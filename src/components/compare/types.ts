/**
 * compare/types.ts — metric + result shapes for the parser comparison panel.
 */
import type { IRAnalytics } from "../../ir/types";
import type { LayoutTemplate } from "../../layout/types";
import type { XRSpatialQuality } from "../../eval/xr-quality";
import type { SegmentationScore } from "../../eval/segmentation";

export interface StageTiming {
  parseMs: number;
  mapMs: number;
  layoutMs: number;
  totalMs: number;
}

export interface IRQuality {
  labelingRate: number;
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
  layoutTemplate: LayoutTemplate;
  /** Literature-grounded XR spatial quality of the placed plan (null on error). */
  xr: XRSpatialQuality | null;
  /** BCubed segmentation quality of THIS backend's produced scene vs reference. */
  segmentation: SegmentationScore;
  error?: string;
}

// ─────────────────────────────────────────────────────────────
// HTML ground truth extraction
// ─────────────────────────────────────────────────────────────
