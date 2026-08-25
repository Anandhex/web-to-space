/**
 * eval/run-evaluation.ts — the parser sanity check.
 *
 * This is NOT a comparison. It answers one question, from
 * docs/evaluation-plan.md §2.1: does the parser recover the page's structure
 * well enough that the study's "semantic spatial" condition means what we say
 * it means?
 *
 * It runs the SHIPPED parser only, over pages that carry a human annotation,
 * and reports macro-F1, the per-label breakdown and the confusion matrix. No
 * baselines, no significance tests, no strata, no ablations — the thesis makes
 * no comparative claim about the parser, so measuring one would invite a claim
 * we are not making.
 *
 * A page whose gold is the tag-derived placeholder is scored and reported, but
 * under a heading that says so: the parser reads the same tags the placeholder
 * was built from, so that number is a smoke test, not evidence.
 */
import "./dom-bootstrap";
import { readFileSync, readdirSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parsePageToIR } from "../ir/parser";
import { DEFAULT_CONFIG, PARSER_CONFIGS } from "../ir/defaults";
import type { ParserConfig } from "../ir/types";
import { scoreNodeLabels, type NodeLabelScore } from "./node-labels";
import { loadGold, loadManifest, type GoldAnnotation } from "./gold/schema";
import { GOLD_LABELS, type GoldLabel, type PredictedLabel } from "./gold/labels";
import { collectGoldUnits, predictionsFromIR, alignPredictions } from "./gold/align";
import { heatmap } from "./figures/charts";

const HERE = resolve(fileURLToPath(new URL(".", import.meta.url)));
const CORPUS_DIR = join(HERE, "gold-corpus");
const GOLD_DIR = join(HERE, "gold-annotations");
const OUT_DIR = resolve(HERE, "../../eval-out/sanity");

/**
 * The configuration everything in the thesis runs on — see
 * docs/evaluation-plan.md §2.1.
 *
 * `useAIFallback` is switched off explicitly rather than left at the shipped
 * default. With no provider configured the parser installs a stub and the layer
 * is already a no-op, so the numbers are identical either way — but the plan
 * states these results are deterministic, and a claim that holds only because an
 * environment variable happens to be unset is not a claim, it is an accident
 * waiting to be reported as one.
 */
const EVAL_CONFIG: ParserConfig = { ...DEFAULT_CONFIG, useAIFallback: false };

/**
 * The same parser with **structural inference switched off** — explicit ARIA and
 * HTML5 tags only.
 *
 * This is the control for the hidden-unit question, and it is the ONLY honest
 * one. A `naive` tags-only baseline scores zero on the hidden subset by
 * construction, because "hidden" is DEFINED as "the tag does not yield the gold
 * label" — quoting that as a win would be a tautology dressed as a result.
 * Contrasting L1 against L1+L2 is not circular: both are real configurations of
 * the same parser, and the difference between them is exactly the mechanism
 * under test (Chapter 4, Phase 3).
 */
const NO_INFERENCE: ParserConfig = {
  ...PARSER_CONFIGS.withExplicitSemantics,
  useAIFallback: false,
};

