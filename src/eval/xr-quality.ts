/**
 * eval/xr-quality.ts — literature-grounded spatial-quality metrics for the XR
 * output. Unlike compare/metrics.ts (which stops at the IR), these judge the
 * *placed* LayoutPlan: can the user actually read and reach the content?
 *
 * Grounding
 * ---------
 * • Angular text size / legibility:
 *     - Legibility floor ≈ 0.29° (~17 arcmin) cap-height — below this XR text
 *       becomes hard to read. (See VR legibility studies, e.g. IEEE VR 2020
 *       "The influence of text rotation, font and distance on legibility in VR".)
 *     - Comfort target ≈ 1.375° — recommended comfortable XR reading size.
 *       (ACM VRST 2025 "Perceiving Multilingual Text in VR"; commonly cited XR
 *       UX guidance.)  Angular size θ = 2·atan(h / 2d).
 * • Placement distance window: content should sit ~0.5–20 m; the device profile
 *   pins panels at `viewingDistance`, so we score deviation from it.
 * • Comfort envelope: horizontal ±`comfortHalfAngleDeg` around the forward gaze
 *   is the no-head-turn reading cone; content outside costs a head rotation.
 *
 * All lengths are metres (project invariant). Head is modelled at
 * (0, eyeLevel, 0) looking down −Z, matching the renderer's camera rig.
 */

import type { LayoutPlan, LayoutEntry } from "../layout/types";
import type { DeviceProfile } from "../layout/types";
import type { SemanticScene, XRPrimitive, XRPrimitiveType } from "../mapper/types";

// Legibility thresholds in degrees of visual angle (cap-height).
export const LEGIBILITY_FLOOR_DEG = 0.29;
export const COMFORT_TARGET_DEG = 1.375;

export interface XRSpatialQuality {
  // ── Angular legibility (weighted by text length) ──────────────
  /** Mean cap-height angular size of readable text, degrees. */
  meanAngularSizeDeg: number;
  /** Smallest text angular size present, degrees. */
  minAngularSizeDeg: number;
  /** Fraction of text (by char weight) at/above the legibility floor. */
  legibleFraction: number;
  /** Fraction of text (by char weight) at/above the comfort target. */
  comfortableFraction: number;

  // ── Comfort envelope occupancy (top-level panels) ─────────────
  /** Fraction of panel area whose centre lies within ±comfortHalfAngle. */
  comfortCoverage: number;
  /** Panels whose centre is beyond the comfort cone (need a head turn). */
  peripheralPanelCount: number;
  /** Area-weighted mean |azimuth| of panels from forward gaze, degrees. */
  meanAbsAzimuthDeg: number;

  // ── Information density ───────────────────────────────────────
  /**
   * Main content-panel area ÷ comfort-viewport area at the viewing distance.
   * ~0.4–0.9 is a comfortable fill; ≫1 spills past the cone, ≪ wastes it.
   */
  mainPanelFovFill: number;

  // ── Navigation cost ───────────────────────────────────────────
  /** Sequential page turns to read everything (Σ pages − #paginated panels). */
  pageTurnsToReadAll: number;
  /** Total virtual pages across all paginated panels. */
  totalPages: number;
  /** Area-weighted mean |distance − viewingDistance| over panels, metres. */
  meanReadingDistanceErrorM: number;
  /** Panels placed nearer than 0.5 m or farther than 20 m. */
  outOfDistanceWindowCount: number;
}

const DEG = 180 / Math.PI;

/** Cap-height angular size (deg) for a glyph of height `h` at distance `d`. */
function angularSizeDeg(h: number, d: number): number {
  if (d <= 0) return Infinity;
  return 2 * Math.atan(h / (2 * d)) * DEG;
}

/** Font cap-height (m) for a text-bearing primitive, from the device metrics. */
function fontHeightFor(
  p: XRPrimitive,
  metrics: DeviceProfile["renderMetrics"],
): number | null {
  switch (p.type) {
    case "XRParagraph":
    case "XRText":
      return metrics.paragraph.fontSize;
    case "XRHeading": {
      const lvl = Math.min(6, Math.max(1, (p as { level?: number }).level ?? 2)) as
        | 1 | 2 | 3 | 4 | 5 | 6;
      return (metrics.heading[lvl] ?? metrics.heading[2] ?? metrics.paragraph).fontSize;
    }
    case "XRCodeBlock":
      return metrics.codeBlock.fontSize;
    case "XRBlockQuote":
      return metrics.blockQuote.fontSize;
    case "XRListItem":
      return metrics.listItem.font.fontSize;
    case "XRLink":
      return metrics.link.font.fontSize;
    case "XRButton":
      return metrics.button.font.fontSize;
    default:
      return null;
  }
}

