/**
 * eval/segmentation.ts — literature-grounded web-page segmentation quality.
 *
 * Implements the evaluation methodology of:
 *   Kiesel, Kneist, Meyer, Komlossy, Stein, Potthast —
 *   "Web Page Segmentation Revisited: Evaluation Framework and Dataset",
 *   CIKM 2020, pp. 3047–3054.
 *   https://downloads.webis.de/publications/papers/kiesel_2020b.pdf
 *
 * In that framework a *segmentation* is a partition of a page's **atomic
 * elements** into segments, and two segmentations are compared with a
 * size-weighted **BCubed** precision / recall / F-measure over pairs of atomic
 * elements. Kiesel et al. weight each atomic element by its rendered **pixel
 * area**. We run entirely on the DOM (no rendering / no CSSOM), so we weight by
 * **text length** as a rendering-free proxy for visual mass. This is the one
 * documented deviation from the paper; everything else follows the framework.
 *
 * WHY THIS MATTERS FOR THE PROJECT
 * --------------------------------
 * The existing compare/ metrics score the parser against the *DOM's own*
 * landmarks (self-referential). This module instead scores how well each
 * segmentation *algorithm* recovers a reference segmentation of the page — the
 * field's standard notion of "is the segmentation correct". Every segmenter
 * here is an independent `Document -> Segmentation` function evaluated on an
 * identical atomic-element set, so results are attributable to the algorithm
 * (no shared parsePageToIR confound).
 *
 * Pure + DOM-only: works with a browser `DOMParser` document and with a jsdom
 * document in the offline Node harness.
 *
 * TWO CONSUMERS
 * -------------
 *  • scoreSegmentation() — compares standalone segmentation ALGORITHMS (flat,
 *    vips, readability, …). Used by the offline benchmark. No parser involved.
 *  • scoreSceneSegmentation() — scores ONE parser BACKEND's produced scene
 *    (Custom / Readability / Naive / VIPS). Used by the in-app panel so the
 *    Segmentation tab breaks down by the same backends as every other tab.
 */

import type { XRPrimitive } from "../mapper/types";

// ─────────────────────────────────────────────────────────────
// Atomic elements
// ─────────────────────────────────────────────────────────────

/**
 * A single atomic content unit of the page — the smallest block that carries
 * standalone content. Kiesel's "atomic elements". Each is tied to the concrete
 * DOM element so every segmenter partitions the *same* set (alignment is by
 * `id`, never by re-matching text across algorithms).
 */
export interface AtomicUnit {
  /** Stable index within the page (assignment order == document order). */
  id: number;
  /** The DOM element this unit corresponds to. */
  el: Element;
  /** Visual-mass weight. Text length (chars); ≥ 1 for non-empty media. */
  weight: number;
}

/** Partition of atomic units: unit id → segment label. */
export type Segmentation = Map<number, string>;

/** Result of a BCubed comparison. All rates in [0, 1]. */
export interface SegmentationScore {
  precision: number;
  recall: number;
  f: number;
  /** #segments the algorithm produced (over covered units). */
  segmentCount: number;
  /** #atomic units scored (present in both partitions). */
  coveredUnits: number;
}

/**
 * Elements that, when they carry direct text, count as atomic content blocks.
 * We treat the *smallest* text-bearing block as atomic: an element is atomic if
 * it has non-whitespace direct text (a text node child) OR is standalone media.
 */
const MEDIA_TAGS = new Set(["img", "video", "audio", "svg", "canvas", "iframe"]);
const SKIP_TAGS = new Set([
  "script", "style", "noscript", "meta", "link", "head", "template", "br", "wbr",
]);
const INTERACTIVE_LEAF = new Set(["input", "textarea", "select", "button"]);

/**
 * Page-chrome regions the XR scene does not render (banner + contentinfo), so
 * the segmentation eval ignores their content entirely — units inside a
 * <header>/<footer> (or role=banner/contentinfo) are never emitted, which keeps
 * every segmenter and the reference scored on main content only.
 */
const IGNORED_REGION_TAGS = new Set(["header", "footer"]);
const IGNORED_REGION_ROLES = new Set(["banner", "contentinfo"]);

