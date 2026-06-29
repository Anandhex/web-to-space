// ─────────────────────────────────────────────────────────────
// Helpers (geometry, rotation)
// ─────────────────────────────────────────────────────────────

import type {
  Rotation3,
  Vec3,
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

/**
 * Vertical inset from an XRListItem card's top edge to the first glyph of
 * its label. This is a layout contract value, not a visual tuning constant:
 * XRSceneRenderer's XRListItemMesh positions the label text mesh at exactly
 * this offset, and the layout engine (engine.ts, in both estimateHeight's
 * XRListItem branch and stackChildrenSimple's top-padding calculation) must
 * use the same value when deciding where the card's children start. If
 * these two sites ever read different numbers, the label and the first
 * child either overlap (renderer inset smaller than what layout reserved)
 * or leave a dead gap (renderer inset larger than what layout reserved).
 */
export const LIST_ITEM_LABEL_TOP_INSET = 0.018;

/**
 * Height occupied by an XRListItem's own label line, including its top
 * inset (LIST_ITEM_LABEL_TOP_INSET).
 *
 * Unlike estimateTextBearingHeight, this does NOT model word-wrapping —
 * XRListItemMesh renders the label as a single fixed-size top line (it does
 * not wrap across multiple lines), so the height contribution is always
 * exactly one line, regardless of label length or panel width.
 *
 * Used by:
 *   - estimateHeight()'s XRListItem branch, to size the card.
 *   - stackChildrenSimple(), to know where the children's stack should
 *     start (y = -listItemLabelBlockHeight(...)) instead of the flat
 *     panelPaddingTop every other OWNS_TOP_PADDING container uses.
 *   - XRListItemMesh, to offset its rendered children group by the same
 *     amount the layout engine assumed when it positioned them.
 *
 * Returns 0 when there is no label, matching XRListItemMesh's behaviour of
 * skipping the text mesh entirely when primitive.label is falsy.
 */
export function listItemLabelBlockHeight(
  label: string | null | undefined,
  metrics: RenderMetrics,
): number {
  if (!label) return 0;
  const font = metrics.listItem.font;
  return LIST_ITEM_LABEL_TOP_INSET + font.fontSize * font.lineHeightRatio;
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

// ─────────────────────────────────────────────────────────────
// Inline flow layout helpers
// ─────────────────────────────────────────────────────────────

/**
 * Primitive types that are purely inline (flow horizontally on the same
 * line as adjacent runs). Everything else is treated as a block-break.
 *
 * XRImage / XRFigure are intentionally absent — they always force a new
 * vertical row.
 */
const INLINE_PRIMITIVE_TYPES = new Set(["XRText", "XRLink", "XRButton"]);

/** Returns true when a primitive should flow inline with its neighbours. */
export function isInlinePrimitive(type: string): boolean {
  return INLINE_PRIMITIVE_TYPES.has(type);
}

/**
 * Flatten XRGenericPanel wrappers that contain only inline children.
 *
 * The parser wraps Korean-romanisation spans, citation superscripts, and
 * other purely-stylistic inline containers in XRGenericPanel nodes (because
 * they carry a `title` attribute that prevents wrapper-piercing). Those
 * wrappers must be transparent to both the layout engine and the renderer:
 *
 *   Before: [..., XRText("wields a "), XRGenericPanel[XRLink("saingeom")], XRText(" sword")]
 *   After:  [..., XRText("wields a "), XRLink("saingeom"), XRText(" sword")]
 *
 * Called in:
 *   - estimateHeight (engine.ts) — XRListItem and XRParagraph branches
 *   - XRParagraphMesh / XRListItemMesh (primitives.tsx) — inline flow renderer
 *
 * Both call sites must use this function on the same input so the height the
 * engine reserves matches the height the renderer actually draws.
 *
 * A wrapper is flattened when ALL of its direct children are inline
 * primitives (XRText, XRLink, XRButton). Wrappers with block children
 * (XRImage, sub-lists) are left in place.
 */
// REPLACE the existing flattenInlineWrappers in utils.ts with:
export function flattenInlineWrappers<
  T extends { type: string; children?: T[] },
>(children: T[]): T[] {
  // An empty XRGenericPanel (no children) is a metadata-only node (e.g. the
  // Wikipedia Z3988 COinS span). It is transparent — drop it entirely and do
  // not let it block the "are all siblings inline?" check on the parent.
  const isEmptyPanel = (c: T) =>
    c.type === "XRGenericPanel" &&
    (!Array.isArray((c as any).children) || (c as any).children.length === 0);

  return children
    .filter((child) => !isEmptyPanel(child)) // drop empty metadata panels
    .flatMap((child) => {
      if (child.type !== "XRGenericPanel" || !Array.isArray(child.children)) {
        return [child];
      }
      // Filter out empty sub-panels before checking inline-ness
      const meaningfulChildren = child.children.filter(
        (c) => !isEmptyPanel(c as T),
      );
      if (
        meaningfulChildren.length > 0 &&
        meaningfulChildren.every((c) => isInlinePrimitive((c as T).type))
      ) {
        return meaningfulChildren as T[];
      }
      // Recurse: the wrapper may contain nested wrappers that haven't
      // been unwrapped yet (e.g. <span><i><a>…</a></i></span>).
      if (meaningfulChildren.length > 0) {
        const unwrapped = flattenInlineWrappers(meaningfulChildren as T[]);
        if (unwrapped.every((c) => isInlinePrimitive(c.type))) {
          return unwrapped;
        }
      }
      return [child];
    });
}

/**
 * Merge adjacent XRText sibling primitives into single combined nodes.
 *
 * Fragmented text like:
 *   XRText("This page was last edited on ")
 *   XRText("20 June 2026, at 23:57")
 *   XRText(" (UTC).")
 * arrives from the mapper as three separate nodes but should measure and
 * render as one continuous run. This function collapses consecutive XRText
 * nodes (preserving non-XRText nodes in place) before height estimation or
 * rendering so both sites see the same fused word-count.
 *
 * IMPORTANT: only merges nodes whose `componentType` is plain text (null,
 * "text", "span") AND that carry no `styleTags` (e.g. ["b"], ["i"]).
 * Bold/italic/code runs keep their individual identity — whether that's
 * signalled via componentType or via an accumulated styleTags stack (the
 * latter is how nested style-only tags like <i><b>…</b></i> are
 * represented) — so their visual styling is not lost.
 *
 * @returns a new array of primitives (original array is not mutated).
 */
export function mergeAdjacentTextRuns<
  T extends {
    type: string;
    text?: string;
    componentType?: string | null;
    styleTags?: string[] | null;
    id: string;
  },
>(children: T[]): T[] {
  if (children.length === 0) return children;

  const result: T[] = [];

  const isPlainText = (c: T) =>
    c.type === "XRText" &&
    (c.componentType == null ||
      c.componentType === "text" ||
      c.componentType === "span") &&
    (!c.styleTags || c.styleTags.length === 0);

  let i = 0;
  while (i < children.length) {
    const child = children[i];

    if (isPlainText(child)) {
      // Collect consecutive plain-text siblings
      const runStart = i;
      const parts: string[] = [child.text ?? ""];
      i++;
      while (i < children.length && isPlainText(children[i])) {
        parts.push(children[i].text ?? "");
        i++;
      }

      if (parts.length === 1) {
        // Nothing to merge
        result.push(child);
      } else {
        // Produce a single fused node (shallow-clone the first node)
        const merged: T = {
          ...child,
          id: child.id, // keep the first node's id for map lookups
          text: parts.join(""),
        } as T;
        result.push(merged);
      }
    } else {
      result.push(child);
      i++;
    }
  }

  return result;
}

/**
 * Estimate the rendered height of a mixed inline+block child list.
 *
 * Algorithm
 * ─────────
 * Scan `children` left-to-right maintaining a current-line word budget:
 *
 *   • INLINE primitives (XRText, XRLink, XRButton):
 *       Accumulate their word counts onto the current line.  When the line
 *       overflows `wordsPerLine`, add extra wrapped lines at `lineH`.
 *
 *   • BLOCK primitives (XRImage, XRFigure, or any unknown type):
 *       1. Flush the current inline run (add its height to totalHeight).
 *       2. Add the block primitive's own height (via `blockHeightFn`).
 *       3. Reset the inline cursor.
 *
 * After the loop, flush any remaining inline words.
 *
 * This matches the renderer's behaviour in XRParagraphMesh where inline
 * runs are grouped into a single <Text> and images are stacked below.
 *
 * @param children       Already-merged list of child primitives.
 * @param wordsPerLine   From `computeWordsPerLine(panelUsableWidth, m)`.
 * @param lineH          `m.fontSize * m.lineHeightRatio`.
 * @param vertPad        `m.verticalPadding` (added once, at the end).
 * @param blockHeightFn  Returns the height for a non-inline child.
 * @param gapY           Gap between a flushed inline block and the next block.
 */
export function estimateInlineFlowHeight(
  children: ReadonlyArray<{
    type: string;
    text?: string;
    label?: string;
    wordCount?: number;
  }>,
  wordsPerLine: number,
  lineH: number,
  vertPad: number,
  blockHeightFn: (child: {
    type: string;
    text?: string;
    label?: string;
    wordCount?: number;
  }) => number,
  gapY: number,
): number {
  if (children.length === 0) return 0;

  let totalHeight = 0;
  let inlineWords = 0;
  let firstBlock = true;

  const flushInline = (): void => {
    if (inlineWords === 0) return;
    const lineCount = Math.max(
      1,
      Math.ceil(inlineWords / Math.max(1, wordsPerLine)),
    );
    if (!firstBlock) totalHeight += gapY;
    totalHeight += lineCount * lineH;
    firstBlock = false;
    inlineWords = 0;
  };

  for (const child of children) {
    if (isInlinePrimitive(child.type)) {
      // Word count from the primitive's own field, or counted from text/label
      const wc =
        child.wordCount != null && child.wordCount > 0
          ? child.wordCount
          : countWords(
              (child as { text?: string; label?: string }).text ??
                (child as { label?: string }).label ??
                "",
            );
      inlineWords += wc;
    } else {
      // Block element — flush inline first, then account for the block
      flushInline();
      const bh = blockHeightFn(child);
      if (!firstBlock) totalHeight += gapY;
      totalHeight += bh;
      firstBlock = false;
    }
  }

  // Flush any trailing inline run
  flushInline();

  return totalHeight + vertPad;
}
