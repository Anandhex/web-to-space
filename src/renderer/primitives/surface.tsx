/**
 * primitives/surface.tsx
 *
 * The canonical Horizon-card <Surface> plus the geometry helpers and small
 * shared render utilities (transform, heading metric/weight, hover scale) that
 * every mesh builds on. Depends only on constants + layout types, so it sits at
 * the base of the primitive dependency graph.
 */

import React, { useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";

import type { LayoutEntry, RenderMetrics } from "../../layout/types";
import {
  MIN_DIM,
  CORNER_FRACTION,
  CORNER_MIN,
  CORNER_MAX,
  Z_SURFACE,
  Z_SURFACE_RIM,
  RENDER_ORDER_SURFACE,
} from "./constants";
import { usePanelCurve, makeBentPlane, type PanelCurve } from "./curve";

/** Clamp a layout dimension to a safe minimum. */
export function safeDim(v: number): number {
  return Number.isFinite(v) && v > MIN_DIM ? v : MIN_DIM;
}

/**
 * Horizon-scale corner radius for a flat surface of the given size.
 * Depth-independent (unlike safeRadius): a fraction of the shorter edge,
 * clamped, then capped at just under half the shorter edge so a fully-rounded
 * pill (radius = h/2) is still expressible for short/wide controls.
 */
export function cornerRadius(
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

interface SurfaceProps {
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
   * regardless of scene lighting — a true UI-canvas look. DEFAULTS TO TRUE.
   *
   * These are interface surfaces, not objects in the room, and the two must not
   * be lit by the same lights: with meshStandardMaterial a card picked up
   * whatever the surrounding space happened to be lit with, so the same
   * #323232 section read warm and blotchy under the rooms view's practicals and
   * neutral everywhere else — a light smear across the panel that no theme
   * value could account for. The panel's own gradient wash was already unlit,
   * so the two disagreed on every card. Unlit means a colour picked in the
   * theme is the colour the reader sees, in every view.
   *
   * Depth still reads: it comes from the Z ladder, the rim, and the top-lighter
   * `gradient`, none of which depend on scene lights. Pass `flat={false}` only
   * for a surface that is meant to be part of the room rather than part of the
   * interface; roughness/metalness apply only then.
   */
  flat?: boolean;
  /**
   * Grow the backing outward by this many metres on all four sides, around the
   * content box given by `width`/`height`.
   *
   * A container knows the box its children occupy, not the box its card should
   * be — those differ by exactly the card's interior padding. Without this the
   * card was drawn flush to its own text on every edge: a section's heading
   * started at the same x as the section fill's left edge, so the fill read as
   * a stray band behind the words rather than as a card holding them. Padding
   * the geometry outward keeps every child position untouched (the layout
   * engine still owns those) while giving the surface its own margin.
   */
  pad?: number;
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
  /**
   * Explicit cylinder curve for a panel's OWN full-width backing, which is not
   * wrapped in an <AtPos> (so it can't inherit the tangent transform the way a
   * nested fill does). When set, the fill is bent around the panel centre. When
   * omitted, the surface still bends if it sits inside a PanelCurveContext — but
   * around its group origin (an outer <AtPos> already tangent-yawed it there).
   */
  curve?: PanelCurve | null;
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
  flat = true,
  pad = 0,
  rimColor,
  rimOpacity = 0.9,
  z = Z_SURFACE,
  origin,
  clips,
  curve,
}: SurfaceProps) {
  // `pad` grows the geometry symmetrically, so the default origin — which puts
  // the content box's top-left at the group origin — is unchanged: the extra
  // half-pad on each side cancels against the shift. The card simply bleeds
  // `pad` beyond its content in every direction.
  const w = safeDim(width + pad * 2);
  const h = safeDim(height + pad * 2);
  const r = radius ?? cornerRadius(w, h);
  const ox = origin ? origin[0] : w / 2 - pad;
  const oy = origin ? origin[1] : -h / 2 + pad;
  const resolvedTop = topColor ?? (gradient ? liftColor(color) : undefined);

  // Curve resolution: an explicit `curve` prop (a panel's own centred backing)
  // bends around the panel centre — the geometry point currently at panel-x
  // centerX must stay, and it sits at geometry-local x = centerX − ox. Otherwise
  // fall back to the ambient PanelCurveContext, where an outer <AtPos> already
  // tangent-yawed this group at its origin, so bend around geometry-local −ox.
  const ctxCurve = usePanelCurve();
  const activeCurve = curve ?? ctxCurve;
  const pivotX = curve ? curve.centerX - ox : -ox;
  const flatFillGeo = useSurfaceGeometry(w, h, r, resolvedTop, color);
  const flatRimGeo = useSurfaceGeometry(w, h, r);
  const bentFillGeo = React.useMemo(
    () =>
      activeCurve
        ? makeBentPlane(w, h, activeCurve.radius, pivotX, resolvedTop, color)
        : null,
    [activeCurve, w, h, pivotX, resolvedTop, color],
  );
  const bentRimGeo = React.useMemo(
    () =>
      activeCurve
        ? makeBentPlane(w + 0.0025, h + 0.0025, activeCurve.radius, pivotX)
        : null,
    [activeCurve, w, h, pivotX],
  );
  const fillGeo = bentFillGeo ?? flatFillGeo;
  const rimGeo = bentRimGeo ?? flatRimGeo;

  return (
    <group position={[ox, oy, 0]}>
      {rimColor && (
        <mesh
          geometry={rimGeo}
          position={[0, 0, z + Z_SURFACE_RIM - Z_SURFACE]}
          scale={
            bentRimGeo ? [1, 1, 1] : [(w + 0.0025) / w, (h + 0.0025) / h, 1]
          }
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

/**
 * A textured quad (image/video poster) that bends onto the panel cylinder when
 * inside a PanelCurveContext, so it hugs the curved backing instead of poking
 * through as a flat tangent slab. Pass the material as children; it's applied
 * to whichever geometry (bent segmented plane, or a flat planeGeometry) is used.
 *
 * The mesh is placed at `position` inside an already tangent-yawed group, so the
 * bend pivots around the group origin — geometry-local x = −position[0].
 */
export function CurvedTexturePlane({
  width,
  height,
  position,
  renderOrder,
  children,
}: {
  width: number;
  height: number;
  position: [number, number, number];
  renderOrder?: number;
  children: React.ReactNode;
}) {
  const curve = usePanelCurve();
  const bent = React.useMemo(
    () =>
      curve ? makeBentPlane(width, height, curve.radius, -position[0]) : null,
    [curve, width, height, position[0]],
  );
  return (
    <mesh
      geometry={bent ?? undefined}
      position={position}
      renderOrder={renderOrder}
    >
      {!bent && <planeGeometry args={[width, height]} />}
      {children}
    </mesh>
  );
}

// ─────────────────────────────────────────────────────────────
// Utility
// ─────────────────────────────────────────────────────────────

/**
 * Convert a LayoutEntry into a Three.js position and Euler rotation.
 * All values are already in metres from the layout engine.
 */
export function entryTransform(entry: LayoutEntry) {
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
export function headingWeight(level: number): string {
  return level <= 2 ? "700" : level <= 4 ? "600" : "500";
}

/**
 * Resolve a heading level's font metrics from the active RenderMetrics,
 * with the same fallback chain estimateHeight() uses in engine.ts
 * (level → heading[2] → paragraph), so a heading that falls back in the
 * layout engine falls back identically here.
 */
export function resolveHeadingMetric(
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

export function useHoverScale(baseScale = 1.0, hoverScale = 1.015) {
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
