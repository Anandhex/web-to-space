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
 *     Used internally by paginateContentPanel's stampDescendants pass to
 *     compute local offsets for nodes not directly placed by the paginator.
 *     Also used by every container that is NOT an XRContentPanel (outside
 *     the paginated context entirely).
 *
 *   paginateContentPanel(children, panelWidth, scene, config, metrics, diag)
 *     Section-aware paginator. Only ever called for XRContentPanel nodes.
 *     After placing top-level children, runs a stampDescendants pass that
 *     walks the ENTIRE subtree and writes panel-absolute positions for every
 *     descendant into placedPositionMap. This gives the renderer ONE uniform
 *     coordinate system: entry.position is always panel-absolute, at any depth.
 *     The renderer never needs to distinguish "was this placed by the paginator
 *     directly?" from "was this placed by stackChildrenSimple?" — there is no
 *     longer a difference from the renderer's perspective.
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
  XRText,
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
  estimateInlineFlowHeight,
  estimateTextBearingHeight,
  flattenInlineWrappers,
  FIXED_HEIGHT_LOOKUP,
  isInlinePrimitive,
  listItemLabelBlockHeight,
  mergeAdjacentTextRuns,
  resolveListColumns,
  resolveTableStrategy,
  zeroRotation,
  zeroVec,
} from "./utils";

