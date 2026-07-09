/**
 * inline-constants.ts
 *
 * The set of primitive types that OWN inline text rendering: their inline
 * children (XRText, XRLink, XRButton) are flowed as a single prose run by the
 * mesh component rather than positioned as independent 3D nodes. Shared by the
 * layout engine (isInlineOwningNode) and the mapper (containerFlowsProse) so the
 * two can never drift out of sync.
 */
export const INLINE_OWNING_TYPES = new Set<string>([
  "XRParagraph",
  "XRHeading",
  "XRListItem",
  "XRBlockQuote",
  "XRLink",
  "XRButton",
  // NOTE: XRTableCell's heightStrategy is "mixed" too (estimateMixedContentHeight
  // with metrics.paragraph), which has the same estimate/position mismatch as
  // the types above — a cell's inline content (e.g. a "5" text node followed by
  // a "{3,3}" link) gets stacked as separate full-width rows instead of flowing
  // on one line. Adding "XRTableCell" here fixes that, but on large Wikipedia
  // tables it currently makes the layout pass slow enough to trip the WebGL
  // context's hang detection — needs a perf pass before it can be turned on.
]);
