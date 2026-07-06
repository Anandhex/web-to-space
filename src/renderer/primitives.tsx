/**
 * primitives.tsx
 *
 * Core XR primitive React Three Fiber components.
 *
 * Rendered primitives (Phase 4 scope — extend in Phase 5+):
 *   XRHeadingMesh     — floating text billboard, level-aware scale
 *   XRParagraphMesh   — multi-line text on a frosted panel
 *   XRSectionMesh     — translucent bounding volume + title bar
 *   XRNavigationMesh  — arc-curved strip of link chips
 *   XRMediaMesh       — video/audio player panel
 *
 * Design decisions
 * ────────────────
 * • All geometry is in metres (WebXR coordinate system).
 * • Text is rendered via @react-three/drei <Text> (troika-three-text),
 *   which handles word-wrap and GPU SDF text natively in WebGL/XR.
 * • Panels use the flat <Surface> primitive (rounded-rect ShapeGeometry) for
 *   Horizon OS card aesthetics: generous depth-independent corners plus an
 *   optional MultiGradientUI top-lighter gradient. All panels share one
 *   monotonic Z-depth ladder + renderOrder scheme (see constants) so
 *   near-coplanar transparent content never bleeds through under THREE's
 *   unstable transparent-sort.
 * • Every primitive receives its resolved position/size from LayoutEntry
 *   (not from SpatialPlacement) — the renderer always applies the plan.
 * • Components are intentionally stateless. Interaction state (hover,
 *   focus, selected) is managed by the parent XRSceneRenderer via a
 *   shared context and passed down as props.
 *
 * Colour system
 * ─────────────
 * Meta Horizon UI Set palette — light theme (see constants below):
 *   panel bg    #FFFFFF  (white backplate)
 *   panel rim   #D8D8DE  (soft grey border)
 *   heading     #1C1B1F  (near-black, high contrast)
 *   body        #49454F  (muted grey)
 *   accent      #0082FB  (Meta brand blue — navigation, interactive)
 *   media bg    #0B0C0F  (nearly black behind video — unchanged across themes)
 *   nav bg      #F3F3F6  (recedes slightly behind white content panels)
 */

import React, { useRef, useContext, createContext } from "react";
import { Text } from "@react-three/drei";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";

// ─────────────────────────────────────────────────────────────
// Panel clipping context
// ─────────────────────────────────────────────────────────────

/**
 * Provides THREE.Plane clipping planes to all descendant mesh materials.
 *
 * Set by XRContentPanel (and XRSectionMesh when it acts as a viewport)
 * to clip child geometry that would overflow the panel boundary.
 *
 * The planes are in WORLD space — Three.js applies them after the model
 * matrix transform, so the panel's own world position must be factored in
 * by the provider (see XRSceneRenderer: buildPanelClipPlanes).
 *
 * An empty array means "no clipping active" (default).
 */
export const ClipPlanesContext = createContext<THREE.Plane[]>([]);

/** Convenience hook — returns the current clip planes (may be empty). */
export function useClipPlanes(): THREE.Plane[] {
  return useContext(ClipPlanesContext);
}

/**
 * World-space Y of the enclosing XRContentPanel's own top edge (its
 * entry.position.y). Clipping planes are always evaluated in world space,
 * but descendant entries (list items, paragraphs, ...) carry panel-relative
 * ("panel-absolute") positions — this lets a descendant reconstruct its own
 * world-space Y bounds (panelOriginY + entry.position.y) without needing to
 * decode it back out of an upstream Plane's constant.
 */
export const PanelOriginYContext = createContext<number>(0);

import type {
  XRHeading,
  XRParagraph,
  XRSection,
  XRNavigationBar,
  XRMediaPlayer,
  XRLink,
} from "../mapper/types";
import type { LayoutEntry } from "../layout/types";
import type { RenderMetrics } from "../layout/types";
import {
  LIST_ITEM_LABEL_TOP_INSET,
  LIST_ITEM_PROSE_INSET,
  mergeAdjacentTextRuns,
  isInlinePrimitive,
  flattenInlineWrappers,
} from "../layout/utils";

// ─────────────────────────────────────────────────────────────
// Render metrics context
// ─────────────────────────────────────────────────────────────

/**
 * Provides the SAME RenderMetrics object the layout engine used to compute
 * estimateHeight() for this scene.
 *
 * Why this exists: components in this file used to keep their own hardcoded
 * font-size/line-height constants (e.g. a local `headingFontSize()` lookup)
 * that were meant to "match" RenderMetrics but lived as a separate, hand
 * maintained table. The two tables drifted (e.g. H1 was 0.048 in
 * RenderMetrics.heading but 0.068 in the local table), so the layout engine
 * would reserve space for a 1-line heading while the renderer actually drew
 * text ~40% larger — causing the heading to wrap to extra lines that were
 * never budgeted for, overlapping whatever was stacked below it.
 *
 * Mounted once near the Canvas root in XRSceneRenderer (see
 * RenderMetricsContext.Provider there) using the resolved deviceProfile's
 * renderMetrics — the exact object passed into computeLayoutPlan. Components
 * MUST read fontSize/lineHeightRatio from here rather than redeclaring their
 * own constants, or this class of bug will reappear.
 */
export const RenderMetricsContext = createContext<RenderMetrics | null>(null);

/**
 * Convenience hook — returns the active RenderMetrics.
 *
 * Throws if no provider is mounted rather than silently falling back to a
 * guessed default, since a silent fallback is exactly the kind of drift
 * this context exists to prevent.
 */
export function useRenderMetrics(): RenderMetrics {
  const metrics = useContext(RenderMetricsContext);
  if (!metrics) {
    throw new Error(
      "useRenderMetrics() called with no RenderMetricsContext.Provider mounted. " +
        "Wrap the scene tree in <RenderMetricsContext.Provider value={deviceProfile.renderMetrics}>.",
    );
  }
  return metrics;
}

// ─────────────────────────────────────────────────────────────
// Text style context (parent-font-metric propagation)
// ─────────────────────────────────────────────────────────────

/**
 * Lets a text-bearing container (currently: XRHeadingMesh) tell its inline
 * descendants (XRTextMesh, XRLinkMesh, XRButtonMesh when used inline) which
 * PrimitiveFontMetrics to render with.
 *
 * Without this, XRText always rendered at metrics.paragraph regardless of
 * its parent — so a heading with mixed inline content (e.g. "<h1>Explore
 * the <strong>web</strong></h1>", which the mapper decomposes into XRText
 * children) would render its text children at small body-text size while
 * estimateHeight() measured those same children using the heading's larger
 * metric. That mismatch is the inline-content counterpart to the
 * headingFontSize() drift fixed via RenderMetricsContext above.
 *
 * `null` means "no override — use the type's own default metric" (e.g.
 * metrics.paragraph for a standalone XRText, metrics.link for a standalone
 * XRLink). Set by a container right before rendering its children; do not
 * set it for containers whose children should keep their own default sizing
 * (e.g. XRParagraph's XRText children correctly want metrics.paragraph).
 */
export const TextStyleContext = createContext<
  RenderMetrics["paragraph"] | null
>(null);

/**
 * Provides the navigate handler to any descendant that needs to handle link
 * clicks — both standalone XRLinkMesh and inline link spans in InlineProseRows.
 * XRSceneGraph provides this; components consume it via useContext.
 */
export const NavigateContext = createContext<((href: string) => void) | null>(
  null,
);

import { CurrentPageContext, FontContext } from "./XRSceneRenderer";
import { useTheme, type XRTheme } from "./theme";

// ─────────────────────────────────────────────────────────────
// Shared geometry constants
// ─────────────────────────────────────────────────────────────
// Colours themselves live in theme.ts (XRTheme) and are read via useTheme()
// so they can be swapped live from a <ThemePanel> — only fixed panel
// geometry (radii/depths, not colour) belongs here.

// Corner radius — soft rounding matching Horizon OS cards.
//
// Horizon OS surfaces are Unity Canvas quads: FLAT rounded rectangles whose
// corner radius is a generous fraction of the surface's shorter edge. The
// old panels used drei <RoundedBox>, whose radius is a 3D bevel constrained
// to `< depth / 2`; with PANEL_DEPTH = 0.01 that hard-capped every corner at
// 5 mm no matter the panel size, so a half-metre panel rounded the same tiny
// amount as a chip and read as a square block — and "pill" buttons weren't
// actually pills. Panels now render through <Surface> (a flat rounded-rect
// ShapeGeometry, see below) whose radius is decoupled from depth, so we can
// use a Horizon-scale radius. PANEL_RADIUS is kept only as a small floor for
// the few remaining legacy <RoundedBox> call sites.
const PANEL_RADIUS = 0.004;
const PANEL_DEPTH = 0.01;

// Horizon rounds ~1/12 of the shorter edge, clamped to a sane metric range so
// large content panels don't turn into lozenges and tiny chips still round
// visibly.
const CORNER_FRACTION = 1 / 12;
const CORNER_MIN = 0.006;
const CORNER_MAX = 0.03;

// ── Z-depth ladder & render order ────────────────────────────────────────────
// A single monotonic stack of depth bands shared by every primitive. All
// panels are near-coplanar in XR (millimetre-scale Z gaps), and troika text +
// transparent image planes rely on THREE's transparent-object sort, which is
// unstable at those gaps — content bled through panels and through each other.
// Two rules fix it and MUST be kept in lockstep:
//   1. Each visual role sits at its own Z band, strictly increasing toward the
//      viewer: surface fill → accent/stripe → content text → image → overlay.
//   2. renderOrder increases the same way, so the draw order is deterministic
//      regardless of camera-distance sort. Never place two different roles at
//      the same (Z, renderOrder).
// Bands are expressed as offsets in front of a surface's front face (z = 0 in
// panel-local space; surfaces themselves are pushed slightly behind via
// Z_SURFACE).
const Z_SURFACE = -0.0006; // panel fill sits just behind the content plane
const Z_SURFACE_RIM = Z_SURFACE - 0.0004; // border peeks out behind the fill
const Z_LAYER_ACCENT = 0.0008; // accent bars / stripes / selection pills
const Z_LAYER_INLINE_TEXT = 0.002; // inline prose runs
const Z_LAYER_BODY_TEXT = 0.0028; // block body text
const Z_LAYER_IMAGE = 0.0034; // image / poster planes
const Z_LAYER_OVERLAY_TEXT = 0.0046; // labels/icons drawn on top of imagery

const RENDER_ORDER_SURFACE = 0;
const RENDER_ORDER_ACCENT = 1;
const RENDER_ORDER_IMAGE = 2;
const RENDER_ORDER_TEXT = 3;

// Flat rounded-rect ShapeGeometry rounds freely, but a degenerate w/h still
// produces NaN corners — floor both to a small safe minimum.
const MIN_DIM = PANEL_RADIUS * 2 + 0.001; // 0.025 m — safe floor for w and h

/** Clamp a layout dimension to a safe minimum. */
function safeDim(v: number): number {
  return Number.isFinite(v) && v > MIN_DIM ? v : MIN_DIM;
}

/**
 * Horizon-scale corner radius for a flat surface of the given size.
 * Depth-independent (unlike safeRadius): a fraction of the shorter edge,
 * clamped, then capped at just under half the shorter edge so a fully-rounded
 * pill (radius = h/2) is still expressible for short/wide controls.
 */
function cornerRadius(
  w: number,
  h: number,
  desired = Math.min(w, h) * CORNER_FRACTION,
): number {
  const capped = Math.min(desired, CORNER_MAX, Math.min(w, h) / 2 - 0.0002);
  return Math.max(CORNER_MIN, Math.min(capped, Math.min(w, h) / 2 - 0.0002));
}

// ─────────────────────────────────────────────────────────────
// Surface — flat rounded-rectangle Horizon card
// ─────────────────────────────────────────────────────────────

