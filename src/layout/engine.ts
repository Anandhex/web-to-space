/**
 * engine.ts — XR Spatial Layout Engine (v2)
 *
 * Architecture position:
 *   HTML → Parser → IR → Mapper → SemanticScene
 *                                       ↓
 *                               Layout Engine (this file)
 *                                       ↓
 *                                  LayoutPlan
 *                                       ↓
 *                                XR Renderer
 *
 * Key design changes from v1
 * ──────────────────────────
 * • All font sizes, line heights, element heights and panel dimensions are
 *   supplied via a typed `RenderMetrics` object rather than being hardcoded
 *   constants. The engine never guesses metrics — if a value is absent the
 *   engine falls back to `RenderMetrics.fallbackElementHeight` and records
 *   a diagnostic warning.
 *
 * • Named `DeviceProfile` presets (Quest 3, Quest Pro, Ray-Ban Meta, etc.)
 *   ship ready to use. Calling code can override any field.
 *
 * • Template selection lives here (not in the mapper). `selectLayoutTemplate`
 *   inspects the SemanticScene and returns the best-fit template. Callers may
 *   override via the `template` parameter of `computeLayoutPlan`.
 *
 * • Paragraph overflow produces *continuation nodes* — synthetic XRParagraph
 *   entries that carry the word-offset at which rendering should resume. The
 *   renderer uses `continuationWordOffset` to skip already-shown words and
 *   resume text mid-paragraph across page boundaries.
 *
 * • XRTable layout strategy ("flat-2d" | "curved-2d" | "scrollable" | "cards")
 *   is decided here from column/row counts and available panel width.
 *
 * • XRList column count is resolved here from child count and panel width.
 *
 * Design principles (unchanged from v1)
 * ──────────────────────────────────────
 * 1. Pure function: (SemanticScene, LayoutConfig) → LayoutPlan. No side-effects.
 * 2. XRContentPanel is the sole owner of pagination.
 * 3. All measurements in metres (WebXR right-handed coordinate system).
 * 4. Every primitive receives a LayoutEntry regardless of depth.
 *
 * Stacking architecture (v2 refactor)
 * ────────────────────────────────────
 * stackChildren() has been split into two clearly-scoped functions:
 *
 *   stackChildrenSimple(children, panelWidth, config, metrics)
 *     Pure vertical stacker. No page awareness whatsoever.
 *     Used by every container that is NOT an XRContentPanel.
 *     Returns page-relative y-positions (always resets to -panelPaddingTop
 *     at the start). Since these nodes live inside a single page slice,
 *     "page-relative" and "panel-relative" mean the same thing here.
 *
 *   paginateContentPanel(children, panelWidth, scene, config, metrics, diag)
 *     Section-aware paginator. Only ever called for XRContentPanel nodes.
 *     Emits page-relative y-positions per child — each entry's y is
 *     relative to the TOP of the page it belongs to (resets to
 *     -panelPaddingTop whenever a new page starts).
 *     The renderer therefore needs only:
 *       worldY = entry.position.y          (already page-relative)
 *       worldZ = baseZ + pageIndex * pageZStep
 *     No layout reconstruction on the renderer side.
 *
 */

import type {
  Vec3,
  Rotation3,
  Size2,
  XRPrimitive,
  XRHeading,
  XRParagraph,
  XRTable,
  XRList,
  XRMediaPlayer,
  SemanticScene,
} from "../mapper/types";
import { selectSlots } from "./slots";
import { selectLayoutTemplate } from "./templates";
import type {
  TextBearingMetrics,
  DeviceProfile,
  LayoutTemplate,
  RenderMetrics,
  LayoutEntry,
  PaginationMeta,
  LayoutDiagnostics,
  LayoutPlan,
  LayoutConfig,
  SlotName,
  SimpleStackResult,
  PaginateResult,
} from "./types";
import {
  computeWordsPerLine,
  countWords,
  estimateParagraphHeight,
  estimateTextBearingHeight,
  FIXED_HEIGHT_LOOKUP,
  paragraphWordsThatFit,
  resolveListColumns,
  resolveTableStrategy,
  splitIntoWords,
  zeroRotation,
  zeroVec,
} from "./utils";

// ─────────────────────────────────────────────────────────────
// Layout configuration (spatial parameters, not render metrics)
// ─────────────────────────────────────────────────────────────

/**
 * Estimate the rendered height of any primitive.
 *
 * Resolution order
 * ────────────────
 * 1. Type-specific formulas for primitives whose height cannot be derived from
 *    children or a label alone:
 *      XRHeading      — level-aware metrics + word-wrap
 *      XRParagraph    — word-count formula (drives pagination accuracy)
 *      XRCodeBlock    — newline count × line height
 *      XRBlockQuote   — word-count formula with blockQuote metrics
 *      XRMediaPlayer  — sizing-strategy resolution (large / compact / ambient)
 *      XRFigure       — fixed image height + caption word-wrap
 *      XRTable        — row/column formula
 *      XRList         — grid layout (columns × per-card height)
 *      text-bearing   — XRButton/XRLink/XRTab/… label wrap + children
 *
 * 2. Universal fallback (everything else — XRGenericPanel, XRSection, XRBanner,
 *    XRFooter, XRNavigationBar, XRContentPanel, and any future unknown type):
 *      Stage 1 — children present  → sum child heights recursively
 *                                    (with childGapY gaps + panelPaddingTop×2)
 *                                    floored by FIXED_HEIGHT_LOOKUP if defined
 *      Stage 2 — no children, label present → paragraph-metric word-wrap
 *                                    floored by FIXED_HEIGHT_LOOKUP if defined
 *      Stage 3 — no children, no label     → FIXED_HEIGHT_LOOKUP ?? fallback
 *
 * This means a new primitive type is automatically handled correctly without
 * any change here — as long as it has children, a label, or a fixed metric.
 *
 * @param primitive        The primitive to measure.
 * @param panelUsableWidth Width of the containing panel minus left/right padding (m).
 * @param metrics          Render metrics for the target device.
 * @param config           Layout config (needed for gap and padding values).
 * @param ancestors          Cycle guard; pass `new Set()` at the call site.
 * @param scene            Optional scene reference for context-aware decisions
 *                         (e.g. XRMediaPlayer parent lookup).
 * @returns                Estimated height in metres.
 */
