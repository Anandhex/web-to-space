// ── PRIMITIVE_CONFIG registry ─────────────────────────────────────────────────
// One entry per XRPrimitiveType. Controls height estimation strategy, pagination
// behavior, padding ownership, and landmark slot assignment.

import type {
  SemanticScene,
  XRHeading,
  XRImage,
  XRMediaPlayer,
  XRPrimitive,
  XRTable,
  XRText,
} from "../mapper/types";
import type {
  LayoutConfig,
  PrimitiveConfig,
  PrimitiveFontMetrics,
  RenderMetrics,
} from "./types";
import {
  computeWordsPerLine,
  containerInsetX,
  countWords,
  estimateInlineFlowHeight,
  estimateTextBearingHeight,
  FIXED_HEIGHT_LOOKUP,
  flattenInlineWrappers,
  isInlinePrimitive,
  listItemLabelBlockHeight,
  mergeAdjacentTextRuns,
  resolveListColumns,
} from "./utils";

// ── Custom height handlers (extracted from estimateHeight branches) ────────────

function _estimateHeadingHeight(
  primitive: XRPrimitive,
  panelUsableWidth: number,
  metrics: RenderMetrics,
  config: LayoutConfig,
  ancestors: Set<string>,
  scene?: SemanticScene,
): number {
  const level = ((primitive as XRHeading).level ?? 2) as 1 | 2 | 3 | 4 | 5 | 6;
  const m = metrics.heading[level] ?? metrics.heading[2] ?? metrics.paragraph;
  const lineH = m.fontSize * m.lineHeightRatio;
  const minH = lineH + m.verticalPadding;
  if (primitive.children.length > 0) {
    return Math.max(
      minH,
      estimateMixedContentHeight(
        flattenAndMerge(primitive.children),
        panelUsableWidth,
        panelUsableWidth,
        metrics,
        config,
        ancestors,
        scene,
        m,
      ),
    );
  }
  const wordCount = countWords(primitive.content ?? primitive.label ?? "");
  const wpl = computeWordsPerLine(panelUsableWidth, m);
  return Math.max(
    minH,
    Math.ceil(Math.max(1, wordCount) / wpl) * lineH + m.verticalPadding,
  );
}

function _estimateBlockQuoteHeight(
  primitive: XRPrimitive,
  panelUsableWidth: number,
  metrics: RenderMetrics,
  config: LayoutConfig,
  ancestors: Set<string>,
  scene?: SemanticScene,
): number {
  const m = metrics.blockQuote;
  const lineH = m.fontSize * m.lineHeightRatio;
  const minH = lineH + m.verticalPadding;
  if (primitive.children.length > 0) {
    // XRBlockQuoteMesh flows its prose at panelWidth − X_INSET with an extra
    // X_INSET left inset (see block.tsx), i.e. a usable width of w − 2·X_INSET.
    // Estimate at that SAME narrower width or the engine under-counts lines and
    // the last line/footer overflows behind the following block.
    const flowW = Math.max(0.05, panelUsableWidth - 2 * BLOCKQUOTE_X_INSET);
    return Math.max(
      minH,
      estimateMixedContentHeight(
        flattenAndMerge(primitive.children),
        flowW,
        panelUsableWidth,
        metrics,
        config,
        ancestors,
        scene,
        m,
      ),
    );
  }
  return minH;
}

function _estimateLinkHeight(
  primitive: XRPrimitive,
  panelUsableWidth: number,
  metrics: RenderMetrics,
  config: LayoutConfig,
  ancestors: Set<string>,
  scene?: SemanticScene,
): number {
  if (primitive.children.length > 0) {
    return Math.max(
      metrics.link.minHeight,
      estimateMixedContentHeight(
        flattenAndMerge(primitive.children),
        panelUsableWidth,
        panelUsableWidth,
        metrics,
        config,
        ancestors,
        scene,
        metrics.link.font,
      ),
    );
  }
  return metrics.link.minHeight;
}

function _estimateButtonHeight(
  primitive: XRPrimitive,
  panelUsableWidth: number,
  metrics: RenderMetrics,
  config: LayoutConfig,
  ancestors: Set<string>,
  scene?: SemanticScene,
): number {
  if (primitive.children.length > 0) {
    return Math.max(
      metrics.button.minHeight,
      estimateMixedContentHeight(
        flattenAndMerge(primitive.children),
        panelUsableWidth,
        panelUsableWidth,
        metrics,
        config,
        ancestors,
        scene,
        metrics.button.font,
      ),
    );
  }
  return metrics.button.minHeight;
}

