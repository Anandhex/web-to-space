/**
 * eval/node-labels.ts — Layer A scoring: node role labels against gold.
 *
 * Produces per-label precision/recall/F1, macro-F1 (the pre-registered primary
 * endpoint), weighted accuracy, and the 13 × 14 confusion matrix.
 *
 * Macro-F1 rather than accuracy, because `prose` is 60–80% of every page's
 * units by count. An accuracy score is very nearly "did you notice this is
 * text", which every system passes; macro-F1 refuses to let the majority label
 * drown out `navigation`, `control` and `table`, which are the labels the
 * spatial mapper actually branches on.
 */
import {
  GOLD_LABELS,
  PREDICTED_LABELS,
  type GoldLabel,
  type PredictedLabel,
} from "./gold/labels";
import type { GoldUnit } from "./gold/align";

export interface LabelScore {
  label: GoldLabel;
  precision: number;
  recall: number;
  f1: number;
  /** Number of gold units carrying this label. */
  support: number;
}

export interface NodeLabelScore {
  /** Primary endpoint: unweighted mean F1 over labels with non-zero support. */
  macroF1: number;
  /** Support-weighted mean F1 — reported beside macro, never instead of it. */
  weightedF1: number;
  /** Plain agreement, unit-counted. */
  accuracy: number;
  /** Agreement weighted by visual mass (pixel area, or text length offline). */
  massAccuracy: number;
  perLabel: LabelScore[];
  /** `confusion[gold][predicted]` — counts. Predicted includes `absent`. */
  confusion: Record<GoldLabel, Record<PredictedLabel, number>>;
  /** Gold units that the system produced nothing for, as a fraction (0–1). */
  absentRate: number;
  unitCount: number;
  /**
   * Of the gold units labelled `chrome`, the fraction the system produced
   * nothing for. HIGHER IS BETTER — this pipeline drops banner/contentinfo on
   * purpose, so producing nothing for page chrome is correct behaviour, and a
   * system that faithfully reproduces the cookie bar should not be rewarded.
   * Reported separately for exactly that reason: `chrome` is excluded from the
   * scored labels, because scoring "did you emit the footer" as if it were a
   * classification would penalise every system for doing the right thing.
   */
  boilerplateRejection: number | null;
  chromeUnits: number;
  /** Labels held out of the scored set for this run. */
  excluded: GoldLabel[];
  /** Scored units where the system disagreed with the annotator. */
  disagreements: number;
  /**
   * Of those, how many landed on a node that exists because a run of siblings
   * was GROUPED, rather than because the parser classified an element that way.
   *
   * This explains a disagreement; it does not excuse one. A run of prose divs
   * grouped into a `list` becomes `XRListItem` primitives, and those render as
   * separate cards with their own surfaces — so a reader sees four cards where
   * the annotator saw continuous prose. The reader is affected either way. The
   * number is here so the thesis can say WHICH kind of mistake dominates, not so
   * a mistake can be reclassified as a non-mistake.
   */
  disagreementsFromGrouping: number;
}

/** Why a system gave a unit the label it did. */
export interface UnitProvenance {
  grouping: string | null;
  sourceTag: string | null;
}

/** Labels held out of scoring by default. See `boilerplateRejection`. */
export const DEFAULT_EXCLUDED: GoldLabel[] = ["chrome"];

function emptyConfusion(): Record<GoldLabel, Record<PredictedLabel, number>> {
  const m = {} as Record<GoldLabel, Record<PredictedLabel, number>>;
  for (const g of GOLD_LABELS) {
    const row = {} as Record<PredictedLabel, number>;
    for (const p of PREDICTED_LABELS) row[p] = 0;
    m[g] = row;
  }
  return m;
}

