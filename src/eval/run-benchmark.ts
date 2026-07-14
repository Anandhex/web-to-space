/**
 * eval/run-benchmark.ts — offline, reproducible batch benchmark.
 *
 *   npm run benchmark                 # runs src/eval/corpus/*.html
 *   npm run benchmark -- path/to/dir  # runs *.html under a custom directory
 *
 * Emits, under eval-out/:
 *   • per-page.csv        — every metric for every (page, backend)
 *   • segmentation.csv    — BCubed precision/recall/F per (page, segmenter)
 *   • report.md           — corpus-level means ± sample stddev, ranked
 *
 * Import order matters: dom-bootstrap installs a jsdom DOMParser before any
 * pipeline module loads.
 */
import "./dom-bootstrap";
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { benchmarkPage, PIPELINE_BACKENDS, type PageBenchmark } from "./harness";
import type { SegmenterId } from "./segmentation";
import type { XRSpatialQuality } from "./xr-quality";

const QUEST_3_LABEL = "Meta Quest 3";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const CORPUS_DIR = process.argv[2]
  ? resolve(process.cwd(), process.argv[2])
  : join(HERE, "corpus");
const OUT_DIR = resolve(process.cwd(), "eval-out");

// ── Aggregation helpers ───────────────────────────────────────
function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}
function stddev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(mean(xs.map((x) => (x - m) ** 2)) * (xs.length / (xs.length - 1)));
}
function fmt(m: number, s: number, dp = 2): string {
  return `${m.toFixed(dp)} ± ${s.toFixed(dp)}`;
}
function csvRow(cells: (string | number)[]): string {
  return cells
    .map((c) => {
      const s = String(c);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    })
    .join(",");
}

// ── Metric selectors for the per-backend aggregate ────────────
const XR_KEYS: Array<keyof XRSpatialQuality> = [
  "meanAngularSizeDeg", "legibleFraction", "comfortableFraction",
  "comfortCoverage", "peripheralPanelCount", "mainPanelFovFill",
  "totalPages", "pageTurnsToReadAll", "meanReadingDistanceErrorM",
];
const BACKEND_KEYS = [
  "timingMs", "irNodeCount", "semanticRichness", "headingRecall",
  "landmarkRecall", "textCoverage", "genericRatio", "primitivesPlaced",
  "altTextCoverage", "ariaLabelledByRate", "interactiveAffordanceRate",
  "controlLabelCoverage", "headingHierarchyValidity", "linkRetention",
  "navLinkRetention", "inlineLinkRetention",
  "tablePreservation", "mediaPreservation", "readingOrderFidelity",
] as const;

