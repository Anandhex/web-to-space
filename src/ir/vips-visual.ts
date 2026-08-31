/**
 * vips-visual.ts — VIPS on a *rendered* document.
 *
 * Reference: Cai, Yu, Wen, Ma — "VIPS: a Vision-based Page Segmentation
 * Algorithm", Microsoft Research Technical Report MSR-TR-2003-79, 2003.
 * https://www.microsoft.com/en-us/research/wp-content/uploads/2016/02/tr-2003-79.pdf
 *
 * The premise of VIPS is that a page's *visual* presentation carries structural
 * information the tag tree does not: whitespace gutters, background changes,
 * font shifts and rules are how a human sees where one region ends and the next
 * begins. A DOM-only port cannot see any of that — it is reduced to counting
 * child elements, which is precisely the tag-tree dependence the paper set out
 * to escape ("an automatic top-down, *tag-tree independent* approach").
 *
 * This module implements the algorithm as intended, over real
 * `getBoundingClientRect()` and `getComputedStyle()` data supplied by
 * `render-frame.ts`. The paper's three phases:
 *
 *   1. **Visual block extraction** — recursively decide, per node, whether it is
 *      one visual block or must be divided (§3.1).
 *   2. **Visual separator detection** — sweep the separator list over the block
 *      pool (split / update / remove), then weight each separator by how strong
 *      a visual boundary it is (§3.2).
 *   3. **Content structure construction** — merge blocks across the weakest
 *      separators upward, and recurse into any block whose Degree of Coherence
 *      falls below the Permitted Degree of Coherence (§3.3).
 *
 * ── Documented deviation ────────────────────────────────────────────────────
 *
 * Phase 3 in the paper merges blocks across separators in ascending weight
 * order, producing a hierarchy bottom-up. This implementation instead performs
 * a **weight-ordered recursive cut**: at each region it detects separators on
 * both axes, picks the axis carrying the strongest boundary, splits along every
 * separator at or near that maximum weight, and recurses. Phases 1 and 2 —
 * including the full separator sweep and the paper's weighting rules — are
 * implemented as described.
 *
 * The two formulations agree on the common case (a region split by one dominant
 * gutter) and differ on pathological mixed layouts. The recursive-cut form is
 * chosen because it is deterministic, terminates by construction, and yields the
 * top-down block tree the caller actually wants. This is the module's single
 * deviation from the paper and is reported as such; it is stated here for the
 * same reason `compare/segmentation.ts` states its BCubed weighting deviation.
 */

import type { RenderedFrame } from "./render-frame";

/** Monotonic clock, with a fallback for environments without `performance`. */
const now = (): number =>
  typeof performance !== "undefined" ? performance.now() : Date.now();

// ─────────────────────────────────────────────────────────────
// Geometry
// ─────────────────────────────────────────────────────────────

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const right = (r: Rect) => r.x + r.w;
const bottom = (r: Rect) => r.y + r.h;
const area = (r: Rect) => Math.max(0, r.w) * Math.max(0, r.h);

function union(a: Rect, b: Rect): Rect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(right(a), right(b)) - x, h: Math.max(bottom(a), bottom(b)) - y };
}

function unionAll(rects: Rect[]): Rect {
  return rects.reduce(union);
}

// ─────────────────────────────────────────────────────────────
// Visual blocks
// ─────────────────────────────────────────────────────────────

/** Visual style facts read once per element and reused across all three phases. */
interface VisualStyle {
  /** Effective painted background colour, resolved through transparent ancestors. */
  background: string;
  fontSizePx: number;
  fontWeight: number;
  color: string;
  display: string;
  /** True for `<hr>` and for elements whose border acts as a rule. */
  isRule: boolean;
  tag: string;
  /** False for `display:none`, `visibility:hidden` and near-zero opacity. */
  rendered: boolean;
}

interface VisualBlock {
  id: string;
  /** Source elements. More than one after a merge. */
  els: Element[];
  rect: Rect;
  style: VisualStyle;
  /** Degree of Coherence on the paper's 1–10 scale. */
  doc: number;
  children: VisualBlock[];
}

export interface VipsVisualOptions {
  /**
   * Permitted Degree of Coherence, 1–10. A block whose DoC is below this is
   * subdivided further; higher PDoC ⇒ finer segmentation.
   *
   * Default 7. Akpınar & Yeşilada (ICWE 2013) re-implemented VIPS and found
   * users judge *higher*-granularity segmentation as better regardless of page
   * complexity, which is also what a spatial layout wants: finer blocks give
   * the layout engine more placement freedom than a few monolithic panels.
   */
  pdoc?: number;
  /** Ignore blocks smaller than this in either dimension, px. Default 12. */
  minBlockPx?: number;
  /** Minimum gutter counted as a separator, px. Default 6. */
  minSeparatorPx?: number;
  /** Recursion ceiling. Default 8. */
  maxDepth?: number;
  /** Hard cap on emitted leaf blocks. Default 200. */
  maxBlocks?: number;
}

