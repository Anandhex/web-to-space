// ─────────────────────────────────────────────────────────────
// Landmark placement layer
//
// Merged from slots.ts (per-template SlotMaps) + arrangements.ts (two-axis
// view system). Two orthogonal axes live here:
//   • Content template  → per-template hand-tuned SlotMap (selectSlots)
//   • Arrangement        → frame + distribution composed over a template's
//                          slot roster (resolveArrangementSlots)
// Intra-panel layout (layoutPrimitive / pagination) lives in engine.ts and is
// untouched — this file only places the top-level landmark panels.
// ─────────────────────────────────────────────────────────────

import type {
  Arrangement,
  LayoutConfig,
  RenderMetrics,
  LayoutTemplate,
  SlotMap,
  SlotName,
  SlotSpec,
  SlotRoster,
  LandmarkSlot,
} from "./types";
import type { Rotation3, Size2 } from "../mapper/types";
import { zeroRotation, angularPosition, angularRotation } from "./utils";

const RAD2DEG = 180 / Math.PI;

/**
 * "One cylinder around the viewer" wrap geometry.
 *
 * A panel placed tangent on the radius-`d` circle (via angularPosition +
 * angularRotation) and curved with `curveRadius = d` has its curve axis land
 * exactly on the viewer — so every panel that follows this rule shares ONE
 * user-centred cylinder and forms a continuous surround (the content panel at
 * angle 0 is just the special case). These helpers keep the landmark panels on
 * that cylinder, placed just outside the content panel's angular span so they
 * sit flush with its curved edges instead of reading as "behind" it.
 */

/** Half the arc (degrees) a flat `width` subtends wrapped on a radius-`d` cylinder. */
function halfArcDeg(width: number, d: number): number {
  return (width / 2 / d) * RAD2DEG;
}

/**
 * Signed centre angle (degrees) for a landmark placed just outside the main
 * panel's edge on the shared cylinder. `innerWidths` are any other landmarks
 * already occupying the arc between the main panel and this one (same side), so
 * successive panels stack outward without overlapping.
 */
function outsideMainDeg(
  side: 1 | -1,
  mainWidth: number,
  landmarkWidth: number,
  d: number,
  innerWidths: number[] = [],
  gapDeg = 3,
): number {
  let deg = halfArcDeg(mainWidth, d) + gapDeg;
  for (const w of innerWidths) deg += 2 * halfArcDeg(w, d) + gapDeg;
  deg += halfArcDeg(landmarkWidth, d);
  return side * deg;
}

/** A landmark slot placed tangent on the shared radius-`d` cylinder at `deg`. */
function wrapLandmark(
  d: number,
  deg: number,
  y: number,
  width: number,
  height: number,
): LandmarkSlot {
  return {
    position: angularPosition(d, deg, y),
    rotation: angularRotation(deg),
    size: { width, height },
    curveRadius: d,
    worldLocked: true,
  };
}

/**
 * DOCUMENT template
 * ```
 *  ←TOC arc   ←Nav   [ Main content panel (1.4 m wide) ]
 * ```
 * Main left edge at x=0 (world origin). TOC and nav arc to the left at
 * -ha and -(ha-8) degrees — comfortably separated from main's left edge.
 */
function documentSlots(cfg: LayoutConfig, metrics: RenderMetrics): SlotMap {
  const eyeY = cfg.eyeLevel + cfg.eyeLevelOffset;
  const d = cfg.viewingDistance;
  const ha = cfg.comfortHalfAngleDeg;
  return {
    banner: {
      position: { x: 0, y: eyeY + 0.52, z: -d },
      rotation: zeroRotation(),
      size: { width: 1.4, height: metrics.banner.height },
      curveRadius: d * 0.8,
      worldLocked: true,
    },
    toc: {
      position: angularPosition(d * 0.95, -ha, eyeY - 0.05),
      rotation: angularRotation(-ha),
      size: { width: 0.36, height: metrics.navigationBar.height },
      curveRadius: d,
      worldLocked: true,
    },
    navigation: {
      position: angularPosition(d, -(ha - 8), eyeY - 0.05),
      rotation: angularRotation(-(ha - 8)),
      size: { width: 0.32, height: metrics.navigationBar.height },
      curveRadius: d,
      worldLocked: true,
    },
    main: {
      position: { x: 0, y: eyeY, z: -d },
      rotation: zeroRotation(),
      size: { width: 1.4, height: cfg.maxPanelViewportHeight },
      curveRadius: d * 0.8,
      worldLocked: true,
    },
    complementary: {
      position: angularPosition(d, ha + 5, eyeY),
      rotation: angularRotation(ha - 8),
      // Sidebar width — kept slim (~a third of the 1.4 m main panel) so the
      // aside reads as secondary. Was full main-width, which looked oversized
      // once table/list pages fell through from the (removed) dashboard template.
      size: { width: 0.5, height: cfg.maxPanelViewportHeight },
      curveRadius: d,
      worldLocked: true,
    },
    footer: {
      position: { x: 0, y: eyeY - cfg.maxPanelViewportHeight * 0.6, z: -d },
      rotation: zeroRotation(),
      size: { width: 1.4, height: metrics.footer.height },
      curveRadius: d * 0.8,
      worldLocked: true,
    },
    alert: {
      position: { x: 0.4, y: eyeY + 0.35, z: -(d - 0.15) },
      rotation: { x: 0, y: -0.15, z: 0 },
      size: { width: 0.5, height: metrics.alert.minHeight },
      curveRadius: 0,
      worldLocked: false,
    },
    dialog: {
      position: { x: 0, y: eyeY, z: -(d - 0.2) },
      rotation: zeroRotation(),
      size: { width: 0.8, height: 0.6 },
      curveRadius: 0,
      worldLocked: false,
    },
  };
}

