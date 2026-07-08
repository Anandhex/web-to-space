import type {
  Vec3,
  Rotation3,
  Size2,
  XRPrimitive,
  XRHeading,
  XRImage,
  XRParagraph,
  XRTable,
  SemanticScene,
  XRText,
} from "../mapper/types";
import {
  _estimateTextBearingItemHeight,
  estimateHeight,
  flattenAndMerge,
  isIconSizedImage,
  PRIMITIVE_CONFIG,
  resolveImageDisplaySize,
} from "./positionConfigs";
import { selectSlots } from "./slots";
import { resolveArrangementSlots } from "./arrangements";
import { selectLayoutTemplate } from "./templates";
import type {
  Arrangement,
  DeviceProfile,
  LayoutTemplate,
  RenderMetrics,
  PrimitiveFontMetrics,
  LayoutEntry,
  LayoutDiagnostics,
  LayoutPlan,
  LayoutConfig,
  SlotName,
  SimpleStackResult,
  PaginateResult,
} from "./types";
import {
  computeWordsPerLine,
  containerInsetX,
  countWords,
  flattenInlineWrappers,
  isInlinePrimitive,
  resolveListColumns,
  resolveTableStrategy,
  zeroRotation,
  zeroVec,
} from "./utils";

// ── Shared helpers ────────────────────────────────────────────────────────────

function topOfPagePos(config: LayoutConfig): Vec3 {
  return { x: config.panelPaddingX, y: -config.panelPaddingTop, z: 0 };
}

// ─────────────────────────────────────────────────────────────
// Landmark classifier
// ─────────────────────────────────────────────────────────────

function classifyLandmark(primitive: XRPrimitive): SlotName {
  const cfg = PRIMITIVE_CONFIG[primitive.type];
  if (!cfg) return "main";
  if (cfg.slotFn) return cfg.slotFn(primitive);
  return cfg.slot;
}

// ─────────────────────────────────────────────────────────────
// Simple vertical stacker  (non-paginating, depth > 0)
// ─────────────────────────────────────────────────────────────

// Pure vertical stacker for non-paginating containers. Caller dispatches to
// paginateContentPanel instead when the container is an XRContentPanel.

// Node types that own inline text rendering. Their inline children
// (XRText, XRLink, XRButton) are flowed as text runs by the mesh
// component — they are NOT positioned as independent 3D nodes.
const INLINE_OWNING_TYPES = new Set([
  "XRParagraph",
  "XRHeading",
  "XRListItem",
  "XRBlockQuote",
  "XRLink",
  "XRButton",
  // NOTE: XRTableCell's heightStrategy is "mixed" too (estimateMixedContentHeight
  // with metrics.paragraph), which has the same estimate/position mismatch as
  // the types above — a cell's inline content (e.g. a "5" text node followed
  // by a "{3,3}" link) gets stacked as separate full-width rows instead of
  // flowing on one line. Adding "XRTableCell" here fixes that, but on this
  // codebase's large Wikipedia tables it currently makes the layout pass slow
  // enough to trip the WebGL context's hang detection (visible as "Context
  // Lost" in the console) — needs a perf pass before it can be turned on.
]);

// An XRGenericPanel (a role-less wrapper div/span) is ALSO inline-owning when
// every one of its effective children (after seeing through nested transparent
// wrappers) is an inline primitive — e.g. Wikipedia's
// <span class="mw-reference-text"><cite>…</cite></span>. stampDescendants
// relies on this same check to decide which nodes to skip stamping; every
// call site that mirrors stampDescendants' decisions (i.e. whether to build a
// LayoutEntry for a child at all) MUST use this exact helper, or the two
// passes disagree and children stampDescendants deliberately left unstamped
// get a bogus fallback LayoutEntry (wrong page, position pinned to the top of
// the page) instead of none.
// Font metrics an inline-owning node's own prose is rendered with — needed
// to size the inline runs that separate its block children (see
// stampDescendants' block-positioning pass below). Must match whatever
// estimateHeight/_estimate*Height picks for the same node type, or the
// positions computed here will disagree with the space already reserved
// during height estimation.
function inlineOwnerFontMetrics(
  node: { type: string; level?: number | null },
  metrics: RenderMetrics,
): PrimitiveFontMetrics {
  switch (node.type) {
    case "XRHeading": {
      const level = (node.level ?? 2) as 1 | 2 | 3 | 4 | 5 | 6;
      return metrics.heading[level] ?? metrics.heading[2] ?? metrics.paragraph;
    }
    case "XRBlockQuote":
      return metrics.blockQuote;
    case "XRLink":
      return metrics.link.font;
    case "XRButton":
      return metrics.button.font;
    default:
      return metrics.paragraph;
  }
}

function isInlineOwningNode(node: {
  type: string;
  children: unknown[];
}): boolean {
  if (INLINE_OWNING_TYPES.has(node.type)) return true;
  if (node.type !== "XRGenericPanel" || node.children.length === 0)
    return false;
  const flatEffective = flattenInlineWrappers(node.children as any[]);
  return (
    flatEffective.length > 0 &&
    flatEffective.every((c: any) => isInlinePrimitive(c.type))
  );
}

// Whether a child of an inline-owning node is rendered as part of the
// parent's merged prose text run (by flattenInlineWrappers, inside the mesh
// component) rather than as an independent positioned 3D node. True for the
// obvious inline primitives (XRText/XRLink/XRButton) AND for an
// XRGenericPanel wrapper whose own effective children are all inline (e.g.
// Wikipedia's <span class="frac">, which the mapper can't classify as
// inline and falls through to XRGenericPanel, but which
// flattenInlineWrappers still sees through when rendering prose).
//
// stampDescendants and layoutPrimitive both decide, independently, which
// children of an inline-owning node get a LayoutEntry. They MUST agree, or
// one produces no entry (correctly, nothing to position) while the other
// still calls layoutPrimitive on it and falls back to a bogus top-of-page
// position for every such child — collapsing all of them onto the same
// point instead of leaving them unpositioned.
function isFlattenedIntoProse(child: {
  type: string;
  children: unknown[];
}): boolean {
  if (isInlinePrimitive(child.type)) return true;
  if (child.type !== "XRGenericPanel") return false;
  const flat = flattenInlineWrappers(child.children as any[]);
  return flat.length > 0 && flat.every((c: any) => isInlinePrimitive(c.type));
}

// Padding ownership is now driven by PRIMITIVE_CONFIG (ownsXPadding / ownsTopPadding).

function stackChildrenSimple(
  children: XRPrimitive[],
  panelWidth: number,
  config: LayoutConfig,
  metrics: RenderMetrics,
  parentType?: string,
  listColumns?: number,
  _parentLabel?: string | null,
): SimpleStackResult {
  if (children.length === 0) {
    return { childEntries: [], totalHeight: 0 };
  }

  // X-padding: only containers that own their full slot width subtract panelPaddingX.
  // Y-padding: containers that render their own label/header at the top need
  // children to start below that label, not at y = 0.
  const parentCfg = parentType
    ? PRIMITIVE_CONFIG[parentType as import("../mapper/types").XRPrimitiveType]
    : undefined;
  const ownsXPadding = !parentType || parentCfg?.ownsXPadding === true;
  const ownsTopPadding = !parentType || parentCfg?.ownsTopPadding === true;
  const topOffset = config.panelPaddingTop;
  const insetX = containerInsetX(panelWidth, config.panelPaddingX);
  const childWidth = ownsXPadding
    ? Math.max(0.025, panelWidth - insetX * 2)
    : Math.max(0.025, panelWidth);
  const panelUsableWidth = childWidth;

  // ── XRList grid layout ────────────────────────────────────────────────────
  // XRListItem children must be placed side-by-side in rows of `columns`
  // cards. Each card gets `cardUsableWidth = childWidth / columns`.
  // This path is taken only when the caller identifies the parent as XRList
  // and supplies a resolved column count.
  if (parentType === "XRList" && listColumns && listColumns > 1) {
    const columns = listColumns;
    const cardWidth = Math.max(
      0.025,
      (childWidth - config.childGapY * (columns - 1)) / columns,
    );
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
            x: insetX + colIdx * (cardWidth + config.childGapY),
            y: rowY,
            z: 0,
          },
          rotation: zeroRotation(),
          size: { width: cardWidth, height: rowHeights[colIdx] ?? rowH },
          curveRadius: 0,
          worldLocked: true,
          // Stamped on each item (not just the XRList container) so
          // XRListItemMesh can tell a grid tile apart from a flat list row
          // without needing to look up its parent.
          listColumns: columns,
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

  // ── Inline icon-image strip ────────────────────────────────────────────────
  // A wrapper whose children are ALL icon-sized images (e.g. every glyph in a
  // Wikipedia Coxeter-Dynkin diagram: node-edge-node-edge-...) represents one
  // horizontally-flowing diagram, not a vertical list of photos. The default
  // branch below gives every child the full container width and stacks them
  // one per row — stretching each tiny glyph (often under 10px wide natively)
  // to the panel's full width and stacking a handful of them into a tall
  // column of distorted, near-unrecognisable bars instead of one compact
  // horizontal strip. Lay these out left-to-right at their own
  // intrinsic-aspect-ratio width instead.
  if (children.length > 1 && children.every(isIconSizedImage)) {
    const lineH =
      metrics.paragraph.fontSize * metrics.paragraph.lineHeightRatio;
    const childX = ownsXPadding ? insetX : 0;
    const startY = ownsTopPadding ? -topOffset : 0;
    let cursorX = childX;
    let rowH = 0;
    const childEntries: LayoutEntry[] = [];

    for (const child of children) {
      const img = child as XRImage;
      const iw = img.intrinsicWidth ?? 1;
      const ih = img.intrinsicHeight ?? 1;
      const h = Math.min(lineH, lineH * (ih / iw));
      const w = h * (iw / ih);
      rowH = Math.max(rowH, h);

      childEntries.push({
        id: child.id,
        position: { x: cursorX, y: startY, z: 0 },
        rotation: zeroRotation(),
        size: { width: w, height: h },
        curveRadius: 0,
        worldLocked: true,
      });
      cursorX += w;
    }

    const paddingContrib = ownsTopPadding ? topOffset * 2 : 0;
    return { childEntries, totalHeight: paddingContrib + rowH };
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
  const childX = ownsXPadding ? insetX : 0;
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
      // Single-column XRList children: stamp listColumns=1 so XRListItemMesh
      // can distinguish a flat list row from a multi-column grid tile (see
      // the listColumns>1 branch above) purely from its own entry.
      ...(parentType === "XRList" ? { listColumns: 1 } : {}),
    };
    attachResolvedStrategies(entry, child, panelUsableWidth, metrics);
    childEntries.push(entry);
    cursorY -= gap + h;
  }

  // paddingContrib mirrors startY's reservation plus a matching bottom gap.
  // Containers that own top padding reserve panelPaddingTop at both top and
  // bottom symmetrically. Types with ownsTopPadding: false contribute nothing.
  const paddingContrib = ownsTopPadding ? topOffset * 2 : 0;
  const totalHeight =
    paddingContrib +
    childEntries.reduce((s, e) => s + e.size.height, 0) +
    config.childGapY * Math.max(0, children.length - 1);

  return { childEntries, totalHeight };
}

