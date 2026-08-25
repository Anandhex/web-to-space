/**
 * eval/gold/lint.ts — check annotations against the written guidelines.
 *
 *   npm run gold:lint
 *   npm run gold:lint -- --page divsoup-blog
 *
 * This does NOT overrule an annotator. The annotation is the ground truth by
 * construction, and a tool that "corrects" it would rebuild the circularity the
 * gold standard exists to break — the labels would drift back toward whatever
 * the markup says, which is what the parser reads.
 *
 * What it does is narrower and genuinely useful: the guidelines
 * (docs/annotation-guidelines.md §3) fix a handful of tie-breaks so that two
 * annotators produce the same labels. Where a label contradicts one of those
 * written rules, exactly one of two things is true — the label should change, or
 * the rule should — and either way somebody has to decide before annotator B
 * does the same page and κ collapses. The lint finds those cases and says which
 * rule is in play.
 *
 * Only mechanically defensible rules are checked. Judgement calls the guidelines
 * leave open ("is this block a caption or a paragraph?") are not linted, because
 * a lint that nags about judgement is a lint that gets ignored.
 */
import "../dom-bootstrap";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadGold, type GoldAnnotation } from "./schema";
import { selectAnnotatableElements } from "./units";
import { GOLD_LABELS, type GoldLabel } from "./labels";
import { siteChromeRegion } from "./chrome";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const CORPUS = join(HERE, "..", "gold-corpus");
const GOLD_DIR = join(HERE, "..", "gold-annotations");

/** Pages with at least this many units should exercise more of the vocabulary. */
const BREADTH_MIN_UNITS = 15;
const BREADTH_MIN_LABELS = 4;

export interface LintFinding {
  page: string;
  annotator: string;
  evalId: string;
  rule: string;
  expected: GoldLabel | null;
  actual: GoldLabel;
  excerpt: string;
  severity: "conflict" | "note";
}

interface TagRule {
  rule: string;
  /** CSS selector the element must match. */
  selector: string;
  expected: GoldLabel;
}

/**
 * The guideline rules a machine can check. Each cites the guideline it comes
 * from, so a finding is actionable without re-reading the document.
 */
const TAG_RULES: TagRule[] = [
  { rule: "label table: images and figures are `figure`", selector: "img, picture, figure, figcaption", expected: "figure" },
  { rule: "label table: video/audio are `media`", selector: "video, audio", expected: "media" },
  { rule: "label table: headings are `heading`", selector: "h1, h2, h3, h4, h5, h6", expected: "heading" },
  { rule: "label table: lists and their items are `list`", selector: "ul, ol, dl, li, dt", expected: "list" },
  { rule: "label table: tables and their cells are `table`", selector: "table, thead, tbody, tr, td, th", expected: "table" },
  { rule: "§3.11: a form and everything in it is `control`", selector: "form, fieldset, input, select, textarea, button", expected: "control" },
  { rule: "label table: code blocks are `code`", selector: "pre, code", expected: "code" },
  { rule: "label table: nav is `navigation`", selector: "nav", expected: "navigation" },
];

/** §3.3 — a block whose text is ≥60% links is `navigation`. */
function linkDensity(el: Element): number {
  const total = (el.textContent ?? "").replace(/\s+/g, "").length;
  if (total === 0) return 0;
  let linked = 0;
  for (const a of Array.from(el.querySelectorAll("a[href]"))) {
    linked += (a.textContent ?? "").replace(/\s+/g, "").length;
  }
  return linked / total;
}