const OPT_DEFAULTS: Required<VipsVisualOptions> = {
  pdoc: 7,
  minBlockPx: 12,
  minSeparatorPx: 6,
  maxDepth: 8,
  maxBlocks: 200,
};

const SKIP_TAGS = new Set([
  "script", "style", "noscript", "meta", "link", "head", "template",
  "br", "wbr", "base", "title", "param", "source", "track",
]);

/** Elements that are semantically atomic — never divided regardless of layout. */
const ATOMIC_TAGS = new Set([
  "img", "picture", "video", "audio", "canvas", "svg", "iframe", "object",
  "embed", "input", "textarea", "select", "button", "pre", "code",
]);

// ─────────────────────────────────────────────────────────────
// Style reading
// ─────────────────────────────────────────────────────────────

function isTransparent(color: string): boolean {
  if (!color) return true;
  if (color === "transparent") return true;
  const m = color.match(/rgba?\([^)]*,\s*([\d.]+)\s*\)/);
  return m ? parseFloat(m[1]) < 0.05 : false;
}

/**
 * The background colour a viewer actually sees behind this element.
 *
 * CSS backgrounds are transparent by default, so reading `background-color` off
 * a node usually reports `rgba(0,0,0,0)` even where the user plainly sees a
 * colour. VIPS's background-difference rules are meaningless without resolving
 * that up the ancestor chain to the nearest painted colour.
 */
/**
 * The background colour a viewer actually sees behind this element.
 *
 * The walk is memoised on the way up: once an ancestor's effective background is
 * known, every descendant that reaches it stops there, so the whole tree costs
 * O(elements) style resolves instead of O(elements × depth).
 */
function effectiveBackground(
  el: Element,
  win: Window,
  cache: Map<Element, string>,
): string {
  // Collect the transparent run, then paint the answer back over all of it.
  const chain: Element[] = [];
  let cur: Element | null = el;
  let hops = 0;
  let resolved = "rgb(255, 255, 255)";

  while (cur && hops < 24) {
    const hit = cache.get(cur);
    if (hit !== undefined) {
      resolved = hit;
      break;
    }
    chain.push(cur);
    const bg = win.getComputedStyle(cur).backgroundColor;
    if (!isTransparent(bg)) {
      resolved = bg;
      break;
    }
    cur = cur.parentElement;
    hops++;
  }

  for (const node of chain) cache.set(node, resolved);
  return resolved;
}

/**
 * Every visual fact we need about an element, from one style resolve.
 *
 * `display`/`visibility`/`opacity` are read here rather than in a separate
 * `isVisible` pass so the element is only resolved once — visibility and the
 * block's appearance come from the same `CSSStyleDeclaration`.
 */
function readStyle(el: Element, ctx: ExtractContext): VisualStyle {
  const cached = ctx.styles.get(el);
  if (cached) return cached;

  const cs = ctx.win.getComputedStyle(el);
  const tag = el.tagName.toLowerCase();
  const borderTop = parseFloat(cs.borderTopWidth) || 0;
  const borderBottom = parseFloat(cs.borderBottomWidth) || 0;
  const height = toPageRect(el, ctx).h;

  const style: VisualStyle = {
    background: effectiveBackground(el, ctx.win, ctx.backgrounds),
    fontSizePx: parseFloat(cs.fontSize) || 16,
    fontWeight: parseInt(cs.fontWeight, 10) || 400,
    color: cs.color,
    display: cs.display,
    // A <hr>, or any element laid out as a thin band with a visible border, is
    // an explicit author-drawn rule — the paper's strongest separator cue.
    isRule: tag === "hr" || (height <= 4 && (borderTop > 0 || borderBottom > 0)),
    tag,
    rendered:
      cs.display !== "none" &&
      cs.visibility !== "hidden" &&
      (parseFloat(cs.opacity) || 1) >= 0.05,
  };
  ctx.styles.set(el, style);
  return style;
}

function isVisible(el: Element, ctx: ExtractContext): boolean {
  if (el.getAttribute("aria-hidden") === "true") return false;
  return readStyle(el, ctx).rendered;
}

