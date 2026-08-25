/**
 * eval/gold/fetch-corpus.ts — build and freeze the stratified gold corpus.
 *
 *   npm run gold:fetch                # download every URL in gold/corpus.urls
 *   npm run gold:fetch -- --render    # …through a real browser, JavaScript run
 *   npm run gold:fetch -- --adopt     # additionally adopt the pages already on disk
 *   npm run gold:fetch -- --force     # refetch pages already downloaded
 *   npm run gold:fetch -- --reclassify # re-apply the stratum predicate, fetch nothing
 *
 * Writes stamped snapshots to `src/eval/gold-corpus/` plus `manifest.json`
 * (url, stratum, fetch timestamp, sampling method). Stamping happens here, once,
 * because `data-eval-id` must be stable for the whole life of the annotation:
 * re-fetching a page renumbers every element and silently invalidates every
 * label that referenced it.
 *
 * **Use `--render` for anything real.** A plain `fetch()` captures the bytes the
 * server sent, which on a modern site is a shell: the corpus's saved Wikipedia
 * articles have 7 `<p>` and 246 `<li>`, because the article body never arrived
 * and what remains is navigation chrome. Annotating that produces units the
 * pipeline deliberately drops, and the page then scores every system near zero
 * for reasons that have nothing to do with any of them. `--render` loads the URL
 * in Chromium, lets its scripts run, and freezes the DOM that results — the
 * "freeze with SingleFile/WARC" step of the plan, using the browser that is
 * already a dependency of the evaluation.
 *
 * Pages adopted from the pre-existing `corpus/` and `link-corpus/` directories
 * are recorded as `sampling: "convenience"`. They are not a random sample of the
 * web — they are MDN, Wikipedia, W3C and WHATWG, the best-authored documents
 * there are — and the report must never let them carry a headline number alone.
 */
import "../dom-bootstrap";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  readdirSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stampHtml, verifyStampIsInert } from "./stamp";
import {
  STRATA,
  type CorpusEntry,
  type CorpusManifest,
  type Stratum,
} from "./schema";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const EVAL_DIR = join(HERE, "..");
const LIST = join(HERE, "corpus.urls");
const OUT = join(EVAL_DIR, "gold-corpus");
const MANIFEST = join(OUT, "manifest.json");
const FORCE = process.argv.includes("--force");
const ADOPT = process.argv.includes("--adopt");
const RENDER = process.argv.includes("--render");

const UA =
  "from-space-to-web-research/1.0 (offline parser-evaluation corpus; one fetch per page)";

/**
 * The stratum predicates of the superseded parser plan, applied to the
 * fetched markup. Sampling draws from a stratum, so a page whose measured
 * stratum disagrees with its declared one is reported — silently reassigning it
 * would corrupt the design.
 */
export function classifyStratum(html: string): Stratum {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const q = (sel: string) => doc.querySelectorAll(sel).length;

  const total = q("*");
  const landmarks = q("main, nav, aside, article, section[aria-label], [role]");
  const divs = q("div");
  const controls = q(
    'input:not([type="hidden"]), select, textarea, button, [role="button"]',
  );
  const headings = q("h1,h2,h3,h4,h5,h6");
  const fragmentLinks = q('a[href^="#"]');
  const frameworky =
    /data-react|__NEXT_DATA__|data-v-app|ng-version|data-svelte|class="[^"]*\b(?:flex|grid|px-\d|text-(?:sm|xs|lg))\b/i.test(
      html,
    );

  // Div-soup: hardly any semantic markup, and the document is mostly <div>. The
  // plan states the threshold as ">=200 divs" for the random sample of real
  // pages; expressed as a proportion it also classifies the small hand-written
  // fixtures correctly, which a flat 200 would push into the wrong stratum.
  //
  // `landmarks === 0` was too strict to be useful. `landmarks` counts `[role]`,
  // so one stray `role="button"` on a menu toggle disqualified a page — and
  // essentially every real page written since about 2015 has one. The predicate
  // therefore matched hand-written fixtures and almost nothing else, which is
  // exactly backwards: S2 is the stratum the structural-inference claim lives
  // in, and it held a single page. A randomly drawn page with 854 `<div>`s and
  // ONE landmark was classified S4 on a heading count.
  //
  // A small allowance instead of zero. Three is the number of stray roles a page
  // can carry while still being, to a reader and to a parser, a wall of divs.
  const divSoupThreshold = Math.min(200, Math.max(8, Math.round(total * 0.3)));
  const divShare = total > 0 ? divs / total : 0;
  if (landmarks < 3 && divs >= divSoupThreshold && divShare > 0.3) return "S2";

  // Reference/docs before app-like: a specification has both a deep heading
  // tree and a search box, and it is a document, not an application.
  if (headings >= 15 && fragmentLinks >= 5) return "S4";

  // App-like means the page is mostly affordances — more things to operate than
  // things to read. `controls >= 8` alone matches every site with a search box.
  if (controls >= 8 && controls > headings) return "S5";

  // Semantic before framework: a hand-authored <main> with explicit roles is a
  // stronger signal about how the page is marked up than a utility class name.
  if (q("main, [role='main']") > 0 && q("[role]") > 0) return "S1";
  if (frameworky) return "S3";
  return "S3";
}

