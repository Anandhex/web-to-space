// ─────────────────────────────────────────────────────────────
// Landmark placement layer
//
// Merged from slots.ts (the SlotMap) + arrangements.ts (two-axis view
// system). Two things live here:
//   • The desk          → the one hand-tuned SlotMap (selectSlots)
//   • Arrangement       → places the desk's main slot for a given arrangement
//                         (resolveArrangementSlots)
// Intra-panel layout (layoutPrimitive / pagination) lives in engine.ts and is
// untouched — this file only places the top-level landmark panels.
// ─────────────────────────────────────────────────────────────

import type { Arrangement, LayoutConfig, RenderMetrics, SlotMap } from "./types";
import { deg2rad, zeroRotation } from "./utils";

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
//     banner or footer SLOT any more (see `selectSlots`) — that content
//     paginates in flow, so it cannot reach into the band at all.
//  3. THE RAILS ARE GONE. TOC and complementary were separately drag-tuned
//     to 1.00 m / +71.5° and 1.05 m / −64.3° against a main panel at 1.20 m
//     — three different accommodations, no symmetry, and a navigation rail
//     at −14° azimuth, i.e. hidden behind the main panel. A shared rail
//     cylinder replaced that for a while (see git history), but every
//     reachable arrangement folds `nav`/`aside`/`header` into the main
//     panel's flow instead (`foldForArrangement` in content-only.ts) — so
//     `resolveArrangementSlots` only ever places `main`.
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

/** The vertical span the main panel hangs from. */
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
  return (
    2 * cfg.viewingDistance * Math.tan(deg2rad(cfg.comfortHalfAngleDeg)) * fill
  );
}

/**
 * Build the desk: a main reading panel head-on in the band, sized to exactly
 * the comfort cone so it reads without turning your head, plus the two modal
 * overlays pulled forward of it. No banner/footer/rail slots — see the
 * comment on the `main` map entry below for why.
 */
export function selectSlots(
  cfg: LayoutConfig,
  metrics: RenderMetrics,
): SlotMap {
  const d = cfg.viewingDistance;
  const band = readingBand(cfg);
  const mainW = mainWidth(cfg, 1);
  const leftX = -mainW / 2;
  const bandMidY = (band.topY + band.bottomY) / 2;
  // Overlay sizing, all relative to the desk it interrupts.
  const alertW = mainW * 0.36;
  const dialogW = mainW * 0.58;
  const dialogH = band.height * 0.66;
  /** How far in front of the desk an overlay floats — enough to separate. */
  const overlayLift = Math.min(0.25, d * 0.2);

  return {
    main: {
      position: { x: leftX, y: band.topY, z: -d },
      rotation: zeroRotation(),
      size: { width: mainW, height: band.height },
      curveRadius: d,
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
}

// ═════════════════════════════════════════════════════════════
// Arrangement registry
//
// A view = a reference frame + a page distribution, composed over the desk.
// Every entry below sets a non-"flip" `pageDistribution`, which puts
// `resolveArrangementSlots` in content-only mode: the page set replaces the
// landmark rails, so `main` is the only slot it ever resolves (see below).
// ═════════════════════════════════════════════════════════════

/**
 * The declarative view catalogue. Adding a spatial view is a data entry here.
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

/**
 * Resolve a fully-positioned SlotMap for an arrangement composed over the
 * desk. This is the arrangement-path replacement for `selectSlots`.
 *
 * Every registered arrangement puts the layout engine in content-only mode
 * (a non-"flip" `pageDistribution`), which collapses the desk's roster to
 * `main` alone — the page set replaces the `complementary`/`toc`/`navigation`
 * rails, so nothing ever scatters them (see `layout/content-only.ts`). The
 * roster/distribution machinery that used to build those rails only to have
 * this function discard them was removed 2026-08-19; `main` is placed
 * head-on in front of the viewer directly.
 */
export function resolveArrangementSlots(
  _arrangement: Arrangement,
  cfg: LayoutConfig,
  metrics: RenderMetrics,
): SlotMap {
  const base = selectSlots(cfg, metrics);
  const map: SlotMap = {};
  if (base.main) {
    const eyeY = cfg.eyeLevel + cfg.eyeLevelOffset;
    const d = cfg.viewingDistance;
    map.main = {
      position: { x: -base.main.size.width / 2, y: eyeY, z: -d },
      rotation: zeroRotation(),
      size: base.main.size,
      curveRadius: d * 0.8,
      worldLocked: true,
    };
  }
  // Modal overlays always sit head-on, near the viewer — reuse the desk's own
  // alert/dialog slots directly.
  if (base.alert) map.alert = base.alert;
  if (base.dialog) map.dialog = base.dialog;
  return map;
}
