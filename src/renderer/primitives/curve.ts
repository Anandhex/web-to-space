/**
 * primitives/curve.ts
 *
 * The curved-panel subsystem: bends a panel's backing + every child primitive
 * around ONE vertical cylinder (the Meta Horizon "wrap the UI around the user"
 * look). Kept dependency-light (no <Surface> import) so Surface can bend itself
 * without an import cycle.
 *
 * Coordinate model (all metres, panel-local frame):
 *   A flat panel has x running 0 → width (left → right), y running 0 → -height
 *   (top → down), z forward toward the viewer. We wrap it onto a cylinder of
 *   radius R whose axis is vertical, so the panel stays flat at its horizontal
 *   centre (`centerX`) and its left/right edges bend TOWARD the viewer (+z) —
 *   a concave surface hugging the reader.
 *
 * The bend is a pure RENDER transform: the layout engine still lays every child
 * out flat (panel-absolute), and descendant entries carry curveRadius 0, so the
 * radius is propagated to descendants through PanelCurveContext rather than the
 * per-entry field.
 */
import { createContext, useContext } from "react";
import * as THREE from "three";

// ─────────────────────────────────────────────────────────────
// Global knob
// ─────────────────────────────────────────────────────────────

/**
 * THE single global curve knob. 1 = full curvature (use each panel's authored
 * `entry.curveRadius` as-is); 0 = flat (no panel provides a curve context, so
 * everything renders exactly as it did before curvature existed). Values in
 * between flatten the curve (a smaller strength maps to a larger effective
 * radius). This is the one place to tune or disable curved panels globally.
 */
export const PANEL_CURVE_STRENGTH = 1;

/**
 * Carousel ghost (prev/next page preview) panels curve on their OWN, flatter
 * cylinder — their authored radius is multiplied by this. Seen off-axis at the
 * sides, a ghost bent as tightly as the head-on main panel reads as oddly
 * over-curved, so a value > 1 relaxes it. Tune to taste (1 = identical to the
 * main panel).
 */
export const CAROUSEL_GHOST_CURVE_SCALE = 1.8;

/**
 * Resolve a panel's authored curve radius into the effective render radius,
 * folding in the global strength knob. Returns null when the panel should stay
 * flat (no authored radius, or strength dialled to 0) — callers then skip
 * providing a PanelCurveContext.
 */
export function resolveCurveRadius(entryCurveRadius: number): number | null {
  if (PANEL_CURVE_STRENGTH <= 0) return null;
  if (!Number.isFinite(entryCurveRadius) || entryCurveRadius <= 0) return null;
  // Smaller strength → larger radius → flatter arc. strength 1 → radius as-is.
  return entryCurveRadius / PANEL_CURVE_STRENGTH;
}

// ─────────────────────────────────────────────────────────────
// Context
// ─────────────────────────────────────────────────────────────

export interface PanelCurve {
  /** Cylinder radius in metres (already strength-adjusted). */
  radius: number;
  /** Panel-local x that stays flat/tangent — the horizontal centre (width/2). */
  centerX: number;
}

/**
 * Provided by a curved panel (content panel, complementary, nav) and inherited
 * by every descendant so the whole panel-absolute subtree bends around ONE
 * cylinder. `null` means "flat" (the default). Only a TOP curved panel provides
 * it; nested paginating containers carry curveRadius 0 and inherit.
 */
export const PanelCurveContext = createContext<PanelCurve | null>(null);

/** Current panel curve, or null when flat. */
export function usePanelCurve(): PanelCurve | null {
  return useContext(PanelCurveContext);
}

/**
 * True once an ancestor <AtPos> has already tangent-placed this subtree on the
 * cylinder. The position curve is a NONLINEAR map, so it must be applied to a
 * node's absolute panel position exactly ONCE. Panel-absolute children are flat
 * siblings (each placed once), but parent-relative subtrees (XRComplementary
 * content, XRList items) nest <AtPos> inside <AtPos> — the inner ones must then
 * translate rigidly instead of re-curving, or the child is placed twice and
 * over-rotates. Text/fills still bend via PanelCurveContext regardless.
 */
export const CurvePlacedContext = createContext<boolean>(false);

/** Whether an ancestor already tangent-placed this subtree (see context doc). */
export function useCurvePlaced(): boolean {
  return useContext(CurvePlacedContext);
}

