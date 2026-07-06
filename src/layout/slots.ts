// ─────────────────────────────────────────────────────────────
// Template slot descriptors
// ─────────────────────────────────────────────────────────────

import type {
  LayoutConfig,
  RenderMetrics,
  LayoutTemplate,
  SlotMap,
} from "./types";
import { zeroRotation, angularPosition, angularRotation } from "./utils";

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
      size: { width: 1.4, height: cfg.maxPanelViewportHeight },
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
 * DASHBOARD template
 * ```
 * ←Nav   [ Main / Cards (1.4 m wide) ]   Sidebar →
 * ```
 */
function dashboardSlots(cfg: LayoutConfig, metrics: RenderMetrics): SlotMap {
  const eyeY = cfg.eyeLevel + cfg.eyeLevelOffset;
  const d = cfg.viewingDistance;
  const ha = cfg.comfortHalfAngleDeg;
  return {
    banner: {
      position: { x: 0, y: eyeY + 0.5, z: -d },
      rotation: zeroRotation(),
      size: { width: 1.6, height: metrics.banner.height },
      curveRadius: d * 1.2,
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
      position: angularPosition(d, -(ha - 8), eyeY),
      rotation: angularRotation(-(ha - 8)),
      size: { width: 0.32, height: metrics.navigationBar.height },
      curveRadius: d,
      worldLocked: true,
    },
    main: {
      position: { x: 0, y: eyeY, z: -d },
      rotation: zeroRotation(),
      size: { width: 1.4, height: cfg.maxPanelViewportHeight },
      curveRadius: d * 1.2,
      worldLocked: true,
    },
    complementary: {
      position: angularPosition(d, ha + 5, eyeY),
      rotation: angularRotation(ha + 5),
      size: { width: 0.5, height: cfg.maxPanelViewportHeight },
      curveRadius: d,
      worldLocked: true,
    },
    footer: {
      position: { x: 0, y: eyeY - cfg.maxPanelViewportHeight * 0.6, z: -d },
      rotation: zeroRotation(),
      size: { width: 1.6, height: metrics.footer.height },
      curveRadius: d * 1.2,
      worldLocked: true,
    },
    alert: {
      position: { x: 0.5, y: eyeY + 0.4, z: -(d - 0.15) },
      rotation: { x: 0, y: -0.18, z: 0 },
      size: { width: 0.5, height: metrics.alert.minHeight },
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
 * FORM template
 * ```
 *       [ Form (1.1 m wide, flat) ]
 * ```
 * Flat panel — curved panels make input targets harder to hit precisely.
 */
function formSlots(cfg: LayoutConfig, metrics: RenderMetrics): SlotMap {
  const eyeY = cfg.eyeLevel + cfg.eyeLevelOffset;
  const d = cfg.viewingDistance;
  const ha = cfg.comfortHalfAngleDeg;
  return {
    banner: {
      position: { x: 0, y: eyeY + 0.58, z: -d },
      rotation: zeroRotation(),
      size: { width: 1.1, height: metrics.banner.height },
      curveRadius: 0,
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
      position: { x: -0.65, y: eyeY, z: -(d + 0.4) },
      rotation: angularRotation(-20),
      size: { width: 0.32, height: 0.8 },
      curveRadius: 0,
      worldLocked: true,
    },
    main: {
      position: { x: 0, y: eyeY, z: -d },
      rotation: zeroRotation(),
      size: { width: 1.1, height: cfg.maxPanelViewportHeight },
      curveRadius: 0,
      worldLocked: true,
    },
    complementary: {
      position: angularPosition(d, ha + 5, eyeY),
      rotation: angularRotation(ha + 5),
      size: { width: 0.42, height: cfg.maxPanelViewportHeight },
      curveRadius: d,
      worldLocked: true,
    },
    alert: {
      position: { x: 0, y: eyeY - 0.62, z: -(d - 0.1) },
      rotation: zeroRotation(),
      size: { width: 1.0, height: metrics.alert.minHeight },
      curveRadius: 0,
      worldLocked: true,
    },
    dialog: {
      position: { x: 0, y: eyeY, z: -(d - 0.2) },
      rotation: zeroRotation(),
      size: { width: 0.75, height: 0.6 },
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
  const ha = cfg.comfortHalfAngleDeg;
  return {
    banner: {
      position: { x: 0, y: eyeY + 0.52, z: -d },
      rotation: zeroRotation(),
      size: { width: 1.6, height: metrics.banner.height },
      curveRadius: d,
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
      size: { width: 1.6, height: cfg.maxPanelViewportHeight },
      curveRadius: d,
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
  const tocX = prevGhostX - GAP - TOC_W;
  const asideX = nextGhostX + MAIN_W + GAP;

  // Facing angles for toc and aside (ghosts handled by the renderer).
  const TOC_DEG = -60;
  const ASIDE_DEG = 60;

  return {
    toc: {
      position: { x: tocX, y: eyeY - 0.05, z: -d + 2 * CAROUSEL_Z_STEP },
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
 * CARDS template
 * ```
 * ←TOC  [ Grid of compact section cards (1.8 m wide) ]  aside→
 * ```
 * Wider main panel to fit the card grid. The engine paginates the grid so
 * sections are distributed across pages (≈12 cards per page).
 */
function cardsSlots(cfg: LayoutConfig, metrics: RenderMetrics): SlotMap {
  const eyeY = cfg.eyeLevel + cfg.eyeLevelOffset;
  const d = cfg.viewingDistance;
  const ha = cfg.comfortHalfAngleDeg;
  const MAIN_W = 1.8;
  const mainX = -(MAIN_W / 2); // centre the panel on the viewer's gaze axis
  return {
    banner: {
      position: { x: mainX, y: eyeY + 0.52, z: -d },
      rotation: zeroRotation(),
      size: { width: MAIN_W, height: metrics.banner.height },
      curveRadius: d * 1.2,
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
      position: { x: mainX, y: eyeY, z: -d },
      rotation: zeroRotation(),
      size: { width: MAIN_W, height: cfg.maxPanelViewportHeight },
      curveRadius: d * 1.2,
      worldLocked: true,
    },
    complementary: {
      position: angularPosition(d, ha + 5, eyeY),
      rotation: angularRotation(ha + 5),
      size: { width: 0.36, height: cfg.maxPanelViewportHeight },
      curveRadius: d,
      worldLocked: true,
    },
    footer: {
      position: { x: mainX, y: eyeY - cfg.maxPanelViewportHeight * 0.6, z: -d },
      rotation: zeroRotation(),
      size: { width: MAIN_W, height: metrics.footer.height },
      curveRadius: d * 1.2,
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
 * DOOR template
 * ```
 * ←TOC  [ Current drill level (paginated) ]
 * ```
 * TOC always pinned. The main panel shows the current drill level's content.
 * No complementary — keeps focus on the current drill level.
 */
function doorSlots(cfg: LayoutConfig, metrics: RenderMetrics): SlotMap {
  const eyeY = cfg.eyeLevel + cfg.eyeLevelOffset;
  const d = cfg.viewingDistance;
  const ha = cfg.comfortHalfAngleDeg;
  const MAIN_W = 1.4;
  const mainX = -(MAIN_W / 2); // centre the panel on the viewer's gaze axis
  return {
    banner: {
      position: { x: mainX, y: eyeY + 0.52, z: -d },
      rotation: zeroRotation(),
      size: { width: MAIN_W, height: metrics.banner.height },
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
      position: { x: mainX, y: eyeY, z: -d },
      rotation: zeroRotation(),
      size: { width: MAIN_W, height: cfg.maxPanelViewportHeight },
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
  return {
    main: {
      position: { x: -mhw, y: eyeY, z: -d },
      rotation: zeroRotation(),
      size: { width: mw, height: cfg.maxPanelViewportHeight },
      curveRadius: d * 2.0,
      worldLocked: true,
    },
    // TOC and aside flank the wide panel *outside* its horizontal extent
    // (|x| > mhw) so they never overlap the main content, angled inward and
    // pulled slightly toward the viewer to wrap the theatre around the user.
    toc: {
      position: { x: -(mhw + 0.28), y: eyeY, z: -(d - 0.25) },
      rotation: { x: 0, y: 0.5, z: 0 },
      size: { width: 0.36, height: metrics.navigationBar.height },
      curveRadius: 0,
      worldLocked: true,
    },
    navigation: {
      position: { x: -(mhw + 0.28), y: eyeY - metrics.navigationBar.height - 0.06, z: -(d - 0.25) },
      rotation: { x: 0, y: 0.5, z: 0 },
      size: { width: 0.32, height: metrics.navigationBar.height },
      curveRadius: 0,
      worldLocked: true,
    },
    complementary: {
      position: { x: mhw + 0.28, y: eyeY, z: -(d - 0.25) },
      rotation: { x: 0, y: -0.5, z: 0 },
      size: { width: 0.42, height: cfg.maxPanelViewportHeight * 0.7 },
      curveRadius: 0,
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
      curveRadius: d * 2.0,
      worldLocked: true,
    },
    footer: {
      position: { x: -mhw, y: eyeY - cfg.maxPanelViewportHeight * 0.6, z: -d },
      rotation: zeroRotation(),
      size: { width: mw, height: metrics.footer.height },
      curveRadius: d * 2.0,
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
    case "dashboard":
      return centreStackedPanels(dashboardSlots(cfg, metrics));
    case "form":
      return centreStackedPanels(formSlots(cfg, metrics));
    case "landing":
      return centreStackedPanels(landingSlots(cfg, metrics));
    case "carousel":
      return carouselSlots(cfg, metrics);
    case "cards":
      return cardsSlots(cfg, metrics);
    case "door":
      return doorSlots(cfg, metrics);
    case "theatre":
      return theatreSlots(cfg, metrics);
    default:
      return centreStackedPanels(genericSlots(cfg, metrics));
  }
}