export function lintPage(
  html: string,
  annotation: GoldAnnotation,
): LintFinding[] {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const units = selectAnnotatableElements(doc);
  const byId = new Map(units.map((u) => [u.evalId, u]));
  const findings: LintFinding[] = [];

  for (const [evalId, actual] of Object.entries(annotation.nodes)) {
    const unit = byId.get(evalId);
    if (!unit) continue;
    const el = unit.el;
    const excerpt = unit.preview.slice(0, 46) || `<${unit.tag}>`;
    const add = (rule: string, expected: GoldLabel | null, severity: LintFinding["severity"] = "conflict") =>
      findings.push({
        page: annotation.page,
        annotator: annotation.annotator,
        evalId,
        rule,
        expected,
        actual,
        excerpt,
        severity,
      });

    // Chrome first: §3 rule 4 is subtractive and overrides what the element is —
    // including the tag rules below. `continue` unconditionally, not only when
    // the label conflicts: a correctly-labelled `chrome` unit that fell through
    // was then flagged by the tag table for being an `<li>`, which reported
    // 50 conflicts against labels that follow the guidelines exactly.
    const chrome = siteChromeRegion(el);
    if (chrome) {
      if (actual !== "chrome") {
        add(`§3 rule 4: inside site chrome (${chrome.why})`, "chrome");
      }
      continue;
    }

    let matched = false;
    for (const r of TAG_RULES) {
      if (!el.matches?.(r.selector)) continue;
      matched = true;
      if (actual !== r.expected) add(r.rule, r.expected);
      break;
    }
    if (matched) continue;

    const density = linkDensity(el);
    if (density >= 0.6 && actual !== "navigation" && actual !== "chrome") {
      add(
        `§3.3: ${Math.round(density * 100)}% of this block's text is links (≥60% ⇒ navigation)`,
        "navigation",
      );
    }
  }

  // Vocabulary breadth. Not a rule violation — a page really can be all prose —
  // but a long page using three labels is usually a pass that settled into a
  // groove, and it is worth a second look before it becomes half the corpus.
  const used = new Set(Object.values(annotation.nodes));
  const count = Object.keys(annotation.nodes).length;
  if (count >= BREADTH_MIN_UNITS && used.size < BREADTH_MIN_LABELS) {
    findings.push({
      page: annotation.page,
      annotator: annotation.annotator,
      evalId: "—",
      rule: `only ${used.size} of ${GOLD_LABELS.length} labels used across ${count} units (${[...used].join(", ")})`,
      expected: null,
      actual: "other",
      excerpt: "whole page",
      severity: "note",
    });
  }

  // Layers B and C are optional, but their absence should be a decision rather
  // than an oversight — pressing `s` in the tool is the whole of Layer B.
  if (!annotation.segments || Object.keys(annotation.segments).length === 0) {
    findings.push({
      page: annotation.page,
      annotator: annotation.annotator,
      evalId: "—",
      rule: "no segments (Layer B) — press `s` at the start of each coherent block; without it this page scores no BCubed and no reading order",
      expected: null,
      actual: "other",
      excerpt: "whole page",
      severity: "note",
    });
  }

  return findings;
}

/**
 * Report how each annotation's labels came about.
 *
 * Seeding the unambiguous units is what makes 60 pages affordable, and it is
 * also the most direct route back into defect D1 — a seeded label nobody
 * disagreed with is the seed's label, and the seed reads tags. The rate is
 * therefore not a diagnostic, it is a number the write-up owes the reader:
 * a page that is 95% `unreviewed` is a page the annotator did not annotate.
 *
 * `changed` is the interesting column. A seeded pass where the annotator
 * overrides almost nothing is either a very good seed or an annotator who
 * stopped reading, and only a `--blind` pass on the same page separates those.
 */
