// ─────────────────────────────────────────────────────────────
// Landmark placement layer
//
// Merged from slots.ts (the SlotMap) + arrangements.ts (two-axis view
// system). Two things live here:
//   • The desk          → the one hand-tuned SlotMap (selectSlots)
//   • Arrangement       → frame + distribution composed over the desk's slot
//                         roster (resolveArrangementSlots)
// Intra-panel layout (layoutPrimitive / pagination) lives in engine.ts and is
// untouched — this file only places the top-level landmark panels.
// ─────────────────────────────────────────────────────────────

import type {
  Arrangement,
  LayoutConfig,
  RenderMetrics,
  SlotMap,
  SlotName,
  SlotSpec,
  SlotRoster,
} from "./types";
import type { Size2 } from "../mapper/types";
import { deg2rad, zeroRotation, angularPosition, angularRotation } from "./utils";

/**
 * Peripheral rails are width-capped so a scattered arrangement never places a
 * full main-width (≈1.4 m) panel beside another — the cause of overlap. Both
 * the desk below and the arrangement path's `railSize` read it, so a
 * side rail is the same slab of the workspace whichever path placed it.
 */
const RAIL_MAX_W = 0.5;

// ═════════════════════════════════════════════════════════════
// The desk — the front-facing landmark geometry
//
// There used to be three of these — `document`, `landing` and `generic` —
// selected per scene. They were the same piece of furniture with a different
// main width and a different rail order, and neither difference reached the
// screen: the page views drop every rail from the roster, and `landing` was
// structurally unreachable (its gate wants a banner AND ≤3 sections AND <600
// words). Removed 2026-08-19; the desk below is the surviving `document`
// geometry. Three things it fixes, all of which the offline audit measured:
//
//  1. THE READING BAND SITS WHERE THE EYE RESTS. Panels used to hang from
//     `eyeLevel + eyeLevelOffset`, i.e. their TOP edge was just under the
//     horizon — so a 0.9 m panel at 1.2 m ran from −5° to −40° of elevation
//     and you read the bottom third with your chin down. The band is centred
//     on the resting gaze instead and the panel spans roughly +8°…−30°.
//  2. PAGE CHROME IS OUT OF THE WAY ENTIRELY. `footer.y = eyeY − height*0.6`
//     put the footer's top edge 60 % of the way DOWN the main panel: the
//     audit reported a 1.40 × 0.12 m overlap on every profile. There is no
//     banner or footer SLOT any more (see `deskSlots`) — that content
//     paginates in flow, so it cannot reach into the band at all.
//  3. THE RAILS ARE ONE FAMILY. TOC and complementary were separately
//     drag-tuned to 1.00 m / +71.5° and 1.05 m / −64.3° against a main panel
//     at 1.20 m — three different accommodations, no symmetry, and a
//     navigation rail at −14° azimuth, i.e. hidden behind the main panel. Every rail now sits on the one user-centred
//     cylinder, laid outward from the main panel's edges in priority order,
//     alternating sides.
//
// What it does NOT pretend to fix: a 1.4 m panel at 1.2 m subtends ±33°, so
// it fills the ±30° comfort cone by itself and anything beside it is a head
// turn by construction. The rails are peripheral because the geometry says
// so — the goal is that turning to one puts it flat-on and legible, not that
// it be readable out of the corner of your eye.
// ═════════════════════════════════════════════════════════════

/**
 * Resting-gaze depression, degrees below the horizon, where the reading
 * band's centre is placed. Comfortable seated/standing gaze sits ~10–20°
 * down; 13° keeps a full-height panel's bottom edge inside −30° on all three
 * device profiles while leaving its top edge only just above the horizon.
 */
const READING_GAZE_DEG = 13;

/** Vertical clearance between the reading band and anything above it. */
const BAND_GAP = 0.035;

/** The vertical span the main panel and its side rails share. */
interface ReadingBand {
  /** World y of the band's top edge — every panel in it hangs from here. */
  topY: number;
  bottomY: number;
  height: number;
}