function argOf(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const ONLY = (argOf("--only") ?? "").split(",").filter(Boolean);

interface PageScore {
  page: string;
  annotator: string;
  human: boolean;
  goldUnits: number;
  /** Wall-clock parse time, ms. The thesis guide asks for processing times. */
  timingMs: number;
  /** Source size, for a time-per-kB figure. */
  htmlBytes: number;
  /** Over every annotated unit. Context only. */
  score: NodeLabelScore;
  /**
   * Over units whose markup declares NOTHING about their role — no HTML5
   * sectioning tag, no `role=`. This is the reported result: a tags-only reader
   * has no signal here, so whatever is recovered came from structural
   * inference. @see isMarkupDeclared
   */
  hidden: NodeLabelScore | null;
  hiddenUnits: number;
  /** The counterpart subset, for contrast. */
  declared: NodeLabelScore | null;
  declaredUnits: number;
  /** Source tags carried by the hidden units, most frequent first. */
  hiddenTags: Array<[string, number]>;
  /** The same page parsed WITHOUT structural inference, scored on hidden units. */
  hiddenNoInference: NodeLabelScore | null;
}

/** Prefer a human pass; fall back to the placeholder and say which was used. */
function chooseAnnotation(byAnnotator: Map<string, GoldAnnotation>): GoldAnnotation {
  for (const a of byAnnotator.values()) if (!a.provisional) return a;
  return [...byAnnotator.values()][0];
}

async function scorePage(html: string, url: string, gold: GoldAnnotation): Promise<PageScore | null> {
  const htmlBytes = Buffer.byteLength(html, "utf8");
  const doc = new DOMParser().parseFromString(html, "text/html");
  const { units } = collectGoldUnits(doc, gold.nodes);
  if (units.length === 0) return null;
  const t0 = performance.now();
  const ir = await parsePageToIR(html, url, undefined, EVAL_CONFIG);
  const timingMs = Math.round(performance.now() - t0);
  const alignment = alignPredictions(units, predictionsFromIR(ir));

  // The subsets are scored by re-running the scorer over a filtered unit list,
  // NOT by partitioning the finished confusion matrix: macro-F1 is an unweighted
  // mean over labels with non-zero support, so a subset's macro-F1 is not
  // recoverable from the whole-page one.
  const hiddenUnits = units.filter((u) => !u.declared);
  const declaredUnits = units.filter((u) => u.declared);
  const sub = (us: typeof units) =>
    us.length > 0 ? scoreNodeLabels(us, alignment.predicted, alignment.provenance) : null;

  const tags = new Map<string, number>();
  for (const u of hiddenUnits) tags.set(u.sourceTag, (tags.get(u.sourceTag) ?? 0) + 1);

  // The control: same page, same units, inference off.
  const irL1 = await parsePageToIR(html, url, undefined, NO_INFERENCE);
  const alignL1 = alignPredictions(units, predictionsFromIR(irL1));

  return {
    page: gold.page,
    annotator: gold.annotator,
    human: !gold.provisional,
    goldUnits: units.length,
    timingMs,
    htmlBytes,
    score: scoreNodeLabels(units, alignment.predicted, alignment.provenance),
    hiddenNoInference:
      hiddenUnits.length > 0
        ? scoreNodeLabels(hiddenUnits, alignL1.predicted, alignL1.provenance)
        : null,
    hidden: sub(hiddenUnits),
    hiddenUnits: hiddenUnits.length,
    declared: sub(declaredUnits),
    declaredUnits: declaredUnits.length,
    hiddenTags: [...tags].sort((a, b) => b[1] - a[1]).slice(0, 8),
  };
}

// ── report ───────────────────────────────────────────────────

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN;
}

function perLabelTable(rows: PageScore[]): string {
  const agg = new Map<string, { p: number[]; r: number[]; f: number[]; n: number }>();
  for (const row of rows) {
    for (const l of row.score.perLabel) {
      const e = agg.get(l.label) ?? { p: [], r: [], f: [], n: 0 };
      e.p.push(l.precision);
      e.r.push(l.recall);
      e.f.push(l.f1);
      e.n += l.support;
      agg.set(l.label, e);
    }
  }
  const lines = ["| Label | P | R | F1 | support |", "|---|---:|---:|---:|---:|"];
  for (const [label, e] of [...agg].sort((a, b) => a[1].n - b[1].n)) {
    lines.push(
      `| \`${label}\` | ${mean(e.p).toFixed(3)} | ${mean(e.r).toFixed(3)} | ` +
        `${mean(e.f).toFixed(3)} | ${e.n} |`,
    );
  }
  return lines.join("\n");
}

function pooledConfusion(rows: PageScore[]): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  for (const row of rows) {
    for (const [g, preds] of Object.entries(row.score.confusion)) {
      out[g] ??= {};
      for (const [p, n] of Object.entries(preds)) out[g][p] = (out[g][p] ?? 0) + n;
    }
  }
  return out;
}

function confusionCsv(conf: Record<string, Record<string, number>>): string {
  const cols: PredictedLabel[] = [...GOLD_LABELS, "absent"];
  const head = ["gold", ...cols].join(",");
  const body = GOLD_LABELS.map((g) =>
    [g, ...cols.map((c) => conf[g]?.[c] ?? 0)].join(","),
  );
  return [head, ...body].join("\n") + "\n";
}