/**
 * Build a flat rounded-rectangle THREE.Shape centred at the origin.
 * Corner radius rounds freely (no coupling to any extrusion depth), which is
 * what lets Horizon-scale corners exist at all — see the PANEL_RADIUS note.
 */
function roundedRectShape(w: number, h: number, r: number): THREE.Shape {
  const s = new THREE.Shape();
  const x = -w / 2;
  const y = -h / 2;
  const rr = Math.max(0.0001, Math.min(r, w / 2 - 0.0001, h / 2 - 0.0001));
  s.moveTo(x + rr, y);
  s.lineTo(x + w - rr, y);
  s.quadraticCurveTo(x + w, y, x + w, y + rr);
  s.lineTo(x + w, y + h - rr);
  s.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  s.lineTo(x + rr, y + h);
  s.quadraticCurveTo(x, y + h, x, y + h - rr);
  s.lineTo(x, y + rr);
  s.quadraticCurveTo(x, y, x + rr, y);
  return s;
}

/**
 * Rounded-rect ShapeGeometry with an optional baked vertical gradient
 * (Horizon's MultiGradientUI look — top edge a touch lighter than the body).
 *
 * The gradient is baked into per-vertex colours so it costs no extra draw
 * call and works with troika/standard materials via `vertexColors`. When no
 * gradient is requested the geometry carries no colour attribute and the
 * material's flat `color` shows through unchanged.
 */