/**
 * LANDING template
 * ```
 * [       Hero / Main (1.8 m wide, panoramic)       ]
 *         ←Nav (bottom arc)
 * ```
 */
function landingSlots(cfg: LayoutConfig, metrics: RenderMetrics): SlotMap {
  const eyeY = cfg.eyeLevel + cfg.eyeLevelOffset;
  const d = cfg.viewingDistance;
  const ha = cfg.comfortHalfAngleDeg;
  return {
    banner: {
      position: { x: 0, y: eyeY + 0.54, z: -d },
      rotation: zeroRotation(),
      size: { width: 1.8, height: metrics.banner.height },
      curveRadius: d * 1.4,
      worldLocked: true,
    },
    toc: {
      position: angularPosition(d * 0.95, -ha, eyeY - 0.05),
      rotation: angularRotation(-ha),
      size: { width: 0.36, height: metrics.navigationBar.height },
      curveRadius: d,
      worldLocked: true,
    },
    navigation: {
      position: { x: 0, y: eyeY - 0.62, z: -(d - 0.1) },
      rotation: { x: 0.15, y: 0, z: 0 },
      size: { width: 1.6, height: 0.1 },
      curveRadius: d * 1.4,
      worldLocked: true,
    },
    main: {
      position: { x: 0, y: eyeY, z: -d },
      rotation: zeroRotation(),
      size: { width: 1.8, height: cfg.maxPanelViewportHeight },
      curveRadius: d * 1.4,
      worldLocked: true,
    },
    complementary: {
      position: angularPosition(d, ha, eyeY),
      rotation: angularRotation(ha),
      size: { width: 0.42, height: cfg.maxPanelViewportHeight },
      curveRadius: d,
      worldLocked: true,
    },
    footer: {
      position: { x: 0, y: eyeY - cfg.maxPanelViewportHeight * 0.6, z: -d },
      rotation: zeroRotation(),
      size: { width: 1.8, height: metrics.footer.height },
      curveRadius: d * 1.4,
      worldLocked: true,
    },
    alert: {
      position: { x: 0, y: eyeY + 0.45, z: -(d - 0.15) },
      rotation: zeroRotation(),
      size: { width: 0.6, height: metrics.alert.minHeight },
      curveRadius: 0,
      worldLocked: false,
    },
    dialog: {
      position: { x: 0, y: eyeY, z: -(d - 0.2) },
      rotation: zeroRotation(),
      size: { width: 0.85, height: 0.65 },
      curveRadius: 0,
      worldLocked: false,
    },
  };
}

/**
 * GENERIC template — safe fallback.
 */
