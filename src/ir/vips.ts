/**
 * Simplified VIPS (Vision-based Page Segmentation) algorithm.
 *
 * Reference: Cai, Yu, Wen, Ma — "VIPS: a Vision-based Page Segmentation
 * Algorithm" — Microsoft Research Technical Report, 2003.
 * https://www.microsoft.com/en-us/research/publication/vips-a-vision-based-page-segmentation-algorithm/
 *
 * Original VIPS uses rendered CSS layout (computed bounding boxes, visual
 * separators) to partition a page into visually coherent blocks.  This
 * browser-side port approximates those signals using pure DOM structure:
 *
 *   • Block element nesting depth  → visual separator signal
 *   • Child block count            → subdivision trigger (low DOC score)
 *   • Text length + link density   → coherence signal (high DOC score)
 *
 * The algorithm recursively subdivides elements whose Degree of Coherence
 * (DOC) is below the threshold, stopping at elements that look visually
 * coherent from a structural standpoint.  These leaf blocks are wrapped in
 * `<section>` elements and fed through the standard `parsePageToIR` pipeline
 * for ARIA + label resolution within each block.
 */

import { DEFAULT_CONFIG } from "./defaults";
import { parsePageToIR } from "./parser";
import type { PageIR } from "./types";

const BLOCK_TAGS = new Set([
  "div", "section", "article", "main", "aside",
  "header", "footer", "nav", "form", "table",
  "ul", "ol", "dl", "blockquote", "pre",
  "figure", "details", "summary", "address",
]);

const SKIP_TAGS = new Set([
  "script", "style", "noscript", "meta", "link",
  "head", "br", "wbr", "svg", "canvas", "template",
]);

const DOC_THRESHOLD = 0.68; // blocks with DOC ≥ this are treated as coherent visual units
const MAX_DEPTH = 7;

function textLength(el: Element): number {
  return (el.textContent ?? "").trim().length;
}

function linkDensity(el: Element): number {
  const total = textLength(el);
  if (total === 0) return 0;
  let linkText = 0;
  for (const a of Array.from(el.querySelectorAll("a"))) {
    linkText += textLength(a as Element);
  }
  return linkText / total;
}

/**
 * Degree of Coherence (DOC) heuristic.
 *
 * A high DOC means the element is a visually self-contained unit — we stop
 * recursing.  A low DOC means the element spans multiple visual blocks and
 * should be subdivided further.
 */
function computeDOC(el: Element): number {
  const len = textLength(el);
  const ld = linkDensity(el);
  const blockChildCount = Array.from(el.children).filter((c) =>
    BLOCK_TAGS.has(c.tagName.toLowerCase()),
  ).length;
  const leafChildCount = Array.from(el.children).filter(
    (c) => !BLOCK_TAGS.has(c.tagName.toLowerCase()),
  ).length;

  // Empty or tiny element — coherent by default (don't waste segments on it)
  if (len < 20 && blockChildCount === 0) return 0.1;

  // High link-density, short text → navigation bar → very coherent
  if (ld > 0.55 && len < 600) return 0.9;

  // Single-purpose block (e.g. a form) → coherent
  if (blockChildCount === 0 && len > 0) return 0.85;

  // Mostly leaf children (paragraph-like content) → coherent
  if (leafChildCount > blockChildCount && len < 1200) return 0.8;

  // Many block children → structural container → subdivide
  if (blockChildCount >= 4) return 0.35;
  if (blockChildCount >= 2) return 0.55;

  // Medium block — depends on text density
  return len > 300 ? 0.75 : 0.5;
}

/**
 * Recursively segment an element into visual leaf blocks.
 *
 * Returns the list of DOM elements that represent visually coherent units.
 */
function vipsSegment(el: Element, depth: number): Element[] {
  const tag = el.tagName.toLowerCase();
  if (SKIP_TAGS.has(tag)) return [];

  const doc = computeDOC(el);
  const len = textLength(el);

  // Stop if block is coherent or we've reached the maximum depth
  if (doc >= DOC_THRESHOLD || depth >= MAX_DEPTH) {
    return len > 40 ? [el] : [];
  }

  // Subdivide via significant block children
  const blockChildren = Array.from(el.children).filter(
    (c) => BLOCK_TAGS.has(c.tagName.toLowerCase()) && textLength(c as Element) > 20,
  );

  if (blockChildren.length === 0) {
    return len > 40 ? [el] : [];
  }

  const result: Element[] = [];
  for (const child of blockChildren) {
    result.push(...vipsSegment(child as Element, depth + 1));
  }
  return result;
}

const PRUNE_SELECTORS = [
  ".mw-editsection", ".mw-jump-link", ".noprint", ".mw-cite-backlink",
  "#toc", "#catlinks", ".catlinks", ".navbox", ".metadata",
  "svg[aria-hidden='true']", "span[aria-hidden='true']:empty",
  "style", "script",
];

/**
 * Parse a page using a simplified VIPS segmentation algorithm.
 *
 * Flow:
 *  1. Prune boilerplate selectors
 *  2. Run VIPS segmentation from the main content root
 *  3. Wrap each visual block in a `<section>` with a `data-vips` attribute
 *  4. Build simplified HTML and feed it through `parsePageToIR` so ARIA
 *     labels and headings within each block are still resolved
 */
export async function parsePageWithVIPS(html: string, url: string): Promise<PageIR> {
  const doc = new DOMParser().parseFromString(html, "text/html");

  for (const sel of PRUNE_SELECTORS) {
    try {
      doc.querySelectorAll(sel).forEach((el) => el.parentNode?.removeChild(el));
    } catch {
      /* ignore invalid selectors */
    }
  }

  // Find main content entry point (same strategy as the custom parser)
  const mainEl =
    doc.querySelector('main, [role="main"], #main, #content, .main-content') ??
    doc.body;

  // Run VIPS segmentation
  const blocks = vipsSegment(mainEl, 0);

  let bodyContent: string;
  if (blocks.length === 0) {
    // Fallback: use the entire main element
    bodyContent = `<section data-vips="root">${mainEl.innerHTML}</section>`;
  } else {
    bodyContent = blocks
      .map((el, i) => `<section data-vips="${i}">${el.innerHTML}</section>`)
      .join("\n");
  }

  const lang = doc.documentElement.getAttribute("lang") ?? "en";
  const title = doc.title ?? "";
  const simplifiedHtml = `<!DOCTYPE html><html lang="${lang}"><head><title>${title}</title></head><body>${bodyContent}</body></html>`;

  // Feed through the standard semantic parser.
  // Disable structural inference (VIPS already provided the block structure),
  // keep ARIA + labels so content within each block is still analysed.
  return parsePageToIR(simplifiedHtml, url, undefined, {
    ...DEFAULT_CONFIG,
    useStructuralInference: false,
    useWrapperPiercing: true,
    useAriaLabels: true,
    useExplicitSemantics: true,
  });
}