function _estimateListItemHeight(
  primitive: XRPrimitive,
  panelUsableWidth: number,
  metrics: RenderMetrics,
  config: LayoutConfig,
  ancestors: Set<string>,
  scene?: SemanticScene,
): number {
  const m = metrics.paragraph;
  const lineH2 = m.fontSize * m.lineHeightRatio;
  if (primitive.children.length > 0) {
    // The renderer flows item prose at (cardWidth − 2×inset): XRListItemMesh
    // passes panelWidth=(w − inset) into InlineProseRows, which then subtracts
    // xInset=inset again. The estimate must wrap at the same width or it
    // under-counts lines and the card renders taller than reserved.
    const flat = flattenAndMerge(primitive.children);
    const inlineOnly =
      flat.length > 0 && flat.every((c) => isInlinePrimitive(c.type));
    const contentHeight = estimateMixedContentHeight(
      flat,
      panelUsableWidth - metrics.listItemProseInset * 2,
      panelUsableWidth,
      metrics,
      config,
      ancestors,
      scene,
    );

    // The card supplies its own vertical padding via metrics.listItemContentPad
    // (top) plus a bottom pad below. estimateMixedContentHeight also folds in the
    // standalone-paragraph m.verticalPadding — appropriate for a bare paragraph,
    // but stacked on top of the card's own padding it DOUBLE-pads, inflating every
    // single-line value chip (e.g. an infobox "Directed by" name) into a tall card
    // and leaving big vertical gaps. For inline prose, strip that paragraph
    // padding and size from the real text height instead.
    if (inlineOnly) {
      const textH = Math.max(lineH2, contentHeight - m.verticalPadding);
      const lines = Math.max(1, Math.round(textH / lineH2));
      // A single-line value can't wrap-mispredict, so it needs no clip cushion —
      // just a tight bottom pad. This keeps infobox value chips compact instead
      // of each single name reserving a tall, mostly-empty card. Multi-line prose
      // falls through to the cushioned path so a wrap under-estimate can't clip.
      if (lines <= 1) {
        return Math.max(
          lineH2 + metrics.listItemMinPad,
          metrics.listItemContentPad + textH + metrics.listItemContentPad,
        );
      }
    }

    // Multi-line prose / mixed / block content: keep the measured height plus a
    // cushion (m.verticalPadding is already inside contentHeight) that covers a
    // one-line wrap under-estimate so the last line isn't clipped.
    const cushionShortfall =
      Math.max(0, lineH2 - m.verticalPadding) + metrics.listItemWrapCushion;
    return Math.max(
      lineH2 + metrics.listItemMinPad,
      metrics.listItemContentPad + contentHeight + cushionShortfall,
    );
  }
  const labelBlockHeight = listItemLabelBlockHeight(primitive.label, metrics);
  return Math.max(
    lineH2 + metrics.listItemMinPad,
    labelBlockHeight ||
      estimateTextBearingHeight(
        primitive.content ?? primitive.label ?? "",
        panelUsableWidth,
        metrics.listItem,
        metrics.fallbackElementHeight,
      ),
  );
}

function _estimateAlertHeight(
  primitive: XRPrimitive,
  panelUsableWidth: number,
  metrics: RenderMetrics,
  config: LayoutConfig,
  ancestors: Set<string>,
  scene?: SemanticScene,
): number {
  const tb = metrics.alert;
  const labelHeight = estimateTextBearingHeight(
    primitive.label ?? "",
    panelUsableWidth,
    tb,
    metrics.fallbackElementHeight,
  );
  if (primitive.children.length > 0) {
    const flattened = flattenAndMerge(primitive.children);
    if (flattened.some((c) => isInlinePrimitive(c.type))) {
      return (
        config.panelPaddingTop * 2 +
        estimateMixedContentHeight(
          flattened,
          panelUsableWidth - 0.02,
          panelUsableWidth,
          metrics,
          config,
          ancestors,
          scene,
        )
      );
    }
    const childrenHeight =
      sumChildrenHeights(
        primitive.children,
        panelUsableWidth,
        metrics,
        config,
        ancestors,
        scene,
      ) +
      config.panelPaddingTop * 2;
    return Math.max(labelHeight, childrenHeight);
  }
  return labelHeight;
}
function _estimateCodeBlockHeight(
  primitive: XRPrimitive,
  panelUsableWidth: number,
  metrics: RenderMetrics,
  config: LayoutConfig,
  ancestors: Set<string>,
  scene?: SemanticScene,
): number {
  const m = metrics.codeBlock;
  const lineH = m.fontSize * m.lineHeightRatio;
  const minH = Math.max(metrics.fallbackElementHeight, lineH + m.verticalPadding);
  if (primitive.children.length > 0) {
    return Math.max(
      minH,
      estimateMixedContentHeight(
        flattenAndMerge(primitive.children),
        panelUsableWidth,
        panelUsableWidth,
        metrics,
        config,
        ancestors,
        scene,
        m,
      ),
    );
  }
  const text = primitive.content ?? primitive.label ?? "";
  const lineCount = Math.max(1, text.split("\n").length);
  return Math.max(minH, lineCount * lineH + m.verticalPadding);
}

// Icon-sized images (e.g. Wikipedia's Coxeter-Dynkin diagram node/edge glyphs,
// typically ~9x23px) are structurally <img> elements but visually inline
// icons, not photos. Reserving the standard fixed photo height per glyph
// inflates a run of several stacked icons into metres of height — several
// XRImage children inside one wrapper each independently claiming a full
// photo's height — which was causing massive page overflow and sibling-row
// overlap in image galleries built from runs of tiny icon images. Any image
// whose larger intrinsic dimension is below ICON_MAX_PX is sized off the
// body-text line height instead of the full-photo fixed height.
const ICON_MAX_PX = 40;