function genericSlots(cfg: LayoutConfig, metrics: RenderMetrics): SlotMap {
  const eyeY = cfg.eyeLevel + cfg.eyeLevelOffset;
  const d = cfg.viewingDistance;
  const mainW = 1.6;
  const tocW = 0.36;
  const navW = 0.32;
  const compW = 0.42;
  return {
    banner: {
      position: { x: 0, y: eyeY + 0.52, z: -d },
      rotation: zeroRotation(),
      size: { width: mainW, height: metrics.banner.height },
      curveRadius: d,
      worldLocked: true,
    },
    toc: wrapLandmark(
      d,
      outsideMainDeg(-1, mainW, tocW, d),
      eyeY - 0.05,
      tocW,
      metrics.navigationBar.height,
    ),
    navigation: wrapLandmark(
      d,
      outsideMainDeg(-1, mainW, navW, d, [tocW]),
      eyeY - 0.05,
      navW,
      metrics.navigationBar.height,
    ),
    main: {
      position: { x: 0, y: eyeY, z: -d },
      rotation: zeroRotation(),
      size: { width: mainW, height: cfg.maxPanelViewportHeight },
      curveRadius: d,
      worldLocked: true,
    },
    complementary: wrapLandmark(
      d,
      outsideMainDeg(1, mainW, compW, d),
      eyeY,
      compW,
      cfg.maxPanelViewportHeight,
    ),
    footer: {
      position: { x: 0, y: eyeY - cfg.maxPanelViewportHeight * 0.6, z: -d },
      rotation: zeroRotation(),
      size: { width: 1.6, height: metrics.footer.height },
      curveRadius: d,
      worldLocked: true,
    },
    alert: {
      position: { x: 0.4, y: eyeY + 0.35, z: -(d - 0.15) },
      rotation: { x: 0, y: -0.15, z: 0 },
      size: { width: 0.5, height: metrics.alert.minHeight },
      curveRadius: 0,
      worldLocked: false,
    },
    dialog: {
      position: { x: 0, y: eyeY, z: -(d - 0.2) },
      rotation: zeroRotation(),
      size: { width: 0.8, height: 0.6 },
      curveRadius: 0,
      worldLocked: false,
    },
  };
}

/**
 * CAROUSEL template — five panels in a flat row, each rotated to face the
 * viewer and pushed back in z proportional to the rotation angle.
 *
 * Algorithm:
 *  1. Lay out all panels in a flat row: x positions from widths + constant gap.
 *  2. Rotate each panel by its facing angle (0° main, ±30° ghosts, ±60° toc/aside).
 *  3. Push z back via the cylindrical formula z = -d / cos(angle) so panels
 *     recede naturally as they rotate — the panel facing the viewer is always
 *     at effective depth d.
 *
 * Ghost panel angles and the gap constant are exported for the renderer.
 */
export const CAROUSEL_GHOST_PREV_ANGLE_DEG = -30;
export const CAROUSEL_GHOST_NEXT_ANGLE_DEG = 30;
/** World-space x-gap between adjacent carousel panels (metres). */
export const CAROUSEL_GHOST_GAP = 0.06;
/**
 * Z pull-forward step per tier (metres, toward the viewer).
 * Main = -d (tier 0), ghosts = -d + Z_STEP (tier 1), toc/aside = -d + 2*Z_STEP (tier 2).
 */
export const CAROUSEL_Z_STEP = 0.2;

/**
 * Placement of the two carousel "ghost" panels (prev/next page previews),
 * derived from the main content panel's position and size. Shared by the
 * renderer (which draws the ghosts) and the tuning HUD (which seeds its sliders
 * from these defaults), so both agree on where a ghost sits before tuning.
 */
export function carouselGhostPlacement(
  pos: { x: number; y: number; z: number },
  size: { width: number; height: number },
): {
  prev: { position: { x: number; y: number; z: number }; rotation: Rotation3 };
  next: { position: { x: number; y: number; z: number }; rotation: Rotation3 };
} {
  return {
    prev: {
      position: {
        x: pos.x - size.width + CAROUSEL_GHOST_GAP * 2.5,
        y: pos.y,
        z: pos.z + CAROUSEL_Z_STEP * 3.5,
      },
      rotation: angularRotation(CAROUSEL_GHOST_PREV_ANGLE_DEG),
    },
    next: {
      position: {
        x: pos.x + size.width + CAROUSEL_GHOST_GAP,
        y: pos.y,
        z: pos.z,
      },
      rotation: angularRotation(CAROUSEL_GHOST_NEXT_ANGLE_DEG),
    },
  };
}

