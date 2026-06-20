// ─────────────────────────────────────────────────────────────
// Helpers (geometry, rotation)
// ─────────────────────────────────────────────────────────────

import type {
  Rotation3,
  Vec3,
  XRList,
  XRParagraph,
  XRPrimitiveType,
  XRTable,
} from "../mapper/types";
import type {
  PrimitiveFontMetrics,
  RenderMetrics,
  TextBearingMetrics,
} from "./types";

export function deg2rad(deg: number): number {
  return (deg * Math.PI) / 180;
}

export function zeroRotation(): Rotation3 {
  return { x: 0, y: 0, z: 0 };
}

export function zeroVec(): Vec3 {
  return { x: 0, y: 0, z: 0 };
}

// ── Slot factory helpers ─────────────────────────────────────

export function angularPosition(
  distance: number,
  angleDeg: number,
  eyeY: number,
): Vec3 {
  const rad = deg2rad(angleDeg);
  return { x: distance * Math.sin(rad), y: eyeY, z: -distance * Math.cos(rad) };
}

export function angularRotation(angleDeg: number): Rotation3 {
  return { x: 0, y: -deg2rad(angleDeg), z: 0 };
}

/** Compute words-per-line for a given panel width and font metrics. */
export function computeWordsPerLine(
  panelUsableWidth: number,
  m: PrimitiveFontMetrics,
): number {
  const charWidth = m.fontSize * m.charWidthRatio;
  return Math.max(
    1,
    Math.floor(panelUsableWidth / (charWidth * m.avgCharsPerWord)),
  );
}

/** Count words in a string. */
export function countWords(text: string): number {
  return text.trim() === "" ? 0 : text.trim().split(/\s+/).length;
}

// ─────────────────────────────────────────────────────────────
// Metric-driven height estimation
// ─────────────────────────────────────────────────────────────

/**
 * Estimate the rendered height of a text-bearing interactive element
 * (button, link, menu item, tab, alert, tooltip, list item, card).
 *
 * If the element's label fits on one line the result is `tb.minHeight`.
 * If the label wraps to N lines the result grows: the extra lines are added
 * on top of `tb.minHeight` using the element's line height.
 *
 * @param label           The visible label text (may be empty / undefined).
 * @param panelUsableWidth Width of the containing panel minus padding (m).
 * @param tb              TextBearingMetrics for this element type.
 * @param fallback        Fallback height if tb metrics are degenerate.
 */
export function estimateTextBearingHeight(
  label: string | undefined,
  panelUsableWidth: number,
  tb: TextBearingMetrics,
  fallback: number,
): number {
  const minHeight = Math.max(tb.minHeight, fallback);

  const wordCount = countWords(label ?? "");
  if (wordCount === 0) {
    return minHeight;
  }

  const lineH = tb.font.fontSize * tb.font.lineHeightRatio;
  if (lineH <= 0 || !isFinite(lineH)) {
    return minHeight;
  }

  const wordsPerLine = computeWordsPerLine(panelUsableWidth, tb.font);
  const lineCount = Math.max(1, Math.ceil(wordCount / wordsPerLine));

  if (lineCount <= 1) {
    return minHeight;
  }

  const height = minHeight + (lineCount - 1) * lineH;

  return Math.max(minHeight, height);
}

/**
 * Fixed-height floors for primitives whose minimum height is dictated by
 * RenderMetrics regardless of content.
 *
 * These values are consumed by the universal fallback in `estimateHeight` as a
 * *floor*: if a primitive also has children or a label, the derived height is
 * taken as max(fixedFloor, derivedHeight), so the element never shrinks below
 * its designed baseline but can grow to fit its actual content.
 */
