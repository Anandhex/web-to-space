/**
 * eval/fetch-link-corpus.ts — build the census corpus from `link-corpus.urls`.
 *
 *   npm run census:fetch
 *
 * Downloads each URL once into `src/eval/link-corpus/` (gitignored) and writes
 * `sources.json` alongside, recording the URL each file came from. The census
 * reads that map so the origin comparison — the whole basis of `same-site` vs
 * `off-site`, and therefore of radius — runs against the page's REAL origin
 * rather than the `file://` path it happens to be saved at. Get that wrong and
 * every same-site link on the page is classified as external, which would put
 * the entire near field out in the far field.
 *
 * Already-downloaded files are skipped, so a re-run costs nothing and a partly
 * fetched corpus resumes. Pass `--force` to refetch everything.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const LIST = join(HERE, "link-corpus.urls");
const OUT = join(HERE, "link-corpus");
const FORCE = process.argv.includes("--force");

/** A polite, honest UA. Nothing here pretends to be a browser it is not. */
const UA =
  "from-space-to-web-research/1.0 (offline link-census corpus; one fetch per page)";

/** Filesystem-safe name derived from the URL, so the mapping stays legible. */
function fileNameFor(url: string): string {
  const u = new URL(url);
  const path = u.pathname.replace(/\/+$/, "").replace(/^\/+/, "");
  const stem = `${u.host}${path ? "-" + path : ""}`
    .replace(/[^a-z0-9.-]+/gi, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 90)
    .toLowerCase();
  return `${stem}.html`;
}

async function main(): Promise<void> {
  const urls = readFileSync(LIST, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "" && !l.startsWith("#"));

  mkdirSync(OUT, { recursive: true });
  const sourcesPath = join(OUT, "sources.json");
  const sources: Record<string, string> = existsSync(sourcesPath)
    ? JSON.parse(readFileSync(sourcesPath, "utf8"))
    : {};

  console.log(`Fetching ${urls.length} page(s) into ${OUT}\n`);
  let fetched = 0;
  let skipped = 0;
  let failed = 0;

  for (const url of urls) {
    const name = fileNameFor(url);
    const dest = join(OUT, name);
    if (!FORCE && existsSync(dest)) {
      sources[name] = url;
      skipped++;
      console.log(`  skip  ${name}`);
      continue;
    }
    try {
      const res = await fetch(url, {
        headers: { "user-agent": UA, accept: "text/html" },
        redirect: "follow",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const html = await res.text();
      writeFileSync(dest, html);
      // The URL AFTER redirects is the one the origin comparison must use.
      sources[name] = res.url || url;
      fetched++;
      console.log(`  ok    ${name.padEnd(56)} ${(html.length / 1024).toFixed(0)} KB`);
    } catch (err) {
      failed++;
      console.log(`  FAIL  ${name.padEnd(56)} ${err instanceof Error ? err.message : String(err)}`);
    }
    // One page at a time, with a pause. This is a research corpus, not a crawl.
    await new Promise((r) => setTimeout(r, 800));
  }

  writeFileSync(sourcesPath, JSON.stringify(sources, null, 2) + "\n");

  const onDisk = readdirSync(OUT).filter((f) => f.endsWith(".html")).length;
  console.log(`\n  ${fetched} fetched, ${skipped} already present, ${failed} failed`);
  console.log(`  ${onDisk} document(s) in the corpus\n`);
  if (onDisk === 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
