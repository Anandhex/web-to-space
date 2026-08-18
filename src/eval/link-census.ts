/**
 * eval/link-census.ts — Phase 0 of docs/link-build-plan.md.
 *
 *   npm run census                    # runs src/eval/corpus/*.html
 *   npm run census -- path/to/dir     # runs *.html under a custom directory
 *
 * The entire reference-neighbourhood design rests on a capacity claim: roughly
 * 16–24 destinations of lateral room against a median of 13 outbound per page.
 * That median came from five Wikipedia articles. This measures it on the
 * corpus that is actually going to be rendered, offline, with no browser and
 * no renderer — `parsePageToIR` -> `mapIRToScene` -> `computeLayoutPlan`,
 * exactly as run-benchmark.ts does — and reports the distribution.
 *
 * Emits, under eval-out/:
 *   • link-census.csv     — one row per rendered page
 *   • link-census.md      — the distribution, and the G0 verdict
 *
 * ── One deliberate deviation from the plan ──
 *
 * The plan puts the census before the classifier and lets it carry its own
 * inline definitions of "outbound", "footing" and the rest. This imports
 * `src/links/` instead. Two definitions of "outbound" that drift apart would
 * mean the number in the thesis and the number the renderer acts on are
 * different numbers, and the whole point of measuring first is that the gate
 * binds what gets built.
 *
 * Import order matters: dom-bootstrap installs a jsdom DOMParser before any
 * pipeline module loads.
 */
import "./dom-bootstrap";
import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";

import { parsePageToIR } from "../ir/parser";
import { DEFAULT_CONFIG } from "../ir/defaults";
import { mapIRToScene, DEFAULT_MAPPER_CONFIG } from "../mapper/mapper";
import { computeLayoutPlan } from "../layout/engine";
import { QUEST_3_PROFILE } from "../layout/profiles";
import { getArrangement } from "../layout/placement";
import { foldForArrangement } from "../layout/content-only";
import { collectSpatialLinks } from "../links/collect";
import type { SpatialLink } from "../links/types";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const CORPUS_DIR = process.argv[2]
  ? resolve(process.cwd(), process.argv[2])
  : join(HERE, "corpus");
const OUT_DIR = resolve(process.cwd(), "eval-out");
/** Distinct output names per corpus, so a real-page run never overwrites a fixture run. */
const TAG = basename(CORPUS_DIR) === "corpus" ? "link-census" : `link-census-${basename(CORPUS_DIR)}`;

/**
 * The URL each saved document was fetched from (written by fetch-link-corpus).
 *
 * This matters more than it looks: `same-site` vs `off-site` is an ORIGIN
 * comparison, and a page measured under the `file://` path it happens to be
 * saved at has no origin to compare against — every absolute href on it comes
 * back off-site, which moves the entire near field out into the far field and
 * makes the radius encoding meaningless. Falling back to the file path is
 * correct only for the hand-written fixtures, whose hrefs are all relative.
 */
function loadSources(dir: string): Record<string, string> {
  const p = join(dir, "sources.json");
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, "utf8")) as Record<string, string>;
  } catch {
    return {};
  }
}

// ── The columns the build plan asks for ──────────────────────────────────

interface PageCensus {
  doc: string;
  page: number;
  /** References that would get a body: everything but same-document and operational. */
  outbound: number;
  /** Of those, the ones in the lateral field — what the capacity budget is about. */
  field: number;
  footing: number;
  /** Same-document references. These get no body. */
  arrangement: number;
  ascent: number;
  /** Operational links: download, mailto, submit. They stay on the page. */
  onPage: number;
  /** Anchors whose text is "read more" / "click here" / "here" / <= 2 words. */
  degenerate: number;
  /** Anchors sharing a block with another anchor — the alignment-collision rate. */
  sameLine: number;
}