function fileNameFor(url: string): string {
  const u = new URL(url);
  const path = u.pathname.replace(/\/+$/, "").replace(/^\/+/, "");
  return (
    `${u.host}${path ? "-" + path : ""}`
      .replace(/[^a-z0-9.-]+/gi, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 90)
      .toLowerCase() + ".html"
  );
}

/** Load a page in Chromium and return the DOM after its scripts have run. */
async function renderedHtml(url: string): Promise<string> {
  const specifier = "playwright";
  const { chromium } = (await import(specifier)) as {
    chromium: {
      launch: (o: { headless: boolean }) => Promise<{
        newContext: (o: Record<string, unknown>) => Promise<{
          newPage: () => Promise<{
            goto: (u: string, o: Record<string, unknown>) => Promise<unknown>;
            content: () => Promise<string>;
            waitForTimeout: (ms: number) => Promise<void>;
          }>;
        }>;
        close: () => Promise<void>;
      }>;
    };
  };
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 1024 },
      userAgent: UA,
    });
    const page = await context.newPage();
    // `networkidle` rather than `load`: the content that matters arrives after
    // load on every site this is aimed at.
    await page.goto(url, { waitUntil: "networkidle", timeout: 60_000 });
    // A short settle for the frameworks that hydrate on an idle callback.
    await page.waitForTimeout(1500);
    return await page.content();
  } finally {
    await browser.close();
  }
}

function readList(): Array<{ stratum: Stratum | null; url: string }> {
  if (!existsSync(LIST)) return [];
  return readFileSync(LIST, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "" && !l.startsWith("#"))
    .map((line) => {
      const m = /^(S[1-5])\s+(\S+)$/.exec(line);
      if (m) return { stratum: m[1] as Stratum, url: m[2] };
      return { stratum: null, url: line };
    });
}

/** Freeze one page: verify the stamp is inert, stamp it, write it. */
function freeze(
  name: string,
  html: string,
  url: string,
  sampling: CorpusEntry["sampling"],
  declared: Stratum | null,
): CorpusEntry | null {
  const inert = verifyStampIsInert(html);
  if (!inert.ok) {
    console.log(`  SKIP  ${name.padEnd(52)} ${inert.reason}`);
    return null;
  }
  const { html: stamped, count } = stampHtml(html);
  const measured = classifyStratum(html);
  if (declared && declared !== measured) {
    console.log(
      `  note  ${name.padEnd(52)} declared ${declared}, measured ${measured} — keeping declared`,
    );
  }
  writeFileSync(join(OUT, name), stamped);
  console.log(
    `  ok    ${name.padEnd(52)} ${(declared ?? measured)}  ${count} ids  ${(stamped.length / 1024).toFixed(0)} KB`,
  );
  return {
    page: name.replace(/\.html$/, ""),
    url,
    stratum: declared ?? measured,
    fetchedAt: new Date().toISOString(),
    sampling,
    archiver: RENDER ? "chromium-render+stamp" : "fetch+stamp",
    bytes: stamped.length,
  };
}

function adoptExisting(): CorpusEntry[] {
  const adopted: CorpusEntry[] = [];
  const dirs = [
    { dir: join(EVAL_DIR, "link-corpus"), sources: true },
    { dir: join(EVAL_DIR, "corpus"), sources: false },
  ];
  for (const { dir, sources } of dirs) {
    if (!existsSync(dir)) continue;
    const sourceMap: Record<string, string> = sources && existsSync(join(dir, "sources.json"))
      ? JSON.parse(readFileSync(join(dir, "sources.json"), "utf8"))
      : {};
    for (const f of readdirSync(dir).filter((n) => n.endsWith(".html"))) {
      const html = readFileSync(join(dir, f), "utf8");
      // A fixture with no source URL has no origin; record the file URL so the
      // manifest never claims a provenance it does not have.
      const url = sourceMap[f] ?? `file://${join(dir, f)}`;
      const entry = freeze(f, html, url, "convenience", null);
      if (entry) adopted.push(entry);
    }
  }
  return adopted;
}

