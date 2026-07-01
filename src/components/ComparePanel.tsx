import React, { useState, useCallback, useRef } from "react";
import { createPortal } from "react-dom";
import { parsePageToIR } from "../ir/parser";
import { parsePageWithVIPS } from "../ir/vips";
import { mapIRToScene, DEFAULT_MAPPER_CONFIG } from "../mapper/mapper";
import { computeLayoutPlan } from "../layout/engine";
import { DEFAULT_CONFIG } from "../ir/defaults";
import { applyParserBackend } from "../ir/backends";
import { QUEST_3_PROFILE } from "../layout/profiles";
import type { IRAnalytics, IRNode } from "../ir/types";
import type { XRPrimitive } from "../mapper/types";
import type { LayoutTemplate } from "../layout/types";

// ─────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────

interface StageTiming {
  parseMs: number;
  mapMs: number;
  layoutMs: number;
  totalMs: number;
}

interface IRQuality {
  labelingRate: number;
  avgConfidence: number;
  genericRatio: number;
  nodesWithRelations: number;
  maxDepth: number;
  avgDepth: number;
  parseConfidenceRate: number; // % nodes above confidence threshold 0.6
  semanticNodeRatio: number;  // % that are not generic/inline
  contentToChromeRatio: number; // content nodes / nav+banner+footer nodes
}

interface PrecisionRecall {
  headingRecall: number;       // IR headings / DOM h1-h6
  landmarkRecall: number;      // IR landmarks / DOM landmark elements
  formInputRecall: number;     // IR controls / DOM form inputs
  imageRecall: number;         // IR images / DOM images with alt
  navRecall: number;           // IR nav bars / DOM nav elements
}

interface AccessibilityPreservation {
  ariaLabelledByRate: number;  // IR nodes with resolved labelledBy / DOM [aria-labelledby]
  ariaDescribedByRate: number; // same for describedby
  explicitRoleHonorRate: number; // non-generic explicit-source nodes / all explicit-role nodes in DOM
  altTextCoverage: number;     // IR images labeled / DOM images with alt text
}

interface InformationFidelity {
  textCoverage: number;        // IR words / DOM words
  headingTextRetention: number; // IR heading labels present / DOM heading text nodes
  nodesPerKb: number;          // irNodeCount / htmlSizeKb
}

interface XRUsability {
  hasContentPanel: boolean;
  hasTOC: boolean;
  wordsPerPage: number;
  sectionGranularity: number;  // sections / landmarks
  semanticDiversity: number;   // distinct primitive types used / total available
}

interface CompositeScore {
  semanticRichness: number;    // 0–100 weighted composite
}

interface PrimitiveBreakdown {
  [type: string]: number;
}

interface HTMLGroundTruth {
  headingCount: number;
  navCount: number;
  formInputCount: number;
  imageWithAltCount: number;
  totalImageCount: number;
  buttonCount: number;
  ariaLabelledByCount: number;
  ariaDescribedByCount: number;
  ariaRoleExplicitCount: number;
  totalTextWordCount: number;
  landmarkCount: number;
}

interface BackendStats {
  label: string;
  timing: StageTiming;
  htmlSizeKb: number;
  irNodeCount: number;
  analytics: IRAnalytics;
  irQuality: IRQuality;
  precisionRecall: PrecisionRecall;
  accessibility: AccessibilityPreservation;
  fidelity: InformationFidelity;
  usability: XRUsability;
  composite: CompositeScore;
  sourceBreakdown: Record<string, number>;
  primitiveTypeBreakdown: PrimitiveBreakdown;
  primitiveCount: number;
  unplacedCount: number;
  paginatedPanels: number;
  totalPages: number;
  fallbackHeightCount: number;
  layoutTemplate: LayoutTemplate;
  error?: string;
}

// ─────────────────────────────────────────────────────────────
// HTML ground truth extraction
// ─────────────────────────────────────────────────────────────