export function FIXED_HEIGHT_LOOKUP(
  m: RenderMetrics,
): Partial<Record<XRPrimitiveType, number>> {
  return {
    // Interactive — truly fixed (no meaningful label or children in practice)
    XRToggle: m.toggle.height,
    XRSlider: m.slider.height,
    XRComboBox: m.comboBox.height,
    XRSearchBox: m.searchBox.height,
    XRProgressBar: m.progressBar.height,
    XRSeparator: m.separator.height,
    XRTabGroup: m.tabGroup.height,
    // Media (XRFigure is handled above with caption awareness)
    XRImage: m.image.height,
    // Landmark containers — floors only; children/label can push them taller.
    XRBanner: m.banner.height,
    XRFooter: m.footer.height,
    XRNavigationBar: m.navigationBar.height,
  };
}

/**
 * Estimate the rendered height of a paragraph primitive.
 * Exported so paragraph continuation helpers can call it directly.
 */
export function estimateParagraphHeight(
  p: XRParagraph,
  panelUsableWidth: number,
  metrics: RenderMetrics,
): number {
  const wordCount =
    p.wordCount != null && p.wordCount > 0
      ? p.wordCount
      : countWords(p.content ?? p.label ?? "");
  if (wordCount === 0) {
    return (
      metrics.paragraph.fontSize * metrics.paragraph.lineHeightRatio +
      metrics.paragraph.verticalPadding
    );
  }
  const m = metrics.paragraph;
  const wordsPerLine = computeWordsPerLine(panelUsableWidth, m);
  const lineCount = Math.ceil(wordCount / wordsPerLine);
  const lineH = m.fontSize * m.lineHeightRatio;
  return Math.max(
    m.fontSize * m.lineHeightRatio + m.verticalPadding, // floor = 1 line
    lineCount * lineH + m.verticalPadding,
  );
}

/**
 * Compute how many words of a paragraph fit within a given height budget.
 *
 * Used by the paginator to split a paragraph that straddles a page boundary.
 *
 * @returns number of words that fit (could be 0 if budget < 1 line).
 */
export function paragraphWordsThatFit(
  budget: number,
  panelUsableWidth: number,
  metrics: RenderMetrics,
): number {
  const m = metrics.paragraph;
  const lineH = m.fontSize * m.lineHeightRatio;
  const availableForText = budget - m.verticalPadding;
  if (availableForText <= 0) return 0;
  const lines = Math.floor(availableForText / lineH);
  const wordsPerLine = computeWordsPerLine(panelUsableWidth, m);
  return lines * wordsPerLine;
}

// ─────────────────────────────────────────────────────────────
// Resolved strategy helpers
// ─────────────────────────────────────────────────────────────

/**
 * Decide the column count for an XRList given the available panel width.
 *
 * floor(panelUsableWidth / minCardWidth), clamped to [1, maxCardColumns].
 */
export function resolveListColumns(
  grid: XRList,
  panelUsableWidth: number,
  metrics: RenderMetrics,
): number {
  const fromWidth = Math.floor(panelUsableWidth / metrics.minCardWidth);
  return Math.max(1, Math.min(fromWidth, metrics.maxCardColumns));
}

/**
 * Decide the rendering strategy for an XRTable.
 *
 * Rules:
 *   columns > tableMaxFlatColumns → "scrollable" (too wide to show flat)
 *   rows    > tableMaxFlatRows    → "scrollable" (too tall to paginate row by row)
 *   columns > 2 && rows > 4      → "curved-2d"  (ergonomic at wide angles)
 *   rows    < columns (wide/flat) → "cards"      (each row becomes a card)
 *   default                      → "flat-2d"
 */
export function resolveTableStrategy(
  table: XRTable,
  metrics: RenderMetrics,
): "flat-2d" | "curved-2d" | "scrollable" | "cards" {
  const { columnCount, rowCount } = table;
  if (columnCount > metrics.tableMaxFlatColumns) return "scrollable";
  if (rowCount > metrics.tableMaxFlatRows) return "scrollable";
  if (columnCount > 2 && rowCount > 4) return "curved-2d";
  if (rowCount < columnCount) return "cards";
  return "flat-2d";
}

export function splitIntoWords(label: string): string[] {
  return label.split(/\s+/);
}