// Shared with stackChildrenSimple (engine.ts): a container whose children are
// ALL icon-sized images (e.g. every glyph in a Coxeter-Dynkin diagram run) is
// laid out as a horizontal strip there instead of the default vertical stack.
// Same threshold as the height estimate above so a glyph never gets stacked
// full-width by one code path while being sized as an icon by the other.
export function isIconSizedImage(primitive: XRPrimitive): boolean {
  if (primitive.type !== "XRImage") return false;
  const img = primitive as XRImage;
  const iw = img.intrinsicWidth;
  const ih = img.intrinsicHeight;
  return iw !== null && ih !== null && Math.max(iw, ih) <= ICON_MAX_PX;
}

// Intrinsic pixel width that maps to a profile's default image height. A source
// image published at this width renders at metrics.image.height; smaller images
// render proportionally smaller (so a ~40 px decorative star no longer inflates
// to a full-height, blurry photo), larger ones clamp to the max. Tied to
// metrics.image.height so it scales across device profiles automatically.
const IMAGE_REFERENCE_PX = 300;

/**
 * Resolve the physical display size (metres) of an image from its intrinsic
 * pixel dimensions, preserving aspect ratio and clamping so it never exceeds
 * the available width or the profile's max image height, and never shrinks
 * below one text line.
 *
 * Shared by the height estimate (_estimateImageHeight) and the placement
 * (attachResolvedStrategies in engine.ts) so the space reserved matches the
 * plane the renderer draws — the renderer reads entry.size directly, so an
 * aspect-correct entry.size is drawn aspect-correct with no stretching.
 *
 * When intrinsic dimensions are unknown, falls back to the legacy full-width ×
 * fixed-height box (we can't do better without knowing the source aspect).
 */
/** Font size (metres) used to render a figure caption under an image. */
export const IMAGE_CAPTION_FONT_SIZE = 0.016;

/**
 * Left inset (metres) XRBlockQuoteMesh flows its prose at (must match X_INSET in
 * block.tsx). The mesh wraps at w − 2·X_INSET, so the height estimator uses the
 * same width to avoid under-counting lines (which overflowed behind the code).
 */
export const BLOCKQUOTE_X_INSET = 0.026;

/**
 * Height (metres) of the caption band drawn beneath a captioned image. Shared by
 * the layout engine (which reserves this space in the image entry) and the
 * renderer (which draws the caption into it) so the two never disagree. Returns
 * 0 for images with no caption.
 */
export function imageCaptionBandHeight(
  caption: string | null | undefined,
  width: number,
): number {
  if (!caption) return 0;
  const fs = IMAGE_CAPTION_FONT_SIZE;
  const lineH = fs * 1.35;
  const topPad = 0.008;
  // Rough proportional-glyph estimate (~0.5·fontSize average advance), matching
  // the wrapping the renderer's troika <Text> will produce at this width.
  const charsPerLine = Math.max(1, Math.floor(width / (fs * 0.5)));
  const lines = Math.min(3, Math.max(1, Math.ceil(caption.length / charsPerLine)));
  return topPad + lines * lineH;
}

export function resolveImageDisplaySize(
  intrinsicWidth: number | null,
  intrinsicHeight: number | null,
  availableWidth: number,
  metrics: RenderMetrics,
): { width: number; height: number } {
  const maxH = metrics.image.height;
  if (
    intrinsicWidth === null ||
    intrinsicHeight === null ||
    intrinsicWidth <= 0 ||
    intrinsicHeight <= 0
  ) {
    return { width: availableWidth, height: maxH };
  }
  const aspect = intrinsicWidth / intrinsicHeight;
  const pxToM = maxH / IMAGE_REFERENCE_PX;
  let w = intrinsicWidth * pxToM;
  let h = intrinsicHeight * pxToM;
  // Clamp height to the profile max, then width to what's available, preserving
  // aspect at each step.
  if (h > maxH) {
    h = maxH;
    w = h * aspect;
  }
  if (w > availableWidth) {
    w = availableWidth;
    h = w / aspect;
  }
  // Floor at one text line so a tiny thumbnail stays legible rather than
  // collapsing to a sliver.
  const lineH = metrics.paragraph.fontSize * metrics.paragraph.lineHeightRatio;
  if (h < lineH) {
    h = lineH;
    w = Math.min(availableWidth, h * aspect);
  }
  return { width: w, height: h };
}

function _estimateImageHeight(
  primitive: XRPrimitive,
  panelUsableWidth: number,
  metrics: RenderMetrics,
): number {
  const img = primitive as XRImage;
  const { height } = resolveImageDisplaySize(
    img.intrinsicWidth,
    img.intrinsicHeight,
    panelUsableWidth,
    metrics,
  );
  // Reserve room for a <figcaption> band beneath the image so the caption the
  // renderer draws isn't clipped or overlapping the next element. The renderer
  // wraps the caption at the entry's full width, so reserve at that same width.
  return height + imageCaptionBandHeight(img.caption, panelUsableWidth);
}

function _estimateFigureHeight(
  primitive: XRPrimitive,
  panelUsableWidth: number,
  metrics: RenderMetrics,
  config: LayoutConfig,
): number {
  const imageH = metrics.image.height;
  const captionLabel = (primitive.label ?? "").trim();
  if (!captionLabel) return imageH;
  const m = metrics.figureCaption;
  const wordCount = countWords(captionLabel);
  const captionH =
    wordCount === 0
      ? 0
      : Math.ceil(wordCount / computeWordsPerLine(panelUsableWidth, m)) *
          m.fontSize *
          m.lineHeightRatio +
        m.verticalPadding;
  return imageH + config.childGapY + captionH;
}