// Advances pageIdx past an overflow and returns the derived values.
// Mutates pageYOffsets in place (appends one entry per overflow page).
function advanceOverflowPages(
  currentPageHeight: number,
  VIEWPORT: number,
  pageYOffsets: number[],
  currentPageIdx: number,
): {
  extraPages: number;
  firstOverflowPage: number;
  bleed: number;
  newPageIdx: number;
} {
  const extraPages = Math.ceil(currentPageHeight / VIEWPORT) - 1;
  for (let p = 0; p < extraPages; p++) {
    pageYOffsets.push((pageYOffsets[pageYOffsets.length - 1] ?? 0) + VIEWPORT);
  }
  return {
    extraPages,
    firstOverflowPage: currentPageIdx + 1,
    bleed: currentPageHeight % VIEWPORT || VIEWPORT,
    newPageIdx: currentPageIdx + extraPages,
  };
}

// ─────────────────────────────────────────────────────────────
// Content panel paginator  (XRContentPanel only)
// ─────────────────────────────────────────────────────────────

// Only place in the engine that creates pages. All positions in placedPositionMap
// are PANEL-ABSOLUTE. stampDescendants finalizes the map so the renderer uses a
// uniform coordinate system at every depth. Callers must read heights from
// placedHeightMap — not re-estimate — because split paragraph fragments carry a
// truncated height that differs from estimateHeight's answer for the full node.
function paginateContentPanel(
  children: XRPrimitive[],
  panelWidth: number,
  scene: SemanticScene,
  config: LayoutConfig,
  metrics: RenderMetrics,
  _diag: LayoutDiagnostics,
): PaginateResult {
  if (children.length === 0) {
    return {
      pagination: null,
      pageIndexMap: {},
      placedPositionMap: new Map(),
      placedHeightMap: new Map(),
      placedWidthMap: new Map(),
      syntheticPrimitives: [],
    };
  }

  const childWidth = Math.max(0.025, panelWidth - config.panelPaddingX * 2);
  const VIEWPORT = config.maxPanelViewportHeight;

  const positionMap: Map<string, Vec3> = new Map();
  const heightMap: Map<string, number> = new Map();
  const widthMap: Map<string, number> = new Map();
  const pageIndexMap: Record<string, number> = {};
  const pageYOffsets: number[] = [0];
  const syntheticPrimitives: XRPrimitive[] = [];

  let pageIdx = 0;
  let pageHeight = config.panelPaddingTop;
  let itemsOnPage = 0;
  let cursorY = -config.panelPaddingTop;
  let absoluteY = config.panelPaddingTop;
  // Tracks the type of the last item placed directly by the main pagination
  // loop (not inside splitSection). Used for the "keep heading with next
  // content" rule in the main loop's atomic leaf path.
  let lastPlacedType: string | null = null;

  function nextPage(absolutePageStart: number): void {
    pageYOffsets.push(absolutePageStart);
    pageIdx += 1;
    pageHeight = config.panelPaddingTop;
    itemsOnPage = 0;
    cursorY = -config.panelPaddingTop;
    lastPlacedType = null;
  }

  // Shared "does this node fit in what's left of the current page?" guard.
  // If not — and the page already has content, and doing so wouldn't strand
  // a lone heading — start a fresh page before the node is placed. Used by
  // the main loop's atomic path, splitSection's leaf path, and
  // placeRecursiveContainer (for keep-together containers like XRFigure).
  // Absent from a call site, this check is what lets an atomic block (image,
  // figure, table, ...) get placed straddling a page boundary and clipped by
  // the viewport instead of starting clean on the next page.
  function breakIfDoesNotFit(h: number): boolean {
    const wouldStrandHeading =
      lastPlacedType === "XRHeading" && itemsOnPage === 1;
    const gap = itemsOnPage === 0 ? 0 : config.childGapY;
    if (
      pageHeight + gap + h > VIEWPORT &&
      itemsOnPage > 0 &&
      !wouldStrandHeading
    ) {
      nextPage((pageYOffsets[pageIdx] ?? 0) + VIEWPORT);
      return true;
    }
    return false;
  }

  function stampSubtree(node: XRPrimitive, page: number): void {
    pageIndexMap[node.id] = page;
    for (const child of node.children) stampSubtree(child, page);
  }

  // An XRComplementary flowed inside a content panel is re-homed at the
  // complementary slot by computeLayoutPlan's extraction pass, so it must not
  // occupy any space in the content flow. Give it (and its subtree) a pageIndex
  // anchored to the current page — the extraction pass keys off that pageIndex
  // and later overwrites the positions with slot-relative ones — but do NOT
  // advance the cursor, page height, or item count. Without this, an aside that
  // overflows onto a fresh page leaves that page blank once it is extracted.
  // Only active when the template actually has a complementary slot to extract
  // into (otherwise the aside stays in flow and must occupy real space).
  const extractComplementary = config.complementaryExtractedToSlot === true;
  function placeFloatingComplementary(node: XRPrimitive): void {
    stampSubtree(node, pageIdx);
    positionMap.set(node.id, { x: config.panelPaddingX, y: cursorY, z: 0 });
    heightMap.set(node.id, 0);
  }

  // Config-driven helpers replacing the old isSectionLike / isRecursiveContainer.
  function isSectionLike(p: XRPrimitive): boolean {
    if (PRIMITIVE_CONFIG[p.type]?.forceNewPage !== true) return false;
    // mapList downgrades a list with fewer than minCardGridItems items to a
    // titleless XRSection (not worth a card grid for 1-2 items) — this can
    // fire on a tiny sub-list nested anywhere, including deep inside a
    // citation's own inline content (e.g. a one-item "external link"
    // sub-bullet). That's not a real document section; forcing a page break
    // for it splits ordinary content (e.g. a citation's DOI link) onto its
    // own page mid-item. A genuine document section reliably has a title
    // (from a heading or landmark label), so require one before treating it
    // as page-break-worthy.
    if (p.type === "XRSection" && p.title === null) return false;
    return true;
  }

  // Text carried directly on a node (not in a child XRText). An unmapped
  // <label>/<address> becomes a CHILDLESS XRGenericPanel whose only content is
  // this string — it still renders and must be placed, not skipped as "empty".
  // Check content AND label independently: a node can carry an empty-string
  // content ("") while still having a real label (e.g. XRSearchBox), and
  // `content ?? label` would wrongly return "" for it.
  function nodeHasText(p: XRPrimitive): boolean {
    return (p.content ?? "").trim() !== "" || (p.label ?? "").trim() !== "";
  }

  // A container-typed node (recursive/section) is one whose whole purpose is to
  // group children — when childless AND textless it renders nothing and is
  // skipped. Leaf VISUAL primitives (XRImage, XRMediaPlayer, XRSeparator,
  // XRProgressBar, form controls, …) are paginate:"atomic" and draw themselves
  // with no children or text, so they must NEVER be treated as empty.
  function isEmptyContainerNode(p: XRPrimitive): boolean {
    if (p.children.length > 0 || nodeHasText(p)) return false;
    const cfg = PRIMITIVE_CONFIG[p.type];
    return cfg?.paginate === "recursive" || cfg?.forceNewPage === true;
  }

  // A recursive container is one whose config says paginate:'recursive' but
  // does NOT force a new page (those are handled by isSectionLike above).
  // Normalized XRParagraph/XRHeading/XRBlockQuote/XRLink/XRButton with a
  // single synthetic XRText child also recurse so the text node is split.
  function isRecursiveContainer(p: XRPrimitive): boolean {
    // A childless node has nothing to recurse into. Treating it as a recursive
    // container makes splitSection/the main loop skip it (empty container), yet
    // layoutPrimitive still emits a fallback LayoutEntry pinned to the top of
    // the page for it — a childless-but-text-bearing XRGenericPanel (unmapped
    // <label>/<address>) then rendered over the section heading. Return false so
    // it falls through to the atomic-leaf path and gets a real stacked position.
    if (p.children.length === 0) return false;
    const cfg = PRIMITIVE_CONFIG[p.type];
    if (cfg?.paginate === "recursive" && !cfg.forceNewPage) return true;
    // A titleless XRSection is exempted from forcing a page break (see
    // isSectionLike) but its content must still be recursed into normally —
    // falling through to the atomic-leaf path instead would size it with
    // the generic linear-stack height estimator, which doesn't understand
    // grid-column layouts and wildly overestimates height for any XRList
    // nested inside (e.g. a small table remapped to a card grid).
    if (p.type === "XRSection" && p.title === null) return true;
    if (
      (p.type === "XRParagraph" ||
        p.type === "XRHeading" ||
        p.type === "XRBlockQuote" ||
        p.type === "XRLink" ||
        p.type === "XRButton") &&
      p.children.length === 1 &&
      (p.children[0] as unknown as { __isSynthetic?: boolean }).__isSynthetic
    )
      return true;
    return false;
  }

  // Core continuation loop shared by createParagraphContinuations and
  // createSyntheticTextContinuations. Handles first-page word counting, the
  // wordOffset=0 fast path, and the per-overflow-page iteration. Callers
  // supply three callbacks for the node-specific parts:
  //   onWholeMoved  — called when nothing was visible (wordOffset=0);
  //                   side-effects: stamps/positions the node on firstOverflowPage.
  //                   Returns movedH (the node's full rendered height).
  //   onContPage    — called per overflow page; creates and registers the cont
  //                   node. Returns contActualH for that page.
  //   onTrimOriginal — called once after all cont nodes are created; trims the
  //                    original node to the words that fit on the original page.
  function runContLoop(
    totalWords: number,
    wpl: number,
    lineH: number,
    m: PrimitiveFontMetrics,
    pageHeightBefore: number,
    gapBefore: number,
    firstOverflowPage: number,
    extraPages: number,
    bleed: number,
    onWholeMoved: () => number,
    onContPage: (
      contPageIdx: number,
      fromWord: number,
      isLast: boolean,
    ) => number,
    onTrimOriginal: (toWord: number) => void,
  ): { pageHeight: number; cursorY: number } {
    const firstPageAvailH = Math.max(
      0,
      VIEWPORT - pageHeightBefore - gapBefore - m.verticalPadding / 2,
    );
    // Round (not floor): a line >50% visible on the original page counts as seen.
    const firstPageLines = Math.round(firstPageAvailH / lineH);
    let wordOffset = Math.max(0, firstPageLines * wpl);

    if (wordOffset === 0) {
      const movedH = onWholeMoved();
      const corrH = config.panelPaddingTop + movedH;
      return { pageHeight: corrH, cursorY: -corrH };
    }

    const initialWordOffset = wordOffset;
    let lastContH = bleed - config.panelPaddingTop;

    for (let p = 0; p < extraPages; p++) {
      if (wordOffset >= totalWords) break;
      const contPageIdx = firstOverflowPage + p;
      const isLastOverflow = p === extraPages - 1;
      const thisPageCapacity = isLastOverflow ? bleed : VIEWPORT;
      const contAvailH = Math.max(
        0,
        thisPageCapacity - config.panelPaddingTop - m.verticalPadding / 2,
      );
      const thisPageLines = Math.max(0, Math.floor(contAvailH / lineH));
      const wordsThisPage = Math.max(1, thisPageLines * wpl);
      const contActualH = onContPage(contPageIdx, wordOffset, isLastOverflow);
      if (isLastOverflow) lastContH = contActualH;
      wordOffset += wordsThisPage;
    }

    onTrimOriginal(initialWordOffset);
    const corrH = config.panelPaddingTop + lastContH;
    return { pageHeight: corrH, cursorY: -corrH };
  }

  // Split an overflowing XRParagraph across pages. XRText children are split at
  // exact word boundaries; XRLink children are kept whole. Block children skip.
  function createParagraphContinuations(
    sc: XRPrimitive,
    pageHeightBefore: number,
    gapBefore: number,
    firstOverflowPage: number,
    extraPages: number,
    bleed: number,
  ): { pageHeight: number; cursorY: number } | null {
    if (sc.type !== "XRParagraph") return null;

    const para = sc as XRParagraph;
    const m = metrics.paragraph;
    const lineH = m.fontSize * m.lineHeightRatio;
    const wpl = Math.max(1, computeWordsPerLine(childWidth, m));

    // Flatten inline wrappers exactly as the renderer does so word counts match.
    const flatChildren =
      sc.children.length > 0
        ? (flattenInlineWrappers(sc.children as any[]) as XRPrimitive[])
        : [];

    // Skip if any flattened child is block-level — can't split those.
    if (flatChildren.some((c) => !isInlinePrimitive(c.type))) return null;

    // Per-child word count (mirrors estimateInlineFlowHeight).
    const childWC = (c: XRPrimitive): number => {
      if (c.type === "XRText")
        return countWords((c as unknown as XRText).text ?? "");
      const wc = (c as unknown as { wordCount?: number }).wordCount;
      if (wc != null && wc > 0) return wc;
      return countWords(c.label ?? c.content ?? "");
    };

    const totalWords =
      flatChildren.length === 0
        ? countWords(para.content ?? para.label ?? "")
        : flatChildren.reduce((s, c) => s + childWC(c), 0);

    if (totalWords === 0) return null;

    /**
     * Return the continuation children (and plain-text fallback) that begin at
     * `fromWord` words into the original paragraph.
     *
     * For pure-text paragraphs the children array is empty and `content` holds
     * the remaining text. For inline-children paragraphs the returned children
     * start at (or just before, for straddling XRLink nodes) `fromWord`.
     */
    function buildContFrom(fromWord: number): {
      children: XRPrimitive[];
      content: string | null;
      label: string | null;
      wordCount: number;
    } {
      const remaining = totalWords - fromWord;

      if (flatChildren.length === 0) {
        // Pure-text paragraph.
        const text = para.content ?? para.label ?? "";
        const allWords = text.split(/\s+/).filter(Boolean);
        const slice = allWords.slice(fromWord).join(" ");
        return {
          children: [],
          content: slice,
          label: slice,
          wordCount: remaining,
        };
      }

      // Inline-children paragraph: collect children from `fromWord` onwards.
      const result: XRPrimitive[] = [];
      let seen = 0;

      for (const child of flatChildren) {
        const wc = childWC(child);

        if (seen + wc <= fromWord) {
          // Entirely before the split — skip.
          seen += wc;
          continue;
        }

        if (seen >= fromWord) {
          // Entirely after the split — keep as-is.
          result.push(child);
        } else {
          // Straddles the split point.
          const wordsBeforeSplit = fromWord - seen;
          if (child.type === "XRText") {
            // Split the text node at the exact word boundary.
            const text = (child as unknown as XRText).text ?? "";
            const tw = text.split(/\s+/).filter(Boolean);
            const tail = tw.slice(wordsBeforeSplit).join(" ");
            if (tail) {
              result.push({
                ...(child as unknown as XRText),
                id: `${child.id}__cpart_${fromWord}`,
                text: tail,
              } as unknown as XRPrimitive);
            }
          } else {
            // XRLink or other inline: include the whole node so the link is
            // not broken. The first few words may re-appear from the previous
            // page but the link label stays intact.
            result.push(child);
          }
        }

        seen += wc;
      }

      return {
        children: result,
        content: para.content,
        label: para.label,
        wordCount: remaining,
      };
    }

    // Head-side mirror of buildContFrom: returns the inline children that
    // cover words 0..toWord-1 so the original node can be trimmed.
    function buildOrigTo(toWord: number): XRPrimitive[] {
      const result: XRPrimitive[] = [];
      let seen = 0;
      for (const child of flatChildren) {
        if (seen >= toWord) break;
        const wc = childWC(child);
        if (seen + wc <= toWord) {
          result.push(child);
        } else {
          const wordsToKeep = toWord - seen;
          if (child.type === "XRText") {
            const text = (child as unknown as XRText).text ?? "";
            const tw = text.split(/\s+/).filter(Boolean);
            const head = tw.slice(0, wordsToKeep).join(" ");
            if (head) {
              result.push({
                ...(child as unknown as XRText),
                id: `${child.id}__opart_${toWord}`,
                text: head,
              } as unknown as XRPrimitive);
            }
          } else {
            // XRLink: keep the whole node to avoid breaking the link.
            result.push(child);
          }
        }
        seen += wc;
      }
      return result;
    }

    return runContLoop(
      totalWords,
      wpl,
      lineH,
      m,
      pageHeightBefore,
      gapBefore,
      firstOverflowPage,
      extraPages,
      bleed,
      () => {
        stampSubtree(sc, firstOverflowPage);
        positionMap.set(sc.id, topOfPagePos(config));
        return Math.ceil(totalWords / wpl) * lineH + m.verticalPadding;
      },
      (contPageIdx, fromWord, isLast) => {
        const contId = `${sc.id}__cont_${contPageIdx}`;
        const {
          children: contChildren,
          content,
          label,
          wordCount,
        } = buildContFrom(fromWord);
        const contNode = {
          ...(sc as XRParagraph),
          id: contId,
          content,
          label,
          wordCount,
          children: contChildren,
        } as unknown as XRPrimitive;
        const contActualH =
          Math.ceil(wordCount / wpl) * lineH + m.verticalPadding;
        syntheticPrimitives.push(contNode);
        pageIndexMap[contId] = contPageIdx;
        positionMap.set(contId, topOfPagePos(config));
        heightMap.set(
          contId,
          isLast ? contActualH : VIEWPORT - config.panelPaddingTop,
        );
        return contActualH;
      },
      (toWord) => {
        if (flatChildren.length > 0) {
          (sc as { children: XRPrimitive[] }).children = buildOrigTo(toWord);
        } else {
          const text = para.content ?? para.label ?? "";
          const allWords = text.split(/\s+/).filter(Boolean);
          const trimmed = allWords.slice(0, toWord).join(" ");
          (para as unknown as { content: string | null }).content = trimmed;
          (para as unknown as { label: string | null }).label = trimmed;
        }
      },
    );
  }

  // Like createParagraphContinuations but for the single synthetic XRText child
  // of a normalized XRParagraph/XRHeading, preserving the parent type so the
  // renderer uses the correct font metrics (heading vs paragraph).
  function createSyntheticTextContinuations(
    parentNode: XRPrimitive,
    textNode: XRPrimitive,
    pageHeightBefore: number,
    gapBefore: number,
    firstOverflowPage: number,
    extraPages: number,
    bleed: number,
  ): { pageHeight: number; cursorY: number } | null {
    const isSynthetic = (textNode as unknown as { __isSynthetic?: boolean })
      .__isSynthetic;
    if (!isSynthetic) return null;

    const rawText =
      (textNode as unknown as { text?: string }).text ??
      textNode.content ??
      textNode.label ??
      "";
    const allWords = rawText.split(/\s+/).filter(Boolean);
    const totalWords = allWords.length;
    if (totalWords === 0) return null;

    // Resolve font metrics from the parent type.
    const m =
      parentNode.type === "XRHeading"
        ? (metrics.heading[
            ((parentNode as XRHeading).level ?? 2) as 1 | 2 | 3 | 4 | 5 | 6
          ] ?? metrics.paragraph)
        : parentNode.type === "XRLink"
          ? metrics.link.font
          : parentNode.type === "XRButton"
            ? metrics.button.font
            : parentNode.type === "XRBlockQuote"
              ? metrics.blockQuote
              : metrics.paragraph;
    const lineH = m.fontSize * m.lineHeightRatio;
    const wpl = Math.max(1, computeWordsPerLine(childWidth, m));

    return runContLoop(
      totalWords,
      wpl,
      lineH,
      m,
      pageHeightBefore,
      gapBefore,
      firstOverflowPage,
      extraPages,
      bleed,
      () => {
        stampSubtree(parentNode, firstOverflowPage);
        positionMap.set(parentNode.id, topOfPagePos(config));
        return Math.ceil(totalWords / wpl) * lineH + m.verticalPadding;
      },
      (contPageIdx, fromWord, isLast) => {
        const contParentId = `${parentNode.id}__cont_${contPageIdx}`;
        const contTextId = `${textNode.id}__cont_${contPageIdx}`;
        const remainingWords = allWords.slice(fromWord);
        const contText = remainingWords.join(" ");
        const wordCount = remainingWords.length;

        const contTextNode = {
          id: contTextId,
          type: "XRText" as const,
          text: contText,
          componentType: null,
          isProseRun: true,
          styleTags: [],
          label: contText,
          content: contText,
          sourceIds: [],
          confidence: 1,
          depth: textNode.depth,
          children: [],
          relations: {
            controls: [],
            labelledBy: [],
            describedBy: [],
            details: [],
            errorMessage: [],
          },
          __isSynthetic: true,
          __fm: m,
        } as unknown as XRPrimitive;

        const contParent = {
          ...(parentNode as object),
          id: contParentId,
          label: contText,
          content: contText,
          wordCount,
          children: [contTextNode],
        } as unknown as XRPrimitive;

        const contActualH =
          Math.ceil(wordCount / wpl) * lineH + m.verticalPadding;
        syntheticPrimitives.push(contParent);
        pageIndexMap[contParentId] = contPageIdx;
        positionMap.set(contParentId, topOfPagePos(config));
        heightMap.set(
          contParentId,
          isLast ? contActualH : VIEWPORT - config.panelPaddingTop,
        );
        return contActualH;
      },
      (toWord) => {
        const trimmedText = allWords.slice(0, toWord).join(" ");
        (textNode as unknown as { text: string }).text = trimmedText;
        if ("content" in textNode)
          (textNode as unknown as { content: string }).content = trimmedText;
        if ("label" in textNode)
          (textNode as unknown as { label: string | null }).label = trimmedText;
      },
    );
  }

  // ── Shared section placement helpers ─────────────────────────────────────
  // Both splitSection and the main pagination loop need the same register-recurse-
  // setHeight logic. Function declarations hoist so mutual recursion works fine.

  function placeSectionNode(node: XRPrimitive, initialY: number): void {
    const pageBeforeRecursion = pageIdx;
    pageIndexMap[node.id] = pageIdx;
    positionMap.set(node.id, { x: config.panelPaddingX, y: initialY, z: 0 });
    splitSection(node);
    heightMap.set(
      node.id,
      pageIdx === pageBeforeRecursion
        ? pageHeight - config.panelPaddingTop
        : VIEWPORT - config.panelPaddingTop,
    );
  }

  // Grid layout for XRList: places items in rows of `columns` cards with
  // row-level page overflow (entire row moves to next page if it doesn't fit).
  function placeListGrid(node: XRPrimitive): void {
    const columns = resolveListColumns(childWidth, metrics);
    const usableW = childWidth; // childWidth is already panelWidth - 2*panelPaddingX
    const cardWidth = Math.max(
      0.025,
      (usableW - config.childGapY * (columns - 1)) / columns,
    );
    // The most vertical room any row could ever get, even alone on a fresh
    // page. An item whose card-width estimate exceeds this can never fit its
    // grid column without clipping, no matter which page it lands on.
    const emptyPageBudget = VIEWPORT - config.panelPaddingTop;

    // rowsOnPage tracks rows placed on the current page by THIS list only.
    // Using a local counter (not the global itemsOnPage) ensures the first
    // row always stays on the same page as the section heading — preventing
    // an empty heading-only page when the section heading + first row together
    // exceed the viewport.
    let rowsOnPage = 0;

    const placeRow = (
      rowItems: XRPrimitive[],
      rowWidths: number[],
      rowHeights: number[],
    ): void => {
      const rowH = Math.max(...rowHeights);
      const g = rowsOnPage > 0 ? config.childGapY : 0;

      // Overflow: advance to a fresh page when this row won't fit.
      //
      // The first row of a list normally stays put so it isn't split from its
      // section heading. But when the page ALREADY holds other content (e.g. the
      // tail of the previous section's list plus this section's heading), keeping
      // an oversized first row here just straddles the viewport and clips its
      // lower half — with the next page starting at the FOLLOWING row, so the
      // clipped remainder is lost entirely. Break in that case too; only hold the
      // row back when doing so would strand a lone heading on an otherwise empty
      // page (itemsOnPage === 1), where an empty heading-only page is worse.
      const wouldStrandLoneHeading =
        lastPlacedType === "XRHeading" && itemsOnPage === 1;
      const doesNotFit = pageHeight + g + rowH > VIEWPORT;
      if (
        doesNotFit &&
        (rowsOnPage > 0 || (itemsOnPage > 0 && !wouldStrandLoneHeading))
      ) {
        const absOffsetBase = pageYOffsets[pageIdx] ?? 0;
        pageYOffsets.push(absOffsetBase + VIEWPORT);
        pageIdx += 1;
        pageHeight = config.panelPaddingTop;
        itemsOnPage = 0;
        rowsOnPage = 0;
        cursorY = -config.panelPaddingTop;
      }

      const gap = rowsOnPage > 0 ? config.childGapY : 0;
      const rowY = cursorY - gap;

      let itemX = config.panelPaddingX;
      for (let col = 0; col < rowItems.length; col++) {
        const item = rowItems[col];
        const w = rowWidths[col] ?? cardWidth;

        pageIndexMap[item.id] = pageIdx;
        positionMap.set(item.id, { x: itemX, y: rowY, z: 0 });
        heightMap.set(item.id, rowHeights[col] ?? rowH);
        // Always persist this card's real per-column width — not just when
        // promoted to a full-width row. Without an entry here, layoutPrimitive's
        // final assembly recomputes column count independently (via
        // attachResolvedStrategies, using whatever width this list actually
        // received at its own nesting depth), which can disagree with the
        // childWidth this function used — e.g. a list nested under a section
        // that itself sits under another wrapper resolves to a narrower width
        // there than the flat, panel-wide childWidth used here — silently
        // picking a different column count and stretching every card into an
        // overlapping, too-wide box relative to where it was actually placed.
        widthMap.set(item.id, w);
        stampSubtree(item, pageIdx);
        // stampDescendants calls overflowCorrect for any of this item's own
        // descendants that overflow past a page boundary, which mutates the
        // shared pageIdx counter as a side effect — appropriate for a linear
        // sequence, but here it would leak into the NEXT sibling in this
        // same visual row (stamping it onto a later page than its actual
        // row-mates, scattering one row across several pages). Restore
        // pageIdx afterward so only this item's own descendants are
        // affected; pageYOffsets extensions (needed for total page count)
        // still persist regardless.
        const pageIdxBeforeDescendants = pageIdx;
        stampDescendants(item, itemX, rowY, w);
        pageIdx = pageIdxBeforeDescendants;
        itemX += w + config.childGapY;
      }

      cursorY -= gap + rowH;
      pageHeight += gap + rowH;
      itemsOnPage += 1;
      rowsOnPage += 1;

      // A single row — most commonly one promoted to a full-width,
      // single-item row above — can still be taller than an entire empty
      // page (e.g. a text-heavy card, or a citation carrying a nested
      // sub-list). Grid cards carry NO pageEndIndex: each is stamped to one
      // page and clipped to the viewport there — an over-tall card's lower
      // half is never rendered on any following page. So an oversized row
      // occupies exactly ONE page; the next row must start at the TOP of the
      // immediately following page.
      //
      // The previous code advanced by `ceil(pageHeight/VIEWPORT)-1` pages and
      // set `cursorY = -(pageHeight % VIEWPORT)`. That was wrong for a clipped
      // grid: it (a) reserved blank "overflow" pages for content that is
      // clipped away, never shown, and (b) carried the overflow remainder
      // forward as a top offset, so every subsequent row started that far down
      // its page — and because each citation row is itself 0.5–0.7 m, the
      // offset kept re-overflowing and cascaded down page after page, leaving
      // a large empty band at the top of each and pushing content to the
      // bottom. Advance exactly one page and reset to the panel-top padding.
      if (pageHeight > VIEWPORT) {
        const absOffsetBase = pageYOffsets[pageIdx] ?? 0;
        pageYOffsets.push(absOffsetBase + VIEWPORT);
        pageIdx += 1;
        pageHeight = config.panelPaddingTop;
        cursorY = -config.panelPaddingTop;
        itemsOnPage = 0;
        rowsOnPage = 0;
      }
    };

    const children = node.children;
    let i = 0;
    while (i < children.length) {
      const item = children[i];
      const cardH = estimateHeight(
        item,
        cardWidth,
        metrics,
        config,
        new Set(),
        scene,
      );

      if (cardH > emptyPageBudget) {
        // This item can't fit its normal grid column on any page. Promote it
        // to a dedicated full-width row instead: the same text wraps into far
        // fewer lines at full panel width, which usually brings it back
        // under the viewport instead of clipping past it. (A citation with
        // many linked sub-parts is the common real-world trigger.)
        const fullWidthH = estimateHeight(
          item,
          usableW,
          metrics,
          config,
          new Set(),
          scene,
        );
        const h =
          fullWidthH > 0 && isFinite(fullWidthH)
            ? fullWidthH
            : metrics.fallbackElementHeight;
        // placeRow's own break check exempts a list's first row so it stays
        // with a heading it might otherwise be stranded from — appropriate
        // for an ordinary small row, but not here: this item is already
        // known to be unusually tall, and starting it deep into whatever's
        // left of the current page (rather than a fresh one it would
        // actually fit on) makes it overflow so far that stampDescendants
        // flows its tail onto a later page — one that may already have
        // other grid rows scheduled on it, scrambling the reading order.
        // Use the shared itemsOnPage-based check instead, which has no such
        // exemption for an item this size.
        if (breakIfDoesNotFit(h)) rowsOnPage = 0;
        placeRow([item], [usableW], [h]);
        i += 1;
        continue;
      }

      const rowItems: XRPrimitive[] = [item];
      const rowHeights: number[] = [
        cardH > 0 && isFinite(cardH) ? cardH : metrics.fallbackElementHeight,
      ];
      i += 1;
      while (rowItems.length < columns && i < children.length) {
        const candidate = children[i];
        const h = estimateHeight(
          candidate,
          cardWidth,
          metrics,
          config,
          new Set(),
          scene,
        );
        if (h > emptyPageBudget) break; // handled as its own full-width row next
        rowItems.push(candidate);
        rowHeights.push(
          h > 0 && isFinite(h) ? h : metrics.fallbackElementHeight,
        );
        i += 1;
      }
      placeRow(
        rowItems,
        rowItems.map(() => cardWidth),
        rowHeights,
      );
    }
  }

  function placeRecursiveContainer(
    node: XRPrimitive,
    precomputedH?: number,
  ): void {
    // Figures (image + caption) must stay together — unlike other recursive
    // containers (lists, articles) that are allowed to paginate mid-content,
    // a figure that straddles a page boundary clips its image. If it doesn't
    // fit in what's left of the current page, push the whole figure to the
    // next one, mirroring the atomic-leaf "doesn't fit" check below.
    if (node.type === "XRFigure") {
      const h =
        precomputedH ??
        estimateHeight(node, childWidth, metrics, config, new Set(), scene);
      breakIfDoesNotFit(h);
    }

    const wrapperPage = pageIdx;
    const wrapperY = cursorY - (itemsOnPage > 0 ? config.childGapY : 0);
    pageIndexMap[node.id] = wrapperPage;
    positionMap.set(node.id, { x: config.panelPaddingX, y: wrapperY, z: 0 });
    if (node.type === "XRList") {
      placeListGrid(node);
    } else {
      splitSection(node);
    }
    heightMap.set(
      node.id,
      pageIdx === wrapperPage
        ? wrapperY - cursorY
        : wrapperY - (-VIEWPORT + config.panelPaddingTop),
    );
  }

  // ── splitSection ─────────────────────────────────────────────────────────
  // Recursively places children of a section-like or recursive-container node.
  // isSectionLike  → XRSection only  → forces a fresh page before the child.
  // isRecursiveContainer (non-section) → XRGenericPanel, XRArticle, XRFormPanel,
  //   XRFormField, normalized XRParagraph/XRHeading → continues on current page,
  //   height from cursor delta.
  // Everything else → atomic leaf; overflow triggers continuation creation for
  //   XRParagraph (multi-inline) or synthetic XRText (normalized nodes).
  function splitSection(section: XRPrimitive): void {
    for (let j = 0; j < section.children.length; j++) {
      const sc = section.children[j];

      // ── Floating complementary aside (extracted to slot) ──────────────────
      if (extractComplementary && sc.type === "XRComplementary") {
        placeFloatingComplementary(sc);
        continue;
      }

      // Empty container nodes (recursive/section type, no children, no text)
      // render nothing — skip. Childless text-bearing nodes AND leaf visual
      // primitives (image/media/separator/…) are NOT empty; they fall through
      // to the atomic-leaf path below.
      if (isEmptyContainerNode(sc)) continue;

      // ── Section-like child (XRSection only) ───────────────────────────────
      if (isSectionLike(sc)) {
        if (sc.children.length === 0) continue;

        // Don't strand a lone heading alone on the previous page (see the
        // matching guard in the main pagination loop above) — a top-level
        // heading is typically wrapped several generic-panel levels deep
        // from its lead section (e.g. main-node-4 -> node-8 -> node-10 ->
        // section-1), so this recursive copy of the same "start new page"
        // logic needs its own stranding guard; fixing only the main loop's
        // copy leaves this one still forcing the heading onto its own page.
        const wouldStrandHeading =
          lastPlacedType === "XRHeading" && itemsOnPage === 1;

        if (
          config.sectionStartsOnNewPage !== false &&
          itemsOnPage > 0 &&
          !wouldStrandHeading
        ) {
          const absOffsetBase = pageYOffsets[pageIdx] ?? 0;
          pageYOffsets.push(absOffsetBase + VIEWPORT);
          pageIdx += 1;
          pageHeight = config.panelPaddingTop;
          itemsOnPage = 0;
          cursorY = -config.panelPaddingTop;
          lastPlacedType = null;
        }

        placeSectionNode(
          sc,
          cursorY - (itemsOnPage > 0 ? config.childGapY : 0),
        );
        continue;
      }

      // ── Recursive container (no forced page break) ────────────────────────
      if (isRecursiveContainer(sc)) {
        if (sc.children.length === 0) continue;
        placeRecursiveContainer(sc);
        continue;
      }

      // ── Leaf child (atomic) ──────────────────────────────────────────────
      // Within a section we place the child at the current cursor position.
      // If it overflows the page, paragraphs and synthetic XRText nodes get
      // continuation entries so the remaining text appears on subsequent pages.
      const sch = estimateHeight(
        sc,
        childWidth,
        metrics,
        config,
        new Set(),
        scene,
      );

      // Unlike the main pagination loop, this path previously placed leaves
      // wherever the cursor happened to be with no "does it fit?" pre-check —
      // non-text leaves (XRImage, XRTable, ...) have no continuation logic,
      // so one that didn't fit would start on the current page and simply get
      // clipped by the viewport instead of moving to the next page.
      breakIfDoesNotFit(sch);

      const g = itemsOnPage > 0 ? config.childGapY : 0;
      const pageHeightBeforePlacement = pageHeight;
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
      // Mirror the main pagination loop's bookkeeping (see below) so the
      // "don't strand a heading alone" check works inside sections too —
      // without this, a section's own heading followed by its first real
      // content child can overflow to the next page with nothing to hold
      // them together, leaving the heading isolated on its own page.
      lastPlacedType = sc.type;

      // Overflow: advance pageIdx and create continuation nodes if the leaf
      // is text-bearing (XRParagraph with real inline children, or a synthetic
      // XRText that is the sole text child of a normalized XRParagraph/XRHeading).
      if (pageHeight > VIEWPORT) {
        const { extraPages, firstOverflowPage, bleed, newPageIdx } =
          advanceOverflowPages(pageHeight, VIEWPORT, pageYOffsets, pageIdx);
        pageIdx = newPageIdx;
        pageHeight = bleed;
        cursorY = -bleed;

        let corrected: { pageHeight: number; cursorY: number } | null = null;
        if (sc.type === "XRParagraph") {
          corrected = createParagraphContinuations(
            sc,
            pageHeightBeforePlacement,
            g,
            firstOverflowPage,
            extraPages,
            bleed,
          );
        } else if (
          sc.type === "XRText" &&
          (sc as unknown as { __isSynthetic?: boolean }).__isSynthetic
        ) {
          corrected = createSyntheticTextContinuations(
            section,
            sc,
            pageHeightBeforePlacement,
            g,
            firstOverflowPage,
            extraPages,
            bleed,
          );
        }
        if (corrected !== null) {
          pageHeight = corrected.pageHeight;
          cursorY = corrected.cursorY;
        }
      }
    }
  }

  // ── Main pagination loop ───────────────────────────────────────────────────
  for (let i = 0; i < children.length; i++) {
    const child = children[i];

    // Floating complementary aside (extracted to slot): occupies no flow space.
    if (extractComplementary && child.type === "XRComplementary") {
      placeFloatingComplementary(child);
      continue;
    }

    // Empty container nodes render nothing — skip. Childless text-bearing
    // nodes and leaf visual primitives fall through to the atomic-leaf path.
    if (isEmptyContainerNode(child)) continue;

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

      // Don't strand a lone heading alone on the previous page: if the only
      // thing placed on the current page so far is a heading, let this
      // section start right after it instead of forcing a break. Without
      // this, a top-level heading immediately followed by its lead/first
      // section (the common case — the page title followed by the intro
      // section) always lands alone on page 1 with the real content pushed
      // to page 2, since this branch forced nextPage() unconditionally
      // whenever sectionStartsOnNewPage was set, with no stranding guard.
      const wouldStrandHeading =
        lastPlacedType === "XRHeading" && itemsOnPage === 1;

      if (
        config.sectionStartsOnNewPage !== false &&
        itemsOnPage > 0 &&
        !wouldStrandHeading
      ) {
        nextPage(absoluteY);
        absoluteY = config.panelPaddingTop;
      }

      placeSectionNode(child, -config.panelPaddingTop);
      absoluteY = config.panelPaddingTop + pageHeight;
    } else if (isRecursiveContainer(child)) {
      if (child.children.length === 0) continue;
      placeRecursiveContainer(child, h);
      absoluteY = config.panelPaddingTop + pageHeight;
    } else {
      // Atomic leaf child
      const gap = itemsOnPage === 0 ? 0 : config.childGapY;

      // Keep-with-next: same as splitSection — don't strand a heading alone.
      const wouldStrandHeading =
        lastPlacedType === "XRHeading" && itemsOnPage === 1;

      // If child doesn't fit, move to next page
      if (
        pageHeight + gap + h > VIEWPORT &&
        itemsOnPage > 0 &&
        !wouldStrandHeading
      ) {
        nextPage(absoluteY);
        absoluteY = config.panelPaddingTop;
      }

      const g = itemsOnPage === 0 ? 0 : config.childGapY;
      const pageHeightBeforePlacement = pageHeight;
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
      lastPlacedType = child.type;

      // If this item's height exceeds the viewport, it bleeds into subsequent
      // pages via overflowCorrect in stampDescendants. Advance pageIdx so the
      // next sibling starts on the correct page and doesn't overlap the tail.
      // For paragraphs, also create continuation nodes for the overflow pages.
      if (pageHeight > VIEWPORT) {
        const { extraPages, firstOverflowPage, bleed, newPageIdx } =
          advanceOverflowPages(pageHeight, VIEWPORT, pageYOffsets, pageIdx);
        pageIdx = newPageIdx;
        pageHeight = bleed;
        cursorY = -bleed;
        absoluteY = bleed;
        const corrected = createParagraphContinuations(
          child,
          pageHeightBeforePlacement,
          g,
          firstOverflowPage,
          extraPages,
          bleed,
        );
        if (corrected !== null) {
          pageHeight = corrected.pageHeight;
          cursorY = corrected.cursorY;
          absoluteY = corrected.pageHeight;
        }
      }
    }
  }

  // ── Stamp all descendants with panel-absolute positions ───────────────────
  // positionMap currently contains only the nodes that the main pagination
  // loop and splitSection explicitly placed (sections, generic panels, and
  // direct atomic leaves). Any deeper descendants — e.g. children of XRList,
  // XRListItem, XRFigure, nested XRGenericPanel inside a list item — are
  // absent from the map.

  // Convert a page-relative Y that may extend below the viewport into the
  // correct page and page-relative Y. Extends pageYOffsets and increments
  // pageIdx for any overflow pages so totalPages at the end of paginateContentPanel
  // correctly reflects the real page count (including pages synthesised here
  // for tall containers like XRList whose total item height exceeds VIEWPORT).
  function overflowCorrect(
    relY: number,
    parentPage: number,
  ): { page: number; y: number } {
    let page = parentPage;
    let y = relY;
    while (y < -VIEWPORT) {
      y += VIEWPORT;
      page += 1;
      if (page >= pageYOffsets.length) {
        pageYOffsets.push(
          (pageYOffsets[pageYOffsets.length - 1] ?? 0) + VIEWPORT,
        );
        pageIdx = Math.max(pageIdx, page);
      }
    }
    return { page, y };
  }
  //
  // Without this pass, layoutPrimitive would fall back to stackChildrenSimple
  // for those missing levels and produce PARENT-RELATIVE positions, creating
  // a second coordinate system that the renderer would have to handle with
  // special cases. Instead we complete the map here so every descendant has
  // a PANEL-ABSOLUTE position, giving the renderer one uniform coordinate
  // system: always use entry.position as-is, always wrap in a group at that
  // position, never worry about whether a node is "inside" or "outside" the
  // paginator's direct scope.

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
    // its effective children (after flattening nested transparent panels) are
    // inline. In that case the parent XRListItemMesh uses flattenInlineWrappers()
    // to see through it and renders the children as a prose run — so we must NOT
    // stamp them as positioned 3D nodes.
    //
    // FIX: use flattenInlineWrappers for transitive check. A panel like
    // <span><a>link text</a></span> has direct child XRGenericPanel(→XRLink),
    // which is NOT in INLINE_PRIMITIVE_TYPES, but its effective leaf content IS
    // all-inline. The old direct-children check missed this case.
    const isInlineWrapper = isInlineOwningNode(node);

    // For XRListItem: check flattened effective children to decide whether
    // the item is block-only. A listitem whose only child is an XRGenericPanel
    // wrapping inline content is NOT block-only — it renders via the prose flow.
    const flatListItemChildren =
      node.type === "XRListItem"
        ? flattenInlineWrappers(node.children as any[])
        : null;
    const hasOnlyBlockChildren =
      node.type === "XRListItem" &&
      node.children.length > 0 &&
      (flatListItemChildren ?? []).every(
        (c: any) => !isInlinePrimitive(c.type),
      );

    if (isInlineWrapper && !hasOnlyBlockChildren) {
      // Any inline-owning node (XRParagraph, XRHeading, XRListItem,
      // XRBlockQuote, XRLink, XRButton) can carry block children interleaved
      // with its inline prose — e.g. a Wikipedia <span class="frac"> that the
      // mapper can't classify as inline (falls through to XRGenericPanel), or
      // a list item's lead-in text followed by a nested sub-list. Those block
      // children ARE dispatched via renderChild and need a real
      // panel-absolute Y that accounts for however much inline prose precedes
      // and separates them — otherwise every block child in the same node
      // collapses onto the same Y (absY), rendering superimposed on top of
      // each other instead of stacked.
      //
      // This mirrors estimateInlineFlowHeight's run-based flush algorithm
      // (utils.ts) so the positions computed here agree with the space that
      // algorithm already reserved during height estimation.
      const flatForPositioning = flattenAndMerge(node.children);
      const m = inlineOwnerFontMetrics(node, metrics);
      const itemWidth =
        node.type === "XRListItem"
          ? Math.max(0.025, availableWidth - metrics.listItemProseInset)
          : availableWidth;
      const wordsPerLine = computeWordsPerLine(itemWidth, m);
      const lineH = m.fontSize * m.lineHeightRatio;

      const blockPositions = new Map<string, { y: number; h: number }>();
      {
        let cursorY = absY;
        let inlineWords = 0;
        let firstSegment = true;
        const flushInline = () => {
          if (inlineWords === 0) return;
          const lineCount = Math.max(
            1,
            Math.ceil(inlineWords / Math.max(1, wordsPerLine)),
          );
          if (!firstSegment) cursorY -= config.childGapY;
          cursorY -= lineCount * lineH;
          firstSegment = false;
          inlineWords = 0;
        };
        for (const fc of flatForPositioning) {
          if (isInlinePrimitive((fc as any).type)) {
            const wc =
              (fc as any).wordCount != null && (fc as any).wordCount > 0
                ? (fc as any).wordCount
                : countWords((fc as any).text ?? (fc as any).label ?? "");
            inlineWords += wc;
          } else {
            flushInline();
            if (!firstSegment) cursorY -= config.childGapY;
            const h = estimateHeight(
              fc as XRPrimitive,
              availableWidth,
              metrics,
              config,
              new Set(),
              scene,
            );
            blockPositions.set(fc.id, { y: cursorY, h });
            cursorY -= h;
            firstSegment = false;
          }
        }
      }

      for (const child of node.children) {
        if (!isFlattenedIntoProse(child)) {
          // Block child inside an inline-owning container: it IS dispatched
          // via renderChild and needs a panel-absolute position.
          if (!positionMap.has(child.id)) {
            const placed = blockPositions.get(child.id);
            const rawBlockY = placed?.y ?? absY;
            const parentPage = pageIndexMap[node.id] ?? 0;
            // XRListItem block children must stay on the same page as the item:
            // overflowCorrect mutates the outer pageIdx, which would cause
            // subsequent columns in the same placeListGrid row to inherit the
            // wrong page index. Clip planes handle any visual overflow.
            const { page: childPage, y: childRelY } =
              node.type === "XRListItem"
                ? { page: parentPage, y: rawBlockY }
                : overflowCorrect(rawBlockY, parentPage);
            const panelAbs: Vec3 = { x: absX, y: childRelY, z: 0 };
            positionMap.set(child.id, panelAbs);
            const childH =
              placed?.h ??
              estimateHeight(
                child,
                availableWidth,
                metrics,
                config,
                new Set(),
                scene,
              );
            heightMap.set(child.id, childH);
            pageIndexMap[child.id] = childPage;
          }
          const childAbs = positionMap.get(child.id)!;
          // See the top-level sweep below: save/restore pageIdx around each
          // sibling's recursive descent so one child's deeply-nested overflow
          // correction doesn't leak into how later siblings in this same
          // loop get paged (same leak placeListGrid already guards against).
          const pageIdxBeforeChild = pageIdx;
          stampDescendants(child, childAbs.x, childAbs.y, availableWidth);
          pageIdx = pageIdxBeforeChild;
        }
      }
      return;
    }

    // If the children are already in positionMap (stamped by splitSection or
    // the main loop), just recurse with their known absolute positions.
    //
    // Checking only node.children[0] used to miss this: splitSection's
    // section-like/recursive-container branches `continue` past a child with
    // zero children without ever calling positionMap.set on it (there's
    // nothing to render, so nothing to position). If THAT empty child
    // happens to be first in the array — e.g. a stray empty XRGenericPanel
    // ahead of a page's real content, which is common for a document's
    // implicit lead section — the array-order check saw an "unstamped"
    // first child and wrongly concluded none of this node's children had
    // been paginated yet, so it fell through to the block below and re-ran
    // stackChildrenSimple's naive single-page flow over children that
    // splitSection had already correctly spread across many real pages.
    // That silently overwrote their correct pageIndex/position with a
    // freshly (and wrongly) computed one, landing already-paginated content
    // from an earlier section on the same page as a later, unrelated
    // section and rendering both superimposed. Checking whether ANY child
    // is stamped is robust to a skipped-empty child anywhere in the array,
    // including first.
    const alreadyStamped = node.children.some((c) => positionMap.has(c.id));
    if (alreadyStamped) {
      for (const child of node.children) {
        const childAbs = positionMap.get(child.id);
        if (!childAbs) continue;
        const pageIdxBeforeChild = pageIdx;
        stampDescendants(child, childAbs.x, childAbs.y, availableWidth);
        pageIdx = pageIdxBeforeChild;
      }
      return;
    }

    // Children are NOT in the map yet. Run stackChildrenSimple in the context
    // of this node to get their local-to-parent positions, then convert each
    // to panel-absolute by adding the parent's known absolute position.
    const resolvedListColumns =
      node.type === "XRList"
        ? resolveListColumns(availableWidth, metrics)
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

      // Compute page-relative Y, correcting for overflow into subsequent pages.
      // stampSubtree already stamped all descendants with the parent's page index,
      // but children of a tall container (e.g. XRList with many XRListItems) can
      // extend past the viewport boundary. overflowCorrect derives the correct
      // page and page-relative Y, extending pageYOffsets as needed so totalPages
      // reflects the true page count.
      //
      // Exception: XRListItem children must stay on the same page as the item.
      // overflowCorrect mutates the outer pageIdx closure, which would corrupt
      // the page assignment of subsequent columns in the same placeListGrid row.
      const rawY = absY + local.position.y;
      const parentPage = pageIndexMap[node.id] ?? 0;
      const { page: childPage, y: childRelY } =
        node.type === "XRListItem"
          ? { page: parentPage, y: rawY }
          : overflowCorrect(rawY, parentPage);

      const panelAbs: Vec3 = {
        x: absX + local.position.x,
        y: childRelY,
        z: local.position.z,
      };
      positionMap.set(child.id, panelAbs);
      heightMap.set(child.id, local.size.height);
      // Persist the width stackChildrenSimple just computed for this specific
      // nesting level (already narrowed by this container's own x-padding).
      // Without this, layoutPrimitive's final entries assembly finds no
      // widthMap entry for anything outside a list grid's card-promotion
      // path and falls back to the full top-level panel width for every
      // nested Section/Article/Paragraph — silently discarding the correct,
      // progressively-narrower width and letting each nesting level's right
      // edge drift past its actual parent's boundary.
      widthMap.set(child.id, local.size.width);
      pageIndexMap[child.id] = childPage;

      // Recurse: the child's usable width comes from stackChildrenSimple's
      // entry, which already accounts for the child's own x-padding. Save/
      // restore pageIdx around the call — same leak as the other recursive
      // sites in this function (a deeply-nested descendant's overflow
      // correction must not change how the NEXT sibling in this loop pages).
      const pageIdxBeforeChild = pageIdx;
      stampDescendants(child, panelAbs.x, panelAbs.y, local.size.width);
      pageIdx = pageIdxBeforeChild;
    }
  }

  // Kick off the pass from each top-level child that was placed by the main
  // pagination loop. Their absolute positions are already in positionMap.
  // stampDescendants can mutate the closured pageIdx via overflowCorrect when
  // a deeply-nested descendant needs a page that doesn't exist yet — save and
  // restore around each call so that leak doesn't corrupt the page index for
  // unrelated later siblings or the final totalPages count (same pattern as
  // placeListGrid's save/restore around its stampDescendants call above).
  for (const child of children) {
    const abs = positionMap.get(child.id);
    if (!abs) continue;
    const pageIdxBeforeDescendants = pageIdx;
    stampDescendants(child, abs.x, abs.y, childWidth);
    pageIdx = pageIdxBeforeDescendants;
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
    placedWidthMap: widthMap,
    syntheticPrimitives,
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
    entry.listColumns = resolveListColumns(panelUsableWidth, metrics);
  }
  if (primitive.type === "XRImage") {
    // Size the image from its intrinsic dimensions (aspect-preserving), instead
    // of stretching the full slot width to a fixed photo height. The renderer
    // draws entry.size directly, so this is what fixes both the blown-up
    // decorative icons and the aspect distortion. availableWidth is the slot the
    // image was given (entry.size.width from the stack/grid placement).
    const img = primitive as XRImage;
    const { width, height } = resolveImageDisplaySize(
      img.intrinsicWidth,
      img.intrinsicHeight,
      entry.size.width,
      metrics,
    );
    entry.size = { width, height };
  }
}

