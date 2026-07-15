/**
 * compare/backends.ts — runs each parser backend end-to-end through the
 * pipeline and assembles its BackendStats via the metrics derivations.
 */
import { parsePageToIR } from "../../ir/parser";
import { parsePageWithVIPS } from "../../ir/vips";
import { mapIRToScene, DEFAULT_MAPPER_CONFIG } from "../../mapper/mapper";
import { computeLayoutPlan } from "../../layout/engine";
import { DEFAULT_CONFIG } from "../../ir/defaults";
import { applyParserBackend } from "../../ir/backends";
import { QUEST_3_PROFILE } from "../../layout/profiles";
import { computeXRQuality } from "../../eval/xr-quality";
import { scoreSceneSegmentation } from "../../eval/segmentation";
import { INLINE_PRIMITIVE_TYPES } from "./config";
import {
  deriveIRQuality,
  derivePrecisionRecall,
  deriveAccessibility,
  deriveStructuralFidelity,
  deriveInformationFidelity,
  deriveXRUsability,
  deriveComposite,
  countPrimitiveTypes,
  buildPrimitiveTypeIndex,
} from "./metrics";
import type { IRAnalytics } from "../../ir/types";
import type {
  BackendStats,
  HTMLGroundTruth,
  IRQuality,
  PrecisionRecall,
  AccessibilityPreservation,
  StructuralFidelity,
  InformationFidelity,
  XRUsability,
} from "./types";

export const BACKENDS = [
  { id: "custom" as const, label: "Custom (ARIA+Structural)" },
  { id: "readability" as const, label: "Readability" },
  { id: "naive" as const, label: "Naive (Tags Only)" },
  { id: "vips" as const, label: "VIPS" },
];

export async function runBackend(
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
    const irQuality = deriveIRQuality(nodes);
    const precisionRecall = derivePrecisionRecall(
      ir.analytics,
      primitiveTypeBreakdown,
      gt,
    );
    const accessibility = deriveAccessibility(nodes, gt);
    const refBody = new DOMParser().parseFromString(html, "text/html").body;
    const structuralFidelity = deriveStructuralFidelity(
      nodes,
      scene,
      gt,
      refBody,
    );
    const fidelity = deriveInformationFidelity(ir.analytics, gt);
    const usability = deriveXRUsability(
      scene.root,
      primitiveTypeBreakdown,
      ir.analytics,
      totalPages,
    );
    const composite = deriveComposite(
      precisionRecall,
      irQuality,
      accessibility,
      fidelity,
    );

    return {
      label,
      timing: { parseMs, mapMs, layoutMs, totalMs },
      htmlSizeKb,
      irNodeCount: nodes.length,
      analytics: ir.analytics,
      irQuality,
      precisionRecall,
      accessibility,
      structuralFidelity,
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
      xr: computeXRQuality(plan, QUEST_3_PROFILE, scene),
      segmentation: scoreSceneSegmentation(scene.root, refBody),
    };
  } catch (err) {
    const totalMs = Math.round(performance.now() - t0);
    const emptyAnalytics: IRAnalytics = {
      headingCount: 0,
      landmarkCount: 0,
      controlCount: 0,
      sectionCount: 0,
      textDensity: 0,
      wordCount: 0,
      textLength: 0,
      childCount: 0,
      liveRegionCount: 0,
    };
    const emptyQuality: IRQuality = {
      labelingRate: 0,
      avgConfidence: 0,
      genericRatio: 0,
      nodesWithRelations: 0,
      parseConfidenceRate: 0,
      semanticNodeRatio: 0,
    };
    const emptyPR: PrecisionRecall = {
      headingRecall: 0,
      landmarkRecall: 0,
      formInputRecall: 0,
      imageRecall: 0,
      navRecall: 0,
    };
    const emptyA11y: AccessibilityPreservation = {
      ariaLabelledByRate: 0,
      ariaDescribedByRate: 0,
      explicitRoleHonorRate: 0,
      altTextCoverage: 0,
    };
    const emptyStructural: StructuralFidelity = {
      interactiveAffordanceRate: 0,
      controlLabelCoverage: 0,
      headingHierarchyValidity: 0,
      linkRetention: 0,
      navLinkRetention: 0,
      inlineLinkRetention: 0,
      tablePreservation: 0,
      mediaPreservation: 0,
      readingOrderFidelity: 0,
    };
    const emptyFidelity: InformationFidelity = {
      textCoverage: 0,
    };
    const emptyUsability: XRUsability = {
      hasContentPanel: false,
      hasTOC: false,
      wordsPerPage: 0,
      sectionGranularity: 0,
      semanticDiversity: 0,
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
      structuralFidelity: emptyStructural,
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
      xr: null,
      segmentation: {
        precision: 0,
        recall: 0,
        f: 0,
        segmentCount: 0,
        coveredUnits: 0,
      },
      error: err instanceof Error ? err.message : "Unknown error",
    };
  }
}

// ─────────────────────────────────────────────────────────────
// Metric descriptions
// ─────────────────────────────────────────────────────────────