function readingBand(cfg: LayoutConfig): ReadingBand {
  const height = cfg.maxPanelViewportHeight;
  const centreY =
    cfg.eyeLevel - cfg.viewingDistance * Math.tan(deg2rad(READING_GAZE_DEG));
  return { topY: centreY + height / 2, bottomY: centreY - height / 2, height };
}

/**
 * Width of the main reading panel: a multiple of the comfort cone's own width
 * at the reading distance.
 *
 * It used to be a literal 1.4 m on every device. That number is the Quest 3's
 * comfort cone (2 · 1.2 m · tan 30° = 1.386 m), which is why it looked right
 * there and nowhere else — on the Ray-Ban profile the
 * same 1.4 m panel sits at 0.6 m and subtends ±67°, roughly three times the
 * glasses' entire 40° field, and it pushed the first side rail out past 90°.
 * Derived, the Quest 3 barely moves (1.386 vs 1.400, so its pagination is
 * unchanged to within a percent) and the narrow profiles get a panel they can
 * actually see.
 */
function mainWidth(cfg: LayoutConfig, fill: number): number {
  return 2 * cfg.viewingDistance * Math.tan(deg2rad(cfg.comfortHalfAngleDeg)) * fill;
}

interface DeskSpec {
  /** Width of the main reading panel, from `mainWidth`. */
  mainW: number;
  /** Curve radius for the head-on stacked column. Defaults to the cylinder. */
  mainCurve?: number;
}

/**
 * Build the desk: a main reading panel head-on in the band, page chrome
 * attached above and below it, side rails arced outward on the shared
 * cylinder, and the two modal overlays pulled forward of the whole thing.
 */
function deskSlots(
  cfg: LayoutConfig,
  metrics: RenderMetrics,
  spec: DeskSpec,
): SlotMap {
  const d = cfg.viewingDistance;
  const band = readingBand(cfg);
  const { mainW } = spec;
  const curve = spec.mainCurve ?? d;
  const leftX = -mainW / 2;
  const bandMidY = (band.topY + band.bottomY) / 2;
  // Overlay sizing, all relative to the desk it interrupts.
  const alertW = mainW * 0.36;
  const dialogW = mainW * 0.58;
  const dialogH = band.height * 0.66;
  /** How far in front of the desk an overlay floats — enough to separate. */
  const overlayLift = Math.min(0.25, d * 0.2);

  const map: SlotMap = {
    main: {
      position: { x: leftX, y: band.topY, z: -d },
      rotation: zeroRotation(),
      size: { width: mainW, height: band.height },
      curveRadius: curve,
      worldLocked: true,
    },
    // NO banner / footer slot.
    //
    // Site headers and footers are page furniture, not reading matter: given
    // their own panels they bracketed the reading band with two full-width
    // bars that were empty on most documents, and the desk's board had to
    // reserve room for both — a mount half again as tall as the page inside
    // it. Leaving the slots out means the engine's extraction passes never
    // fire and any banner/footer content simply paginates in flow, which is
    // the same call the content-only page views already make (see
    // layout/content-only.ts). Nothing is dropped; it just reads in order.

    // Overlays interrupt: head-on, pulled forward of the desk so they read in
    // front of it, and sized against the desk rather than at a fixed 0.5 /
    // 0.8 m — on the Ray-Ban profile those literals made a dialog two and a
    // half times the width of the panel it was interrupting, hanging from
    // +25° to −51° of elevation.
    alert: {
      position: {
        x: -alertW / 2,
        y: band.topY + BAND_GAP + metrics.alert.minHeight,
        z: -(d - overlayLift),
      },
      rotation: zeroRotation(),
      size: { width: alertW, height: metrics.alert.minHeight },
      curveRadius: 0,
      worldLocked: false,
    },
    dialog: {
      position: {
        x: -dialogW / 2,
        y: bandMidY + dialogH / 2,
        z: -(d - overlayLift),
      },
      rotation: zeroRotation(),
      size: { width: dialogW, height: dialogH },
      curveRadius: 0,
      worldLocked: false,
    },
  };

  return map;
}

