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
      position: { x: -0.81, y: 1.41, z: -0.49 },
      rotation: { x: 0, y: 1.248, z: 0 },
      size: { width: 0.36, height: 0.9 },
      curveRadius: 0.62,
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
      position: { x: 0.7, y: 1.4, z: -0.9 },
      rotation: { x: 0, y: -1.122, z: 0 },
      size: { width: 0.5, height: 0.9 },
      curveRadius: 1.2,
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
  _size: { width: number; height: number },
): {
  prev: { position: { x: number; y: number; z: number }; rotation: Rotation3 };
  next: { position: { x: number; y: number; z: number }; rotation: Rotation3 };
} {
  return {
    prev: {
      // QUEST_3 · carousel ghost · prev — offsets from main in scene-graph.tsx
      position: {
        x: pos.x - 1.02,
        y: pos.y - 0.01,
        z: pos.z + 1.17,
      },
      rotation: angularRotation(-46.868),
    },

    next: {
      // QUEST_3 · carousel ghost · next — offsets from main in scene-graph.tsx
      position: {
        x: pos.x + 1.45,
        y: pos.y - 0.01,
        z: pos.z + 0.14,
      },
      rotation: angularRotation(52.803),
    },
  };
}

function carouselSlots(cfg: LayoutConfig, metrics: RenderMetrics): SlotMap {
  const eyeY = cfg.eyeLevel + cfg.eyeLevelOffset;
  const d = cfg.viewingDistance;
  const MAIN_W = 1.4;
  // Main sits centred; toc / complementary / ghosts are hand-placed below
  // (ghosts via carouselGhostPlacement in the renderer).
  const mainX = -(MAIN_W / 2);

  return {
    toc: {
      position: { x: -1.81, y: 1.37, z: 0.41 },
      rotation: { x: 0, y: 1.047, z: 0 },
      // Same height as the content panel (main); width kept slim.
      size: { width: 0.36, height: cfg.maxPanelViewportHeight },
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
      position: { x: 1.45, y: 1.4, z: 0.18 },
      rotation: { x: 0, y: -1.437, z: 0 },
      size: { width: 0.5, height: 0.9 },
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
  // The peripheral slots (toc / nav / complementary) are hand-authored per
  // template and left exactly as placed — no auto-shift — so their tuned poses
  // survive centring of the stacked column above.
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
  // ── Page views (content-only) ──────────────────────────────
  // The page SET is the spatial structure: the roster collapses to [main]
  // (see resolveArrangementSlots) and the renderer scatters page ghosts via
  // src/renderer/page-placements.ts. All world-framed: the page field is an
  // exocentric structure the user surveys, not a HUD.
  elevator: {
    id: "elevator",
    frame: "world",
    distribution: "fan",
    deviceFit: ["headset-6dof", "headset-roomscale", "glasses"],
    pageDistribution: "elevator",
  },
  wall: {
    id: "wall",
    frame: "world",
    distribution: "fan",
    deviceFit: ["headset-6dof", "headset-roomscale"],
    pageDistribution: "wall",
  },
  deck: {
    id: "deck",
    frame: "world",
    distribution: "fan",
    deviceFit: ["headset-6dof", "headset-roomscale"],
    pageDistribution: "deck",
  },
  rooms: {
    id: "rooms",
    frame: "world",
    distribution: "fan",
    deviceFit: ["headset-6dof", "headset-roomscale"],
    pageDistribution: "rooms",
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

// ── Overlap-safety helpers ───────────────────────────────────
//
// The in-world chrome (view-mode toggle + tab bar) is anchored to the main
// panel: the toggle sits ~1.1 m above the panel's bottom edge and the tab bar
// ~0.3 m below it, both centred on the panel's x. That makes the vertical strip
// through the panel centre a KEEP-OUT COLUMN (main panel + both chrome bars),
// so anything a distribution places must keep its full width outside it.

/** Bottom edge (world y) of the main viewport — where the chrome anchors. */
function chromeBottomY(cfg: LayoutConfig): number {
  return cfg.eyeLevel + cfg.eyeLevelOffset - cfg.maxPanelViewportHeight;
}

/** Top edge (world y) of the view-mode toggle bar, so content can clear it. */
function toggleTopY(cfg: LayoutConfig): number {
  return chromeBottomY(cfg) + 1.1 + 0.1;
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
    // Float the header ABOVE the view-mode toggle (which is anchored just above
    // the panel), not in the small gap between panel-top and toggle where it
    // would collide with the toggle bar.
    map.banner = {
      position: {
        x: mainX,
        y: toggleTopY(cfg) + 0.06 + banner.size.height,
        z: mainZ,
      },
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

const DISTRIBUTIONS: Record<string, DistributeFn> = {
  fan,
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
  let roster = rosterFor(template, cfg, metrics);
  // Content-only page views: the page set replaces the landmark panels, so
  // only the main slot survives. With no complementary/banner/footer slots
  // in the map the engine's extraction passes never fire — folded landmarks
  // paginate in-flow (see layout/content-only.ts).
  if (arrangement.pageDistribution && arrangement.pageDistribution !== "flip") {
    roster = roster.filter((s) => s.role === "main");
  }
  const distribute = DISTRIBUTIONS[arrangement.distribution] ?? fan;
  const map = distribute(roster, cfg, metrics);
  // Modal overlays always sit head-on, near the viewer — reuse the template's
  // own alert/dialog slots so overlays are never lost by a distribution.
  const base = selectSlots(template, cfg, metrics);
  if (!map.alert && base.alert) map.alert = base.alert;
  if (!map.dialog && base.dialog) map.dialog = base.dialog;
  return map;
}