function estimateHeight(
  primitive: XRPrimitive,
  panelUsableWidth: number,
  metrics: RenderMetrics,
  config: LayoutConfig,
  ancestors: Set<string> = new Set(),
  scene?: SemanticScene,
): number {
  if (ancestors.has(primitive.id)) return metrics.fallbackElementHeight;
  ancestors.add(primitive.id);

  const branchAncestors = new Set(ancestors);
  branchAncestors.add(primitive.id);

  // ── Heading ────────────────────────────────────────────────────────────────
  if (primitive.type === "XRHeading") {
    const level = ((primitive as XRHeading).level ?? 2) as
      | 1
      | 2
      | 3
      | 4
      | 5
      | 6;
    const m = metrics.heading[level] ?? metrics.heading[2] ?? metrics.paragraph;
    const lineH = m.fontSize * m.lineHeightRatio;
    const wordCount = countWords(primitive.content ?? primitive.label ?? "");
    const textHeight =
      wordCount <= 1
        ? lineH + m.verticalPadding
        : (() => {
            const wordsPerLine = computeWordsPerLine(panelUsableWidth, m);
            return (
              Math.ceil(wordCount / wordsPerLine) * lineH + m.verticalPadding
            );
          })();

    // Add block children height if present (e.g. h2>img, h3>figure)
    if (primitive.children.length > 0) {
      const childrenHeight = primitive.children.reduce(
        (sum, child) =>
          sum +
          config.childGapY +
          estimateHeight(
            child,
            panelUsableWidth,
            metrics,
            config,
            new Set(branchAncestors),
            scene,
          ),
        0,
      );
      return textHeight + childrenHeight;
    }
    return textHeight;
  }

  // ── Paragraph (word-count based) ──────────────────────────────────────────
  if (primitive.type === "XRParagraph") {
    const textHeight = estimateParagraphHeight(
      primitive as XRParagraph,
      panelUsableWidth,
      metrics,
    );
    // Add block children height (p>img, p>ul, p>div>img, etc.)
    if (primitive.children.length > 0) {
      const childrenHeight = primitive.children.reduce(
        (sum, child) =>
          sum +
          config.childGapY +
          estimateHeight(
            child,
            panelUsableWidth,
            metrics,
            config,
            new Set(branchAncestors),
            scene,
          ),
        0,
      );
      return textHeight + childrenHeight;
    }
    return textHeight;
  }

  // ── Code block (line-count based, same formula as paragraph) ──────────────
  if (primitive.type === "XRCodeBlock") {
    // Code blocks store their text in `label`; estimate lines from that.
    const text = primitive.content ?? primitive.label ?? "";
    const lineCount = Math.max(1, text.split("\n").length);
    const m = metrics.codeBlock;
    const lineH = m.fontSize * m.lineHeightRatio;
    return Math.max(
      metrics.fallbackElementHeight,
      lineCount * lineH + m.verticalPadding,
    );
  }

  // ── Block quote ────────────────────────────────────────────────────────────
  if (primitive.type === "XRBlockQuote") {
    const wordCount = countWords(primitive.content ?? primitive.label ?? "");
    if (wordCount > 0) {
      const m = metrics.blockQuote;
      const lineH = m.fontSize * m.lineHeightRatio;
      const wordsPerLine = computeWordsPerLine(panelUsableWidth, m);
      const lineCount = Math.ceil(wordCount / wordsPerLine);
      return lineCount * lineH + m.verticalPadding;
    }
    return (
      metrics.blockQuote.fontSize * metrics.blockQuote.lineHeightRatio +
      metrics.blockQuote.verticalPadding
    );
  }

  // ── Media player ────────────────────────────────────────────────────────────
  // Sizing strategy is resolved here from structural cues, not delegated to the mapper.
  //
  // Rules (in priority order):
  //   1. If the mapper already stamped a strategy, honour it (backward compat).
  //   2. A player that is the *only* child of an XRContentPanel (top-level) and
  //      has no sibling text → "large-panel" (immersive cinema mode).
  //   3. A player whose parent has ≥ 3 other children → "compact" (inline/embedded).
  //   4. A player tagged as background/ambient (mediaRole === "ambient") → "ambient".
  //   5. Default → "compact".
  if (primitive.type === "XRMediaPlayer") {
    const player = primitive as XRMediaPlayer & {
      sizingStrategy?: string;
      mediaRole?: string;
    };

    // 1. Mapper-stamped strategy takes precedence.
    if (player.sizingStrategy === "large-panel")
      return metrics.mediaPlayerLarge.height;
    if (player.sizingStrategy === "ambient") return 0;
    if (player.sizingStrategy === "compact")
      return metrics.mediaPlayerCompact.height;

    // 2. Ambient role → invisible in panel.
    if (player.mediaRole === "ambient") return 0;

    // 3. Resolve from parent context via scene lookup.
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
            (s: XRPrimitive) =>
              s.id === player.id || s.type === "XRMediaPlayer",
          );
        const isTopLevelPanel = parentPrimitive.type === "XRContentPanel";
        if (isTopLevelPanel && isOnlyMediaChild) {
          return metrics.mediaPlayerLarge.height;
        }
        if (siblings.length >= 4) {
          return metrics.mediaPlayerCompact.height;
        }
      }
    }

    // 4. Default → compact.
    return metrics.mediaPlayerCompact.height;
  }

  // ── Text-bearing interactive elements ─────────────────────────────────────
  // These elements have labels that may wrap across lines when the panel is
  // narrow. We compute actual wrap height instead of using a fixed floor.
  // Children (e.g. nested icons, badges, sub-labels) are summed on top of the
  // label height so the element never clips its own content.
  {
    type TextBearingKey =
      | "XRButton"
      | "XRLink"
      | "XRTab"
      | "XRMenuItem"
      | "XRTreeItem"
      | "XRAlert"
      | "XRTooltip"
      | "XRListItem";
    const TEXT_BEARING_MAP: Partial<
      Record<TextBearingKey, TextBearingMetrics>
    > = {
      XRButton: metrics.button,
      XRLink: metrics.link,
      XRTab: metrics.tab,
      XRMenuItem: metrics.menuItem,
      XRTreeItem: metrics.treeItem,
      XRAlert: metrics.alert,
      XRTooltip: metrics.tooltip,
      XRListItem: metrics.listItem,
    };
    const tb = TEXT_BEARING_MAP[primitive.type as TextBearingKey];
    if (tb !== undefined) {
      // Label-based height floor.
      const labelHeight = estimateTextBearingHeight(
        primitive.label ?? "",
        panelUsableWidth,
        tb,
        metrics.fallbackElementHeight,
      );

      // XRListItem: label is the first row; primitive children (images,
      // sub-paragraphs, badges, etc.) stack beneath it.
      // Height = labelHeight + childrenHeight, floored at tb.minHeight.
      if (primitive.type === "XRListItem") {
        if (primitive.children.length > 0) {
          const childrenHeight = primitive.children.reduce(
            (sum: number, child: XRPrimitive, idx: number) => {
              // Every child gets a gap from the item above it (label row or sibling).
              const gap = config.childGapY;
              return (
                sum +
                gap +
                estimateHeight(
                  child,
                  panelUsableWidth,
                  metrics,
                  config,
                  new Set(branchAncestors),
                  scene,
                )
              );
            },
            0,
          );
          return Math.max(tb.minHeight, labelHeight + childrenHeight);
        }
        return labelHeight;
      }

      // Add child content height if present (e.g. XRAlert with body paragraphs,
      // XRTreeItem with nested items)
      if (primitive.children.length > 0) {
        const childrenHeight = primitive.children.reduce(
          (sum: number, child: XRPrimitive, idx: number) => {
            const gap = idx === 0 ? 0 : config.childGapY;
            return (
              sum +
              gap +
              estimateHeight(
                child,
                panelUsableWidth,
                metrics,
                config,
                ancestors,
              )
            );
          },
          0,
        );
        return Math.max(labelHeight, tb.minHeight + childrenHeight);
      }

      return labelHeight;
    }
  }

  // ── Figure: image height + variable-length caption ────────────────────────
  if (primitive.type === "XRFigure") {
    const imageH = metrics.image.height;
    const captionLabel = primitive.label ?? "";
    if (captionLabel.trim() === "") return imageH;
    const captionH = (() => {
      const m = metrics.figureCaption;
      const wordCount = countWords(captionLabel);
      if (wordCount === 0) return 0;
      const lineH = m.fontSize * m.lineHeightRatio;
      const wordsPerLine = computeWordsPerLine(panelUsableWidth, m);
      const lineCount = Math.ceil(wordCount / wordsPerLine);
      return lineCount * lineH + m.verticalPadding;
    })();
    return imageH + captionH;
  }

  // ── Card grid: per-card height is text-bearing ──────────────────────────
  // Override: each XRListItem label can wrap.
  if (primitive.type === "XRList") {
    const columns = resolveListColumns(
      primitive as XRList,
      panelUsableWidth,
      metrics,
    );
    const cardUsableWidth = Math.max(
      0.025,
      panelUsableWidth / Math.max(1, columns),
    );
    // Measure each card's actual height (wrapping its own label + any child content).
    // Model: label is the first row; primitive children stack beneath it.
    // Height = labelH + childrenH, floored at metrics.listItem.minHeight.
    const cardHeights =
      primitive.children.length > 0
        ? primitive.children.map((item: XRPrimitive) => {
            const labelH = estimateTextBearingHeight(
              item.label ?? "",
              cardUsableWidth,
              metrics.listItem,
              metrics.fallbackElementHeight,
            );
            if (item.children.length > 0) {
              const childrenH = item.children.reduce(
                (sum: number, child: XRPrimitive, idx: number) => {
                  const gap = config.childGapY;
                  return (
                    sum +
                    gap +
                    estimateHeight(
                      child,
                      cardUsableWidth,
                      metrics,
                      config,
                      new Set(branchAncestors),
                      scene,
                    )
                  );
                },
                0,
              );
              return Math.max(metrics.listItem.minHeight, labelH + childrenH);
            }
            return labelH;
          })
        : [metrics.listItem.minHeight];
    // Group cards into rows and sum per-row max height.
    const rowCount = Math.ceil(
      primitive.children.length / Math.max(1, columns),
    );
    let totalCardH = 0;
    for (let row = 0; row < rowCount; row++) {
      const start = row * columns;
      const end = Math.min(start + columns, cardHeights.length);
      const rowH = Math.max(...cardHeights.slice(start, end));
      totalCardH += rowH;
    }
    const gaps = config.childGapY * Math.max(0, rowCount - 1);
    return totalCardH + gaps;
  }

  if (primitive.type === "XRTable") {
    const { rowCount } = primitive as XRTable;
    return (
      metrics.tableHeaderRowHeight +
      Math.max(0, rowCount - 1) * metrics.tableRowHeight +
      rowCount * config.childGapY
    );
  }

  // ── Universal fallback: children → label → fixed lookup → fallback ──────────
  //
  // All remaining types (named containers, XRGenericPanel, and any future
  // unknown primitive) go through a single three-stage resolution rather than
  // an ever-growing list of named type checks:
  //
  //   Stage 1 — Children present
  //     Sum child heights recursively (with childGapY between them and
  //     panelPaddingTop on both ends).  For primitives that have a fixed-height
  //     floor in RenderMetrics (XRBanner, XRFooter, XRNavigationBar) the
  //     children-derived height is taken as a *minimum* so the element never
  //     shrinks below its designed baseline.
  //
  //   Stage 2 — No children, but label present
  //     Estimate from the label as a single-line or wrapping text block using
  //     the paragraph metrics (best available generic metric for unknown types).
  //     If the fixed-height lookup has an entry it serves as a floor here too.
  //
  //   Stage 3 — No children, no label
  //     Return the fixed-height lookup value if one exists, otherwise
  //     fallbackElementHeight.
  //
  // This means XRGenericPanel, future XRCustomCard, or any mapper-introduced
  // type automatically gets correct height estimation without a code change here.

  // Fixed-height floor for this type, if any (used in stages 1 and 2).
  const fixedFloor = FIXED_HEIGHT_LOOKUP(metrics)[primitive.type];

  // Stage 1: has children — sum them recursively.
  if (primitive.children.length > 0) {
    const childHeights = primitive.children.map((c: XRPrimitive) =>
      estimateHeight(c, panelUsableWidth, metrics, config, ancestors, scene),
    );
    const total = childHeights.reduce((s: number, h: number) => s + h, 0);
    const gaps = config.childGapY * Math.max(0, primitive.children.length - 1);
    const fromChildren =
      config.panelPaddingTop + total + gaps + config.panelPaddingTop;
    // Honour any fixed floor (e.g. XRBanner must be at least metrics.banner.height).
    return fixedFloor !== undefined
      ? Math.max(fixedFloor, fromChildren)
      : Math.max(metrics.fallbackElementHeight, fromChildren);
  }

  // Stage 2: no children, label available — estimate as wrapping text.
  const labelText = primitive.content ?? primitive.label ?? "";
  if (labelText.trim() !== "") {
    const wordCount = countWords(labelText);
    const m = metrics.paragraph; // best generic metric for unknown types
    const lineH = m.fontSize * m.lineHeightRatio;
    const wordsPerLine = computeWordsPerLine(panelUsableWidth, m);
    const lineCount = Math.max(1, Math.ceil(wordCount / wordsPerLine));
    const fromLabel = lineCount * lineH + m.verticalPadding;
    return fixedFloor !== undefined
      ? Math.max(fixedFloor, fromLabel)
      : fromLabel;
  }

  // Stage 3: no children, no label — fixed lookup or fallback.
  return fixedFloor ?? metrics.fallbackElementHeight;
}

