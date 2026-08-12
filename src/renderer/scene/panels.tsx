/**
 * scene/panels.tsx
 *
 * Panel-level renderers: the paginating content panel, its carousel ghost
 * neighbours, generic/backing panel meshes, pagination controls, and the
 * world-space clip-plane builder.
 */
import React, { useMemo } from "react";
import * as THREE from "three";
import { RoundedBox, Text } from "@react-three/drei";

import type { XRPrimitive } from "../../mapper/types";
import type { LayoutEntry, LayoutPlan } from "../../layout/types";
import { useTheme } from "../theme";
import { PanelGradientOverlay } from "../PanelGradient";
import {
  Surface,
  ClipPlanesContext,
  CardSelfClipContext,
  PanelOriginYContext,
  PanelCurveContext,
  usePanelCurve,
  resolveCurveRadius,
  curvePoint,
  makeBentPlane,
  Z_LAYER_ACCENT,
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

/** Shared no-op setPage for ghost/preview panels that must not change pages. */
const _noop = () => {};

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
  const rot: [number, number, number] = [entry.rotation.x, yaw, entry.rotation.z];

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

// ─────────────────────────────────────────────────────────────
// Carousel ghost panel
// ─────────────────────────────────────────────────────────────

/**
 * Renders one "ghost" copy of a paginated panel at an overridden world position.
 * Used by carousel mode to show the prev/next page panels beside the current one.
 * Non-interactive: no pagination controls, raycast disabled.
 */
export function CarouselGhostPanel({
  primitive,
  plan,
  entry,
  targetPage,
  primitiveMap,
  opacity,
  edgeSide,
  edgeColor,
  scale = 1,
}: {
  primitive: XRPrimitive;
  plan: LayoutPlan;
  entry: LayoutEntry;
  targetPage: number;
  primitiveMap: Map<string, XRPrimitive>;
  opacity: number;
  /**
   * The edge of the ghost that faces the page being read: the LEFT edge of
   * the next page, the RIGHT edge of the previous one. Banding it in the
   * section's own colour is what says "the next page, and it is still in this
   * section" — the same hue the wall and the deck give that section — and it
   * marks the seam between two pages standing side by side on the arc.
   */
  edgeSide?: "left" | "right";
  edgeColor?: string;
  /**
   * How much smaller than the page being read this neighbour is drawn
   * (`carouselGhostPlacement().scale`). A neighbour is the same panel at a
   * reduced size, and its children carry the MAIN panel's panel-absolute
   * layout, so the shrink is one group scale about the top-left anchor — not
   * a re-layout. `entry.size` therefore stays the full size throughout.
   */
  scale?: number;
}) {
  const depth = React.useContext(StackDepthContext);
  const ex = entry.position.x;
  const ey = entry.position.y;
  const ez = entry.position.z + stackZ(depth);
  const rot: [number, number, number] = [
    entry.rotation.x,
    entry.rotation.y,
    entry.rotation.z,
  ];

  // A neighbour sits on the same user-centred cylinder as the page being read
  // (see carouselGhostPlacement), so it bends on the same radius — that is
  // what makes the three of them read as one continuous surround rather than
  // three separately-curved cards. The bend is built in the group's own
  // coordinates, which the group scale then shrinks along with everything
  // else, so the local radius is divided by that scale to leave the curvature
  // the reader actually sees equal to the cylinder's.
  const ghostRadius = resolveCurveRadius(entry.curveRadius);
  const panelCurve: PanelCurve | null = ghostRadius
    ? { radius: ghostRadius / scale, centerX: entry.size.width / 2 }
    : null;

  // The panel's world-space top/bottom edges — the scaled ones, since that is
  // where the drawn page actually ends.
  const panelClipPlanes = React.useMemo(
    () => buildPanelClipPlanes(ey, entry.size.height * scale),
    [ey, entry.size.height, scale],
  );

  // Ghost pageState: only this panel's page is overridden
  const ghostPageState = React.useMemo(
    () => ({ [primitive.id]: targetPage }),
    [primitive.id, targetPage],
  );

  const ghostExtractedComps = React.useMemo(
    () =>
      primitive.type === "XRContentPanel"
        ? collectExtractedComplementaries(primitive, plan)
        : [],
    [primitive, plan],
  );

  return (
    <CurrentPageContext.Provider value={targetPage}>
      {ghostExtractedComps.map((comp) => {
        const compEntry = plan.entries[comp.id];
        if (!compEntry) return null;
        return (
          <group
            key={comp.id}
            position={[
              compEntry.position.x,
              compEntry.position.y,
              compEntry.position.z,
            ]}
            rotation={[0, 0, 0]}
          >
            {/* extracted comps dimmed alongside parent */}
          </group>
        );
      })}
      <group
        position={[ex, ey, ez]}
        rotation={rot}
        scale={scale}
        raycast={() => null}
      >
        <PanelCurveContext.Provider value={panelCurve}>
          <PanelBacking
            entry={zeroedEntry(entry)}
            ghostOpacity={opacity}
            curve={panelCurve}
          />
          {edgeSide && edgeColor && (
            <Surface
              width={Math.max(0.009, entry.size.width * 0.016)}
              height={entry.size.height}
              radius={0.004}
              color={edgeColor}
              flat
              opacity={Math.min(1, opacity + 0.4)}
              origin={[
                edgeSide === "left"
                  ? entry.size.width * 0.008
                  : entry.size.width * 0.992,
                -entry.size.height / 2,
              ]}
              z={Z_LAYER_ACCENT}
            />
          )}
          <ClipPlanesContext.Provider value={panelClipPlanes}>
            <PanelOriginYContext.Provider value={ey}>
              {/* A card's self-clip planes are world-space, reconstructed
                  from panelOriginY + its own panel-absolute y — which the
                  group scale has moved. Rather than thread the scale through
                  every mesh, a shrunken ghost falls back to the panel's own
                  clip bounds, the same escape hatch parent-relative landmark
                  panels use (see CardSelfClipContext). */}
              <CardSelfClipContext.Provider value={scale === 1}>
                <StackDepthContext.Provider value={depth + 1}>
                  {primitive.children
                    .filter((child) => !isExtractedComplementary(child, plan))
                    .map((child) => (
                      <PrimitiveDispatcher
                        key={child.id}
                        primitive={child}
                        plan={plan}
                        pageState={ghostPageState}
                        setPage={_noop}
                        primitiveMap={primitiveMap}
                      />
                    ))}
                </StackDepthContext.Provider>
              </CardSelfClipContext.Provider>
            </PanelOriginYContext.Provider>
          </ClipPlanesContext.Provider>
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
   * When set, renders as a translucent, dimmed carousel "ghost" preview
   * panel (an adjacent page) instead of the normal opaque matte card.
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
  const DEPTH = 0.01;
  const RADIUS = Math.min(0.004, Math.min(w, h, DEPTH) / 2 - 0.001);
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
    [activeCurve, w, h, bentPivotX, theme.panelGradientTop, theme.panelGradientBottom],
  );

  // Curved variant: a segmented bent plane fill + a bent gradient wash (the
  // flat RoundedBox can't wrap onto the cylinder). Rounded corners are traded
  // for the arc — see makeBentPlane / the curved-panels design notes.
  if (activeCurve) {
    return (
      <>
        <mesh geometry={bentFill!} position={[w / 2, -h / 2, -0.0006]}>
          <meshStandardMaterial
            color={theme.panelBg}
            transparent={isGhost}
            opacity={isGhost ? ghostOpacity : 1}
            roughness={0.85}
            metalness={0}
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
  return (
    <>
      <RoundedBox
        args={[w, h, DEPTH]}
        radius={RADIUS}
        position={[w / 2, -h / 2, -DEPTH / 2]}
      >
        <meshStandardMaterial
          color={theme.panelBg}
          transparent={isGhost}
          opacity={isGhost ? ghostOpacity : 1}
          roughness={0.85}
          metalness={0}
        />
      </RoundedBox>

      {/* Subtle vertical gradient wash — panelGradientBottom matches panelBg
          exactly so the seam against the flat fill above is invisible; only
          the top portion reads lighter, matching Meta's panel material. */}
      <PanelGradientOverlay
        width={w}
        height={h}
        position={[w / 2, -h / 2, 0.0005]}
        topColor={theme.panelGradientTop}
        bottomColor={theme.panelGradientBottom}
      />
    </>
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
        <meshStandardMaterial
          color={theme.panelBg}
          roughness={0.85}
          metalness={0}
        />
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