function useSurfaceGeometry(
  w: number,
  h: number,
  r: number,
  topColor?: string,
  bottomColor?: string,
): THREE.ShapeGeometry {
  return React.useMemo(() => {
    const geo = new THREE.ShapeGeometry(roundedRectShape(w, h, r), 12);
    if (topColor && bottomColor) {
      const top = new THREE.Color(topColor);
      const bot = new THREE.Color(bottomColor);
      const pos = geo.attributes.position;
      const colors = new Float32Array(pos.count * 3);
      const c = new THREE.Color();
      for (let i = 0; i < pos.count; i++) {
        // y runs -h/2 (bottom) → +h/2 (top); t = 0 at bottom, 1 at top.
        const t = (pos.getY(i) + h / 2) / h;
        c.copy(bot).lerp(top, THREE.MathUtils.clamp(t, 0, 1));
        colors[i * 3] = c.r;
        colors[i * 3 + 1] = c.g;
        colors[i * 3 + 2] = c.b;
      }
      geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    }
    geo.computeBoundingSphere();
    return geo;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [w, h, r, topColor, bottomColor]);
}

/** Lighten a hex colour in HSL space — used to derive a gradient's top stop. */
function liftColor(hex: string, amount = 0.05): string {
  const c = new THREE.Color(hex);
  c.offsetHSL(0, 0, amount);
  return `#${c.getHexString()}`;
}

export interface SurfaceProps {
  /** Panel width/height in metres (already safeDim'd by the caller). */
  width: number;
  height: number;
  /** Corner radius; defaults to the Horizon-scale cornerRadius(w, h). */
  radius?: number;
  /** Flat fill colour (also the gradient's bottom stop when a gradient is on). */
  color: string;
  /** Explicit gradient top stop — enables the MultiGradientUI look. */
  topColor?: string;
  /** Convenience: derive a subtle lighter top stop from `color` automatically. */
  gradient?: boolean;
  opacity?: number;
  roughness?: number;
  metalness?: number;
  /**
   * Render the fill unlit (meshBasicMaterial) so it shows exactly its colour
   * regardless of scene lighting — a truly flat UI-canvas look. Used for
   * buttons/controls that should read as flat solid chips rather than
   * light-shaded cards. roughness/metalness are ignored when set.
   */
  flat?: boolean;
  /** Thin outline drawn just behind the fill. */
  rimColor?: string;
  rimOpacity?: number;
  /**
   * Front-face Z of the fill in panel-local space. Defaults to Z_SURFACE so
   * the fill sits just behind the content plane (z = 0). Callers on the depth
   * ladder should not need to override this.
   */
  z?: number;
  /**
   * Group origin. Panels are laid out top-left, so the default places the
   * centred geometry at [w/2, -h/2] — matching the old <RoundedBox> call
   * sites this replaces. Pass a custom origin for centred controls.
   */
  origin?: [number, number];
  clips?: THREE.Plane[];
}

/**
 * The canonical Horizon OS card surface: a flat, generously-rounded quad with
 * an optional top-lighter gradient and hairline rim, placed on the shared
 * depth ladder. Replaces the per-primitive <RoundedBox> + material stacks so
 * every panel rounds, gradients, and z-orders identically.
 */
export function Surface({
  width,
  height,
  radius,
  color,
  topColor,
  gradient = false,
  opacity = 1,
  roughness = 0.9,
  metalness = 0,
  flat = false,
  rimColor,
  rimOpacity = 0.9,
  z = Z_SURFACE,
  origin,
  clips,
}: SurfaceProps) {
  const w = safeDim(width);
  const h = safeDim(height);
  const r = radius ?? cornerRadius(w, h);
  const ox = origin ? origin[0] : w / 2;
  const oy = origin ? origin[1] : -h / 2;
  const resolvedTop = topColor ?? (gradient ? liftColor(color) : undefined);
  const fillGeo = useSurfaceGeometry(w, h, r, resolvedTop, color);
  const rimGeo = useSurfaceGeometry(w, h, r);

  return (
    <group position={[ox, oy, 0]}>
      {rimColor && (
        <mesh
          geometry={rimGeo}
          position={[0, 0, z + Z_SURFACE_RIM - Z_SURFACE]}
          scale={[(w + 0.0025) / w, (h + 0.0025) / h, 1]}
          renderOrder={RENDER_ORDER_SURFACE}
        >
          <meshBasicMaterial
            color={rimColor}
            transparent
            opacity={rimOpacity}
            clippingPlanes={clips}
          />
        </mesh>
      )}
      <mesh
        geometry={fillGeo}
        position={[0, 0, z]}
        renderOrder={RENDER_ORDER_SURFACE}
      >
        {flat ? (
          <meshBasicMaterial
            color={resolvedTop ? "#ffffff" : color}
            vertexColors={!!resolvedTop}
            transparent={opacity < 1}
            opacity={opacity}
            clippingPlanes={clips}
          />
        ) : (
          <meshStandardMaterial
            color={resolvedTop ? "#ffffff" : color}
            vertexColors={!!resolvedTop}
            transparent={opacity < 1}
            opacity={opacity}
            roughness={roughness}
            metalness={metalness}
            clippingPlanes={clips}
          />
        )}
      </mesh>
    </group>
  );
}

// ─────────────────────────────────────────────────────────────
// Utility
// ─────────────────────────────────────────────────────────────

/**
 * Convert a LayoutEntry into a Three.js position and Euler rotation.
 * All values are already in metres from the layout engine.
 */
function entryTransform(entry: LayoutEntry) {
  const pos = new THREE.Vector3(
    entry.position.x,
    entry.position.y,
    entry.position.z,
  );
  const rot = new THREE.Euler(
    entry.rotation.x,
    entry.rotation.y,
    entry.rotation.z,
    "XYZ",
  );
  return { pos, rot };
}

/**
 * Heading-level to font weight string for troika-three-text.
 *
 * Weight is purely cosmetic (not part of RenderMetrics, doesn't affect
 * word-wrap or height) so it's fine to keep as a local lookup, unlike
 * font size which MUST come from RenderMetrics (see useRenderMetrics).
 */
function headingWeight(level: number): string {
  return level <= 2 ? "700" : level <= 4 ? "600" : "500";
}

/**
 * Resolve a heading level's font metrics from the active RenderMetrics,
 * with the same fallback chain estimateHeight() uses in engine.ts
 * (level → heading[2] → paragraph), so a heading that falls back in the
 * layout engine falls back identically here.
 */
function resolveHeadingMetric(
  level: number,
  metrics: RenderMetrics,
): RenderMetrics["paragraph"] {
  const headingMap = metrics.heading as Partial<
    Record<number, RenderMetrics["paragraph"]>
  >;
  return headingMap[level] ?? headingMap[2] ?? metrics.paragraph;
}

// ─────────────────────────────────────────────────────────────
// Shared hover hook — gentle scale pulse on pointer-over
// ─────────────────────────────────────────────────────────────

function useHoverScale(baseScale = 1.0, hoverScale = 1.015) {
  const ref = useRef<THREE.Group>(null);
  const hovering = useRef(false);
  const current = useRef(baseScale);

  useFrame((_, delta) => {
    if (!ref.current) return;
    const target = hovering.current ? hoverScale : baseScale;
    current.current = THREE.MathUtils.lerp(
      current.current,
      target,
      Math.min(1, delta * 8),
    );
    ref.current.scale.setScalar(current.current);
  });

  const handlers = {
    onPointerOver: () => {
      hovering.current = true;
    },
    onPointerOut: () => {
      hovering.current = false;
    },
  };

  return { ref, handlers };
}

// ─────────────────────────────────────────────────────────────
// ClippedText — troika Text with clipping plane support
// ─────────────────────────────────────────────────────────────

/**
 * Drop-in wrapper around drei <Text> that applies the current ClipPlanesContext
 * to the troika mesh material via onSync.
 *
 * Troika manages its own MeshStandardMaterial internally, so passing
 * clippingPlanes as a JSX prop to a <meshStandardMaterial> child has no effect.
 * The onSync callback fires after troika has built/updated the text mesh and
 * its material, giving us a stable hook to inject clippingPlanes imperatively.
 *
 * All props are forwarded to <Text> transparently.
 */
type TextProps = React.ComponentPropsWithoutRef<typeof Text>;

export function ClippedText(props: TextProps) {
  const clips = useClipPlanes();

  const fontType = useContext(FontContext);

  const handleSync = React.useCallback(
    (mesh: THREE.Mesh) => {
      if (!mesh) return;
      const mat = mesh.material as THREE.Material & {
        clippingPlanes?: THREE.Plane[] | null;
      };
      if (mat) {
        mat.clippingPlanes = clips.length > 0 ? clips : null;
        mat.needsUpdate = true;
      }
      // Also propagate to the onSync the caller may have passed
      if (typeof props.onSync === "function") {
        props.onSync(mesh);
      }
    },
    // clips array reference changes when planes change; stringify for comparison
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [clips, props.onSync],
  );

  return <Text {...props} font={fontType} onSync={handleSync} />;
}

// ─────────────────────────────────────────────────────────────
// 1. XRHeadingMesh
// ─────────────────────────────────────────────────────────────

export interface XRHeadingMeshProps {
  primitive: XRHeading;
  entry: LayoutEntry;
  renderChild: (primitiveId: string) => React.ReactNode;
}

/**
 * Floating text billboard for headings.
 *
 * Renders the heading as a world-space troika Text node with no backing panel
 * for H1–H2 (they stand alone as large anchors) and a subtle underline
 * accent bar for H3–H6.
 *
 * The text is anchored top-left so vertical stacking from the layout engine
 * is consistent: position.y is the top edge of the text.
 */
export function XRHeadingMesh({
  primitive,
  entry,
  renderChild,
}: XRHeadingMeshProps) {
  const { pos, rot } = entryTransform(entry);
  const clips = useClipPlanes();
  const theme = useTheme();
  const metrics = useRenderMetrics();
  const headingMetric = resolveHeadingMetric(primitive.level, metrics);
  const fontSize = headingMetric.fontSize;
  const showAccent = primitive.level >= 3;

  const hasTextChildren = primitive.children.some(
    (child) =>
      child.type === "XRText" ||
      child.type === "XRLink" ||
      child.type === "XRButton",
  );
  if (hasTextChildren) {
    // Inline children (XRText, XRLink) are flowed as a prose run — they are
    // NOT dispatched through renderChild/PrimitiveDispatcher since the engine
    // does not stamp plan entries for inline children of inline-owning nodes.
    const flattened = flattenInlineWrappers(
      mergeAdjacentTextRuns(primitive.children as any[]) as any[],
    );
    const rows = buildInlineRows(flattened);
    return (
      <group position={pos} rotation={rot}>
        <InlineProseRows
          rows={rows}
          startY={0}
          panelWidth={entry.size.width}
          fontSize={fontSize}
          lineHeightRatio={headingMetric.lineHeightRatio}
          xInset={0}
          renderChild={renderChild}
        />
      </group>
    );
  }

  return (
    <group position={pos} rotation={rot}>
      <ClippedText
        anchorX="left"
        anchorY="top"
        position={[0, 0, 0.001]}
        fontSize={fontSize}
        color={theme.headingCol}
        font={undefined}
        fontWeight={headingWeight(primitive.level)}
        maxWidth={entry.size.width}
        lineHeight={headingMetric.lineHeightRatio}
        letterSpacing={-0.01}
        outlineWidth={0}
      >
        {primitive.content ?? primitive.label ?? ""}
      </ClippedText>

      {/* Accent underline for H3+ */}
      {showAccent && (
        <mesh position={[entry.size.width * 0.5, -fontSize * 1.35, 0]}>
          <planeGeometry args={[entry.size.width, 0.002]} />
          <meshBasicMaterial
            color={theme.accentCol}
            transparent
            opacity={0.5}
            clippingPlanes={clips}
          />
        </mesh>
      )}
      {primitive.children.map((child) => renderChild(child.id))}
    </group>
  );
}

// ─────────────────────────────────────────────────────────────
// Shared inline prose utilities
// Used by XRParagraphMesh and XRListItemMesh — must stay in sync
// with engine.ts's estimateInlineFlowHeight + flattenInlineWrappers.
// ─────────────────────────────────────────────────────────────

type TextSeg = { kind: "text"; text: string; bold?: boolean; italic?: boolean };
type LinkSeg = { kind: "link"; text: string; href?: string | null };
export type InlineSeg = TextSeg | LinkSeg;

export type InlineRow =
  | { kind: "inline"; segments: InlineSeg[] }
  | { kind: "block"; childId: string };

/**
 * Convert a flat list of XR primitives (after flattenInlineWrappers +
 * mergeAdjacentTextRuns) into alternating rows of inline segments and
 * block slots. Every XRText/XRLink/XRButton becomes a segment; everything
 * else forces a block row rendered via renderChild.
 */
export function buildInlineRows(children: any[]): InlineRow[] {
  const rows: InlineRow[] = [];
  let currentSegs: InlineSeg[] = [];

  const flush = (): void => {
    if (currentSegs.length === 0) return;
    rows.push({ kind: "inline", segments: currentSegs });
    currentSegs = [];
  };

  for (const child of children) {
    if (isInlinePrimitive(child.type)) {
      const text: string = child.text ?? child.label ?? child.content ?? "";
      if (child.type === "XRLink") {
        currentSegs.push({ kind: "link", text, href: child.href ?? null });
      } else {
        // Bold/italic can come from a single componentType ("b"/"strong"/
        // "i"/"em") or from an accumulated styleTags stack (e.g. ["i","b"]
        // for <i><b>…</b></i>, where componentType alone can't represent
        // two simultaneous styles). OR both signals in, same as XRTextMesh.
        const componentType = child.componentType ?? null;
        const styleTags: string[] = child.styleTags ?? [];
        const bold =
          componentType === "strong" ||
          componentType === "b" ||
          styleTags.includes("strong") ||
          styleTags.includes("b");
        const italic =
          componentType === "em" ||
          componentType === "i" ||
          styleTags.includes("em") ||
          styleTags.includes("i");
        currentSegs.push({
          kind: "text",
          text,
          ...(bold ? { bold: true } : {}),
          ...(italic ? { italic: true } : {}),
        });
      }
    } else {
      flush();
      rows.push({ kind: "block", childId: child.id });
    }
  }
  flush();
  return rows;
}

/**
 * Build the joined string + troika colorRanges for one inline row.
 *
 * Color is the only per-character styling troika's <Text colorRanges>
 * supports — there is no equivalent per-character ranging for fontWeight/
 * fontStyle, so bold/italic spans can't be drawn heavier or slanted within
 * a single mesh. Instead, styled (bold/italic) text segments are given the
 * theme's emphasisCol instead of the muted bodyCol, so they still stand
 * out from plain prose on the same line without forcing a line break.
 */
export function buildRowMeta(
  segments: InlineSeg[],
  theme: XRTheme,
  forceColor?: number,
): {
  text: string;
  colorRanges: Record<number, number> | null;
} {
  let text = "";
  const colorRanges: Record<number, number> = {};
  let hasColor = false;

  const accentHex = parseInt(theme.accentCol.replace("#", ""), 16);
  const bodyHex = parseInt(theme.bodyCol.replace("#", ""), 16);
  const emphasisHex = parseInt(theme.emphasisCol.replace("#", ""), 16);

  const colorForSegment = (seg: InlineSeg): number => {
    if (seg.kind === "link") return accentHex;
    if (seg.kind === "text" && (seg.bold || seg.italic)) return emphasisHex;
    return bodyHex;
  };

  let prevColor: number | null = null;
  for (let si = 0; si < segments.length; si++) {
    const seg = segments[si];
    const charStart = text.length;
    text += seg.text;

    const color = forceColor !== undefined ? forceColor : colorForSegment(seg);
    if (color !== prevColor) {
      colorRanges[charStart] = color;
      hasColor = true;
    }
    prevColor = color;
  }

  // Always seed an explicit entry at character 0 once colorRanges is used.
  // Troika's <Text colorRanges> applies the `color` prop as the default for
  // any uncovered leading span, but only once the GPU vertex-color buffer
  // has been (re)synced for that exact range layout. Rows whose first
  // segment's color wasn't written above (shouldn't happen given the loop
  // always writes charStart === 0 on the first iteration, but kept as a
  // defensive guard) would otherwise render with a stale/near-black vertex
  // color until troika's next full resync instead of inheriting the
  // intended `color` prop immediately.
  if (hasColor && colorRanges[0] === undefined) {
    colorRanges[0] = bodyHex;
  }

  return { text, colorRanges: hasColor ? colorRanges : null };
}

/**
 * Render a list of InlineRows as React Three Fiber nodes.
 *
 * Uses a local cursorY counter starting at `startY` — no dependency on
 * layout-plan entries. This is correct because:
 *  - For XRListItem children, plan entries use list-local stacked Y values
 *    that assumed the old "one block per child" model, not the prose flow.
 *  - For XRParagraph children, the plan entries after flattenInlineWrappers
 *    may reference IDs of nodes that no longer appear at the top level.
 *
 * xInset shifts all text/underlines right from the group origin (used by
 * XRListItemMesh to apply the card's left padding).
 */
interface InlineProseRowsProps {
  rows: InlineRow[];
  startY: number;
  panelWidth: number;
  fontSize: number;
  lineHeightRatio: number;
  xInset?: number;
  forceColor?: number;
  renderChild: (id: string) => React.ReactNode;
}

export function InlineProseRows({
  rows,
  startY,
  panelWidth,
  fontSize,
  lineHeightRatio,
  xInset = 0,
  renderChild,
  forceColor,
}: InlineProseRowsProps) {
  const navigate = useContext(NavigateContext);
  const theme = useTheme();
  const lineH = fontSize * lineHeightRatio;
  const usableWidth = panelWidth - xInset;
  // cursorY is mutated during render — intentional, single render pass.
  let cursorY = startY;
  // Approx average char width for Roboto as a fraction of fontSize.
  const CHAR_W = 0.52;
  // How many characters fit on one visual line before troika wraps.
  // Used to map charOffset → (visualLine, xInLine) so overlay blocks land
  // on the right wrapped line rather than always at the row's first line.
  const charsPerLine = Math.max(
    1,
    Math.floor(usableWidth / (fontSize * CHAR_W)),
  );

  return (
    <>
      {rows.map((row, i) => {
        if (row.kind === "block") {
          return <group key={`b-${i}`}>{renderChild(row.childId)}</group>;
        }

        const { text, colorRanges } = buildRowMeta(
          row.segments,
          theme,
          forceColor,
        );
        const rowY = cursorY;
        cursorY -= lineH;

        // Transparent overlay blocks for each link segment.
        // charOffset tracks how many characters precede the current segment;
        // dividing by charsPerLine gives the approximate visual line so the
        // overlay Y is correct even when the merged text has wrapped.
        const linkHits: React.ReactNode[] = [];
        if (navigate) {
          let charOffset = 0;
          for (let si = 0; si < row.segments.length; si++) {
            const seg = row.segments[si];
            if (seg.kind === "link" && seg.href) {
              const visualLine = Math.floor(charOffset / charsPerLine);
              const xInLine = charOffset % charsPerLine;
              const hitX = xInset + xInLine * fontSize * CHAR_W;
              const hitY = rowY - visualLine * lineH;
              const hitW = Math.min(
                Math.max(seg.text.length * fontSize * CHAR_W, 0.02),
                usableWidth - xInLine * fontSize * CHAR_W,
              );
              const href = seg.href;
              linkHits.push(
                <mesh
                  key={`lh-${si}`}
                  position={[hitX + hitW / 2, hitY - lineH / 2, 0.004]}
                  onClick={(e) => {
                    e.stopPropagation();
                    navigate(href);
                  }}
                >
                  <planeGeometry args={[hitW, lineH]} />
                  <meshBasicMaterial
                    transparent
                    opacity={0}
                    depthWrite={false}
                  />
                </mesh>,
              );
            }
            charOffset += seg.text.length;
          }
        }

        return (
          <group key={`il-${i}`}>
            <ClippedText
              anchorX="left"
              {...(colorRanges ? ({ colorRanges } as any) : {})}
              anchorY="top"
              position={[xInset, rowY, Z_LAYER_INLINE_TEXT]}
              renderOrder={RENDER_ORDER_TEXT}
              fontSize={fontSize}
              color={theme.bodyCol}
              maxWidth={usableWidth}
              lineHeight={lineHeightRatio}
              letterSpacing={0.005}
              overflowWrap="break-word"
            >
              {text}
            </ClippedText>
            {linkHits}
          </group>
        );
      })}
    </>
  );
}

// ─────────────────────────────────────────────────────────────
// 2. XRParagraphMesh
// ─────────────────────────────────────────────────────────────

export interface XRParagraphMeshProps {
  primitive: XRParagraph;
  entry: LayoutEntry;
  renderChild: (primitiveId: string) => React.ReactNode;
  /** Returns the layout entry for a direct child by id, or null if not found. */
  getChildEntry?: (childId: string) => LayoutEntry | null;
}

/**
 * Multi-line body text rendered on a matte beveled panel.
 *
 * Dense paragraphs (densityScore > 0.6) receive a slightly larger panel
 * with a faint top-edge glow to signal long-form reading mode.\
 * Short snippets (≤ 10 words) skip the backing panel entirely.
 */
export function XRParagraphMesh({
  primitive,
  entry,
  renderChild,
  getChildEntry,
}: XRParagraphMeshProps) {
  const { pos, rot } = entryTransform(entry);
  const clips = useClipPlanes();
  const theme = useTheme();
  const w = safeDim(entry.size.width);
  const h = safeDim(entry.size.height);
  const metrics = useRenderMetrics();

  // FIX: flatten transparent XRGenericPanel wrappers (e.g. a <span title="…">
  // around a link/text run) BEFORE checking for inline content. Previously
  // this check ran against the unflattened `primitive.children`, so a
  // paragraph whose only "inline-looking" content was wrapped one level
  // deeper (XRGenericPanel → XRLink) registered as having zero inline
  // children, skipped the InlineProseRows flow path entirely, and fell
  // through to the block-stacked fallback below.
  const flatForInlineCheck = flattenInlineWrappers(primitive.children ?? []);
  const hasAnyInlineChild = flatForInlineCheck.some((c) =>
    isInlinePrimitive(c.type),
  );
  // ── Mixed / pure-inline children: flow layout ────────────────────────────
  // Merge adjacent plain-text XRText siblings so fragmented runs like
  //   ["This page was last edited on ", "20 June 2026", " (UTC)."]
  // collapse into one <Text> call with the correct word-count.
  //
  // Scan the merged list left-to-right:
  //   • Consecutive inline primitives (XRText, XRLink, XRButton) are
  //     accumulated into a single text string and rendered as one <Text>
  //     node anchored top-left at the current cursor Y.
  //   • Block primitives (XRImage, XRFigure, or any unknown type) flush
  //     the current inline run, then render the block via renderChild at
  //     the cursor Y so it gets the block's layout-plan position.
  if (hasAnyInlineChild) {
    const mergedChildren = mergeAdjacentTextRuns(flatForInlineCheck);
    const rows = buildInlineRows(mergedChildren);
    const m = metrics.paragraph;

    return (
      <group position={pos} rotation={rot}>
        <InlineProseRows
          rows={rows}
          startY={-m.verticalPadding / 2}
          panelWidth={w}
          fontSize={m.fontSize}
          lineHeightRatio={m.lineHeightRatio}
          renderChild={renderChild}
        />
      </group>
    );
  }

  const skipPanel = primitive.wordCount <= 10;

  return (
    <group position={pos} rotation={rot}>
      {/* Backing panel — flat Horizon card with a subtle top-lighter gradient */}
      {!skipPanel && (
        <Surface
          width={w}
          height={h}
          color={theme.panelBg}
          gradient
          clips={clips}
        />
      )}

      {/* Body text - only render content directly if no text children */}
      <ClippedText
        anchorX="left"
        anchorY="top"
        position={[0.02, -0.018, Z_LAYER_BODY_TEXT]}
        renderOrder={RENDER_ORDER_TEXT}
        fontSize={0.026}
        color={theme.bodyCol}
        maxWidth={w - 0.04}
        lineHeight={1.55}
        letterSpacing={0.005}
      >
        {primitive.content ?? primitive.label ?? ""}
      </ClippedText>

      {/* Any non-text children (images, lists, etc.) — dispatched as true
          siblings at their own absolute positions; renderOrder on this
          paragraph's own text above ensures it never renders behind a
          same-depth image child regardless of THREE's transparent draw
          order sort. */}
      {primitive.children.map((child) => renderChild(child.id))}
    </group>
  );
}

// ─────────────────────────────────────────────────────────────
// 3. XRSectionMesh
// ─────────────────────────────────────────────────────────────

export interface XRSectionMeshProps {
  primitive: XRSection;
  entry: LayoutEntry;
  /**
   * Resolved child entries for the children visible on the current page.
   * The renderer passes only entries whose pageIndex matches the current page
   * (or all entries when the section fits on one page). Used solely to compute
   * the correct backing panel height — the section must not be taller than
   * its visible content.
   */
  childEntries: LayoutEntry[];
  /** Renderer for child primitives — injected by XRSceneRenderer. */
  renderChild: (primitiveId: string) => React.ReactNode;
  /**
   * True when this section is a mid-section continuation (its first child is
   * on a later page index than the section itself). Drives the top-edge
   * "continued from" accent stripe.
   */
  isContinuation?: boolean;
  /**
   * True when this section overflows onto a subsequent page. Drives the
   * bottom-edge "continues on" accent stripe.
   */
  hasMore?: boolean;
}

/**
 * Translucent bounding panel for a section.
 *
 * Purely a spatial container: draws a frosted backing panel sized to the
 * visible child content and delegates all child rendering to the injected
 * renderChild. Child positions are resolved by the layout engine; this
 * component does not re-layout them.
 *
 * Panel height is derived from childEntries (the current page's visible
 * children) rather than entry.size.height, because entry.size.height is
 * the full section height across all pages. The renderer passes only the
 * entries whose pageIndex matches the current page.
 *
 * Continuation indicators (thin accent stripes) are shown at the top/bottom
 * edges when the section spans multiple pages, driven by the isContinuation
 * and hasMore props computed by the renderer.
 */
export function XRSectionMesh({
  primitive,
  entry,
  childEntries,
  renderChild,
  isContinuation,
  hasMore,
}: XRSectionMeshProps) {
  const { pos, rot } = entryTransform(entry);
  const clips = useClipPlanes();
  const theme = useTheme();
  const w = safeDim(entry.size.width);

  // Panel height = span from the top of the first visible child to the
  // bottom of the last, read from their real engine-assigned positions —
  // not reconstructed from hardcoded padding/gap constants, which drift out
  // of sync with the engine's actual values (e.g. when a nested section's
  // own top/bottom padding is zero) and leave a dead gap or an oversized box.
  const visibleHeight =
    childEntries.length > 0
      ? childEntries[0].position.y -
        (childEntries[childEntries.length - 1].position.y -
          childEntries[childEntries.length - 1].size.height)
      : entry.size.height;

  const h = safeDim(visibleHeight);

  return (
    <group position={pos} rotation={rot}>
      {/* Section backing — a single flat fill. Sections nest inside the main
          content panel (which already carries the border/gradient "hero"
          treatment — see PanelBacking), so every section does NOT repeat
          that same border+gradient+highlight stack: a document with a dozen
          short sections on one page previously stacked a dozen near-
          identical 4-layer glass slabs at nearly the same Z depth, reading
          as a solid "brick" when viewed edge-on. One flat layer per section
          keeps nested containers visually quiet and avoids that compounding. */}
      <Surface width={w} height={h} color={theme.panelBg} clips={clips} />

      {/* "Continued from previous page" top edge indicator */}
      {isContinuation && (
        <mesh
          position={[w / 2, -0.001, Z_LAYER_ACCENT]}
          renderOrder={RENDER_ORDER_ACCENT}
        >
          <planeGeometry args={[w * 0.4, 0.003]} />
          <meshBasicMaterial
            color={theme.accentCol}
            transparent
            opacity={0.5}
            clippingPlanes={clips}
          />
        </mesh>
      )}

      {primitive.children.map((child) => renderChild(child.id))}
    </group>
  );
}

// ─────────────────────────────────────────────────────────────
// 4. XRNavigationMesh
// ─────────────────────────────────────────────────────────────

export interface XRNavigationMeshProps {
  primitive: XRNavigationBar;
  entry: LayoutEntry;
  onNavigate?: (href: string) => void;
}

interface TOCPanelProps {
  items: XRLink[];
  w: number;
  h: number;
  pos: THREE.Vector3;
  rot: THREE.Euler;
  label: string;
  clips: THREE.Plane[];
  onNavigate?: (href: string) => void;
}

/**
 * Scrollable vertical table-of-contents panel.
 *
 * The item list can exceed the panel height, so items live in a group whose Y
 * is driven by a `scroll` offset and are clipped to a fixed viewport region
 * below the header via world-space horizontal clip planes. Scrolling is driven
 * by wheel input in the inline preview; the same setScroll is where an XR
 * controller thumbstick would hook in. A thin scrollbar on the right edge
 * signals position and only appears when the content actually overflows.
 *
 * The clip planes are world-space horizontal (normal along Y). This stays
 * correct while the panel is only yawed to face the user (a Y-axis rotation
 * leaves world-Y aligned with the panel's vertical axis); a pitched/rolled
 * panel would need panel-local planes instead.
 */
function TOCPanel({
  items,
  w,
  h,
  pos,
  rot,
  label,
  clips,
  onNavigate,
}: TOCPanelProps) {
  const theme = useTheme();

  const ITEM_H = 0.052;
  const ITEM_GAP = 0.006;
  const INDENT_STEP = 0.018; // metres per depth level
  const PADDING = 0.014;
  const HEADER_H = PADDING * 3; // label band above the scroll viewport
  const BOTTOM_PAD = PADDING;

  const step = ITEM_H + ITEM_GAP;
  const contentTop = -HEADER_H; // local Y of the scroll viewport's top edge
  const visibleH = Math.max(step, h - HEADER_H - BOTTOM_PAD);
  const totalH = items.length * step;
  const maxScroll = Math.max(0, totalH - visibleH);
  const scrollable = maxScroll > 1e-6;

  const [scroll, setScroll] = React.useState(0);
  // Re-clamp if the content or viewport size changes out from under us.
  React.useEffect(() => {
    setScroll((s) => THREE.MathUtils.clamp(s, 0, maxScroll));
  }, [maxScroll]);

  // Clip planes bounding the scroll viewport (header bottom → panel bottom).
  //
  // They MUST be derived from the panel's real world transform, which is NOT
  // available as `pos` here: this mesh receives a zeroedEntry() (pos = rot = 0)
  // while an outer <AtPos> applies the true world position/rotation. So instead
  // of hardcoding a world Y, we keep two stable Plane instances, define them in
  // the panel's LOCAL frame, and re-project them through the group's
  // matrixWorld every frame (mutated in place — troika/standard materials
  // already hold these instances, so they pick up the update with no
  // re-render). This is also correct under arbitrary yaw/pitch.
  const groupRef = React.useRef<THREE.Group>(null);
  const clipPlanes = React.useMemo(
    () => [
      new THREE.Plane(new THREE.Vector3(0, -1, 0), 0), // keep y ≤ viewport top
      new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), // keep y ≥ viewport bottom
    ],
    [],
  );
  const itemClips = React.useMemo(
    () => [...clips, ...clipPlanes],
    [clips, clipPlanes],
  );
  // Local-frame viewport bounds (fixed; items scroll within this band).
  const topLocalY = contentTop;
  const bottomLocalY = -(h - BOTTOM_PAD);
  useFrame(() => {
    const g = groupRef.current;
    if (!g) return;
    // Force the world matrix current regardless of where useFrame sits relative
    // to the renderer's own matrix update (matters in the XR animation loop and
    // on the very first frame).
    g.updateWorldMatrix(true, false);
    const m = g.matrixWorld;
    clipPlanes[0].set(new THREE.Vector3(0, -1, 0), topLocalY);
    clipPlanes[0].applyMatrix4(m);
    clipPlanes[1].set(new THREE.Vector3(0, 1, 0), -bottomLocalY);
    clipPlanes[1].applyMatrix4(m);
  });

  const handleWheel = React.useCallback(
    (e: { deltaY: number; stopPropagation: () => void }) => {
      if (!scrollable) return;
      e.stopPropagation();
      setScroll((s) =>
        THREE.MathUtils.clamp(s + e.deltaY * 0.0002, 0, maxScroll),
      );
    },
    [scrollable, maxScroll],
  );

  // Drag-to-scroll: press and drag the panel up/down. Works with a mouse in
  // the flat preview AND an XR controller ray (both surface as R3F pointer
  // events), so it's the primary, discoverable scroll gesture — the wheel is a
  // convenience on top. Grab-style: content follows the pointer (drag down →
  // earlier items). Screen-Y based, so the factor is approximate and tuned for
  // a panel at typical reading distance.
  const { gl } = useThree();
  const dragging = React.useRef(false);
  const lastPointerY = React.useRef(0);
  // Set once a drag actually moves, so the item under the pointer can suppress
  // its click on release (drag-to-scroll must not also navigate).
  const didDrag = React.useRef(false);

  const handleDragStart = React.useCallback(
    (e: any) => {
      if (!scrollable) return;
      e.stopPropagation();
      dragging.current = true;
      didDrag.current = false;
      lastPointerY.current = e.clientY ?? e.nativeEvent?.clientY ?? 0;
      gl.domElement.setPointerCapture?.(e.pointerId);
    },
    [scrollable, gl],
  );
  const handleDragMove = React.useCallback(
    (e: any) => {
      if (!dragging.current) return;
      const y = e.clientY ?? e.nativeEvent?.clientY ?? 0;
      const dy = y - lastPointerY.current;
      if (Math.abs(dy) > 1) didDrag.current = true;
      lastPointerY.current = y;
      setScroll((s) => THREE.MathUtils.clamp(s - dy * 0.0016, 0, maxScroll));
    },
    [maxScroll],
  );
  const handleDragEnd = React.useCallback(
    (e: any) => {
      dragging.current = false;
      gl.domElement.releasePointerCapture?.(e.pointerId);
    },
    [gl],
  );

  // Scrollbar geometry.
  const trackX = w - PADDING * 0.45;
  const thumbH = Math.max(
    0.02,
    visibleH * (visibleH / Math.max(totalH, visibleH)),
  );
  const thumbTravel = visibleH - thumbH;
  const thumbTop =
    contentTop - (maxScroll > 0 ? (scroll / maxScroll) * thumbTravel : 0);

  return (
    <group ref={groupRef} position={pos} rotation={rot}>
      {/* Panel backing — uses panelBg (identical to the XRContentPanel) so the
          TOC/nav reads as the same panel material as the main content, not a
          distinct surface. navBg is reserved for the small item chips. */}
      <Surface width={w} height={h} color={theme.panelBg} clips={clips} />

      {/* Panel label (fixed header, not scrolled) */}
      <ClippedText
        anchorX="left"
        anchorY="top"
        position={[PADDING, -PADDING, Z_LAYER_BODY_TEXT]}
        fontSize={0.014}
        color={theme.bodyCol}
        fontWeight="700"
        letterSpacing={0.08}
      >
        {label.toUpperCase()}
      </ClippedText>

      {/* Transparent scroll-capture surface over the viewport. Sits in front
          of the backing but behind the item rows, so item clicks still win for
          navigation while wheel + drag events (which the rows don't handle)
          fall through to here. */}
      <mesh
        position={[w / 2, contentTop - visibleH / 2, Z_LAYER_ACCENT]}
        onWheel={handleWheel as any}
        onPointerDown={handleDragStart}
        onPointerMove={handleDragMove}
        onPointerUp={handleDragEnd}
        onPointerLeave={handleDragEnd}
      >
        <planeGeometry args={[w, visibleH]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} />
      </mesh>

      {/* Scrolling item rows, clipped to the viewport */}
      <ClipPlanesContext.Provider value={itemClips}>
        <group position={[0, scroll, 0]}>
          {items.map((item, i) => {
            const itemY = contentTop - i * step;
            const indent = PADDING + (item.depth ?? 0) * INDENT_STEP;
            const isCurrent = item.isCurrent;
            const itemW = w - indent - PADDING;

            return (
              <group
                key={item.id}
                position={[indent, itemY, Z_LAYER_INLINE_TEXT]}
                onClick={() => {
                  // Suppress navigation if this "click" was the end of a drag.
                  if (didDrag.current) {
                    didDrag.current = false;
                    return;
                  }
                  if (item.href) onNavigate?.(item.href);
                }}
              >
                {/* Hit-area plane for easier pointing */}
                <mesh position={[itemW / 2, -ITEM_H / 2, 0.0005]}>
                  <planeGeometry args={[itemW, ITEM_H]} />
                  <meshBasicMaterial
                    transparent
                    opacity={0}
                    depthWrite={false}
                    clippingPlanes={itemClips}
                  />
                </mesh>

                {/* Selected-row highlight — solid, high-contrast rounded pill. */}
                {isCurrent && (
                  <Surface
                    width={itemW + PADDING * 0.6}
                    height={ITEM_H * 0.92}
                    radius={cornerRadius(
                      itemW + PADDING * 0.6,
                      ITEM_H * 0.92,
                      (ITEM_H * 0.92) / 2,
                    )}
                    color={theme.emphasisCol}
                    origin={[itemW / 2 - PADDING * 0.3, -ITEM_H / 2]}
                    clips={itemClips}
                  />
                )}
                <ClippedText
                  anchorX="left"
                  anchorY="top"
                  position={[0, 0, 0.002]}
                  fontSize={item.depth === 0 ? 0.022 : 0.018}
                  color={
                    isCurrent
                      ? theme.panelBg
                      : item.depth === 0
                        ? theme.headingCol
                        : theme.bodyCol
                  }
                  fontWeight={
                    isCurrent ? "700" : item.depth === 0 ? "600" : "400"
                  }
                  maxWidth={itemW}
                  lineHeight={1.3}
                >
                  {item.label ?? ""}
                </ClippedText>
              </group>
            );
          })}
        </group>
      </ClipPlanesContext.Provider>

      {/* Scrollbar (only when content overflows) */}
      {scrollable && (
        <group>
          <mesh position={[trackX, contentTop - visibleH / 2, Z_LAYER_ACCENT]}>
            <planeGeometry args={[0.004, visibleH]} />
            <meshBasicMaterial
              color={theme.panelRim}
              transparent
              opacity={0.4}
            />
          </mesh>
          <mesh position={[trackX, thumbTop - thumbH / 2, Z_LAYER_BODY_TEXT]}>
            <planeGeometry args={[0.004, thumbH]} />
            <meshBasicMaterial
              color={theme.mutedTextCol}
              transparent
              opacity={0.9}
            />
          </mesh>
        </group>
      )}
    </group>
  );
}

