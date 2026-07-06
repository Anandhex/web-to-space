// ─────────────────────────────────────────────────────────────
// Two-axis view system — arrangements & distributions
//
// A view = a reference frame + a distribution, composed over whatever content
// template the scene auto-selects. The content template produces a SlotRoster
// (which landmark roles exist, their sizes, and reading priority). A
// distribution turns that roster into a positioned SlotMap. Intra-panel layout
// (layoutPrimitive / pagination) is untouched — arrangements only move the
// top-level landmark panels.
// ─────────────────────────────────────────────────────────────

import type {
  Arrangement,
  LayoutConfig,
  LayoutTemplate,
  RenderMetrics,
  SlotMap,
  SlotName,
  SlotSpec,
  SlotRoster,
} from "./types";
import type { Rotation3, Size2 } from "../mapper/types";
import { selectSlots } from "./slots";
import { angularPosition, angularRotation, zeroRotation } from "./utils";

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

export function getArrangement(id: string | undefined): Arrangement | undefined {
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
    const yRef = goLeft ? (leftY -= RIBBON_H + GAP) : (rightY -= RIBBON_H + GAP);
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
      curveRadius: d * 0.9,
      worldLocked: true,
    };
  }
  attachBannerFooter(map, roster, -mainW / 2, -d, zeroRotation(), d * 0.9, cfg);
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
    map[spec.role] = {
      position: angularPosition(d, center, eyeY),
      rotation: angularRotation(center),
      size,
      curveRadius: 0,
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
