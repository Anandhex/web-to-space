/**
 * eval/gold/provisional.ts — a placeholder ground truth, so the machinery can be
 * built, debugged and demonstrated before thirty hours of human labelling exist.
 *
 *   npm run gold:provisional
 *
 * ⚠️  WHAT THIS IS NOT
 *
 * These labels are derived from HTML tags. That is precisely defect D1 of
 * docs/evaluation-plan.md — the parser reads the same tags, so scoring it
 * against them is scoring it against a paraphrase of its own input. Numbers
 * produced from provisional gold say only that the pipeline runs end to end.
 * They are not evidence for anything and every artefact generated from them is
 * stamped `provisional` and refuses to be presented as a result.
 *
 * It is still worth having: it exercises the alignment, the scorers, the
 * statistics and every figure against real pages, so that when the human labels
 * arrive the only thing that changes is the contents of `gold-annotations/`.
 */
import "../dom-bootstrap";
import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { selectAnnotatableElements } from "./units";
import { siteChromeRegion } from "./chrome";
import type { GoldAnnotation } from "./schema";
import type { GoldLabel } from "./labels";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const CORPUS = process.argv[2]
  ? resolve(process.cwd(), process.argv[2])
  : join(HERE, "..", "gold-corpus");
const OUT = join(HERE, "..", "gold-annotations");

const TAG_LABEL: Record<string, GoldLabel> = {
  main: "main-content",
  article: "main-content",
  section: "main-content",
  h1: "heading", h2: "heading", h3: "heading", h4: "heading", h5: "heading", h6: "heading",
  summary: "heading", legend: "heading",
  p: "prose", blockquote: "prose", address: "prose", dd: "prose",
  ul: "list", ol: "list", dl: "list", li: "list", dt: "list",
  nav: "navigation", a: "navigation",
  aside: "complementary",
  img: "figure", picture: "figure", figure: "figure", figcaption: "figure", caption: "figure",
  video: "media", audio: "media", iframe: "media", object: "media", embed: "media",
  table: "table", thead: "table", tbody: "table", tr: "table", td: "table", th: "table",
  form: "control", fieldset: "control", input: "control", select: "control",
  textarea: "control", button: "control", label: "control",
  pre: "code", code: "code",
  header: "chrome", footer: "chrome",
  hr: "other", dialog: "other", details: "other",
};

const ROLE_LABEL: Record<string, GoldLabel> = {
  main: "main-content", article: "main-content", region: "main-content",
  navigation: "navigation", menu: "navigation", menubar: "navigation",
  complementary: "complementary", banner: "chrome", contentinfo: "chrome",
  search: "control", form: "control", button: "control", textbox: "control",
  searchbox: "control", checkbox: "control", radio: "control", combobox: "control",
  table: "table", grid: "table", list: "list", listitem: "list", heading: "heading",
  img: "figure", figure: "figure", dialog: "other", alert: "other", status: "other",
};

/**
 * The label this oracle can defend, or `null` where it has no evidence.
 *
 * Returning `other` for an unknown tag was actively harmful. A `<div>` carries
 * no tag evidence at all, so labelling it `other` asserts "this block has no
 * structural role" — and on a div-soup page that makes the correct answer "there
 * is no structure here", scoring ZERO any system that correctly infers the prose
 * runs, link-runs and lists that are plainly there. Measured on
 * `divsoup-blog`: every parser condition scored 0.000 while the parser was in
 * fact recovering `prose`, `list` and `navigation` correctly.
 *
 * Declining instead means the page contributes only the units a tag-derived
 * oracle can actually speak to — usually very few, which is the honest answer
 * for div soup and the reason the corpus needs human annotation.
 */
function labelFor(el: Element, tag: string): GoldLabel | null {
  // Chrome FIRST, because §3 rule 4 is subtractive: it overrides what the
  // element is, including an explicit `role=`. Testing `role` first meant a
  // `role="button"` inside a masthead came back `control`, which contradicts the
  // written rule the annotators are held to.
  //
  // Site chrome is not only header and footer. A primary navigation bar that is
  // a sibling of `<main>` is the same menu on every page of the site; the scene
  // does not render it, and `boilerplateRejection` credits dropping it. Scoring
  // it as `navigation` punished the pipeline for correct behaviour — on one
  // app-like page that was 211 of 237 scored units.
  if (siteChromeRegion(el)) return "chrome";

  const role = el.getAttribute("role");
  if (role && ROLE_LABEL[role]) return ROLE_LABEL[role];
  return TAG_LABEL[tag] ?? null;
}

/** Sectioning-driven segments: the same partition `segDomSectioning` produces. */
function segmentFor(el: Element): string | null {
  const container = el.closest?.(
    "main, article, section, nav, aside, header, footer, form, table, figure",
  );
  if (!container) return null;
  return container.getAttribute("data-eval-id") ?? null;
}

function main(): void {
  if (!existsSync(CORPUS)) {
    console.error(`No corpus at ${CORPUS} — run \`npm run gold:fetch -- --adopt\` first.`);
    process.exit(1);
  }
  mkdirSync(OUT, { recursive: true });
  const files = readdirSync(CORPUS).filter((f) => f.endsWith(".html"));
  if (files.length === 0) {
    console.error(`No .html in ${CORPUS}`);
    process.exit(1);
  }

  console.log(`Generating PROVISIONAL annotations for ${files.length} page(s)\n`);
  for (const f of files) {
    const html = readFileSync(join(CORPUS, f), "utf8");
    const doc = new DOMParser().parseFromString(html, "text/html");
    const units = selectAnnotatableElements(doc);
    const nodes: Record<string, GoldLabel> = {};
    const segments: Record<string, string> = {};
    const segOrder: string[] = [];
    const seen = new Set<string>();

    let declined = 0;
    for (const u of units) {
      const label = labelFor(u.el, u.tag);
      if (label === null) {
        declined++;
        continue;
      }
      nodes[u.evalId] = label;
      const seg = segmentFor(u.el);
      if (seg) {
        segments[u.evalId] = seg;
        if (!seen.has(seg)) {
          seen.add(seg);
          segOrder.push(seg);
        }
      }
    }

    const annotation: GoldAnnotation = {
      page: f.replace(/\.html$/, ""),
      annotator: "provisional-oracle",
      annotatedAt: new Date().toISOString(),
      provisional: true,
      nodes,
      segments,
      readingOrder: segOrder,
      notes:
        "TAG-DERIVED PLACEHOLDER. Not a human annotation. Present only so the " +
        "scoring pipeline can be exercised; produces no evidence (see plan §1, D1).",
    };
    writeFileSync(
      join(OUT, `${annotation.page}.provisional.json`),
      JSON.stringify(annotation, null, 2) + "\n",
    );
    const labelled = Object.keys(nodes).length;
    console.log(
      `  ${f.padEnd(56)} ${String(labelled).padStart(5)} units, ${String(segOrder.length).padStart(3)} segments` +
        (declined > 0
          ? `  (${declined} block${declined === 1 ? "" : "s"} declined — no tag evidence)`
          : ""),
    );
  }
  console.log(`\n  wrote ${files.length} provisional annotation(s) to ${OUT}`);
  console.log(
    `\n  ⚠️  Provisional gold is tag-derived and proves nothing. Replace it with\n` +
      `     human annotations before quoting any number from it.\n`,
  );
}

main();
