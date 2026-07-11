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
  PanelOriginYContext,
  PanelCurveContext,
  usePanelCurve,
  resolveCurveRadius,
  curvePoint,
  makeBentPlane,
  CAROUSEL_GHOST_CURVE_SCALE,
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
  // and becomes the cylinder origin (its group stays at the flat slot position).
  // A NESTED paginating container (curveRadius 0) inherits the parent cylinder:
  // its group is tangent-placed on that cylinder, and it re-centres a fresh
  // curve on its own width so its panel-relative children bend correctly.
  const inheritedCurve = usePanelCurve();
  const ownRadius = resolveCurveRadius(entry.curveRadius);
  const subtreeRadius = ownRadius ?? inheritedCurve?.radius ?? null;
  const panelCurve: PanelCurve | null = subtreeRadius
    ? { radius: subtreeRadius, centerX: entry.size.width / 2 }
    : null;

  const ex0 = entry.position.x;
  const ey0 = entry.position.y;
  const ez0 = entry.position.z + stackZ(depth);
  let ex = ex0;
  let ey = ey0;
  let ez = ez0;
  let yaw = entry.rotation.y;
  if (inheritedCurve && !ownRadius) {
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

  const panelClipPlanes = useMemo(
    () => buildPanelClipPlanes(ey, entry.size.height),
    [ey, entry.size.height],
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
            <PanelOriginYContext.Provider value={ey}>
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
}: {
  primitive: XRPrimitive;
  plan: LayoutPlan;
  entry: LayoutEntry;
  targetPage: number;
  primitiveMap: Map<string, XRPrimitive>;
  opacity: number;
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

  // Ghost previews curve on their own, flatter cylinder so the off-axis side
  // panels don't read as oddly over-curved next to the head-on main panel.
  const ghostRadius = resolveCurveRadius(entry.curveRadius);
  const panelCurve: PanelCurve | null = ghostRadius
    ? {
        radius: ghostRadius * CAROUSEL_GHOST_CURVE_SCALE,
        centerX: entry.size.width / 2,
      }
    : null;

  const panelClipPlanes = React.useMemo(
    () => buildPanelClipPlanes(ey, entry.size.height),
    [ey, entry.size.height],
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
      <group position={[ex, ey, ez]} rotation={rot} raycast={() => null}>
        <PanelCurveContext.Provider value={panelCurve}>
          <PanelBacking
            entry={zeroedEntry(entry)}
            ghostOpacity={opacity}
            curve={panelCurve}
          />
          <ClipPlanesContext.Provider value={panelClipPlanes}>
            <PanelOriginYContext.Provider value={ey}>
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
        onClick={() => onPageChange(Math.max(firstPage, currentPage - 1))}
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
        onClick={() => onPageChange(Math.min(lastPage, currentPage + 1))}
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

