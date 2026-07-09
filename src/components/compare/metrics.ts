/**
 * compare/metrics.ts — pure derivations that turn IR + scene + HTML into the
 * comparison metrics. No React, no I/O.
 */
import type { IRNode, IRAnalytics } from "../../ir/types";
import type { XRPrimitive } from "../../mapper/types";
import { CONFIDENCE_THRESHOLD, TOTAL_PRIMITIVE_TYPES } from "./config";
import type {
  IRQuality,
  PrecisionRecall,
  AccessibilityPreservation,
  InformationFidelity,
  XRUsability,
  CompositeScore,
  PrimitiveBreakdown,
  HTMLGroundTruth,
} from "./types";

export function extractHTMLGroundTruth(html: string): HTMLGroundTruth {
  const doc = new DOMParser().parseFromString(html, "text/html");

  const allImages = doc.querySelectorAll("img");
  const imagesWithAlt = Array.from(allImages).filter(
    (img) => img.getAttribute("alt") && img.getAttribute("alt")!.trim() !== "",
  ).length;

  const bodyText = doc.body?.textContent ?? "";
  const totalTextWordCount = bodyText.split(/\s+/).filter(Boolean).length;

  const landmarkElements = doc.querySelectorAll(
    'main, [role="main"], nav, [role="navigation"], header, [role="banner"], ' +
      'footer, [role="contentinfo"], aside, [role="complementary"], [role="search"], form[aria-label], [role="form"]',
  );

  return {
    headingCount: doc.querySelectorAll("h1,h2,h3,h4,h5,h6").length,
    navCount: doc.querySelectorAll('nav, [role="navigation"]').length,
    formInputCount: doc.querySelectorAll(
      'input:not([type="hidden"]):not([type="submit"]):not([type="button"]), select, textarea',
    ).length,
    imageWithAltCount: imagesWithAlt,
    totalImageCount: allImages.length,
    buttonCount: doc.querySelectorAll(
      'button, [role="button"], input[type="button"], input[type="submit"], input[type="reset"]',
    ).length,
    ariaLabelledByCount: doc.querySelectorAll("[aria-labelledby]").length,
    ariaDescribedByCount: doc.querySelectorAll("[aria-describedby]").length,
    ariaRoleExplicitCount: doc.querySelectorAll("[role]").length,
    totalTextWordCount,
    landmarkCount: landmarkElements.length,
  };
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
    landmarkRecall: Math.min(
      100,
      pct(analytics.landmarkCount, Math.max(gt.landmarkCount, 1)),
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
  primitiveBreakdown: PrimitiveBreakdown,
): AccessibilityPreservation {
  const nodesWithLabelledBy = nodes.filter(
    (n) => n.relations.labelledBy.length > 0,
  ).length;
  const nodesWithDescribedBy = nodes.filter(
    (n) => n.relations.describedBy.length > 0,
  ).length;
  const explicitSourceNodes = nodes.filter((n) => n.source === "explicit");
  const explicitNonGeneric = explicitSourceNodes.filter(
    (n) => n.role !== "generic",
  ).length;

  return {
    ariaLabelledByRate: pct(nodesWithLabelledBy, gt.ariaLabelledByCount),
    ariaDescribedByRate: pct(nodesWithDescribedBy, gt.ariaDescribedByCount),
    explicitRoleHonorRate: pct(
      explicitNonGeneric,
      Math.max(explicitSourceNodes.length, 1),
    ),
    altTextCoverage: pct(
      primitiveBreakdown["XRImage"] ?? 0,
      Math.max(gt.imageWithAltCount, 1),
    ),
  };
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

