/**
 * primitives/meshes/list.tsx
 *
 * List-item card mesh: renders a list item as a Horizon card with inline-prose
 * flow and (when eligible) its own world-space self-clip planes.
 */
import React, { useContext } from "react";
import * as THREE from "three";

import type { LayoutEntry } from "../../../layout/types";
import {
  mergeAdjacentTextRuns,
  isInlinePrimitive,
  flattenInlineWrappers,
} from "../../../layout/utils";
import { useTheme } from "../../theme";
import { PANEL_DEPTH } from "../constants";
import { Surface, safeDim, entryTransform } from "../surface";
import {
  ClipPlanesContext,
  useClipPlanes,
  PanelOriginYContext,
  CardSelfClipContext,
  useRenderMetrics,
} from "../contexts";
import { ClippedText, buildInlineRows, InlineProseRows } from "../inline";

export interface XRListItemMeshProps {
  primitive: import("../../../mapper/types").XRListItem;
  entry: LayoutEntry;
  renderChild: (primitiveId: string) => React.ReactNode;
  /**
   * This card's top-edge Y in panel-relative space. `entry` itself arrives
   * pre-zeroed (XRSceneRenderer wraps the real position on with its own
   * outer <AtPos>, since this mesh doubles as a WithSiblingChildren
   * "backing" — see the XRListItem case in XRSceneRenderer.tsx), so
   * entry.position.y is always 0 here and cannot be used for the
   * world-space clip-plane math below. Callers must pass the real,
   * un-zeroed panel-relative Y explicitly.
   */
  panelRelativeY: number;
}

export function XRListItemMesh({
  primitive,
  entry,
  renderChild,
  panelRelativeY,
}: XRListItemMeshProps) {
  const { pos, rot } = entryTransform(entry);
  const pageClips = useClipPlanes();
  const theme = useTheme();
  const metrics = useRenderMetrics();
  const w = safeDim(entry.size.width);
  const h = safeDim(entry.size.height);

  // The page-level clip planes only bound the current page's top/bottom
  // edge — nothing clips an individual card's own bottom edge. A citation
  // whose real wrapped line count comes out even slightly taller than this
  // card's estimated height then bleeds straight into the row below (two
  // unrelated citations' text superimposed). Adding this card's own
  // world-space Y bounds on top of the inherited page bounds contains any
  // such overflow to the card itself instead of letting it escape downward.
  const panelOriginY = useContext(PanelOriginYContext);
  const cardSelfClip = useContext(CardSelfClipContext);
  const cardClips = React.useMemo(() => {
    const topY = panelOriginY + panelRelativeY;
    const bottomY = topY - h;
    return [
      new THREE.Plane(new THREE.Vector3(0, -1, 0), topY),
      new THREE.Plane(new THREE.Vector3(0, 1, 0), -bottomY),
    ];
  }, [panelOriginY, panelRelativeY, h]);
  const clips = React.useMemo(
    // In a parent-relative landmark panel the card's Y isn't panel-absolute, so
    // its self-clip bounds would be wrong and cull it — fall back to the
    // panel's own clip planes only (see CardSelfClipContext).
    () => (cardSelfClip ? [...pageClips, ...cardClips] : pageClips),
    [pageClips, cardClips, cardSelfClip],
  );
  // Where content starts relative to the card top edge — a plain top padding
  // (no accent band is drawn anymore). Shared with the engine via the profile's
  // metrics.listItemContentPad — any drift causes visual overlap or dead gaps.
  const CONTENT_Y = -metrics.listItemContentPad;
  const proseInset = metrics.listItemProseInset;

  // primitive.label on XRListItem is the accessible-name / TOC string. When
  // the item has inline children (XRText/XRLink runs — see parser.ts
  // createListItem + buildChildrenFromSiblings), that label duplicates text
  // already present in those children and must NOT be rendered.
  //
  // However: a plain-text <li> with no inline tags produces children: [] —
  // bare text nodes are dropped and never become an XRText child. For that
  // case, label/content IS the item's only content and must still be rendered.
  const hasInlineChildren = primitive.children.length > 0;
  const displayText = hasInlineChildren
    ? null
    : (primitive.content ?? primitive.label ?? "");

  const labelFont = metrics.listItem.font;

  // FIX: flatten BEFORE checking for inline content so XRGenericPanel wrappers
  // around inline runs are unwrapped before the inline check.
  const flatChildren = flattenInlineWrappers(primitive.children as any[]);
  const hasAnyInlineChild = flatChildren.some((c) => isInlinePrimitive(c.type));
  const mergedFlatChildren = hasAnyInlineChild
    ? mergeAdjacentTextRuns(flatChildren)
    : null;

  const inlineOnlyChildren =
    mergedFlatChildren?.filter((c: any) => isInlinePrimitive(c.type)) ?? [];
  const blockChildren =
    mergedFlatChildren?.filter((c: any) => !isInlinePrimitive(c.type)) ?? [];
  const inlineRows =
    inlineOnlyChildren.length > 0 ? buildInlineRows(inlineOnlyChildren) : null;

  const m = metrics.paragraph;

  // Both multi-column grid tiles (nav/featured grids) and single-column rows
  // (plain <ul>/<ol>, TOC-like lists, settings-style rows) render as a solid
  // rounded matte tile (Meta Horizon "card" list variant), so every list
  // item reads as a distinct grabbable surface against its container.

  return (
    <group position={pos} rotation={rot}>
      <ClipPlanesContext.Provider value={clips}>
        <Surface width={w} height={h} color={theme.listItemBg} clips={clips} />

        {/* Plain-text list items (no child elements): label rendered below the top padding. */}
        {displayText && (
          <ClippedText
            anchorX="left"
            anchorY="top"
            position={[proseInset, CONTENT_Y, PANEL_DEPTH]}
            fontSize={labelFont.fontSize}
            color={theme.headingCol}
            fontWeight="600"
            lineHeight={labelFont.lineHeightRatio}
            maxWidth={w - proseInset * 2}
            overflowWrap="break-word"
          >
            {displayText}
          </ClippedText>
        )}

        {/* Inline children: flowed as prose starting at CONTENT_Y so the first
          line always clears the top padding.
          panelWidth is pre-reduced by the right inset so usableWidth = w - 2*xInset,
          giving symmetric left and right margins (same pattern as XRBlockQuoteMesh). */}
        {inlineRows && (
          <InlineProseRows
            rows={inlineRows}
            startY={CONTENT_Y}
            panelWidth={w - proseInset}
            fontSize={m.fontSize}
            lineHeightRatio={m.lineHeightRatio}
            xInset={proseInset}
            renderChild={renderChild}
          />
        )}

        {/* Block children from mixed inline+block items (e.g. sub-lists after
          a prose run). Engine places these at y=0 relative to the card origin;
          we shift by CONTENT_Y so they start below the top padding. */}
        {blockChildren.length > 0 && (
          <group position={[0, CONTENT_Y, 0]}>
            {blockChildren.map((child: any) => renderChild(child.id))}
          </group>
        )}

        {/* Pure-block items (no inline children at all). Engine also places these
          at y=0; same CONTENT_Y shift keeps them below the top padding. */}
        {!hasAnyInlineChild && primitive.children.length > 0 && (
          <group position={[0, CONTENT_Y, 0]}>
            {primitive.children.map((child) => renderChild(child.id))}
          </group>
        )}
      </ClipPlanesContext.Provider>
    </group>
  );
}

// ─────────────────────────────────────────────────────────────
// 12. XRButtonMesh
// ─────────────────────────────────────────────────────────────