// ─────────────────────────────────────────────────────────────
// Landmark classifier
// ─────────────────────────────────────────────────────────────

function classifyLandmark(primitive: XRPrimitive): SlotName {
  switch (primitive.type) {
    case "XRContentPanel":
      return "main";
    case "XRNavigationBar":
      return primitive.id.startsWith("toc") ? "toc" : "navigation";
    case "XRBanner":
      return "banner";
    case "XRFooter":
      return "footer";
    case "XRComplementary":
      return "complementary";
    case "XRFormPanel":
      return "main"; // contained inside XRContentPanel
    case "XRDialog":
      return "dialog";
    case "XRAlert":
      return "alert";
    default:
      return "main";
  }
}

// ─────────────────────────────────────────────────────────────
// Simple vertical stacker  (non-paginating, depth > 0)
// ─────────────────────────────────────────────────────────────

/**
 * Stack `children` vertically within a non-paginating container.
 *
 * Called for every container that is NOT an XRContentPanel. Has zero
 * awareness of pages — it simply assigns y-positions top-to-bottom
 * within the panel's local space. Because these nodes always live inside
 * a single page slice the positions are implicitly page-relative.
 *
 * The `depth` concept from the original stackChildren is gone. The caller
 * (layoutPrimitive) is responsible for dispatching to this function vs
 * paginateContentPanel based on primitive.type.
 */
// In engine.ts, update stackChildrenSimple:

function stackChildrenSimple(
  children: XRPrimitive[],
  panelWidth: number,
  config: LayoutConfig,
  metrics: RenderMetrics,
  parentType?: string,
  listColumns?: number,
): SimpleStackResult {
  if (children.length === 0) {
    return { childEntries: [], totalHeight: 0 };
  }

  const childWidth = Math.max(0.025, panelWidth - config.panelPaddingX * 2);
  const panelUsableWidth = childWidth;

  // ── XRList grid layout ────────────────────────────────────────────────────
  // XRListItem children must be placed side-by-side in rows of `columns`
  // cards. Each card gets `cardUsableWidth = childWidth / columns`.
  // This path is taken only when the caller identifies the parent as XRList
  // and supplies a resolved column count.
  if (parentType === "XRList" && listColumns && listColumns > 1) {
    const columns = listColumns;
    const cardWidth = Math.max(0.025, childWidth / columns);
    const rowCount = Math.ceil(children.length / columns);
    const childEntries: LayoutEntry[] = [];
    let cursorY = -config.panelPaddingTop;
    let totalHeight = config.panelPaddingTop;

    for (let row = 0; row < rowCount; row++) {
      const rowStart = row * columns;
      const rowEnd = Math.min(rowStart + columns, children.length);

      // Measure all cards in this row to find the row height.
      const rowHeights: number[] = [];
      for (let col = rowStart; col < rowEnd; col++) {
        const h = estimateHeight(
          children[col],
          cardWidth,
          metrics,
          config,
          new Set(),
        );
        rowHeights.push(
          !h || h <= 0 || !isFinite(h) ? metrics.fallbackElementHeight : h,
        );
      }
      const rowH = Math.max(...rowHeights);

      const rowGap = row === 0 ? 0 : config.childGapY;
      const rowY = cursorY - rowGap;

      // Place each card in this row at its column offset.
      for (let col = rowStart; col < rowEnd; col++) {
        const colIdx = col - rowStart;
        const card = children[col];
        const entry: LayoutEntry = {
          id: card.id,
          position: {
            x: config.panelPaddingX + colIdx * (cardWidth + config.childGapY),
            y: rowY,
            z: 0,
          },
          rotation: zeroRotation(),
          size: { width: cardWidth, height: rowHeights[colIdx] ?? rowH },
          curveRadius: 0,
          worldLocked: true,
        };
        attachResolvedStrategies(entry, card, cardWidth, metrics);
        childEntries.push(entry);
      }

      cursorY -= rowGap + rowH;
      totalHeight += rowGap + rowH;
    }
    totalHeight += config.panelPaddingTop;

    return { childEntries, totalHeight };
  }

  // ── Default: single-column vertical stack ────────────────────────────────
  let cursorY = -config.panelPaddingTop;
  const childEntries: LayoutEntry[] = [];

  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    let h = estimateHeight(child, panelUsableWidth, metrics, config, new Set());

    if (!h || h <= 0 || !isFinite(h)) {
      h = metrics.fallbackElementHeight;
    }

    const gap = i === 0 ? 0 : config.childGapY;

    const entry: LayoutEntry = {
      id: child.id,
      position: { x: config.panelPaddingX, y: cursorY - gap, z: 0 },
      rotation: zeroRotation(),
      size: { width: childWidth, height: h },
      curveRadius: 0,
      worldLocked: true,
    };
    attachResolvedStrategies(entry, child, panelUsableWidth, metrics);
    childEntries.push(entry);
    cursorY -= gap + h;
  }

  const totalHeight =
    config.panelPaddingTop +
    childEntries.reduce((s, e) => s + e.size.height, 0) +
    config.childGapY * Math.max(0, children.length - 1) +
    config.panelPaddingTop;

  return { childEntries, totalHeight };
}