/**
 * Arc-curved navigation strip or vertical TOC panel.
 *
 * Layout mode is selected by aspect ratio:
 *   tall + narrow (height > width)  → vertical TOC list with depth indentation
 *   wide + short  (width >= height) → horizontal arc chip strip (site nav)
 *
 * TOC items use item.depth for left-indent so h1/h2 are flush and h3+
 * are progressively indented — matching the dummy-layout TOC behaviour.
 */
export function XRNavigationMesh({
  primitive,
  entry,
  onNavigate,
}: XRNavigationMeshProps) {
  const { pos, rot } = entryTransform(entry);
  const clips = useClipPlanes();
  const theme = useTheme();
  const items: XRLink[] = primitive.items ?? [];
  const w = safeDim(entry.size.width);
  const h = safeDim(entry.size.height);

  const isTOC = h > w;

  // ── Vertical TOC layout — scrollable container ────────────────────────────
  if (isTOC) {
    return (
      <TOCPanel
        items={items}
        w={w}
        h={h}
        pos={pos}
        rot={rot}
        label={primitive.label ?? "Contents"}
        clips={clips}
        onNavigate={onNavigate}
      />
    );
  }

  // ── Horizontal arc chip layout (site nav) ────────────────────────────────
  const CHIP_H = 0.048;
  const CHIP_GAP = 0.012;
  const chipW = Math.max(
    0.025,
    items.length > 0
      ? Math.min(0.28, (w - CHIP_GAP * (items.length + 1)) / items.length)
      : 0.24,
  );

  const arcTotal =
    entry.curveRadius > 0
      ? 2 * Math.asin(Math.min(1, w / (2 * entry.curveRadius)))
      : 0;
  const arcStep = items.length > 1 ? arcTotal / (items.length - 1) : 0;
  const arcStart = -arcTotal / 2;

  return (
    <group position={pos} rotation={rot}>
      {/* Nav panel backing — uses panelBg so it matches the XRContentPanel
          material (navBg stays for the item chips). */}
      <Surface width={w} height={h} color={theme.panelBg} clips={clips} />

      {/* Nav chips */}
      {items.map((item, i) => {
        const chipAngle = arcStart + i * arcStep;
        const chipX =
          entry.curveRadius > 0
            ? entry.curveRadius * Math.sin(chipAngle)
            : CHIP_GAP + i * (chipW + CHIP_GAP);
        const chipZ =
          entry.curveRadius > 0
            ? entry.curveRadius * (1 - Math.cos(chipAngle))
            : 0;
        const isCurrent = item.isCurrent;

        return (
          <group
            key={item.id}
            position={[chipX, -h / 2, chipZ + PANEL_DEPTH * 0.5]}
            rotation={[0, -chipAngle, 0]}
          >
            {/* Chip body — flat pill. Current/active chip uses the same
                monochrome "Primary Button" treatment as XRButtonMesh (solid
                emphasisCol fill, panelBg text) — the Horizon UI Set reserves
                colour (blue/red) for links and destructive actions, not
                general primary controls. Inactive chips get a hairline rim. */}
            <Surface
              width={chipW}
              height={CHIP_H}
              radius={cornerRadius(chipW, CHIP_H, CHIP_H / 2)}
              color={isCurrent ? theme.emphasisCol : theme.navBg}
              gradient={!isCurrent}
              opacity={isCurrent ? 1 : 0.96}
              roughness={isCurrent ? 0.4 : 0.7}
              rimColor={!isCurrent ? theme.panelRim : undefined}
              rimOpacity={0.8}
              origin={[0, 0]}
              clips={clips}
            />

            <ClippedText
              anchorX="center"
              anchorY="middle"
              position={[0, 0, Z_LAYER_BODY_TEXT]}
              fontSize={0.018}
              color={isCurrent ? theme.panelBg : theme.bodyCol}
              maxWidth={chipW - 0.016}
              fontWeight={isCurrent ? "600" : "400"}
            >
              {item.label ?? item.href ?? ""}
            </ClippedText>
          </group>
        );
      })}
    </group>
  );
}