export function flattenAndMerge(children: XRPrimitive[]): XRPrimitive[] {
  return mergeAdjacentTextRuns(
    flattenInlineWrappers(children as any[]) as any[],
  ) as XRPrimitive[];
}

// ─────────────────────────────────────────────────────────────
// Layout configuration (spatial parameters, not render metrics)
// ─────────────────────────────────────────────────────────────

// Shared inline-flow-or-stack estimator used by XRParagraph, XRHeading,
// XRBlockQuote, XRListItem, XRAlert, and the universal fallback.
// Caller pre-flattens with flattenAndMerge.
// flowWidth    — width for word-count→line conversion (may be inset).
// blockWidth   — width forwarded to estimateHeight for block children.
// fontMetrics  — override metrics.paragraph for callers with their own font
//                (heading level, blockquote, link, button).
function estimateMixedContentHeight(
  merged: XRPrimitive[],
  flowWidth: number,
  blockWidth: number,
  metrics: RenderMetrics,
  config: LayoutConfig,
  ancestors: Set<string>,
  scene: SemanticScene | undefined,
  fontMetrics?: PrimitiveFontMetrics,
): number {
  const hasAnyInline = merged.some((c) => isInlinePrimitive(c.type));
  const hasAnyBlock = merged.some((c) => !isInlinePrimitive(c.type));
  const m = fontMetrics ?? metrics.paragraph;
  const wordsPerLine = computeWordsPerLine(flowWidth, m);
  // Real columns per line — drives greedy token wrapping (long ISBNs/URLs).
  const charsPerLine = Math.max(
    1,
    Math.floor(flowWidth / (m.fontSize * m.charWidthRatio)),
  );
  const lineH = m.fontSize * m.lineHeightRatio;

  if (hasAnyInline) {
    // Cast: XRPrimitive.label is `string | null`; estimateInlineFlowHeight expects `string | undefined`.
    return estimateInlineFlowHeight(
      merged as Parameters<typeof estimateInlineFlowHeight>[0],
      wordsPerLine,
      charsPerLine,
      lineH,
      m.verticalPadding,
      hasAnyBlock
        ? (child) =>
            estimateHeight(
              child as XRPrimitive,
              blockWidth,
              metrics,
              config,
              new Set(ancestors),
              scene,
            )
        : () => metrics.fallbackElementHeight,
      hasAnyBlock ? config.childGapY : 0,
    );
  }

  return sumChildrenHeights(
    merged,
    blockWidth,
    metrics,
    config,
    ancestors,
    scene,
  );
}