function censusOfPage(links: SpatialLink[], doc: string, page: number): PageCensus {
  const count = (fn: (l: SpatialLink) => boolean) => links.filter(fn).length;
  return {
    doc,
    page,
    outbound: count(
      (l) => l.region === "field" || l.region === "footing" || l.region === "ascent",
    ),
    field: count((l) => l.region === "field"),
    footing: count((l) => l.region === "footing"),
    arrangement: count((l) => l.region === "arrangement"),
    ascent: count((l) => l.region === "ascent"),
    onPage: count((l) => l.region === "page"),
    degenerate: count((l) => l.degenerate),
    sameLine: count((l) => l.sameBlock),
  };
}

// ── Distribution ─────────────────────────────────────────────────────────

/**
 * Nearest-rank percentile. Chosen over interpolation on purpose: with a corpus
 * of a few dozen pages an interpolated p90 invents a page that does not exist,
 * and the gate below is a decision about real pages.
 */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}

interface Dist {
  n: number;
  median: number;
  p90: number;
  p99: number;
  max: number;
  mean: number;
}

function distribution(xs: number[]): Dist {
  const s = [...xs].sort((a, b) => a - b);
  return {
    n: s.length,
    median: percentile(s, 50),
    p90: percentile(s, 90),
    p99: percentile(s, 99),
    max: s.length ? s[s.length - 1] : 0,
    mean: s.length ? s.reduce((a, b) => a + b, 0) / s.length : 0,
  };
}

// ── Decision gate G0 ─────────────────────────────────────────────────────

type Verdict = "proceed" | "narrow-panel" | "replan";

function gateG0(p90: number): { verdict: Verdict; text: string } {
  if (p90 <= 24)
    return {
      verdict: "proceed",
      text:
        "**PASS — proceed as planned.** p90 outbound is inside the ~16-24 lateral " +
        "budget, so the neighbourhood stays flat and clustering is not built.",
    };
  if (p90 <= 40)
    return {
      verdict: "narrow-panel",
      text:
        "**CONDITIONAL — proceed, but narrow the panel.** p90 outbound is between " +
        "25 and 40. Take the main panel to 1.0-1.2 m (buys 8-16 degrees of band " +
        "per side) and schedule clustering by source section for Phase 6.",
    };
  return {
    verdict: "replan",
    text:
      "**FAIL — stop and re-plan.** p90 outbound exceeds 40, which no amount of " +
      "panel narrowing recovers. Clustering by source section becomes Phase 1, " +
      "not an afterthought.",
  };
}

// ── CSV ──────────────────────────────────────────────────────────────────

const COLUMNS: Array<keyof PageCensus> = [
  "doc", "page", "outbound", "field", "footing", "arrangement",
  "ascent", "onPage", "degenerate", "sameLine",
];

function csvRow(cells: (string | number)[]): string {
  return cells
    .map((c) => {
      const s = String(c);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    })
    .join(",");
}

function distRow(name: string, d: Dist): string {
  return `| \`${name}\` | ${d.median} | ${d.p90} | ${d.p99} | ${d.max} | ${d.mean.toFixed(1)} |`;
}