// ─────────────────────────────────────────────────────────────
// 5. XRMediaMesh
// ─────────────────────────────────────────────────────────────

export interface XRMediaMeshProps {
  primitive: XRMediaPlayer;
  entry: LayoutEntry;
}

/**
 * Video / audio player panel.
 *
 * sizingStrategy drives the visual treatment:
 *   "large-panel"    — cinema-scale curved panel with a play icon overlay
 *   "compact-widget" — small audio widget with waveform placeholder
 *   "ambient"        — minimal placeholder (renderer positions it off-axis)
 *
 * For Phase 4 we render a placeholder panel with a play/audio icon and
 * the media label. Actual HTMLVideoElement → VideoTexture wiring is
 * deferred to Phase 5 (requires document.createElement in XR context).
 */
export function XRMediaMesh({ primitive, entry }: XRMediaMeshProps) {
  const { pos, rot } = entryTransform(entry);
  const clips = useClipPlanes();
  const theme = useTheme();
  const w = safeDim(entry.size.width);
  const h = safeDim(entry.size.height);
  const isAudio = primitive.mediaType === "audio";
  // Icon geometry previously used a literal `1` (metre) base unit, completely
  // unscaled to the panel's actual (centimetre-scale) size — reading as an
  // oversized/clipped stub rather than an intentional placeholder. Scale to
  // a fraction of the panel's smaller dimension instead, clamped to a
  // sensible range.
  const ICON_SIZE = Math.min(0.08, Math.max(0.03, Math.min(w, h) * 0.3));

  // Poster/thumbnail background, loaded the same way XRImageMesh loads its
  // texture — makes the placeholder read as a real media widget rather than
  // a flat placeholder color, without wiring up actual playback.
  const proxiedPoster = primitive.poster ? proxyImageSrc(primitive.poster) : "";
  const [posterTexture, setPosterTexture] =
    React.useState<THREE.Texture | null>(null);

  React.useEffect(() => {
    setPosterTexture(null);
    if (!proxiedPoster) return;
    let cancelled = false;
    const loader = new THREE.TextureLoader();
    loader.load(
      proxiedPoster,
      (loaded) => {
        loaded.colorSpace = THREE.SRGBColorSpace;
        if (!cancelled) setPosterTexture(loaded);
      },
      undefined,
      () => {
        // Broken/unreachable poster — leave null so the plain backing
        // panel renders instead.
      },
    );
    return () => {
      cancelled = true;
    };
  }, [proxiedPoster]);

  return (
    <group position={pos} rotation={rot}>
      {/* Backing panel — flat Horizon card (kept dark behind media) */}
      <Surface width={w} height={h} color={theme.mediaBg} clips={clips} />

      {/* Poster thumbnail — sits between the backing panel and the icon
          overlay so the play/audio icon still reads on top of it. */}
      {posterTexture && (
        <mesh
          position={[w / 2, -h / 2, Z_LAYER_IMAGE]}
          renderOrder={RENDER_ORDER_IMAGE}
        >
          <planeGeometry args={[w, h]} />
          <meshBasicMaterial
            map={posterTexture}
            transparent
            clippingPlanes={clips}
          />
        </mesh>
      )}

      {/* Play / audio icon */}
      <group position={[w / 2, -h / 2, Z_LAYER_OVERLAY_TEXT]}>
        {isAudio ? (
          <>
            {[-0.012, 0, 0.012].map((xOff, i) => (
              <mesh
                key={i}
                position={[xOff, 0, 0]}
                renderOrder={RENDER_ORDER_TEXT}
              >
                <boxGeometry
                  args={[0.006, ICON_SIZE * (0.5 + i * 0.3), 0.002]}
                />
                <meshBasicMaterial
                  color={theme.accentCol}
                  transparent
                  opacity={0.85}
                  clippingPlanes={clips}
                />
              </mesh>
            ))}
          </>
        ) : (
          <mesh rotation={[0, 0, 0]} renderOrder={RENDER_ORDER_TEXT}>
            <coneGeometry args={[ICON_SIZE * 0.6, ICON_SIZE, 3, 1]} />
            <meshBasicMaterial
              color={theme.accentCol}
              transparent
              opacity={0.9}
              clippingPlanes={clips}
            />
          </mesh>
        )}
      </group>

      {/* Label */}
      {primitive.label && (
        <ClippedText
          anchorX="center"
          anchorY="top"
          position={[w / 2, -h + 0.03, Z_LAYER_OVERLAY_TEXT]}
          renderOrder={RENDER_ORDER_TEXT}
          fontSize={0.02}
          color={theme.bodyCol}
          maxWidth={w - 0.06}
        >
          {primitive.label}
        </ClippedText>
      )}

      {/* Native video embed for large-panel when src is available */}
      {/* {isLarge && primitive.src && (
        <Html
          transform
          position={[w / 2, -h / 2, PANEL_DEPTH * 2]}
          style={{
            width: `${w * 300}px`,
            height: `${h * 300}px`,
            pointerEvents: "auto",
          }}
          distanceFactor={3}
          occlude
        >
          <video
            src={primitive.src}
            controls
            style={{
              width: "100%",
              height: "100%",
              objectFit: "contain",
              background: theme.mediaBg,
            }}
          />
        </Html>
      )} */}
    </group>
  );
}

