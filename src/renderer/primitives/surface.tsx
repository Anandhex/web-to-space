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
export function roundedRectShape(w: number, h: number, r: number): THREE.Shape {
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
export function useSurfaceGeometry(
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
export function liftColor(hex: string, amount = 0.05): string {
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
