import type {
  Arrangement,
  LayoutConfig,
  RenderMetrics,
  SlotMap,
} from "./types";
import { deg2rad, zeroRotation } from "./utils";

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
 * Width of the main reading panel: the chord the comfort cone subtends at the
 * reading distance, so the panel is as wide as the region the reader takes in
 * without turning their head, and no wider.
 *
 * Plain half-angle geometry — the panel is centred on the forward gaze at
 * distance d, so each half subtends comfortHalfAngleDeg at the eye and the
 * half-width is d · tan(θ):
 *
 *     w = 2 · d · tan(θ)
 *
 * Both inputs come from the device profile, so it is never a stored constant:
 * a profile with a shorter reading distance or a narrower comfort angle gets a
 * proportionally narrower panel, and nothing downstream needs to know which
 * device it is running on. Quest 3 (d = 1.2, θ = 30°) gives 1.386 m.
 *
 * `fill` scales the result. Every current call site passes 1.
 */
function mainWidth(cfg: LayoutConfig, fill: number): number {
  return (
    2 * cfg.viewingDistance * Math.tan(deg2rad(cfg.comfortHalfAngleDeg)) * fill
  );
}

function selectSlots(
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

/**
 * The declarative view catalogue. Adding a spatial view is a data entry here.
 */
const ARRANGEMENTS: Record<string, Arrangement> = {
  wall: {
    id: "wall",
    frame: "world",
    deviceFit: ["headset-6dof", "headset-roomscale"],
    pageDistribution: "wall",
  },
  deck: {
    id: "deck",
    frame: "world",
    deviceFit: ["headset-6dof", "headset-roomscale"],
    pageDistribution: "deck",
  },
  rooms: {
    id: "rooms",
    frame: "world",
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

  if (base.alert) map.alert = base.alert;
  if (base.dialog) map.dialog = base.dialog;
  return map;
}
