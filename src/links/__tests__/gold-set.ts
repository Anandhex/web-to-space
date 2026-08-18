/**
 * links/__tests__/gold-set.ts — score `classify.ts` against the gold set.
 *
 *   npm run test:links
 *
 * Runs the real pipeline over the five annotated documents, matches every gold
 * anchor to the reference the collector produced for it, and reports per-region
 * precision, recall and F1 plus a confusion matrix.
 *
 * Two numbers are kept apart on purpose:
 *
 *  • RETENTION — how many gold anchors reached the scene at all. An anchor the
 *    parser dropped cannot be classified right or wrong, and folding those into
 *    recall would blame the classifier for a parser result. It is reported as
 *    its own figure because it is a real limit on the whole design: a reference
 *    that never reaches the IR gets no body however good the rules are.
 *  • ACCURACY — over the anchors that did arrive.
 *
 * Exits non-zero when `field` or `arrangement` fall below 0.9 F1, which is the
 * bar the build plan sets for the two structural regions. `footing` has no
 * threshold, and the plan says why: citation markup is inconsistent and that
 * region will be the weak one.
 *
 * ── Direction ──
 *
 * The geometry consumes DIRECTION, not region (`direction.ts`), so the same
 * anchors are scored a second time after the projection. Two things about that
 * number, stated rather than assumed:
 *
 *  • The gold set annotates a region, not a direction, and locus is mechanical
 *    — a function of href against page URL with no judgement in it. So the
 *    gold direction is the GOLD region projected through the link's own locus,
 *    and the predicted direction is the PREDICTED region through that same
 *    locus. Direction accuracy is therefore never worse than region accuracy.
 *  • That is the point. The gap between the two is exactly the set of region
 *    errors the projection absorbs — a `footing`/`field` confusion over a
 *    same-site href is a real miss in the region column and a non-event in the
 *    geometry, and the design should be able to say which of its misses cost
 *    the reader something.
 *
 * The projection table itself is asserted separately and exhaustively by
 * `direction.ts`, which runs first: a wrong table is caught by all 25 of its
 * cells, not by whichever ones the corpus happens to contain.
 */
import "../../eval/dom-bootstrap";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

import { parsePageToIR } from "../../ir/parser";
import { DEFAULT_CONFIG } from "../../ir/defaults";
import { mapIRToScene, DEFAULT_MAPPER_CONFIG } from "../../mapper/mapper";
import { computeLayoutPlan } from "../../layout/engine";
import { QUEST_3_PROFILE } from "../../layout/profiles";
import { collectSpatialLinks } from "../collect";
import { normaliseText } from "../classify";
import { DIRECTIONS, directionFor, type LinkDirection } from "../direction";
import type { Locus, Region } from "../types";
import { GOLD, type GoldAnchor } from "./gold-annotations";
import { runDirectionTable } from "./direction";

const DIR = "src/eval/link-corpus";
const REGIONS: Region[] = ["field", "arrangement", "ascent", "footing", "page"];
/** The two structural regions the plan holds to >= 0.9. */
const GATED: Region[] = ["field", "arrangement"];
const THRESHOLD = 0.9;
/**
 * Directions are REPORTED, not gated, and the reason is in the ambiguity
 * figure the scorer prints below: the gold set keys an annotation on href plus
 * anchor text, and on a docs page one href routinely appears twice — once in a
 * body list and once in the sidebar tree — with identical text both times. The
 * annotation cannot say which occurrence it meant, so a `up`/`lateral` split
 * over such a pair is a limit of the KEY, not of the projection or the rules.
 *
 * Gating a number that a harness artefact controls would only ever be resolved
 * by biasing the matcher, which is fitting the test to the answer. The gate
 * stays on region `field`/`arrangement`, where the plan put it; the projection
 * table is gated exhaustively by `direction.ts` instead.
 */
const GATED_DIRECTIONS: LinkDirection[] = [];