async function main(): Promise<void> {
  const files = readdirSync(CORPUS_DIR)
    .filter((f) => f.endsWith(".html"))
    .sort();
  if (files.length === 0) {
    console.error(`No .html files found in ${CORPUS_DIR}`);
    process.exit(1);
  }
  console.log(`Benchmarking ${files.length} page(s) from ${CORPUS_DIR}\n`);

  const results: PageBenchmark[] = [];
  for (const f of files) {
    const html = readFileSync(join(CORPUS_DIR, f), "utf8");
    const doc = new DOMParser().parseFromString(html, "text/html");
    const r = await benchmarkPage(basename(f), html, `file://${f}`, doc);
    results.push(r);
    const best = [...r.backends].sort((a, b) => b.semanticRichness - a.semanticRichness)[0];
    console.log(
      `  ${f.padEnd(26)} richness top: ${best.label} (${best.semanticRichness})`,
    );
  }

  mkdirSync(OUT_DIR, { recursive: true });

  // ── per-page.csv ────────────────────────────────────────────
  const perPage: string[] = [];
  perPage.push(csvRow(["page", "backend", ...BACKEND_KEYS, ...XR_KEYS, "error"]));
  for (const r of results) {
    for (const b of r.backends) {
      perPage.push(
        csvRow([
          r.page,
          b.label,
          ...BACKEND_KEYS.map((k) => b[k] as number),
          ...XR_KEYS.map((k) => (b.xr ? b.xr[k] : "")),
          b.error ?? "",
        ]),
      );
    }
  }
  writeFileSync(join(OUT_DIR, "per-page.csv"), perPage.join("\n"));

  // ── segmentation.csv ────────────────────────────────────────
  const segIds = Object.keys(results[0].segmentation) as SegmenterId[];
  const segCsv: string[] = [csvRow(["page", "segmenter", "precision", "recall", "f", "segments", "units"])];
  for (const r of results) {
    for (const id of segIds) {
      const s = r.segmentation[id];
      segCsv.push(csvRow([r.page, id, s.precision.toFixed(4), s.recall.toFixed(4), s.f.toFixed(4), s.segmentCount, s.coveredUnits]));
    }
  }
  writeFileSync(join(OUT_DIR, "segmentation.csv"), segCsv.join("\n"));

  // ── report.md ───────────────────────────────────────────────
  const md: string[] = [];
  md.push(`# Web→VR Parser Benchmark`);
  md.push("");
  md.push(`Corpus: **${files.length}** page(s) — ${files.join(", ")}`);
  md.push(`Device profile: **${QUEST_3_LABEL}**  ·  generated ${new Date().toISOString()}`);
  md.push("");

  // Per-backend aggregate table.
  md.push(`## Pipeline backends (mean ± sd across corpus)`);
  md.push("");
  const cols = ["semanticRichness", "headingRecall", "landmarkRecall", "textCoverage", "genericRatio", "timingMs"] as const;
  md.push(`| Backend | ${cols.join(" | ")} |`);
  md.push(`|${"---|".repeat(cols.length + 1)}`);
  for (const b of PIPELINE_BACKENDS) {
    const rows = results.map((r) => r.backends.find((x) => x.id === b.id)!);
    const cells = cols.map((k) => fmt(mean(rows.map((r) => r[k] as number)), stddev(rows.map((r) => r[k] as number)), k === "timingMs" ? 0 : 1));
    md.push(`| ${b.label} | ${cells.join(" | ")} |`);
  }
  md.push("");

  // XR spatial quality aggregate.
  md.push(`## XR spatial quality (mean ± sd)`);
  md.push("");
  const xrCols: Array<keyof XRSpatialQuality> = ["meanAngularSizeDeg", "legibleFraction", "comfortableFraction", "comfortCoverage", "mainPanelFovFill", "totalPages"];
  md.push(`| Backend | ${xrCols.join(" | ")} |`);
  md.push(`|${"---|".repeat(xrCols.length + 1)}`);
  for (const b of PIPELINE_BACKENDS) {
    const rows = results.map((r) => r.backends.find((x) => x.id === b.id)!).filter((r) => r.xr);
    const cells = xrCols.map((k) => {
      const vals = rows.map((r) => r.xr![k]);
      return fmt(mean(vals), stddev(vals), k === "totalPages" ? 1 : 3);
    });
    md.push(`| ${b.label} | ${cells.join(" | ")} |`);
  }
  md.push("");
  md.push(`> Legibility floor ${0.29}° · comfort target ${1.375}° cap-height at ${1.2} m viewing distance.`);
  md.push("");

  // Segmentation aggregate — the literature (Kiesel CIKM'20) metric.
  md.push(`## Segmentation quality — size-weighted BCubed vs reference`);
  md.push("");
  md.push(`Reference: HTML5-semantic proxy oracle (supply gold annotations for a true ground truth). Each segmenter is an independent DOM→partition algorithm; no shared parser.`);
  md.push("");
  md.push(`> Caveat: on pages with no landmarks/sectioning the proxy oracle degenerates to a single segment, so every algorithm (including \`flat\`) scores 1.0 there. Such pages inflate the mean and cannot discriminate — use gold annotations to evaluate div-soup pages.`);
  md.push("");
  md.push(`| Segmenter | precision | recall | F |`);
  md.push(`|---|---|---|---|`);
  const segAgg = segIds
    .map((id) => {
      const P = results.map((r) => r.segmentation[id].precision);
      const R = results.map((r) => r.segmentation[id].recall);
      const F = results.map((r) => r.segmentation[id].f);
      return { id, p: mean(P), sp: stddev(P), r: mean(R), sr: stddev(R), f: mean(F), sf: stddev(F) };
    })
    .sort((a, b) => b.f - a.f);
  for (const s of segAgg) {
    md.push(`| ${s.id} | ${fmt(s.p, s.sp, 3)} | ${fmt(s.r, s.sr, 3)} | **${fmt(s.f, s.sf, 3)}** |`);
  }
  md.push("");
  md.push(`_CSV detail in per-page.csv and segmentation.csv._`);

  writeFileSync(join(OUT_DIR, "report.md"), md.join("\n"));

  console.log(`\nWrote:`);
  console.log(`  ${join(OUT_DIR, "per-page.csv")}`);
  console.log(`  ${join(OUT_DIR, "segmentation.csv")}`);
  console.log(`  ${join(OUT_DIR, "report.md")}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