/** Collapse whitespace; the visible-text length is our weight. */
function directTextLength(el: Element): number {
  let len = 0;
  for (const child of Array.from(el.childNodes)) {
    // Node.TEXT_NODE === 3 (avoid importing DOM lib constants for jsdom parity).
    if (child.nodeType === 3) {
      const t = (child.textContent ?? "").replace(/\s+/g, " ").trim();
      len += t.length;
    }
  }
  return len;
}

/**
 * Extract the page's atomic units in document order. Called ONCE per page; the
 * returned list is shared by every segmenter and by the ground truth so that
 * BCubed compares like-for-like partitions.
 */
export function extractAtomicUnits(root: Element): AtomicUnit[] {
  const units: AtomicUnit[] = [];
  let nextId = 0;

  const visit = (el: Element): void => {
    const tag = el.tagName.toLowerCase();
    if (SKIP_TAGS.has(tag)) return;
    if (el.getAttribute("aria-hidden") === "true") return;
    // Skip the whole banner/footer subtree — it is chrome the scene drops.
    const role = el.getAttribute("role");
    if (IGNORED_REGION_TAGS.has(tag) || (role && IGNORED_REGION_ROLES.has(role))) {
      return;
    }

    if (MEDIA_TAGS.has(tag) || INTERACTIVE_LEAF.has(tag)) {
      const alt = el.getAttribute("alt") ?? el.getAttribute("aria-label") ?? "";
      units.push({ id: nextId++, el, weight: Math.max(alt.trim().length, 12) });
      return;
    }

    const own = directTextLength(el);
    const hasElementChildren = el.children.length > 0;
    // Leaf-ish text block: has its own text and no block children that would
    // themselves be atomic. If it also has element children (e.g. <p> with an
    // inline <a>), it is still atomic — inline children are not descended into
    // for atomicity, but we DO recurse to catch block children carrying text.
    if (own > 0) {
      units.push({ id: nextId++, el, weight: own });
    }
    if (hasElementChildren) {
      for (const child of Array.from(el.children)) visit(child);
    }
  };

  for (const child of Array.from(root.children)) visit(child);
  return units;
}

// ─────────────────────────────────────────────────────────────
// BCubed comparison (size-weighted)
// ─────────────────────────────────────────────────────────────

/**
 * Size-weighted extended BCubed precision / recall / F between a predicted and
 * a reference segmentation, scored over the atomic units present in both.
 *
 * For atomic unit e with predicted cluster C = pred(e) and reference category
 * L = ref(e), let W(S) = Σ weight over units in set S:
 *   P_e = W(C ∩ L) / W(C)          (are units grouped with e correctly grouped?)
 *   R_e = W(C ∩ L) / W(L)          (are units that belong with e recovered?)
 *   Precision = Σ_e w_e·P_e / Σ_e w_e ,  Recall likewise ,  F = 2PR/(P+R).
 *
 * A merge (algorithm lumps two reference segments together) depresses precision;
 * a split (algorithm shatters one reference segment) depresses recall — exactly
 * the accounting the framework requires.
 */
export function bcubed(
  pred: Segmentation,
  ref: Segmentation,
  units: AtomicUnit[],
): SegmentationScore {
  const weightOf = new Map<number, number>();
  for (const u of units) weightOf.set(u.id, u.weight);

  // Only units both partitions place are scored.
  const scored = units.filter((u) => pred.has(u.id) && ref.has(u.id));
  if (scored.length === 0) {
    return { precision: 0, recall: 0, f: 0, segmentCount: 0, coveredUnits: 0 };
  }

  // Cluster/category weight sums and their intersections.
  const clusterW = new Map<string, number>();
  const categoryW = new Map<string, number>();
  const interW = new Map<string, number>(); // key `${cluster} ${category}`
  for (const u of scored) {
    const c = pred.get(u.id)!;
    const l = ref.get(u.id)!;
    const w = weightOf.get(u.id)!;
    clusterW.set(c, (clusterW.get(c) ?? 0) + w);
    categoryW.set(l, (categoryW.get(l) ?? 0) + w);
    const k = `${c} ${l}`;
    interW.set(k, (interW.get(k) ?? 0) + w);
  }

  let pNum = 0;
  let rNum = 0;
  let wSum = 0;
  for (const u of scored) {
    const c = pred.get(u.id)!;
    const l = ref.get(u.id)!;
    const w = weightOf.get(u.id)!;
    const inter = interW.get(`${c} ${l}`)!;
    pNum += w * (inter / clusterW.get(c)!);
    rNum += w * (inter / categoryW.get(l)!);
    wSum += w;
  }

  const precision = pNum / wSum;
  const recall = rNum / wSum;
  const f = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  const segments = new Set(scored.map((u) => pred.get(u.id)!));
  return {
    precision,
    recall,
    f,
    segmentCount: segments.size,
    coveredUnits: scored.length,
  };
}