/** Text weight for a primitive = visible characters it renders. */
function textWeight(p: XRPrimitive): number {
  const s = p.content ?? p.label ?? "";
  return s.replace(/\s+/g, " ").trim().length;
}

// XRBanner/XRFooter are excluded — that page chrome is dropped from the scene,
// so it does not participate in comfort-envelope / FOV / distance scoring.
const TOP_LEVEL_PANELS = new Set<XRPrimitiveType>([
  "XRContentPanel", "XRNavigationBar",
  "XRComplementary", "XRFormPanel", "XRDialog",
]);

export function computeXRQuality(
  plan: LayoutPlan,
  profile: DeviceProfile,
  scene: SemanticScene,
): XRSpatialQuality {
  const d = profile.layoutConfig.viewingDistance;
  const metrics = profile.renderMetrics;
  const comfortHalf = profile.layoutConfig.comfortHalfAngleDeg;

  // ── Angular legibility over all text-bearing primitives ──────
  let angWSum = 0;
  let angValSum = 0;
  let legibleW = 0;
  let comfortableW = 0;
  let minAng = Infinity;
  const walk = (p: XRPrimitive): void => {
    const h = fontHeightFor(p, metrics);
    if (h != null) {
      const w = textWeight(p);
      if (w > 0) {
        const ang = angularSizeDeg(h, d);
        angWSum += w;
        angValSum += w * ang;
        if (ang >= LEGIBILITY_FLOOR_DEG) legibleW += w;
        if (ang >= COMFORT_TARGET_DEG) comfortableW += w;
        if (ang < minAng) minAng = ang;
      }
    }
    for (const c of p.children) walk(c);
  };
  walk(scene.root);

  // ── Comfort envelope + reading distance over top-level panels ─
  const head = { x: 0, y: profile.layoutConfig.eyeLevel, z: 0 };
  let areaSum = 0;
  let comfortAreaSum = 0;
  let azWeighted = 0;
  let peripheral = 0;
  let distErrWeighted = 0;
  let outOfWindow = 0;
  let mainPanelArea = 0;

  const panelEntries: Array<{ entry: LayoutEntry; type: XRPrimitiveType }> = [];
  for (const [id, entry] of Object.entries(plan.entries)) {
    const prim = scene.primitives[id];
    if (!prim || !entry.worldLocked) continue;
    if (!TOP_LEVEL_PANELS.has(prim.type)) continue;
    panelEntries.push({ entry, type: prim.type });
  }

  for (const { entry, type } of panelEntries) {
    const area = Math.max(entry.size.width * entry.size.height, 0);
    // Panel centre relative to head; forward gaze is −Z.
    const cx = entry.position.x + entry.size.width / 2 - head.x;
    const cz = entry.position.z - head.z;
    const dist = Math.hypot(cx, cz, entry.position.y - head.y);
    const azimuthDeg = Math.abs(Math.atan2(cx, -cz) * DEG);

    areaSum += area;
    azWeighted += area * azimuthDeg;
    if (azimuthDeg <= comfortHalf) comfortAreaSum += area;
    else peripheral += 1;
    distErrWeighted += area * Math.abs(dist - d);
    if (dist < 0.5 || dist > 20) outOfWindow += 1;
    if (type === "XRContentPanel" && area > mainPanelArea) mainPanelArea = area;
  }

  // Comfort viewport area at the viewing distance (horizontal cone; vertical
  // treated symmetrically — profiles expose only the horizontal half-angle).
  const halfW = d * Math.tan((comfortHalf * Math.PI) / 180);
  const comfortViewportArea = (2 * halfW) * (2 * halfW);

  const totalPages = plan.diagnostics.paginatedPanels.reduce(
    (s, p) => s + p.pageCount,
    0,
  );

  return {
    meanAngularSizeDeg: angWSum > 0 ? round(angValSum / angWSum, 3) : 0,
    minAngularSizeDeg: minAng === Infinity ? 0 : round(minAng, 3),
    legibleFraction: angWSum > 0 ? round(legibleW / angWSum, 3) : 0,
    comfortableFraction: angWSum > 0 ? round(comfortableW / angWSum, 3) : 0,
    comfortCoverage: areaSum > 0 ? round(comfortAreaSum / areaSum, 3) : 0,
    peripheralPanelCount: peripheral,
    meanAbsAzimuthDeg: areaSum > 0 ? round(azWeighted / areaSum, 2) : 0,
    mainPanelFovFill:
      comfortViewportArea > 0 ? round(mainPanelArea / comfortViewportArea, 3) : 0,
    pageTurnsToReadAll: Math.max(
      0,
      totalPages - plan.diagnostics.paginatedPanels.length,
    ),
    totalPages,
    meanReadingDistanceErrorM: areaSum > 0 ? round(distErrWeighted / areaSum, 3) : 0,
    outOfDistanceWindowCount: outOfWindow,
  };
}

function round(v: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(v * f) / f;
}