/** Direct (non-descendant) text of an element, whitespace-collapsed. */
function directText(el: Element): string {
  let out = "";
  for (const node of Array.from(el.childNodes)) {
    if (node.nodeType === 3) out += " " + (node.textContent ?? "");
  }
  return out.replace(/\s+/g, " ").trim();
}

/**
 * Does this subtree contain any visible text?
 *
 * Deliberately not `textContent.trim().length > 0`: `textContent` materialises
 * the whole subtree as a string, and asking it once per element makes the walk
 * allocate the page's text once per level of nesting. This exits at the first
 * non-whitespace character instead.
 */
function hasText(el: Element): boolean {
  const stack: Node[] = [el];
  while (stack.length > 0) {
    const node = stack.pop()!;
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === 3) {
        if ((child.textContent ?? "").trim().length > 0) return true;
      } else if (child.nodeType === 1) {
        stack.push(child);
      }
    }
  }
  return false;
}

// ─────────────────────────────────────────────────────────────
// Phase 1 — Visual block extraction
// ─────────────────────────────────────────────────────────────

interface ExtractContext {
  win: Window;
  doc: Document;
  origin: { x: number; y: number };
  opts: Required<VipsVisualOptions>;
  /** Full page box — the denominator for "how much of the page is this?". */
  pageRect: Rect;
  /** Visible viewport height, px — the ceiling on "one block the user can see". */
  viewportHeight: number;
  nextId: () => string;
  /**
   * Per-element measurement caches.
   *
   * The walk measures every element twice — once as a child candidate of its
   * parent, once as itself — and `effectiveBackground` multiplies that again by
   * the ancestor chain it climbs. Uncached, a 600-element page issues ~5,600
   * `getComputedStyle` calls, each a full style resolve. These maps live only as
   * long as the frame does.
   */
  rects: Map<Element, Rect>;
  styles: Map<Element, VisualStyle>;
  backgrounds: Map<Element, string>;
}

/**
 * The box an element occupies on the page.
 *
 * `display: contents` removes an element's own box while its children lay out
 * normally, so `getBoundingClientRect()` reports 0×0 for it. Taking that at face
 * value drops the whole subtree — MDN wraps every article in a
 * `<main id="content">` that is `display: contents`, so VIPS extracted zero
 * blocks there and fell back to the DOM-only approximation on every run. When an
 * element has no box of its own, measure the union of its contents instead:
 * that is the region a reader actually sees it occupy.
 */
function toPageRect(el: Element, ctx: ExtractContext): Rect {
  const cached = ctx.rects.get(el);
  if (cached) return cached;

  let r: DOMRect | { left: number; top: number; width: number; height: number } =
    el.getBoundingClientRect();
  if (r.width < 1 && r.height < 1 && el.childNodes.length > 0) {
    try {
      const range = ctx.doc.createRange();
      range.selectNodeContents(el);
      const contents = range.getBoundingClientRect();
      if (contents.width >= 1 || contents.height >= 1) r = contents;
    } catch {
      /* not measurable — keep the zero rect */
    }
  }

  const rect: Rect = {
    x: r.left - ctx.origin.x,
    y: r.top - ctx.origin.y,
    w: r.width,
    h: r.height,
  };
  ctx.rects.set(el, rect);
  return rect;
}

/**
 * Should this node be treated as one visual block, or divided into its children?
 *
 * The paper states this as a list of DOM/visual rules (§3.1, rules 1–13). The
 * rules below are the rendered-signal subset — each one is a question a DOM-only
 * port physically cannot ask.
 */
function shouldDivide(
  rect: Rect,
  style: VisualStyle,
  hasOwnText: boolean,
  childBlocks: { el: Element; rect: Rect; style: VisualStyle }[],
  ctx: ExtractContext,
): boolean {
  if (ATOMIC_TAGS.has(style.tag)) return false;
  if (childBlocks.length === 0) return false;

  // Rule: a node carrying its own text is a text block, and its element
  // children are inline runs within that text (a <p> with an <a> in it).
  // Dividing here would shred prose into fragments, so it stays whole. Checked
  // first because the rules below reason about *containers*.
  if (hasOwnText) return false;

  // Rule: a node containing an explicit rule (<hr>) is divided by it.
  if (childBlocks.some((c) => c.style.isRule)) return true;

  // Rule: if the background colour of this node differs from that of any child,
  // the child is visually distinguished and the node must be divided.
  if (childBlocks.some((c) => c.style.background !== style.background)) return true;

  // Rule: a container with a single child holds all of its content in that
  // child and contributes no boundary of its own — descend through it. This
  // covers both the wrapper case (child fills the parent) and the padded case
  // (child sits inside parent whitespace); in neither is the parent itself a
  // meaningful visual unit.
  if (childBlocks.length === 1) return true;

  // Rule: children laid out as blocks that do not fill the parent leave visible
  // whitespace between them — the parent spans multiple visual units.
  const childArea = childBlocks.reduce((sum, c) => sum + area(c.rect), 0);
  const fill = area(rect) > 0 ? childArea / area(rect) : 1;
  if (fill < 0.85) return true;

  // Rule: heterogeneous font sizes among children indicate distinct roles
  // (heading vs body) rather than one coherent block.
  const sizes = childBlocks.map((c) => c.style.fontSizePx);
  if (Math.max(...sizes) - Math.min(...sizes) >= 4) return true;

  // Rule: a node taller than the viewport cannot be perceived as a single
  // visual block — the user can never see all of it at once.
  if (rect.h > ctx.viewportHeight) return true;

  return false;
}