// ─────────────────────────────────────────────────────────────
// Segmenters — each is an independent Document/Element → Segmentation.
// No segmenter routes through parsePageToIR, so scores are attributable to the
// algorithm itself (the "backend confound" does not apply to this metric).
// ─────────────────────────────────────────────────────────────

// header/footer (banner/contentinfo) are intentionally absent — that chrome is
// excluded from atomic units (see IGNORED_REGION_*), so it never segments here.
const SECTIONING_TAGS = new Set([
  "main", "section", "article", "nav", "aside", "form",
  "figure", "table", "ul", "ol", "dl",
]);
const SECTIONING_ROLES = new Set([
  "main", "navigation", "complementary", "region",
  "article", "form", "search", "list", "table",
]);

/** Nearest ancestor (inclusive) that opens a new sectioning context, or null. */
function nearestSection(el: Element, root: Element): Element | null {
  let cur: Element | null = el;
  while (cur && cur !== root.parentElement) {
    const tag = cur.tagName.toLowerCase();
    const role = cur.getAttribute("role");
    if (SECTIONING_TAGS.has(tag) || (role && SECTIONING_ROLES.has(role))) {
      return cur;
    }
    cur = cur.parentElement;
  }
  return null;
}

/** Stable per-element key so two units under the same section share a label. */
function elKey(el: Element, salt: string): string {
  const anyEl = el as Element & { __segKey?: string };
  if (!anyEl.__segKey) anyEl.__segKey = `${salt}#${Math.random().toString(36).slice(2)}`;
  return anyEl.__segKey;
}

/**
 * BASELINE — whole page is one segment. Represents "no segmentation": maximal
 * merge. Upper-bounds recall (everything grouped) and lower-bounds precision.
 */
export function segFlat(units: AtomicUnit[]): Segmentation {
  const seg: Segmentation = new Map();
  for (const u of units) seg.set(u.id, "page");
  return seg;
}

/**
 * HTML5 SEMANTIC SECTIONING — segment = nearest sectioning ancestor. Rewards
 * pages authored with real landmarks/sectioning; degenerates to `segFlat` on
 * div-soup. Also serves as the default proxy reference (see proxyGroundTruth).
 */
export function segDomSectioning(units: AtomicUnit[], root: Element): Segmentation {
  const seg: Segmentation = new Map();
  for (const u of units) {
    const sec = nearestSection(u.el, root);
    seg.set(u.id, sec ? elKey(sec, "sec") : "root");
  }
  return seg;
}

/**
 * HEADING-BOUNDED — approximates the custom parser's structural inference:
 * a new segment starts at every heading; content flows into the current
 * heading's segment. Independent of sectioning markup.
 */
export function segHeadingBounded(units: AtomicUnit[]): Segmentation {
  const seg: Segmentation = new Map();
  let current = "intro";
  let counter = 0;
  for (const u of units) {
    const tag = u.el.tagName.toLowerCase();
    const role = u.el.getAttribute("role");
    const isHeading = /^h[1-6]$/.test(tag) || role === "heading";
    if (isHeading) current = `h${++counter}`;
    seg.set(u.id, current);
  }
  return seg;
}

