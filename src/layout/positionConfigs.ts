// ── PRIMITIVE_CONFIG registry ─────────────────────────────────────────────────
// One entry per XRPrimitiveType. Controls height estimation strategy, pagination
// behavior, padding ownership, and landmark slot assignment.

import type {
  SemanticScene,
  XRHeading,
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
  countWords,
  estimateInlineFlowHeight,
  estimateTextBearingHeight,
  FIXED_HEIGHT_LOOKUP,
  flattenInlineWrappers,
  isInlinePrimitive,
  listItemLabelBlockHeight,
  mergeAdjacentTextRuns,
} from "./utils";

export const LIST_ITEM_PROSE_INSET = 0.014;

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
  const lineH2 = metrics.paragraph.fontSize * metrics.paragraph.lineHeightRatio;
  if (primitive.children.length > 0) {
    const contentHeight = estimateMixedContentHeight(
      flattenAndMerge(primitive.children),
      panelUsableWidth - LIST_ITEM_PROSE_INSET,
      panelUsableWidth,
      metrics,
      config,
      ancestors,
      scene,
    );
    return Math.max(lineH2 + 0.02, contentHeight);
  }
  const labelBlockHeight = listItemLabelBlockHeight(primitive.label, metrics);
  return Math.max(
    lineH2 + 0.02,
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
  _panelUsableWidth: number,
  metrics: RenderMetrics,
): number {
  const text = primitive.content ?? primitive.label ?? "";
  const lineCount = Math.max(1, text.split("\n").length);
  const m = metrics.codeBlock;
  const lineH = m.fontSize * m.lineHeightRatio;
  return Math.max(
    metrics.fallbackElementHeight,
    lineCount * lineH + m.verticalPadding,
  );
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
  const lineH = m.fontSize * m.lineHeightRatio;

  if (hasAnyInline) {
    // Cast: XRPrimitive.label is `string | null`; estimateInlineFlowHeight expects `string | undefined`.
    return estimateInlineFlowHeight(
      merged as Parameters<typeof estimateInlineFlowHeight>[0],
      wordsPerLine,
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
          ? Math.max(0.025, panelUsableWidth - config.panelPaddingX * 2)
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
    }
  }

  // ── Universal fallback for types not in PRIMITIVE_CONFIG ──────────────────
  // (XRScene root, future unknown primitives)
  const fixedFloor = FIXED_HEIGHT_LOOKUP(metrics)[primitive.type];

  if (primitive.children.length > 0) {
    const childEstimateWidth = Math.max(
      0.025,
      panelUsableWidth - config.panelPaddingX * 2,
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
    heightStrategy: "children",
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
    heightStrategy: "fixed",
    fixedHeight: (m) => m.image.height,
    paginate: "atomic",
    ownsXPadding: true,
    ownsTopPadding: true,
    slot: "main",
  },
  XRCodeBlock: {
    heightStrategy: "custom",
    customHandler: (p, w, m) => _estimateCodeBlockHeight(p, w, m),
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
    ownsTopPadding: true,
    slot: "main",
  },
  XRArticle: {
    heightStrategy: "children",
    paginate: "recursive",
    ownsXPadding: true,
    ownsTopPadding: true,
    slot: "main",
  },
  XRGenericPanel: {
    heightStrategy: "children",
    paginate: "recursive",
    ownsXPadding: true,
    ownsTopPadding: true,
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