// Config-driven dispatcher. All type-specific logic lives in PRIMITIVE_CONFIG
// and the _estimate* handlers above. The universal fallback handles any type
// not yet in the registry (unknown future primitives, XRScene root, etc.).
export function estimateHeight(
  primitive: XRPrimitive,
  panelUsableWidth: number,
  metrics: RenderMetrics,
  config: LayoutConfig,
  ancestors: Set<string> = new Set(),
  scene?: SemanticScene,
): number {
  if (ancestors.has(primitive.id)) return metrics.fallbackElementHeight;
  ancestors.add(primitive.id);

  const cfg = PRIMITIVE_CONFIG[primitive.type];

  if (cfg) {
    switch (cfg.heightStrategy) {
      case "custom":
        return cfg.customHandler!(
          primitive,
          panelUsableWidth,
          metrics,
          config,
          ancestors,
          scene,
        );

      case "mixed": {
        const m = cfg.fontMetrics
          ? cfg.fontMetrics(primitive, metrics)
          : metrics.paragraph;
        if (primitive.children.length > 0) {
          const flowW = panelUsableWidth - (cfg.flowWidthInset ?? 0);
          const h = estimateMixedContentHeight(
            flattenAndMerge(primitive.children),
            flowW,
            panelUsableWidth,
            metrics,
            config,
            ancestors,
            scene,
            m,
          );
          return cfg.minHeight ? Math.max(cfg.minHeight(metrics), h) : h;
        }
        // Fallback: no children — estimate from label text.
        const wordCount = countWords(
          primitive.content ?? primitive.label ?? "",
        );
        const wpl = computeWordsPerLine(panelUsableWidth, m);
        const lineH = m.fontSize * m.lineHeightRatio;
        const fromLabel =
          Math.ceil(Math.max(1, wordCount) / wpl) * lineH + m.verticalPadding;
        const floor = cfg.minHeight
          ? cfg.minHeight(metrics)
          : lineH + m.verticalPadding;
        return Math.max(floor, fromLabel);
      }

      case "text": {
        // XRText: synthetic nodes carry __fm with the right font metrics.
        if (primitive.type === "XRText") {
          const text = (primitive as XRText).text || "";
          const wordCount = countWords(text);
          const m: PrimitiveFontMetrics =
            (primitive as unknown as { __fm?: PrimitiveFontMetrics }).__fm ??
            metrics.paragraph;
          const lineH = m.fontSize * m.lineHeightRatio;
          if (wordCount === 0) return lineH + m.verticalPadding;
          const wordsPerLine = computeWordsPerLine(panelUsableWidth, m);
          const lineCount = Math.ceil(wordCount / Math.max(1, wordsPerLine));
          return Math.max(
            lineH + m.verticalPadding,
            lineCount * lineH + m.verticalPadding,
          );
        }
        // Other text-bearing interactive elements (XRTab, XRMenuItem, etc.)
        const tb = cfg.textBearing!(metrics);
        return _estimateTextBearingItemHeight(
          tb,
          primitive,
          panelUsableWidth,
          metrics,
          config,
          ancestors,
          scene,
        );
      }

      case "fixed":
        return cfg.fixedHeight!(metrics);

      case "children": {
        const childEstimateWidth = cfg.ownsXPadding
          ? Math.max(
              0.025,
              panelUsableWidth -
                containerInsetX(panelUsableWidth, config.panelPaddingX) * 2,
            )
          : panelUsableWidth;
        const paddingContrib = cfg.ownsTopPadding
          ? config.panelPaddingTop * 2
          : 0;
        const fixedFloor = FIXED_HEIGHT_LOOKUP(metrics)[primitive.type];
        if (primitive.children.length > 0) {
          const fromChildren =
            paddingContrib +
            estimateMixedContentHeight(
              flattenAndMerge(primitive.children),
              childEstimateWidth,
              childEstimateWidth,
              metrics,
              config,
              ancestors,
              scene,
            );
          return fixedFloor !== undefined
            ? Math.max(fixedFloor, fromChildren)
            : Math.max(metrics.fallbackElementHeight, fromChildren);
        }
        const labelText = primitive.content ?? primitive.label ?? "";
        if (labelText.trim() !== "") {
          const wordCount = countWords(labelText);
          const m = metrics.paragraph;
          const lineH = m.fontSize * m.lineHeightRatio;
          // No m.verticalPadding here: that constant represents a real
          // paragraph's own space before/after it, which is wrong for this
          // fallback — a bare unmapped text leaf (e.g. a <time> caption with
          // no ARIA role) that already gets normal childGapY spacing from its
          // siblings. Including it double-counted spacing and left a dead
          // gap around short captions like "3 weeks ago".
          const fromLabel =
            Math.max(
              1,
              Math.ceil(wordCount / computeWordsPerLine(panelUsableWidth, m)),
            ) * lineH;
          return fixedFloor !== undefined
            ? Math.max(fixedFloor, fromLabel)
            : fromLabel;
        }
        return fixedFloor ?? metrics.fallbackElementHeight;
      }
    }
  }

  // ── Universal fallback for types not in PRIMITIVE_CONFIG ──────────────────
  // (XRScene root, future unknown primitives)
  const fixedFloor = FIXED_HEIGHT_LOOKUP(metrics)[primitive.type];

  if (primitive.children.length > 0) {
    const childEstimateWidth = Math.max(
      0.025,
      panelUsableWidth -
        containerInsetX(panelUsableWidth, config.panelPaddingX) * 2,
    );
    const fromChildren =
      config.panelPaddingTop * 2 +
      estimateMixedContentHeight(
        flattenAndMerge(primitive.children),
        childEstimateWidth,
        childEstimateWidth,
        metrics,
        config,
        ancestors,
        scene,
      );
    return fixedFloor !== undefined
      ? Math.max(fixedFloor, fromChildren)
      : Math.max(metrics.fallbackElementHeight, fromChildren);
  }

  const labelText = primitive.content ?? primitive.label ?? "";
  if (labelText.trim() !== "") {
    const wordCount = countWords(labelText);
    const m = metrics.paragraph;
    const lineH = m.fontSize * m.lineHeightRatio;
    const fromLabel =
      Math.max(
        1,
        Math.ceil(wordCount / computeWordsPerLine(panelUsableWidth, m)),
      ) *
        lineH +
      m.verticalPadding;
    return fixedFloor !== undefined
      ? Math.max(fixedFloor, fromLabel)
      : fromLabel;
  }

  return fixedFloor ?? metrics.fallbackElementHeight;
}

export function sumChildrenHeights(
  children: XRPrimitive[],
  panelUsableWidth: number,
  metrics: RenderMetrics,
  config: LayoutConfig,
  ancestors: Set<string>,
  scene?: SemanticScene,
): number {
  if (children.length === 0) return 0;

  const merged = flattenAndMerge(children);

  // Mirrors stackChildrenSimple's inline icon-image strip (engine.ts): when
  // every child is an icon-sized image (e.g. a Coxeter-Dynkin diagram's
  // node/edge glyph run), that container is actually placed as ONE
  // horizontal row, not a vertical stack. Summing each glyph's height here
  // as if they were stacked overestimates the reserved space by roughly the
  // glyph count, budgeting several times more page room than the row
  // actually occupies once placed.
  if (merged.length > 1 && merged.every(isIconSizedImage)) {
    const lineH = metrics.paragraph.fontSize * metrics.paragraph.lineHeightRatio;
    let rowH = 0;
    for (const child of merged as unknown as XRImage[]) {
      const iw = child.intrinsicWidth ?? 1;
      const ih = child.intrinsicHeight ?? 1;
      rowH = Math.max(rowH, Math.min(lineH, lineH * (ih / iw)));
    }
    return rowH;
  }

  let totalHeight = 0;
  for (let i = 0; i < merged.length; i++) {
    const child = merged[i];
    const childHeight = estimateHeight(
      child,
      panelUsableWidth,
      metrics,
      config,
      new Set(ancestors),
      scene,
    );
    const validHeight =
      childHeight && childHeight > 0 && isFinite(childHeight)
        ? childHeight
        : metrics.fallbackElementHeight;
    totalHeight += validHeight;
    if (i < merged.length - 1) {
      totalHeight += config.childGapY;
    }
  }
  return totalHeight;
}