function carouselSlots(cfg: LayoutConfig, metrics: RenderMetrics): SlotMap {
  const eyeY = cfg.eyeLevel + cfg.eyeLevelOffset;
  const d = cfg.viewingDistance;
  const MAIN_W = 1.4;
  const GAP = CAROUSEL_GHOST_GAP;
  const TOC_W = 0.36;
  const ASIDE_W = 0.5;

  // Flat row x positions (left edges, constant gap, no overlap).
  const mainX = -(MAIN_W / 2);
  const prevGhostX = mainX - GAP - MAIN_W;
  const nextGhostX = mainX + MAIN_W + GAP;
  const tocX = prevGhostX - TOC_W + GAP * 7;
  const asideX = nextGhostX + MAIN_W + GAP;

  // Facing angles for toc and aside (ghosts handled by the renderer).
  const TOC_DEG = -60;
  const ASIDE_DEG = 60;

  return {
    toc: {
      position: { x: tocX, y: eyeY, z: -d + 5.5 * CAROUSEL_Z_STEP },
      rotation: angularRotation(TOC_DEG),
      size: { width: TOC_W, height: metrics.navigationBar.height },
      curveRadius: 0,
      worldLocked: true,
    },
    main: {
      position: { x: mainX, y: eyeY, z: -d },
      rotation: zeroRotation(),
      size: { width: MAIN_W, height: cfg.maxPanelViewportHeight },
      curveRadius: d * 0.8,
      worldLocked: true,
    },
    complementary: {
      position: { x: asideX, y: eyeY, z: -d + 2 * CAROUSEL_Z_STEP },
      rotation: angularRotation(ASIDE_DEG),
      size: { width: ASIDE_W, height: cfg.maxPanelViewportHeight },
      curveRadius: 0,
      worldLocked: true,
    },
    banner: {
      position: { x: mainX, y: eyeY + 0.52, z: -d },
      rotation: zeroRotation(),
      size: { width: MAIN_W, height: metrics.banner.height },
      curveRadius: d * 0.8,
      worldLocked: true,
    },
    footer: {
      position: { x: mainX, y: eyeY - cfg.maxPanelViewportHeight * 0.6, z: -d },
      rotation: zeroRotation(),
      size: { width: MAIN_W, height: metrics.footer.height },
      curveRadius: d * 0.8,
      worldLocked: true,
    },
    alert: {
      position: { x: 0.4, y: eyeY + 0.35, z: -(d - 0.15) },
      rotation: { x: 0, y: -0.15, z: 0 },
      size: { width: 0.5, height: metrics.alert.minHeight },
      curveRadius: 0,
      worldLocked: false,
    },
    dialog: {
      position: { x: 0, y: eyeY, z: -(d - 0.2) },
      rotation: zeroRotation(),
      size: { width: 0.8, height: 0.6 },
      curveRadius: 0,
      worldLocked: false,
    },
  };
}

/**
 * THEATRE template
 * ```
 * [      Wide curved IMAX panel (2.4 m)      ]
 * TOC and aside as near-eye peripheral overlays (worldLocked=false)
 * ```
 */
function theatreSlots(cfg: LayoutConfig, metrics: RenderMetrics): SlotMap {
  const eyeY = cfg.eyeLevel + cfg.eyeLevelOffset;
  const d = cfg.viewingDistance;
  const mw = 2.4;
  const mhw = mw / 2;
  const tocW = 0.36;
  const navW = 0.32;
  const compW = 0.42;
  // IMAX wrap: the wide panel curves around the viewer on the shared cylinder,
  // and TOC/nav/aside sit tangent just beyond its (wide) angular edges so they
  // continue the wrap instead of floating flat in front of it.
  const tocDeg = outsideMainDeg(-1, mw, tocW, d);
  const navDeg = outsideMainDeg(-1, mw, navW, d, [tocW]);
  const compDeg = outsideMainDeg(1, mw, compW, d);
  return {
    main: {
      position: { x: -mhw, y: eyeY, z: -d },
      rotation: zeroRotation(),
      size: { width: mw, height: cfg.maxPanelViewportHeight },
      curveRadius: d,
      worldLocked: true,
    },
    toc: {
      position: angularPosition(d, tocDeg, eyeY),
      rotation: angularRotation(tocDeg),
      size: { width: tocW, height: metrics.navigationBar.height },
      curveRadius: d,
      worldLocked: true,
    },
    navigation: {
      position: angularPosition(d, navDeg, eyeY),
      rotation: angularRotation(navDeg),
      size: { width: navW, height: metrics.navigationBar.height },
      curveRadius: d,
      worldLocked: true,
    },
    complementary: {
      position: angularPosition(d, compDeg, eyeY),
      rotation: angularRotation(compDeg),
      size: { width: compW, height: cfg.maxPanelViewportHeight * 0.7 },
      curveRadius: d,
      worldLocked: true,
    },
    alert: {
      position: { x: 0, y: eyeY - 0.5, z: -(d - 0.15) },
      rotation: zeroRotation(),
      size: { width: 0.6, height: metrics.alert.minHeight },
      curveRadius: 0,
      worldLocked: false,
    },
    dialog: {
      position: { x: 0, y: eyeY, z: -(d - 0.2) },
      rotation: zeroRotation(),
      size: { width: 0.85, height: 0.65 },
      curveRadius: 0,
      worldLocked: false,
    },
    banner: {
      position: { x: -mhw, y: eyeY + 0.56, z: -d },
      rotation: zeroRotation(),
      size: { width: mw, height: metrics.banner.height },
      curveRadius: d,
      worldLocked: true,
    },
    footer: {
      position: { x: -mhw, y: eyeY - cfg.maxPanelViewportHeight * 0.6, z: -d },
      rotation: zeroRotation(),
      size: { width: mw, height: metrics.footer.height },
      curveRadius: d,
      worldLocked: true,
    },
  };
}

