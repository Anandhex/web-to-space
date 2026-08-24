/**
 * VIPS (Vision-based Page Segmentation) backend.
 *
 * Reference: Cai, Yu, Wen, Ma — "VIPS: a Vision-based Page Segmentation
 * Algorithm" — Microsoft Research Technical Report MSR-TR-2003-79, 2003.
 * https://www.microsoft.com/en-us/research/publication/vips-a-vision-based-page-segmentation-algorithm/
 *
 * This module picks between two implementations and reports which one ran.
 *
 *   • **visual** (`vips-visual.ts`) — the real algorithm: renders the page in an
 *     off-screen frame and segments it from `getBoundingClientRect()` /
 *     `getComputedStyle()` using genuine visual separators, background changes
 *     and font shifts. This is what the paper describes.
 *
 *   • **dom-only** (below) — a rendering-free approximation that substitutes DOM
 *     structure for visual signal: nesting depth for separators, child-block
 *     count for subdivision, text length and link density for coherence.
 *
 * ── Why both exist ──────────────────────────────────────────────────────────
 *
 * The dom-only path was originally the *only* path, which made every comparison
 * against "VIPS" unfair to VIPS. The paper's entire premise is that rendered
 * layout carries structure the tag tree does not — it bills itself as
 * "tag-tree independent" — so a tag-tree-only port is not a weak VIPS, it is a
 * different (and strictly weaker) algorithm wearing the name. Reporting a win
 * over it as a win over VIPS would be a straw man.
 *
 * The dom-only path is still needed: the offline benchmark runs under jsdom,
 * which implements the DOM but performs no layout, so `getBoundingClientRect()`
 * returns all-zeros there. Rather than silently degrade, `parsePageWithVIPSDetailed`
 * always reports its `mode` and the reason it chose it, and every consumer
 * labels its output accordingly.
 */

import { DEFAULT_CONFIG } from "./defaults";
import { parsePageToIR } from "./parser";
import { renderInFrame, hasLayoutEngine } from "./render-frame";
import type { RenderFrameDiagnostics } from "./render-frame";
import { runVipsVisual } from "./vips-visual";
import type { VipsVisualDiagnostics, VipsVisualOptions } from "./vips-visual";
import type { PageIR } from "./types";

// ─────────────────────────────────────────────────────────────
// Result reporting
// ─────────────────────────────────────────────────────────────

export type VipsMode = "visual" | "dom-only";

/** Why the visual path was not used. `null` when it was. */
export type VipsFallbackReason =
  | "no-layout-engine" // Node/jsdom — no rendering available
  | "render-failed" // frame timed out or was unreadable
  | "no-blocks" // rendered fine but produced nothing usable
  | "no-css" // rendered with zero stylesheets applied — no visual signal
  | "disabled" // caller asked for dom-only
  | null;

interface VipsDiagnostics {
  mode: VipsMode;
  fallbackReason: VipsFallbackReason;
  /** Number of visual/structural blocks fed into the semantic parser. */
  blockCount: number;
  /** Short label for the diagnostics bar. Honest about which path ran. */
  label: string;
  render: RenderFrameDiagnostics | null;
  visual: VipsVisualDiagnostics | null;
}

interface VipsResult {
  ir: PageIR;
  diagnostics: VipsDiagnostics;
}

interface VipsOptions extends VipsVisualOptions {
  /** Force the rendering-free path. Used by the offline benchmark. */
  forceDomOnly?: boolean;
  /**
   * Treat "rendered but no CSS applied" as a failure and fall back.
   * Default true — a frame with no stylesheets has no visual signal to read,
   * so calling its output "visual" would be dishonest.
   */
  requireCss?: boolean;
}

// ─────────────────────────────────────────────────────────────
// Shared pre-processing
// ─────────────────────────────────────────────────────────────

/** Chrome that is content in the markup but noise on the page. */
const PRUNE_SELECTORS = [
  ".mw-editsection", ".mw-jump-link", ".noprint", ".mw-cite-backlink",
  "#toc", "#catlinks", ".catlinks", ".navbox", ".metadata",
  "svg[aria-hidden='true']", "span[aria-hidden='true']:empty",
];

/**
 * Elements that carry no content but *do* carry the page's appearance.
 *
 * Removing these is right on the DOM-only path, where a `<style>` body would
 * otherwise be walked as text. It is catastrophic on the visual path: strip the
 * stylesheets out of a live frame and the next layout flush reflows the whole
 * document unstyled, so every rect VIPS then reads is the geometry of an
 * *unstyled* page — no gutters, no columns, no background changes. The algorithm
 * still runs, and still reports "visual", having measured nothing visual at all.
 */
const NON_RENDERED_SELECTORS = ["style", "script"];

function pruneAll(doc: Document, selectors: string[]): void {
  for (const sel of selectors) {
    try {
      doc.querySelectorAll(sel).forEach((el) => el.parentNode?.removeChild(el));
    } catch {
      /* ignore invalid selectors */
    }
  }
}