/**
 * Degree of Coherence for a block, on the paper's 1–10 scale.
 *
 * DoC answers "how much does this look like one thing?" — high for a tight,
 * visually uniform unit, low for a loose container spanning several. Every term
 * here is a rendered measurement.
 */
function computeDoC(
  rect: Rect,
  style: VisualStyle,
  children: { rect: Rect; style: VisualStyle }[],
  viewport: Rect,
): number {
  if (children.length === 0) return 10; // an indivisible leaf is maximally coherent

  let score = 10;

  // Size relative to the page: a block covering most of the page is by
  // definition an aggregate of smaller ones.
  const coverage = area(viewport) > 0 ? area(rect) / area(viewport) : 0;
  if (coverage > 0.6) score -= 4;
  else if (coverage > 0.3) score -= 2.5;
  else if (coverage > 0.12) score -= 1;

  // Internal whitespace: large gaps between children read as separate regions.
  const gaps = internalGaps(children.map((c) => c.rect));
  if (gaps.maxGap > 40) score -= 3;
  else if (gaps.maxGap > 20) score -= 1.5;
  else if (gaps.maxGap > 10) score -= 0.5;

  // Typographic uniformity.
  const sizes = children.map((c) => c.style.fontSizePx);
  const sizeSpread = Math.max(...sizes) - Math.min(...sizes);
  if (sizeSpread >= 8) score -= 2;
  else if (sizeSpread >= 4) score -= 1;

  // Background uniformity.
  const backgrounds = new Set(children.map((c) => c.style.background));
  if (backgrounds.size > 1) score -= 1.5;
  if (!backgrounds.has(style.background)) score -= 0.5;

  // An explicit rule inside is an author saying "these are different things".
  if (children.some((c) => c.style.isRule)) score -= 2;

  return Math.max(1, Math.min(10, Math.round(score)));
}

/** Largest gap between adjacent child rects, on whichever axis they stack. */
function internalGaps(rects: Rect[]): { maxGap: number; axis: "x" | "y" } {
  if (rects.length < 2) return { maxGap: 0, axis: "y" };

  const gapsOn = (
    lo: (r: Rect) => number,
    hi: (r: Rect) => number,
  ): number => {
    const sorted = [...rects].sort((a, b) => lo(a) - lo(b));
    let max = 0;
    let reach = hi(sorted[0]);
    for (let i = 1; i < sorted.length; i++) {
      max = Math.max(max, lo(sorted[i]) - reach);
      reach = Math.max(reach, hi(sorted[i]));
    }
    return max;
  };

  const gapY = gapsOn((r) => r.y, bottom);
  const gapX = gapsOn((r) => r.x, right);
  return gapY >= gapX ? { maxGap: gapY, axis: "y" } : { maxGap: gapX, axis: "x" };
}

/**
 * Recursively extract the visual block pool beneath `el`.
 *
 * Returns the blocks this node contributes — either itself as one block, or the
 * union of its children's blocks when it must be divided.
 */
