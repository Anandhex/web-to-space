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
import { deg2rad, zeroRotation, angularPosition, angularRotation } from "./utils";

const RAD2DEG = 180 / Math.PI;

/**
 * Peripheral rails are width-capped so a scattered arrangement never places a
 * full main-width (≈1.4 m) panel beside another — the cause of overlap. Both
 * the desk templates below and the arrangement path's `railSize` read it, so a
 * side rail is the same slab of the workspace whichever path placed it.
 */
const RAIL_MAX_W = 0.5;

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

/**
 * A landmark slot whose CENTRE sits on the shared radius-`d` cylinder at
 * `deg`, tangent to it, hanging from `topY`.
 *
 * Slots are TOP-LEFT anchored and rotate about that anchor, so placing the
 * anchor itself at `deg` — what this helper used to do — actually centres the
 * panel at `deg + halfArc(width)`. That is the arc equivalent of the same
 * off-by-half-a-width the flat templates correct with `centreStackedPanels`,
 * and it is signed: a left-hand rail drifted inward toward the main panel
 * while its right-hand partner drifted outward, so a pair authored at equal
 * and opposite angles never actually looked symmetric. `outsideMainDeg`
 * returns a centre angle, which made every caller here wrong by that amount.
 *
 * Stepping the anchor back along the panel's own +x axis (which yaw −`deg`
 * puts at `(cos deg, 0, sin deg)`) puts the centre exactly on the cylinder:
 * `deg` means what it says, and every rail is at exactly distance `d` from
 * the reader — one accommodation for the whole desk.
 */
function wrapLandmark(
  d: number,
  deg: number,
  topY: number,
  width: number,
  height: number,
): LandmarkSlot {
  const rad = deg2rad(deg);
  const half = width / 2;
  return {
    position: {
      x: d * Math.sin(rad) - half * Math.cos(rad),
      y: topY,
      z: -d * Math.cos(rad) - half * Math.sin(rad),
    },
    rotation: angularRotation(deg),
    size: { width, height },
    curveRadius: d,
    worldLocked: true,
  };
}

// ═════════════════════════════════════════════════════════════
// The desk — shared geometry for the front-facing templates
//
// `document`, `landing` and `generic` are all the same piece of furniture
// with a different main width and a different set of side rails, so they are
// built by one function instead of three hand-tuned tables of magic numbers.
// Three things it fixes, all of which the offline audit measured:
//
//  1. THE READING BAND SITS WHERE THE EYE RESTS. Panels used to hang from
//     `eyeLevel + eyeLevelOffset`, i.e. their TOP edge was just under the
//     horizon — so a 0.9 m panel at 1.2 m ran from −5° to −40° of elevation
//     and you read the bottom third with your chin down. The band is centred
//     on the resting gaze instead and the panel spans roughly +8°…−30°.
//  2. PAGE CHROME IS OUTSIDE THE BAND. `footer.y = eyeY − height * 0.6` put
//     the footer's top edge 60 % of the way DOWN the main panel: the audit
//     reported a 1.40 × 0.12 m overlap on every profile, in every template.
//     Banner and footer now attach above and below the band with a fixed
//     clearance and cannot reach into it.
//  3. THE RAILS ARE ONE FAMILY. TOC and complementary were separately
//     drag-tuned to 1.00 m / +71.5° and 1.05 m / −64.3° against a main panel
//     at 1.20 m — three different accommodations, no symmetry, and (in the
//     document template) a navigation rail at −14° azimuth, i.e. hidden
//     behind the main panel. Every rail now sits on the one user-centred
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

/** Angular clearance between neighbouring panels on the shared cylinder. */
const WRAP_GAP_DEG = 2.5;

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
 * It used to be a literal 1.4 / 1.6 / 1.8 per template on every device. That
 * number is the Quest 3's comfort cone (2 · 1.2 m · tan 30° = 1.386 m), which
 * is why it looked right there and nowhere else — on the Ray-Ban profile the
 * same 1.4 m panel sits at 0.6 m and subtends ±67°, roughly three times the
 * glasses' entire 40° field, and it pushed the first side rail out past 90°.
 * Derived, the Quest 3 barely moves (1.386 vs 1.400, so its pagination is
 * unchanged to within a percent) and the narrow profiles get a panel they can
 * actually see.
 */
