/**
 * scene/panels.tsx
 *
 * Panel-level renderers: the paginating content panel, generic/backing panel
 * meshes, pagination controls, and the world-space clip-plane builder.
 */
import React, { useMemo } from "react";
import * as THREE from "three";
import { Text } from "@react-three/drei";

import type { XRPrimitive } from "../../mapper/types";
import type { LayoutEntry } from "../../layout/types";
import { useTheme } from "../theme";
import {
  Surface,
  ClipPlanesContext,
  PanelOriginYContext,
  PanelCurveContext,
  usePanelCurve,
  resolveCurveRadius,
  curvePoint,
  makeBentPlane,
  type PanelCurve,
} from "../primitives";
import {
  CurrentPageContext,
  PageRangeContext,
  FontContext,
  StackDepthContext,
  stackZ,
  zeroedEntry,
} from "./contexts";
import { PrimitiveDispatcher, type DispatcherProps } from "./dispatcher";
import {
  collectExtractedComplementaries,
  isExtractedComplementary,
} from "./dispatch-children";

export function PaginatingPanelRenderer({
  primitive,
  plan,
  pageState,
  setPage,
  primitiveMap,
  entry,
}: DispatcherProps & { entry: LayoutEntry }) {
  const currentPage = pageState[primitive.id] ?? 0;
  const pagination = entry.pagination;
  const depth = React.useContext(StackDepthContext);

  // Curve resolution. A top content panel carries its own authored curveRadius
  // and becomes the cylinder origin: its group stays at the flat slot position,
  // so the surface is tangent at the panel's CENTRE and children bend about
  // `width / 2`.
  //
  // A NESTED paginating container (curveRadius 0) inherits the parent cylinder
  // and is tangent-placed on it by curvePoint below — which puts its group
  // ORIGIN on the cylinder, already yawed to the tangent there. Its children
  // must therefore bend about x = 0, not about its own half-width: re-centring
  // on the half-width applies a second rotation on top of the tangent one, and
  // the child surface peels off the cylinder it is supposed to lie on. Inside an
  // <aside> that put the item tiles ~11 mm BEHIND the aside's own backing, so
  // the opaque backing occluded most of each tile and the rail read as flat,
  // clipped boxes.
  const inheritedCurve = usePanelCurve();
  const ownRadius = resolveCurveRadius(entry.curveRadius);
  const subtreeRadius = ownRadius ?? inheritedCurve?.radius ?? null;
  const tangentPlaced = !!inheritedCurve && !ownRadius;
  const panelCurve: PanelCurve | null = subtreeRadius
    ? {
        radius: subtreeRadius,
        centerX: tangentPlaced ? 0 : entry.size.width / 2,
      }
    : null;

  const ex0 = entry.position.x;
  const ey0 = entry.position.y;
  const ez0 = entry.position.z + stackZ(depth);
  let ex = ex0;
  let ey = ey0;
  let ez = ez0;
  let yaw = entry.rotation.y;
  if (tangentPlaced && inheritedCurve) {
    const placed = curvePoint(
      ex0,
      ey0,
      ez0,
      inheritedCurve.radius,
      inheritedCurve.centerX,
    );
    [ex, ey, ez] = placed.position;
    yaw = entry.rotation.y + placed.yaw;
  }
  const rot: [number, number, number] = [
    entry.rotation.x,
    yaw,
    entry.rotation.z,
  ];

  // Clip planes are evaluated in WORLD space, but `ey` is this group's position
  // inside whatever group encloses it. Those coincide for a top-level content
  // panel (PanelOriginYContext defaults to 0) and NOT for a paginating
  // container nested in a landmark slot — an XRGenericPanel inside an <aside>
  // is laid out by stackChildrenSimple, so its y is parent-relative (≈ −0.056,
  // the panel's top padding). Passing that raw put the planes a whole slot
  // height below the geometry and clipped the entire subtree away, which is why
  // the complementary rail rendered as an empty slab with its content present
  // in the scene but invisible. Compose with the enclosing panel's world origin.
  const parentPanelOriginY = React.useContext(PanelOriginYContext);
  const worldTopY = parentPanelOriginY + ey;
  const panelClipPlanes = useMemo(
    () => buildPanelClipPlanes(worldTopY, entry.size.height),
    [worldTopY, entry.size.height],
  );

  // XRComplementary nodes extracted to the world-space slot by the engine.
  // Only ever present inside XRContentPanel; other container types never have
  // them. They render OUTSIDE the panel group so their world-space slot
  // positions apply directly, but inside CurrentPageContext so gating works.
  const extractedComps = useMemo(
    () =>
      primitive.type === "XRContentPanel"
        ? collectExtractedComplementaries(primitive, plan)
        : [],
    [primitive, plan],
  );

  // Apply the section page range only for the top-level content panel — not
  // for nested sections/articles which have their own per-child pagination.
  const pageRange = React.useContext(PageRangeContext);
  const effectiveRange = primitive.type === "XRContentPanel" ? pageRange : null;

  return (
    <CurrentPageContext.Provider value={currentPage}>
      {extractedComps.map((comp) => (
        <PrimitiveDispatcher
          key={comp.id}
          primitive={comp}
          plan={plan}
          pageState={pageState}
          setPage={setPage}
          primitiveMap={primitiveMap}
        />
      ))}
      <group key={primitive.id} position={[ex, ey, ez]} rotation={rot}>
        <PanelCurveContext.Provider value={panelCurve}>
          <PanelBacking entry={zeroedEntry(entry)} curve={panelCurve} />
          <ClipPlanesContext.Provider value={panelClipPlanes}>
            <PanelOriginYContext.Provider value={worldTopY}>
              <StackDepthContext.Provider value={depth + 1}>
                {primitive.children
                  .filter((child) => !isExtractedComplementary(child, plan))
                  .map((child) => (
                    <PrimitiveDispatcher
                      key={child.id}
                      primitive={child}
                      plan={plan}
                      pageState={pageState}
                      setPage={setPage}
                      primitiveMap={primitiveMap}
                    />
                  ))}
              </StackDepthContext.Provider>
            </PanelOriginYContext.Provider>
          </ClipPlanesContext.Provider>
          {pagination && pagination.pageCount > 1 && (
            <PaginationControls
              primitiveId={primitive.id}
              pagination={pagination}
              currentPage={currentPage}
              entry={zeroedEntry(entry)}
              onPageChange={(p) => setPage(primitive.id, p)}
              pageRange={effectiveRange}
            />
          )}
        </PanelCurveContext.Provider>
      </group>
    </CurrentPageContext.Provider>
  );
}