/**
 * Landmark slots use a top-left x origin: `position.x` is the panel's LEFT
 * edge, so a slot authored at `x: 0` actually sits centred at `+width/2` —
 * pushing wide panels off to the right of the viewer. For the page-style
 * templates (single stacked column: main + banner + footer), re-anchor those
 * panels so they're horizontally centred on the gaze axis. The peripheral
 * slots (toc / nav / complementary) are intentionally off to the side and are
 * left untouched.
 */
function centreStackedPanels(map: SlotMap): SlotMap {
  for (const key of ["main", "banner", "footer"] as const) {
    const slot = map[key];
    if (slot) slot.position.x = -slot.size.width / 2;
  }
  // Keep the left-hand TOC sidebar clear of the now-centred main panel. Panels
  // use a TOP-LEFT x origin, so a panel at position.x spans [x, x + width]:
  // the main's left edge is main.position.x and the TOC's right edge is
  // toc.position.x + toc.size.width. If the TOC would intrude past the main's
  // left edge, shift it left so its right edge clears with a small gap.
  const main = map.main;
  const toc = map.toc;
  if (main && toc) {
    const gap = 0.08;
    const mainLeft = main.position.x;
    const tocRight = toc.position.x + toc.size.width;
    if (tocRight > mainLeft - gap) {
      toc.position.x = mainLeft - gap - toc.size.width;
    }
  }
  return map;
}

export function selectSlots(
  template: LayoutTemplate,
  cfg: LayoutConfig,
  metrics: RenderMetrics,
): SlotMap {
  switch (template) {
    case "document":
      return centreStackedPanels(documentSlots(cfg, metrics));
    case "landing":
      return centreStackedPanels(landingSlots(cfg, metrics));
    case "carousel":
      return carouselSlots(cfg, metrics);
    case "theatre":
      return theatreSlots(cfg, metrics);
    default:
      return centreStackedPanels(genericSlots(cfg, metrics));
  }
}

// ═════════════════════════════════════════════════════════════
// Two-axis view system — arrangements & distributions
//
// A view = a reference frame + a distribution, composed over whatever content
// template the scene auto-selects. selectSlots (above) provides the roster's
// slot sizing; a distribution turns that roster into a positioned SlotMap.
// ═════════════════════════════════════════════════════════════

// ── Arrangement registry ─────────────────────────────────────

/**
 * The declarative view catalogue. Adding a spatial view is a data entry here
 * plus a distribution function below — no bespoke SlotMap.
 */
export const ARRANGEMENTS: Record<string, Arrangement> = {
  focus: {
    id: "focus",
    frame: "world",
    distribution: "focus",
    deviceFit: ["headset-6dof", "headset-roomscale", "glasses"],
  },
  stack: {
    id: "stack",
    frame: "world",
    distribution: "stack",
    deviceFit: ["headset-6dof", "headset-roomscale"],
  },
  orbital: {
    id: "orbital",
    frame: "body",
    distribution: "ring",
    deviceFit: ["headset-6dof", "headset-roomscale"],
  },
  palm: {
    id: "palm",
    frame: "hand",
    distribution: "palm",
    deviceFit: ["headset-6dof", "headset-roomscale"],
  },
  gallery: {
    id: "gallery",
    frame: "world",
    distribution: "corridor",
    deviceFit: ["headset-roomscale"],
  },
};

export function getArrangement(
  id: string | undefined,
): Arrangement | undefined {
  if (!id) return undefined;
  return ARRANGEMENTS[id];
}

// ── Roster derivation (content template → ordered slot specs) ─

/**
 * Reading-priority order. `main` is always primary; the rest descend so that
 * distributions can compress/recede/angle by importance deterministically.
 * `alert`/`dialog` are intentionally excluded — modal overlays are never
 * scattered by a distribution; they always come from the template's own head-on
 * overlay slots (see resolveArrangementSlots).
 */
const PRIORITY: SlotName[] = [
  "main",
  "complementary",
  "toc",
  "navigation",
  "banner",
  "footer",
];

/**
 * Build a SlotRoster from the auto-selected content template. We reuse the
 * template's own slot sizing (so per-template width/height intelligence is
 * preserved) but drop its positions — those are the arrangement's job.
 */