/**
 * Re-run `classifyStratum` over the frozen snapshots and rewrite only the
 * manifest's strata. **Touches no HTML**, which is the entire point.
 *
 * A stratum predicate changes as the design is understood better — relaxing S2
 * moved a page with 854 divs and one landmark out of "reference/docs" and into
 * "div-soup", where it belongs. Applying that by re-running the fetch would
 * re-download and RE-STAMP every page, and a re-stamp renumbers `data-eval-id`
 * and silently repoints every existing annotation at the wrong elements. The
 * corpus is frozen precisely so that cannot happen, so reclassification has to
 * be a separate, read-only operation.
 */
function reclassify(existing: CorpusManifest): void {
  let changed = 0;
  for (const entry of existing.entries) {
    const file = join(OUT, `${entry.page}.html`);
    if (!existsSync(file)) continue;
    const now = classifyStratum(readFileSync(file, "utf8"));
    if (now === entry.stratum) continue;
    console.log(`  ${entry.stratum} → ${now}  ${entry.page}`);
    entry.stratum = now;
    changed++;
  }
  writeFileSync(
    MANIFEST,
    `${JSON.stringify({ ...existing, generatedAt: new Date().toISOString() }, null, 2)}\n`,
  );
  console.log(
    changed === 0
      ? "\n  No page changed stratum.\n"
      : `\n  ${changed} page(s) reclassified. No HTML was touched, so every ` +
          `data-eval-id\n  and every annotation that references one is unaffected.\n`,
  );
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const existing: CorpusManifest = existsSync(MANIFEST)
    ? JSON.parse(readFileSync(MANIFEST, "utf8"))
    : { generatedAt: "", entries: [] };
  const byPage = new Map(existing.entries.map((e) => [e.page, e]));

  if (process.argv.includes("--reclassify")) {
    console.log("Reclassifying frozen snapshots (no fetching, no re-stamping)\n");
    reclassify(existing);
    return;
  }

  if (ADOPT) {
    console.log(`Adopting pages already on disk into ${OUT}\n`);
    for (const e of adoptExisting()) byPage.set(e.page, e);
    console.log("");
  }

  const list = readList();
  if (list.length > 0) {
    console.log(
      `Fetching ${list.length} page(s) into ${OUT}` +
        (RENDER
          ? " — through Chromium, scripts run\n"
          : "\n  (plain fetch: JavaScript does NOT run, so a modern page arrives as a shell.\n" +
            "   Use --render for a corpus anyone can annotate.)\n"),
    );
    for (const { stratum, url } of list) {
      const name = fileNameFor(url);
      const page = name.replace(/\.html$/, "");
      if (!FORCE && existsSync(join(OUT, name)) && byPage.has(page)) {
        console.log(`  skip  ${name}`);
        continue;
      }
      try {
        let html: string;
        let finalUrl = url;
        if (RENDER) {
          html = await renderedHtml(url);
        } else {
          const res = await fetch(url, {
            headers: { "user-agent": UA, accept: "text/html" },
            redirect: "follow",
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          html = await res.text();
          finalUrl = res.url || url;
        }
        const entry = freeze(name, html, finalUrl, "random", stratum);
        if (entry) byPage.set(entry.page, entry);
      } catch (err) {
        console.log(
          `  FAIL  ${name.padEnd(52)} ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      // One page at a time, with a pause. A research corpus, not a crawl.
      await new Promise((r) => setTimeout(r, 800));
    }
  }

  const entries = [...byPage.values()].sort((a, b) => a.page.localeCompare(b.page));
  const manifest: CorpusManifest = {
    generatedAt: new Date().toISOString(),
    entries,
  };
  writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + "\n");

  console.log(`\n  ${entries.length} document(s) in the gold corpus`);
  for (const s of STRATA) {
    const n = entries.filter((e) => e.stratum === s).length;
    const random = entries.filter((e) => e.stratum === s && e.sampling === "random").length;
    console.log(`    ${s}: ${String(n).padStart(3)}  (${random} randomly sampled)`);
  }
  if (entries.length === 0) process.exit(1);
}

/**
 * Run only as the entry point. `classifyStratum` is imported from here by
 * `sample-corpus.ts`, and a bare `main()` at module scope meant that importing
 * one function silently performed a whole corpus fetch — `npm run gold:sample`
 * was re-fetching and re-stamping every page in the corpus as a side effect of
 * an import, which is also a silent way to renumber `data-eval-id` and
 * invalidate every annotation that references it.
 */
const isEntryPoint =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isEntryPoint) main().catch((err) => {
  console.error(err);
  process.exit(1);
});
