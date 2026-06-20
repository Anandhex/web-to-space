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
      size: { width: 0.5, height: metrics.navigationBar.height },
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
      size: { width: 0.42, height: 0.75 },
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
      size: { width: 0.42, height: 0.8 },
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

export function selectSlots(
  template: LayoutTemplate,
  cfg: LayoutConfig,
  metrics: RenderMetrics,
): SlotMap {
  switch (template) {
    case "document":
      return documentSlots(cfg, metrics);
    case "dashboard":
      return dashboardSlots(cfg, metrics);
    case "form":
      return formSlots(cfg, metrics);
    case "landing":
      return landingSlots(cfg, metrics);
    default:
      return genericSlots(cfg, metrics);
  }
}