function confusionFigure(conf: Record<string, Record<string, number>>): string {
  const cols: PredictedLabel[] = [...GOLD_LABELS, "absent"];
  const present = GOLD_LABELS.filter((g) =>
    cols.some((c) => (conf[g]?.[c] ?? 0) > 0),
  ) as GoldLabel[];
  const values = present.map((g) => {
    const total = cols.reduce((a, c) => a + (conf[g]?.[c] ?? 0), 0) || 1;
    return cols.map((c) => (conf[g]?.[c] ?? 0) / total);
  });
  return heatmap({
    title: "Where the parser disagrees with the annotator",
    subtitle: "Row-normalised. `absent` counts gold units the parser produced nothing for.",
    rowLabels: present.map(String),
    colLabels: cols.map(String),
    values,
    display: (r, c) => (values[r][c] === 0 ? "" : values[r][c].toFixed(2).replace(/^0/, "")),
    rowAxisLabel: "annotator",
    colAxisLabel: "parser",
  });
}

async function main(): Promise<void> {
  const goldSet = loadGold(GOLD_DIR);
  for (const issue of goldSet.issues) {
    console.log(`  annotation issue — ${issue.file}: ${issue.problem}`);
  }
  const manifest = loadManifest(join(CORPUS_DIR, "manifest.json"));
  const byPage = new Map(manifest.entries.map((e) => [e.page, e]));

  const files = readdirSync(CORPUS_DIR)
    .filter((f) => f.endsWith(".html"))
    .filter((f) => goldSet.byPage.has(f.replace(/\.html$/, "")))
    .filter((f) => ONLY.length === 0 || ONLY.includes(f.replace(/\.html$/, "")));

  console.log(`\nParser sanity check over ${files.length} page(s)\n`);

  const scores: PageScore[] = [];
  for (const f of files) {
    const page = f.replace(/\.html$/, "");
    const gold = chooseAnnotation(goldSet.byPage.get(page)!);
    const html = readFileSync(join(CORPUS_DIR, f), "utf8");
    const url = byPage.get(page)?.url ?? `file://${join(CORPUS_DIR, f)}`;
    const s = await scorePage(html, url, gold);
    if (!s) {
      console.log(`  ${page}: no scoreable units — skipped`);
      continue;
    }
    scores.push(s);
    console.log(
      `  ${s.human ? "human " : "oracle"}  ${page.slice(0, 40).padEnd(42)}` +
        `hidden ${s.hidden ? s.hidden.macroF1.toFixed(3) : "  -  "}` +
        ` vs ${s.hiddenNoInference ? s.hiddenNoInference.macroF1.toFixed(3) : "  -  "} no-inf` +
        ` (${String(s.hiddenUnits).padStart(4)})   ` +
        `declared ${s.declared ? s.declared.macroF1.toFixed(3) : "  -  "} (${String(s.declaredUnits).padStart(4)})`,
    );
  }

  const human = scores.filter((s) => s.human);
  const oracle = scores.filter((s) => !s.human);

  const md: string[] = [
    "# Parser sanity check",
    "",
    "Not a comparison. This says whether the structure driving the study's",
    "**semantic spatial** condition is really there — see `docs/evaluation-plan.md` §2.1.",
    "",
  ];

  const meanOf = (rows: PageScore[], pick: (r: PageScore) => NodeLabelScore | null) => {
    const vs = rows.map(pick).filter((x): x is NodeLabelScore => x !== null).map((x) => x.macroF1);
    return vs.length ? mean(vs) : NaN;
  };

  if (human.length > 0) {
    const hUnits = human.reduce((a, s) => a + s.hiddenUnits, 0);
    const dUnits = human.reduce((a, s) => a + s.declaredUnits, 0);
    const tags = new Map<string, number>();
    for (const r of human) for (const [t, n] of r.hiddenTags) tags.set(t, (tags.get(t) ?? 0) + n);

    md.push(
      "## The result — units the markup does not declare",
      "",
      "A **hidden** unit carries no HTML5 sectioning tag and no `role=`. The author",
      "marked up nothing, so the annotator's label came from reading the rendered",
      "page. A tags-only reader has no signal on these units at all; whatever the",
      "parser recovers here came from structural inference (Phase 3).",
      "",
      `On ${hUnits} hidden units the full parser scores ` +
        `**macro-F1 ${meanOf(human, (r) => r.hidden).toFixed(3)}**, against ` +
        `**${meanOf(human, (r) => r.hiddenNoInference).toFixed(3)}** for the same parser with ` +
        `structural inference switched off. On the ${dUnits} declared units it scores ` +
        `${meanOf(human, (r) => r.declared).toFixed(3)}. ${human.length} human-annotated page(s).`,
      "",
      "The control is the parser's own L1 configuration, not a tags-only baseline:",
      "`hidden` is *defined* as \"the tag does not yield the gold label\", so a tag",
      "reader scores zero here by construction and quoting that would be a tautology.",
      "",
      "| Page | hidden (L1+L2) | hidden (L1 only) | Δ | *n* | declared | *n* |",
      "|---|---:|---:|---:|---:|---:|---:|",
      ...human.map((r) => {
        const a = r.hidden?.macroF1, b = r.hiddenNoInference?.macroF1;
        const d = a !== undefined && b !== undefined ? (a - b >= 0 ? "+" : "") + (a - b).toFixed(3) : "—";
        return `| ${r.page.slice(0, 34)} | **${a?.toFixed(3) ?? "—"}** | ${b?.toFixed(3) ?? "—"} | ${d} | ${r.hiddenUnits} | ` +
          `${r.declared?.macroF1.toFixed(3) ?? "—"} | ${r.declaredUnits} |`;
      }),
      "",
      "Source tags carried by the hidden units: " +
        ([...tags].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([t, n]) => `\`<${t}>\` ${n}`).join(", ") || "—") +
        ".",
      "",
      "## Over all annotated units — context",
      "",
      `**macro-F1 ${mean(human.map((s) => s.score.macroF1)).toFixed(3)}** ` +
        `over ${human.length} page(s), ` +
        `${human.reduce((a, s) => a + s.goldUnits, 0)} annotated units.`,
      "",
      "| Page | macro-F1 | accuracy | units |",
      "|---|---:|---:|---:|",
      ...human.map(
        (s) =>
          `| ${s.page} | ${s.score.macroF1.toFixed(3)} | ` +
          `${s.score.accuracy.toFixed(3)} | ${s.goldUnits} |`,
      ),
      "",
      "### Per label",
      "",
      perLabelTable(human),
      "",
    );
  } else {
    md.push(
      "> **No human annotation in the corpus.** Everything below is scored against",
      "> the tag-derived placeholder, which the parser also reads — it cannot",
      "> support the validity argument. Annotate the study pages.",
      "",
    );
  }

  if (oracle.length > 0) {
    md.push(
      "## Against the placeholder oracle — smoke test only",
      "",
      "The parser reads the same tags this gold was derived from, so these numbers",
      "measure that the pipeline runs, not that it is right.",
      "",
      `macro-F1 ${mean(oracle.map((s) => s.score.macroF1)).toFixed(3)} over ${oracle.length} page(s).`,
      "",
    );
  }

  const conf = pooledConfusion(human.length > 0 ? human : scores);
  md.push("## Confusion matrix", "", "![confusion](confusion.svg)", "");

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, "sanity.md"), md.join("\n"));
  writeFileSync(join(OUT_DIR, "confusion.csv"), confusionCsv(conf));
  writeFileSync(join(OUT_DIR, "confusion.svg"), confusionFigure(conf));
  writeFileSync(
    join(OUT_DIR, "per-page.csv"),
    "page,annotator,human,goldUnits,htmlKb,timingMs,macroF1,hiddenF1,hiddenUnits,declaredF1,declaredUnits,accuracy,absentRate\n" +
      scores
        .map((s) =>
          [
            s.page,
            s.annotator,
            s.human,
            s.goldUnits,
            Math.round(s.htmlBytes / 1024),
            s.timingMs,
            s.score.macroF1.toFixed(4),
            s.hidden?.macroF1.toFixed(4) ?? "",
            s.hiddenUnits,
            s.declared?.macroF1.toFixed(4) ?? "",
            s.declaredUnits,
            s.score.accuracy.toFixed(4),
            s.score.absentRate.toFixed(4),
          ].join(","),
        )
        .join("\n") + "\n",
  );

  console.log(
    `\n  ${human.length} human-annotated, ${oracle.length} placeholder` +
      (human.length === 0 ? "  ⚠️  no human gold — see the report" : "") +
      `\n  written to ${OUT_DIR}\n`,
  );
}

if (existsSync(CORPUS_DIR)) {
  await main();
} else {
  console.log(`no corpus at ${CORPUS_DIR} — run \`npm run gold:fetch\` first`);
}