export function PanelBacking({
  entry,
  ghostOpacity,
  curve,
}: {
  entry: LayoutEntry;
  /**
   * When set, renders as a translucent, dimmed "ghost" preview panel (a page
   * in the field that is not the one being read) instead of the normal opaque
   * matte card.
   */
  ghostOpacity?: number;
  /**
   * Explicit cylinder curve for a panel's OWN centred backing (top content
   * panel / complementary), which is not wrapped in an <AtPos>. When omitted,
   * the backing still bends if it sits in an ambient PanelCurveContext — that's
   * the nested container case (XRArticle/XRFormPanel/XRFigure), where an outer
   * <AtPos> already tangent-yawed this group at its top-left.
   */
  curve?: PanelCurve | null;
}) {
  const theme = useTheme();
  const w = Math.max(entry.size.width, 0.025);
  const h = Math.max(entry.size.height, 0.032);
  const isGhost = ghostOpacity !== undefined;

  const ctxCurve = usePanelCurve();
  const activeCurve = curve ?? ctxCurve;
  // Explicit centred backing bends around the panel centre (geometry sits at
  // [w/2,-h/2], so pivot = centerX − w/2 = 0). A context-driven nested backing
  // bends around the group origin the outer <AtPos> yawed tangent (pivot = −w/2).
  const bentPivotX = curve ? curve.centerX - w / 2 : -w / 2;
  const bentFill = React.useMemo(
    () =>
      activeCurve ? makeBentPlane(w, h, activeCurve.radius, bentPivotX) : null,
    [activeCurve, w, h, bentPivotX],
  );
  const bentGradient = React.useMemo(
    () =>
      activeCurve
        ? makeBentPlane(
            w,
            h,
            activeCurve.radius,
            bentPivotX,
            theme.panelGradientTop,
            theme.panelGradientBottom,
          )
        : null,
    [
      activeCurve,
      w,
      h,
      bentPivotX,
      theme.panelGradientTop,
      theme.panelGradientBottom,
    ],
  );

  // Curved variant: a segmented bent plane fill + a bent gradient wash (the
  // flat RoundedBox can't wrap onto the cylinder). Rounded corners are traded
  // for the arc — see makeBentPlane / the curved-panels design notes.
  if (activeCurve) {
    return (
      <>
        {/* Unlit, for the same reason the flat branch below is — an interface
            surface must not take a tint from the room's lights. */}
        <mesh geometry={bentFill!} position={[w / 2, -h / 2, -0.0006]}>
          <meshBasicMaterial
            color={theme.panelBg}
            transparent={isGhost}
            opacity={isGhost ? ghostOpacity : 1}
          />
        </mesh>
        <mesh geometry={bentGradient!} position={[w / 2, -h / 2, 0.0005]}>
          <meshBasicMaterial
            vertexColors
            transparent
            opacity={isGhost ? ghostOpacity! : 1}
            depthWrite={false}
          />
        </mesh>
      </>
    );
  }

  // Two layers only — opaque matte fill + gradient wash. This backing is
  // reused for the top-level content panel AND every nested XRArticle/
  // XRFormPanel/XRComplementary container, so a document with many nested
  // containers no longer stacks a border-rim box + highlight strip per
  // container at nearly the same Z depth (that compounding read as a thick
  // "brick" of panels when viewed edge-on — see the matching simplification
  // in XRSectionMesh, primitives.tsx). The box front face sits at local z = 0;
  // child primitives don't collide with it because each nesting level is
  // staggered forward on the Z axis by StackDepthContext (see AtPos).
  // ONE layer: a <Surface> whose vertical gradient is baked into its vertex
  // colours, plus a hairline rim.
  //
  // This used to be a drei <RoundedBox> with a separate gradient quad in front
  // of it. Both parts were wrong. RoundedBox's radius is a 3-D bevel capped at
  // depth / 2, so with DEPTH = 0.01 the largest corner a metre-wide reading
  // panel could have was 5 mm — it read as a square slab while every chip beside
  // it was properly rounded (the whole reason <Surface> exists; see the
  // PANEL_RADIUS note in primitives/constants.ts). And its fill was lit, so the
  // panel took a tint from whatever the surrounding space was lit with while the
  // unlit gradient quad in front of it did not, which is what made the seam
  // between them visible in the rooms view.
  //
  // Surface rounds to the Horizon fraction of the shorter edge, bakes the
  // gradient into the same draw call, and is unlit — so the panel is exactly
  // the theme colour, in every view, with one mesh instead of two.
  return (
    <Surface
      width={w}
      height={h}
      color={theme.panelGradientBottom}
      topColor={theme.panelGradientTop}
      opacity={isGhost ? ghostOpacity! : 1}
      rimColor={isGhost ? undefined : theme.panelRim}
      rimOpacity={0.35}
    />
  );
}