/** Prune for the visual path — leaves the frame's styling intact. */
function pruneRenderedFrame(doc: Document): void {
  pruneAll(doc, PRUNE_SELECTORS);
}

/** Prune for the rendering-free path, where `<style>` text is just noise. */
function pruneBoilerplate(doc: Document): void {
  pruneAll(doc, [...PRUNE_SELECTORS, ...NON_RENDERED_SELECTORS]);
}

/** Main-content entry point — same strategy as the custom parser. */
function findContentRoot(doc: Document): Element {
  return (
    doc.querySelector('main, [role="main"], #main, #content, .main-content') ??
    doc.body
  );
}

/**
 * Table-internal elements, which are invalid outside a `<table>`.
 *
 * A visual block can land on a `<tbody>` — it is a laid-out box like any other.
 * Emitted bare into a `<section>`, the HTML parser discards it and every row
 * inside it, so the table's entire content disappears from the re-parse.
 */
const TABLE_PART_TAGS = new Set([
  "tbody", "thead", "tfoot", "tr", "td", "th", "caption", "colgroup", "col",
]);

/**
 * Serialise one visual block's source elements back to HTML.
 *
 * Uses `outerHTML`, never `innerHTML`. Unwrapping a block element destroys the
 * very thing the re-parse is being asked to read:
 *
 *   • `<h3>Kant</h3>` → `Kant`, a bare text node. The heading is gone, so the
 *     segmented document has no headings at all and heading recall reads ~0.
 *   • `<p>In his <a>…</a> theory of <i>space</i>…</p>` → loose inline nodes
 *     directly inside `<section>`. Nothing owns them, and the re-parse runs with
 *     structural inference off *by design* (VIPS has already decided the block
 *     structure), so there is no paragraph-run inference to put them back
 *     together. The `<a>` and `<i>` fragments survive as standalone nodes and
 *     every run of plain prose between them is dropped — the reader sees
 *     "Immanuel Kant / a priori / synthetic" stacked in a column where a
 *     paragraph should be.
 *
 * Blocks are joined with a newline rather than the empty string: `innerHTML`
 * concatenation welded adjacent elements' text together ("Immanuel
 * KantCritique of Pure Reasonknowledge").
 */
function serialiseBlock(els: Element[]): string {
  return els
    .map((el) => {
      const html = el.outerHTML;
      return TABLE_PART_TAGS.has(el.tagName.toLowerCase())
        ? `<table>${html}</table>`
        : html;
    })
    .join("\n");
}

/**
 * Wrap each segmented block in a `<section data-vips>` and rebuild a minimal
 * document. Feeding this back through `parsePageToIR` keeps ARIA labels,
 * headings and inline structure resolved *within* each block, so the comparison
 * against the custom parser isolates the segmentation decision rather than
 * conflating it with label resolution.
 */
function buildSegmentedHtml(
  doc: Document,
  blockHtml: string[],
  fallbackInner: string,
): string {
  const body =
    blockHtml.length > 0
      ? blockHtml
          .map((inner, i) => `<section data-vips="${i}">${inner}</section>`)
          .join("\n")
      : `<section data-vips="root">${fallbackInner}</section>`;

  const lang = doc.documentElement.getAttribute("lang") ?? "en";
  const title = doc.title ?? "";
  return `<!DOCTYPE html><html lang="${lang}"><head><title>${title}</title></head><body>${body}</body></html>`;
}

/**
 * Parse segmented HTML with structural inference disabled.
 *
 * VIPS has already decided the block structure; leaving the custom parser's
 * structural inference on would let it re-segment, and the backend would no
 * longer be measuring VIPS. ARIA and label resolution stay on so content inside
 * each block is still analysed.
 */
function parseSegmented(html: string, url: string): Promise<PageIR> {
  return parsePageToIR(html, url, undefined, {
    ...DEFAULT_CONFIG,
    useStructuralInference: false,
    useWrapperPiercing: true,
    useAriaLabels: true,
    useExplicitSemantics: true,
  });
}

// ─────────────────────────────────────────────────────────────
// Path A — visual (the real algorithm)
// ─────────────────────────────────────────────────────────────

interface VisualExtraction {
  blockHtml: string[];
  visual: VipsVisualDiagnostics;
}

async function segmentVisually(
  html: string,
  url: string,
  opts: VipsOptions,
): Promise<{
  extraction: VisualExtraction | null;
  render: RenderFrameDiagnostics;
}> {
  const { value, diagnostics } = await renderInFrame(
    html,
    { baseHref: url || null },
    (frame): VisualExtraction => {
      pruneRenderedFrame(frame.doc);
      const root = findContentRoot(frame.doc);
      const result = runVipsVisual(frame, root, opts);

      // Serialise now — the frame is torn down the moment this returns.
      return {
        blockHtml: result.blocks
          .map((b) => serialiseBlock(b.els))
          .filter((h) => h.trim().length > 0),
        visual: result.diagnostics,
      };
    },
  );

  return { extraction: value, render: diagnostics };
}

// ─────────────────────────────────────────────────────────────
// Path B — dom-only (rendering-free approximation)
// ─────────────────────────────────────────────────────────────

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