function extractHTMLGroundTruth(html: string): HTMLGroundTruth {
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

const CONFIDENCE_THRESHOLD = 0.6;
const TOTAL_PRIMITIVE_TYPES = 30; // approximate number of distinct XRPrimitiveType values

function pct(numerator: number, denominator: number): number {
  if (denominator === 0) return 0;
  return Math.round((numerator / denominator) * 100);
}

function deriveIRQuality(nodes: IRNode[], scene: XRPrimitive): IRQuality {
  if (nodes.length === 0) {
    return {
      labelingRate: 0, avgConfidence: 0, genericRatio: 0,
      nodesWithRelations: 0, maxDepth: 0, avgDepth: 0,
      parseConfidenceRate: 0, semanticNodeRatio: 0, contentToChromeRatio: 0,
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
    const hasRelation = Object.values(n.relations).some((arr) => arr.length > 0);
    if (hasRelation) withRelations++;
    if (n.readingDepth > maxDepth) maxDepth = n.readingDepth;
    depthSum += n.readingDepth;
  }

  // Content nodes = paragraph, heading, code, blockquote, text
  // Chrome nodes = navigation, banner, footer/contentinfo
  const contentRoles = new Set(["paragraph", "heading", "code", "blockquote", "text", "article"]);
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
    semanticNodeRatio: pct(nodes.length - genericCount - inlineCount, nodes.length),
    contentToChromeRatio: chromeCount === 0 ? contentCount : Math.round((contentCount / chromeCount) * 10) / 10,
  };
}

function derivePrecisionRecall(
  analytics: IRAnalytics,
  primitiveBreakdown: PrimitiveBreakdown,
  gt: HTMLGroundTruth,
): PrecisionRecall {
  return {
    headingRecall: Math.min(100, pct(analytics.headingCount, Math.max(gt.headingCount, 1))),
    landmarkRecall: Math.min(100, pct(analytics.landmarkCount, Math.max(gt.landmarkCount, 1))),
    // XRFormField is the direct XR equivalent of HTML form inputs — more accurate than
    // analytics.controlCount which includes all interactive roles (links, tabs, etc.)
    formInputRecall: Math.min(100, pct(
      primitiveBreakdown["XRFormField"] ?? 0,
      Math.max(gt.formInputCount, 1),
    )),
    imageRecall: Math.min(100, pct(primitiveBreakdown["XRImage"] ?? 0, Math.max(gt.imageWithAltCount, 1))),
    navRecall: Math.min(100, pct(primitiveBreakdown["XRNavigationBar"] ?? 0, Math.max(gt.navCount, 1))),
  };
}

function deriveAccessibility(
  nodes: IRNode[],
  gt: HTMLGroundTruth,
  primitiveBreakdown: PrimitiveBreakdown,
): AccessibilityPreservation {
  const nodesWithLabelledBy = nodes.filter((n) => n.relations.labelledBy.length > 0).length;
  const nodesWithDescribedBy = nodes.filter((n) => n.relations.describedBy.length > 0).length;
  const explicitSourceNodes = nodes.filter((n) => n.source === "explicit");
  const explicitNonGeneric = explicitSourceNodes.filter((n) => n.role !== "generic").length;

  return {
    ariaLabelledByRate: pct(nodesWithLabelledBy, gt.ariaLabelledByCount),
    ariaDescribedByRate: pct(nodesWithDescribedBy, gt.ariaDescribedByCount),
    explicitRoleHonorRate: pct(explicitNonGeneric, Math.max(explicitSourceNodes.length, 1)),
    altTextCoverage: pct(primitiveBreakdown["XRImage"] ?? 0, Math.max(gt.imageWithAltCount, 1)),
  };
}

function deriveInformationFidelity(
  analytics: IRAnalytics,
  irNodeCount: number,
  htmlSizeKb: number,
  gt: HTMLGroundTruth,
): InformationFidelity {
  return {
    textCoverage: Math.min(100, pct(analytics.wordCount, Math.max(gt.totalTextWordCount, 1))),
    // Use analytics.headingCount — the parser's own authoritative heading tally —
    // rather than re-filtering ir.nodes (where heading labels may be null if the
    // text-label layer was disabled, e.g. naive/baseline config).
    headingTextRetention: Math.min(100, pct(analytics.headingCount, Math.max(gt.headingCount, 1))),
    nodesPerKb: htmlSizeKb > 0 ? Math.round((irNodeCount / htmlSizeKb) * 10) / 10 : 0,
  };
}

function deriveXRUsability(
  scene: XRPrimitive,
  primitiveBreakdown: PrimitiveBreakdown,
  analytics: IRAnalytics,
  totalPages: number,
): XRUsability {
  const hasContentPanel = (primitiveBreakdown["XRContentPanel"] ?? 0) > 0;
  const hasTOC = (primitiveBreakdown["XRNavigationBar"] ?? 0) > 0;
  const wordsPerPage = totalPages > 0 ? Math.round(analytics.wordCount / totalPages) : analytics.wordCount;
  const sectionGranularity = analytics.landmarkCount > 0
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

function deriveComposite(
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
  const ariaScore = (accessibility.ariaLabelledByRate + accessibility.explicitRoleHonorRate) / 2;
  const score =
    (pr.headingRecall * 0.20) +
    (pr.landmarkRecall * 0.20) +
    (quality.labelingRate * 0.20) +
    (quality.semanticNodeRatio * 0.20) +
    (ariaScore * 0.20);

  return { semanticRichness: Math.round(score) };
}

// ─────────────────────────────────────────────────────────────
// Inline primitive types (rendered as text runs, not plan entries)
// ─────────────────────────────────────────────────────────────

const INLINE_PRIMITIVE_TYPES = new Set(["XRText", "XRLink"]);

function countPrimitiveTypes(root: XRPrimitive): PrimitiveBreakdown {
  const counts: PrimitiveBreakdown = {};
  function walk(p: XRPrimitive) {
    counts[p.type] = (counts[p.type] ?? 0) + 1;
    for (const child of p.children) walk(child);
  }
  walk(root);
  return counts;
}

function buildPrimitiveTypeIndex(root: XRPrimitive): Map<string, string> {
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

const BACKENDS = [
  { id: "custom" as const,      label: "Custom (ARIA+Structural)" },
  { id: "readability" as const, label: "Readability" },
  { id: "naive" as const,       label: "Naive (Tags Only)" },
  { id: "vips" as const,        label: "VIPS" },
];

async function runBackend(
  backendId: "custom" | "readability" | "naive" | "vips",
  label: string,
  html: string,
  url: string,
  gt: HTMLGroundTruth,
): Promise<BackendStats> {
  const htmlSizeKb = Math.round((new Blob([html]).size / 1024) * 10) / 10;
  const t0 = performance.now();
  try {
    let ir;

    if (backendId === "vips") {
      ir = await parsePageWithVIPS(html, url);
    } else {
      const transform = applyParserBackend(html, backendId, {});
      const cfg = { ...DEFAULT_CONFIG, ...transform.configOverride };
      ir = await parsePageToIR(transform.html, url, undefined, cfg);
    }
    const parseMs = Math.round(performance.now() - t0);

    const mapT0 = performance.now();
    const scene = mapIRToScene(ir, DEFAULT_MAPPER_CONFIG);
    const mapMs = Math.round(performance.now() - mapT0);

    const layoutT0 = performance.now();
    const plan = computeLayoutPlan(scene, QUEST_3_PROFILE, undefined, {});
    const layoutMs = Math.round(performance.now() - layoutT0);

    const totalMs = Math.round(performance.now() - t0);

    const nodes = Object.values(ir.nodes);
    const sourceBreakdown: Record<string, number> = {};
    for (const n of nodes) {
      sourceBreakdown[n.source] = (sourceBreakdown[n.source] ?? 0) + 1;
    }

    const totalPages = plan.diagnostics.paginatedPanels.reduce(
      (sum, p) => sum + p.pageCount,
      0,
    );

    const typeIndex = buildPrimitiveTypeIndex(scene.root);
    const unplacedNonInline = plan.diagnostics.unplacedIds.filter(
      (id) => !INLINE_PRIMITIVE_TYPES.has(typeIndex.get(id) ?? ""),
    );

    const primitiveTypeBreakdown = countPrimitiveTypes(scene.root);
    const irQuality = deriveIRQuality(nodes, scene.root);
    const precisionRecall = derivePrecisionRecall(ir.analytics, primitiveTypeBreakdown, gt);
    const accessibility = deriveAccessibility(nodes, gt, primitiveTypeBreakdown);
    const fidelity = deriveInformationFidelity(ir.analytics, nodes.length, htmlSizeKb, gt);
    const usability = deriveXRUsability(scene.root, primitiveTypeBreakdown, ir.analytics, totalPages);
    const composite = deriveComposite(precisionRecall, irQuality, accessibility, fidelity);

    return {
      label,
      timing: { parseMs, mapMs, layoutMs, totalMs },
      htmlSizeKb,
      irNodeCount: nodes.length,
      analytics: ir.analytics,
      irQuality,
      precisionRecall,
      accessibility,
      fidelity,
      usability,
      composite,
      sourceBreakdown,
      primitiveTypeBreakdown,
      primitiveCount: plan.diagnostics.totalPlaced,
      unplacedCount: unplacedNonInline.length,
      paginatedPanels: plan.diagnostics.paginatedPanelCount,
      totalPages,
      fallbackHeightCount: plan.diagnostics.fallbackHeightIds.length,
      layoutTemplate: plan.template,
    };
  } catch (err) {
    const totalMs = Math.round(performance.now() - t0);
    const emptyAnalytics: IRAnalytics = {
      headingCount: 0, landmarkCount: 0, controlCount: 0, sectionCount: 0,
      textDensity: 0, wordCount: 0, textLength: 0, childCount: 0, liveRegionCount: 0,
    };
    const emptyQuality: IRQuality = {
      labelingRate: 0, avgConfidence: 0, genericRatio: 0, nodesWithRelations: 0,
      maxDepth: 0, avgDepth: 0, parseConfidenceRate: 0, semanticNodeRatio: 0, contentToChromeRatio: 0,
    };
    const emptyPR: PrecisionRecall = {
      headingRecall: 0, landmarkRecall: 0, formInputRecall: 0, imageRecall: 0, navRecall: 0,
    };
    const emptyA11y: AccessibilityPreservation = {
      ariaLabelledByRate: 0, ariaDescribedByRate: 0, explicitRoleHonorRate: 0, altTextCoverage: 0,
    };
    const emptyFidelity: InformationFidelity = {
      textCoverage: 0, headingTextRetention: 0, nodesPerKb: 0,
    };
    const emptyUsability: XRUsability = {
      hasContentPanel: false, hasTOC: false, wordsPerPage: 0, sectionGranularity: 0, semanticDiversity: 0,
    };
    return {
      label,
      timing: { parseMs: 0, mapMs: 0, layoutMs: 0, totalMs },
      htmlSizeKb,
      irNodeCount: 0,
      analytics: emptyAnalytics,
      irQuality: emptyQuality,
      precisionRecall: emptyPR,
      accessibility: emptyA11y,
      fidelity: emptyFidelity,
      usability: emptyUsability,
      composite: { semanticRichness: 0 },
      sourceBreakdown: {},
      primitiveTypeBreakdown: {},
      primitiveCount: 0,
      unplacedCount: 0,
      paginatedPanels: 0,
      totalPages: 0,
      fallbackHeightCount: 0,
      layoutTemplate: "generic",
      error: err instanceof Error ? err.message : "Unknown error",
    };
  }
}

// ─────────────────────────────────────────────────────────────
// Metric descriptions
// ─────────────────────────────────────────────────────────────

const METRIC_DESCRIPTIONS: Record<string, string> = {
  // Performance
  "Total pipeline": "Wall-clock time from raw HTML to a completed LayoutPlan, covering all three stages: IR parsing, semantic mapping, and 3D layout. Measured with performance.now() in the browser. Excludes network fetch and font loading.",
  "IR parse": "Time for Stage 1 — converting raw HTML into the Intermediate Representation. Covers DOM traversal, ARIA role resolution, structural inference (heading-bounded sections, link-run navigation, paragraph-run articles), and wrapper-piercing.",
  "Mapper": "Time for Stage 2 — translating each IR node's role into a typed XR primitive (e.g. heading → XRHeading, nav → XRNavigationBar). No spatial positions are assigned here; only semantic facts are extracted.",
  "Layout engine": "Time for Stage 3 — assigning 3D positions, sizes, and pagination to every primitive. Includes template selection, landmark slot placement, content-panel stacking, and per-panel overflow pagination.",
  "HTML input size": "Size of the raw HTML source in kilobytes. Identical across all backends since they all receive the same document. Provides context for interpreting parse times and extraction efficiency.",

  // IR Structure
  "IR nodes total": "Total number of nodes in the Intermediate Representation after parsing. Includes all roles — landmarks, headings, paragraphs, inlines, and generics. Higher counts indicate finer-grained extraction or more wrapper-heavy source HTML.",
  "Landmarks": "ARIA landmark regions detected: main, nav, banner, contentinfo (footer), aside (complementary), search, form. Each landmark becomes a top-level spatial panel in the XR scene.",
  "Headings": "Elements resolved with the heading role (h1–h6 or explicit role=heading). Used to infer document hierarchy and section boundaries in Stage 1 structural inference.",
  "Sections (regions)": "Implicit or explicit sections inferred from heading-bounded content groups or ARIA region roles. Each maps to an XRSection primitive — a navigable card in Cards view.",
  "Interactive controls": "Nodes with interactive ARIA roles: button, textbox, checkbox, radio, combobox, slider, etc. Maps to form and control primitives in XR. High counts drive the form layout template selection.",
  "Word count": "Total words across all resolved node labels. Indicates how much textual content was successfully extracted and will be readable in the XR scene.",
  "Text length (chars)": "Total character count across all node labels. Combined with node count to compute text density.",
  "Text density (chars/node)": "Average label length per IR node. High values indicate nodes carry rich text content; low values suggest many structural or wrapper nodes.",
  "Live regions": "Nodes carrying aria-live attributes (status, alert, log). In XR these map to XRAlert primitives. Indicates pages with dynamic, real-time content regions.",

  // Semantic Precision & Recall
  "Heading recall": "IR headings extracted ÷ actual h1–h6 elements in the raw HTML DOM, as a percentage. A score of 100% means every HTML heading was recognised. Lower scores indicate the parser missed heading structure.",
  "Landmark recall": "IR landmarks extracted ÷ actual landmark elements in the raw HTML DOM (main, nav, header, footer, aside plus role= equivalents). Measures how completely the page's spatial frame was captured.",
  "Form input recall": "IR interactive controls extracted ÷ actual form inputs + buttons in the raw HTML. Indicates how well the parser captured interactive affordances.",
  "Image recall": "IR image primitives with labels ÷ images with non-empty alt text in the raw HTML. Measures how well alt-text-bearing images were surfaced for the XR scene.",
  "Nav region recall": "XRNavigationBar primitives ÷ actual nav / role=navigation elements in the raw HTML. A score of 100% means every navigation region was detected and mapped to a spatial nav panel.",

  // Accessibility preservation
  "aria-labelledby preserved": "IR nodes with a resolved aria-labelledby relationship ÷ total [aria-labelledby] elements in the raw HTML. Measures how faithfully the parser preserved ARIA labelling cross-references.",
  "aria-describedby preserved": "IR nodes with a resolved aria-describedby relationship ÷ total [aria-describedby] elements in the raw HTML. Describes how well supplemental descriptions were retained.",
  "Explicit role honor rate": "Explicit-source IR nodes with a non-generic role ÷ total explicit-source nodes. Measures the fraction of author-declared ARIA roles that were successfully classified into a typed XR primitive (not left as XRGenericPanel).",
  "Alt text coverage": "XRImage primitives with a resolved label ÷ total images with non-empty alt text in the raw HTML. Indicates how much visual content information is preserved for the XR scene.",

  // Information Fidelity
  "Text coverage": "IR word count ÷ full DOM word count of the raw HTML, as a percentage. 100% would mean every word in the page is represented in the IR. Values below 100% indicate text that was filtered, skipped, or lost during parsing.",
  "Heading text retention": "IR heading nodes with resolved labels ÷ actual heading elements in the raw HTML. A proxy for structural text fidelity — heading text drives section navigation in XR.",
  "Nodes per KB": "IR node count ÷ HTML input size in KB. Measures extraction density — how many semantic nodes were produced per kilobyte of source HTML. Higher values indicate more efficient semantic extraction from the same input.",

  // IR Quality
  "Labeling rate": "Percentage of IR nodes that have a non-null resolved label. Labels come from aria-label, aria-labelledby, <label for>, alt text, or text content. Higher rates mean more content is surfaced for XR display.",
  "Avg node confidence": "Mean classification confidence across all IR nodes (0–1). Confidence is assigned per source: explicit ARIA = 1.0, structural = 0.8, generic = 0.3. Higher averages indicate stronger overall evidence for role assignments.",
  "Parse confidence rate": "Percentage of IR nodes with confidence ≥ 0.6 (the default AI fallback threshold). Nodes below this threshold are candidates for AI-assisted reclassification. Higher rates indicate the parser resolved more nodes confidently from structure alone.",
  "Semantic node ratio": "Percentage of IR nodes that are neither generic (unclassified) nor inline (text runs). Represents the proportion of nodes that carry a meaningful typed role and will become a distinct spatial primitive in XR.",
  "Generic node ratio": "Percentage of IR nodes whose source is 'generic' — no semantic role could be inferred. High ratios indicate heavy reliance on unsemantic markup (div-soup). Generic nodes become transparent XRGenericPanel wrappers.",
  "Content-to-chrome ratio": "Content nodes (paragraph, heading, article, code, blockquote) ÷ chrome nodes (navigation, banner, footer). Higher values indicate the parser surfaced more readable content relative to page furniture.",
  "Nodes with ARIA relations": "Count of nodes carrying at least one ARIA relationship: aria-controls, aria-labelledby, aria-describedby, aria-owns, aria-flowto. Indicates richness of cross-element relationships preserved in the IR.",
  "Max semantic depth": "Deepest nesting level in the semantic containment tree. Top-level landmarks are depth 0; each nested section, article, list, or region adds 1. Affects Z-axis layering of nested panels in XR.",
  "Avg semantic depth": "Mean readingDepth across all IR nodes. Values near 0 indicate flat landmark-only structures; values above 2–3 indicate deeply nested content hierarchies.",

  // Source Breakdown
  "explicit": "Nodes classified from an explicit role= ARIA attribute on the element. The highest-confidence source — the author directly declared semantic intent.",
  "structural": "Nodes inferred from HTML structural patterns: heading-bounded implicit sections, consecutive <a> runs → navigation, consecutive <p> runs → article body, repeated identical subtrees → list.",
  "ai": "Nodes that fell through layers 1 and 2 and were sent to the AI-assisted fallback classifier. Only active when useAIFallback=true and a provider is configured (stubbed in this build).",
  "ai-timeout": "Nodes sent to the AI provider that timed out and fell back to 'generic'. Indicates AI fallback latency issues.",
  "inline": "Inline text and link runs within block elements (XRText, XRLink, XRButton). Rendered as flowing text inside their parent mesh — not given standalone plan entries.",
  "generic": "Nodes that could not be classified by any layer. Rendered as XRGenericPanel — a transparent spatial wrapper whose children are dispatched at their panel-absolute positions.",

  // XR Primitive Types
  "XRContentPanel": "The main scrollable content surface. Receives all body text, sections, and articles. Paginated when content height exceeds the device viewport. One per scene is expected.",
  "XRSection": "A heading-delimited section within the content panel. Maps from ARIA region or structurally inferred content groups. Each becomes a navigable card in Cards view.",
  "XRArticle": "An article-level content block. Similar to XRSection but mapped from <article> or ARIA article role. Typically represents self-contained editorial content.",
  "XRNavigationBar": "A navigation landmark panel containing links. Rendered adjacent to the main content panel. If it mirrors section headings, it doubles as an in-scene table-of-contents.",
  "XRHeading": "A heading element (h1–h6). Rendered with typographic prominence scaled to heading level.",
  "XRParagraph": "A paragraph or block of prose text. The most common content primitive. Uses troika-three-text for GPU-rendered text.",
  "XRListItem": "An individual list item. Can contain inline prose (text row) or nested block content (sibling primitives).",
  "XRImage": "A resolved image node with an alt-text label. Rendered as a labelled plane in XR. Images without alt text are suppressed.",
  "XRTable": "A tabular data structure. Layout strategy (flat-2d, curved-2d, scrollable, cards) is selected by the engine based on column count.",
  "XRFormField": "An individual form control (input, select, textarea) with its resolved label. Grouped inside an XRFormPanel landmark.",
  "XRButton": "A standalone button or call-to-action element. Rendered as an interactive rounded-box primitive.",
  "XRCodeBlock": "A preformatted code block (<pre>/<code>). Rendered with monospace text in a distinct panel.",
  "XRGenericPanel": "A transparent spatial wrapper for content that couldn't be more specifically typed. Its children are dispatched at their panel-absolute positions.",

  // XR Layout & Usability
  "Layout template": "Scene archetype auto-selected by the layout engine based on landmark counts, control density, and content volume. Determines spatial slot arrangement. Options: document, dashboard, form, landing, generic, carousel, cards, door, theatre.",
  "Primitives placed": "Total primitives assigned a valid 3D LayoutEntry — position, size, and rotation. The count of spatially realised nodes the renderer will draw.",
  "Paginated panels": "Number of content containers split across multiple virtual pages because their stacked children exceeded the panel viewport height.",
  "Total pages": "Sum of page counts across all paginated panels. Total number of virtual screens the user must navigate to read the entire page.",
  "Unplaced primitives": "Primitives in the semantic scene but not assigned a LayoutEntry. Inline XRText/XRLink are excluded (they render as text runs). Remaining unplaced primitives indicate layout engine coverage gaps.",
  "Fallback height estimates": "Primitives whose height could not be computed from font metrics and used a fixed floor value. Inaccurate heights degrade pagination — content may overflow or leave whitespace. Lower is better.",

  // XR Usability
  "Content panel present": "Whether a main XRContentPanel was detected and placed. This is the primary reading surface in the XR scene; its absence means the page's main content has no spatial container.",
  "TOC / nav available": "Whether at least one XRNavigationBar was detected. Enables in-scene section navigation and landmark jumping — a key usability feature for long-form XR documents.",
  "Words per page": "Average word count per virtual XR page (total words ÷ total pages). Higher values mean denser pages; lower values suggest over-paginated or sparse content. Useful for estimating reading time per page transition.",
  "Section granularity": "Sections per landmark (sectionCount ÷ landmarkCount). Higher values indicate richer hierarchical subdivision within each landmark — more navigable structure inside the main content panel.",
  "Semantic diversity": "Percentage of available XR primitive types that were actually instantiated (distinct types used ÷ 30 total). Higher values indicate the parser captured a broader range of semantic structures — headings, lists, tables, forms, code, media, alerts, etc.",

  // Composite
  "Semantic richness score": "Weighted composite (0–100) combining five dimensions equally: heading recall (structural capture), landmark recall (spatial frame), labeling rate (content accessibility), semantic node ratio (classification coverage), and accessibility preservation (ARIA fidelity). A single number summarising how semantically complete the XR representation is relative to the source HTML.",
};

// ─────────────────────────────────────────────────────────────
// Markdown export
// ─────────────────────────────────────────────────────────────

function buildMarkdownTable(stats: BackendStats[], gt: HTMLGroundTruth): string {
  const headers = ["Metric", ...stats.map((s) => s.label)];
  const sep = headers.map(() => "---");
  const row = (label: string, vals: (string | number)[]) =>
    [label, ...vals.map(String)].join(" | ");

  return [
    row(headers[0], headers.slice(1)),
    row(sep[0], sep.slice(1)),
    "**Composite Score** | " + stats.map(() => "").join(" | "),
    row("Semantic richness score (/100)", stats.map((s) => s.composite.semanticRichness)),
    `HTML ground truth — headings: ${gt.headingCount}, landmarks: ${gt.landmarkCount}, words: ${gt.totalTextWordCount} | | | | `,
    "**Performance** | " + stats.map(() => "").join(" | "),
    row("Total pipeline (ms)", stats.map((s) => s.timing.totalMs)),
    row("  IR parse (ms)", stats.map((s) => s.timing.parseMs)),
    row("  Mapper (ms)", stats.map((s) => s.timing.mapMs)),
    row("  Layout engine (ms)", stats.map((s) => s.timing.layoutMs)),
    row("HTML input size (KB)", stats.map((s) => s.htmlSizeKb)),
    "**Semantic Precision & Recall vs HTML** | " + stats.map(() => "").join(" | "),
    row("Heading recall (%)", stats.map((s) => s.precisionRecall.headingRecall)),
    row("Landmark recall (%)", stats.map((s) => s.precisionRecall.landmarkRecall)),
    row("Nav region recall (%)", stats.map((s) => s.precisionRecall.navRecall)),
    row("Form input recall (%)", stats.map((s) => s.precisionRecall.formInputRecall)),
    row("Image recall (%)", stats.map((s) => s.precisionRecall.imageRecall)),
    "**Accessibility Preservation** | " + stats.map(() => "").join(" | "),
    row("aria-labelledby preserved (%)", stats.map((s) => s.accessibility.ariaLabelledByRate)),
    row("aria-describedby preserved (%)", stats.map((s) => s.accessibility.ariaDescribedByRate)),
    row("Explicit role honor rate (%)", stats.map((s) => s.accessibility.explicitRoleHonorRate)),
    row("Alt text coverage (%)", stats.map((s) => s.accessibility.altTextCoverage)),
    "**Information Fidelity** | " + stats.map(() => "").join(" | "),
    row("Text coverage (%)", stats.map((s) => s.fidelity.textCoverage)),
    row("Heading text retention (%)", stats.map((s) => s.fidelity.headingTextRetention)),
    row("Nodes per KB", stats.map((s) => s.fidelity.nodesPerKb)),
    "**IR Structure** | " + stats.map(() => "").join(" | "),
    row("IR nodes total", stats.map((s) => s.irNodeCount)),
    row("Landmarks", stats.map((s) => s.analytics.landmarkCount)),
    row("Headings", stats.map((s) => s.analytics.headingCount)),
    row("Sections (regions)", stats.map((s) => s.analytics.sectionCount)),
    row("Interactive controls", stats.map((s) => s.analytics.controlCount)),
    row("Word count", stats.map((s) => s.analytics.wordCount)),
    row("Text density (chars/node)", stats.map((s) => Math.round(s.analytics.textDensity))),
    "**IR Semantic Quality** | " + stats.map(() => "").join(" | "),
    row("Semantic richness score (/100)", stats.map((s) => s.composite.semanticRichness)),
    row("Labeling rate (%)", stats.map((s) => s.irQuality.labelingRate)),
    row("Parse confidence rate (%)", stats.map((s) => s.irQuality.parseConfidenceRate)),
    row("Avg node confidence", stats.map((s) => s.irQuality.avgConfidence)),
    row("Semantic node ratio (%)", stats.map((s) => s.irQuality.semanticNodeRatio)),
    row("Generic node ratio (%)", stats.map((s) => s.irQuality.genericRatio)),
    row("Content-to-chrome ratio", stats.map((s) => s.irQuality.contentToChromeRatio)),
    row("Max semantic depth", stats.map((s) => s.irQuality.maxDepth)),
    row("Avg semantic depth", stats.map((s) => s.irQuality.avgDepth)),
    "**Node Source Breakdown** | " + stats.map(() => "").join(" | "),
    row("Explicit ARIA", stats.map((s) => s.sourceBreakdown["explicit"] ?? 0)),
    row("Structural inference", stats.map((s) => s.sourceBreakdown["structural"] ?? 0)),
    row("AI fallback", stats.map((s) => s.sourceBreakdown["ai"] ?? 0)),
    row("Inline", stats.map((s) => s.sourceBreakdown["inline"] ?? 0)),
    row("Generic (unclassified)", stats.map((s) => s.sourceBreakdown["generic"] ?? 0)),
    "**XR Usability** | " + stats.map(() => "").join(" | "),
    row("Content panel present", stats.map((s) => s.usability.hasContentPanel ? "yes" : "no")),
    row("TOC / nav available", stats.map((s) => s.usability.hasTOC ? "yes" : "no")),
    row("Words per page", stats.map((s) => s.usability.wordsPerPage)),
    row("Section granularity", stats.map((s) => s.usability.sectionGranularity)),
    row("Semantic diversity (%)", stats.map((s) => s.usability.semanticDiversity)),
    "**XR Layout Output** | " + stats.map(() => "").join(" | "),
    row("Layout template", stats.map((s) => s.layoutTemplate)),
    row("Primitives placed", stats.map((s) => s.primitiveCount)),
    row("Paginated panels", stats.map((s) => s.paginatedPanels)),
    row("Total pages", stats.map((s) => s.totalPages)),
    row("Unplaced primitives", stats.map((s) => s.unplacedCount)),
    row("Fallback height estimates", stats.map((s) => s.fallbackHeightCount)),
  ].join("\n");
}

// ─────────────────────────────────────────────────────────────
// Tooltip (portal-based to avoid table overflow clipping)
// ─────────────────────────────────────────────────────────────

function Tooltip({ text }: { text: string }) {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const iconRef = useRef<HTMLSpanElement>(null);

  const show = useCallback(() => {
    if (iconRef.current) {
      const r = iconRef.current.getBoundingClientRect();
      setPos({ x: r.left + r.width / 2, y: r.top });
    }
  }, []);

  const hide = useCallback(() => setPos(null), []);

  return (
    <>
      <span
        ref={iconRef}
        onMouseEnter={show}
        onMouseLeave={hide}
        style={{ color: "#2a4a6a", fontSize: 10, marginLeft: 5, cursor: "default", userSelect: "none" }}
      >
        ⓘ
      </span>
      {pos &&
        createPortal(
          <div
            style={{
              position: "fixed",
              left: pos.x,
              top: pos.y - 8,
              transform: "translate(-50%, -100%)",
              background: "rgba(6,12,22,0.97)",
              border: "1px solid rgba(88,166,255,0.22)",
              borderRadius: 7,
              padding: "9px 12px",
              fontSize: 11,
              color: "#8aaac8",
              lineHeight: 1.6,
              width: 290,
              zIndex: 999999,
              pointerEvents: "none",
              boxShadow: "0 10px 40px rgba(0,0,0,0.7)",
              whiteSpace: "normal",
            }}
          >
            {text}
          </div>,
          document.body,
        )}
    </>
  );
}

// ─────────────────────────────────────────────────────────────
// Table sub-components
// ─────────────────────────────────────────────────────────────

function SectionHeader({ label, colCount }: { label: string; colCount: number }) {
  return (
    <tr>
      <td
        colSpan={colCount + 1}
        style={{
          padding: "10px 10px 4px",
          color: "#2a4a6a",
          fontSize: 10,
          fontWeight: 700,
          textTransform: "uppercase",
          letterSpacing: "0.1em",
          borderTop: "1px solid rgba(30,45,61,0.6)",
        }}
      >
        {label}
      </td>
    </tr>
  );
}

function Cell({ value, best, worst, dim }: {
  value: string | number;
  best?: boolean;
  worst?: boolean;
  dim?: boolean;
}) {
  return (
    <td
      style={{
        padding: "4px 10px",
        textAlign: "right",
        fontFamily: "monospace",
        fontSize: 12,
        color: dim ? "#3a5a7a" : best ? "#4ec966" : worst ? "#f6a623" : "#c8d8e8",
        background: best ? "rgba(78,201,102,0.06)" : worst ? "rgba(246,166,35,0.06)" : "transparent",
        borderBottom: "1px solid rgba(20,30,40,0.7)",
      }}
    >
      {typeof value === "number" ? value.toLocaleString() : value}
    </td>
  );
}

function Row({
  label,
  values,
  bestIsLow,
  suffix = "",
  dim,
  indent,
}: {
  label: string;
  values: (number | string)[];
  bestIsLow?: boolean;
  suffix?: string;
  dim?: boolean;
  indent?: boolean;
}) {
  const nums = values.filter((v): v is number => typeof v === "number");
  const allSame = nums.length > 1 && nums.every((n) => n === nums[0]);
  const best = !allSame && nums.length > 0 ? (bestIsLow ? Math.min(...nums) : Math.max(...nums)) : null;
  const worst = !allSame && nums.length > 1 ? (bestIsLow ? Math.max(...nums) : Math.min(...nums)) : null;
  const tooltipText = METRIC_DESCRIPTIONS[label];

  return (
    <tr>
      <td
        style={{
          padding: "4px 10px",
          fontSize: 12,
          color: dim ? "#3a5a7a" : "#8a9aaa",
          whiteSpace: "nowrap",
          borderBottom: "1px solid rgba(20,30,40,0.7)",
          paddingLeft: indent ? 22 : 10,
        }}
      >
        {label}
        {tooltipText && <Tooltip text={tooltipText} />}
      </td>
      {values.map((v, i) => (
        <Cell
          key={i}
          value={typeof v === "number" ? v + suffix : v}
          best={typeof v === "number" && v === best}
          worst={typeof v === "number" && v === worst && worst !== best}
          dim={dim}
        />
      ))}
    </tr>
  );
}

const KEY_PRIMITIVE_TYPES = [
  "XRContentPanel", "XRSection", "XRArticle", "XRNavigationBar",
  "XRHeading", "XRParagraph", "XRListItem", "XRImage", "XRTable",
  "XRFormField", "XRButton", "XRCodeBlock", "XRGenericPanel",
];

// A row that shows a boolean as yes/no, coloured green/red
function BoolRow({ label, values }: { label: string; values: boolean[] }) {
  const tooltipText = METRIC_DESCRIPTIONS[label];
  const allTrue = values.every(Boolean);
  const allFalse = values.every((v) => !v);
  return (
    <tr>
      <td style={{ padding: "4px 10px", fontSize: 12, color: "#8a9aaa", whiteSpace: "nowrap", borderBottom: "1px solid rgba(20,30,40,0.7)" }}>
        {label}
        {tooltipText && <Tooltip text={tooltipText} />}
      </td>
      {values.map((v, i) => (
        <td key={i} style={{
          padding: "4px 10px",
          textAlign: "right",
          fontFamily: "monospace",
          fontSize: 12,
          color: v ? "#4ec966" : "#f6a623",
          background: allTrue || allFalse ? "transparent" : v ? "rgba(78,201,102,0.06)" : "rgba(246,166,35,0.06)",
          borderBottom: "1px solid rgba(20,30,40,0.7)",
        }}>
          {v ? "yes" : "no"}
        </td>
      ))}
    </tr>
  );
}

// Ground truth reference bar shown above the table
function GroundTruthBar({ gt }: { gt: HTMLGroundTruth }) {
  const items = [
    { label: "headings", value: gt.headingCount },
    { label: "landmarks", value: gt.landmarkCount },
    { label: "nav regions", value: gt.navCount },
    { label: "form inputs", value: gt.formInputCount },
    { label: "images w/ alt", value: gt.imageWithAltCount },
    { label: "aria-labelledby", value: gt.ariaLabelledByCount },
    { label: "DOM words", value: gt.totalTextWordCount.toLocaleString() },
  ];
  return (
    <div style={{
      display: "flex",
      gap: 16,
      flexWrap: "wrap",
      padding: "8px 10px",
      marginBottom: 10,
      background: "rgba(20,35,55,0.4)",
      borderRadius: 6,
      border: "1px solid rgba(30,45,61,0.5)",
    }}>
      <span style={{ fontSize: 10, color: "#2a4a6a", textTransform: "uppercase", letterSpacing: "0.08em", alignSelf: "center", whiteSpace: "nowrap" }}>
        HTML ground truth
      </span>
      {items.map(({ label, value }) => (
        <span key={label} style={{ fontSize: 11, color: "#4a6a8a", fontFamily: "monospace" }}>
          <span style={{ color: "#58a6ff" }}>{value}</span>
          <span style={{ color: "#2a4a6a", marginLeft: 3 }}>{label}</span>
        </span>
      ))}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Main component
// ─────────────────────────────────────────────────────────────

export function ComparePanel({ html, url, onClose }: {
  html: string;
  url: string;
  onClose: () => void;
}) {
  const [stats, setStats] = useState<BackendStats[] | null>(null);
  const [gt, setGt] = useState<HTMLGroundTruth | null>(null);
  const [running, setRunning] = useState(false);
  const [copied, setCopied] = useState(false);

  const runAll = useCallback(async () => {
    setRunning(true);
    setStats(null);
    const groundTruth = extractHTMLGroundTruth(html);
    setGt(groundTruth);
    const results = await Promise.all(
      BACKENDS.map((b) => runBackend(b.id, b.label, html, url, groundTruth)),
    );
    setStats(results);
    setRunning(false);
  }, [html, url]);

  React.useEffect(() => { runAll(); }, [runAll]);

  const copyMarkdown = useCallback(() => {
    if (!stats || !gt) return;
    navigator.clipboard.writeText(buildMarkdownTable(stats, gt)).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [stats, gt]);

  return (
    <div style={{
      position: "fixed", top: "50%", left: "50%",
      transform: "translate(-50%, -50%)",
      width: "min(1020px, 96vw)", maxHeight: "90vh", overflowY: "auto",
      background: "rgba(6,10,18,0.98)",
      border: "1px solid rgba(88,166,255,0.18)",
      borderRadius: 12,
      boxShadow: "0 24px 80px rgba(0,0,0,0.8)",
      backdropFilter: "blur(24px)", WebkitBackdropFilter: "blur(24px)",
      zIndex: 99999,
      fontFamily: "system-ui, -apple-system, sans-serif",
    }}>
      {/* Sticky header */}
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "13px 18px",
        borderBottom: "1px solid rgba(30,45,61,0.6)",
        position: "sticky", top: 0,
        background: "rgba(6,10,18,0.98)", zIndex: 1,
      }}>
        <div>
          <span style={{ color: "#58a6ff", fontWeight: 600, fontSize: 14 }}>Parser Comparison</span>
          <span style={{ color: "#2a4a6a", fontSize: 11, marginLeft: 12, fontFamily: "monospace" }}>
            {url.length > 55 ? url.slice(0, 53) + "…" : url}
          </span>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {stats && (
            <button onClick={copyMarkdown} style={{
              background: copied ? "rgba(78,201,102,0.12)" : "rgba(30,45,61,0.5)",
              border: `1px solid ${copied ? "rgba(78,201,102,0.4)" : "rgba(30,45,61,0.6)"}`,
              borderRadius: 6, color: copied ? "#4ec966" : "#7a8a9a",
              fontSize: 12, padding: "4px 12px", cursor: "pointer", fontFamily: "monospace",
            }}>
              {copied ? "✓ Copied!" : "Copy as Markdown"}
            </button>
          )}
          <button onClick={runAll} disabled={running} style={{
            background: "rgba(88,166,255,0.10)", border: "1px solid rgba(88,166,255,0.22)",
            borderRadius: 6, color: "#58a6ff", fontSize: 12, padding: "4px 12px",
            cursor: running ? "default" : "pointer", opacity: running ? 0.5 : 1,
          }}>
            {running ? "Running…" : "Re-run"}
          </button>
          <button onClick={onClose} style={{
            background: "none", border: "none", color: "#3a4a5a",
            fontSize: 18, cursor: "pointer", lineHeight: 1, padding: "0 4px",
          }}>✕</button>
        </div>
      </div>

      <div style={{ padding: "12px 18px 24px" }}>
        {running && (
          <div style={{ color: "#58a6ff", fontSize: 13, textAlign: "center", padding: "40px 0" }}>
            <div style={{ marginBottom: 10 }}>Running all backends in parallel…</div>
            <div style={{ fontSize: 11, color: "#2a4a6a", fontFamily: "monospace" }}>
              Custom · Readability · Naive · VIPS
            </div>
          </div>
        )}

        {stats && gt && (
          <>
            <GroundTruthBar gt={gt} />

            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  <th style={{ textAlign: "left", padding: "5px 10px", color: "#2a4060", fontSize: 10, fontWeight: 600, borderBottom: "2px solid rgba(30,45,61,0.8)", textTransform: "uppercase", letterSpacing: "0.06em" }}>
                    Metric
                  </th>
                  {stats.map((s) => (
                    <th key={s.label} style={{ textAlign: "right", padding: "5px 10px", color: "#58a6ff", fontSize: 11, fontWeight: 600, borderBottom: "2px solid rgba(30,45,61,0.8)", whiteSpace: "nowrap" }}>
                      {s.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {/* Composite */}
                <SectionHeader label="Composite Score" colCount={stats.length} />
                <Row label="Semantic richness score" values={stats.map((s) => s.composite.semanticRichness)} suffix="/100" />

                {/* Performance */}
                <SectionHeader label="Performance" colCount={stats.length} />
                <Row label="Total pipeline" values={stats.map((s) => s.timing.totalMs)} bestIsLow suffix=" ms" />
                <Row indent label="IR parse" values={stats.map((s) => s.timing.parseMs)} bestIsLow suffix=" ms" dim />
                <Row indent label="Mapper" values={stats.map((s) => s.timing.mapMs)} bestIsLow suffix=" ms" dim />
                <Row indent label="Layout engine" values={stats.map((s) => s.timing.layoutMs)} bestIsLow suffix=" ms" dim />
                <Row label="HTML input size" values={stats.map((s) => s.htmlSizeKb)} suffix=" KB" />

                {/* Semantic precision & recall */}
                <SectionHeader label="Semantic Precision & Recall (vs HTML)" colCount={stats.length} />
                <Row label="Heading recall" values={stats.map((s) => s.precisionRecall.headingRecall)} suffix="%" />
                <Row label="Landmark recall" values={stats.map((s) => s.precisionRecall.landmarkRecall)} suffix="%" />
                <Row label="Nav region recall" values={stats.map((s) => s.precisionRecall.navRecall)} suffix="%" />
                <Row label="Form input recall" values={stats.map((s) => s.precisionRecall.formInputRecall)} suffix="%" />
                <Row label="Image recall" values={stats.map((s) => s.precisionRecall.imageRecall)} suffix="%" />

                {/* Accessibility preservation */}
                <SectionHeader label="Accessibility Preservation" colCount={stats.length} />
                <Row label="aria-labelledby preserved" values={stats.map((s) => s.accessibility.ariaLabelledByRate)} suffix="%" />
                <Row label="aria-describedby preserved" values={stats.map((s) => s.accessibility.ariaDescribedByRate)} suffix="%" />
                <Row label="Explicit role honor rate" values={stats.map((s) => s.accessibility.explicitRoleHonorRate)} suffix="%" />
                <Row label="Alt text coverage" values={stats.map((s) => s.accessibility.altTextCoverage)} suffix="%" />

                {/* Information fidelity */}
                <SectionHeader label="Information Fidelity" colCount={stats.length} />
                <Row label="Text coverage" values={stats.map((s) => s.fidelity.textCoverage)} suffix="%" />
                <Row label="Heading text retention" values={stats.map((s) => s.fidelity.headingTextRetention)} suffix="%" />
                <Row label="Nodes per KB" values={stats.map((s) => s.fidelity.nodesPerKb)} />

                {/* IR Structure */}
                <SectionHeader label="IR Structure" colCount={stats.length} />
                <Row label="IR nodes total" values={stats.map((s) => s.irNodeCount)} />
                <Row label="Landmarks" values={stats.map((s) => s.analytics.landmarkCount)} />
                <Row label="Headings" values={stats.map((s) => s.analytics.headingCount)} />
                <Row label="Sections (regions)" values={stats.map((s) => s.analytics.sectionCount)} />
                <Row label="Interactive controls" values={stats.map((s) => s.analytics.controlCount)} />
                <Row label="Word count" values={stats.map((s) => s.analytics.wordCount)} />
                <Row label="Text length (chars)" values={stats.map((s) => s.analytics.textLength)} />
                <Row label="Text density (chars/node)" values={stats.map((s) => Math.round(s.analytics.textDensity))} />
                <Row label="Live regions" values={stats.map((s) => s.analytics.liveRegionCount)} />

                {/* IR Quality */}
                <SectionHeader label="IR Semantic Quality" colCount={stats.length} />
                <Row label="Labeling rate" values={stats.map((s) => s.irQuality.labelingRate)} suffix="%" />
                <Row label="Parse confidence rate" values={stats.map((s) => s.irQuality.parseConfidenceRate)} suffix="%" />
                <Row label="Avg node confidence" values={stats.map((s) => s.irQuality.avgConfidence)} />
                <Row label="Semantic node ratio" values={stats.map((s) => s.irQuality.semanticNodeRatio)} suffix="%" />
                <Row label="Generic node ratio" values={stats.map((s) => s.irQuality.genericRatio)} bestIsLow suffix="%" />
                <Row label="Content-to-chrome ratio" values={stats.map((s) => s.irQuality.contentToChromeRatio)} />
                <Row label="Nodes with ARIA relations" values={stats.map((s) => s.irQuality.nodesWithRelations)} />
                <Row label="Max semantic depth" values={stats.map((s) => s.irQuality.maxDepth)} />
                <Row label="Avg semantic depth" values={stats.map((s) => s.irQuality.avgDepth)} />

                {/* Source breakdown */}
                <SectionHeader label="Node Source Breakdown" colCount={stats.length} />
                {["explicit", "structural", "ai", "ai-timeout", "inline", "generic"].map((src) => (
                  <Row key={src} indent label={src} values={stats.map((s) => s.sourceBreakdown[src] ?? 0)} />
                ))}

                {/* XR Primitive types */}
                <SectionHeader label="XR Primitive Types" colCount={stats.length} />
                {KEY_PRIMITIVE_TYPES.map((type) => {
                  const vals = stats.map((s) => s.primitiveTypeBreakdown[type] ?? 0);
                  if (vals.every((v) => v === 0)) return null;
                  return <Row key={type} indent label={type} values={vals} dim={vals.every((v) => v < 2)} />;
                })}

                {/* XR Usability */}
                <SectionHeader label="XR Usability" colCount={stats.length} />
                <BoolRow label="Content panel present" values={stats.map((s) => s.usability.hasContentPanel)} />
                <BoolRow label="TOC / nav available" values={stats.map((s) => s.usability.hasTOC)} />
                <Row label="Words per page" values={stats.map((s) => s.usability.wordsPerPage)} />
                <Row label="Section granularity" values={stats.map((s) => s.usability.sectionGranularity)} />
                <Row label="Semantic diversity" values={stats.map((s) => s.usability.semanticDiversity)} suffix="%" />

                {/* XR Layout */}
                <SectionHeader label="XR Layout Output" colCount={stats.length} />
                <Row label="Layout template" values={stats.map((s) => s.layoutTemplate)} />
                <Row label="Primitives placed" values={stats.map((s) => s.primitiveCount)} />
                <Row label="Paginated panels" values={stats.map((s) => s.paginatedPanels)} />
                <Row label="Total pages" values={stats.map((s) => s.totalPages)} />
                <Row label="Unplaced primitives" values={stats.map((s) => s.unplacedCount)} bestIsLow />
                <Row label="Fallback height estimates" values={stats.map((s) => s.fallbackHeightCount)} bestIsLow />
              </tbody>
            </table>

            {stats.some((s) => s.error) && (
              <div style={{ marginTop: 12 }}>
                {stats.filter((s) => s.error).map((s) => (
                  <div key={s.label} style={{ color: "#f6a623", fontSize: 11, fontFamily: "monospace", marginBottom: 4 }}>
                    {s.label}: {s.error}
                  </div>
                ))}
              </div>
            )}

            <div style={{ marginTop: 14, fontSize: 10, color: "#1e2e3e", lineHeight: 1.8 }}>
              <span style={{ color: "#4ec966" }}>■</span> best &nbsp;
              <span style={{ color: "#f6a623" }}>■</span> worst &nbsp;·&nbsp;
              Hover <span style={{ color: "#2a4a6a" }}>ⓘ</span> on any metric for an explanation &nbsp;·&nbsp;
              Recall metrics are vs raw HTML DOM counts (no manual annotation required) &nbsp;·&nbsp;
              Timing via <code style={{ color: "#2a4a6a" }}>performance.now()</code> &nbsp;·&nbsp;
              Device profile: Quest 3
            </div>
          </>
        )}
      </div>
    </div>
  );
}