// ─────────────────────────────────────────────────────────────
// Content panel paginator  (XRContentPanel only)
// ─────────────────────────────────────────────────────────────

/**
 * Paginate the direct children of an XRContentPanel.
 *
 * This is the ONLY place in the engine where pages are created. All other
 * containers call stackChildrenSimple instead.
 *
 * Page-relative y-positions
 * ─────────────────────────
 * Every child entry's position.y is relative to the TOP of the page it
 * belongs to, not the top of the panel overall. This means:
 *   - Page 0, first item:  y = -panelPaddingTop
 *   - Page 1, first item:  y = -panelPaddingTop  (reset)
 *   - Page 2, first item:  y = -panelPaddingTop  (reset)
 *
 * The renderer combines (pageRelativeY, pageIndex) to get world position:
 *   worldY = entry.position.y
 *   worldZ = panelBaseZ + entry.pageIndex * pageZStep
 *
 * Section handling
 * ────────────────
 * XRSection / XRArticle / XRFormPanel / XRFormField always start on a
 * fresh page. Their children are laid out via splitSection(), which
 * manages its own page-relative cursor and writes positions directly
 * into positionMap so they are never left undefined.
 *
 * XRGenericPanel handling
 * ────────────────────────
 * A top-level XRGenericPanel does NOT force a fresh page (it's a plain
 * wrapper, not a section), but it IS routed through splitSection() so that
 * any section-like descendants buried inside it still get correct fresh-page
 * treatment. Previously, top-level XRGenericPanel children fell into the
 * generic "leaf" path below and were measured/placed as one opaque block —
 * which silently broke page-splitting for any section nested inside a
 * top-level wrapper panel. splitSection() already had the correct
 * XRGenericPanel-recursion logic for *nested* panels; this just makes the
 * top level consistent with that.
 *
 * Paragraph continuation
 * ──────────────────────
 * An XRParagraph that straddles a page boundary is split at the last
 * line that fits. The first fragment stays on the current page with a
 * reduced height. A continuation LayoutEntry (id = `${id}__cont_${page}`,
 * continuationWordOffset = words already shown) is placed at the top of
 * the next page.
 *
 * Height contract
 * ────────────────
 * Every id written into placedPositionMap also gets a corresponding entry
 * in placedHeightMap, holding the height ACTUALLY USED to make that
 * placement decision — not a generic re-estimate. This matters specifically
 * for split paragraph fragments: the fragment that stays behind on the
 * current page is sized at splitHeight (its truncated height), not its
 * full unsplit height. Callers (layoutPrimitive) must read sizes from this
 * map rather than calling estimateHeight() again, or a split fragment's
 * LayoutEntry will be sized as if it contained the whole paragraph.
 */