export function GenericPanelMesh({
  primitive,
  entry,
}: {
  primitive: XRPrimitive;
  entry: LayoutEntry;
}) {
  const theme = useTheme();
  const w = Math.max(entry.size.width, 0.025);
  const h = Math.max(entry.size.height, 0.032);
  const fontType = React.useContext(FontContext);
  return (
    <>
      <mesh position={[w / 2, -h / 2, 0]}>
        <planeGeometry args={[w, h]} />
        <meshBasicMaterial color={theme.panelBg} />
      </mesh>
      <Text
        font={fontType}
        anchorX="left"
        anchorY="top"
        position={[0.006, -0.005, 0.001]}
        fontSize={0.011}
        color={theme.bodyCol}
        maxWidth={w - 0.012}
      >
        {`${primitive.type}${primitive.label ? ` · ${primitive.label.slice(0, 32)}` : ""}`}
      </Text>
    </>
  );
}

export function PaginationControls({
  primitiveId: _id,
  pagination,
  currentPage,
  entry,
  onPageChange,
  pageRange,
}: {
  primitiveId: string;
  pagination: { pageCount: number };
  currentPage: number;
  entry: LayoutEntry;
  onPageChange: (page: number) => void;
  pageRange?: [number, number] | null;
}) {
  const theme = useTheme();
  const w = entry.size.width;
  const h = entry.size.height;
  const fontType = React.useContext(FontContext);

  // When a section range is active, clamp navigation and show relative page numbers.
  const firstPage = pageRange?.[0] ?? 0;
  const lastPage = pageRange?.[1] ?? pagination.pageCount - 1;
  const sectionPageCount = lastPage - firstPage + 1;
  const relPage = currentPage - firstPage; // 0-based within section
  const atFirst = currentPage <= firstPage;
  const atLast = currentPage >= lastPage;

  // Single rounded control bar (Horizon "segmented pill"): the two circular
  // chevron buttons and the page indicator share one recessed, rounded panel
  // instead of floating as three separate spread-out elements.
  const BAR_W = 0.24;
  const BAR_H = 0.06;
  const BTN_SIZE = 0.042;
  const PAD_X = 0.014;
  const btnX = BAR_W / 2 - PAD_X - BTN_SIZE / 2;
  const barY = -(h + BAR_H / 2 + 0.02);

  return (
    <group position={[w / 2, barY, 0.005]}>
      {/* Rounded control-bar backing */}
      <Surface
        width={BAR_W}
        height={BAR_H}
        radius={BAR_H / 2}
        color={theme.navBg}
        gradient
        rimColor={theme.panelRim}
        origin={[0, 0]}
      />

      {/* Previous */}
      <group
        position={[-btnX, 0, 0.006]}
        onClick={(e) => {
          // R3F delivers a pointer event to EVERY object the ray crosses, not
          // just the nearest one. Without this the same click also lands on the
          // card click-backing behind the bar and navigates away — pressing the
          // pager read as clicking the story underneath it.
          e.stopPropagation();
          onPageChange(Math.max(firstPage, currentPage - 1));
        }}
      >
        <Surface
          width={BTN_SIZE}
          height={BTN_SIZE}
          radius={BTN_SIZE / 2}
          color={atFirst ? theme.disabledBg : theme.emphasisCol}
          opacity={atFirst ? 0.6 : 1}
          flat
          origin={[0, 0]}
        />
        <Text
          font={fontType}
          anchorX="center"
          anchorY="middle"
          position={[0, 0, 0.004]}
          fontSize={0.02}
          color={atFirst ? theme.mutedTextCol : theme.panelBg}
        >
          {"‹"}
        </Text>
      </group>

      {/* Page indicator */}
      <Text
        font={fontType}
        anchorX="center"
        anchorY="middle"
        position={[0, 0, 0.006]}
        fontSize={0.016}
        color={theme.bodyCol}
      >
        {`${relPage + 1} / ${sectionPageCount}`}
      </Text>

      {/* Next */}
      <group
        position={[btnX, 0, 0.006]}
        onClick={(e) => {
          e.stopPropagation();
          onPageChange(Math.min(lastPage, currentPage + 1));
        }}
      >
        <Surface
          width={BTN_SIZE}
          height={BTN_SIZE}
          radius={BTN_SIZE / 2}
          color={atLast ? theme.disabledBg : theme.emphasisCol}
          opacity={atLast ? 0.6 : 1}
          flat
          origin={[0, 0]}
        />
        <Text
          font={fontType}
          anchorX="center"
          anchorY="middle"
          position={[0, 0, 0.004]}
          fontSize={0.02}
          color={atLast ? theme.mutedTextCol : theme.panelBg}
        >
          {"›"}
        </Text>
      </group>
    </group>
  );
}

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

export function buildPanelClipPlanes(
  worldY: number,
  panelHeight: number,
): THREE.Plane[] {
  const topPlane = new THREE.Plane(new THREE.Vector3(0, -1, 0), worldY);
  const bottomPlane = new THREE.Plane(
    new THREE.Vector3(0, 1, 0),
    -(worldY - panelHeight),
  );
  return [topPlane, bottomPlane];
}