// ─────────────────────────────────────────────────────────────
// 6. XRCodeBlockMesh
// ─────────────────────────────────────────────────────────────

export interface XRCodeBlockMeshProps {
  primitive: import("../mapper/types").XRCodeBlock;
  entry: LayoutEntry;
  renderChild: (primitiveId: string) => React.ReactNode;
}

export function XRCodeBlockMesh({
  primitive,
  entry,
  renderChild,
}: XRCodeBlockMeshProps) {
  const { pos, rot } = entryTransform(entry);
  const clips = useClipPlanes();
  const theme = useTheme();
  const w = safeDim(entry.size.width);
  const h = safeDim(entry.size.height);
  const CODE_BG = theme.inputBg;
  const CODE_COL = "#116329";

  // Mirrors XRBlockQuoteMesh: children extracted by the parser (e.g. a
  // synthetic text run, or block-level content) were previously discarded
  // by the mapper (children: [] hardcoded) — now that they're preserved,
  // flow inline children through InlineProseRows and let block-only
  // children be dispatched externally as siblings (see the "XRCodeBlock"
  // case in XRSceneRenderer.tsx) rather than duplicating them here.
  const flatChildren = flattenInlineWrappers(primitive.children ?? []);
  const hasAnyInlineChild = flatChildren.some((c) => isInlinePrimitive(c.type));
  const hasAnyChildren = (primitive.children ?? []).length > 0;
  const rows = hasAnyInlineChild
    ? buildInlineRows(mergeAdjacentTextRuns(flatChildren))
    : [];

  return (
    <group position={pos} rotation={rot}>
      <Surface
        width={w}
        height={h}
        color={CODE_BG}
        rimColor={theme.panelRim}
        clips={clips}
      />

      {/* Left accent stripe */}
      <mesh
        position={[0.005, -h / 2, Z_LAYER_ACCENT]}
        renderOrder={RENDER_ORDER_ACCENT}
      >
        <planeGeometry args={[0.007, h * 0.85]} />
        <meshBasicMaterial
          color={CODE_COL}
          transparent
          opacity={0.75}
          clippingPlanes={clips}
        />
      </mesh>

      {hasAnyInlineChild ? (
        <InlineProseRows
          rows={rows}
          startY={-0.014}
          panelWidth={w - 0.018}
          fontSize={0.02}
          lineHeightRatio={1.6}
          xInset={0.018}
          renderChild={renderChild}
        />
      ) : hasAnyChildren ? null : ( // the caller — render nothing here to avoid duplicating content. // Block-only children are dispatched as true positioned siblings by
        <ClippedText
          anchorX="left"
          anchorY="top"
          position={[0.018, -0.014, Z_LAYER_BODY_TEXT]}
          renderOrder={RENDER_ORDER_TEXT}
          fontSize={0.02}
          color={CODE_COL}
          maxWidth={w - 0.03}
          lineHeight={1.6}
          letterSpacing={0.02}
        >
          {primitive.content ?? primitive.label ?? ""}
        </ClippedText>
      )}
    </group>
  );
}

// ─────────────────────────────────────────────────────────────
// 7. XRBlockQuoteMesh
// ─────────────────────────────────────────────────────────────

export interface XRBlockQuoteMeshProps {
  primitive: import("../mapper/types").XRBlockQuote;
  entry: LayoutEntry;
  renderChild: (primitiveId: string) => React.ReactNode;
}

export function XRBlockQuoteMesh({
  primitive,
  entry,
  renderChild,
}: XRBlockQuoteMeshProps) {
  const { pos, rot } = entryTransform(entry);
  const clips = useClipPlanes();
  const theme = useTheme();
  const w = safeDim(entry.size.width);
  const h = safeDim(entry.size.height);
  const metrics = useRenderMetrics();
  const QUOTE_ACCENT = "#d2a679";

  // Hatnotes (role="note" → XRBlockQuote) arrive with inline children:
  //   [XRText("Main article: "), XRLink("KPop Demon Hunters (soundtrack)")]
  // Without this path XRBlockQuoteMesh rendered only primitive.label
  // ("Main article:") and silently discarded all children — exactly the
  // same leaf-only pattern that bit XRAlertMesh.  Apply the same fix:
  // flatten wrappers → merge adjacent text → flow via InlineProseRows so
  // link segments get accent colouring.
  const flatChildren = flattenInlineWrappers(primitive.children ?? []);
  const hasAnyInlineChild = flatChildren.some((c) => isInlinePrimitive(c.type));
  const hasAnyChildren = (primitive.children ?? []).length > 0;
  const rows = hasAnyInlineChild
    ? buildInlineRows(mergeAdjacentTextRuns(flatChildren))
    : [];
  const m = metrics.blockQuote ?? metrics.paragraph;
  const X_INSET = 0.026;

  return (
    <group position={pos} rotation={rot}>
      <Surface
        width={w}
        height={h}
        color={theme.panelBg}
        gradient
        rimColor={theme.panelRim}
        clips={clips}
      />

      {/* Left quote accent bar */}
      <mesh
        position={[0.006, -h / 2, Z_LAYER_ACCENT]}
        renderOrder={RENDER_ORDER_ACCENT}
      >
        <planeGeometry args={[0.01, h * 0.8]} />
        <meshBasicMaterial
          color={QUOTE_ACCENT}
          transparent
          opacity={0.9}
          clippingPlanes={clips}
        />
      </mesh>

      {hasAnyInlineChild ? (
        // Inline flow: "Main article: " (body colour) + link (accent colour)
        // rendered as a single prose run, matching what the engine measured.
        <InlineProseRows
          rows={rows}
          startY={-0.018}
          panelWidth={w - X_INSET}
          fontSize={m.fontSize}
          lineHeightRatio={m.lineHeightRatio}
          xInset={X_INSET}
          renderChild={renderChild}
        />
      ) : hasAnyChildren ? null : ( // their content via the text fallback below. // XRSceneRenderer.tsx) — render nothing here to avoid duplicating // positioned siblings by the caller (see the "XRBlockQuote" case in // Block-only children (e.g. a wrapped <p>) are dispatched as true
        // Fallback: plain blockquote with no structured children.
        // Use content (full visible string) in preference to label (may be
        // the accessible short-name only, e.g. "Main article:").
        <ClippedText
          anchorX="left"
          anchorY="top"
          position={[X_INSET, -0.018, Z_LAYER_BODY_TEXT]}
          renderOrder={RENDER_ORDER_TEXT}
          fontSize={0.024}
          color="#8B6D3F"
          maxWidth={w - 0.04}
          lineHeight={1.5}
          letterSpacing={0.003}
        >
          {primitive.content ?? primitive.label ?? ""}
        </ClippedText>
      )}
    </group>
  );
}

// ─────────────────────────────────────────────────────────────
// 8. XRSeparatorMesh
// ─────────────────────────────────────────────────────────────

export interface XRSeparatorMeshProps {
  primitive: import("../mapper/types").XRSeparator;
  entry: LayoutEntry;
}

export function XRSeparatorMesh({ primitive, entry }: XRSeparatorMeshProps) {
  const { pos, rot } = entryTransform(entry);
  const clips = useClipPlanes();
  const theme = useTheme();
  const w = safeDim(entry.size.width);
  const h = safeDim(entry.size.height);
  const isHoriz = primitive.orientation !== "vertical";

  return (
    <group position={pos} rotation={rot}>
      <mesh position={[w / 2, -h / 2, 0]}>
        <planeGeometry args={[isHoriz ? w : 0.002, isHoriz ? 0.002 : h]} />
        <meshBasicMaterial
          color={theme.panelRim}
          transparent
          opacity={0.6}
          clippingPlanes={clips}
        />
      </mesh>
    </group>
  );
}

// ─────────────────────────────────────────────────────────────
// 9. XRProgressBarMesh
// ─────────────────────────────────────────────────────────────

export interface XRProgressBarMeshProps {
  primitive: import("../mapper/types").XRProgressBar;
  entry: LayoutEntry;
}

export function XRProgressBarMesh({
  primitive,
  entry,
}: XRProgressBarMeshProps) {
  const { pos, rot } = entryTransform(entry);
  const clips = useClipPlanes();
  const theme = useTheme();
  const w = safeDim(entry.size.width);
  const h = safeDim(entry.size.height);
  const fraction = Math.max(0, Math.min(1, primitive.valueFraction ?? 0));
  const fillW = Math.max(0.001, w * fraction);
  const TRACK_H = Math.min(0.018, h);

  return (
    <group position={pos} rotation={rot}>
      <mesh position={[w / 2, -h / 2, 0]}>
        <planeGeometry args={[w, TRACK_H]} />
        <meshBasicMaterial
          color={theme.panelRim}
          transparent
          opacity={0.5}
          clippingPlanes={clips}
        />
      </mesh>

      {/* Monochrome fill (matches the Horizon UI Set's Slider reference —
          white/light track fill in dark theme, not a blue accent). */}
      <mesh position={[fillW / 2, -h / 2, 0.001]}>
        <planeGeometry args={[fillW, TRACK_H]} />
        <meshBasicMaterial
          color={theme.emphasisCol}
          transparent
          opacity={0.85}
          clippingPlanes={clips}
        />
      </mesh>

      {primitive.label && (
        <ClippedText
          anchorX="left"
          anchorY="bottom"
          position={[0, -h / 2 + TRACK_H / 2 + 0.006, 0.002]}
          fontSize={0.018}
          color={theme.bodyCol}
          maxWidth={w}
        >
          {primitive.label}
        </ClippedText>
      )}
    </group>
  );
}