// XRList used the generic "children" height strategy (sumChildrenHeights),
// which sums every item's height sequentially as if the list were a single
// column. But when the list renders as a multi-column card grid (columns
// resolved the same way placeListGrid resolves them at placement time), the
// real total height is only `rows` items tall, not `items` items tall — the
// naive sum overestimated by roughly a factor of `columns`, over-reserving
// vertical space during pagination budgeting and leaving genuinely-empty
// trailing pages once the real grid placement finished sooner than the
// (wrong) estimate predicted.
function _estimateListHeight(
  primitive: XRPrimitive,
  panelUsableWidth: number,
  metrics: RenderMetrics,
  config: LayoutConfig,
  ancestors: Set<string>,
  scene?: SemanticScene,
): number {
  const paddingContrib = config.panelPaddingTop * 2;
  if (primitive.children.length === 0) return paddingContrib;

  const childEstimateWidth = Math.max(
    0.025,
    panelUsableWidth -
      containerInsetX(panelUsableWidth, config.panelPaddingX) * 2,
  );
  const columns = resolveListColumns(childEstimateWidth, metrics);
  const cardWidth = Math.max(
    0.025,
    (childEstimateWidth - config.childGapY * (columns - 1)) / columns,
  );
  const itemHeights = primitive.children.map((child) =>
    estimateHeight(child, cardWidth, metrics, config, new Set(ancestors), scene),
  );

  let totalRowHeight = 0;
  let rowCount = 0;
  for (let i = 0; i < itemHeights.length; i += columns) {
    const rowItems = itemHeights.slice(i, i + columns);
    totalRowHeight += Math.max(...rowItems);
    rowCount += 1;
  }
  const gapTotal = config.childGapY * Math.max(0, rowCount - 1);
  return paddingContrib + totalRowHeight + gapTotal;
}

function _estimateMediaHeight(
  primitive: XRPrimitive,
  _panelUsableWidth: number,
  metrics: RenderMetrics,
  _config: LayoutConfig,
  _ancestors: Set<string>,
  scene?: SemanticScene,
): number {
  const player = primitive as XRMediaPlayer & {
    sizingStrategy?: string;
    mediaRole?: string;
  };
  if (player.sizingStrategy === "large-panel")
    return metrics.mediaPlayerLarge.height;
  if (player.sizingStrategy === "ambient") return 0;
  if (player.sizingStrategy === "compact")
    return metrics.mediaPlayerCompact.height;
  if (player.mediaRole === "ambient") return 0;
  const parentId = (player as unknown as { parentId?: string }).parentId;
  if (parentId) {
    const parentPrimitive = (
      scene as SemanticScene & { primitives: Record<string, XRPrimitive> }
    ).primitives[parentId];
    if (parentPrimitive) {
      const siblings = parentPrimitive.children;
      const isOnlyMediaChild =
        siblings.length === 1 ||
        siblings.every(
          (s: XRPrimitive) => s.id === player.id || s.type === "XRMediaPlayer",
        );
      if (parentPrimitive.type === "XRContentPanel" && isOnlyMediaChild)
        return metrics.mediaPlayerLarge.height;
      if (siblings.length >= 4) return metrics.mediaPlayerCompact.height;
    }
  }
  return metrics.mediaPlayerCompact.height;
}


export function _estimateTextBearingItemHeight(
  tb: import("./types").TextBearingMetrics,
  primitive: XRPrimitive,
  panelUsableWidth: number,
  metrics: RenderMetrics,
  config: LayoutConfig,
  ancestors: Set<string>,
  scene?: SemanticScene,
): number {
  const labelHeight = estimateTextBearingHeight(
    primitive.label ?? "",
    panelUsableWidth,
    tb,
    metrics.fallbackElementHeight,
  );
  if (primitive.children.length > 0) {
    const childrenHeight =
      sumChildrenHeights(
        primitive.children,
        panelUsableWidth,
        metrics,
        config,
        ancestors,
        scene,
      ) +
      config.panelPaddingTop * 2;
    return Math.max(labelHeight, childrenHeight);
  }
  return labelHeight;
}
function _estimateTableHeight(
  primitive: XRPrimitive,
  panelUsableWidth: number,
  metrics: RenderMetrics,
  config: LayoutConfig,
  ancestors: Set<string>,
  scene?: SemanticScene,
): number {
  const { rowCount } = primitive as XRTable;
  // paddingContrib mirrors stackChildrenSimple: ownsTopPadding=true adds
  // panelPaddingTop at the top and an equal amount at the bottom.
  const paddingContrib = config.panelPaddingTop * 2;
  const fixedRowsHeight =
    paddingContrib +
    metrics.tableHeaderRowHeight +
    Math.max(0, rowCount - 1) * metrics.tableRowHeight +
    Math.max(0, rowCount - 1) * config.childGapY;
  const contentHeight =
    primitive.children.length > 0
      ? paddingContrib +
        sumChildrenHeights(
          primitive.children,
          panelUsableWidth,
          metrics,
          config,
          ancestors,
          scene,
        )
      : 0;
  return Math.max(fixedRowsHeight, contentHeight);
}

