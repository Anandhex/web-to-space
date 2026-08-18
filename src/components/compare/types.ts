/**
 * compare/types.ts — metric + result shapes for the parser comparison panel.
 */
import type { IRAnalytics } from "../../ir/types";
import type { XRSpatialQuality } from "../../eval/xr-quality";
import type { SegmentationScore } from "../../eval/segmentation";
import type { VipsMode, VipsFallbackReason } from "../../ir/vips";
import type { RenderFrameDiagnostics } from "../../ir/render-frame";
import type { VipsVisualDiagnostics } from "../../ir/vips-visual";

export interface StageTiming {
  parseMs: number;
  mapMs: number;
  layoutMs: number;
  totalMs: number;
}

export interface IRQuality {
  labelingRate: number; // % nodes with an explicit label OR text content
  avgConfidence: number;
  genericRatio: number;
  nodesWithRelations: number;
  parseConfidenceRate: number; // % nodes above confidence threshold 0.6
  semanticNodeRatio: number; // % that are not generic/inline
}

export interface PrecisionRecall {
  headingRecall: number; // IR headings / DOM h1-h6
  landmarkRecall: number; // IR landmarks / DOM landmark elements
  formInputRecall: number; // XR form-control primitives / DOM form inputs (≤100)
  imageRecall: number; // IR images / DOM images with alt
  navRecall: number; // IR nav bars / DOM navs (excl. header/footer chrome), ≤100
}

export interface AccessibilityPreservation {
  // All rates are content-matched set intersections ÷ the DOM population, so
  // they are ≤100% by construction (a numerator cannot exceed its denominator).
  ariaLabelledByRate: number; // DOM aria-labelledby label texts preserved in IR ÷ DOM total
  ariaDescribedByRate: number; // same for aria-describedby description texts
  explicitRoleHonorRate: number; // non-generic explicit-source nodes / all explicit-role nodes in DOM
  altTextCoverage: number; // DOM alt strings that survive into the scene ÷ DOM alt strings
}

export interface StructuralFidelity {
  interactiveAffordanceRate: number; // interactive XR primitives ÷ DOM interactive elements (≤100)
  controlLabelCoverage: number; // interactive XR primitives with a label ÷ all interactive XR primitives
  headingHierarchyValidity: number; // heading level transitions that don't skip a level (WCAG 1.3.1)
  linkRetention: number; // combined rollup: all links preserved ÷ all DOM <a href> (≤100)
  navLinkRetention: number; // standalone XRLink-with-href ÷ DOM navigation/standalone links (≤100)
  inlineLinkRetention: number; // inline-run links-with-href ÷ DOM in-prose links (≤100)
  tablePreservation: number; // XRTableCell ÷ DOM table cells (≤100)
  mediaPreservation: number; // XRMediaPlayer ÷ DOM <video>/<audio> (≤100)
  readingOrderFidelity: number; // Kendall-τ agreement of scene reading order vs DOM order, 0–100
}

export interface InformationFidelity {
  textCoverage: number; // IR words / DOM words
}

export interface XRUsability {
  hasContentPanel: boolean;
  hasTOC: boolean;
  wordsPerPage: number;
  sectionGranularity: number; // sections / landmarks
  semanticDiversity: number; // distinct primitive types used / total available
}

export interface CompositeScore {
  semanticRichness: number; // 0–100 weighted composite
}

export interface PrimitiveBreakdown {
  [type: string]: number;
}

// ─────────────────────────────────────────────────────────────
// CSSOM usage
// ─────────────────────────────────────────────────────────────

/**
 * What a backend saw of the *rendered* page, as opposed to the markup.
 *
 * Every other section of this panel compares backends on DOM-derived output, and
 * that quietly hides the single biggest difference between them: only VIPS reads
 * the CSSOM at all, and whether it *got* the CSSOM on this particular run
 * decides whether the row is Cai et al.'s algorithm or a tag-tree approximation
 * wearing its name. The reader needs both facts side by side — "does this
 * backend use rendered layout" and "did it have any on this page" — otherwise a
 * VIPS row is uninterpretable.
 *
 * `usesCssom: false` is a statement about the algorithm; `mode: "dom-only"` with
 * `usesCssom: true` is a statement about this run.
 */
export interface CssomUsage {
  /** Does this backend consult rendered layout by design? */
  usesCssom: boolean;
  /** What it actually ran as this time. */
  mode: VipsMode;
  /** Why the rendered path was not used, when it was not. */
  fallbackReason: VipsFallbackReason;
  /** Off-screen frame render stats — null when no frame was rendered. */
  render: RenderFrameDiagnostics | null;
  /** Visual block / separator stats — null when the visual path did not run. */
  visual: VipsVisualDiagnostics | null;
}

/** A backend that never renders: its CSSOM column is "not applicable". */
export const DOM_ONLY_BY_DESIGN: CssomUsage = {
  usesCssom: false,
  mode: "dom-only",
  fallbackReason: null,
  render: null,
  visual: null,
};

export interface HTMLGroundTruth {
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
  /** DOM interactive elements (links/buttons/inputs/interactive roles). */
  interactiveElementCount: number;
  /** DOM <a href> count (total). */
  linkCount: number;
  /** DOM <a href> classified as navigation/standalone (in nav/menu or link-only). */
  navLinkCount: number;
  /** DOM <a href> classified as in-prose (surrounded by other text). */
  inlineLinkCount: number;
  /** DOM table data/header cells (td + th). */
  tableCellCount: number;
  /** DOM <video> + <audio> count. */
  mediaCount: number;
  /** Normalised non-empty alt strings from DOM <img alt>. */
  altTexts: string[];
  /** Resolved label text for each DOM element with aria-labelledby. */
  labelledByTexts: string[];
  /** Resolved description text for each DOM element with aria-describedby. */
  describedByTexts: string[];
}

export interface BackendStats {
  label: string;
  /**
   * A caveat that must travel with this row's numbers.
   *
   * Set when a backend ran in a degraded mode that makes a head-to-head
   * comparison unfair to it — currently only VIPS, which falls back to a
   * rendering-free approximation when no layout engine is available. A win over
   * a degraded baseline is not a win over the algorithm, and the panel says so
   * rather than leaving the reader to assume otherwise.
   */
  caveat?: string;
  timing: StageTiming;
  htmlSizeKb: number;
  irNodeCount: number;
  analytics: IRAnalytics;
  irQuality: IRQuality;
  precisionRecall: PrecisionRecall;
  accessibility: AccessibilityPreservation;
  structuralFidelity: StructuralFidelity;
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
  /** Literature-grounded XR spatial quality of the placed plan (null on error). */
  xr: XRSpatialQuality | null;
  /** BCubed segmentation quality of THIS backend's produced scene vs reference. */
  segmentation: SegmentationScore;
  /** Whether this backend used the rendered page, and what it got. */
  cssom: CssomUsage;
  error?: string;
}

// ─────────────────────────────────────────────────────────────
// HTML ground truth extraction
// ─────────────────────────────────────────────────────────────