// ─────────────────────────────────────────────────────────────
// 10. XRImageMesh
// ─────────────────────────────────────────────────────────────

export interface XRImageMeshProps {
  primitive: import("../mapper/types").XRImage;
  entry: LayoutEntry;
}

/**
 * Routes external image URLs through the CORS proxy so Three.js can load
 * them without cross-origin restrictions.  Data and blob URLs pass through
 * unchanged.
 */
function proxyImageSrc(src: string): string {
  if (
    !src ||
    src.startsWith("data:") ||
    src.startsWith("blob:") ||
    src.startsWith("/")
  ) {
    return src;
  }
  try {
    const u = new URL(src);
    if (u.protocol === "http:" || u.protocol === "https:") {
      return `/api/proxy?url=${encodeURIComponent(src)}`;
    }
  } catch {
    // relative URL — leave as-is
  }
  return src;
}

export function XRImageMesh({ primitive, entry }: XRImageMeshProps) {
  const { pos, rot } = entryTransform(entry);
  const clips = useClipPlanes();
  const theme = useTheme();
  const w = safeDim(entry.size.width);
  const h = safeDim(entry.size.height);
  const IMG_BG = theme.inputBg;

  // Proxy external URLs so Three.js can load them without CORS errors.
  const proxiedSrc = proxyImageSrc(primitive.src ?? "");

  function isRenderableImage(url: string) {
    // After proxying, external images become same-origin /api/proxy paths.
    if (!url) return false;
    if (
      url.startsWith("/") ||
      url.startsWith("data:") ||
      url.startsWith("blob:")
    )
      return true;
    try {
      return new URL(url).origin === window.location.origin;
    } catch {
      return false;
    }
  }
  const [texture, setTexture] = React.useState<THREE.Texture | null>(null);
  // Distinguishes "still loading" from "failed to load" — the alt/label text
  // below is a fallback for when the image can't be shown, not a permanent
  // caption. Without this, every successfully-rendered image (including ones
  // with no visible caption on the source page) got its alt text drawn under
  // it forever, e.g. showing literal alt strings like "altN=4-simplex" or a
  // bare filename such as "CDel_node.png" as if it were a real caption.
  const [loadFailed, setLoadFailed] = React.useState(false);

  React.useEffect(() => {
    setTexture(null);
    setLoadFailed(false);
    if (!isRenderableImage(proxiedSrc)) {
      setLoadFailed(true);
      return;
    }
    let cancelled = false;
    const loader = new THREE.TextureLoader();
    loader.load(
      proxiedSrc,
      (loaded) => {
        // useTexture (drei) sets this automatically; a bare TextureLoader
        // does not, which left images rendering blank/washed out under
        // three's color-managed pipeline.
        loaded.colorSpace = THREE.SRGBColorSpace;
        if (!cancelled) setTexture(loaded);
      },
      undefined,
      () => {
        // Broken/unreachable image — leave texture null so the plain
        // background box renders instead of crashing the canvas.
        if (!cancelled) setLoadFailed(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [proxiedSrc]);

  return (
    <group position={pos} rotation={rot}>
      <Surface width={w} height={h} color={IMG_BG} clips={clips} />

      {/* Mesh only mounts once the texture is ready: creating it earlier
          with map=undefined bakes a shader program compiled without the
          USE_MAP define, and later assigning material.map via prop update
          does not retroactively enable texture sampling — the plane just
          renders as meshBasicMaterial's plain white default forever. */}
      {texture && (
        <mesh
          position={[w / 2, -h / 2, Z_LAYER_IMAGE]}
          renderOrder={RENDER_ORDER_IMAGE}
        >
          <planeGeometry args={[w, h]} />
          <meshBasicMaterial map={texture} transparent clippingPlanes={clips} />
        </mesh>
      )}
      <mesh position={[w / 2, -h / 2, 0.002]} rotation={[0, 0, Math.PI / 2]}>
        <planeGeometry args={[h * 0.4, 0.002]} />
        <meshBasicMaterial
          color={theme.panelRim}
          transparent
          opacity={0.5}
          clippingPlanes={clips}
        />
      </mesh>

      {loadFailed && (primitive.alt ?? primitive.label) && (
        <ClippedText
          anchorX="center"
          anchorY="bottom"
          position={[w / 2, -h + 0.02, Z_LAYER_OVERLAY_TEXT]}
          renderOrder={RENDER_ORDER_TEXT}
          fontSize={0.016}
          color={theme.bodyCol}
          maxWidth={w - 0.04}
        >
          {primitive.alt ?? primitive.label ?? ""}
        </ClippedText>
      )}
    </group>
  );
}

// ─────────────────────────────────────────────────────────────
// 11. XRListItemMesh
// ─────────────────────────────────────────────────────────────

export interface XRListItemMeshProps {
  primitive: import("../mapper/types").XRListItem;
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
  const cardClips = React.useMemo(() => {
    const topY = panelOriginY + panelRelativeY;
    const bottomY = topY - h;
    return [
      new THREE.Plane(new THREE.Vector3(0, -1, 0), topY),
      new THREE.Plane(new THREE.Vector3(0, 1, 0), -bottomY),
    ];
  }, [panelOriginY, panelRelativeY, h]);
  const clips = React.useMemo(
    () => [...pageClips, ...cardClips],
    [pageClips, cardClips],
  );
  // Where content starts relative to the card top edge.
  // = LIST_ITEM_ACCENT_INSET + LIST_ITEM_ACCENT_H + LIST_ITEM_CONTENT_PAD.
  // Shared with the engine via layout/utils — any drift causes visual overlap
  // or dead gaps.
  const CONTENT_Y = -LIST_ITEM_LABEL_TOP_INSET;

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

        {/* Plain-text list items (no child elements): label rendered below accent band. */}
        {displayText && (
          <ClippedText
            anchorX="left"
            anchorY="top"
            position={[LIST_ITEM_PROSE_INSET, CONTENT_Y, PANEL_DEPTH]}
            fontSize={labelFont.fontSize}
            color={theme.headingCol}
            fontWeight="600"
            lineHeight={labelFont.lineHeightRatio}
            maxWidth={w - LIST_ITEM_PROSE_INSET * 2}
            overflowWrap="break-word"
          >
            {displayText}
          </ClippedText>
        )}

        {/* Inline children: flowed as prose starting at CONTENT_Y so the first
          line always clears the accent band + gap.
          panelWidth is pre-reduced by the right inset so usableWidth = w - 2*xInset,
          giving symmetric left and right margins (same pattern as XRBlockQuoteMesh). */}
        {inlineRows && (
          <InlineProseRows
            rows={inlineRows}
            startY={CONTENT_Y}
            panelWidth={w - LIST_ITEM_PROSE_INSET}
            fontSize={m.fontSize}
            lineHeightRatio={m.lineHeightRatio}
            xInset={LIST_ITEM_PROSE_INSET}
            renderChild={renderChild}
          />
        )}

        {/* Block children from mixed inline+block items (e.g. sub-lists after
          a prose run). Engine places these at y=0 relative to the card origin;
          we shift by CONTENT_Y so they start below the accent band. */}
        {blockChildren.length > 0 && (
          <group position={[0, CONTENT_Y, 0]}>
            {blockChildren.map((child: any) => renderChild(child.id))}
          </group>
        )}

        {/* Pure-block items (no inline children at all). Engine also places these
          at y=0; same CONTENT_Y shift keeps them below the accent band. */}
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

export interface XRButtonMeshProps {
  primitive: import("../mapper/types").XRButton;
  entry: LayoutEntry;
}

export function XRButtonMesh({ primitive, entry }: XRButtonMeshProps) {
  const { ref, handlers } = useHoverScale(1.0, 1.04);
  const { pos, rot } = entryTransform(entry);
  const clips = useClipPlanes();
  const theme = useTheme();
  const metrics = useRenderMetrics();
  const w = safeDim(entry.size.width);
  const h = safeDim(entry.size.height);
  const isDisabled = primitive.state?.disabled;

  // Read label text from the synthetic child when available (added by
  // normalizeSceneLabels in the mapper), otherwise fall back to primitive.label.
  const flatChildren = flattenInlineWrappers(primitive.children ?? []);
  const labelText =
    flatChildren.length > 0
      ? ((flatChildren[0] as unknown as { text?: string }).text ??
        flatChildren[0].label ??
        "")
      : (primitive.label ?? "");

  // Primary button fill is monochrome (emphasisCol — near-black on light
  // panels, near-white on dark panels) rather than the brand-blue accent.
  // The Horizon UI Set's "Buttons" reference shows Primary as a plain
  // white/light pill with dark content; blue/red are reserved for links and
  // destructive actions respectively, not general primary controls.
  const btnColor = isDisabled ? theme.disabledBg : theme.emphasisCol;

  return (
    <group ref={ref} position={pos} rotation={rot} {...handlers}>
      {/* Pill body — flat, unlit, fully-rounded Horizon primary button */}
      <Surface
        width={w}
        height={h}
        radius={cornerRadius(w, h, h / 2)}
        color={btnColor}
        opacity={isDisabled ? 0.6 : 1}
        flat
        clips={clips}
      />

      <ClippedText
        anchorX="center"
        anchorY="middle"
        position={[w / 2, -h / 2, Z_LAYER_BODY_TEXT]}
        fontSize={metrics.button.font.fontSize}
        color={isDisabled ? theme.mutedTextCol : theme.panelBg}
        fontWeight="600"
        maxWidth={w - 0.02}
      >
        {labelText}
      </ClippedText>
    </group>
  );
}

// ─────────────────────────────────────────────────────────────
// 13. XRAlertMesh
// ─────────────────────────────────────────────────────────────

export interface XRAlertMeshProps {
  primitive: import("../mapper/types").XRAlert;
  entry: LayoutEntry;
  renderChild: (primitiveId: string) => React.ReactNode;
}

export function XRAlertMesh({
  primitive,
  entry,
  renderChild,
}: XRAlertMeshProps) {
  const { pos, rot } = entryTransform(entry);
  const clips = useClipPlanes();
  const theme = useTheme();
  const w = safeDim(entry.size.width);
  const h = safeDim(entry.size.height);
  const metrics = useRenderMetrics();
  const isAssertive = primitive.liveRegion === "assertive";
  const alertColor = isAssertive ? "#D32F2F" : theme.accentCol;
  const alertBg = isAssertive ? "#FDECEA" : "#EAF2FE";

  // If the alert has inline children (e.g. a hatnote whose label is followed
  // by a link), flow them with InlineProseRows exactly like XRParagraphMesh.
  // Without this, only primitive.label renders and all link/text children are
  // silently discarded — the XRAlert case in PrimitiveDispatcher never passed
  // renderChild, so there was no path for children to appear at all.
  const flatChildren = flattenInlineWrappers(primitive.children ?? []);
  const hasAnyInlineChild = flatChildren.some((c) => isInlinePrimitive(c.type));
  const rows = hasAnyInlineChild
    ? buildInlineRows(mergeAdjacentTextRuns(flatChildren))
    : [];
  const m = metrics.paragraph;
  const X_INSET = 0.02;

  return (
    <group position={pos} rotation={rot}>
      <Surface
        width={w}
        height={h}
        color={alertBg}
        rimColor={theme.panelRim}
        clips={clips}
      />

      {/* Left accent bar */}
      <mesh
        position={[0.004, -h / 2, Z_LAYER_ACCENT]}
        renderOrder={RENDER_ORDER_ACCENT}
      >
        <planeGeometry args={[0.007, h * 0.8]} />
        <meshBasicMaterial
          color={alertColor}
          transparent
          opacity={0.95}
          clippingPlanes={clips}
        />
      </mesh>

      {hasAnyInlineChild ? (
        // Inline flow: renders "Main article: " (XRText) + link (XRLink) as a
        // single prose run with correct accent colouring for the link segment.
        <InlineProseRows
          rows={rows}
          startY={-0.014}
          panelWidth={w - X_INSET}
          fontSize={m.fontSize}
          lineHeightRatio={m.lineHeightRatio}
          xInset={X_INSET}
          renderChild={renderChild}
        />
      ) : (
        // Fallback: label-only alerts (live regions, status messages, etc.)
        // Prefer primitive.content over primitive.label — the mapper may set
        // label to only the accessible short-name (e.g. "Main article:") while
        // content carries the full visible text (e.g. "Main article: KPop Demon
        // Hunters (soundtrack)").  This is a stop-gap: link text will appear
        // but without accent colouring.  The proper fix is for the mapper to
        // populate primitive.children so the hasAnyInlineChild branch above
        // fires and InlineProseRows handles link styling correctly.
        <ClippedText
          anchorX="left"
          anchorY="top"
          position={[X_INSET, -0.014, Z_LAYER_BODY_TEXT]}
          renderOrder={RENDER_ORDER_TEXT}
          fontSize={0.022}
          color={isAssertive ? "#B3261E" : theme.bodyCol}
          maxWidth={w - 0.032}
          lineHeight={1.4}
        >
          {primitive.content ?? primitive.label ?? ""}
        </ClippedText>
      )}
    </group>
  );
}

// ─────────────────────────────────────────────────────────────
// 14. XRTableMesh
// ─────────────────────────────────────────────────────────────

export interface XRTableMeshProps {
  primitive: import("../mapper/types").XRTable;
  entry: LayoutEntry;
  renderChild: (primitiveId: string) => React.ReactNode;
}

export function XRTableMesh({
  primitive,
  entry,
  renderChild,
}: XRTableMeshProps) {
  const { pos, rot } = entryTransform(entry);
  const clips = useClipPlanes();
  const theme = useTheme();
  const w = safeDim(entry.size.width);
  const h = safeDim(entry.size.height);
  const HEADER_H = 0.04;

  return (
    <group position={pos} rotation={rot}>
      <Surface
        width={w}
        height={h}
        color={theme.panelBg}
        gradient
        rimColor={theme.panelRim}
        clips={clips}
      />

      {/* Header row — a recessed nav-toned band across the top */}
      <Surface
        width={w}
        height={HEADER_H}
        color={theme.navBg}
        origin={[w / 2, -HEADER_H / 2]}
        z={Z_LAYER_ACCENT}
        clips={clips}
      />

      {primitive.label && (
        <ClippedText
          anchorX="left"
          anchorY="middle"
          position={[0.014, -HEADER_H / 2, Z_LAYER_BODY_TEXT]}
          fontSize={0.018}
          color={theme.headingCol}
          fontWeight="600"
          maxWidth={w - 0.12}
        >
          {primitive.label}
        </ClippedText>
      )}

      {primitive.children.map((child) => renderChild(child.id))}
    </group>
  );
}

// ─────────────────────────────────────────────────────────────
// 15. XRFormFieldMesh
// ─────────────────────────────────────────────────────────────

export interface XRFormFieldMeshProps {
  primitive: import("../mapper/types").XRFormField;
  entry: LayoutEntry;
}

export function XRFormFieldMesh({ primitive, entry }: XRFormFieldMeshProps) {
  const { pos, rot } = entryTransform(entry);
  const clips = useClipPlanes();
  const theme = useTheme();
  const w = safeDim(entry.size.width);
  const h = safeDim(entry.size.height);
  const INPUT_H = Math.min(0.038, h * 0.6);
  const INPUT_BG = theme.inputBg;
  const label = primitive.resolvedLabel ?? primitive.label ?? "";

  return (
    <group position={pos} rotation={rot}>
      {label && (
        <ClippedText
          anchorX="left"
          anchorY="bottom"
          position={[0, -(h - INPUT_H) + 0.002, 0.002]}
          fontSize={0.016}
          color={theme.bodyCol}
          maxWidth={w}
        >
          {label}
        </ClippedText>
      )}

      <Surface
        width={w}
        height={INPUT_H}
        color={INPUT_BG}
        rimColor={theme.panelRim}
        opacity={primitive.state?.disabled ? 0.5 : 1}
        origin={[w / 2, -h + INPUT_H / 2]}
        clips={clips}
      />

      {primitive.placeholder && (
        <ClippedText
          anchorX="left"
          anchorY="middle"
          position={[0.01, -h + INPUT_H / 2, Z_LAYER_BODY_TEXT]}
          fontSize={0.016}
          color={theme.mutedTextCol}
          maxWidth={w - 0.02}
        >
          {primitive.placeholder}
        </ClippedText>
      )}
    </group>
  );
}

// ─────────────────────────────────────────────────────────────
// 16. XRTabGroupMesh
// ─────────────────────────────────────────────────────────────

export interface XRTabGroupMeshProps {
  primitive: import("../mapper/types").XRTabGroup;
  entry: LayoutEntry;
  renderChild: (primitiveId: string) => React.ReactNode;
}

export function XRTabGroupMesh({
  primitive,
  entry,
  renderChild,
}: XRTabGroupMeshProps) {
  const { pos, rot } = entryTransform(entry);
  const clips = useClipPlanes();
  const theme = useTheme();
  const w = safeDim(entry.size.width);
  const h = safeDim(entry.size.height);
  const TAB_H = 0.042;

  return (
    <group position={pos} rotation={rot}>
      {/* Tab bar — recessed nav-toned strip */}
      <Surface
        width={w}
        height={TAB_H}
        color={theme.navBg}
        origin={[w / 2, -TAB_H / 2]}
        clips={clips}
      />

      {/* Content panel below the tab bar */}
      <Surface
        width={w}
        height={h - TAB_H}
        color={theme.panelBg}
        gradient
        origin={[w / 2, -(TAB_H + (h - TAB_H) / 2)]}
        clips={clips}
      />

      {primitive.children.map((child) => renderChild(child.id))}
    </group>
  );
}

// primitives.tsx - Add XRTextMesh for rendering text nodes

export interface XRTextMeshProps {
  primitive: import("../mapper/types").XRText;
  entry: LayoutEntry;
}

/**
 * XRTextMesh renders a single text node.
 *
 * Text nodes are atomic - they represent a single text run with optional
 * semantic formatting (em, strong, code, etc.).
 *
 * The componentType determines the visual styling:
 * - "strong" / "b": bold
 * - "em" / "i": italic
 * - "code": monospace
 * - "span": plain text (default)
 * - "text": plain text (default)
 */
export function XRTextMesh({ primitive, entry }: XRTextMeshProps) {
  const { pos, rot } = entryTransform(entry);
  const clips = useClipPlanes();
  const theme = useTheme();
  const w = safeDim(entry.size.width);
  const h = safeDim(entry.size.height);
  const metrics = useRenderMetrics();
  // An ancestor (e.g. XRHeadingMesh) may override the metric this text run
  // renders with — see TextStyleContext. Falls back to paragraph metrics,
  // matching estimateHeight()'s default for a standalone XRText.
  const styleOverride = useContext(TextStyleContext);
  const textMetric = styleOverride ?? metrics.paragraph;

  // Determine styling based on component type and/or the accumulated
  // styleTags stack (e.g. <i><b>text</b></i> produces componentType: null,
  // styleTags: ["i", "b"] — a single componentType string can't represent
  // two simultaneous styles, so we OR both signals in rather than treating
  // componentType as the only source of truth).
  const componentType = primitive.componentType || "text";
  const styleTags = primitive.styleTags ?? [];
  const isBold =
    componentType === "strong" ||
    componentType === "b" ||
    styleTags.includes("strong") ||
    styleTags.includes("b");
  const isItalic =
    componentType === "em" ||
    componentType === "i" ||
    styleTags.includes("em") ||
    styleTags.includes("i");

  let fontWeight: string | number = isBold ? "700" : "400";
  let fontStyle: "normal" | "italic" = isItalic ? "italic" : "normal";
  let color = isBold || isItalic ? theme.headingCol : theme.bodyCol;

  switch (componentType) {
    case "code":
      fontWeight = "500";
      color = "#116329";
      break;
    case "link":
      color = theme.accentCol;
      fontWeight = "500";
      break;
    default:
      // bold/italic/color already resolved above from isBold/isItalic;
      // nothing else to do for 'text' / 'span' / unknown.
      break;
  }

  return (
    <group position={pos} rotation={rot}>
      <ClippedText
        anchorX="left"
        anchorY="top"
        position={[0, 0, 0.002]}
        fontSize={textMetric.fontSize}
        color={color}
        fontWeight={fontWeight}
        fontStyle={fontStyle}
        maxWidth={w}
        lineHeight={textMetric.lineHeightRatio}
        letterSpacing={0.005}
      >
        {primitive.text}
      </ClippedText>
    </group>
  );
}

// primitives.tsx - Add XRLinkMesh

export interface XRLinkMeshProps {
  primitive: import("../mapper/types").XRLink;
  entry: LayoutEntry;
  renderChild: (primitiveId: string) => React.ReactNode;
}

/**
 * XRLinkMesh renders a link's text content inline.
 *
 * When the link has children (synthetic XRLink leaf from normalizeSceneLabels,
 * or real mixed XRText/XRLink children), they are flowed via InlineProseRows.
 * XRLink segments in buildRowMeta automatically receive the theme's accent
 * colour, so a synthetic XRLink child renders in link colour with no extra
 * wiring needed.
 *
 * Label-only fallback (no children after normalization) renders via ClippedText.
 */
export function XRLinkMesh({ primitive, entry, renderChild }: XRLinkMeshProps) {
  const { pos, rot } = entryTransform(entry);
  const w = safeDim(entry.size.width);
  const metrics = useRenderMetrics();
  const theme = useTheme();
  const accentHex = parseInt(theme.accentCol.replace("#", ""), 16);
  const styleOverride = useContext(TextStyleContext);
  const linkMetric = styleOverride ?? metrics.link.font;
  const { ref, handlers } = useHoverScale(1.0, 1.02);
  const navigate = useContext(NavigateContext);

  const flatChildren = flattenInlineWrappers(primitive.children ?? []);
  const hasInlineChildren = flatChildren.some((c) => isInlinePrimitive(c.type));
  const rows = hasInlineChildren
    ? buildInlineRows(mergeAdjacentTextRuns(flatChildren))
    : [];

  const clickHandler =
    primitive.href && navigate
      ? {
          onClick: (e: { stopPropagation: () => void }) => {
            e.stopPropagation();
            navigate(primitive.href!);
          },
        }
      : {};

  return (
    <group
      ref={ref}
      position={pos}
      rotation={rot}
      {...handlers}
      {...clickHandler}
    >
      {hasInlineChildren ? (
        <InlineProseRows
          rows={rows}
          startY={0}
          panelWidth={w}
          fontSize={linkMetric.fontSize}
          lineHeightRatio={linkMetric.lineHeightRatio}
          xInset={0}
          renderChild={renderChild}
          forceColor={accentHex}
        />
      ) : (
        <ClippedText
          anchorX="left"
          anchorY="top"
          position={[0, 0, 0.002]}
          fontSize={linkMetric.fontSize}
          color={primitive.isCurrent ? theme.headingCol : theme.accentCol}
          fontWeight={primitive.isCurrent ? "700" : "500"}
          maxWidth={w}
          lineHeight={linkMetric.lineHeightRatio}
        >
          {primitive.label ?? primitive.href ?? ""}
        </ClippedText>
      )}
    </group>
  );
}