interface Scored extends GoldAnchor {
  predicted: Region | null;
  /** The matched link's locus — shared by the gold and predicted directions. */
  locus: Locus | null;
  /**
   * The href + text key matched several occurrences that classify differently,
   * so which one the annotation meant is not recoverable from the annotation.
   */
  ambiguous: boolean;
  /** The other regions those occurrences got, for the report. */
  alsoSeenAs: Region[];
}

function pad(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length);
}

async function main(): Promise<void> {
  // The projection table first — it needs no corpus, and a broken table would
  // make every direction number below meaningless.
  const table = runDirectionTable();
  for (const f of table.failures) console.error("  ✗ " + f);
  if (table.failures.length > 0) {
    console.error(`FAIL: direction table, ${table.failures.length} of ${table.checked} cases`);
    process.exit(1);
  }

  if (!existsSync(DIR)) {
    console.error(`No corpus at ${DIR}. Run: npm run census:fetch`);
    process.exit(1);
  }
  const sources: Record<string, string> = JSON.parse(
    readFileSync(join(DIR, "sources.json"), "utf8"),
  );

  const docs = [...new Set(GOLD.map((g) => g.doc))];
  const scored: Scored[] = [];

  for (const doc of docs) {
    const path = join(DIR, doc);
    if (!existsSync(path)) {
      console.error(`missing ${doc} — run npm run census:fetch`);
      process.exit(1);
    }
    const url = sources[doc];
    const ir = await parsePageToIR(readFileSync(path, "utf8"), url, undefined, DEFAULT_CONFIG);
    const scene = mapIRToScene(ir, DEFAULT_MAPPER_CONFIG);
    const plan = computeLayoutPlan(scene, QUEST_3_PROFILE, undefined, {});
    // dedupe OFF: the gold set annotates individual anchors, and several of
    // them are repeat occurrences of one href in different settings.
    const links = collectSpatialLinks(scene, plan, { pageUrl: url, dedupe: false });

    // Match on the raw href first — it is what the annotation was keyed on and
    // it survives the parser's label resolution. Where one href occurs several
    // times, prefer the occurrence whose anchor text matches, then take any.
    const byHref = new Map<string, typeof links>();
    for (const l of links) {
      const list = byHref.get(l.href) ?? [];
      list.push(l);
      byHref.set(l.href, list);
    }

    for (const g of GOLD.filter((x) => x.doc === doc)) {
      const candidates = byHref.get(g.href) ?? [];
      const wantText = normaliseText(g.text).toLowerCase();
      const exact = candidates.find(
        (c) => normaliseText(c.label).toLowerCase().startsWith(wantText.slice(0, 24)),
      );
      const hit = exact ?? candidates[0];
      // The annotation key is href + text, and one href can occur several
      // times on a page in settings that classify differently — a docs link in
      // a body list and again in the sidebar tree. When that happens the gold
      // label cannot say which occurrence it meant, so the scorer takes the
      // first and records that the choice was forced.
      const distinct = new Set(candidates.map((c) => c.region));
      scored.push({
        ...g,
        predicted: hit ? hit.region : null,
        locus: hit ? hit.locus : null,
        ambiguous: distinct.size > 1,
        alsoSeenAs: distinct.size > 1 ? [...distinct].filter((r) => r !== hit.region) : [],
      });
    }
  }

  // ── Retention ──
  const arrived = scored.filter((s) => s.predicted !== null);
  const dropped = scored.filter((s) => s.predicted === null);

  console.log("");
  console.log("Gold set: 5 documents, %d anchors", scored.length);
  console.log(
    "Retention: %d/%d (%s%%) reached the scene; %d were dropped before classification",
    arrived.length,
    scored.length,
    ((arrived.length / scored.length) * 100).toFixed(1),
    dropped.length,
  );
  console.log("");

  // ── Per-region P/R/F over the anchors that arrived ──
  console.log("Per region, over the %d anchors that arrived:", arrived.length);
  console.log("");
  console.log(`  ${pad("region", 14)}${pad("gold", 6)}${pad("pred", 6)}${pad("tp", 5)}${pad("precision", 11)}${pad("recall", 9)}f1`);
  const f1s = new Map<Region, number>();
  for (const r of REGIONS) {
    const gold = arrived.filter((s) => s.region === r).length;
    const pred = arrived.filter((s) => s.predicted === r).length;
    const tp = arrived.filter((s) => s.region === r && s.predicted === r).length;
    const precision = pred ? tp / pred : gold === 0 ? 1 : 0;
    const recall = gold ? tp / gold : 1;
    const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
    f1s.set(r, f1);
    console.log(
      `  ${pad(r, 14)}${pad(String(gold), 6)}${pad(String(pred), 6)}${pad(String(tp), 5)}` +
        `${pad(precision.toFixed(3), 11)}${pad(recall.toFixed(3), 9)}${f1.toFixed(3)}` +
        (GATED.includes(r) ? (f1 >= THRESHOLD ? "  ✓" : "  ✗ below 0.90") : ""),
    );
  }
  const correct = arrived.filter((s) => s.region === s.predicted).length;
  console.log("");
  console.log(
    "  overall accuracy %s (%d/%d)",
    ((correct / Math.max(1, arrived.length)) * 100).toFixed(1) + "%",
    correct,
    arrived.length,
  );

  // ── Confusion matrix ──
  console.log("");
  console.log("Confusion (rows = gold, columns = predicted):");
  console.log("");
  console.log(`  ${pad("", 14)}${REGIONS.map((r) => pad(r, 13)).join("")}`);
  for (const g of REGIONS) {
    const cells = REGIONS.map((p) =>
      pad(String(arrived.filter((s) => s.region === g && s.predicted === p).length), 13),
    );
    console.log(`  ${pad(g, 14)}${cells.join("")}`);
  }

  // ── The same anchors, projected onto direction ──
  //
  // Both sides go through the SAME locus (the header says why), so this
  // measures the projection, not a second classifier.
  const goldDir = (s: Scored): LinkDirection => directionFor(s.region, s.locus ?? "unknown");
  const predDir = (s: Scored): LinkDirection =>
    directionFor(s.predicted ?? "field", s.locus ?? "unknown");

  console.log("");
  console.log("Per direction, over the same %d anchors:", arrived.length);
  console.log("");
  console.log(`  ${pad("direction", 14)}${pad("gold", 6)}${pad("pred", 6)}${pad("tp", 5)}${pad("precision", 11)}${pad("recall", 9)}f1`);
  const dirF1s = new Map<LinkDirection, number>();
  for (const d of DIRECTIONS) {
    const gold = arrived.filter((s) => goldDir(s) === d).length;
    const pred = arrived.filter((s) => predDir(s) === d).length;
    const tp = arrived.filter((s) => goldDir(s) === d && predDir(s) === d).length;
    const precision = pred ? tp / pred : gold === 0 ? 1 : 0;
    const recall = gold ? tp / gold : 1;
    const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
    dirF1s.set(d, f1);
    console.log(
      `  ${pad(d, 14)}${pad(String(gold), 6)}${pad(String(pred), 6)}${pad(String(tp), 5)}` +
        `${pad(precision.toFixed(3), 11)}${pad(recall.toFixed(3), 9)}${f1.toFixed(3)}` +
        (GATED_DIRECTIONS.includes(d) ? (f1 >= THRESHOLD ? "  ✓" : "  ✗ below 0.90") : ""),
    );
  }
  const dirCorrect = arrived.filter((s) => goldDir(s) === predDir(s)).length;
  console.log("");
  console.log(
    "  overall direction accuracy %s (%d/%d)",
    ((dirCorrect / Math.max(1, arrived.length)) * 100).toFixed(1) + "%",
    dirCorrect,
    arrived.length,
  );
  console.log(
    "  %d region miss%s the projection absorbs (same direction either way)",
    dirCorrect - correct,
    dirCorrect - correct === 1 ? "" : "es",
  );

  console.log("");
  console.log("Direction confusion (rows = gold, columns = predicted):");
  console.log("");
  console.log(`  ${pad("", 14)}${DIRECTIONS.map((d) => pad(d, 10)).join("")}`);
  for (const g of DIRECTIONS) {
    const cells = DIRECTIONS.map((p) =>
      pad(String(arrived.filter((s) => goldDir(s) === g && predDir(s) === p).length), 10),
    );
    console.log(`  ${pad(g, 14)}${cells.join("")}`);
  }

  const dirMisses = arrived.filter((s) => goldDir(s) !== predDir(s));
  if (dirMisses.length > 0) {
    console.log("");
    console.log("Direction misses (%d) — these are the ones that move the reader wrongly:", dirMisses.length);
    for (const m of dirMisses)
      console.log(
        `  gold=${pad(goldDir(m), 8)} got=${pad(predDir(m), 8)}${m.ambiguous ? " [ambiguous]" : "            "} ` +
          `${JSON.stringify(m.text.slice(0, 30))}  ${m.href.slice(0, 46)}`,
      );
    const forced = dirMisses.filter((m) => m.ambiguous).length;
    if (forced > 0)
      console.log(
        "  %d of these %s ambiguous: the href occurs more than once on the page in settings\n" +
          "  that classify differently (a body list AND the sidebar tree), and the annotation\n" +
          "  key — href plus anchor text — cannot say which occurrence it meant. Disambiguating\n" +
          "  the ANNOTATION is the fix; biasing the matcher would be fitting the test.",
        forced,
        forced === 1 ? "is" : "are",
      );
  }

  // ── Every miss, in full ──
  const misses = arrived.filter((s) => s.region !== s.predicted);
  if (misses.length > 0) {
    console.log("");
    console.log("Misses (%d):", misses.length);
    for (const m of misses) {
      console.log(
        `  gold=${pad(m.region, 12)} got=${pad(m.predicted ?? "-", 12)} ${JSON.stringify(m.text.slice(0, 34))}  ${m.href.slice(0, 58)}`,
      );
      if (m.note) console.log(`      note: ${m.note}`);
    }
  }

  if (dropped.length > 0) {
    console.log("");
    console.log("Dropped before classification (%d) — a parser/mapper limit, not a rule:", dropped.length);
    for (const d of dropped)
      console.log(`  ${pad(d.region, 12)} ${JSON.stringify(d.text.slice(0, 34))}  ${d.href.slice(0, 58)}`);
  }

  // ── Arguable labels, reported separately ──
  const judged = arrived.filter((s) => s.note);
  const judgedRight = judged.filter((s) => s.region === s.predicted).length;
  console.log("");
  console.log(
    "%d of the %d anchors that arrived carry a judgement-call note; the classifier agrees with %d of them.",
    judged.length,
    arrived.length,
    judgedRight,
  );
  console.log(
    "Accuracy excluding those: %s%%",
    (
      ((correct - judgedRight) / Math.max(1, arrived.length - judged.length)) *
      100
    ).toFixed(1),
  );
  console.log("");

  const failed = GATED.filter((r) => (f1s.get(r) ?? 0) < THRESHOLD);
  const dirFailed = GATED_DIRECTIONS.filter((d) => (dirF1s.get(d) ?? 0) < THRESHOLD);
  if (failed.length > 0 || dirFailed.length > 0) {
    if (failed.length > 0)
      console.error(`FAIL: region ${failed.join(", ")} below F1 ${THRESHOLD}`);
    if (dirFailed.length > 0)
      console.error(`FAIL: direction ${dirFailed.join(", ")} below F1 ${THRESHOLD}`);
    process.exit(1);
  }
  console.log("PASS");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