// ─────────────────────────────────────────────────────────────
// Point placement (used by AtPos + any explicit-group placement)
// ─────────────────────────────────────────────────────────────

export interface CurvedPlacement {
  position: [number, number, number];
  /** Y-axis yaw (radians) that faces the point tangent to the cylinder. */
  yaw: number;
}

/**
 * Map a flat panel-local point to its position on the cylinder plus the yaw
 * that lays it tangent to the surface. Concave-toward-viewer: the panel centre
 * (px === centerX) stays put (θ = 0), edges bend to +z.
 *
 * Matches the arc math the horizontal nav bar already uses for its chips
 * (x = centerX + R·sinθ, z += R·(1 − cosθ), yaw = −θ) so backing + chips + all
 * primitives share one cylinder.
 */
export function curvePoint(
  px: number,
  py: number,
  pz: number,
  radius: number,
  centerX: number,
): CurvedPlacement {
  const theta = (px - centerX) / radius;
  return {
    position: [centerX + radius * Math.sin(theta), py, pz + radius * (1 - Math.cos(theta))],
    yaw: -theta,
  };
}

// ─────────────────────────────────────────────────────────────
// Geometry bending (for wide backing / fill surfaces)
// ─────────────────────────────────────────────────────────────

/**
 * Bend a flat geometry around the vertical cylinder IN PLACE. Every vertex at
 * geometry-local x is wrapped by angle θ = (x − pivotX) / R, moving it to
 * (pivotX + R·sinθ, y, z + R·(1 − cosθ)). The line at x = pivotX stays fixed and
 * everything else curves toward +z.
 *
 * `pivotX` is the geometry-local x that must stay tangent, and MUST line up with
 * where the mesh is anchored or the fill wraps onto a shifted parallel cylinder
 * (curves "slightly", pokes through the panel):
 *   - explicit centred backing (group already at the panel centre): pivotX = 0
 *   - context-driven nested fill (an outer <AtPos> already tangent-yawed the
 *     group at its origin): pivotX = −ox, i.e. bend around the group origin.
 *
 * ShapeGeometry can't be bent usefully (it only tessellates the perimeter), so
 * curved wide surfaces are built from a segmented PlaneGeometry and trade the
 * sub-millimetre rounded corners for a smoothly segmented arc.
 */
export function bendGeometry(
  geo: THREE.BufferGeometry,
  radius: number,
  pivotX: number,
): THREE.BufferGeometry {
  const pos = geo.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    const theta = (x - pivotX) / radius;
    pos.setX(i, pivotX + radius * Math.sin(theta));
    pos.setZ(i, z + radius * (1 - Math.cos(theta)));
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return geo;
}

/** Horizontal segment count for a bent surface of the given width (≈ one every 2 cm). */
export function bendSegments(width: number): number {
  return THREE.MathUtils.clamp(Math.ceil(width / 0.02), 8, 64);
}

/**
 * Build a bent, optionally top-to-bottom vertex-gradient PlaneGeometry centred
 * at the origin — the curved analogue of a flat rounded-rect fill. Used by
 * <Surface> (and the panel backing) whenever a curve is active.
 */
export function makeBentPlane(
  width: number,
  height: number,
  radius: number,
  pivotX: number,
  topColor?: string,
  bottomColor?: string,
): THREE.PlaneGeometry {
  const geo = new THREE.PlaneGeometry(
    Math.max(width, 0.001),
    Math.max(height, 0.001),
    bendSegments(width),
    1,
  );
  if (topColor && bottomColor) {
    const top = new THREE.Color(topColor);
    const bot = new THREE.Color(bottomColor);
    const p = geo.attributes.position;
    const colors = new Float32Array(p.count * 3);
    const c = new THREE.Color();
    const h = Math.max(height, 0.001);
    for (let i = 0; i < p.count; i++) {
      const t = (p.getY(i) + h / 2) / h; // 0 bottom → 1 top
      c.copy(bot).lerp(top, THREE.MathUtils.clamp(t, 0, 1));
      colors[i * 3] = c.r;
      colors[i * 3 + 1] = c.g;
      colors[i * 3 + 2] = c.b;
    }
    geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  }
  bendGeometry(geo, radius, pivotX);
  return geo;
}