function paginateContentPanel(
  children: XRPrimitive[],
  panelWidth: number,
  scene: SemanticScene,
  config: LayoutConfig,
  metrics: RenderMetrics,
  diag: LayoutDiagnostics,
): PaginateResult {
  if (children.length === 0) {
    return {
      pagination: null,
      pageIndexMap: {},
      placedPositionMap: new Map(),
      placedHeightMap: new Map(),
      continuationEntries: [],
    };
  }

  const childWidth = Math.max(0.025, panelWidth - config.panelPaddingX * 2);
  const panelUsableWidth = childWidth;
  const VIEWPORT = config.maxPanelViewportHeight;

  // Pre-estimate heights for direct children that will take the "leaf" path
  // in the main loop below (plain non-section, non-generic-panel nodes).
  // Section-like and XRGenericPanel children are re-measured node-by-node
  // inside splitSection() instead, since their height isn't a single fixed
  // number — it depends on where page breaks land among their descendants.
  // This array is indexed in parallel with `children`; entries for
  // section-like / XRGenericPanel children are computed but simply unused.
  const heights = children.map((c) =>
    estimateHeight(c, panelUsableWidth, metrics, config, new Set(), scene),
  );

  // positionMap holds the final page-relative position for each direct child.
  // Section children are written here by splitSection() directly.
  const positionMap: Map<string, Vec3> = new Map();

  // heightMap holds the height ACTUALLY USED when placing each node — i.e.
  // splitHeight for a paragraph fragment that got truncated at a page
  // boundary, or the plain estimateHeight() result otherwise. This is the
  // authoritative size for the LayoutEntry the renderer will build; callers
  // (layoutPrimitive) must use this instead of re-calling estimateHeight(),
  // which would return the FULL untruncated height for a split fragment and
  // produce a LayoutEntry sized larger than the content actually placed there.
  const heightMap: Map<string, number> = new Map();

  const pageIndexMap: Record<string, number> = {};
  const continuationEntries: LayoutEntry[] = [];
  const pageYOffsets: number[] = [0];

  // Mutable page state — shared between the main loop and splitSection().
  let pageIdx = 0;
  let pageHeight = config.panelPaddingTop;
  let itemsOnPage = 0;
  // cursorY is PAGE-RELATIVE. Reset to -panelPaddingTop on every new page.
  let cursorY = -config.panelPaddingTop;

  // ── Helpers ────────────────────────────────────────────────────────────────

  function isSectionLike(p: XRPrimitive): boolean {
    return (
      p.type === "XRSection" ||
      p.type === "XRArticle" ||
      p.type === "XRFormPanel" ||
      p.type === "XRFormField"
    );
  }

  /** Recursively stamp every node in a subtree with the given page index. */
  function stampSubtree(node: XRPrimitive, page: number): void {
    pageIndexMap[node.id] = page;
    for (const child of node.children) stampSubtree(child, page);
  }

  /**
   * Advance to the next page.
   * Resets cursorY to the top of the new page (page-relative origin).
   * Records the absolute y-offset of the new page for PaginationMeta.
   *
   * NOTE: pageYOffsets stores absolute cumulative heights for the renderer
   * to know where each page starts in the content's total height. It is
   * NOT used for y-position computation inside the engine — that always
   * uses the page-relative cursorY.
   */
  function nextPage(absolutePageStart: number): void {
    pageYOffsets.push(absolutePageStart);
    pageIdx += 1;
    pageHeight = config.panelPaddingTop;
    itemsOnPage = 0;
    cursorY = -config.panelPaddingTop; // reset to page-relative origin
  }

  /**
   * Try to split a paragraph at the page boundary.
   *
   * If the paragraph fits a split (some words on this page, rest on next):
   *   - Returns the reduced height for the fragment that fits.
   *   - Pushes a continuation LayoutEntry onto continuationEntries.
   *   - The caller must advance to the next page after calling this.
   *
   * If splitting is not possible (paragraph type mismatch, budget = 0,
   * or all words fit / none fit), returns { splitHeight: fullHeight, didSplit: false }.
   */
  function maybeSplitParagraph(
    p: XRPrimitive,
    fullHeight: number,
    budget: number,
    nextPageIdx: number,
  ): { splitHeight: number; didSplit: boolean } {
    if (p.type !== "XRParagraph")
      return { splitHeight: fullHeight, didSplit: false };
    if (budget <= 0) return { splitHeight: fullHeight, didSplit: false };

    const wordsThatFit = paragraphWordsThatFit(
      budget,
      panelUsableWidth,
      metrics,
    );
    const totalWords =
      (p as XRParagraph).wordCount ?? countWords(p.content ?? p.label ?? "");

    if (wordsThatFit <= 0 || wordsThatFit >= totalWords) {
      return { splitHeight: fullHeight, didSplit: false };
    }

    const m = metrics.paragraph;
    const wordsPerLine = computeWordsPerLine(panelUsableWidth, m);
    const lineH = m.fontSize * m.lineHeightRatio;
    const splitLines = Math.ceil(wordsThatFit / wordsPerLine);
    const splitHeight = splitLines * lineH + m.verticalPadding;

    const contWordOffset = wordsThatFit;
    const remainingWords = totalWords - wordsThatFit;
    const contLines = Math.ceil(remainingWords / wordsPerLine);
    const contHeight = contLines * lineH + m.verticalPadding;

    const contId = `${p.id}__cont_${nextPageIdx}`;
    // The continuation sits at the top of the next page (page-relative origin).
    // Note: this is a SEPARATE synthetic id from the original paragraph, so it
    // does not collide with stampSubtree(p, ...) calls made elsewhere for the
    // fragment that stays behind on the current page — both halves get a
    // correct, independent page-index stamp.
    const contEntry: LayoutEntry = {
      id: contId,
      position: { x: config.panelPaddingX, y: -config.panelPaddingTop, z: 0 },
      rotation: zeroRotation(),
      size: { width: childWidth, height: contHeight },
      curveRadius: 0,
      worldLocked: true,
      continuationWordOffset: contWordOffset,
      pageIndex: nextPageIdx,
    };
    // Register in positionMap so the placed-position contract covers it.
    positionMap.set(contId, contEntry.position);
    pageIndexMap[contId] = nextPageIdx;
    heightMap.set(contId, contHeight);
    continuationEntries.push(contEntry);

    diag.paragraphContinuations.push({
      originalId: p.id,
      pageIndex: nextPageIdx,
      wordOffset: contWordOffset,
    });

    return { splitHeight, didSplit: true };
  }

  // ── Section splitter ───────────────────────────────────────────────────────
  //
  // Lays out the children of a section-like primitive (or XRGenericPanel)
  // across pages, writing page-relative positions into positionMap.
  //
  // Operates directly on the shared outer page state (pageIdx, pageHeight,
  // itemsOnPage, cursorY) so that recursion naturally continues from wherever
  // the cursor currently sits — no coordination needed at call boundaries.
  //
  // Recursion rules
  // ───────────────
  // • isSectionLike child  → force a fresh page, recurse into children, then
  //                          record the wrapper's position as the top of that page.
  // • XRGenericPanel child → recurse inline (no fresh page), then record the
  //                          wrapper's position as wherever the first child landed.
  // • anything else        → leaf: placed as one block, paragraph-split if
  //                          it straddles the boundary.
  //
  // Wrapper positions are written AFTER recursion so they reflect the page and
  // cursor where the content actually landed, not a speculative pre-recursion
  // snapshot that may be invalidated by an intra-child page break.
  //
  function splitSection(section: XRPrimitive): void {
    for (let j = 0; j < section.children.length; j++) {
      const sc = section.children[j];

      // ── Recursive: section-like child ─────────────────────────────────────
      if (isSectionLike(sc)) {
        if (sc.children.length === 0) {
          // A childless section has no visible content, so it should not
          // consume a page or inject blank space. Skipping it entirely
          // (rather than giving it phantom padding-only height) avoids a
          // spurious empty page/gap in the layout.
          continue;
        }

        const sectionNewPage = config.sectionStartsOnNewPage !== false;

        if (sectionNewPage && itemsOnPage > 0) {
          const absOffsetBase = pageYOffsets[pageIdx] ?? 0;
          pageYOffsets.push(absOffsetBase + VIEWPORT);
          pageIdx += 1;
          pageHeight = config.panelPaddingTop;
          itemsOnPage = 0;
          cursorY = -config.panelPaddingTop;
        }

        // Record which page this section lands on, and its position at the
        // top of that page — before recursing so descendants can inherit it.
        pageIndexMap[sc.id] = pageIdx;
        positionMap.set(sc.id, {
          x: config.panelPaddingX,
          y: -config.panelPaddingTop,
          z: 0,
        });

        // Mark the page as occupied before recursing so the first child
        // inside doesn't see itemsOnPage === 0 and skip its gap check.
        // We don't advance cursorY or pageHeight — the children do that.
        const pageBeforeRecursion = pageIdx;
        splitSection(sc);
        // Height = however far the cursor moved on the page the section
        // STARTED on. If the section's content overflowed onto further
        // pages, those continuation pages belong to the section's children
        // (already stamped individually), not to a single bounding box for
        // the section itself — this height only describes its first-page
        // footprint, which is what a single LayoutEntry for `sc` can
        // meaningfully represent.
        if (pageIdx === pageBeforeRecursion) {
          heightMap.set(sc.id, pageHeight - config.panelPaddingTop);
        } else {
          heightMap.set(sc.id, VIEWPORT - config.panelPaddingTop);
        }
        continue;
      }

      // ── Recursive: generic panel child ────────────────────────────────────
      // No fresh page. Recurse first, then record the wrapper's position as
      // wherever the cursor was at the start of the recursion. This avoids
      // recording a pre-recursion cursor that gets invalidated by a page break
      // inside the generic panel's children.
      if (sc.type === "XRGenericPanel") {
        if (sc.children.length === 0) continue; // childless no-op

        // Snapshot page state before recursing so we can record the wrapper's
        // entry using the position the cursor was at when it started.
        const wrapperPage = pageIdx;
        const wrapperY = cursorY - (itemsOnPage > 0 ? config.childGapY : 0);
        const cursorBeforeRecursion = wrapperY;

        pageIndexMap[sc.id] = wrapperPage;
        positionMap.set(sc.id, {
          x: config.panelPaddingX,
          y: wrapperY,
          z: 0,
        });

        splitSection(sc);
        // Height = distance the cursor moved on the wrapper's own page,
        // from where it started to where it ended up — mirrors the
        // section-like case above. If content overflowed past this page,
        // the remainder belongs to children already stamped on later pages.
        if (pageIdx === wrapperPage) {
          heightMap.set(sc.id, cursorBeforeRecursion - cursorY);
        } else {
          heightMap.set(
            sc.id,
            cursorBeforeRecursion - (-VIEWPORT + config.panelPaddingTop),
          );
        }
        continue;
      }

      // ── Leaf child ────────────────────────────────────────────────────────
      // Reached only for primitives that are neither section-like nor
      // XRGenericPanel — i.e. genuinely atomic content (paragraphs, figures,
      // tables, lists, etc.) that should be placed as a single block, or
      // split via maybeSplitParagraph if it's a paragraph straddling a page
      // boundary.
      const sch = estimateHeight(
        sc,
        panelUsableWidth,
        metrics,
        config,
        new Set(),
      );
      const scGap = itemsOnPage > 0 ? config.childGapY : 0;

      if (pageHeight + scGap + sch > VIEWPORT && itemsOnPage > 0) {
        const budget = VIEWPORT - pageHeight - scGap;
        const nextSubPageIdx = pageIdx + 1;
        const { splitHeight, didSplit } = maybeSplitParagraph(
          sc,
          sch,
          budget,
          nextSubPageIdx,
        );

        if (didSplit) {
          // The fragment that stays behind belongs on the CURRENT page
          // (pageIdx has not been advanced yet at this point) — correct.
          stampSubtree(sc, pageIdx);
          positionMap.set(sc.id, {
            x: config.panelPaddingX,
            y: cursorY - scGap,
            z: 0,
          });
          // Record splitHeight, NOT sch (the full unsplit height) — this
          // fragment only contains the truncated text, and a LayoutEntry
          // sized at the full height would extend past where the actual
          // (truncated) content ends.
          heightMap.set(sc.id, splitHeight);
          cursorY -= scGap + splitHeight;
          pageHeight += scGap + splitHeight;
          itemsOnPage += 1;
        }

        // Open the next sub-page. This MUST happen before the fallthrough
        // stamp below: when didSplit is false (sc is not a paragraph, or
        // couldn't be split), nothing has been stamped/placed for sc yet,
        // and we want it to land on the NEW page, not the one it didn't
        // fit on. Advancing pageIdx/cursorY/pageHeight/itemsOnPage here,
        // before the fallthrough, is what makes that correct — do not
        // reorder these lines relative to the stamp below.
        const absOffsetBase = pageYOffsets[pageIdx] ?? 0;
        pageYOffsets.push(absOffsetBase + VIEWPORT);
        pageIdx += 1;
        cursorY = -config.panelPaddingTop;
        pageHeight = config.panelPaddingTop;
        itemsOnPage = 0;

        if (didSplit) continue;
      }

      // Place the leaf on the current page. If we just fell through from
      // the overflow branch above without a split, "current page" here is
      // already the freshly-advanced page (see comment above).
      const g = itemsOnPage > 0 ? config.childGapY : 0;
      stampSubtree(sc, pageIdx);
      positionMap.set(sc.id, {
        x: config.panelPaddingX,
        y: cursorY - g,
        z: 0,
      });
      heightMap.set(sc.id, sch);
      cursorY -= g + sch;
      pageHeight += g + sch;
      itemsOnPage += 1;
    }
  }

  // ── Main pagination loop ───────────────────────────────────────────────────

  // Running absolute y for computing pageYOffsets accurately.
  // We track it separately from cursorY (which is always page-relative).
  let absoluteY = config.panelPaddingTop;

  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    const h = heights[i];

    if (isSectionLike(child)) {
      const isChildlessSection = child.children.length === 0;

      if (isChildlessSection) {
        // See splitSection's identical case above: no content, no page.
        continue;
      }
      const sectionNewPage = config.sectionStartsOnNewPage !== false;
      // Sections always start on a fresh page.
      if (sectionNewPage && itemsOnPage > 0) {
        nextPage(absoluteY);
        absoluteY = config.panelPaddingTop; // reset absolute tracker for new page
      }

      pageIndexMap[child.id] = pageIdx;
      // Section itself is placed at the top of this fresh page.
      positionMap.set(child.id, {
        x: config.panelPaddingX,
        y: -config.panelPaddingTop,
        z: 0,
      });

      const pageBeforeRecursion = pageIdx;
      splitSection(child);
      // Mirrors splitSection's own section-like-child height logic: only
      // describe the footprint on the page the section started on.
      if (pageIdx === pageBeforeRecursion) {
        heightMap.set(child.id, pageHeight - config.panelPaddingTop);
      } else {
        heightMap.set(child.id, VIEWPORT - config.panelPaddingTop);
      }
      // absoluteY is not directly tracked through splitSection since it
      // operates on shared outer state. Recompute from pageHeight.
      absoluteY = config.panelPaddingTop + pageHeight;
    } else if (child.type === "XRGenericPanel") {
      // Top-level XRGenericPanel: same treatment as a nested XRGenericPanel
      // inside splitSection — no forced fresh page, but routed through
      // splitSection so that any section-like descendants buried inside it
      // still get correct fresh-page handling. Previously this fell into
      // the plain "leaf" branch below and was measured/placed as one
      // opaque block via `h`, which silently prevented nested sections
      // inside a top-level wrapper panel from ever starting a fresh page.
      if (child.children.length === 0) continue; // childless no-op, mirrors splitSection

      const wrapperPage = pageIdx;
      const wrapperY = cursorY - (itemsOnPage > 0 ? config.childGapY : 0);
      const cursorBeforeRecursion = wrapperY;

      pageIndexMap[child.id] = wrapperPage;
      positionMap.set(child.id, {
        x: config.panelPaddingX,
        y: wrapperY,
        z: 0,
      });

      splitSection(child);
      if (pageIdx === wrapperPage) {
        heightMap.set(child.id, cursorBeforeRecursion - cursorY);
      } else {
        heightMap.set(
          child.id,
          cursorBeforeRecursion - (-VIEWPORT + config.panelPaddingTop),
        );
      }
      absoluteY = config.panelPaddingTop + pageHeight;
    } else {
      // Non-section, non-generic-panel direct children: genuinely atomic
      // leaves (paragraphs, figures, tables, etc.), measured monolithically
      // via the pre-computed `h` and placed as one block, or paragraph-split
      // across the boundary.
      const gap = itemsOnPage === 0 ? 0 : config.childGapY;
      const budget = VIEWPORT - pageHeight - gap;

      if (pageHeight + gap + h > VIEWPORT && itemsOnPage > 0) {
        // Try paragraph split first.
        const nextPageIdx = pageIdx + 1;
        const { splitHeight, didSplit } = maybeSplitParagraph(
          child,
          h,
          budget,
          nextPageIdx,
        );

        if (didSplit) {
          stampSubtree(child, pageIdx);
          positionMap.set(child.id, {
            x: config.panelPaddingX,
            y: cursorY - gap,
            z: 0,
          });
          // Record splitHeight, not h (full height) — see comment in
          // splitSection's identical leaf-split case.
          heightMap.set(child.id, splitHeight);
          cursorY -= gap + splitHeight;
          pageHeight += gap + splitHeight;
          absoluteY += gap + splitHeight;
          itemsOnPage += 1;
        }

        // Advance to next page regardless of whether we split. As in
        // splitSection's leaf branch, this MUST precede the fallthrough
        // stamp below when didSplit is false, so the unsplit child lands
        // on the new page rather than the one it overflowed.
        nextPage(absoluteY);
        absoluteY = config.panelPaddingTop;

        if (didSplit) continue; // continuation sits at top of new page; skip re-placing
      }

      // Place child on current page.
      const g = itemsOnPage === 0 ? 0 : config.childGapY;
      stampSubtree(child, pageIdx);
      positionMap.set(child.id, {
        x: config.panelPaddingX,
        y: cursorY - g,
        z: 0,
      });
      heightMap.set(child.id, h);
      cursorY -= g + h;
      pageHeight += g + h;
      absoluteY += g + h;
      itemsOnPage += 1;
    }
  }

  const totalPages = pageIdx + 1;

  const pagination: PaginationMeta | null =
    totalPages > 1
      ? { pageCount: totalPages, pageZStep: config.pageZStep, pageYOffsets }
      : null;

  return {
    pagination,
    pageIndexMap,
    placedPositionMap: positionMap,
    placedHeightMap: heightMap,
    continuationEntries,
  };
}
// ─────────────────────────────────────────────────────────────
// Strategy attachment
// ─────────────────────────────────────────────────────────────