/**
 * VIPS-DIRECT — a rendering-free port of the DOC (Degree-of-Coherence)
 * recursion from Cai et al. 2003, producing a block partition *directly* (no
 * parsePageToIR). Each visual leaf block becomes one segment; atomic units
 * inherit the id of the nearest ancestor block the recursion emitted.
 */
export function segVips(units: AtomicUnit[], root: Element): Segmentation {
  const BLOCK = new Set([
    "div", "section", "article", "main", "aside", "header", "footer", "nav",
    "form", "table", "ul", "ol", "dl", "blockquote", "pre", "figure", "details",
  ]);
  const DOC_THRESHOLD = 0.68;
  const MAX_DEPTH = 7;

  const textLen = (el: Element) => (el.textContent ?? "").trim().length;
  const linkDensity = (el: Element) => {
    const total = textLen(el);
    if (total === 0) return 0;
    let link = 0;
    for (const a of Array.from(el.querySelectorAll("a"))) link += textLen(a);
    return link / total;
  };
  const doc = (el: Element): number => {
    const len = textLen(el);
    const ld = linkDensity(el);
    const kids = Array.from(el.children);
    const blockKids = kids.filter((c) => BLOCK.has(c.tagName.toLowerCase())).length;
    const leafKids = kids.length - blockKids;
    if (len < 20 && blockKids === 0) return 0.1;
    if (ld > 0.55 && len < 600) return 0.9;
    if (blockKids === 0 && len > 0) return 0.85;
    if (leafKids > blockKids && len < 1200) return 0.8;
    if (blockKids >= 4) return 0.35;
    if (blockKids >= 2) return 0.55;
    return len > 300 ? 0.75 : 0.5;
  };

  const blocks: Element[] = [];
  const segment = (el: Element, depth: number): void => {
    const tag = el.tagName.toLowerCase();
    if (SKIP_TAGS.has(tag)) return;
    if (doc(el) >= DOC_THRESHOLD || depth >= MAX_DEPTH) {
      if (textLen(el) > 40) blocks.push(el);
      return;
    }
    const blockKids = Array.from(el.children).filter(
      (c) => BLOCK.has(c.tagName.toLowerCase()) && textLen(c) > 20,
    );
    if (blockKids.length === 0) {
      if (textLen(el) > 40) blocks.push(el);
      return;
    }
    for (const k of blockKids) segment(k, depth + 1);
  };
  segment(root, 0);

  // Assign each unit to the deepest emitted block that contains it.
  const blockKeyFor = new Map<Element, string>();
  blocks.forEach((b, i) => blockKeyFor.set(b, `vips${i}`));
  const seg: Segmentation = new Map();
  for (const u of units) {
    let cur: Element | null = u.el;
    let label = "vips-root";
    while (cur) {
      const k = blockKeyFor.get(cur);
      if (k) {
        label = k;
        break;
      }
      cur = cur.parentElement;
    }
    seg.set(u.id, label);
  }
  return seg;
}

/**
 * READABILITY-STYLE — content-extraction segmentation. Partitions the page into
 * exactly two segments: `main` (highest text-density subtree) vs `boilerplate`.
 * Mirrors what a Readability pass yields for downstream layout. Rendering-free
 * density heuristic so it runs identically in browser and Node.
 */
export function segReadability(units: AtomicUnit[], root: Element): Segmentation {
  const score = (el: Element): number => {
    const text = (el.textContent ?? "").trim();
    if (text.length === 0) return 0;
    let linkText = 0;
    for (const a of Array.from(el.querySelectorAll("a"))) {
      linkText += (a.textContent ?? "").trim().length;
    }
    const linkDensity = linkText / text.length;
    const commas = (text.match(/,/g) ?? []).length;
    return text.length * (1 - linkDensity) + commas * 20;
  };
  // Candidate = the highest-scoring block among plausible article containers.
  const candidates = Array.from(
    root.querySelectorAll("article, main, section, div"),
  );
  let best: Element | null = null;
  let bestScore = 0;
  for (const c of candidates) {
    const s = score(c);
    if (s > bestScore) {
      bestScore = s;
      best = c;
    }
  }
  const seg: Segmentation = new Map();
  for (const u of units) {
    const inMain = best ? best.contains(u.el) : false;
    seg.set(u.id, inMain ? "main" : "boilerplate");
  }
  return seg;
}