export function rosterFor(
  template: LayoutTemplate,
  cfg: LayoutConfig,
  metrics: RenderMetrics,
): SlotRoster {
  const base = selectSlots(template, cfg, metrics);
  const present = PRIORITY.filter((role) => base[role] !== undefined);
  return present.map((role, i) => ({
    role,
    size: { ...base[role]!.size },
    weight: 1 - i / Math.max(present.length, 1),
  }));
}

// ── Distribution algorithms ──────────────────────────────────

type DistributeFn = (
  roster: SlotRoster,
  cfg: LayoutConfig,
  metrics: RenderMetrics,
) => SlotMap;

// ── Shared helpers ───────────────────────────────────────────

/**
 * Peripheral rails are width-capped so a scattered arrangement never places a
 * full main-width (≈1.4 m) panel beside another — the cause of overlap. Height
 * is capped to the viewport so tall side panels stay comfortable.
 */
const RAIL_MAX_W = 0.5;

function railSize(spec: SlotSpec, cfg: LayoutConfig): Size2 {
  return {
    width: Math.min(spec.size.width, RAIL_MAX_W),
    height: Math.min(spec.size.height, cfg.maxPanelViewportHeight),
  };
}

/** The panels a distribution scatters: everything except main and banner/footer. */
function railsOf(roster: SlotRoster): SlotRoster {
  return roster.filter(
    (s) => s.role !== "main" && s.role !== "banner" && s.role !== "footer",
  );
}

/** Angular half-width (deg) a panel of the given width subtends at radius `d`. */
function halfAngleDeg(width: number, d: number): number {
  return (Math.atan2(width / 2, d) * 180) / Math.PI;
}

/**
 * Attach banner above / footer below the primary panel, sharing its x-centre,
 * depth, rotation and curve — so page chrome stays with the content instead of
 * being scattered into the workspace as free-floating full-width bars.
 */
function attachBannerFooter(
  map: SlotMap,
  roster: SlotRoster,
  mainX: number,
  mainZ: number,
  rotation: Rotation3,
  curveRadius: number,
  cfg: LayoutConfig,
): void {
  const eyeY = cfg.eyeLevel + cfg.eyeLevelOffset;
  const banner = roster.find((s) => s.role === "banner");
  if (banner) {
    map.banner = {
      position: { x: mainX, y: eyeY + banner.size.height + 0.04, z: mainZ },
      rotation,
      size: banner.size,
      curveRadius,
      worldLocked: true,
    };
  }
  const footer = roster.find((s) => s.role === "footer");
  if (footer) {
    map.footer = {
      position: {
        x: mainX,
        y: eyeY - cfg.maxPanelViewportHeight - 0.04,
        z: mainZ,
      },
      rotation,
      size: footer.size,
      curveRadius,
      worldLocked: true,
    };
  }
}

// ── Distribution implementations ─────────────────────────────

/**
 * FAN — classic front-facing spread: primary centred at -d, peripheral rails
 * arced left/right by the comfort half-angle. Generic fallback for any roster.
 */
const fan: DistributeFn = (roster, cfg) => {
  const eyeY = cfg.eyeLevel + cfg.eyeLevelOffset;
  const d = cfg.viewingDistance;
  const ha = cfg.comfortHalfAngleDeg;
  const map: SlotMap = {};
  const main = roster.find((s) => s.role === "main");
  const mainW = main?.size.width ?? 1.4;
  if (main) {
    map.main = {
      position: { x: -mainW / 2, y: eyeY, z: -d },
      rotation: zeroRotation(),
      size: main.size,
      curveRadius: d * 0.8,
      worldLocked: true,
    };
  }
  attachBannerFooter(map, roster, -mainW / 2, -d, zeroRotation(), d * 0.8, cfg);
  railsOf(roster).forEach((spec, i) => {
    const goLeft = i % 2 === 0;
    const step = Math.floor(i / 2) + 1;
    const angle = (goLeft ? -1 : 1) * (ha - 4 + (step - 1) * 8);
    map[spec.role] = {
      position: angularPosition(d, angle, eyeY),
      rotation: angularRotation(angle),
      size: railSize(spec, cfg),
      curveRadius: 0,
      worldLocked: true,
    };
  });
  return map;
};

/**
 * FOCUS — focus+context reading. Primary at full legibility dead ahead; every
 * other role collapses to a thin peripheral ribbon at ±(ha+10)°, stacked
 * vertically, its width shrinking with lower reading priority (deeper content).
 */