export const PRIMITIVE_CONFIG: Partial<
  Record<import("../mapper/types").XRPrimitiveType, PrimitiveConfig>
> = {
  // ── Text primitives ────────────────────────────────────────────────────────
  XRText: {
    heightStrategy: "text",
    textBearing: (m) => ({
      minHeight: m.fallbackElementHeight,
      font: m.paragraph,
    }),
    paginate: "atomic",
    ownsXPadding: false,
    ownsTopPadding: false,
    slot: "main",
  },
  XRParagraph: {
    heightStrategy: "mixed",
    fontMetrics: (_p, m) => m.paragraph,
    paginate: "split",
    ownsXPadding: false,
    ownsTopPadding: false,
    slot: "main",
  },
  XRHeading: {
    heightStrategy: "custom",
    customHandler: _estimateHeadingHeight,
    paginate: "split",
    ownsXPadding: false,
    ownsTopPadding: false,
    slot: "main",
  },
  XRBlockQuote: {
    heightStrategy: "custom",
    customHandler: _estimateBlockQuoteHeight,
    paginate: "split",
    ownsXPadding: false,
    ownsTopPadding: false,
    slot: "main",
  },
  XRLink: {
    heightStrategy: "custom",
    customHandler: _estimateLinkHeight,
    paginate: "split",
    ownsXPadding: false,
    ownsTopPadding: false,
    slot: "main",
  },
  XRButton: {
    heightStrategy: "custom",
    customHandler: _estimateButtonHeight,
    paginate: "split",
    ownsXPadding: false,
    ownsTopPadding: false,
    slot: "main",
  },
  // ── List ───────────────────────────────────────────────────────────────────
  XRListItem: {
    heightStrategy: "custom",
    customHandler: _estimateListItemHeight,
    paginate: "atomic",
    ownsXPadding: false,
    ownsTopPadding: false,
    slot: "main",
  },
  XRList: {
    heightStrategy: "custom",
    customHandler: _estimateListHeight,
    paginate: "recursive",
    ownsXPadding: true,
    ownsTopPadding: true,
    slot: "main",
  },
  // ── Table ──────────────────────────────────────────────────────────────────
  XRTable: {
    heightStrategy: "custom",
    customHandler: _estimateTableHeight,
    paginate: "atomic",
    ownsXPadding: true,
    ownsTopPadding: true,
    slot: "main",
  },
  XRTableRow: {
    heightStrategy: "children",
    paginate: "recursive",
    ownsXPadding: false,
    ownsTopPadding: false,
    slot: "main",
  },
  XRTableCell: {
    heightStrategy: "mixed",
    fontMetrics: (_p, m) => m.paragraph,
    paginate: "recursive",
    ownsXPadding: false,
    ownsTopPadding: false,
    slot: "main",
  },
  // ── Media ──────────────────────────────────────────────────────────────────
  XRMediaPlayer: {
    heightStrategy: "custom",
    customHandler: _estimateMediaHeight,
    paginate: "atomic",
    ownsXPadding: true,
    ownsTopPadding: true,
    slot: "main",
  },
  XRFigure: {
    heightStrategy: "custom",
    customHandler: (p, w, m, c) => _estimateFigureHeight(p, w, m, c),
    paginate: "recursive",
    ownsXPadding: true,
    ownsTopPadding: true,
    slot: "main",
  },
  XRImage: {
    heightStrategy: "custom",
    customHandler: _estimateImageHeight,
    paginate: "atomic",
    ownsXPadding: true,
    ownsTopPadding: true,
    slot: "main",
  },
  XRCodeBlock: {
    heightStrategy: "custom",
    customHandler: _estimateCodeBlockHeight,
    paginate: "atomic",
    ownsXPadding: true,
    ownsTopPadding: true,
    slot: "main",
  },
  // ── Interactive text-bearing ───────────────────────────────────────────────
  XRAlert: {
    heightStrategy: "custom",
    customHandler: _estimateAlertHeight,
    paginate: "atomic",
    ownsXPadding: true,
    ownsTopPadding: true,
    slot: "alert",
  },
  XRTab: {
    heightStrategy: "text",
    textBearing: (m) => m.tab,
    paginate: "atomic",
    ownsXPadding: false,
    ownsTopPadding: false,
    slot: "main",
  },
  XRMenuItem: {
    heightStrategy: "text",
    textBearing: (m) => m.menuItem,
    paginate: "atomic",
    ownsXPadding: false,
    ownsTopPadding: false,
    slot: "main",
  },
  XRTreeItem: {
    heightStrategy: "text",
    textBearing: (m) => m.treeItem,
    paginate: "atomic",
    ownsXPadding: false,
    ownsTopPadding: false,
    slot: "main",
  },
  XRTooltip: {
    heightStrategy: "text",
    textBearing: (m) => m.tooltip,
    paginate: "atomic",
    ownsXPadding: false,
    ownsTopPadding: false,
    slot: "main",
  },
  // ── Fixed-height interactive ───────────────────────────────────────────────
  XRToggle: {
    heightStrategy: "fixed",
    fixedHeight: (m) => m.toggle.height,
    paginate: "atomic",
    ownsXPadding: false,
    ownsTopPadding: false,
    slot: "main",
  },
  XRSlider: {
    heightStrategy: "fixed",
    fixedHeight: (m) => m.slider.height,
    paginate: "atomic",
    ownsXPadding: false,
    ownsTopPadding: false,
    slot: "main",
  },
  XRComboBox: {
    heightStrategy: "fixed",
    fixedHeight: (m) => m.comboBox.height,
    paginate: "atomic",
    ownsXPadding: false,
    ownsTopPadding: false,
    slot: "main",
  },
  XRSearchBox: {
    heightStrategy: "fixed",
    fixedHeight: (m) => m.searchBox.height,
    paginate: "atomic",
    ownsXPadding: false,
    ownsTopPadding: false,
    slot: "main",
  },
  XRProgressBar: {
    heightStrategy: "fixed",
    fixedHeight: (m) => m.progressBar.height,
    paginate: "atomic",
    ownsXPadding: false,
    ownsTopPadding: false,
    slot: "main",
  },
  XRSeparator: {
    heightStrategy: "fixed",
    fixedHeight: (m) => m.separator.height,
    paginate: "atomic",
    ownsXPadding: false,
    ownsTopPadding: false,
    slot: "main",
  },
  // ── Structural containers ──────────────────────────────────────────────────
  XRContentPanel: {
    heightStrategy: "children",
    paginate: "recursive",
    ownsXPadding: true,
    ownsTopPadding: true,
    slot: "main",
  },
  XRSection: {
    heightStrategy: "children",
    paginate: "recursive",
    forceNewPage: true,
    ownsXPadding: true,
    // Top-level sections (direct children of the content panel) get their
    // page-edge padding from paginateContentPanel's own cursor/page-height
    // bookkeeping via splitSection — this flag is never consulted on that
    // path. It only fires when a section is estimated as an ordinary nested
    // child (e.g. a heading+paragraph pair structurally grouped inside an
    // XRArticle/XRListItem card), where reserving a full panel-edge padding
    // above and below produced a large dead gap with no visible boundary.
    ownsTopPadding: false,
    slot: "main",
  },
  XRArticle: {
    heightStrategy: "children",
    paginate: "recursive",
    ownsXPadding: true,
    // Same reasoning as XRSection above: XRArticle never forces its own
    // page (paginate: "recursive"), so it's always nested inside a panel or
    // list item that already provides edge padding — see PRIMITIVE_CONFIG.XRSection.
    ownsTopPadding: false,
    slot: "main",
  },
  XRGenericPanel: {
    heightStrategy: "children",
    paginate: "recursive",
    ownsXPadding: true,
    // Same reasoning as XRSection/XRArticle: XRGenericPanel never forces its
    // own page (paginate: "recursive"), so — as the catch-all wrapper for any
    // unmapped/structurally-inferred grouping — it's always nested inside a
    // panel or card that already provides edge padding.
    ownsTopPadding: false,
    slot: "main",
  },
  XRFormPanel: {
    heightStrategy: "children",
    paginate: "recursive",
    ownsXPadding: true,
    ownsTopPadding: true,
    slot: "main",
  },
  XRFormField: {
    heightStrategy: "children",
    paginate: "recursive",
    ownsXPadding: true,
    ownsTopPadding: true,
    slot: "main",
  },
  XRTabGroup: {
    heightStrategy: "fixed",
    fixedHeight: (m) => m.tabGroup.height,
    paginate: "atomic",
    ownsXPadding: true,
    ownsTopPadding: true,
    slot: "main",
  },
  XRTabPanel: {
    heightStrategy: "children",
    paginate: "atomic",
    ownsXPadding: true,
    ownsTopPadding: true,
    slot: "main",
  },
  XRMenu: {
    heightStrategy: "children",
    paginate: "atomic",
    ownsXPadding: true,
    ownsTopPadding: true,
    slot: "main",
  },
  XRTree: {
    heightStrategy: "children",
    paginate: "atomic",
    ownsXPadding: true,
    ownsTopPadding: true,
    slot: "main",
  },
  XRDialog: {
    heightStrategy: "children",
    paginate: "atomic",
    ownsXPadding: true,
    ownsTopPadding: true,
    slot: "dialog",
  },
  XRComplementary: {
    heightStrategy: "children",
    paginate: "atomic",
    ownsXPadding: true,
    ownsTopPadding: true,
    slot: "complementary",
  },
  // ── Landmarks ─────────────────────────────────────────────────────────────
  XRBanner: {
    heightStrategy: "fixed",
    fixedHeight: (m) => m.banner.height,
    paginate: "atomic",
    ownsXPadding: true,
    ownsTopPadding: true,
    slot: "banner",
  },
  XRFooter: {
    heightStrategy: "fixed",
    fixedHeight: (m) => m.footer.height,
    paginate: "atomic",
    ownsXPadding: true,
    ownsTopPadding: true,
    slot: "footer",
  },
  XRNavigationBar: {
    heightStrategy: "fixed",
    fixedHeight: (m) => m.navigationBar.height,
    paginate: "atomic",
    ownsXPadding: true,
    ownsTopPadding: true,
    slot: "navigation",
    slotFn: (p) => (p.id.startsWith("toc") ? "toc" : "navigation"),
  },
};
