/**
 * eval/harness.ts — one-page benchmark. Runs the pipeline backends end-to-end,
 * derives the IR-level metrics (reusing compare/), computes the XR spatial
 * quality of the placed plan, and scores the (pipeline-independent) DOM
 * segmentation algorithms. Browser-safe: shared by the offline Node runner and
 * usable from the React panel.
 */
import { parsePageToIR } from "../ir/parser";
import { parsePageWithVIPS } from "../ir/vips";
import { applyParserBackend } from "../ir/backends";
import { DEFAULT_CONFIG } from "../ir/defaults";
import { mapIRToScene, DEFAULT_MAPPER_CONFIG } from "../mapper/mapper";
import { computeLayoutPlan } from "../layout/engine";
import { QUEST_3_PROFILE } from "../layout/profiles";
import {
  extractHTMLGroundTruth,
  deriveIRQuality,
  derivePrecisionRecall,
  deriveInformationFidelity,
  deriveComposite,
  deriveAccessibility,
  deriveStructuralFidelity,
  countPrimitiveTypes,
} from "../components/compare/metrics";
import { computeXRQuality, type XRSpatialQuality } from "./xr-quality";
import { scoreSegmentation, type SegmenterId, type SegmentationScore } from "./segmentation";

/** Pipeline backends we can run headlessly (web2vr needs a real iframe). */
export const PIPELINE_BACKENDS = [
  { id: "custom" as const, label: "Custom (ARIA+Structural)" },
  { id: "readability" as const, label: "Readability" },
  { id: "naive" as const, label: "Naive (Tags Only)" },
  { id: "vips" as const, label: "VIPS" },
];

export type PipelineBackendId = (typeof PIPELINE_BACKENDS)[number]["id"];

export interface BackendBenchmark {
  id: PipelineBackendId;
  label: string;
  timingMs: number;
  irNodeCount: number;
  /** compare/ composite (0–100). */
  semanticRichness: number;
  headingRecall: number;
  landmarkRecall: number;
  textCoverage: number;
  genericRatio: number;
  primitivesPlaced: number;
  altTextCoverage: number;
  ariaLabelledByRate: number;
  interactiveAffordanceRate: number;
  controlLabelCoverage: number;
  headingHierarchyValidity: number;
  linkRetention: number;
  navLinkRetention: number;
  inlineLinkRetention: number;
  tablePreservation: number;
  mediaPreservation: number;
  readingOrderFidelity: number;
  xr: XRSpatialQuality | null;
  error?: string;
}

export interface PageBenchmark {
  page: string;
  htmlSizeKb: number;
  /** Algorithm-level segmentation quality (BCubed vs reference). */
  segmentation: Record<SegmenterId, SegmentationScore>;
  backends: BackendBenchmark[];
}

async function runOneBackend(
  id: PipelineBackendId,
  label: string,
  html: string,
  url: string,
): Promise<BackendBenchmark> {
  const gt = extractHTMLGroundTruth(html);
  const t0 = performance.now();
  try {
    let ir;
    if (id === "vips") {
      ir = await parsePageWithVIPS(html, url);
    } else {
      const transform = applyParserBackend(html, id, {});
      const cfg = { ...DEFAULT_CONFIG, ...transform.configOverride };
      ir = await parsePageToIR(transform.html, url, undefined, cfg);
    }
    const scene = mapIRToScene(ir, DEFAULT_MAPPER_CONFIG);
    const plan = computeLayoutPlan(scene, QUEST_3_PROFILE, undefined, {});
    const timingMs = Math.round(performance.now() - t0);

    const nodes = Object.values(ir.nodes);
    const breakdown = countPrimitiveTypes(scene.root);
    const quality = deriveIRQuality(nodes);
    const pr = derivePrecisionRecall(ir.analytics, breakdown, gt);
    const acc = deriveAccessibility(nodes, gt);
    const refBody = new DOMParser().parseFromString(html, "text/html").body;
    const structural = deriveStructuralFidelity(nodes, scene, gt, refBody);
    const fidelity = deriveInformationFidelity(ir.analytics, gt);
    const composite = deriveComposite(pr, quality, acc, fidelity);

    return {
      id,
      label,
      timingMs,
      irNodeCount: nodes.length,
      semanticRichness: composite.semanticRichness,
      headingRecall: pr.headingRecall,
      landmarkRecall: pr.landmarkRecall,
      textCoverage: fidelity.textCoverage,
      genericRatio: quality.genericRatio,
      primitivesPlaced: plan.diagnostics.totalPlaced,
      altTextCoverage: acc.altTextCoverage,
      ariaLabelledByRate: acc.ariaLabelledByRate,
      interactiveAffordanceRate: structural.interactiveAffordanceRate,
      controlLabelCoverage: structural.controlLabelCoverage,
      headingHierarchyValidity: structural.headingHierarchyValidity,
      linkRetention: structural.linkRetention,
      navLinkRetention: structural.navLinkRetention,
      inlineLinkRetention: structural.inlineLinkRetention,
      tablePreservation: structural.tablePreservation,
      mediaPreservation: structural.mediaPreservation,
      readingOrderFidelity: structural.readingOrderFidelity,
      xr: computeXRQuality(plan, QUEST_3_PROFILE, scene),
    };
  } catch (err) {
    return {
      id,
      label,
      timingMs: Math.round(performance.now() - t0),
      irNodeCount: 0,
      semanticRichness: 0,
      headingRecall: 0,
      landmarkRecall: 0,
      textCoverage: 0,
      genericRatio: 0,
      primitivesPlaced: 0,
      altTextCoverage: 0,
      ariaLabelledByRate: 0,
      interactiveAffordanceRate: 0,
      controlLabelCoverage: 0,
      headingHierarchyValidity: 0,
      linkRetention: 0,
      navLinkRetention: 0,
      inlineLinkRetention: 0,
      tablePreservation: 0,
      mediaPreservation: 0,
      readingOrderFidelity: 0,
      xr: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Benchmark a single page: all pipeline backends + all segmentation algorithms.
 * `doc` is the parsed DOM (used only for the segmentation metric); pass
 * `new DOMParser().parseFromString(html, "text/html")`.
 */
export async function benchmarkPage(
  page: string,
  html: string,
  url: string,
  doc: Document,
): Promise<PageBenchmark> {
  const htmlSizeKb = Math.round((new Blob([html]).size / 1024) * 10) / 10;
  const segmentation = scoreSegmentation(doc.body);
  const backends: BackendBenchmark[] = [];
  for (const b of PIPELINE_BACKENDS) {
    backends.push(await runOneBackend(b.id, b.label, html, url));
  }
  return { page, htmlSizeKb, segmentation, backends };
}