/**
 * BLOCK-FUSION — a rendering-free port of the densitometric segmentation of
 * Kohlschütter & Nejdl, "A densitometric approach to web page segmentation",
 * CIKM 2008. Text density of a block ≈ tokens / lines, approximated here by
 * words per atomic unit (one unit ≈ one text line/block). Adjacent units in
 * document order are fused into the same segment while the absolute difference
 * in their text density stays below θ_max; a large density jump opens a new
 * block. This reproduces the paper's core idea (blocks are bounded by density
 * discontinuities) without a CSS box model.
 */
export function segBlockFusion(units: AtomicUnit[], thetaMax = 0.38): Segmentation {
  const seg: Segmentation = new Map();
  if (units.length === 0) return seg;
  // Text density per unit: words normalised into (0,1] via a soft cap so the
  // threshold is scale-free (long paragraphs saturate rather than dominate).
  const density = (u: AtomicUnit): number => {
    const words = ((u.el.textContent ?? "").trim().match(/\S+/g) ?? []).length;
    return words === 0 ? 0 : 1 - 1 / (1 + words / 12); // saturating in words
  };
  let block = 0;
  let prev = density(units[0]);
  seg.set(units[0].id, `bf${block}`);
  for (let i = 1; i < units.length; i++) {
    const d = density(units[i]);
    if (Math.abs(d - prev) > thetaMax) block++;
    seg.set(units[i].id, `bf${block}`);
    prev = d;
  }
  return seg;
}

/**
 * CETD — Composite Text Density content extraction (Sun, Song, Liu, "DOM based
 * Content Extraction via Text Density", WWW 2011). Each block element gets a
 * text density = own text length / (own text + descendant tag count); the
 * highest-density subtree is the main content, everything else boilerplate.
 * Two-segment partition, density-driven (contrast with Readability's
 * link-density heuristic).
 */
export function segTextDensity(units: AtomicUnit[], root: Element): Segmentation {
  const textDensity = (el: Element): number => {
    const textLen = (el.textContent ?? "").trim().length;
    if (textLen === 0) return 0;
    const tagCount = el.getElementsByTagName("*").length + 1;
    return textLen / tagCount; // chars per tag — high for dense prose
  };
  const candidates = Array.from(root.querySelectorAll("article, main, section, div, td"));
  let best: Element | null = null;
  let bestScore = 0;
  for (const c of candidates) {
    // Weight density by the block's own size so a tiny dense span doesn't win.
    const s = textDensity(c) * Math.log2((c.textContent ?? "").trim().length + 2);
    if (s > bestScore) {
      bestScore = s;
      best = c;
    }
  }
  const seg: Segmentation = new Map();
  for (const u of units) {
    seg.set(u.id, best?.contains(u.el) ? "content" : "boilerplate");
  }
  return seg;
}

// ─────────────────────────────────────────────────────────────
// Reference segmentation (ground truth)
// ─────────────────────────────────────────────────────────────

/**
 * A supplied human/gold annotation: CSS-selector → segment label. Units whose
 * element matches a selector (closest ancestor wins) take that label. This is
 * the preferred reference when available (Kiesel uses crowd annotations).
 */
export interface SegmentationAnnotation {
  [selector: string]: string;
}

/**
 * Build a reference segmentation. If `annotation` is provided it is authoritative;
 * otherwise we fall back to the HTML5-semantic proxy oracle (segDomSectioning),
 * which rewards correct landmark/sectioning authoring. The proxy is a stand-in
 * for gold annotations and is reported as such — it should not be read as a
 * human ground truth.
 */
export function proxyGroundTruth(
  units: AtomicUnit[],
  root: Element,
  annotation?: SegmentationAnnotation,
): Segmentation {
  if (!annotation) return segDomSectioning(units, root);
  const seg: Segmentation = new Map();
  const selectors = Object.keys(annotation);
  for (const u of units) {
    let label = "unlabelled";
    // Deepest matching ancestor wins.
    for (const sel of selectors) {
      let anc: Element | null = u.el;
      while (anc) {
        if (anc.matches?.(sel)) {
          label = annotation[sel];
          break;
        }
        anc = anc.parentElement;
      }
      if (label !== "unlabelled") break;
    }
    seg.set(u.id, label);
  }
  return seg;
}