const focus: DistributeFn = (roster, cfg) => {
  const eyeY = cfg.eyeLevel + cfg.eyeLevelOffset;
  const d = cfg.viewingDistance;
  const ha = cfg.comfortHalfAngleDeg;
  const map: SlotMap = {};
  let leftY = eyeY + 0.25;
  let rightY = eyeY + 0.25;
  const RIBBON_H = 0.34;
  const GAP = 0.06;
  let toggle = false;
  for (const spec of roster) {
    if (spec.role === "main") {
      map.main = {
        position: { x: -spec.size.width / 2, y: eyeY, z: -d },
        rotation: zeroRotation(),
        size: spec.size,
        curveRadius: d * 0.7,
        worldLocked: true,
      };
      continue;
    }
    // Ribbon: compressed width scales with reading priority.
    const ribbonW = 0.07 + spec.weight * 0.05;
    const goLeft = !(toggle = !toggle);
    const angle = (goLeft ? -1 : 1) * (ha + 10);
    const yRef = goLeft
      ? (leftY -= RIBBON_H + GAP)
      : (rightY -= RIBBON_H + GAP);
    const pos = angularPosition(d * 0.98, angle, yRef);
    map[spec.role] = {
      position: pos,
      rotation: angularRotation(angle),
      size: { width: ribbonW, height: RIBBON_H },
      curveRadius: 0,
      worldLocked: true,
    };
  }
  return map;
};

/**
 * STACK — depth hierarchy. Primary at -d; each rail recedes along -Z and peeks
 * out beside the main panel (alternating sides), so secondary landmarks read as
 * a fanned card stack behind the content rather than hidden directly behind it.
 * The one axis flat web can't use. (Pull-to-front drill is a deferred interaction.)
 */
const stack: DistributeFn = (roster, cfg) => {
  const eyeY = cfg.eyeLevel + cfg.eyeLevelOffset;
  const d = cfg.viewingDistance;
  const map: SlotMap = {};
  const main = roster.find((s) => s.role === "main");
  const mainW = main?.size.width ?? 1.4;
  const mainX = -mainW / 2;
  if (main) {
    map.main = {
      position: { x: mainX, y: eyeY, z: -d },
      rotation: zeroRotation(),
      size: main.size,
      curveRadius: d * 0.8,
      worldLocked: true,
    };
  }
  attachBannerFooter(map, roster, mainX, -d, zeroRotation(), d * 0.8, cfg);
  railsOf(roster).forEach((spec, i) => {
    const size = railSize(spec, cfg);
    const layer = i + 1;
    const goLeft = i % 2 === 0;
    const z = -d - layer * 0.45;
    const y = eyeY + 0.05 + Math.floor(i / 2) * 0.05;
    const x = goLeft ? mainX - 0.12 - size.width : mainX + mainW + 0.12;
    map[spec.role] = {
      position: { x, y, z },
      rotation: zeroRotation(),
      size,
      curveRadius: d * 0.8,
      worldLocked: true,
    };
  });
  return map;
};

/**
 * RING — body-locked cylinder. Primary faces forward; rails are placed around
 * the cylinder by CUMULATIVE angle so no two panels overlap: each rail reserves
 * its own angular width plus a gap beyond the previous panel's trailing edge.
 * Navigate by physically turning; the body frame keeps the ring comfortable.
 */
const ring: DistributeFn = (roster, cfg) => {
  const eyeY = cfg.eyeLevel + cfg.eyeLevelOffset;
  const d = cfg.viewingDistance;
  const map: SlotMap = {};
  const GAP_DEG = 8;
  const main = roster.find((s) => s.role === "main");
  const mainW = main?.size.width ?? 1.4;
  if (main) {
    // Front panel is centred on the gaze axis (top-left-x anchor at -mainW/2),
    // matching the carousel/standard convention — angularPosition(0) would put
    // its left edge on-axis and shove the panel off to the right.
    map.main = {
      position: { x: -mainW / 2, y: eyeY, z: -d },
      rotation: zeroRotation(),
      size: main.size,
      curveRadius: d,
      worldLocked: true,
    };
  }
  attachBannerFooter(map, roster, -mainW / 2, -d, zeroRotation(), d, cfg);
  // Trailing-edge angle already consumed on each side (starts at main's edge).
  let leftEdge = halfAngleDeg(mainW, d);
  let rightEdge = halfAngleDeg(mainW, d);
  railsOf(roster).forEach((spec, i) => {
    const size = railSize(spec, cfg);
    const rh = halfAngleDeg(size.width, d);
    const goLeft = i % 2 === 0;
    let center: number;
    if (goLeft) {
      center = -(leftEdge + GAP_DEG + rh);
      leftEdge += GAP_DEG + 2 * rh;
    } else {
      center = rightEdge + GAP_DEG + rh;
      rightEdge += GAP_DEG + 2 * rh;
    }
    // Tangent on the same radius-d cylinder as main → one continuous surround
    // (curveRadius d makes each rail's curve axis land on the viewer).
    map[spec.role] = {
      position: angularPosition(d, center, eyeY),
      rotation: angularRotation(center),
      size,
      curveRadius: d,
      worldLocked: true,
    };
  });
  return map;
};