function extractBlocks(el: Element, ctx: ExtractContext, depth: number): VisualBlock[] {
  const tag = el.tagName.toLowerCase();
  if (SKIP_TAGS.has(tag)) return [];
  if (!isVisible(el, ctx)) return [];

  const rect = toPageRect(el, ctx);
  if (rect.w < 1 || rect.h < 1) return [];

  const style = readStyle(el, ctx);

  // A rule carries no content but is a first-class separator cue — keep it.
  if (style.isRule) {
    return [{ id: ctx.nextId(), els: [el], rect, style, doc: 10, children: [] }];
  }

  const hasContent = hasText(el) || ATOMIC_TAGS.has(tag);
  if (!hasContent) return [];

  const ownText = directText(el);

  const childCandidates = Array.from(el.children)
    .filter((c) => !SKIP_TAGS.has(c.tagName.toLowerCase()))
    .filter((c) => isVisible(c, ctx))
    .map((c) => ({ el: c, rect: toPageRect(c, ctx), style: readStyle(c, ctx) }))
    .filter((c) => c.rect.w >= 1 && c.rect.h >= 1);

  const divide =
    depth < ctx.opts.maxDepth &&
    shouldDivide(rect, style, ownText.length > 0, childCandidates, ctx);

  if (!divide) {
    if (rect.w < ctx.opts.minBlockPx && rect.h < ctx.opts.minBlockPx) return [];
    return [
      {
        id: ctx.nextId(),
        els: [el],
        rect,
        style,
        doc: computeDoC(rect, style, childCandidates, ctx.pageRect),
        children: [],
      },
    ];
  }

  const out: VisualBlock[] = [];
  for (const child of childCandidates) {
    out.push(...extractBlocks(child.el, ctx, depth + 1));
  }

  // Unreachable while `shouldDivide` refuses to split a node with its own text,
  // but kept as a guard: if that ever changes, direct text must not vanish.
  if (out.length > 0 && ownText.length > 0) {
    out.unshift({ id: ctx.nextId(), els: [el], rect, style, doc: 8, children: [] });
  }

  return out.length > 0
    ? out
    : [
        {
          id: ctx.nextId(),
          els: [el],
          rect,
          style,
          doc: computeDoC(rect, style, childCandidates, ctx.pageRect),
          children: [],
        },
      ];
}

// ─────────────────────────────────────────────────────────────
// Phase 2 — Visual separator detection
// ─────────────────────────────────────────────────────────────

interface Separator {
  /** "h" spans horizontally and separates top from bottom; "v" is the converse. */
  axis: "h" | "v";
  /** Start coordinate along the separating axis (y for "h", x for "v"). */
  start: number;
  /** End coordinate along the separating axis. */
  end: number;
  /** Thickness in px. */
  size: number;
  /** Separator weight, 1–10. Higher ⇒ stronger visual boundary. */
  weight: number;
}

function makeSeparator(axis: "h" | "v", start: number, end: number): Separator {
  return { axis, start, end, size: end - start, weight: 1 };
}

/**
 * The paper's separator sweep (§3.2.1).
 *
 * The paper states it imperatively: start with one separator covering the whole
 * region, then for every block in the pool remove / split / shrink the
 * separators it touches. The fixed point of that process is exactly *the region
 * minus the union of the blocks' projections onto the axis* — so this computes
 * the union directly, by sorting the projections and emitting the gaps between
 * merged runs.
 *
 * Same separators, O(n log n) instead of O(n²): the imperative form re-scans a
 * separator list that grows with every block it splits, which on a page whose
 * block pool runs to a few thousand is millions of interval comparisons per
 * region — and phase 3 asks for this twice at every node of its recursion.
 *
 * Separators touching the region's borders are dropped: those are page margin,
 * not internal structure.
 */
function detectSeparators(blocks: VisualBlock[], region: Rect, axis: "h" | "v"): Separator[] {
  const lo = (r: Rect) => (axis === "h" ? r.y : r.x);
  const hi = (r: Rect) => (axis === "h" ? bottom(r) : right(r));
  const regionLo = axis === "h" ? region.y : region.x;
  const regionHi = axis === "h" ? bottom(region) : right(region);

  const spans = blocks
    .map((b) => ({ lo: lo(b.rect), hi: hi(b.rect) }))
    .filter((s) => s.hi > s.lo)
    .sort((a, b) => a.lo - b.lo);

  const separators: Separator[] = [];
  let cursor = regionLo;
  for (const span of spans) {
    if (span.lo > cursor) separators.push(makeSeparator(axis, cursor, span.lo));
    cursor = Math.max(cursor, span.hi);
    if (cursor >= regionHi) break;
  }
  if (cursor < regionHi) separators.push(makeSeparator(axis, cursor, regionHi));

  return separators.filter(
    (s) => s.start > regionLo + 0.5 && s.end < regionHi - 0.5 && s.size > 0,
  );
}

/**
 * Weight the separators (§3.2.2).
 *
 * The paper's rules, all of which need rendered data:
 *   a. the wider the gap, the higher the weight;
 *   b. a separator coinciding with an <hr> weighs more;
 *   c. differing background colours across the separator weigh more;
 *   d. for horizontal separators, differing font size/weight across it weighs
 *      more — especially where a larger/bolder run starts below (a heading);
 *   e. differing structure tags across it weigh more.
 */