// ─────────────────────────────────────────────────────────────
// Runner
// ─────────────────────────────────────────────────────────────

export type SegmenterId =
  | "flat"
  | "dom-sectioning"
  | "heading-bounded"
  | "vips"
  | "readability"
  | "block-fusion"
  | "text-density";

export const SEGMENTERS: Record<
  SegmenterId,
  (units: AtomicUnit[], root: Element) => Segmentation
> = {
  flat: (u) => segFlat(u),
  "dom-sectioning": (u, r) => segDomSectioning(u, r),
  "heading-bounded": (u) => segHeadingBounded(u),
  vips: (u, r) => segVips(u, r),
  readability: (u, r) => segReadability(u, r),
  "block-fusion": (u) => segBlockFusion(u),
  "text-density": (u, r) => segTextDensity(u, r),
};

/**
 * Score every segmenter on one page against the reference. `root` is typically
 * `document.body`. Returns a per-algorithm map of BCubed scores.
 */
export function scoreSegmentation(
  root: Element,
  annotation?: SegmentationAnnotation,
): Record<SegmenterId, SegmentationScore> {
  const units = extractAtomicUnits(root);
  const ref = proxyGroundTruth(units, root, annotation);
  const out = {} as Record<SegmenterId, SegmentationScore>;
  for (const id of Object.keys(SEGMENTERS) as SegmenterId[]) {
    out[id] = bcubed(SEGMENTERS[id](units, root), ref, units);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────
// Per-backend scoring — segmentation of a produced XR scene
// ─────────────────────────────────────────────────────────────

/** Scene primitives that open a new segment (mirror HTML5 sectioning). */
const SCENE_SEGMENT_TYPES = new Set([
  "XRContentPanel", "XRSection", "XRArticle", "XRList", "XRNavigationBar",
  "XRComplementary", "XRFormPanel", "XRTable", "XRFigure",
]);

function norm(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Score one parser BACKEND's segmentation: how its produced scene groups the
 * page's atomic content units, vs the reference. The scene carries no DOM
 * pointers, so its text is aligned back to the reference atomic units by
 * normalised text content. Units the backend dropped (absent from its scene)
 * stay unscored — see `coveredUnits`, which reports alignment/retention.
 *
 * `refRoot` is the ORIGINAL page body (the true structure); `sceneRoot` is the
 * backend's `scene.root`.
 */
export function scoreSceneSegmentation(
  sceneRoot: XRPrimitive,
  refRoot: Element,
  annotation?: SegmentationAnnotation,
): SegmentationScore {
  const refUnits = extractAtomicUnits(refRoot);
  const ref = proxyGroundTruth(refUnits, refRoot, annotation);

  // Build: normalised text → the scene segment (nearest sectioning container).
  const textToSeg = new Map<string, string>();
  const walk = (p: XRPrimitive, seg: string): void => {
    const here = SCENE_SEGMENT_TYPES.has(p.type) ? p.id : seg;
    const raw =
      p.content ?? p.label ?? (p as { text?: string }).text ?? "";
    const t = norm(raw);
    if (t) textToSeg.set(t, here);
    for (const c of p.children) walk(c, here);
  };
  walk(sceneRoot, "root");

  const pred: Segmentation = new Map();
  for (const u of refUnits) {
    const full = norm(u.el.textContent ?? "");
    let seg = textToSeg.get(full);
    if (seg === undefined) {
      // Fall back to the element's own direct text (excludes descendants).
      const direct = norm(
        Array.from(u.el.childNodes)
          .filter((n) => n.nodeType === 3)
          .map((n) => n.textContent ?? "")
          .join(" "),
      );
      if (direct) seg = textToSeg.get(direct);
    }
    if (seg !== undefined) pred.set(u.id, seg);
  }
  return bcubed(pred, ref, refUnits);
}