export function scoreNodeLabels(
  units: GoldUnit[],
  predicted: Map<string, PredictedLabel>,
  provenance?: Map<string, UnitProvenance>,
  excluded: GoldLabel[] = DEFAULT_EXCLUDED,
): NodeLabelScore {
  const confusion = emptyConfusion();
  const excludedSet = new Set(excluded);
  let correct = 0;
  let mass = 0;
  let massCorrect = 0;
  let absent = 0;
  let scoredUnits = 0;
  let chromeUnits = 0;
  let chromeRejected = 0;
  let disagreements = 0;
  let disagreementsFromGrouping = 0;

  for (const u of units) {
    const p = predicted.get(u.evalId) ?? "absent";
    // The confusion matrix keeps every row, excluded or not — the figure is
    // there to show what happened, and hiding the chrome row would hide the
    // one place a system's boilerplate handling is visible.
    confusion[u.label][p] += 1;
    if (u.label === "chrome") {
      chromeUnits++;
      if (p === "absent") chromeRejected++;
    }
    if (excludedSet.has(u.label)) continue;
    scoredUnits++;
    mass += u.weight;
    if (p === u.label) {
      correct++;
      massCorrect += u.weight;
    } else {
      disagreements++;
      if (provenance?.get(u.evalId)?.grouping) disagreementsFromGrouping++;
    }
    if (p === "absent") absent++;
  }

  const perLabel: LabelScore[] = [];
  for (const g of GOLD_LABELS) {
    if (excludedSet.has(g)) continue;
    const tp = confusion[g][g];
    const support = PREDICTED_LABELS.reduce((s, p) => s + confusion[g][p], 0);
    // False positives: units of some OTHER SCORED gold label predicted as `g`.
    // Units of an excluded label are not counted against `g` — a footer
    // paragraph the system called `prose` is out of scope, not a mistake.
    let fp = 0;
    for (const other of GOLD_LABELS) {
      if (other !== g && !excludedSet.has(other)) fp += confusion[other][g];
    }
    const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
    const recall = support === 0 ? 0 : tp / support;
    const f1 =
      precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
    perLabel.push({ label: g, precision, recall, f1, support });
  }

  // Labels absent from this page's gold are not scored. Including them would
  // add a zero for a distinction the page never offered, and pages would rank
  // by which labels they happen to contain rather than by parser quality.
  const present = perLabel.filter((l) => l.support > 0);
  const macroF1 = present.length
    ? present.reduce((s, l) => s + l.f1, 0) / present.length
    : 0;
  const supportSum = present.reduce((s, l) => s + l.support, 0) || 1;
  const weightedF1 =
    present.reduce((s, l) => s + l.f1 * l.support, 0) / supportSum;

  const n = scoredUnits || 1;
  return {
    macroF1,
    weightedF1,
    accuracy: correct / n,
    massAccuracy: mass > 0 ? massCorrect / mass : 0,
    perLabel,
    confusion,
    absentRate: absent / n,
    unitCount: scoredUnits,
    boilerplateRejection: chromeUnits > 0 ? chromeRejected / chromeUnits : null,
    chromeUnits,
    excluded,
    disagreements,
    disagreementsFromGrouping,
  };
}

/** Element-wise sum of confusion matrices, for corpus-level aggregation. */
export function sumConfusions(
  ms: Array<Record<GoldLabel, Record<PredictedLabel, number>>>,
): Record<GoldLabel, Record<PredictedLabel, number>> {
  const out = emptyConfusion();
  for (const m of ms) {
    for (const g of GOLD_LABELS) {
      for (const p of PREDICTED_LABELS) out[g][p] += m[g][p];
    }
  }
  return out;
}

/**
 * Per-label scores recomputed from a pooled confusion matrix.
 *
 * Not the same number as averaging the per-page scores, and the difference
 * matters: pooling lets a single large page dominate, per-page averaging gives
 * every page one vote. The report prints per-page means for the endpoints and
 * pools only for the confusion figure, where the question is "what kind of
 * mistake does this system make", not "how often".
 */
export function perLabelFromConfusion(
  confusion: Record<GoldLabel, Record<PredictedLabel, number>>,
  excluded: GoldLabel[] = DEFAULT_EXCLUDED,
): LabelScore[] {
  const excludedSet = new Set(excluded);
  const out: LabelScore[] = [];
  for (const g of GOLD_LABELS) {
    if (excludedSet.has(g)) continue;
    const tp = confusion[g][g];
    const support = PREDICTED_LABELS.reduce((s, p) => s + confusion[g][p], 0);
    let fp = 0;
    for (const other of GOLD_LABELS) {
      if (other !== g && !excludedSet.has(other)) fp += confusion[other][g];
    }
    const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
    const recall = support === 0 ? 0 : tp / support;
    const f1 =
      precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
    out.push({ label: g, precision, recall, f1, support });
  }
  return out;
}