const DOC_THRESHOLD = 0.68; // blocks with DOC ≥ this are treated as coherent
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
 * Degree of Coherence, approximated without rendering.
 *
 * Every term here is a stand-in for a visual measurement the real algorithm
 * takes directly: child-block count stands in for separator detection, link
 * density for the appearance of a navigation strip, text length for visual mass.
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

  if (len < 20 && blockChildCount === 0) return 0.1;
  if (ld > 0.55 && len < 600) return 0.9;
  if (blockChildCount === 0 && len > 0) return 0.85;
  if (leafChildCount > blockChildCount && len < 1200) return 0.8;
  if (blockChildCount >= 4) return 0.35;
  if (blockChildCount >= 2) return 0.55;
  return len > 300 ? 0.75 : 0.5;
}

function domOnlySegment(el: Element, depth: number): Element[] {
  const tag = el.tagName.toLowerCase();
  if (SKIP_TAGS.has(tag)) return [];

  const doc = computeDOC(el);
  const len = textLength(el);

  if (doc >= DOC_THRESHOLD || depth >= MAX_DEPTH) {
    return len > 40 ? [el] : [];
  }

  const blockChildren = Array.from(el.children).filter(
    (c) => BLOCK_TAGS.has(c.tagName.toLowerCase()) && textLength(c as Element) > 20,
  );
  if (blockChildren.length === 0) return len > 40 ? [el] : [];

  const result: Element[] = [];
  for (const child of blockChildren) {
    result.push(...domOnlySegment(child as Element, depth + 1));
  }
  return result;
}

// ─────────────────────────────────────────────────────────────
// Entry points
// ─────────────────────────────────────────────────────────────

/**
 * Segment a page with VIPS and parse the result into a `PageIR`.
 *
 * Prefers the visual path and falls back to the rendering-free one, always
 * reporting which ran via `diagnostics.mode` / `diagnostics.fallbackReason`.
 */
export async function parsePageWithVIPSDetailed(
  html: string,
  url: string,
  options: VipsOptions = {},
): Promise<VipsResult> {
  const opts = { requireCss: true, ...options };

  let render: RenderFrameDiagnostics | null = null;
  let visual: VipsVisualDiagnostics | null = null;
  let fallbackReason: VipsFallbackReason = null;

  // ── Path A: visual ──
  if (opts.forceDomOnly) {
    fallbackReason = "disabled";
  } else if (!hasLayoutEngine()) {
    fallbackReason = "no-layout-engine";
  } else {
    const attempt = await segmentVisually(html, url, opts);
    render = attempt.render;

    if (attempt.render.status !== "rendered" || !attempt.extraction) {
      fallbackReason = "render-failed";
    } else if (
      opts.requireCss &&
      attempt.render.cssRulesApplied === 0 &&
      attempt.render.inlineStyleBlocks === 0
    ) {
      // A frame with no stylesheets lays everything out in document order at
      // full width — there are no gutters, no background changes and no font
      // shifts to detect. Whatever came back is not a visual segmentation.
      fallbackReason = "no-css";
      visual = attempt.extraction.visual;
    } else if (attempt.extraction.blockHtml.length === 0) {
      fallbackReason = "no-blocks";
      visual = attempt.extraction.visual;
    } else {
      visual = attempt.extraction.visual;
      const doc = new DOMParser().parseFromString(html, "text/html");
      const segmentedHtml = buildSegmentedHtml(
        doc,
        attempt.extraction.blockHtml,
        findContentRoot(doc).innerHTML,
      );
      return {
        ir: await parseSegmented(segmentedHtml, url),
        diagnostics: {
          mode: "visual",
          fallbackReason: null,
          blockCount: attempt.extraction.blockHtml.length,
          label: `VIPS (visual, ${attempt.extraction.blockHtml.length} blocks)`,
          render,
          visual,
        },
      };
    }
  }

  // ── Path B: dom-only ──
  const doc = new DOMParser().parseFromString(html, "text/html");
  pruneBoilerplate(doc);
  const root = findContentRoot(doc);
  const blocks = domOnlySegment(root, 0);
  // Same rule as the visual path: keep each block element's own tag, or its
  // headings and paragraphs dissolve into loose inline nodes. See serialiseBlock.
  const blockHtml = blocks.map((el) => serialiseBlock([el]));

  const segmentedHtml = buildSegmentedHtml(doc, blockHtml, root.innerHTML);

  return {
    ir: await parseSegmented(segmentedHtml, url),
    diagnostics: {
      mode: "dom-only",
      fallbackReason,
      blockCount: blockHtml.length || 1,
      label: `VIPS (DOM-only — ${describeFallback(fallbackReason)})`,
      render,
      visual,
    },
  };
}

function describeFallback(reason: VipsFallbackReason): string {
  switch (reason) {
    case "no-layout-engine":
      return "no renderer";
    case "render-failed":
      return "render failed";
    case "no-blocks":
      return "no visual blocks";
    case "no-css":
      return "no CSS applied";
    case "disabled":
      return "forced";
    default:
      return "approximation";
  }
}