function weightSeparators(
  separators: Separator[],
  blocks: VisualBlock[],
  opts: Required<VipsVisualOptions>,
): void {
  if (separators.length === 0) return;

  const axis = separators[0].axis;
  const lo = (r: Rect) => (axis === "h" ? r.y : r.x);
  const hi = (r: Rect) => (axis === "h" ? bottom(r) : right(r));

  // The blocks immediately flanking a gap are the ones whose visual properties
  // the paper compares — not every block on each side. Sorting the pool once by
  // each edge turns that lookup into a binary search, instead of two full scans
  // of the pool for every separator.
  const byHi = [...blocks].sort((a, b) => hi(a.rect) - hi(b.rect));
  const byLo = [...blocks].sort((a, b) => lo(a.rect) - lo(b.rect));
  const hiKeys = byHi.map((b) => hi(b.rect));
  const loKeys = byLo.map((b) => lo(b.rect));

  /** Index of the last key ≤ target, or -1. */
  const lastAtMost = (keys: number[], target: number): number => {
    let lo_ = 0;
    let hi_ = keys.length - 1;
    let found = -1;
    while (lo_ <= hi_) {
      const mid = (lo_ + hi_) >> 1;
      if (keys[mid] <= target) {
        found = mid;
        lo_ = mid + 1;
      } else {
        hi_ = mid - 1;
      }
    }
    return found;
  };

  /** Index of the first key ≥ target, or -1. */
  const firstAtLeast = (keys: number[], target: number): number => {
    let lo_ = 0;
    let hi_ = keys.length - 1;
    let found = -1;
    while (lo_ <= hi_) {
      const mid = (lo_ + hi_) >> 1;
      if (keys[mid] >= target) {
        found = mid;
        hi_ = mid - 1;
      } else {
        lo_ = mid + 1;
      }
    }
    return found;
  };

  for (const sep of separators) {
    let weight = 1;

    // (a) gap width — the primary signal
    if (sep.size >= 60) weight += 4;
    else if (sep.size >= 32) weight += 3;
    else if (sep.size >= 18) weight += 2;
    else if (sep.size >= opts.minSeparatorPx) weight += 1;

    // Sorted by their bottom/right edge, the block ending closest above the gap
    // is the last one at or before its start; likewise below.
    const aboveIdx = lastAtMost(hiKeys, sep.start + 1);
    const belowIdx = firstAtLeast(loKeys, sep.end - 1);
    const above = aboveIdx >= 0 ? byHi[aboveIdx] : null;
    const below = belowIdx >= 0 ? byLo[belowIdx] : null;

    if (above && below) {
      // (b) an explicit rule sitting in the gap
      if (above.style.isRule || below.style.isRule) weight += 3;

      // (c) background change across the boundary
      if (above.style.background !== below.style.background) weight += 2;

      // (d) typography change — strongest when a heading opens below
      const sizeDelta = Math.abs(above.style.fontSizePx - below.style.fontSizePx);
      if (sep.axis === "h") {
        if (sizeDelta >= 8) weight += 3;
        else if (sizeDelta >= 4) weight += 2;
        else if (sizeDelta >= 2) weight += 1;
        if (below.style.fontWeight - above.style.fontWeight >= 200) weight += 1;
      } else if (sizeDelta >= 4) {
        weight += 1;
      }

      // (e) structural tag change
      if (above.style.tag !== below.style.tag) weight += 1;
    }

    sep.weight = Math.max(1, Math.min(10, weight));
  }
}

// ─────────────────────────────────────────────────────────────
// Phase 3 — Content structure construction
// ─────────────────────────────────────────────────────────────

/** Split a block pool along the separators at (or near) the maximum weight. */
function cutAlong(blocks: VisualBlock[], separators: Separator[], axis: "h" | "v"): VisualBlock[][] {
  const lo = (r: Rect) => (axis === "h" ? r.y : r.x);

  const maxWeight = Math.max(...separators.map((s) => s.weight));
  const cuts = separators
    .filter((s) => s.weight >= maxWeight)
    .map((s) => (s.start + s.end) / 2)
    .sort((a, b) => a - b);

  if (cuts.length === 0) return [blocks];

  const groups: VisualBlock[][] = Array.from({ length: cuts.length + 1 }, () => []);
  for (const block of blocks) {
    const pos = lo(block.rect);
    let idx = 0;
    while (idx < cuts.length && pos >= cuts[idx]) idx++;
    groups[idx].push(block);
  }
  return groups.filter((g) => g.length > 0);
}