function reportProvenance(
  gold: ReturnType<typeof loadGold>,
  onlyPage: string | null,
  available: Set<string>,
): void {
  const rows: string[] = [];
  for (const [page, byAnnotator] of gold.byPage) {
    if (onlyPage && page !== onlyPage) continue;
    if (!available.has(page)) continue;
    for (const annotation of byAnnotator.values()) {
      if (annotation.provisional) continue;
      const total = Object.keys(annotation.nodes).length;
      if (total === 0) continue;
      const prov = annotation.provenance;
      if (!prov) {
        rows.push(
          `    ${page} (${annotation.annotator}): no provenance recorded — ` +
            "annotated before seeding existed, or by hand",
        );
        continue;
      }
      const count: Record<string, number> = {};
      for (const id of Object.keys(annotation.nodes)) {
        const p = prov[id] ?? "unreviewed";
        count[p] = (count[p] ?? 0) + 1;
      }
      const pct = (n: number): string => `${Math.round(((n ?? 0) / total) * 100)}%`;
      const untouched = count.unreviewed ?? 0;
      const ruled = count["rule-applied"] ?? 0;
      rows.push(
        `    ${page} (${annotation.annotator}): ${total} units · ` +
          `${pct(count.blind ?? 0)} blind · ${pct(count.confirmed ?? 0)} confirmed · ` +
          `${pct(count.changed ?? 0)} changed · ${pct(untouched)} UNREVIEWED` +
          (ruled ? ` · ${pct(ruled)} RULE-APPLIED` : "") +
          (annotation.seededFrom ? `  (seed: ${annotation.seededFrom})` : ""),
      );
      if (ruled > 0) {
        rows.push(
          `      note  ${ruled} label(s) come from a subtractive guideline rule applied after` +
            " annotation, not from this annotator — see `npm run gold:reannotate`",
        );
      }
      if (untouched * 2 > total) {
        rows.push(
          `      ⚠️  over half this page is the seed's answer, not the annotator's`,
        );
      }
    }
  }
  if (rows.length === 0) return;
  console.log("\n  Label provenance — what the annotator actually decided:\n");
  for (const r of rows) console.log(r);
  console.log(
    "\n    A `--blind` pass on one page, compared against its seeded pass, is the\n" +
      "    anchoring-bias estimate. Without it the confirmed/changed split is not\n" +
      "    evidence that the seed was right.",
  );
}

function main(): void {
  const onlyPage = process.argv.includes("--page")
    ? process.argv[process.argv.indexOf("--page") + 1]
    : null;
  const goldDir = process.argv.includes("--gold")
    ? resolve(process.cwd(), process.argv[process.argv.indexOf("--gold") + 1])
    : GOLD_DIR;

  const gold = loadGold(goldDir);
  if (gold.byPage.size === 0) {
    console.error(`No annotations in ${goldDir}`);
    process.exit(1);
  }

  const available = new Set(
    existsSync(CORPUS)
      ? readdirSync(CORPUS).filter((f) => f.endsWith(".html")).map((f) => f.replace(/\.html$/, ""))
      : [],
  );

  const all: LintFinding[] = [];
  for (const [page, byAnnotator] of gold.byPage) {
    if (onlyPage && page !== onlyPage) continue;
    if (!available.has(page)) continue;
    const html = readFileSync(join(CORPUS, `${page}.html`), "utf8");
    for (const annotation of byAnnotator.values()) {
      if (annotation.provisional) continue;
      all.push(...lintPage(html, annotation));
    }
  }

  reportProvenance(gold, onlyPage, available);

  const conflicts = all.filter((f) => f.severity === "conflict");
  const notes = all.filter((f) => f.severity === "note");

  if (all.length === 0) {
    console.log("\n  No guideline conflicts found.\n");
    return;
  }

  console.log("");
  if (conflicts.length > 0) {
    console.log(`  ${conflicts.length} label(s) conflict with a written guideline:\n`);
    let lastPage = "";
    for (const f of conflicts) {
      if (f.page !== lastPage) {
        console.log(`  ${f.page}  (annotator: ${f.annotator})`);
        lastPage = f.page;
      }
      console.log(
        `    ${f.evalId.padEnd(5)} labelled ${f.actual.padEnd(13)} guideline says ${String(f.expected).padEnd(13)} "${f.excerpt}"`,
      );
      console.log(`          ${f.rule}`);
    }
    console.log("");
  }
  for (const f of notes) {
    console.log(`  note  ${f.page}: ${f.rule}`);
  }
  console.log(
    "\n  Neither the labels nor the guidelines are automatically right. Decide which\n" +
      "  changes, then re-annotate or amend docs/annotation-guidelines.md §3 — the point\n" +
      "  is that the next annotator makes the same call, not that this one was wrong.\n",
  );
}

main();
