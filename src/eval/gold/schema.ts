/**
 * eval/gold/schema.ts — the on-disk gold-annotation format, its validator and
 * its loader.
 *
 * One file per (page, annotator). Records key on `data-eval-id`, stamped into a
 * frozen snapshot by `stamp.ts` before annotation begins. They do NOT key on CSS
 * selectors: the older `SegmentationAnnotation` (selector → label) is fine for a
 * three-fixture corpus and silently changes meaning at sixty pages, because a
 * hand-written selector re-matches when the markup shifts and nobody notices.
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import { GOLD_LABELS, type GoldLabel } from "./labels";

/** The five sampling strata of the gold corpus. */
export const STRATA = ["S1", "S2", "S3", "S4", "S5"] as const;
export type Stratum = (typeof STRATA)[number];

export const STRATUM_NAMES: Record<Stratum, string> = {
  S1: "Semantic",
  S2: "Div-soup",
  S3: "Framework",
  S4: "Reference/docs",
  S5: "App-like",
};

export interface CorpusEntry {
  /** File slug, without extension — the join key across every artefact. */
  page: string;
  url: string;
  stratum: Stratum;
  fetchedAt: string;
  /** How the page entered the corpus. Convenience samples are marked. */
  sampling: "random" | "convenience";
  archiver?: string;
  bytes?: number;
}

export interface CorpusManifest {
  generatedAt: string;
  entries: CorpusEntry[];
}

/**
 * One annotator's pass over one page.
 *
 * `nodes`, `segments` and `readingOrder` are annotation Layers A, B and C of
 * docs/evaluation-plan.md. A file may carry only some of them; the
 * scorers skip a page for a layer it has no gold for rather than scoring it
 * against nothing.
 */
export interface GoldAnnotation {
  page: string;
  annotator: string;
  annotatedAt: string;
  /** Layer A — `data-eval-id` → collapsed role label. */
  nodes: Record<string, GoldLabel>;
  /** Layer B — `data-eval-id` → segment identifier (free-form, page-local). */
  segments?: Record<string, string>;
  /** Layer C — the segment ids of Layer B in intended reading order. */
  readingOrder?: string[];
  /** Set when this file was produced by the provisional oracle, not a human. */
  provisional?: boolean;
  /**
   * How each label came about, when the annotator worked from a seeded pass.
   *
   * Seeding the unambiguous units cuts the labelling cost by most of itself, but
   * it re-opens the circularity the gold standard exists to break: a seeded
   * label the annotator never disagreed with is the seed's label, and if the
   * seed reads tags then so does the gold. The mitigation is to say which is
   * which, per unit, and to report the rate. A `confirmed` label was looked at;
   * an `unreviewed` one was not, and is the seed speaking.
   */
  provenance?: Record<string, AnnotationProvenance>;
  /** Which annotation file the seed came from, if any. */
  seededFrom?: string;
  notes?: string;
}

/** @see GoldAnnotation.provenance */
export const ANNOTATION_PROVENANCE = [
  "blind",
  "confirmed",
  "changed",
  "unreviewed",
  /**
   * Not a human decision. A guideline rule that is SUBTRACTIVE and mechanical —
   * "anything inside site chrome is chrome" — was amended after this page was
   * annotated and applied to the units it covers by `npm run gold:reannotate`.
   *
   * It exists so the file cannot quietly stop being a human annotation. A label
   * carrying this value is the guideline speaking, and anything computed from
   * this page has to be able to say how much of it that is.
   */
  "rule-applied",
] as const;

export type AnnotationProvenance = (typeof ANNOTATION_PROVENANCE)[number];

export interface AnnotationIssue {
  file: string;
  problem: string;
}

const LABEL_SET = new Set<string>(GOLD_LABELS);

export function validateAnnotation(
  a: unknown,
  file: string,
): { ok: GoldAnnotation | null; issues: AnnotationIssue[] } {
  const issues: AnnotationIssue[] = [];
  const bad = (problem: string) => issues.push({ file, problem });
  if (typeof a !== "object" || a === null) {
    bad("not an object");
    return { ok: null, issues };
  }
  const o = a as Record<string, unknown>;
  if (typeof o.page !== "string") bad("missing `page`");
  if (typeof o.annotator !== "string") bad("missing `annotator`");
  if (typeof o.nodes !== "object" || o.nodes === null) bad("missing `nodes`");
  else {
    for (const [id, label] of Object.entries(o.nodes)) {
      if (!LABEL_SET.has(label as string)) {
        bad(`node ${id}: "${String(label)}" is not a gold label`);
      }
    }
  }
  if (o.readingOrder !== undefined && !Array.isArray(o.readingOrder)) {
    bad("`readingOrder` is not an array");
  }
  // A reading order over segments that Layer B never defined cannot be scored.
  if (Array.isArray(o.readingOrder) && o.segments) {
    const defined = new Set(Object.values(o.segments as Record<string, string>));
    for (const s of o.readingOrder as string[]) {
      if (!defined.has(s)) bad(`readingOrder references undefined segment "${s}"`);
    }
  }
  if (issues.length > 0) return { ok: null, issues };
  return { ok: a as GoldAnnotation, issues };
}

export interface LoadedGold {
  /** page → annotator → annotation. */
  byPage: Map<string, Map<string, GoldAnnotation>>;
  issues: AnnotationIssue[];
  annotators: string[];
  provisional: boolean;
}

/**
 * Load every `*.json` under `dir` as an annotation. Files that fail validation
 * are reported and skipped — a malformed gold file must never silently become a
 * page that "no system got right".
 */
export function loadGold(dir: string): LoadedGold {
  const byPage = new Map<string, Map<string, GoldAnnotation>>();
  const issues: AnnotationIssue[] = [];
  const annotators = new Set<string>();
  let provisional = false;
  if (!existsSync(dir)) return { byPage, issues, annotators: [], provisional };
  // `.superseded.json` is the pre-amendment copy `gold:reannotate` leaves behind
  // so a rule pass is reversible. It carries the same `page` and `annotator` as
  // the live file, so loading it would either collide with that file or — worse,
  // if the collision were resolved by filename — invent a second annotator and
  // put a page's own history into the κ table as if two people had labelled it.
  const files = readdirSync(dir).filter(
    (n) => n.endsWith(".json") && !n.endsWith(".superseded.json"),
  );
  for (const f of files) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(join(dir, f), "utf8"));
    } catch (err) {
      issues.push({ file: f, problem: `unparseable: ${String(err)}` });
      continue;
    }
    const { ok, issues: fileIssues } = validateAnnotation(parsed, f);
    issues.push(...fileIssues);
    if (!ok) continue;
    if (ok.provisional) provisional = true;
    annotators.add(ok.annotator);
    let perPage = byPage.get(ok.page);
    if (!perPage) {
      perPage = new Map();
      byPage.set(ok.page, perPage);
    }
    if (perPage.has(ok.annotator)) {
      issues.push({
        file: f,
        problem: `duplicate annotation for ${ok.page} by ${ok.annotator}`,
      });
      continue;
    }
    perPage.set(ok.annotator, ok);
  }
  return {
    byPage,
    issues,
    annotators: [...annotators].sort(),
    provisional,
  };
}

export function loadManifest(path: string): CorpusManifest {
  if (!existsSync(path)) return { generatedAt: "", entries: [] };
  return JSON.parse(readFileSync(path, "utf8")) as CorpusManifest;
}

export function pageSlug(file: string): string {
  return basename(file).replace(/\.html?$/i, "");
}