interface BuildContext {
  opts: Required<VipsVisualOptions>;
  emitted: { count: number };
  nextId: () => string;
}

/**
 * Recursively build the content structure for one region.
 *
 * Terminates when: the region holds one block, no separator survives detection,
 * the region's DoC already meets PDoC, depth is exhausted, or the block budget
 * is spent.
 */
function buildStructure(
  blocks: VisualBlock[],
  region: Rect,
  ctx: BuildContext,
  depth: number,
): VisualBlock[] {
  if (blocks.length <= 1) return blocks;
  if (depth >= ctx.opts.maxDepth) return [mergeGroup(blocks, ctx)];
  if (ctx.emitted.count >= ctx.opts.maxBlocks) return [mergeGroup(blocks, ctx)];

  const horizontal = detectSeparators(blocks, region, "h");
  const vertical = detectSeparators(blocks, region, "v");
  weightSeparators(horizontal, blocks, ctx.opts);
  weightSeparators(vertical, blocks, ctx.opts);

  const usableH = horizontal.filter((s) => s.size >= ctx.opts.minSeparatorPx);
  const usableV = vertical.filter((s) => s.size >= ctx.opts.minSeparatorPx);

  if (usableH.length === 0 && usableV.length === 0) {
    return [mergeGroup(blocks, ctx)];
  }

  // Pick the axis carrying the strongest boundary; ties go to horizontal,
  // matching reading order.
  const maxH = usableH.length ? Math.max(...usableH.map((s) => s.weight)) : 0;
  const maxV = usableV.length ? Math.max(...usableV.map((s) => s.weight)) : 0;
  const axis: "h" | "v" = maxH >= maxV ? "h" : "v";
  const chosen = axis === "h" ? usableH : usableV;

  const groups = cutAlong(blocks, chosen, axis);
  if (groups.length <= 1) return [mergeGroup(blocks, ctx)];

  const surviving = [...usableH, ...usableV];
  const out: VisualBlock[] = [];
  for (const group of groups) {
    const merged = mergeGroup(group, ctx, surviving);
    // Recurse only where the region is not yet coherent enough (§3.3).
    if (merged.doc < ctx.opts.pdoc && group.length > 1) {
      const sub = buildStructure(group, merged.rect, ctx, depth + 1);
      if (sub.length > 1) {
        merged.children = sub;
        out.push(merged);
        continue;
      }
    }
    out.push(merged);
  }
  return out;
}

/** Strongest separator lying wholly inside `rect`, or 0 if there is none. */
function internalMaxWeight(rect: Rect, separators: Separator[]): number {
  let max = 0;
  for (const s of separators) {
    const lo = s.axis === "h" ? rect.y : rect.x;
    const hi = s.axis === "h" ? bottom(rect) : right(rect);
    if (s.start >= lo - 0.5 && s.end <= hi + 0.5) max = Math.max(max, s.weight);
  }
  return max;
}

/**
 * Fuse a group of blocks into one and score how coherent the result is.
 *
 * The DoC of a merged region comes from the strongest separator still standing
 * *inside* it (§3.3): a region a reader can see a hard boundary through is not
 * one thing, however tidy its parts are individually.
 *
 * Taking `min(member DoC)` instead — the obvious reading — inverts that. Phase 1
 * scores an indivisible leaf 10, so a column of thirty tight paragraphs merges
 * to DoC 10, clears any PDoC, and is never subdivided. The §3.3 recursion then
 * never runs at all and the algorithm returns a page as two or three slabs. The
 * member minimum is still applied as a ceiling, so an incoherent part keeps the
 * whole from being called coherent.
 */
function mergeGroup(
  group: VisualBlock[],
  ctx: BuildContext,
  internalSeparators: Separator[] = [],
): VisualBlock {
  if (group.length === 1) return group[0];
  ctx.emitted.count++;
  const rect = unionAll(group.map((b) => b.rect));
  const strongest = internalMaxWeight(rect, internalSeparators);
  const memberMin = Math.min(...group.map((b) => b.doc));
  return {
    id: ctx.nextId(),
    els: group.flatMap((b) => b.els),
    rect,
    style: group[0].style,
    doc: Math.max(
      1,
      Math.min(memberMin, strongest > 0 ? 11 - strongest : 10),
    ),
    children: [],
  };
}

// ─────────────────────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────────────────────