/**
 * Attach resolved table strategy or card grid column count to a LayoutEntry
 * if the primitive requires it.
 */
function attachResolvedStrategies(
  entry: LayoutEntry,
  primitive: XRPrimitive,
  panelUsableWidth: number,
  metrics: RenderMetrics,
): void {
  if (primitive.type === "XRTable") {
    entry.tableLayoutStrategy = resolveTableStrategy(
      primitive as XRTable,
      metrics,
    );
  }
  if (primitive.type === "XRList") {
    entry.listColumns = resolveListColumns(
      primitive as XRList,
      panelUsableWidth,
      metrics,
    );
  }
}

// ─────────────────────────────────────────────────────────────
// Recursive layout walker
// ─────────────────────────────────────────────────────────────

/**
 * Walk a primitive and all its descendants, producing a LayoutEntry for each.
 *
 * Two modes:
 *
 * Outside XRContentPanel — stackChildrenSimple computes local positions,
 * inheritedPageIndex propagates from parent.
 *
 * Inside XRContentPanel — paginateContentPanel has already written every
 * descendant's page-relative position, page index, AND placed height into
 * placedPositionMap / pageIndexMap / placedHeightMap. layoutPrimitive just
 * looks those up; no position or height recomputation happens anywhere in
 * the subtree. This is required, not just an optimisation: a paragraph
 * fragment that was split at a page boundary has a placed height (the
 * truncated splitHeight) that differs from estimateHeight()'s answer for
 * that same primitive (the full, unsplit height). Recomputing instead of
 * reading placedHeightMap would size such a fragment's LayoutEntry as if it
 * contained the whole paragraph, even though only the truncated text is
 * rendered there.
 */
