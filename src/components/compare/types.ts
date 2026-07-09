/**
 * compare/types.ts — metric + result shapes for the parser comparison panel.
 */
import type { IRAnalytics } from "../../ir/types";
import type { LayoutTemplate } from "../../layout/types";

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
  maxDepth: number;
  avgDepth: number;
  parseConfidenceRate: number; // % nodes above confidence threshold 0.6
  semanticNodeRatio: number; // % that are not generic/inline
  contentToChromeRatio: number; // content nodes / nav+banner+footer nodes
}

export interface PrecisionRecall {
  headingRecall: number; // IR headings / DOM h1-h6
  landmarkRecall: number; // IR landmarks / DOM landmark elements
  formInputRecall: number; // IR controls / DOM form inputs
  imageRecall: number; // IR images / DOM images with alt
  navRecall: number; // IR nav bars / DOM nav elements
}

export interface AccessibilityPreservation {
  ariaLabelledByRate: number; // IR nodes with resolved labelledBy / DOM [aria-labelledby]
  ariaDescribedByRate: number; // same for describedby
  explicitRoleHonorRate: number; // non-generic explicit-source nodes / all explicit-role nodes in DOM
  altTextCoverage: number; // IR images labeled / DOM images with alt text
}

export interface InformationFidelity {
  textCoverage: number; // IR words / DOM words
  headingTextRetention: number; // IR heading labels present / DOM heading text nodes
  nodesPerKb: number; // irNodeCount / htmlSizeKb
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
