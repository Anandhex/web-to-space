/**
 * compare/markdown.ts — renders the comparison results as a Markdown table for
 * the "Copy as Markdown" action.
 */
import type { BackendStats, HTMLGroundTruth } from "./types";

export function buildMarkdownTable(
  stats: BackendStats[],
  gt: HTMLGroundTruth,
): string {
  const headers = ["Metric", ...stats.map((s) => s.label)];
  const sep = headers.map(() => "---");
  const row = (label: string, vals: (string | number)[]) =>
    [label, ...vals.map(String)].join(" | ");

  return [
    row(headers[0], headers.slice(1)),
    row(sep[0], sep.slice(1)),
    "**Composite Score** | " + stats.map(() => "").join(" | "),
    row(
      "Semantic richness score (/100)",
      stats.map((s) => s.composite.semanticRichness),
    ),
    `HTML ground truth — headings: ${gt.headingCount}, landmarks: ${gt.landmarkCount}, words: ${gt.totalTextWordCount} | | | | `,
    "**Performance** | " + stats.map(() => "").join(" | "),
    row(
      "Total pipeline (ms)",
      stats.map((s) => s.timing.totalMs),
    ),
    row(
      "  IR parse (ms)",
      stats.map((s) => s.timing.parseMs),
    ),
    row(
      "  Mapper (ms)",
      stats.map((s) => s.timing.mapMs),
    ),
    row(
      "  Layout engine (ms)",
      stats.map((s) => s.timing.layoutMs),
    ),
    row(
      "HTML input size (KB)",
      stats.map((s) => s.htmlSizeKb),
    ),
    "**Semantic Precision & Recall vs HTML** | " +
      stats.map(() => "").join(" | "),
    row(
      "Heading recall (%)",
      stats.map((s) => s.precisionRecall.headingRecall),
    ),
    row(
      "Landmark recall (%)",
      stats.map((s) => s.precisionRecall.landmarkRecall),
    ),
    row(
      "Nav region recall (%)",
      stats.map((s) => s.precisionRecall.navRecall),
    ),
    row(
      "Form input recall (%)",
      stats.map((s) => s.precisionRecall.formInputRecall),
    ),
    row(
      "Image recall (%)",
      stats.map((s) => s.precisionRecall.imageRecall),
    ),
    "**Accessibility Preservation** | " + stats.map(() => "").join(" | "),
    row(
      "aria-labelledby preserved (%)",
      stats.map((s) => s.accessibility.ariaLabelledByRate),
    ),
    row(
      "aria-describedby preserved (%)",
      stats.map((s) => s.accessibility.ariaDescribedByRate),
    ),
    row(
      "Explicit role honor rate (%)",
      stats.map((s) => s.accessibility.explicitRoleHonorRate),
    ),
    row(
      "Alt text coverage (%)",
      stats.map((s) => s.accessibility.altTextCoverage),
    ),
    "**Information Fidelity** | " + stats.map(() => "").join(" | "),
    row(
      "Text coverage (%)",
      stats.map((s) => s.fidelity.textCoverage),
    ),
    "**IR Structure** | " + stats.map(() => "").join(" | "),
    row(
      "IR nodes total",
      stats.map((s) => s.irNodeCount),
    ),
    row(
      "Landmarks",
      stats.map((s) => s.analytics.landmarkCount),
    ),
    row(
      "Headings",
      stats.map((s) => s.analytics.headingCount),
    ),
    row(
      "Sections (regions)",
      stats.map((s) => s.analytics.sectionCount),
    ),
    row(
      "Interactive controls",
      stats.map((s) => s.analytics.controlCount),
    ),
    row(
      "Word count",
      stats.map((s) => s.analytics.wordCount),
    ),
    row(
      "Text density (chars/node)",
      stats.map((s) => Math.round(s.analytics.textDensity)),
    ),
    "**IR Semantic Quality** | " + stats.map(() => "").join(" | "),
    row(
      "Semantic richness score (/100)",
      stats.map((s) => s.composite.semanticRichness),
    ),
    row(
      "Labeling rate (%)",
      stats.map((s) => s.irQuality.labelingRate),
    ),
    row(
      "Parse confidence rate (%)",
      stats.map((s) => s.irQuality.parseConfidenceRate),
    ),
    row(
      "Avg node confidence",
      stats.map((s) => s.irQuality.avgConfidence),
    ),
    row(
      "Semantic node ratio (%)",
      stats.map((s) => s.irQuality.semanticNodeRatio),
    ),
    row(
      "Generic node ratio (%)",
      stats.map((s) => s.irQuality.genericRatio),
    ),
    "**Node Source Breakdown** | " + stats.map(() => "").join(" | "),
    row(
      "Explicit ARIA",
      stats.map((s) => s.sourceBreakdown["explicit"] ?? 0),
    ),
    row(
      "Structural inference",
      stats.map((s) => s.sourceBreakdown["structural"] ?? 0),
    ),
    row(
      "AI fallback",
      stats.map((s) => s.sourceBreakdown["ai"] ?? 0),
    ),
    row(
      "Inline",
      stats.map((s) => s.sourceBreakdown["inline"] ?? 0),
    ),
    row(
      "Generic (unclassified)",
      stats.map((s) => s.sourceBreakdown["generic"] ?? 0),
    ),
    "**XR Usability** | " + stats.map(() => "").join(" | "),
    row(
      "Content panel present",
      stats.map((s) => (s.usability.hasContentPanel ? "yes" : "no")),
    ),
    row(
      "TOC / nav available",
      stats.map((s) => (s.usability.hasTOC ? "yes" : "no")),
    ),
    row(
      "Words per page",
      stats.map((s) => s.usability.wordsPerPage),
    ),
    row(
      "Section granularity",
      stats.map((s) => s.usability.sectionGranularity),
    ),
    row(
      "Semantic diversity (%)",
      stats.map((s) => s.usability.semanticDiversity),
    ),
    "**XR Layout Output** | " + stats.map(() => "").join(" | "),
    row(
      "Layout template",
      stats.map((s) => s.layoutTemplate),
    ),
    row(
      "Primitives placed",
      stats.map((s) => s.primitiveCount),
    ),
    row(
      "Paginated panels",
      stats.map((s) => s.paginatedPanels),
    ),
    row(
      "Total pages",
      stats.map((s) => s.totalPages),
    ),
    row(
      "Unplaced primitives",
      stats.map((s) => s.unplacedCount),
    ),
    row(
      "Fallback height estimates",
      stats.map((s) => s.fallbackHeightCount),
    ),
  ].join("\n");
}

// ─────────────────────────────────────────────────────────────
// Tooltip (portal-based to avoid table overflow clipping)
// ─────────────────────────────────────────────────────────────