/**
 * CORRIDOR — gallery walk. Primary ahead; rails become alternating left/right
 * "wall" panels (width-capped, cleared of the main panel) receding in z, angled
 * inward. Reading order is a walking path (room-scale). World-locked.
 */
const corridor: DistributeFn = (roster, cfg) => {
  const eyeY = cfg.eyeLevel + cfg.eyeLevelOffset;
  const d = cfg.viewingDistance;
  const map: SlotMap = {};
  const WALL_GAP = 0.35;
  const Z_STEP = 0.9;
  const main = roster.find((s) => s.role === "main");
  const mainW = main?.size.width ?? 1.4;
  const mainX = -mainW / 2;
  if (main) {
    map.main = {
      position: { x: mainX, y: eyeY, z: -d },
      rotation: zeroRotation(),
      size: main.size,
      curveRadius: 0,
      worldLocked: true,
    };
  }
  attachBannerFooter(map, roster, mainX, -d, zeroRotation(), 0, cfg);
  railsOf(roster).forEach((spec, i) => {
    const size = railSize(spec, cfg);
    const goLeft = i % 2 === 0;
    const row = Math.floor(i / 2) + 1;
    const x = goLeft ? mainX - WALL_GAP - size.width : mainX + mainW + WALL_GAP;
    const yawDeg = goLeft ? 35 : -35; // turn each wall inward toward the path
    map[spec.role] = {
      position: { x, y: eyeY, z: -d - row * Z_STEP },
      rotation: { x: 0, y: (yawDeg * Math.PI) / 180, z: 0 },
      size,
      curveRadius: 0,
      worldLocked: true,
    };
  });
  return map;
};

/**
 * PALM — hand-anchored tablet. A compact primary panel sits ~0.4 m ahead and
 * below, tilted toward the face; peripheral roles become small chips above it.
 * Positions are authored in the hand frame — the ReferenceFrameGroup anchors
 * the whole map to a controller grip in XR (identity in flat preview).
 */
const palm: DistributeFn = (roster) => {
  const map: SlotMap = {};
  const PANEL_W = 0.34;
  const PANEL_H = 0.5;
  const TILT = 0.5; // radians, tipped back toward the face
  let chip = 0;
  for (const spec of roster) {
    if (spec.role === "main") {
      map.main = {
        position: { x: -PANEL_W / 2, y: 0.02, z: -0.42 },
        rotation: { x: TILT, y: 0, z: 0 },
        size: { width: PANEL_W, height: PANEL_H },
        curveRadius: 0,
        worldLocked: true,
      };
      continue;
    }
    const col = chip % 3;
    const rowUp = Math.floor(chip / 3);
    chip++;
    map[spec.role] = {
      position: {
        x: -PANEL_W / 2 + col * (PANEL_W / 3),
        y: 0.02 + PANEL_H * 0.55 + rowUp * 0.08,
        z: -0.42,
      },
      rotation: { x: TILT, y: 0, z: 0 },
      size: { width: PANEL_W / 3 - 0.01, height: 0.07 },
      curveRadius: 0,
      worldLocked: true,
    };
  }
  return map;
};

const DISTRIBUTIONS: Record<string, DistributeFn> = {
  fan,
  focus,
  stack,
  ring,
  corridor,
  palm,
};

/**
 * Resolve a fully-positioned SlotMap for an arrangement composed over a content
 * template. This is the arrangement-path replacement for `selectSlots`.
 */
export function resolveArrangementSlots(
  arrangement: Arrangement,
  template: LayoutTemplate,
  cfg: LayoutConfig,
  metrics: RenderMetrics,
): SlotMap {
  const roster = rosterFor(template, cfg, metrics);
  const distribute = DISTRIBUTIONS[arrangement.distribution] ?? fan;
  const map = distribute(roster, cfg, metrics);
  // Modal overlays always sit head-on, near the viewer — reuse the template's
  // own alert/dialog slots so overlays are never lost by a distribution.
  const base = selectSlots(template, cfg, metrics);
  if (!map.alert && base.alert) map.alert = base.alert;
  if (!map.dialog && base.dialog) map.dialog = base.dialog;
  return map;
}