interface VipsVisualResult {
  /** The leaf visual blocks, in reading order. */
  blocks: VisualBlock[];
  diagnostics: VipsVisualDiagnostics;
}

export interface VipsVisualDiagnostics {
  /** Blocks in the pool after phase 1. */
  poolSize: number;
  /** Leaf blocks after phase 3. */
  leafCount: number;
  /** Separators that survived detection at the top level, both axes. */
  topLevelSeparators: number;
  /** Maximum separator weight seen at the top level. */
  maxSeparatorWeight: number;
  /** Mean DoC across emitted leaves. */
  meanDoc: number;
  pdoc: number;
  /** Phase 1 — visual block extraction, ms. */
  extractMs: number;
  /** Phases 2+3 — separator detection, weighting and structure building, ms. */
  structureMs: number;
  /** `getComputedStyle` resolves issued, after caching. One per element is ideal. */
  styleReads: number;
}

/** Depth-first leaf collection, preserving document order. */
function collectLeaves(blocks: VisualBlock[], out: VisualBlock[]): void {
  for (const b of blocks) {
    if (b.children.length > 0) collectLeaves(b.children, out);
    else out.push(b);
  }
}

/**
 * Run all three VIPS phases over a rendered frame.
 *
 * `root` defaults to the frame's body. The returned blocks reference live
 * elements in the frame, so callers must consume them before the frame is torn
 * down — in practice, inside the `read` callback of `renderInFrame`.
 */
export function runVipsVisual(
  frame: RenderedFrame,
  root: Element,
  options: VipsVisualOptions = {},
): VipsVisualResult {
  const opts = { ...OPT_DEFAULTS, ...options };
  let counter = 0;
  const nextId = () => `vb${counter++}`;

  const origin = { x: frame.bodyRect.left, y: frame.bodyRect.top };
  const extractCtx: ExtractContext = {
    win: frame.win,
    doc: frame.doc,
    origin,
    opts,
    // Filled in below — `pageRect` needs the root's measured box, and measuring
    // it goes through the context's cache.
    pageRect: { x: 0, y: 0, w: 1, h: 1 },
    viewportHeight: frame.win.innerHeight || 900,
    nextId,
    rects: new Map(),
    styles: new Map(),
    backgrounds: new Map(),
  };

  const rootRect = toPageRect(root, extractCtx);
  extractCtx.pageRect = {
    x: 0,
    y: 0,
    w: Math.max(rootRect.w, frame.win.innerWidth || 1200),
    h: Math.max(rootRect.h, frame.win.innerHeight || 900),
  };

  // Phase 1
  const extractT0 = now();
  const pool = extractBlocks(root, extractCtx, 0).filter(
    (b) => b.rect.w >= opts.minBlockPx || b.rect.h >= opts.minBlockPx,
  );
  const extractMs = Math.round(now() - extractT0);
  const styleReads = extractCtx.styles.size;

  if (pool.length === 0) {
    return {
      blocks: [],
      diagnostics: {
        poolSize: 0,
        leafCount: 0,
        topLevelSeparators: 0,
        maxSeparatorWeight: 0,
        meanDoc: 0,
        pdoc: opts.pdoc,
        extractMs,
        structureMs: 0,
        styleReads,
      },
    };
  }

  const structureT0 = now();

  // Phase 2 diagnostics at the top level (phase 2 also runs inside phase 3).
  const topH = detectSeparators(pool, rootRect, "h");
  const topV = detectSeparators(pool, rootRect, "v");
  weightSeparators(topH, pool, opts);
  weightSeparators(topV, pool, opts);
  const topSeps = [...topH, ...topV].filter((s) => s.size >= opts.minSeparatorPx);

  // Phase 3
  const buildCtx: BuildContext = { opts, emitted: { count: 0 }, nextId };
  const tree = buildStructure(pool, rootRect, buildCtx, 0);

  const leaves: VisualBlock[] = [];
  collectLeaves(tree, leaves);
  leaves.sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x);

  const capped = leaves.slice(0, opts.maxBlocks);

  return {
    blocks: capped,
    diagnostics: {
      poolSize: pool.length,
      leafCount: capped.length,
      topLevelSeparators: topSeps.length,
      maxSeparatorWeight: topSeps.length
        ? Math.max(...topSeps.map((s) => s.weight))
        : 0,
      meanDoc: capped.length
        ? Math.round((capped.reduce((s, b) => s + b.doc, 0) / capped.length) * 10) / 10
        : 0,
      pdoc: opts.pdoc,
      extractMs,
      structureMs: Math.round(now() - structureT0),
      styleReads,
    },
  };
}