// ── Run ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const files = readdirSync(CORPUS_DIR).filter((f) => f.endsWith(".html")).sort();
  if (files.length === 0) {
    console.error(`No .html files found in ${CORPUS_DIR}`);
    process.exit(1);
  }
  const sources = loadSources(CORPUS_DIR);
  console.log(`Link census over ${files.length} document(s) from ${CORPUS_DIR}`);
  console.log(
    Object.keys(sources).length > 0
      ? `Origins from sources.json — same-site/off-site is a real comparison.\n`
      : `No sources.json — documents measured at their file:// path, so every\n` +
        `absolute href reads as off-site. Fine for relative-href fixtures.\n`,
  );

  const rows: PageCensus[] = [];
  const perDoc: Array<{ doc: string; pages: number; links: number; url: string }> = [];
  const persistent: Array<{ doc: string; bodied: number; arrangement: number; operational: number }> = [];
  let allLinks = 0;
  let allDegenerate = 0;
  let allSameBlock = 0;
  let allSynthesised = 0;

  for (const f of files) {
    const html = readFileSync(join(CORPUS_DIR, f), "utf8");
    const url = sources[f] ?? `file://${resolve(CORPUS_DIR, f)}`;
    const ir = await parsePageToIR(html, url, undefined, DEFAULT_CONFIG);
    const scene = mapIRToScene(ir, DEFAULT_MAPPER_CONFIG);
    // Lay out the way the app does. Every shipped view is a page view, so the
    // slot roster is [main] and the landmarks fold into the panel's flow —
    // measuring the unfolded landmark desk would measure a layout no reader
    // ever sees.
    const arrangement = getArrangement("rooms");
    // `scene` stays the mapper's own output — the parser metrics below are
    // about what was PARSED. `laidOut` is what gets placed, and anything that
    // reads positions out of the plan must use it, since folding re-parents
    // the landmarks and the plan has entries for that shape, not this one.
    const laidOut = foldForArrangement(scene, arrangement);
    const plan = computeLayoutPlan(
      laidOut,
      QUEST_3_PROFILE,
      {},
      undefined,
      arrangement,
    );

    const links = collectSpatialLinks(laidOut, plan, { pageUrl: url });

    const pageCount = Math.max(
      1,
      ...Object.values(plan.entries).map((e) => e.pagination?.pageCount ?? 1),
    );

    // Links outside the paginated panel — a top-level nav bar, a footer, the
    // synthesised table of contents — carry page -1, and how they are counted
    // decides whether the report means anything.
    //
    // The ones that get a BODY (field / footing / ascent) are standing in the
    // neighbourhood whatever page the reader is on, so they spend the capacity
    // budget on every page and are replicated onto every row. That is exactly
    // the pressure the gate is testing for.
    //
    // The ones that do not (arrangement, and operational links) are counted
    // ONCE, into `persistent` below. Replicating them was worse than useless:
    // the WAI-ARIA spec's table of contents is 346 same-document fragments, so
    // every one of its 745 rows reported 346 arrangement links and the corpus
    // median came out at 346 — a per-page statistic describing one list that
    // is drawn once and costs the neighbourhood nothing, since a same-document
    // reference gets no body at all.
    const offPanel = links.filter((l) => l.pageIndex < 0);
    const offPanelBodied = offPanel.filter(
      (l) => l.region === "field" || l.region === "footing" || l.region === "ascent",
    );
    persistent.push({
      doc: basename(f),
      bodied: offPanelBodied.length,
      arrangement: offPanel.filter((l) => l.region === "arrangement").length,
      operational: offPanel.filter((l) => l.region === "page").length,
    });

    for (let page = 0; page < pageCount; page++) {
      const onPage = links.filter((l) => l.pageIndex === page);
      rows.push(censusOfPage([...onPage, ...offPanelBodied], basename(f), page));
    }

    // Rates are computed over each document's DISTINCT references, never over
    // the replicated rows — a link that stands on 745 pages is still one link,
    // and counting it 745 times would let one document's nav bar set the
    // corpus-wide degeneracy rate.
    for (const l of links) {
      allLinks++;
      if (l.degenerate) allDegenerate++;
      if (l.sameBlock) allSameBlock++;
      if (l.synthesised) allSynthesised++;
    }
    perDoc.push({ doc: basename(f), pages: pageCount, links: links.length, url });
    console.log(
      `  ${f.padEnd(26)} ${String(pageCount).padStart(3)} page(s), ` +
        `${String(links.length).padStart(3)} reference(s)`,
    );
  }

  mkdirSync(OUT_DIR, { recursive: true });

  writeFileSync(
    join(OUT_DIR, `${TAG}.csv`),
    [csvRow(COLUMNS), ...rows.map((r) => csvRow(COLUMNS.map((c) => r[c])))].join("\n"),
  );

  const dists: Record<string, Dist> = {};
  for (const key of ["outbound", "field", "footing", "arrangement", "ascent", "onPage", "degenerate", "sameLine"] as const) {
    dists[key] = distribution(rows.map((r) => r[key]));
  }
  // ── Per document, and equally weighted ──
  //
  // Pooling every rendered page treats a 745-page specification and a 3-page
  // article as 745 and 3 votes, which is not what the capacity question is
  // asking: the gate is about the pages a reader will stand in front of, and
  // one enormous, link-sparse document should not be able to carry the
  // headline number on its own. The pooled number below is still the one the
  // gate reads, because that is what the plan specifies — but it is reported
  // beside a per-document table and an equal-weight roll-up, so a median of
  // zero is never mistaken for "pages have no references".
  const byDoc = new Map<string, number[]>();
  for (const r of rows) {
    const list = byDoc.get(r.doc) ?? [];
    list.push(r.outbound);
    byDoc.set(r.doc, list);
  }
  const docDists = [...byDoc.entries()].map(([doc, xs]) => ({ doc, d: distribution(xs) }));
  const equalWeightP90 = distribution(docDists.map((x) => x.d.p90));
  const equalWeightMedian = distribution(docDists.map((x) => x.d.median));
  const nonEmpty = distribution(rows.map((r) => r.outbound).filter((x) => x > 0));
  const busiest = [...rows].sort((a, b) => b.outbound - a.outbound)[0];

  const gate = gateG0(dists.outbound.p90);
  const degenRate = allLinks ? allDegenerate / allLinks : 0;
  const collisionRate = allLinks ? allSameBlock / allLinks : 0;
  const synthRate = allLinks ? allSynthesised / allLinks : 0;

  const md: string[] = [];
  md.push("# Link census");
  md.push("");
  md.push(`Corpus: \`${CORPUS_DIR}\` — ${files.length} document(s), ${rows.length} rendered page(s).`);
  md.push(`Device profile: ${QUEST_3_PROFILE.name}. Generated ${new Date().toISOString()}.`);
  if (Object.keys(sources).length === 0)
    md.push(
      "\n> Measured at `file://` paths — no `sources.json` — so every absolute href " +
        "reads as off-site. Correct for the relative-href fixtures; misleading for saved real pages.",
    );
  md.push("");
  md.push("## Per rendered page");
  md.push("");
  md.push("| metric | median | p90 | p99 | max | mean |");
  md.push("|---|---|---|---|---|---|");
  for (const key of ["outbound", "field", "footing", "arrangement", "ascent", "onPage", "degenerate", "sameLine"])
    md.push(distRow(key, dists[key]));
  md.push("");
  md.push("`outbound` = field + footing + ascent: every reference that would get a body.");
  md.push("`field` is broken out separately because the ~16-24 lateral capacity budget");
  md.push("is a budget on the FIELD; the footing sits below the panel and the ascent above,");
  md.push("and neither competes for the lateral band.");
  md.push("");
  md.push("## Weighted three ways");
  md.push("");
  md.push("| view | median | p90 | max |");
  md.push("|---|---|---|---|");
  md.push(`| every rendered page, pooled *(the gate reads this)* | ${dists.outbound.median} | ${dists.outbound.p90} | ${dists.outbound.max} |`);
  md.push(`| pages that carry at least one reference | ${nonEmpty.median} | ${nonEmpty.p90} | ${nonEmpty.max} |`);
  md.push(`| per-document medians, each document one vote | ${equalWeightMedian.median} | ${equalWeightMedian.p90} | ${equalWeightMedian.max} |`);
  md.push(`| per-document p90s, each document one vote | ${equalWeightP90.median} | ${equalWeightP90.p90} | ${equalWeightP90.max} |`);
  md.push("");
  md.push(
    `Pooling is skewed: the largest document contributes ` +
      `${Math.max(...docDists.map((x) => x.d.n))} of ${rows.length} rows. A pooled median of ` +
      `${dists.outbound.median} means most PAGES are sparse, not that most DOCUMENTS are.`,
  );
  md.push("");
  md.push("### Per document");
  md.push("");
  md.push("| document | pages | median | p90 | max | total refs |");
  md.push("|---|---|---|---|---|---|");
  for (const { doc, d } of docDists) {
    const total = perDoc.find((x) => x.doc === doc)?.links ?? 0;
    md.push(`| ${doc.replace(/\.html$/, "")} | ${d.n} | ${d.median} | ${d.p90} | ${d.max} | ${total} |`);
  }
  md.push("");
  md.push("### The worst page in the corpus");
  md.push("");
  md.push(
    `\`${busiest.doc}\` page ${busiest.page}: **${busiest.outbound} outbound** ` +
      `(${busiest.field} field, ${busiest.footing} footing, ${busiest.ascent} ascent), ` +
      `plus ${busiest.arrangement} same-document and ${busiest.onPage} operational. ` +
      "This is the page the density ladder (design doc section 5) exists for: far past " +
      "40, so it is section clusters only, expanded on approach — never 100+ individual bodies.",
  );
  md.push("");
  md.push("## Decision gate G0");
  md.push("");
  md.push(`p90 \`outbound\` = **${dists.outbound.p90}**`);
  md.push("");
  md.push(gate.text);
  md.push("");
  md.push("## The two numbers that set how much the rest has to carry");
  md.push("");
  md.push(
    `**Alignment collisions:** ${(collisionRate * 100).toFixed(1)}% of anchors share ` +
      "a block with another anchor. Anchor-height alignment cannot disambiguate those, " +
      "so this is the load on the highlight mechanism (design doc section 7, mechanism B).",
  );
  md.push("");
  md.push(
    `**Degenerate anchors:** ${(degenRate * 100).toFixed(1)}% of ${allLinks} distinct ` +
      'references are "read more" / "click here" / "here" / two words or fewer. ' +
      "That is how hard the identity synthesiser has to work by the census's " +
      `definition. By the stricter test \`identity.ts\` actually acts on, only ` +
      `**${(synthRate * 100).toFixed(1)}%** needed a name synthesised from the ` +
      "fragment, slug or host — the gap is almost entirely two-word proper nouns, " +
      "which name their destination perfectly well and must not be replaced.",
  );
  md.push("");
  md.push("Both rates are over each document's DISTINCT references, not over the");
  md.push("replicated per-page rows.");
  md.push("");
  md.push("## References that stand on every page");
  md.push("");
  md.push("Outside the paginated panel. The bodied column is added to every page row above;");
  md.push("the other two are counted here only, because they never get a body.");
  md.push("");
  md.push("| document | bodied (field/footing/ascent) | arrangement | operational |");
  md.push("|---|---|---|---|");
  for (const p of persistent)
    md.push(`| ${p.doc.replace(/\.html$/, "")} | ${p.bodied} | ${p.arrangement} | ${p.operational} |`);
  md.push("");

  writeFileSync(join(OUT_DIR, `${TAG}.md`), md.join("\n"));

  console.log("");
  console.log(`  median outbound ${dists.outbound.median}   p90 ${dists.outbound.p90}   p99 ${dists.outbound.p99}   max ${dists.outbound.max}`);
  console.log(`  median field    ${dists.field.median}   p90 ${dists.field.p90}`);
  console.log(`  non-empty pages only: median ${nonEmpty.median}   p90 ${nonEmpty.p90}   (${nonEmpty.n}/${rows.length} pages)`);
  console.log(`  per-document p90s:   median ${equalWeightP90.median}   max ${equalWeightP90.max}`);
  console.log(`  busiest page: ${busiest.doc} p${busiest.page} = ${busiest.outbound} outbound`);
  console.log(`  over ${allLinks} distinct refs: same-block ${(collisionRate * 100).toFixed(1)}%   degenerate ${(degenRate * 100).toFixed(1)}%   synthesised ${(synthRate * 100).toFixed(1)}%`);
  console.log("");
  console.log(`  G0: ${gate.verdict.toUpperCase()}`);
  console.log("");
  console.log(`Wrote eval-out/${TAG}.csv and eval-out/${TAG}.md`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