function layoutPrimitive(
  primitive: XRPrimitive,
  worldPosition: Vec3,
  worldRotation: Rotation3,
  worldSize: Size2,
  curveRadius: number,
  worldLocked: boolean,
  scene: SemanticScene,
  config: LayoutConfig,
  metrics: RenderMetrics,
  entries: Record<string, LayoutEntry>,
  diag: LayoutDiagnostics,
  inheritedPageIndex?: number,
  pageIndexMap?: Record<string, number>,
  placedPositionMap?: Map<string, Vec3>,
  placedHeightMap?: Map<string, number>,
): void {
  const entry: LayoutEntry = {
    id: primitive.id,
    position: worldPosition,
    rotation: worldRotation,
    size: worldSize,
    curveRadius,
    worldLocked,
  };

  if (inheritedPageIndex !== undefined) {
    entry.pageIndex = inheritedPageIndex;
  }

  attachResolvedStrategies(
    entry,
    primitive,
    Math.max(0.025, worldSize.width - config.panelPaddingX * 2),
    metrics,
  );

  if (primitive.children.length > 0) {
    if (primitive.type === "XRContentPanel") {
      // ── Paginating path ──────────────────────────────────────────────────
      // Run pagination once. After this call, placedPositionMap,
      // pageIndexMap, and placedHeightMap contain authoritative positions,
      // page indices, and sizes for every descendant. We never recompute
      // any of these anywhere below.
      const {
        pagination,
        pageIndexMap: newPageIndexMap,
        placedPositionMap: newPlacedPositionMap,
        placedHeightMap: newPlacedHeightMap,
        continuationEntries,
      } = paginateContentPanel(
        primitive.children,
        worldSize.width,
        scene,
        config,
        metrics,
        diag,
      );

      if (pagination) {
        entry.pagination = pagination;
        diag.paginatedPanelCount += 1;
        diag.paginatedPanels.push({
          id: primitive.id,
          pageCount: pagination.pageCount,
        });
      }

      for (const cont of continuationEntries) {
        entries[cont.id] = cont;
        diag.totalPlaced += 1;

        // Synthesise a proper XRParagraph primitive for this continuation so
        // the renderer treats it as a normal paragraph — no split awareness
        // needed downstream. The label is pre-sliced to the words that belong
        // on this page; wordCount is adjusted accordingly.
        const originalId = cont.id.replace(/__cont_\d+$/, "");
        const originalPrim = scene.primitives[originalId] as
          | XRParagraph
          | undefined;
        if (originalPrim && originalPrim.type === "XRParagraph") {
          const offset = cont.continuationWordOffset ?? 0;
          const words = splitIntoWords(originalPrim.label ?? "");
          const slicedLabel = words.slice(offset).join(" ");
          const syntheticPrim: XRParagraph = {
            ...originalPrim,
            id: cont.id,
            label: slicedLabel,
            content: slicedLabel,
            wordCount: words.length - offset,
          };
          // Register in the flat primitives map so buildPrimitiveMap
          // (seeded from scene.primitives) picks it up in the renderer.
          scene.primitives[cont.id] = syntheticPrim;
        }
      }

      // Recurse using only the maps — no childEntries, no position or
      // height recomputation.
      const usableWidth = Math.max(
        0.025,
        worldSize.width - config.panelPaddingX * 2,
      );
      for (const child of primitive.children) {
        const childPos = newPlacedPositionMap.get(child.id) ?? {
          x: config.panelPaddingX,
          y: -config.panelPaddingTop,
          z: 0,
        };
        const childPageIndex = newPageIndexMap[child.id] ?? 0;

        // Authoritative height as actually used by the paginator (handles
        // split-fragment truncation correctly). Falling back to
        // estimateHeight() should never be needed in a correctly-paginated
        // tree — surface it in diagnostics if it ever is, rather than
        // silently masking a missing-entry bug.
        let childHeight = newPlacedHeightMap.get(child.id);
        if (childHeight === undefined) {
          diag.missingHeightMapEntries =
            (diag.missingHeightMapEntries ?? 0) + 1;
          childHeight = estimateHeight(
            child,
            usableWidth,
            metrics,
            config,
            new Set(),
            scene,
          );
        }

        layoutPrimitive(
          child,
          childPos,
          zeroRotation(),
          { width: usableWidth, height: childHeight },
          0,
          worldLocked,
          scene,
          config,
          metrics,
          entries,
          diag,
          childPageIndex,
          newPageIndexMap,
          newPlacedPositionMap,
          newPlacedHeightMap,
        );
      }
    } else if (placedPositionMap && placedHeightMap) {
      // ── Inside a paginated panel — maps are the only source of truth ─────
      // Look up each child's position, page index, and height directly from
      // the maps that paginateContentPanel produced. No stackChildrenSimple,
      // no estimateHeight() recomputation.
      //
      // Exception: XRList. paginateContentPanel positions the XRList node
      // itself as a leaf (one opaque block), but never walks into its
      // XRListItem children — so those children are always absent from
      // placedPositionMap and fall back to the same {panelPaddingX,
      // -panelPaddingTop} for every item, stacking them at the same point.
      // Treat XRList children like the outside-panel path: run
      // stackChildrenSimple for list-local positions, then recurse without
      // the paginator maps.
      if (primitive.type === "XRList") {
        const resolvedListColumns = entry.listColumns ?? 1;
        const { childEntries } = stackChildrenSimple(
          primitive.children,
          worldSize.width,
          config,
          metrics,
          "XRList",
          resolvedListColumns,
        );
        for (let i = 0; i < primitive.children.length; i++) {
          const child = primitive.children[i];
          const childLayoutEntry = childEntries[i];
          if (!childLayoutEntry) continue;
          layoutPrimitive(
            child,
            childLayoutEntry.position,
            childLayoutEntry.rotation,
            childLayoutEntry.size,
            0,
            worldLocked,
            scene,
            config,
            metrics,
            entries,
            diag,
            inheritedPageIndex,
            // Do NOT forward placedPositionMap: XRListItem sub-children
            // (images, paragraphs) must also use stackChildrenSimple.
          );
        }
      } else {
        for (const child of primitive.children) {
          const childPos = placedPositionMap.get(child.id) ?? {
            x: config.panelPaddingX,
            y: -config.panelPaddingTop,
            z: 0,
          };
          const childPageIndex = pageIndexMap?.[child.id] ?? inheritedPageIndex;

          let childHeight = placedHeightMap.get(child.id);
          if (childHeight === undefined) {
            diag.missingHeightMapEntries =
              (diag.missingHeightMapEntries ?? 0) + 1;
            const usableWidth = Math.max(
              0.025,
              worldSize.width - config.panelPaddingX * 2,
            );
            childHeight = estimateHeight(
              child,
              usableWidth,
              metrics,
              config,
              new Set(),
              scene,
            );
          }

          const usableWidth = Math.max(
            0.025,
            worldSize.width - config.panelPaddingX * 2,
          );

          layoutPrimitive(
            child,
            childPos,
            zeroRotation(),
            { width: usableWidth, height: childHeight },
            0,
            worldLocked,
            scene,
            config,
            metrics,
            entries,
            diag,
            childPageIndex,
            pageIndexMap,
            placedPositionMap,
            placedHeightMap,
          );
        }
      }
    } else {
      // ── Outside any XRContentPanel — stackChildrenSimple ─────────────────
      // For XRList, pass the resolved column count so children are placed in
      // a grid rather than as full-width vertical blocks.
      const resolvedListColumns =
        primitive.type === "XRList" ? (entry.listColumns ?? 1) : undefined;

      const { childEntries, totalHeight } = stackChildrenSimple(
        primitive.children,
        worldSize.width,
        config,
        metrics,
        primitive.type,
        resolvedListColumns,
      );

      // OVERFLOW DETECTION: unlike XRContentPanel, this primitive's slot has
      // a FIXED height (worldSize.height — typically a device-profile
      // constant like metrics.footer.height, not derived from content).
      // stackChildrenSimple has no pagination, so if the real content is
      // taller than the slot it was placed in, it will silently render
      // past the slot's intended bounds — likely overlapping a neighboring
      // slot — with no error anywhere. Surface that here rather than let it
      // manifest only as a visual glitch in the headset.
      //
      // Tolerance avoids flagging trivial sub-millimetre floating-point
      // slack from accumulated gap/padding arithmetic.
      const OVERFLOW_TOLERANCE_M = 0.001;
      if (totalHeight > worldSize.height + OVERFLOW_TOLERANCE_M) {
        diag.slotOverflows = diag.slotOverflows ?? [];
        diag.slotOverflows.push({
          id: primitive.id,
          type: primitive.type,
          declaredHeight: worldSize.height,
          actualHeight: totalHeight,
          overflowBy: totalHeight - worldSize.height,
        });
      }

      for (let i = 0; i < primitive.children.length; i++) {
        const child = primitive.children[i];
        const childLayoutEntry = childEntries[i];
        if (!childLayoutEntry) continue;

        layoutPrimitive(
          child,
          childLayoutEntry.position,
          childLayoutEntry.rotation,
          childLayoutEntry.size,
          0,
          worldLocked,
          scene,
          config,
          metrics,
          entries,
          diag,
          inheritedPageIndex,
        );
      }
    }
  }

  entries[primitive.id] = entry;
  diag.totalPlaced += 1;
}