function mainWidth(cfg: LayoutConfig, fill: number): number {
  return 2 * cfg.viewingDistance * Math.tan(deg2rad(cfg.comfortHalfAngleDeg)) * fill;
}

/**
 * Width of a side rail. Proportional to the main panel so the desk keeps its
 * proportions, floored at a fixed fraction of the reading distance so a rail
 * subtends a readable angle on the narrow profiles (where a proportional
 * width would come out at ~10 cm), and capped at the shared RAIL_MAX_W so a
 * wide profile doesn't push the outer rail past a head turn.
 */
function railWidth(cfg: LayoutConfig, mainW: number): number {
  return Math.min(RAIL_MAX_W, Math.max(0.26 * cfg.viewingDistance, mainW * 0.32));
}

/**
 * Centre angles for the side rails, laid outward from the main panel's edges
 * and alternating left/right in the order given. The order is the caller's
 * reading priority, so the landmark a reader reaches for most often is the
 * one needing the smallest head turn — and it alternates rather than filling
 * one side first so the desk stays balanced.
 */
function railAngles(
  roles: SlotName[],
  mainW: number,
  railW: number,
  d: number,
): Map<SlotName, number> {
  const out = new Map<SlotName, number>();
  const inner: Record<"L" | "R", number[]> = { L: [], R: [] };
  roles.forEach((role, i) => {
    const side: "L" | "R" = i % 2 === 0 ? "L" : "R";
    out.set(
      role,
      outsideMainDeg(
        side === "L" ? -1 : 1,
        mainW,
        railW,
        d,
        inner[side],
        WRAP_GAP_DEG,
      ),
    );
    inner[side].push(railW);
  });
  return out;
}

interface DeskSpec {
  /** Width of the main reading panel, from `mainWidth`. */
  mainW: number;
  /** Side rails, nearest-first; laid alternately left then right. */
  rails: SlotName[];
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
  const { mainW, rails } = spec;
  const curve = spec.mainCurve ?? d;
  const railW = railWidth(cfg, mainW);
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

  const angles = railAngles(rails, mainW, railW, d);
  for (const role of rails) {
    map[role] = wrapLandmark(d, angles.get(role)!, band.topY, railW, band.height);
  }
  return map;
}

/**
 * DOCUMENT template — an article with reading aids either side.
 *
 * ```
 *        ↖nav   ↖toc   [ main 1.4 m ]   aside↗
 * ```
 * Rails in priority order: the table of contents is what a reader reaches for
 * first, the aside next, site navigation last.
 */
function documentSlots(cfg: LayoutConfig, metrics: RenderMetrics): SlotMap {
  return deskSlots(cfg, metrics, {
    // Exactly the comfort cone: an article panel you read without turning.
    mainW: mainWidth(cfg, 1),
    rails: ["toc", "complementary", "navigation"],
  });
}

/**
 * LANDING template — a wider, panoramic hero panel. Only one rail: a landing
 * page's nav is its content, so the desk stays uncluttered and the extra
 * width goes to the hero instead.
 */
function landingSlots(cfg: LayoutConfig, metrics: RenderMetrics): SlotMap {
  return deskSlots(cfg, metrics, {
    mainW: mainWidth(cfg, 1.3),
    rails: ["toc", "complementary", "navigation"],
    // A panoramic panel wants a flatter bend than the reading cylinder, or
    // its far edges rake away from the reader.
    mainCurve: cfg.viewingDistance * 1.4,
  });
}

/** GENERIC template — safe fallback, between the two in width. */
function genericSlots(cfg: LayoutConfig, metrics: RenderMetrics): SlotMap {
  return deskSlots(cfg, metrics, {
    mainW: mainWidth(cfg, 1.15),
    rails: ["complementary", "toc", "navigation"],
  });
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

// `RAIL_MAX_W` is declared at the top of the file — the desk templates size
// their side rails through it too, so a rail is the same slab of the
// workspace whichever path placed it.

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
