/**
 * compare/metrics.ts — pure derivations that turn IR + scene + HTML into the
 * comparison metrics. No React, no I/O.
 */
import type { IRNode, IRAnalytics } from "../../ir/types";
import type { XRPrimitive, SemanticScene } from "../../mapper/types";
import { extractAtomicUnits } from "../../eval/segmentation";
import { CONFIDENCE_THRESHOLD, TOTAL_PRIMITIVE_TYPES } from "./config";
import type {
  IRQuality,
  PrecisionRecall,
  AccessibilityPreservation,
  StructuralFidelity,
  InformationFidelity,
  XRUsability,
  CompositeScore,
  PrimitiveBreakdown,
  HTMLGroundTruth,
} from "./types";

/** Collapse whitespace + lowercase, for content-based matching. */
export function norm(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

/** Interactive XR primitive types (affordances the user can act on). */
export const INTERACTIVE_XR_TYPES = new Set([
  "XRButton", "XRLink", "XRFormField", "XRToggle", "XRSlider",
  "XRComboBox", "XRSearchBox", "XRTab", "XRMenuItem", "XRTreeItem",
]);

/** CSS selector for DOM interactive elements (the denominator population). */
const INTERACTIVE_DOM_SELECTOR =
  'a[href], button, input:not([type="hidden"]), select, textarea, ' +
  '[role="button"], [role="link"], [role="checkbox"], [role="radio"], ' +
  '[role="switch"], [role="tab"], [role="menuitem"], [role="menuitemcheckbox"], ' +
  '[role="menuitemradio"], [role="slider"], [role="combobox"], [role="textbox"], ' +
  '[role="searchbox"], [role="treeitem"], [role="option"]';

/**
 * Classify a DOM link the way the pipeline does: a link inside a nav/menu
 * landmark, or one that is essentially the sole content of its block (a
 * link-only list item / standalone link), becomes a placed XRLink primitive
 * ("nav"); a link surrounded by prose becomes an inline run ("inline").
 */
function classifyLink(a: Element): "nav" | "inline" {
  if (a.closest('nav, [role="navigation"], menu, [role="menu"], [role="menubar"]')) {
    return "nav";
  }
  const block = a.closest(
    "p, h1, h2, h3, h4, h5, h6, blockquote, figcaption, dd, dt, caption, li, td, th",
  );
  if (!block) return "nav"; // standalone (no prose block around it)
  const blockLen = norm(block.textContent ?? "").length;
  const linkLen = norm(a.textContent ?? "").length;
  // Link is ≥80% of its block's text → it *is* the block (link-only li) → nav.
  if (blockLen > 0 && linkLen / blockLen > 0.8) return "nav";
  return "inline";
}

/** Resolve an aria-labelledby/aria-describedby id list to its combined text. */
function resolveIdrefText(doc: Document, idref: string): string {
  return norm(
    idref
      .split(/\s+/)
      .map((id) => doc.getElementById(id)?.textContent ?? "")
      .join(" "),
  );
}

export function extractHTMLGroundTruth(html: string): HTMLGroundTruth {
  const doc = new DOMParser().parseFromString(html, "text/html");

  const allLinks = Array.from(doc.querySelectorAll("a[href]"));
  const allImages = doc.querySelectorAll("img");
  const altTexts: string[] = [];
  for (const img of Array.from(allImages)) {
    const alt = norm(img.getAttribute("alt") ?? "");
    if (alt) altTexts.push(alt);
  }

  const labelledByTexts: string[] = [];
  for (const el of Array.from(doc.querySelectorAll("[aria-labelledby]"))) {
    const t = resolveIdrefText(doc, el.getAttribute("aria-labelledby") ?? "");
    if (t) labelledByTexts.push(t);
  }
  const describedByTexts: string[] = [];
  for (const el of Array.from(doc.querySelectorAll("[aria-describedby]"))) {
    const t = resolveIdrefText(doc, el.getAttribute("aria-describedby") ?? "");
    if (t) describedByTexts.push(t);
  }

  const bodyText = doc.body?.textContent ?? "";
  const totalTextWordCount = bodyText.split(/\s+/).filter(Boolean).length;

  // Banner (<header>/[role=banner]) and contentinfo (<footer>/[role=contentinfo])
  // are intentionally excluded — the XR scene drops that page chrome, so it is
  // not counted as a landmark to be recovered.
  const landmarkElements = doc.querySelectorAll(
    'main, [role="main"], nav, [role="navigation"], ' +
      'aside, [role="complementary"], [role="search"], form[aria-label], [role="form"]',
  );

  return {
    headingCount: doc.querySelectorAll("h1,h2,h3,h4,h5,h6").length,
    navCount: doc.querySelectorAll('nav, [role="navigation"]').length,
    formInputCount: doc.querySelectorAll(
      'input:not([type="hidden"]):not([type="submit"]):not([type="button"]), select, textarea',
    ).length,
    imageWithAltCount: altTexts.length,
    totalImageCount: allImages.length,
    buttonCount: doc.querySelectorAll(
      'button, [role="button"], input[type="button"], input[type="submit"], input[type="reset"]',
    ).length,
    ariaLabelledByCount: doc.querySelectorAll("[aria-labelledby]").length,
    ariaDescribedByCount: doc.querySelectorAll("[aria-describedby]").length,
    ariaRoleExplicitCount: doc.querySelectorAll("[role]").length,
    totalTextWordCount,
    landmarkCount: landmarkElements.length,
    interactiveElementCount:
      doc.querySelectorAll(INTERACTIVE_DOM_SELECTOR).length,
    linkCount: allLinks.length,
    navLinkCount: allLinks.filter((a) => classifyLink(a) === "nav").length,
    inlineLinkCount: allLinks.filter((a) => classifyLink(a) === "inline").length,
    tableCellCount: doc.querySelectorAll("td, th").length,
    mediaCount: doc.querySelectorAll("video, audio").length,
    altTexts,
    labelledByTexts,
    describedByTexts,
  };
}

/** Fraction (0–100) of `domTexts` (as a set) that also appear in `irTexts`. */
function setCoverage(domTexts: string[], irTexts: Set<string>): number {
  const dom = new Set(domTexts);
  if (dom.size === 0) return 0;
  let covered = 0;
  for (const t of dom) if (irTexts.has(t)) covered++;
  return Math.round((covered / dom.size) * 100);
}

// ─────────────────────────────────────────────────────────────
// Per-backend derived metrics
// ─────────────────────────────────────────────────────────────


export function pct(numerator: number, denominator: number): number {
  if (denominator === 0) return 0;
  return Math.round((numerator / denominator) * 100);
}

export function deriveIRQuality(nodes: IRNode[], scene: XRPrimitive): IRQuality {
  if (nodes.length === 0) {
    return {
      labelingRate: 0,
      avgConfidence: 0,
      genericRatio: 0,
      nodesWithRelations: 0,
      maxDepth: 0,
      avgDepth: 0,
      parseConfidenceRate: 0,
      semanticNodeRatio: 0,
      contentToChromeRatio: 0,
    };
  }
  let labeledCount = 0;
  let confidenceSum = 0;
  let genericCount = 0;
  let inlineCount = 0;
  let withRelations = 0;
  let aboveThreshold = 0;
  let maxDepth = 0;
  let depthSum = 0;

  for (const n of nodes) {
    if (n.label !== null) labeledCount++;
    confidenceSum += n.confidence;
    if (n.source === "generic") genericCount++;
    if (n.source === "inline") inlineCount++;
    if (n.confidence >= CONFIDENCE_THRESHOLD) aboveThreshold++;
    const hasRelation = Object.values(n.relations).some(
      (arr) => arr.length > 0,
    );
    if (hasRelation) withRelations++;
    if (n.readingDepth > maxDepth) maxDepth = n.readingDepth;
    depthSum += n.readingDepth;
  }

  // Content nodes = paragraph, heading, code, blockquote, text
  // Chrome nodes = navigation, banner, footer/contentinfo
  const contentRoles = new Set([
    "paragraph",
    "heading",
    "code",
    "blockquote",
    "text",
    "article",
  ]);
  const chromeRoles = new Set(["navigation", "banner", "contentinfo"]);
  const contentCount = nodes.filter((n) => contentRoles.has(n.role)).length;
  const chromeCount = nodes.filter((n) => chromeRoles.has(n.role)).length;

  // Count distinct primitive types used in the scene
  const typeSeen = new Set<string>();
  function walkTypes(p: XRPrimitive) {
    typeSeen.add(p.type);
    for (const c of p.children) walkTypes(c);
  }
  walkTypes(scene);

  return {
    labelingRate: pct(labeledCount, nodes.length),
    avgConfidence: Math.round((confidenceSum / nodes.length) * 100) / 100,
    genericRatio: pct(genericCount, nodes.length),
    nodesWithRelations: withRelations,
    maxDepth,
    avgDepth: Math.round((depthSum / nodes.length) * 10) / 10,
    parseConfidenceRate: pct(aboveThreshold, nodes.length),
    semanticNodeRatio: pct(
      nodes.length - genericCount - inlineCount,
      nodes.length,
    ),
    contentToChromeRatio:
      chromeCount === 0
        ? contentCount
        : Math.round((contentCount / chromeCount) * 10) / 10,
  };
}

export function derivePrecisionRecall(
  analytics: IRAnalytics,
  primitiveBreakdown: PrimitiveBreakdown,
  gt: HTMLGroundTruth,
): PrecisionRecall {
  return {
    headingRecall: Math.min(
      100,
      pct(analytics.headingCount, Math.max(gt.headingCount, 1)),
    ),
    // Count only non-chrome landmark primitives (exclude XRBanner/XRFooter) so
    // both sides of the ratio ignore banner/contentinfo, consistent with gt.
    landmarkRecall: Math.min(
      100,
      pct(
        (primitiveBreakdown["XRContentPanel"] ?? 0) +
          (primitiveBreakdown["XRNavigationBar"] ?? 0) +
          (primitiveBreakdown["XRComplementary"] ?? 0) +
          (primitiveBreakdown["XRFormPanel"] ?? 0),
        Math.max(gt.landmarkCount, 1),
      ),
    ),
    // XRFormField is the direct XR equivalent of HTML form inputs — more accurate than
    // analytics.controlCount which includes all interactive roles (links, tabs, etc.)
    formInputRecall: Math.min(
      100,
      pct(
        primitiveBreakdown["XRFormField"] ?? 0,
        Math.max(gt.formInputCount, 1),
      ),
    ),
    imageRecall: Math.min(
      100,
      pct(
        primitiveBreakdown["XRImage"] ?? 0,
        Math.max(gt.imageWithAltCount, 1),
      ),
    ),
    navRecall: Math.min(
      100,
      pct(primitiveBreakdown["XRNavigationBar"] ?? 0, Math.max(gt.navCount, 1)),
    ),
  };
}

export function deriveAccessibility(
  nodes: IRNode[],
  gt: HTMLGroundTruth,
): AccessibilityPreservation {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const nodeText = (id: string): string => {
    const t = byId.get(id);
    return norm(t?.label ?? t?.content ?? "");
  };

  // What fraction of DOM aria-labelledby/describedby relation *texts* survive
  // into the IR? A content set intersection is ≤ its DOM denominator, so the
  // rate cannot exceed 100%. The parser may preserve the relationship either as
  // the node's own resolved `label` (it inlines aria-labelledby into the label)
  // OR as a live relation pointing at the target node — accept both so the
  // measure reflects true preservation regardless of representation.
  const irLabelledBy = new Set<string>();
  const irDescribedBy = new Set<string>();
  const irAlt = new Set<string>();
  for (const n of nodes) {
    if (n.relations.labelledBy.length > 0) {
      const own = norm(n.label ?? "");
      if (own) irLabelledBy.add(own);
      for (const id of n.relations.labelledBy) {
        const t = nodeText(id);
        if (t) irLabelledBy.add(t);
      }
    }
    if (n.relations.describedBy.length > 0) {
      const own = norm(n.label ?? "");
      if (own) irDescribedBy.add(own);
      for (const id of n.relations.describedBy) {
        const t = nodeText(id);
        if (t) irDescribedBy.add(t);
      }
    }
    if (n.role === "img") {
      const a = norm(n.attributes.alt ?? n.label ?? "");
      if (a) irAlt.add(a);
    }
  }

  const explicitSourceNodes = nodes.filter((n) => n.source === "explicit");
  const explicitNonGeneric = explicitSourceNodes.filter(
    (n) => n.role !== "generic",
  ).length;

  return {
    ariaLabelledByRate: setCoverage(gt.labelledByTexts, irLabelledBy),
    ariaDescribedByRate: setCoverage(gt.describedByTexts, irDescribedBy),
    explicitRoleHonorRate: pct(
      explicitNonGeneric,
      Math.max(explicitSourceNodes.length, 1),
    ),
    altTextCoverage: setCoverage(gt.altTexts, irAlt),
  };
}

// ─────────────────────────────────────────────────────────────
// Structure & interaction fidelity (new metric group)
// ─────────────────────────────────────────────────────────────

export function deriveStructuralFidelity(
  nodes: IRNode[],
  scene: SemanticScene,
  gt: HTMLGroundTruth,
  refRoot: Element,
): StructuralFidelity {
  // Single walk of the scene collecting every count we need. Some primitives
  // (e.g. XRNavigationBar) hold their links in an `items` array separate from
  // `children`, so traverse both — with a visited guard so nothing is counted
  // twice when the same object appears in both.
  let interactiveXR = 0;
  let controlsTotal = 0;
  let controlsLabelled = 0;
  let tableCells = 0;
  let mediaPlayers = 0;
  // Every href the scene preserved, whatever representation it used (a placed
  // XRLink primitive or an inline run). We match these back to DOM links by
  // href, so a link is scored in its DOM-context bucket regardless of how the
  // pipeline chose to represent it — no cross-classification overcount.
  const preservedHrefs = new Set<string>();
  const seen = new Set<string>();
  const walk = (p: XRPrimitive): void => {
    if (seen.has(p.id)) return;
    seen.add(p.id);
    if (INTERACTIVE_XR_TYPES.has(p.type)) {
      interactiveXR++;
      controlsTotal++;
      if ((p.label ?? p.content ?? "").trim() !== "") controlsLabelled++;
    }
    const href = (p as { href?: string | null }).href;
    if (p.type === "XRLink" && (href ?? "") !== "") preservedHrefs.add(href!.trim());
    if (p.type === "XRTableCell") tableCells++;
    if (p.type === "XRMediaPlayer") mediaPlayers++;
    for (const c of p.children) walk(c);
    const items = (p as { items?: XRPrimitive[] }).items;
    if (Array.isArray(items)) for (const it of items) walk(it);
  };
  walk(scene.root);
  for (const n of nodes) {
    for (const run of n.inlineRuns ?? []) {
      if (run.tag === "a" && (run.href ?? "") !== "") {
        preservedHrefs.add(run.href!.trim());
      }
    }
  }

  // DOM links split by context (same classifier the pipeline mirrors), keyed by
  // href so both numerator and denominator use one classification basis.
  const domNavHrefs = new Set<string>();
  const domInlineHrefs = new Set<string>();
  for (const a of Array.from(refRoot.querySelectorAll("a[href]"))) {
    const h = (a.getAttribute("href") ?? "").trim();
    if (!h) continue;
    (classifyLink(a) === "nav" ? domNavHrefs : domInlineHrefs).add(h);
  }
  const hrefCoverage = (dom: Set<string>): number => {
    if (dom.size === 0) return 100;
    let covered = 0;
    for (const h of dom) if (preservedHrefs.has(h)) covered++;
    return Math.round((covered / dom.size) * 100);
  };

  // Heading hierarchy validity (WCAG 1.3.1): reading-ordered heading levels
  // should not skip a level when descending (h2 → h4 is a violation).
  const headingLevels = nodes
    .filter((n) => n.role === "heading" && n.level != null)
    .sort((a, b) => a.readingIndex - b.readingIndex)
    .map((n) => n.level as number);
  let validTransitions = 0;
  for (let i = 1; i < headingLevels.length; i++) {
    if (headingLevels[i] - headingLevels[i - 1] <= 1) validTransitions++;
  }
  const headingHierarchyValidity =
    headingLevels.length < 2
      ? 100
      : Math.round((validTransitions / (headingLevels.length - 1)) * 100);

  const nonZeroRate = (num: number, denom: number): number =>
    denom === 0 ? 100 : Math.min(100, pct(num, denom));

  return {
    interactiveAffordanceRate: Math.min(
      100,
      pct(interactiveXR, Math.max(gt.interactiveElementCount, 1)),
    ),
    controlLabelCoverage:
      controlsTotal === 0
        ? 100
        : Math.round((controlsLabelled / controlsTotal) * 100),
    headingHierarchyValidity,
    // Two affordance-specific rates plus the combined rollup — all href
    // set-coverage, so each is ≤100% and uses one consistent classification.
    navLinkRetention: hrefCoverage(domNavHrefs),
    inlineLinkRetention: hrefCoverage(domInlineHrefs),
    linkRetention: hrefCoverage(new Set([...domNavHrefs, ...domInlineHrefs])),
    tablePreservation: nonZeroRate(tableCells, gt.tableCellCount),
    mediaPreservation: nonZeroRate(mediaPlayers, gt.mediaCount),
    readingOrderFidelity: deriveReadingOrderFidelity(scene, refRoot),
  };
}

/**
 * Reading-order fidelity: does the scene present content in the same order the
 * page does? We take the DOM document order of atomic content units and the
 * scene's `readingOrder`, align them by normalised text, and compute Kendall's
 * τ (rank agreement) over the shared units. Reported as ((τ+1)/2)·100 so 100 =
 * identical order, 50 = uncorrelated, 0 = fully reversed. 100 when < 2 units
 * align. Grounded in screen-reader/DOM reading-order accessibility.
 */
export function deriveReadingOrderFidelity(
  scene: SemanticScene,
  refRoot: Element,
): number {
  // DOM order: text → first document-order rank.
  const domRank = new Map<string, number>();
  extractAtomicUnits(refRoot).forEach((u, i) => {
    const t = norm(u.el.textContent ?? "");
    if (t && !domRank.has(t)) domRank.set(t, i);
  });

  // Scene order: text → first reading-order rank.
  const sceneRank = new Map<string, number>();
  scene.readingOrder.forEach((id, i) => {
    const p = scene.primitives[id];
    if (!p) return;
    const t = norm(p.content ?? p.label ?? (p as { text?: string }).text ?? "");
    if (t && !sceneRank.has(t)) sceneRank.set(t, i);
  });

  // Paired ranks over the shared texts.
  const pairs: Array<[number, number]> = [];
  for (const [t, dr] of domRank) {
    const sr = sceneRank.get(t);
    if (sr !== undefined) pairs.push([dr, sr]);
  }
  if (pairs.length < 2) return 100;

  let concordant = 0;
  let discordant = 0;
  for (let i = 0; i < pairs.length; i++) {
    for (let j = i + 1; j < pairs.length; j++) {
      const a = pairs[i];
      const b = pairs[j];
      const signDom = Math.sign(a[0] - b[0]);
      const signScene = Math.sign(a[1] - b[1]);
      const prod = signDom * signScene;
      if (prod > 0) concordant++;
      else if (prod < 0) discordant++;
    }
  }
  const total = concordant + discordant;
  if (total === 0) return 100;
  const tau = (concordant - discordant) / total; // [-1, 1]
  return Math.round(((tau + 1) / 2) * 100);
}

export function deriveInformationFidelity(
  analytics: IRAnalytics,
  irNodeCount: number,
  htmlSizeKb: number,
  gt: HTMLGroundTruth,
): InformationFidelity {
  return {
    textCoverage: Math.min(
      100,
      pct(analytics.wordCount, Math.max(gt.totalTextWordCount, 1)),
    ),
    // Use analytics.headingCount — the parser's own authoritative heading tally —
    // rather than re-filtering ir.nodes (where heading labels may be null if the
    // text-label layer was disabled, e.g. naive/baseline config).
    headingTextRetention: Math.min(
      100,
      pct(analytics.headingCount, Math.max(gt.headingCount, 1)),
    ),
    nodesPerKb:
      htmlSizeKb > 0 ? Math.round((irNodeCount / htmlSizeKb) * 10) / 10 : 0,
  };
}

export function deriveXRUsability(
  scene: XRPrimitive,
  primitiveBreakdown: PrimitiveBreakdown,
  analytics: IRAnalytics,
  totalPages: number,
): XRUsability {
  const hasContentPanel = (primitiveBreakdown["XRContentPanel"] ?? 0) > 0;
  const hasTOC = (primitiveBreakdown["XRNavigationBar"] ?? 0) > 0;
  const wordsPerPage =
    totalPages > 0
      ? Math.round(analytics.wordCount / totalPages)
      : analytics.wordCount;
  const sectionGranularity =
    analytics.landmarkCount > 0
      ? Math.round((analytics.sectionCount / analytics.landmarkCount) * 10) / 10
      : 0;

  const distinctTypes = new Set<string>();
  function walkTypes(p: XRPrimitive) {
    distinctTypes.add(p.type);
    for (const c of p.children) walkTypes(c);
  }
  walkTypes(scene);

  return {
    hasContentPanel,
    hasTOC,
    wordsPerPage,
    sectionGranularity,
    semanticDiversity: pct(distinctTypes.size, TOTAL_PRIMITIVE_TYPES),
  };
}

export function deriveComposite(
  pr: PrecisionRecall,
  quality: IRQuality,
  accessibility: AccessibilityPreservation,
  _fidelity: InformationFidelity,
): CompositeScore {
  // Weighted composite semantic richness:
  // - Heading recall (how well structure is captured): 20%
  // - Landmark recall (spatial frame correctness): 20%
  // - Labeling rate (content accessibility): 20%
  // - Semantic node ratio (non-generic content): 20%
  // - Accessibility preservation (aria-labelledby + explicit role honor): 20%
  const ariaScore =
    (accessibility.ariaLabelledByRate + accessibility.explicitRoleHonorRate) /
    2;
  const score =
    pr.headingRecall * 0.2 +
    pr.landmarkRecall * 0.2 +
    quality.labelingRate * 0.2 +
    quality.semanticNodeRatio * 0.2 +
    ariaScore * 0.2;

  return { semanticRichness: Math.round(score) };
}

// ─────────────────────────────────────────────────────────────
// Inline primitive types (rendered as text runs, not plan entries)
// ─────────────────────────────────────────────────────────────


export function countPrimitiveTypes(root: XRPrimitive): PrimitiveBreakdown {
  const counts: PrimitiveBreakdown = {};
  function walk(p: XRPrimitive) {
    counts[p.type] = (counts[p.type] ?? 0) + 1;
    for (const child of p.children) walk(child);
  }
  walk(root);
  return counts;
}

export function buildPrimitiveTypeIndex(root: XRPrimitive): Map<string, string> {
  const index = new Map<string, string>();
  function walk(p: XRPrimitive) {
    index.set(p.id, p.type);
    for (const child of p.children) walk(child);
  }
  walk(root);
  return index;
}

// ─────────────────────────────────────────────────────────────
// Runner
// ─────────────────────────────────────────────────────────────