/**
 * The desk's own slot map — an article panel with reading aids either side.
 *
 * ```
 *        ↖nav   ↖toc   [ main 1.4 m ]   aside↗
 * ```
 * Rails in priority order: the table of contents is what a reader reaches for
 * first, the aside next, site navigation last.
 *
 * `mainW` is exactly the comfort cone: an article panel you read without
 * turning your head.
 */
function deskSlotMap(cfg: LayoutConfig, metrics: RenderMetrics): SlotMap {
  return deskSlots(cfg, metrics, { mainW: mainWidth(cfg, 1) });
}

export function selectSlots(cfg: LayoutConfig, metrics: RenderMetrics): SlotMap {
  return deskSlotMap(cfg, metrics);
}

// ═════════════════════════════════════════════════════════════
// Two-axis view system — arrangements & distributions
//
// A view = a reference frame + a distribution, composed over the desk.
// selectSlots (above) provides the roster's slot sizing; a distribution turns
// that roster into a positioned SlotMap.
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

// ── Roster derivation (the desk → ordered slot specs) ───────

/**
 * Reading-priority order. `main` is always primary; the rest descend so that
 * distributions can compress/recede/angle by importance deterministically.
 * `alert`/`dialog` are intentionally excluded — modal overlays are never
 * scattered by a distribution; they always come from the desk's own head-on
 * overlay slots (see resolveArrangementSlots).
 */
const PRIORITY: SlotName[] = [
  "main",
  "complementary",
  "toc",
  "navigation",
];

/**
 * Build a SlotRoster from the desk. We reuse the desk's own slot sizing (so
 * its width/height intelligence is preserved) but drop its positions — those
 * are the arrangement's job.
 */
export function rosterFor(
  cfg: LayoutConfig,
  metrics: RenderMetrics,
): SlotRoster {
  const base = selectSlots(cfg, metrics);
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

// `RAIL_MAX_W` is declared at the top of the file — the desk sizes its side
// rails through it too, so a rail is the same slab of the workspace whichever
// path placed it.

function railSize(spec: SlotSpec, cfg: LayoutConfig): Size2 {
  return {
    width: Math.min(spec.size.width, RAIL_MAX_W),
    height: Math.min(spec.size.height, cfg.maxPanelViewportHeight),
  };
}

/** The panels a distribution scatters: everything except the primary. */
function railsOf(roster: SlotRoster): SlotRoster {
  return roster.filter((s) => s.role !== "main");
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
 * Resolve a fully-positioned SlotMap for an arrangement composed over the desk.
 * This is the arrangement-path replacement for `selectSlots`.
 */
export function resolveArrangementSlots(
  arrangement: Arrangement,
  cfg: LayoutConfig,
  metrics: RenderMetrics,
): SlotMap {
  let roster = rosterFor(cfg, metrics);
  // Content-only page views: the page set replaces the landmark panels, so
  // only the main slot survives. With no complementary/banner/footer slots
  // in the map the engine's extraction passes never fire — folded landmarks
  // paginate in-flow (see layout/content-only.ts).
  if (arrangement.pageDistribution && arrangement.pageDistribution !== "flip") {
    roster = roster.filter((s) => s.role === "main");
  }
  const distribute = DISTRIBUTIONS[arrangement.distribution] ?? fan;
  const map = distribute(roster, cfg, metrics);
  // Modal overlays always sit head-on, near the viewer — reuse the desk's own
  // alert/dialog slots so overlays are never lost by a distribution.
  const base = selectSlots(cfg, metrics);
  if (!map.alert && base.alert) map.alert = base.alert;
  if (!map.dialog && base.dialog) map.dialog = base.dialog;
  return map;
}