// ─────────────────────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────────────────────

/**
 * Compute a LayoutPlan for a SemanticScene.
 *
 * Steps:
 *   1. Select (or accept) the layout template.
 *   2. Build the slot map for that template from config + metrics.
 *   3. For each top-level primitive, classify to a slot and assign world-space
 *      placement from that slot.
 *   4. Recursively stack and paginate all children in local space.
 *   5. Collect all LayoutEntries and return the LayoutPlan.
 *
 * @param scene    SemanticScene from mapIRToScene.
 * @param profile  Device profile supplying both LayoutConfig and RenderMetrics.
 *                 Use one of QUEST_3_PROFILE, QUEST_PRO_PROFILE, RAY_BAN_META_PROFILE,
 *                 or a custom profile.
 * @param template Explicit template override. When omitted, selectLayoutTemplate is called.
 * @param configOverrides Optional partial LayoutConfig to merge over profile.layoutConfig.
 * @param metricsOverrides Optional partial RenderMetrics to merge over profile.renderMetrics.
 */
export function computeLayoutPlan(
  scene: SemanticScene,
  profile: DeviceProfile,
  template?: LayoutTemplate,
  configOverrides?: Partial<LayoutConfig>,
  metricsOverrides?: Partial<RenderMetrics>,
): LayoutPlan {
  const config: LayoutConfig = { ...profile.layoutConfig, ...configOverrides };
  const metrics: RenderMetrics = {
    ...profile.renderMetrics,
    ...metricsOverrides,
  };

  const resolvedTemplate = template ?? selectLayoutTemplate(scene);

  const entries: Record<string, LayoutEntry> = {};
  const diag: LayoutDiagnostics = {
    paginatedPanelCount: 0,
    paginatedPanels: [],
    unplacedIds: [],
    totalPlaced: 0,
    fallbackHeightIds: [],
    paragraphContinuations: [],
    slotOverflows: [],
  };

  const slots = selectSlots(resolvedTemplate, config, metrics);
  const topLevelPrimitives = scene.root.children;
  const usedSlots = new Set<SlotName>();

  for (const primitive of topLevelPrimitives) {
    let slotName = classifyLandmark(primitive);

    if (usedSlots.has(slotName) && slotName !== "main") {
      slotName = "main";
    }
    usedSlots.add(slotName);

    const slot = slots[slotName] ?? slots.main;
    if (!slot) {
      diag.unplacedIds.push(primitive.id);
      continue;
    }

    layoutPrimitive(
      primitive,
      slot.position,
      slot.rotation,
      slot.size,
      slot.curveRadius,
      slot.worldLocked,
      scene,
      config,
      metrics,
      entries,
      diag,
    );
  }

  // XRScene root entry.
  entries[scene.root.id] = {
    id: scene.root.id,
    position: zeroVec(),
    rotation: zeroRotation(),
    size: { width: 0, height: 0 },
    curveRadius: 0,
    worldLocked: true,
  };

  // Catch orphans.
  for (const id of Object.keys(scene.primitives)) {
    if (!entries[id]) {
      diag.unplacedIds.push(id);
    }
  }

  if (diag.slotOverflows && diag.slotOverflows.length > 0) {
    // Each entry here means a non-paginating slot (banner/toc/navigation/
    // footer/complementary/alert/dialog) received content taller than the
    // fixed slot height the current template+profile assigns it. Since
    // stackChildrenSimple cannot paginate, that content is rendered past
    // the slot's intended bounds — most likely overlapping whatever
    // neighboring slot sits below it. This is a real layout defect, not
    // just a diagnostic curiosity: either the content needs to be shorter,
    // the template/profile needs a taller slot for this content, or this
    // primitive needs to be moved under an XRContentPanel so it can
    // paginate instead of silently overflowing.
    console.warn(
      `[layout] ${diag.slotOverflows.length} slot(s) overflowed their fixed height:`,
      diag.slotOverflows,
    );
  }

  return {
    entries,
    template: resolvedTemplate,
    config,
    diagnostics: diag,
  };
}

// ─────────────────────────────────────────────────────────────
// Convenience: merge LayoutPlan back into SemanticScene
// ─────────────────────────────────────────────────────────────

/**
 * Merge a LayoutPlan into a SemanticScene, overwriting each primitive's
 * `placement` field with the corresponding LayoutEntry.
 *
 * Returns a new SemanticScene (does not mutate the input).
 */
export function mergeLayoutPlan(
  scene: SemanticScene,
  plan: LayoutPlan,
): SemanticScene {
  const newPrimitives: Record<string, XRPrimitive> = {};
  for (const [id, primitive] of Object.entries(scene.primitives)) {
    const entry = plan.entries[id];
    if (!entry) {
      newPrimitives[id] = primitive;
      continue;
    }
    newPrimitives[id] = {
      ...(primitive as object),
      placement: {
        position: entry.position,
        rotation: entry.rotation,
        preferredSize: entry.size,
        curveRadius: entry.curveRadius,
        worldLocked: entry.worldLocked,
      },
    } as XRPrimitive;
  }
  return {
    ...scene,
    primitives: newPrimitives,
    root: (newPrimitives[scene.root.id] as typeof scene.root) ?? scene.root,
  };
}
