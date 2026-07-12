import type {
  Vec3,
  Rotation3,
  Size2,
  XRPrimitive,
  XRImage,
  XRTable,
  SemanticScene,
} from "../mapper/types";
import {
  _estimateTextBearingItemHeight,
  estimateHeight,
  isIconSizedImage,
  PRIMITIVE_CONFIG,
  resolveImageDisplaySize,
} from "./positionConfigs";
import { selectSlots, resolveArrangementSlots } from "./placement";
import { selectLayoutTemplate } from "./templates";
import type {
  Arrangement,
  DeviceProfile,
  LayoutTemplate,
  RenderMetrics,
  LayoutEntry,
  LayoutDiagnostics,
  LayoutPlan,
  LayoutConfig,
  SlotName,
  SimpleStackResult,
} from "./types";
import {
  containerInsetX,
  resolveListColumns,
  resolveTableStrategy,
  zeroRotation,
  zeroVec,
} from "./utils";

// ── Shared helpers ────────────────────────────────────────────────────────────

import {
  topOfPagePos,
  classifyLandmark,
  isInlineOwningNode,
  isFlattenedIntoProse,
} from "./engine/classify";
import { paginateContentPanel } from "./engine/pagination";

export function stackChildrenSimple(
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

export function attachResolvedStrategies(
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
export function layoutPrimitive(
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

  // Live tuning override: stamp the HUD's values onto each targeted slot.
  // Slots are freshly built each call, so mutating here is safe. Only fields the
  // HUD actually set are applied; the rest keep the template's computed value.
  if (config.slotOverrides) {
    for (const [name, ov] of Object.entries(config.slotOverrides)) {
      const s = slots[name as SlotName];
      if (!s || !ov) continue;
      if (ov.x !== undefined) s.position.x = ov.x;
      if (ov.y !== undefined) s.position.y = ov.y;
      if (ov.z !== undefined) s.position.z = ov.z;
      if (ov.rotX !== undefined) s.rotation.x = ov.rotX;
      if (ov.rotY !== undefined) s.rotation.y = ov.rotY;
      if (ov.rotZ !== undefined) s.rotation.z = ov.rotZ;
      if (ov.curveRadius !== undefined) s.curveRadius = ov.curveRadius;
    }
  }

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
    slots,
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