function sumChildrenHeights(
  children: XRPrimitive[],
  panelUsableWidth: number,
  metrics: RenderMetrics,
  config: LayoutConfig,
  ancestors: Set<string>,
  scene?: SemanticScene,
): number {
  if (children.length === 0) return 0;

  // Merge consecutive plain-text XRText siblings so fragmented runs like
  // ["This page was last edited on ", "20 June 2026", " (UTC)."] are
  // measured as a single word-count rather than three separate lines.
  // Also flatten inline-only XRGenericPanel wrappers for the same reason.
  const merged = flattenInlineWrappers(
    mergeAdjacentTextRuns(children as any[]) as XRPrimitive[],
  );

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

const LIST_ITEM_PROSE_INSET = 0.014;
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
    // One heading line is the minimum height regardless of child content.
    const minHeight = lineH + m.verticalPadding;

    if (primitive.children.length > 0) {
      // The renderer's hasTextChildren path delegates ALL inline children
      // (XRText, XRLink, XRButton) to renderChild → their own mesh components,
      // which render at their own metrics (XRTextMesh = 0.026, XRLinkMesh uses
      // link metrics, etc.). sumChildrenHeights matches that correctly.
      // The only missing piece was the heading-line floor: without it, a heading
      // whose XRText children total less than one heading line would be
      // underestimated. Apply the floor here.
      const childrenHeight = sumChildrenHeights(
        primitive.children,
        panelUsableWidth,
        metrics,
        config,
        branchAncestors,
        scene,
      );
      return Math.max(minHeight, childrenHeight);
    }

    // No children — measure label/content directly with heading metrics.
    const wordCount = countWords(primitive.content ?? primitive.label ?? "");
    if (wordCount <= 1) return minHeight;
    const wordsPerLine = computeWordsPerLine(panelUsableWidth, m);
    return Math.ceil(wordCount / wordsPerLine) * lineH + m.verticalPadding;
  }
  if (primitive.type === "XRText") {
    const text = (primitive as XRText).text || "";
    const wordCount = countWords(text);
    const m = metrics.paragraph;

    // Always return at least one line height
    if (wordCount === 0) {
      return m.fontSize * m.lineHeightRatio + m.verticalPadding;
    }
    const wordsPerLine = computeWordsPerLine(panelUsableWidth, m);
    const lineCount = Math.ceil(wordCount / Math.max(1, wordsPerLine));
    const lineH = m.fontSize * m.lineHeightRatio;
    return Math.max(
      lineH + m.verticalPadding,
      lineCount * lineH + m.verticalPadding,
    );
  }

  // ── Paragraph (word-count based) ──────────────────────────────────────────
  if (primitive.type === "XRParagraph") {
    // If paragraph has children, measure them with the inline-flow algorithm.
    // Consecutive XRText/XRLink/XRButton nodes are flowed onto the same line
    // until the line width is exhausted; XRImage/XRFigure nodes force a new
    // vertical row. Plain adjacent XRText siblings are merged first so
    // fragmented runs count words correctly.
    if (primitive.children.length > 0) {
      // FIX: flatten transparent XRGenericPanel wrappers (e.g. <i>, <span>)
      // BEFORE merging adjacent text runs, mirroring what XRParagraphMesh does
      // in primitives.tsx. Without this, italic/styled inline text wrapped in
      // XRGenericPanel is treated as a non-inline block child, causing the
      // height estimator to undercount inline content and clip the first
      // word(s) of paragraphs that begin with styled text like <i>KPop Demon
      // Hunters</i>.
      const merged = mergeAdjacentTextRuns(
        flattenInlineWrappers(primitive.children as any[]) as XRPrimitive[],
      ) as XRPrimitive[];
      const hasAnyInline = merged.some((c) => isInlinePrimitive(c.type));
      const hasAnyBlock = merged.some((c) => !isInlinePrimitive(c.type));

      if (hasAnyInline && !hasAnyBlock) {
        // Pure inline children — use flow estimation (no gaps between runs)
        const m = metrics.paragraph;
        const wordsPerLine = computeWordsPerLine(panelUsableWidth, m);
        const lineH = m.fontSize * m.lineHeightRatio;
        return estimateInlineFlowHeight(
          merged,
          wordsPerLine,
          lineH,
          m.verticalPadding,
          () => metrics.fallbackElementHeight,
          0, // no inter-run gaps for pure inline
        );
      }

      if (hasAnyBlock) {
        // Mixed inline+block — use flow estimation with gaps between rows
        const m = metrics.paragraph;
        const wordsPerLine = computeWordsPerLine(panelUsableWidth, m);
        const lineH = m.fontSize * m.lineHeightRatio;
        return estimateInlineFlowHeight(
          merged,
          wordsPerLine,
          lineH,
          m.verticalPadding,
          (child) =>
            estimateHeight(
              child as XRPrimitive,
              panelUsableWidth,
              metrics,
              config,
              branchAncestors,
              scene,
            ),
          config.childGapY,
        );
      }

      // Fallback: all children are unknown types — use sumChildrenHeights
      const childrenHeight = sumChildrenHeights(
        merged,
        panelUsableWidth,
        metrics,
        config,
        branchAncestors,
        scene,
      );
      return childrenHeight + metrics.paragraph.verticalPadding;
    }
    // No children - use word count from label
    return estimateParagraphHeight(
      primitive as XRParagraph,
      panelUsableWidth,
      metrics,
    );
  }

  if (primitive.type === "XRLink") {
    if (primitive.children.length > 0) {
      let totalHeight = 0;
      for (let i = 0; i < primitive.children.length; i++) {
        const child = primitive.children[i];
        const childHeight = estimateHeight(
          child,
          panelUsableWidth,
          metrics,
          config,
          ancestors,
          scene,
        );
        totalHeight += childHeight;
        if (i < primitive.children.length - 1) {
          totalHeight += config.childGapY;
        }
      }
      return Math.max(metrics.link.minHeight, totalHeight);
    }

    const height = estimateTextBearingHeight(
      primitive.label ?? "",
      panelUsableWidth,
      metrics.link,
      metrics.fallbackElementHeight,
    );

    return height;
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

      // XRListItem: primitive.label is the accessible-name/TOC string, never
      // rendered when children exist (see XRListItemMesh in primitives.tsx —
      // it would duplicate text already present in the inline XRText/XRLink
      // children). So when there ARE children, card height is just their
      // stacked height — no label row is drawn, so no space is reserved for
      // one. When there are NO children, label/content is the item's only
      // displayable text (a plain-text <li> with no inline tags produces
      // children: [] in parser.ts's createListItem — text-only nodes are
      // dropped from contentEl.children), so labelBlockHeight still applies.
      if (primitive.type === "XRListItem") {
        if (primitive.children.length > 0) {
          // The renderer (XRListItemMesh) flattens inline-only XRGenericPanel
          // wrappers and then flows all XRText/XRLink/XRButton children as a
          // single continuous prose run — exactly like XRParagraphMesh does.
          // sumChildrenHeights would treat each fragment as a separate stacked
          // block with its own lineH + verticalPadding + childGapY, producing
          // a wildly overestimated card height. We must mirror the renderer:
          // flatten wrappers → merge adjacent text → estimateInlineFlowHeight.
          const flattened = mergeAdjacentTextRuns(
            flattenInlineWrappers(primitive.children as any[]) as XRPrimitive[],
          );
          const hasAnyInline = flattened.some((c) => isInlinePrimitive(c.type));
          const hasAnyBlock = flattened.some((c) => !isInlinePrimitive(c.type));
          const m = metrics.paragraph;
          const wordsPerLine = computeWordsPerLine(
            panelUsableWidth - LIST_ITEM_PROSE_INSET,
            m,
          );
          const lineH = m.fontSize * m.lineHeightRatio;

          let contentHeight: number;
          if (hasAnyInline) {
            // Inline flow — all XRText/XRLink segments measured as one prose run,
            // block children (sub-lists, images) measured individually and stacked.
            contentHeight = estimateInlineFlowHeight(
              flattened,
              wordsPerLine,
              lineH,
              0,
              (child) =>
                estimateHeight(
                  child as XRPrimitive,
                  panelUsableWidth,
                  metrics,
                  config,
                  branchAncestors,
                  scene,
                ),
              hasAnyBlock ? config.childGapY : 0,
            );
          } else {
            // All children are blocks (e.g. a list item that contains only a
            // sub-list or an image) — stack them normally.
            contentHeight = sumChildrenHeights(
              flattened,
              panelUsableWidth,
              metrics,
              config,
              branchAncestors,
              scene,
            );
          }

          const lineH2 =
            metrics.paragraph.fontSize * metrics.paragraph.lineHeightRatio;
          return Math.max(lineH2 + 0.02, contentHeight);
        }
        const labelBlockHeight = listItemLabelBlockHeight(
          primitive.label,
          metrics,
        );
        return Math.max(
          metrics.listItem.minHeight,
          labelBlockHeight ||
            estimateTextBearingHeight(
              primitive.content ?? primitive.label ?? "",
              panelUsableWidth,
              metrics.listItem,
              metrics.fallbackElementHeight,
            ),
        );
      }

      // Add child content height if present (e.g. XRAlert with body paragraphs,
      // XRTreeItem with nested items)
      if (primitive.children.length > 0) {
        let childrenHeight = sumChildrenHeights(
          primitive.children,
          panelUsableWidth,
          metrics,
          config,
          branchAncestors,
          scene,
        );
        childrenHeight = childrenHeight + config.panelPaddingTop * 2;
        return Math.max(labelHeight, childrenHeight);
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

  // ── Card grid: per-card height comes from the XRListItem branch above ────
  // Previously this duplicated that formula with its own word-wrapped label
  // estimate (estimateTextBearingHeight applied to item.label), which models
  // a label that can wrap onto multiple lines. XRListItemMesh renders the
  // label as a single fixed-size top line that does NOT wrap (see
  // primitives.tsx) — so the wrapped estimate here could produce a taller
  // number than the card actually needs, or disagree with the per-item
  // estimate if either formula changed without the other. Delegating to
  // estimateHeight(item, ...) guarantees this grid path and a standalone
  // estimateHeight(someListItem, ...) call always agree.
  if (primitive.type === "XRList") {
    const columns = resolveListColumns(
      primitive as XRList,
      panelUsableWidth,
      metrics,
    );
    const cardUsableWidth = Math.max(
      0.025,
      panelUsableWidth / columns - LIST_ITEM_PROSE_INSET,
    );
    const cardHeights =
      primitive.children.length > 0
        ? primitive.children.map((item: XRPrimitive) =>
            estimateHeight(
              item,
              cardUsableWidth,
              metrics,
              config,
              new Set(branchAncestors),
              scene,
            ),
          )
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

  if (primitive.children.length > 0) {
    // stackChildrenSimple subtracts panelPaddingX from both sides for containers
    // in OWNS_X_PADDING before passing width to children. Match that here or
    // text wraps to a different line count than estimated → height mismatch.
    const childEstimateWidth = OWNS_X_PADDING.has(primitive.type)
      ? Math.max(0.025, panelUsableWidth - config.panelPaddingX * 2)
      : panelUsableWidth;

    // FIX: flatten transparent XRGenericPanel wrappers and merge adjacent
    // text runs BEFORE measuring, then use inline-flow estimation for any
    // inline (XRText/XRLink/XRButton) content instead of summing each
    // child as its own independently-stacked block.
    //
    // Without this, a primitive like XRGenericPanel (no dedicated branch
    // above — it always lands here) measured its own height by treating
    // EVERY child as a full row with childGapY between each, even when the
    // children were a prose run of [XRLink, XRText, XRLink, XRText, …] that
    // should flow onto shared lines. That produced a height (e.g. 0.4639m
    // for a short two-line bio) wildly larger than what XRListItemMesh /
    // XRParagraphMesh actually render when the SAME content appears as
    // their child — those call sites already use inline-flow correctly.
    // The mismatch meant a list item's measured height (via the correct
    // inline-flow path in the XRListItem branch above) ended up SMALLER
    // than its own prose child's self-reported height (via this buggy
    // path), leaving a visible gap below the rendered text — the box
    // border stopped where the listitem THOUGHT the content ended, well
    // short of where the renderer actually drew it.
    const merged = flattenInlineWrappers(
      mergeAdjacentTextRuns(primitive.children as any[]) as XRPrimitive[],
    );
    const hasAnyInline = merged.some((c) => isInlinePrimitive(c.type));
    const hasAnyBlock = merged.some((c) => !isInlinePrimitive(c.type));

    let fromChildren: number;
    if (hasAnyInline) {
      const m = metrics.paragraph;
      const wordsPerLine = computeWordsPerLine(childEstimateWidth, m);
      const lineH = m.fontSize * m.lineHeightRatio;
      const contentHeight = estimateInlineFlowHeight(
        merged,
        wordsPerLine,
        lineH,
        0,
        (c) =>
          estimateHeight(
            c as XRPrimitive,
            childEstimateWidth,
            metrics,
            config,
            ancestors,
            scene,
          ),
        hasAnyBlock ? config.childGapY : 0,
      );
      const paddingContrib = OWNS_X_PADDING.has(primitive.type)
        ? config.panelPaddingTop * 2
        : 0;
      fromChildren = paddingContrib + contentHeight;
    } else {
      const childHeights = merged.map((c) =>
        estimateHeight(
          c,
          childEstimateWidth,
          metrics,
          config,
          ancestors,
          scene,
        ),
      );
      const total = childHeights.reduce((s, h) => s + h, 0);
      const gaps = config.childGapY * Math.max(0, merged.length - 1);
      const paddingContrib = OWNS_X_PADDING.has(primitive.type)
        ? config.panelPaddingTop * 2
        : 0;
      fromChildren = paddingContrib + total + gaps;
    }

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

// Containers that own horizontal padding — their worldSize.width is the full
// slot/panel width and children must be inset by panelPaddingX on each side.
// All other types receive a worldSize.width that is already the usable content
// width, so no further x-padding should be subtracted.
const OWNS_X_PADDING = new Set([
  "XRContentPanel",
  "XRSection",
  "XRArticle",
  "XRFormPanel",
  "XRFormField",
  "XRList",
  "XRNavigationBar",
  "XRBanner",
  "XRFooter",
  "XRComplementary",
  "XRDialog",
  "XRTabGroup",
  "XRTabPanel",
  "XRTree",
  "XRMenu",
]);

// Containers that reserve vertical space at the top for their own label/header.
// Children must start below that reserved space, not at y = 0.
// XRListItem is included for historical/structural reasons (it's a
// label-bearing container in principle) but its actual topOffset is 0 — see
// stackChildrenSimple below — since XRListItemMesh never draws a label row
// when the item has children, so there's nothing to reserve space for.
const OWNS_TOP_PADDING = new Set([...Array.from(OWNS_X_PADDING), "XRListItem"]);

function stackChildrenSimple(
  children: XRPrimitive[],
  panelWidth: number,
  config: LayoutConfig,
  metrics: RenderMetrics,
  parentType?: string,
  listColumns?: number,
  // parentLabel is no longer used here (XRListItem's topOffset is now always
  // 0 — see below) but kept in the signature to avoid a churn-y signature
  // change across both call sites for a label that may regain a use if
  // XRListItem's contract changes again.
  parentLabel?: string | null,
): SimpleStackResult {
  if (children.length === 0) {
    return { childEntries: [], totalHeight: 0 };
  }

  // X-padding: only containers that own their full slot width subtract panelPaddingX.
  // Y-padding: containers that render their own label/header at the top need
  // children to start below that label, not at y = 0.
  const ownsXPadding = !parentType || OWNS_X_PADDING.has(parentType);
  const ownsTopPadding = !parentType || OWNS_TOP_PADDING.has(parentType);
  // XRListItem never renders primitive.label as text when it has children
  // (see XRListItemMesh in primitives.tsx) — this function only runs with
  // parentType === "XRListItem" when that item's children.length > 0 (the
  // early-return above handles the empty case), so no label row is ever
  // drawn for any call that reaches here. Children therefore start at the
  // card's top edge, offset 0 — there's nothing above them to clear.
  const topOffset = parentType === "XRListItem" ? 0 : config.panelPaddingTop;
  const childWidth = ownsXPadding
    ? Math.max(0.025, panelWidth - config.panelPaddingX * 2)
    : Math.max(0.025, panelWidth);
  const panelUsableWidth = childWidth;

  // ── XRList grid layout ────────────────────────────────────────────────────
  // XRListItem children must be placed side-by-side in rows of `columns`
  // cards. Each card gets `cardUsableWidth = childWidth / columns`.
  // This path is taken only when the caller identifies the parent as XRList
  // and supplies a resolved column count.
  if (parentType === "XRList" && listColumns && listColumns > 1) {
    console.log("Stacking XRList with grid layout:", {
      childWidth,
      listColumns,
    });
    const columns = listColumns;
    const cardWidth = Math.max(0.025, childWidth / columns);
    const rowCount = Math.ceil(children.length / columns);
    const childEntries: LayoutEntry[] = [];
    // cursorY starts at 0 (no internal top padding): the XRList container's
    // own position already accounts for padding contributed by its parent's
    // stackChildrenSimple call. Adding panelPaddingTop here again would push
    // all items down by a second padding unit (double-padding bug).
    let cursorY = 0;
    let totalHeight = 0;

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
    // No extra panelPaddingTop added here: the list container's height
    // already includes surrounding padding from its parent's estimateHeight.

    return { childEntries, totalHeight };
  }

  // ── Default: single-column vertical stack ────────────────────────────────
  // Panel-like containers start the cursor below their own top padding and
  // indent children by panelPaddingX. Content nodes (XRParagraph, XRHeading,
  // …) have no internal padding — children start at y=0 and x=0 relative to
  // the container, since the container itself is already inset correctly by
  // its parent. XRListItem's topOffset is 0 (no label row is drawn when it
  // has children — see topOffset above), so it behaves like the latter group
  // despite being in OWNS_TOP_PADDING.
  const startY = ownsTopPadding ? -topOffset : 0;
  const childX = ownsXPadding ? config.panelPaddingX : 0;
  let cursorY = startY;
  const childEntries: LayoutEntry[] = [];

  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    let h = estimateHeight(child, panelUsableWidth, metrics, config, new Set());

    if (!h || h <= 0 || !isFinite(h)) {
      h = metrics.fallbackElementHeight;
      console.warn(`Child ${child.id} had zero height, using fallback`, child);
    }

    const gap = i === 0 ? 0 : config.childGapY;

    const entry: LayoutEntry = {
      id: child.id,
      position: { x: childX, y: cursorY - gap, z: 0 },
      rotation: zeroRotation(),
      size: { width: childWidth, height: h },
      curveRadius: 0,
      worldLocked: true,
    };
    attachResolvedStrategies(entry, child, panelUsableWidth, metrics);
    childEntries.push(entry);
    cursorY -= gap + h;
  }

  // paddingContrib mirrors startY's reservation, plus a matching bottom gap —
  // but only for true panel-padding containers, which reserve panelPaddingTop
  // at BOTH top and bottom symmetrically. XRListItem contributes topOffset
  // (always 0, single not doubled — no bottom label-gap equivalent exists)
  // rather than the doubled panelPaddingTop the other containers use.
  const paddingContrib = ownsTopPadding
    ? parentType === "XRListItem"
      ? topOffset
      : topOffset * 2
    : 0;
  const totalHeight =
    paddingContrib +
    childEntries.reduce((s, e) => s + e.size.height, 0) +
    config.childGapY * Math.max(0, children.length - 1);

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
 * Coordinate system
 * ──────────────────
 * All positions in placedPositionMap are PANEL-ABSOLUTE: relative to the
 * XRContentPanel's top-left origin. The stampDescendants pass (run after the
 * main pagination loop) walks every descendant and converts their
 * stackChildrenSimple-computed local offsets to panel-absolute before writing
 * them to the map. The renderer therefore uses entry.position as-is for every
 * node with no special casing.
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
    };
  }

  const childWidth = Math.max(0.025, panelWidth - config.panelPaddingX * 2);
  const VIEWPORT = config.maxPanelViewportHeight;

  const positionMap: Map<string, Vec3> = new Map();
  const heightMap: Map<string, number> = new Map();
  const pageIndexMap: Record<string, number> = {};
  const pageYOffsets: number[] = [0];

  let pageIdx = 0;
  let pageHeight = config.panelPaddingTop;
  let itemsOnPage = 0;
  let cursorY = -config.panelPaddingTop;
  let absoluteY = config.panelPaddingTop;

  function nextPage(absolutePageStart: number): void {
    pageYOffsets.push(absolutePageStart);
    pageIdx += 1;
    pageHeight = config.panelPaddingTop;
    itemsOnPage = 0;
    cursorY = -config.panelPaddingTop;
  }

  function stampSubtree(node: XRPrimitive, page: number): void {
    pageIndexMap[node.id] = page;
    for (const child of node.children) stampSubtree(child, page);
  }

  function isSectionLike(p: XRPrimitive): boolean {
    return (
      p.type === "XRSection" ||
      p.type === "XRArticle" ||
      p.type === "XRFormPanel" ||
      p.type === "XRFormField"
    );
  }

  // ── Simplified splitSection ───────────────────────────────────────────────
  // Now handles children as atomic units. Text nodes are atomic.
  // No paragraph splitting - children move as whole units.
  function splitSection(section: XRPrimitive): void {
    for (let j = 0; j < section.children.length; j++) {
      const sc = section.children[j];

      // ── Section-like child ─────────────────────────────────────────────────
      if (isSectionLike(sc)) {
        if (sc.children.length === 0) continue;

        // Force fresh page for sections
        if (config.sectionStartsOnNewPage !== false && itemsOnPage > 0) {
          const absOffsetBase = pageYOffsets[pageIdx] ?? 0;
          pageYOffsets.push(absOffsetBase + VIEWPORT);
          pageIdx += 1;
          pageHeight = config.panelPaddingTop;
          itemsOnPage = 0;
          cursorY = -config.panelPaddingTop;
        }

        pageIndexMap[sc.id] = pageIdx;
        positionMap.set(sc.id, {
          x: config.panelPaddingX,
          y: cursorY - (itemsOnPage > 0 ? config.childGapY : 0),
          z: 0,
        });

        const pageBeforeRecursion = pageIdx;
        splitSection(sc);
        if (pageIdx === pageBeforeRecursion) {
          heightMap.set(sc.id, pageHeight - config.panelPaddingTop);
        } else {
          heightMap.set(sc.id, VIEWPORT - config.panelPaddingTop);
        }
        continue;
      }

      // ── Generic panel child ──────────────────────────────────────────────
      if (sc.type === "XRGenericPanel") {
        if (sc.children.length === 0) continue;

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

      // ── Leaf child (atomic) ──────────────────────────────────────────────
      // No paragraph splitting - the child is measured as a whole
      const sch = estimateHeight(
        sc,
        childWidth,
        metrics,
        config,
        new Set(),
        scene,
      );
      const scGap = itemsOnPage > 0 ? config.childGapY : 0;

      // If the child doesn't fit on the current page, move to next page
      if (pageHeight + scGap + sch > VIEWPORT && itemsOnPage > 0) {
        const absOffsetBase = pageYOffsets[pageIdx] ?? 0;
        pageYOffsets.push(absOffsetBase + VIEWPORT);
        pageIdx += 1;
        cursorY = -config.panelPaddingTop;
        pageHeight = config.panelPaddingTop;
        itemsOnPage = 0;
      }

      // Place the child on the current page
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
  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    const h = estimateHeight(
      child,
      childWidth,
      metrics,
      config,
      new Set(),
      scene,
    );

    if (isSectionLike(child)) {
      if (child.children.length === 0) continue;

      if (config.sectionStartsOnNewPage !== false && itemsOnPage > 0) {
        nextPage(absoluteY);
        absoluteY = config.panelPaddingTop;
      }

      pageIndexMap[child.id] = pageIdx;
      positionMap.set(child.id, {
        x: config.panelPaddingX,
        y: -config.panelPaddingTop,
        z: 0,
      });

      const pageBeforeRecursion = pageIdx;
      splitSection(child);
      if (pageIdx === pageBeforeRecursion) {
        heightMap.set(child.id, pageHeight - config.panelPaddingTop);
      } else {
        heightMap.set(child.id, VIEWPORT - config.panelPaddingTop);
      }
      absoluteY = config.panelPaddingTop + pageHeight;
    } else if (child.type === "XRGenericPanel") {
      if (child.children.length === 0) continue;

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
      // Atomic leaf child
      const gap = itemsOnPage === 0 ? 0 : config.childGapY;

      // If child doesn't fit, move to next page
      if (pageHeight + gap + h > VIEWPORT && itemsOnPage > 0) {
        nextPage(absoluteY);
        absoluteY = config.panelPaddingTop;
      }

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

  // ── Stamp all descendants with panel-absolute positions ───────────────────
  // positionMap currently contains only the nodes that the main pagination
  // loop and splitSection explicitly placed (sections, generic panels, and
  // direct atomic leaves). Any deeper descendants — e.g. children of XRList,
  // XRListItem, XRFigure, nested XRGenericPanel inside a list item — are
  // absent from the map.
  //
  // Without this pass, layoutPrimitive would fall back to stackChildrenSimple
  // for those missing levels and produce PARENT-RELATIVE positions, creating
  // a second coordinate system that the renderer would have to handle with
  // special cases. Instead we complete the map here so every descendant has
  // a PANEL-ABSOLUTE position, giving the renderer one uniform coordinate
  // system: always use entry.position as-is, always wrap in a group at that
  // position, never worry about whether a node is "inside" or "outside" the
  // paginator's direct scope.
  // Node types that own inline text rendering. Their inline children
  // (XRText, XRLink, XRButton) are flowed as text runs by the mesh
  // component — they are NOT positioned as independent 3D nodes. Stamping
  // panel-absolute positions for them would cause PrimitiveDispatcher to
  // render them as displaced groups on top of the already-rendered text.
  // Only non-inline (block) children of these nodes need stamping — those
  // are dispatched via renderChild as positioned sub-panels (e.g. a sub-list
  // inside a list item, or an image inside a paragraph).
  const INLINE_OWNING_TYPES = new Set([
    "XRParagraph",
    "XRHeading",
    "XRListItem",
    "XRBlockQuote",
  ]);

  function stampDescendants(
    node: XRPrimitive,
    absX: number,
    absY: number,
    availableWidth: number,
  ): void {
    if (node.children.length === 0) return;

    // If this node owns inline text rendering, skip stamping pure inline
    // children — they are rendered as text runs by the mesh component, not
    // as independent positioned 3D nodes. Only recurse into block children
    // (sub-lists, images, etc.) which ARE dispatched via renderChild.
    //
    // XRGenericPanel is also treated as an inline-owning wrapper when ALL of
    // its children are inline (XRText/XRLink/XRButton). In that case the parent
    // XRListItemMesh uses flattenInlineWrappers() to see through it and renders
    // the children as a prose run — so we must NOT stamp them as positioned 3D
    // nodes. If the XRGenericPanel has mixed or block-only children, fall through
    // to the normal path so block children get panel-absolute positions.
    const isInlineWrapper =
      node.type === "XRGenericPanel" &&
      node.children.length > 0 &&
      node.children.every((c) => isInlinePrimitive(c.type));

    const hasOnlyBlockChildren =
      node.type === "XRListItem" &&
      node.children.length > 0 &&
      node.children.every((c) => !isInlinePrimitive(c.type));

    if (
      (INLINE_OWNING_TYPES.has(node.type) || isInlineWrapper) &&
      !hasOnlyBlockChildren
    ) {
      for (const child of node.children) {
        if (!isInlinePrimitive(child.type)) {
          // Block child inside an inline-owning container: it IS dispatched
          // via renderChild and needs a panel-absolute position.
          if (!positionMap.has(child.id)) {
            // Position it immediately below the parent's top edge as a best
            // estimate — the mesh component controls exact Y via renderChild.
            const panelAbs: Vec3 = { x: absX, y: absY, z: 0 };
            positionMap.set(child.id, panelAbs);
            heightMap.set(
              child.id,
              estimateHeight(
                child,
                availableWidth,
                metrics,
                config,
                new Set(),
                scene,
              ),
            );
            if (pageIndexMap[child.id] === undefined) {
              pageIndexMap[child.id] = pageIndexMap[node.id] ?? pageIdx;
            }
          }
          const childAbs = positionMap.get(child.id)!;
          stampDescendants(child, childAbs.x, childAbs.y, availableWidth);
        }
      }
      return;
    }

    // If the children are already in positionMap (stamped by splitSection or
    // the main loop), just recurse with their known absolute positions.
    const firstChild = node.children[0];
    if (firstChild && positionMap.has(firstChild.id)) {
      for (const child of node.children) {
        const childAbs = positionMap.get(child.id);
        if (!childAbs) continue;
        stampDescendants(child, childAbs.x, childAbs.y, availableWidth);
      }
      return;
    }

    // Children are NOT in the map yet. Run stackChildrenSimple in the context
    // of this node to get their local-to-parent positions, then convert each
    // to panel-absolute by adding the parent's known absolute position.
    const resolvedListColumns =
      node.type === "XRList"
        ? resolveListColumns(node as XRList, availableWidth, metrics)
        : undefined;

    const { childEntries } = stackChildrenSimple(
      node.children,
      availableWidth,
      config,
      metrics,
      node.type,
      resolvedListColumns,
      node.label,
    );

    for (let i = 0; i < node.children.length; i++) {
      const child = node.children[i];
      const local = childEntries[i];
      if (!local) continue;

      const panelAbs: Vec3 = {
        x: absX + local.position.x,
        y: absY + local.position.y,
        z: local.position.z,
      };
      positionMap.set(child.id, panelAbs);
      heightMap.set(child.id, local.size.height);

      // Inherit page index from the parent if not already stamped.
      if (pageIndexMap[child.id] === undefined) {
        pageIndexMap[child.id] = pageIndexMap[node.id] ?? pageIdx;
      }

      // Recurse: the child's usable width comes from stackChildrenSimple's
      // entry, which already accounts for the child's own x-padding.
      stampDescendants(child, panelAbs.x, panelAbs.y, local.size.width);
    }
  }

  // Kick off the pass from each top-level child that was placed by the main
  // pagination loop. Their absolute positions are already in positionMap.
  for (const child of children) {
    const abs = positionMap.get(child.id);
    if (!abs) continue;
    stampDescendants(child, abs.x, abs.y, childWidth);
  }

  const totalPages = pageIdx + 1;
  const pagination =
    totalPages > 1
      ? { pageCount: totalPages, pageZStep: config.pageZStep, pageYOffsets }
      : null;

  return {
    pagination,
    pageIndexMap,
    placedPositionMap: positionMap,
    placedHeightMap: heightMap,
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
      const {
        pagination,
        pageIndexMap: newPageIndexMap,
        placedPositionMap: newPlacedPositionMap,
        placedHeightMap: newPlacedHeightMap,
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
      // ── Inside a paginated panel ──────────────────────────────────────────────
      // paginateContentPanel's stampDescendants pass has written panel-absolute
      // positions for EVERY descendant into placedPositionMap. There is one
      // coordinate system: always look up from the map, never call
      // stackChildrenSimple. The renderer uses entry.position uniformly for
      // every node with no special cases.
      //
      // Inline-owning nodes (XRParagraph, XRHeading, XRListItem, XRBlockQuote)
      // render their inline children (XRText, XRLink, XRButton) as text runs
      // internally — those children are NOT independent 3D nodes and must NOT
      // get LayoutEntries. stampDescendants already skips stamping positions for
      // them; here we skip producing LayoutEntries for them too.
      if (
        primitive.type === "XRParagraph" ||
        primitive.type === "XRHeading" ||
        primitive.type === "XRListItem" ||
        primitive.type === "XRBlockQuote"
      ) {
        // Only recurse into block (non-inline) children — e.g. a sub-list or
        // image inside a list item, which ARE dispatched via renderChild.
        for (const child of primitive.children) {
          if (isInlinePrimitive(child.type)) continue;
          const childPos = placedPositionMap.get(child.id) ?? {
            x: config.panelPaddingX,
            y: -config.panelPaddingTop,
            z: 0,
          };
          const childPageIndex = pageIndexMap?.[child.id] ?? inheritedPageIndex;
          const childHeight =
            placedHeightMap.get(child.id) ??
            estimateHeight(
              child,
              Math.max(0.025, worldSize.width),
              metrics,
              config,
              new Set(),
              scene,
            );
          layoutPrimitive(
            child,
            childPos,
            zeroRotation(),
            { width: worldSize.width, height: childHeight },
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
        entries[primitive.id] = entry;
        diag.totalPlaced += 1;
        return;
      }

      const listCols =
        primitive.type === "XRList" && (entry.listColumns ?? 1) > 1
          ? entry.listColumns!
          : null;

      const listCardWidth = listCols
        ? Math.max(
            0.025,
            (worldSize.width -
              config.panelPaddingX * 2 -
              config.childGapY * (listCols - 1)) /
              listCols,
          )
        : null;

      for (const child of primitive.children) {
        const childPos = placedPositionMap.get(child.id) ?? {
          x: config.panelPaddingX,
          y: -config.panelPaddingTop,
          z: 0,
        };
        const childPageIndex = pageIndexMap?.[child.id] ?? inheritedPageIndex;

        let childHeight = placedHeightMap.get(child.id);

        const childWidth = listCardWidth ?? Math.max(0.025, worldSize.width);
        if (childHeight === undefined) {
          diag.missingHeightMapEntries =
            (diag.missingHeightMapEntries ?? 0) + 1;
          childHeight = estimateHeight(
            child,
            childWidth,
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
          { width: childWidth, height: childHeight },
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
    } else {
      // ── Outside any XRContentPanel — stackChildrenSimple ─────────────────
      const resolvedListColumns =
        primitive.type === "XRList" ? (entry.listColumns ?? 1) : undefined;

      const { childEntries, totalHeight } = stackChildrenSimple(
        primitive.children,
        worldSize.width,
        config,
        metrics,
        primitive.type,
        resolvedListColumns,
        primitive.label,
      );

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
  console.log(entries);
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