// ─────────────────────────────────────────────────────────────
// Recursive layout walker
// ─────────────────────────────────────────────────────────────

// Outside XRContentPanel: stackChildrenSimple computes positions.
// Inside: reads from placedPositionMap/placedHeightMap — never re-estimates,
// because split fragments have a truncated height that differs from estimateHeight.
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
  placedWidthMap?: Map<string, number>,
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
    // worldSize.width is already panel-padding-reduced once we're a descendant
    // inside a paginated panel (placedPositionMap set) — matching the basis
    // placeListGrid uses for the SAME list (see childWidth/usableW there).
    // Subtracting panelPaddingX*2 again here would narrow the width used to
    // resolve column count below what placeListGrid actually placed items
    // with, causing entry.listColumns to disagree with the real column count
    // and rendered cards to overlap/gap relative to their true slot pitch.
    // Outside a paginated panel (top-level call), worldSize.width is still
    // full/unreduced and needs the single reduction to match
    // stackChildrenSimple's own ownsXPadding-driven reduction.
    placedPositionMap
      ? Math.max(0.025, worldSize.width)
      : Math.max(0.025, worldSize.width - config.panelPaddingX * 2),
    metrics,
  );

  // Container types that call paginateContentPanel when at the top level
  // (not already inside another paginated panel). XRNavigationBar and
  // XRComplementary are excluded because they are fixed-height landmark
  // fixtures that must not scroll. XRBanner and XRFooter are intentionally
  // hidden in XR, so pagination is irrelevant for them.
  const PAGINATING_CONTAINER_TYPES = new Set([
    "XRContentPanel",
    "XRSection",
    "XRArticle",
    "XRFormPanel",
    "XRGenericPanel",
  ]);

  if (primitive.children.length > 0) {
    if (PAGINATING_CONTAINER_TYPES.has(primitive.type) && !placedPositionMap) {
      // ── Paginating path ──────────────────────────────────────────────────
      // Called for XRContentPanel (unchanged) AND for XRSection, XRArticle,
      // XRFormPanel, XRGenericPanel when they appear at the top level (not
      // already inside a paginated container). Children receive panel-absolute
      // positions; the renderer wraps them in a group at this primitive's
      // world position.
      entry.paginatedByEngine = true;
      const {
        pagination,
        pageIndexMap: newPageIndexMap,
        placedPositionMap: newPlacedPositionMap,
        placedHeightMap: newPlacedHeightMap,
        placedWidthMap: newPlacedWidthMap,
        syntheticPrimitives: newSyntheticPrimitives,
      } = paginateContentPanel(
        primitive.children,
        worldSize.width,
        scene,
        config,
        metrics,
        diag,
      );

      // Inject paragraph continuation nodes into the scene registry and the
      // panel's children list so the renderer dispatches them as positioned
      // siblings with their own LayoutEntries.
      for (const synth of newSyntheticPrimitives) {
        (scene.primitives as Record<string, XRPrimitive>)[synth.id] = synth;
        (primitive.children as XRPrimitive[]).push(synth);
      }

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
        const childPos =
          newPlacedPositionMap.get(child.id) ?? topOfPagePos(config);
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
          newPlacedWidthMap,
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
      // Inline-owning nodes (XRParagraph, XRHeading, XRListItem, XRBlockQuote,
      // and an all-inline-children XRGenericPanel wrapper) render their inline
      // children (XRText, XRLink, XRButton) as text runs internally — those
      // children are NOT independent 3D nodes and must NOT get LayoutEntries.
      // stampDescendants already skips stamping positions for them (see
      // isInlineOwningNode); here we skip producing LayoutEntries for them
      // too. Must use the exact same check as stampDescendants
      // (isFlattenedIntoProse) — a narrower check (e.g. isInlinePrimitive
      // alone) misses XRGenericPanel wrappers that flatten into prose (like
      // a Wikipedia <span class="frac">), leaving those children with bogus
      // fallback entries (top-of-page position, every one of them landing on
      // the exact same point) instead of no entry at all.
      if (isInlineOwningNode(primitive)) {
        // Only recurse into block (non-inline) children — e.g. a sub-list or
        // image inside a list item, which ARE dispatched via renderChild.
        for (const child of primitive.children) {
          if (isFlattenedIntoProse(child)) continue;
          const childPos =
            placedPositionMap.get(child.id) ?? topOfPagePos(config);
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
            placedWidthMap,
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

      // worldSize.width is already the panel-padding-reduced usable width at
      // this point (see the attachResolvedStrategies call above) — matches
      // placeListGrid's `usableW = childWidth` basis. No further panelPaddingX
      // subtraction here, or cards render narrower than their actual slot
      // pitch and drift out of sync with where placeListGrid put them.
      const listCardWidth = listCols
        ? Math.max(
            0.025,
            (worldSize.width - config.childGapY * (listCols - 1)) / listCols,
          )
        : null;

      for (const child of primitive.children) {
        const childPos =
          placedPositionMap.get(child.id) ?? topOfPagePos(config);
        const childPageIndex = pageIndexMap?.[child.id] ?? inheritedPageIndex;

        let childHeight = placedHeightMap.get(child.id);

        // A list item placeListGrid promoted to a full-width row (too tall
        // for its normal grid column even on an empty page) carries an
        // override in placedWidthMap — it must win over the uniform
        // per-column listCardWidth, or the height computed for it upstream
        // (at the wider width) won't match the narrower box it's squeezed
        // back into here, reintroducing the same overflow it was meant to fix.
        const childWidth =
          placedWidthMap?.get(child.id) ??
          listCardWidth ??
          Math.max(0.025, worldSize.width);
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
          placedWidthMap,
        );
      }
    } else {
      // ── Outside any XRContentPanel — stackChildrenSimple ─────────────────
      // Children get PARENT-RELATIVE positions here. Flag the container so the
      // renderer nests its child dispatch in a positioned group (see
      // LayoutEntry.childrenParentRelative) — otherwise a nested container like
      // an XRList inside a landmark slot loses its own offset and its items
      // detach from it.
      entry.childrenParentRelative = true;
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
        // Inline children of inline-owning parents (including synthetic XRText
        // added by normalizeLabelNodes, and XRGenericPanel wrappers that
        // flatten into prose — see isFlattenedIntoProse) are rendered as text
        // runs by the mesh component — they must not get independent
        // LayoutEntries.
        if (isInlineOwningNode(primitive) && isFlattenedIntoProse(child))
          continue;

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
  arrangement?: Arrangement,
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

  // Arrangement path (new two-axis views): compose the arrangement's spatial
  // distribution over the auto-selected content template's slot roster. Legacy
  // path (no arrangement): the template's own hand-tuned SlotMap.
  const slots = arrangement
    ? resolveArrangementSlots(arrangement, resolvedTemplate, config, metrics)
    : selectSlots(resolvedTemplate, config, metrics);

  // Tell the paginator whether flowed XRComplementary asides will be extracted
  // to a real slot (see LayoutConfig.complementaryExtractedToSlot). When they
  // will be, the paginator must not let them occupy flow space — otherwise the
  // page an overflowing aside lands on is left blank after extraction.
  config.complementaryExtractedToSlot = !!slots.complementary;

  const topLevelPrimitives = scene.root.children;
  const usedSlots = new Set<SlotName>();

  // Top-level XRComplementary landmarks (an <aside> that is a sibling of the
  // page's sections, not nested inside one) classify to the complementary slot.
  // They are always visible — no page gating — so they'd sit permanently at the
  // slot's top lane and collide with any section-nested aside the pagination
  // pass later extracts to the SAME slot. Defer their placement to the unified
  // complementary-packing pass below so both kinds share one skyline and stack
  // instead of overlapping.
  const hoistedComplementaries: XRPrimitive[] = [];

  for (const primitive of topLevelPrimitives) {
    let slotName = classifyLandmark(primitive);

    if (usedSlots.has(slotName) && slotName !== "main") {
      slotName = "main";
    }
    usedSlots.add(slotName);

    // Only defer when a complementary slot actually exists — otherwise fall
    // through so the aside still lands somewhere (the main slot) rather than
    // being dropped, since the packing pass below is gated on compSlot.
    if (
      slotName === "complementary" &&
      primitive.type === "XRComplementary" &&
      slots.complementary
    ) {
      hoistedComplementaries.push(primitive);
      continue;
    }

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

  // Extract any XRComplementary nodes that were paginated inside a content
  // panel and re-layout them at the complementary slot with world-space
  // coordinates.
  //
  // Design intent: a section-nested <aside> is *that section's* aside. It must
  // occupy the complementary panel for as long as its section is on screen, and
  // be replaced by the next section's aside when the reader moves on. Column
  // pagination, however, flows the aside as an ordinary block, so it lands on
  // the page it overflowed onto — typically one page *past* its section body.
  // Gating on that page shows the aside detached from its own section.
  //
  // Fix: gate each extracted aside to its parent section's page RANGE
  // [firstPage … lastPage] (computed from the section's non-aside descendants),
  // so it stays pinned in the complementary panel across every page the section
  // spans. Top-level asides (no parent section) keep their single overflow page.
  const compSlot = slots.complementary;
  if (compSlot) {
    // Parent pointers over the scene tree — used to find the section that owns
    // an aside, and to enumerate a subtree's ids.
    const parentOf = new Map<string, XRPrimitive>();
    const indexTree = (node: XRPrimitive): void => {
      for (const child of node.children) {
        parentOf.set(child.id, node);
        indexTree(child);
      }
    };
    indexTree(scene.root);

    const collectSubtreeIds = (node: XRPrimitive, out: Set<string>): void => {
      out.add(node.id);
      for (const child of node.children) collectSubtreeIds(child, out);
    };

    const nearestSection = (id: string): XRPrimitive | null => {
      let cur = parentOf.get(id);
      while (cur) {
        if (cur.type === "XRSection") return cur;
        if (cur.type === "XRContentPanel") return null;
        cur = parentOf.get(cur.id);
      }
      return null;
    };

    // Document (reading) order index for every primitive — a stable pre-order
    // DFS over the scene tree. Used to decide which aside sits on top when two
    // asides are co-visible in the complementary slot (earlier in the document
    // stacks above later).
    const docOrder = new Map<string, number>();
    {
      let n = 0;
      const orderTree = (node: XRPrimitive): void => {
        docOrder.set(node.id, n++);
        for (const child of node.children) orderTree(child);
      };
      orderTree(scene.root);
    }

    // ── Phase 1: gather every aside destined for the complementary slot ──────
    // The complementary slot is a single fixed rectangle, so each aside placed
    // in it lands at the SAME world position by default. Two kinds compete for
    // it and overlap when co-visible:
    //   • Hoisted asides  — top-level <aside> landmarks, ALWAYS visible (no page
    //     gating). Modelled with an all-pages range so they overlap everything.
    //   • Extracted asides — section-nested <aside>s the pagination pass flowed
    //     into a content panel; gated to their section's page range.
    // Collect both with a [gateStart … gateEnd] range (inclusive) so phase 2 can
    // pack co-visible asides into non-overlapping vertical lanes.
    type SlotAside = {
      prim: XRPrimitive;
      gateStart: number;
      gateEnd: number;
      alwaysVisible: boolean;
      order: number;
    };
    const slotAsides: SlotAside[] = [];

    for (const prim of hoistedComplementaries) {
      slotAsides.push({
        prim,
        // Overlaps any gated range, so extracted asides always stack beneath it.
        gateStart: Number.NEGATIVE_INFINITY,
        gateEnd: Number.POSITIVE_INFINITY,
        alwaysVisible: true,
        order: docOrder.get(prim.id) ?? Number.MAX_SAFE_INTEGER,
      });
    }

    for (const prim of Object.values(scene.primitives)) {
      if (prim.type !== "XRComplementary") continue;
      const existing = entries[prim.id];
      if (existing?.pageIndex === undefined) continue;
      const savedPageIndex = existing.pageIndex;

      // Resolve the parent section's page range, excluding the aside's own
      // (overflowed) descendants so they can't inflate the range end.
      let gateStart = savedPageIndex;
      let gateEnd = savedPageIndex;
      const section = nearestSection(prim.id);
      if (section) {
        const asideIds = new Set<string>();
        collectSubtreeIds(prim, asideIds);
        const sectionIds = new Set<string>();
        collectSubtreeIds(section, sectionIds);
        let min = Infinity;
        let max = -Infinity;
        for (const sid of sectionIds) {
          if (asideIds.has(sid)) continue;
          const p = entries[sid]?.pageIndex;
          if (p === undefined) continue;
          if (p < min) min = p;
          if (p > max) max = p;
        }
        if (min !== Infinity) {
          gateStart = min;
          gateEnd = max;
        }
      }

      slotAsides.push({
        prim,
        gateStart,
        gateEnd,
        alwaysVisible: false,
        order: docOrder.get(prim.id) ?? Number.MAX_SAFE_INTEGER,
      });
    }

    // ── Phase 2: one aside at a time (mutual exclusion) ─────────────────────
    // Every slot aside is placed at the SAME fixed slot position; the slot sits
    // at the content panel's right edge with no room to tile sideways and no way
    // to page-vary a single primitive's position, so instead we time-share the
    // slot by page. Higher-priority asides claim their pages first and lower
    // ones are punched out (pageExcludeRanges) on any page already taken:
    //   • section-scoped asides (contextual) beat the persistent aside, and
    //   • earlier-in-document asides beat later ones (so a media aside beats the
    //     aside nested inside it).
    // The persistent interstitial aside spans the whole document and fills only
    // the pages no section aside owns.
    slotAsides.sort((a, b) => {
      if (a.alwaysVisible !== b.alwaysVisible) return a.alwaysVisible ? 1 : -1;
      return a.order - b.order;
    });

    // Last page of the document, so the persistent aside can span [0 … maxPage].
    let maxPage = 0;
    for (const e of Object.values(entries)) {
      if (e.pageEndIndex !== undefined && e.pageEndIndex > maxPage)
        maxPage = e.pageEndIndex;
      else if (e.pageIndex !== undefined && e.pageIndex > maxPage)
        maxPage = e.pageIndex;
    }

    // Page ranges already claimed by higher-priority asides.
    const claimed: Array<[number, number]> = [];

    for (const { prim, gateStart, gateEnd, alwaysVisible } of slotAsides) {
      const baseStart = alwaysVisible ? 0 : gateStart;
      const baseEnd = alwaysVisible ? maxPage : gateEnd;

      // Holes where a higher-priority aside already owns the slot.
      const excludeRanges: Array<[number, number]> = [];
      for (const [cs, ce] of claimed) {
        const s = Math.max(cs, baseStart);
        const e = Math.min(ce, baseEnd);
        if (s <= e) excludeRanges.push([s, e]);
      }

      layoutPrimitive(
        prim,
        compSlot.position,
        compSlot.rotation,
        compSlot.size,
        compSlot.curveRadius,
        compSlot.worldLocked,
        scene,
        config,
        metrics,
        entries,
        diag,
        baseStart,
      );

      // Stamp the whole subtree with the resolved page window + exclusions so
      // every descendant gates identically (the container is hidden only when
      // none of its descendants are visible).
      const asideSubtree = new Set<string>();
      collectSubtreeIds(prim, asideSubtree);
      for (const sid of asideSubtree) {
        const e = entries[sid];
        if (!e) continue;
        e.pageIndex = baseStart;
        if (baseEnd > baseStart) e.pageEndIndex = baseEnd;
        else delete e.pageEndIndex;
        if (excludeRanges.length > 0) e.pageExcludeRanges = excludeRanges;
        else delete e.pageExcludeRanges;
      }

      claimed.push([baseStart, baseEnd]);
    }
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
    referenceFrame: arrangement?.frame ?? "world",
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
