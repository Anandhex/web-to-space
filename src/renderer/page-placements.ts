/**
 * renderer/page-placements.ts
 *
 * Pure placement math for the content-only page views: given a paginated
 * panel's page count + size and the focused page, compute where every page's
 * ghost sits relative to the panel's top-left slot anchor. This is a
 * PRESENTATIONAL transform over PaginationMeta — the layout engine owns what
 * flows on which page; this module owns where the page set hangs in space
 * (same split as StackDepthContext z-stagger and PanelCurveContext bending).
 *
 * NO three.js / react imports — node-importable so the offline harness can
 * AABB-check placements without a renderer.
 *
 * Coordinates: offsets are metres relative to the main panel's top-left
 * anchor (WebXR right-handed; +y up, −z away from the viewer). The focused
 * page always reads on the REAL panel at the slot itself; placements
 * describe the surrounding ghost field, with `isFocusCell` marking the
 * "you are here" cell the renderer draws as a highlight frame.
 */

export interface PagePlacement {
  pageIndex: number;
  /** Ghost top-left anchor, relative to the main panel's top-left anchor. */
  offset: { x: number; y: number; z: number };
  /** Absolute rotation of the ghost group (radians). */
  rotation: { x: number; y: number; z: number };
  /** Uniform scale (1 = full size). */
  scale: number;
  /** 0 = focused, →1 = fully de-emphasized. Drives ghost dimming. */
  recession: number;
  /**
   * elevator: this page belongs to a ring OTHER than the one the reader is
   * standing on. The renderer always draws these as dimmed imposters, never
   * live ghosts, so a neighbouring storey reads as translucent scenery
   * rather than a second page competing with the one you're reading.
   */
  offFloor?: boolean;
  /** True for the empty marker frame left at the focused page's field cell. */
  isFocusCell: boolean;
  /**
   * The focused page: the one the renderer draws fully interactive (live
   * links, pagination controls). Because each page keeps one persistent
   * eased group, a focus change morphs the clicked page to this placement
   * and the previous one back out.
   *
   * In wall/deck this is the STAGE — identity offset/rotation, scale 1,
   * always flat — and the page flies there from its field cell, leaving an
   * isFocusCell marker behind. The elevator has no stage: the page keeps its
   * bearing on the ring and is emphasised in place instead. Rooms has no
   * stage either, for the opposite reason: nothing moves but the reader, who
   * walks to the page (see computeRoomWalk), so the flag only marks which
   * exhibit is being read.
   */
  isStage: boolean;
}

import type { PageDistribution } from "../layout/types";

/** Inclusive page range of one top-level section (or the intro pseudo-section). */
export interface SectionPageRange {
  start: number;
  end: number;
  label: string;
}

export interface PagePlacementOptions {
  /**
   * elevator/deck/rooms: page ranges of the top-level sections, in
   * reading order.
   */
  sectionRanges?: SectionPageRange[];
  /** elevator/rooms: reading distance (LayoutConfig.viewingDistance). */
  viewingDistance?: number;
  /**
   * rooms only: the floor, as a panel-anchor-relative y — i.e. minus the
   * panel's world height, since the room shell's walls have to stand on the
   * same ground the preview draws its grid on. Placement math has no other
   * business knowing where the world's floor is, so nothing else reads it.
   */
  floorY?: number;
  /**
   * rooms only: the outbound links of each section, in the same order as
   * `sectionRanges` — they hang on the corridor past that section's room, and
   * their count sizes that stretch, so EVERY rooms entry point has to be
   * passed the same list or the floor plans will disagree.
   */
  sectionLinks?: SectionLink[][];
  /**
   * rooms only: where the reader is actually standing, when they have walked
   * somewhere the focused page did not put them. Only the dimming reads it —
   * placements themselves never move — so leaving it out simply dims from the
   * focused page's reading spot instead.
   */
  readerPose?: ReaderPose;
}

/** Section ranges as given, or one range covering the whole document. */
function resolveRanges(
  ranges: SectionPageRange[] | undefined,
  pageCount: number,
): SectionPageRange[] {
  return ranges && ranges.length > 0
    ? ranges
    : [{ start: 0, end: pageCount - 1, label: "" }];
}

/** Pages within this |i − focus| distance render as full live ghosts;
 *  the rest render as cheap imposter cards (page number + heading). */
export const LIVE_GHOST_RADIUS = 2;

/** Below this page count a page view degenerates (a lone floating card);
 *  callers should fall back to "flip". */
export const MIN_PAGES_FOR_PAGE_VIEWS = 3;

const rot0 = { x: 0, y: 0, z: 0 };

/** The focused page's reading placement: identity transform, full size, flat. */
function stagePlacement(pageIndex: number): PagePlacement {
  return {
    pageIndex,
    offset: { x: 0, y: 0, z: 0 },
    rotation: rot0,
    scale: 1,
    recession: 0,
    isFocusCell: false,
    isStage: true,
  };
}

// ── Elevator ─────────────────────────────────────────────────
// A building of sections: every section — nested subsections included — is
// its own FLOOR, and a floor is a cylinder of that section's pages built
// AROUND the reader. The ring axis passes through the viewer, so every page
// is at reading distance and faces inward. The focused section's floor is
// the one the reader stands on; the neighbouring sections' rings hang one
// storey above (earlier) and below (later), so the shaft reads as an atrium
// you ride through.
//
// The ring is FIXED, not a lazy Susan, and the section's NAME IS ONE OF ITS
// SLOTS: the plaque takes the slot dead ahead, then the pages follow it
// clockwise — page 1 one slot to the RIGHT of the name, page 2 two slots, on
// around the back, until the last page arrives one slot to the LEFT of the
// name and closes the circle. Reading order therefore starts beside the
// section name, wraps the whole room, and comes back to it; a page's arc
// distance from the name is just its number × the slot arc. The slots divide
// the FULL 360°, so this is a room you turn around in, not a wall you face.
//
// NOTHING flies to a reading position, and being the current page earns no
// special treatment — it sits in its slot like the rest. Only the page under
// the pointer/ray is emphasised, and even that stays on its own bearing: it
// grows to full size and closes in to reading distance, see
// elevatorEmphasis. So the room never rearranges itself, and a page's place
// on the wall is stable enough to remember.
//
// Spacing: a slot is one page WIDE — page width at ring scale plus a small
// gap — so neighbours sit next to each other however many there are, and the
// pitch between them is that arc over the radius. The radius is whatever
// makes one turn hold the name plus every page, floored at reading distance
// plus the wall standoff so the reader is never inside a room smaller than
// arm's reach. A section big enough to need it therefore gets a bigger room
// (pages keep their size and spacing), and a section too small to fill a
// turn simply leaves the arc behind the reader empty.

const ELEVATOR_S = 0.6; // ring page scale (emphasis takes a page to 1)
const ELEVATOR_ARC_GAP = 0.08; // gap between neighbouring slots along the arc
const ELEVATOR_WALL_STANDOFF = 0.2; // ring wall sits this far beyond reading distance
const ELEVATOR_MAX_RADIUS = 3.2; // metres — past here the ring windows instead
const ELEVATOR_FLOOR_GAP = 0.16; // vertical clearance between storeys
const ELEVATOR_FLOOR_WINDOW = 1; // floors drawn above/below the current one
const ELEVATOR_NEIGHBOUR_PAGES = 8; // pages drawn on a non-focused floor
const TWO_PI = Math.PI * 2;

/**
 * Sections → floors, one storey per section, never merged. Ranges are only
 * clamped to stay disjoint and in-bounds: two sections that begin on the
 * same page must not put that page on two floors (it would be placed —
 * and keyed — twice). A section shorter than its neighbours simply makes a
 * sparser ring; the storey is still its own.
 */
function elevatorFloors(
  ranges: SectionPageRange[],
  pageCount: number,
): SectionPageRange[] {
  const floors: SectionPageRange[] = [];
  let prevEnd = -1;
  for (const r of ranges) {
    const start = Math.max(r.start, prevEnd + 1);
    const end = Math.min(r.end, pageCount - 1);
    if (end < start) continue; // wholly absorbed by an earlier floor
    prevEnd = end;
    floors.push({ start, end, label: r.label });
  }
  return floors.length
    ? floors
    : [{ start: 0, end: Math.max(0, pageCount - 1), label: "" }];
}

/** Arc length one slot consumes on a ring (page width at scale + gap). */
function elevatorArcStep(panel: { width: number }): number {
  return panel.width * ELEVATOR_S + ELEVATOR_ARC_GAP;
}

/**
 * Ring radius for a floor of `n` pages: whatever makes one turn hold the name
 * plaque plus every page at one slot each, floored at reading distance plus
 * the wall standoff and capped at ELEVATOR_MAX_RADIUS. Because the slot arc
 * is fixed, a bigger section buys a bigger room rather than tighter pages.
 */
function elevatorRadius(
  n: number,
  panel: { width: number },
  viewingDistance: number,
): number {
  const oneTurn = ((n + 1) * elevatorArcStep(panel)) / TWO_PI;
  return Math.min(
    Math.max(oneTurn, viewingDistance + ELEVATOR_WALL_STANDOFF),
    ELEVATOR_MAX_RADIUS,
  );
}

/** Angular pitch between adjacent slots: one slot arc over the radius. */
function elevatorStep(radius: number, panel: { width: number }): number {
  return elevatorArcStep(panel) / radius;
}

/**
 * Angle of the k-th page on a ring. Slot 0 is dead ahead and belongs to the
 * section name; the pages follow it CLOCKWISE, each one slot further round —
 * page 1 immediately to the RIGHT of the plaque, page 2 beside that, on
 * around the back, until the last page comes up on the plaque's LEFT. So a
 * page's arc distance from the name is simply its number × the slot arc, and
 * a section that fills a turn closes the circle back at its own name.
 */
function elevatorAngle(
  k: number,
  radius: number,
  panel: { width: number },
): number {
  return wrapAngle((k + 1) * elevatorStep(radius, panel));
}

/** How many slots fit one turn at `radius` without overlapping. */
function elevatorRingCapacity(
  radius: number,
  panel: { width: number },
): number {
  return Math.max(2, Math.floor((TWO_PI * radius) / elevatorArcStep(panel)));
}

/**
 * Wrap to [−π, π) so a page takes the short way round the ring. Half-open at
 * the BACK: a full-turn ring puts its first page at exactly −π, and that page
 * has to stay on the left where reading order starts, not flip to the right.
 */
function wrapAngle(a: number): number {
  let x = a % TWO_PI;
  if (x >= Math.PI) x -= TWO_PI;
  if (x < -Math.PI) x += TWO_PI;
  return x;
}

/**
 * One page's slot on a floor ring. θ = 0 is dead ahead of the reader, +θ
 * swings right. The page faces the axis (yaw = −θ), so it reads head-on from
 * the centre where the reader stands.
 */
function elevatorCell(
  theta: number,
  radius: number,
  centre: { x: number; y: number; z: number },
  panel: { width: number; height: number },
): {
  offset: { x: number; y: number; z: number };
  rotation: { x: number; y: number; z: number };
  scale: number;
} {
  const pw = panel.width * ELEVATOR_S;
  const ph = panel.height * ELEVATOR_S;
  const cx = centre.x + radius * Math.sin(theta);
  const cz = centre.z - radius * Math.cos(theta);
  const yaw = -theta;
  // centre → top-left anchor (rotation about the anchor):
  // anchor = centre + Ry(yaw)·(−pw/2, +ph/2, 0)
  return {
    offset: {
      x: cx - (pw / 2) * Math.cos(yaw),
      y: centre.y + ph / 2,
      z: cz + (pw / 2) * Math.sin(yaw),
    },
    rotation: { x: 0, y: yaw, z: 0 },
    scale: ELEVATOR_S,
  };
}

/** Pages drawn on one floor's ring, and the radius they need. */
function elevatorFloorRing(
  range: SectionPageRange,
  isFocusFloor: boolean,
  focus: number,
  panel: { width: number; height: number },
  viewingDistance: number,
): { first: number; count: number; radius: number } {
  const len = range.end - range.start + 1;
  let count = isFocusFloor ? len : Math.min(len, ELEVATOR_NEIGHBOUR_PAGES);
  let radius = elevatorRadius(count, panel, viewingDistance);
  // A section longer than one capped turn windows around the focus rather
  // than overlapping itself — a 98-page sectionless article shows the pages
  // either side of where you are, not 98 slivers. One slot is the plaque's.
  const cap = elevatorRingCapacity(radius, panel) - 1;
  if (count > cap) {
    count = cap;
    radius = elevatorRadius(count, panel, viewingDistance);
  }
  const first = isFocusFloor
    ? Math.min(
        Math.max(focus - Math.floor((count - 1) / 2), range.start),
        range.end - count + 1,
      )
    : range.start;
  return { first, count, radius };
}

/**
 * Storey height. Any page on the ring can be emphasised up to FULL size — the
 * pointer does it, and it happens in place, on the ring — so the storey has
 * to be a bay a full-size page fits in, deck to soffit, not merely a shelf
 * the ring-scale ones sit on. Hence a whole page between the centres, plus
 * the trim at each end and the void between one storey's floor and the next
 * one's ceiling.
 *
 * Sized off the emphasised page rather than the ring page because the bay has
 * to hold the biggest thing that can happen in it: at ring height it held the
 * pages at rest and pointing at one drove it straight through the walkway.
 */
function elevatorFloorStep(panel: { height: number }): number {
  const trim = atriumTrim(panel);
  return (
    panel.height +
    (ATRIUM_PAGE_CLEAR * 2 + ATRIUM_RAIL_HEIGHT) * trim +
    ELEVATOR_FLOOR_GAP
  );
}

/**
 * Riding the elevator: the page to land on when the reader goes one storey
 * up (`dir` −1, the previous section) or down (+1, the next one). Returns
 * null at the top and bottom of the shaft. Up lands on the previous
 * section's LAST page and down on the next section's first, so the two keys
 * are each other's inverse and stepping down then up returns you home.
 */
export function elevatorFloorTarget(
  focus: number,
  pageCount: number,
  sectionRanges: SectionPageRange[],
  dir: -1 | 1,
): number | null {
  const floors = elevatorFloors(sectionRanges, pageCount);
  const { index } = rangeOf(focus, floors, pageCount);
  const next = floors[index + dir];
  if (!next) return null;
  return dir === 1 ? next.start : next.end;
}

/**
 * How far in front of its own ring the emphasised page keeps its corners.
 * Small — it only has to stop the page touching the wall it came off.
 */
const ELEVATOR_EMPHASIS_CLEAR = 0.06;

/**
 * Emphasis for the page the reader is pointing at. It does NOT fly to the
 * reading position — it stays on its own bearing and simply grows to full
 * size and closes in toward reading distance, so the room keeps its shape and
 * the page never loses its place in the section.
 *
 * Works off the placement alone: the page's inward normal is
 * (sin yaw, 0, cos yaw) because every ring page faces the axis, and the
 * axis is where the reader stands. The renderer eases the result — AtPos the
 * position, EasedScale the size — so this is a plain target transform.
 *
 * How far in it comes is NOT simply reading distance. The page is flat and it
 * has just grown to full width, so its corners stand further from the axis
 * than its centre does — by hypot(d, width/2) — while every page still on the
 * ring lies at or beyond the ring radius. On a Quest that put the corners at
 * 1.389 against a ring at 1.400: eleven millimetres, i.e. the magnified page
 * and its neighbours coplanar, interpenetrating and z-fighting. So it stops
 * at whichever is nearer: reading distance, or the distance that keeps its
 * CORNERS clear of the ring.
 */
export function elevatorEmphasis(
  p: PagePlacement,
  panel: { width: number; height: number },
  viewingDistance: number,
): PagePlacement {
  const yaw = p.rotation.y;
  const cosY = Math.cos(yaw);
  const sinY = Math.sin(yaw);
  // anchor → page centre, at the placement's current scale
  const cx = p.offset.x + ((panel.width * p.scale) / 2) * cosY;
  const cy = p.offset.y - (panel.height * p.scale) / 2;
  const cz = p.offset.z - ((panel.width * p.scale) / 2) * sinY;

  // Close in along the inward normal, but no further out than the ring will
  // let a full-width page sit without cutting into the pages either side.
  const r = Math.hypot(cx - panel.width / 2, cz - viewingDistance);
  const corners = Math.sqrt(
    Math.max(
      0,
      (r - ELEVATOR_EMPHASIS_CLEAR) * (r - ELEVATOR_EMPHASIS_CLEAR) -
        (panel.width / 2) * (panel.width / 2),
    ),
  );
  // …and never closer than arm's reach, however tight the ring: a page on the
  // reader's nose would be a worse answer than a page that overlaps one.
  const target = Math.min(viewingDistance, Math.max(corners, 0.35));
  const approach = Math.max(0, r - target);
  const ecx = cx + sinY * approach;
  const ecz = cz + cosY * approach;

  return {
    ...p,
    scale: 1, // full size, whatever the ring scale was
    offset: {
      x: ecx - (panel.width / 2) * cosY,
      y: cy + panel.height / 2,
      z: ecz + (panel.width / 2) * sinY,
    },
    recession: 0,
  };
}

/** Ring-axis centre of a floor, relative to the panel's top-left anchor. */
function elevatorFloorCentre(
  floorDelta: number,
  panel: { width: number; height: number },
  viewingDistance: number,
): { x: number; y: number; z: number } {
  return {
    x: panel.width / 2,
    // Reading order runs downward: later sections are lower floors.
    y: -panel.height / 2 - floorDelta * elevatorFloorStep(panel),
    z: viewingDistance, // the axis runs through the reader
  };
}

function elevator(
  pageCount: number,
  panel: { width: number; height: number },
  focus: number,
  sectionRanges: SectionPageRange[],
  viewingDistance: number,
): PagePlacement[] {
  const out: PagePlacement[] = [];
  const ranges = elevatorFloors(sectionRanges, pageCount);
  const { index: focusFloor } = rangeOf(focus, ranges, pageCount);

  for (let s = 0; s < ranges.length; s++) {
    const floorDelta = s - focusFloor;
    if (Math.abs(floorDelta) > ELEVATOR_FLOOR_WINDOW) continue;
    const isFocusFloor = floorDelta === 0;
    const { first, count, radius } = elevatorFloorRing(
      ranges[s],
      isFocusFloor,
      focus,
      panel,
      viewingDistance,
    );
    const centre = elevatorFloorCentre(floorDelta, panel, viewingDistance);

    for (let k = 0; k < count; k++) {
      const i = first + k;
      if (i < 0 || i >= pageCount) continue;
      const theta = elevatorAngle(k, radius, panel);
      const cell = elevatorCell(theta, radius, centre, panel);
      const turn = Math.abs(theta) / Math.PI; // 0 = ahead, 1 = behind you
      if (isFocusFloor && i === focus) {
        // The current page sits in its slot like every other page on the
        // wall — it is NOT pulled out or blown up. Emphasis in this view is
        // something the pointer does, not something being current earns.
        // `isStage` only marks it as the live, interactive one.
        out.push({
          pageIndex: i,
          ...cell,
          recession: 0,
          isFocusCell: false,
          isStage: true,
        });
        continue;
      }
      out.push({
        pageIndex: i,
        ...cell,
        // Storeys you are not standing on run out to full recession, and
        // `offFloor` keeps them imposters, so the ring above and the ring
        // below read as translucent scenery either side of your own.
        recession: isFocusFloor
          ? Math.min(1, 0.25 + turn * 0.45)
          : Math.min(1, 0.85 + Math.abs(floorDelta) * 0.1 + turn * 0.1),
        isFocusCell: false,
        isStage: false,
        offFloor: !isFocusFloor,
      });
    }
  }
  return out;
}

// ── Elevator shell (the atrium the rings hang in) ────────────
//
// Rings of pages floating in an empty void read as a debug view of a
// cylinder, not as a place: there is nothing to tell the eye how far away a
// page is, where one storey stops and the next begins, or which way is up.
// So the shaft is BUILT — each storey gets the two horizontal lines a real
// gallery floor has (a deck under its pages, a lit soffit over them), a
// balustrade at the edge of the well, and a wall behind the pages closing the
// void off. The reader stands in the well at the axis, which is what makes
// this an atrium seen from the lift rather than a room.
//
// Sizes only. What the surfaces are MADE of — and the light on them — is the
// renderer's business (scene/elevator-decor.tsx), exactly as with the rooms
// shell above.

// Every clearance below is quoted for a Quest-sized page and then scaled by
// `trim` (see ATRIUM_TRIM_REF). The storeys are only ELEVATOR_FLOOR_GAP apart
// on top of the pages themselves, so on a small-panel profile — a Ray-Ban
// page is barely half a Quest's — absolute trim eats the entire gap between
// one storey's deck and the next one's ceiling and the building closes up.

/** The page height these clearances were drawn against (Quest 3 at ring scale). */
const ATRIUM_TRIM_REF = 0.54;
/** How far in from the ring the walkway's inner edge (the well) sits. */
const ATRIUM_DECK_INNER = 0.55;
/** …and how far past the ring its outer edge runs, up to the shaft wall. */
const ATRIUM_DECK_OUTER = 0.26;
/**
 * Headroom around a page at FULL size — which is what the pointer grows one
 * to, in place on the ring. Measured off the emphasised page, not the
 * ring-scale one: a bay sized to the pages at rest is a bay the page you are
 * pointing at sticks out of at both ends, and the deck is a solid annulus for
 * it to stick out THROUGH.
 */
const ATRIUM_PAGE_CLEAR = 0.06;
/**
 * The balustrade round the well, which hangs BELOW that headroom rather than
 * standing in it. The rail runs at the well's radius, half a metre nearer the
 * reader than the ring, so it draws a line across everything on the ring that
 * is lower than it is: with its top under the emphasised page's bottom edge
 * it crosses nothing, whatever the pointer is doing.
 */
const ATRIUM_RAIL_HEIGHT = 0.16;
/** Gap left between the storey plaque and the surfaces it stands between. */
const ATRIUM_PLAQUE_REVEAL = 0.012;

/**
 * How thick the atrium's trim may be on this build — see ElevatorShell.trim.
 * Both the storey pitch and the shell itself are sized through it, so it has
 * to be one function and not a number computed in two places.
 */
function atriumTrim(panel: { height: number }): number {
  return Math.min(
    1,
    Math.max(0.4, (panel.height * ELEVATOR_S) / ATRIUM_TRIM_REF),
  );
}
/** The shaft wall stands this far behind the pages. */
const ATRIUM_WALL_STANDOFF = 0.34;
/** How far past the top and bottom storeys the shaft runs on before it fades.
 *  A shaft that stopped level with the last floor would be a tube, not a
 *  building you are riding through the middle of. */
const ATRIUM_SHAFT_OVERRUN = 1.1;

/** One storey of the atrium: its ring, the surfaces around it, its plaque. */
export interface ElevatorFloorShell {
  /** Storey offset from the reader's own: −1 is above (earlier), +1 below. */
  delta: number;
  /** Which section this is, and how many the document has. */
  index: number;
  floorCount: number;
  label: string;
  /** Pages the section holds, and how many of them fit on the ring. */
  pageCount: number;
  shownCount: number;
  /** Ring axis centre, panel-anchor-relative (the axis is the reader). */
  centre: { x: number; y: number; z: number };
  radius: number;
  /** The pages' own vertical extent — the band the storey's surfaces frame. */
  bandTopY: number;
  bandBottomY: number;
  /** The walkway under the pages, and the lit ceiling over them. */
  deckY: number;
  soffitY: number;
  /** The reserved slot dead ahead, where the storey's plaque hangs. */
  plaque: {
    /** Centre of the plate (not a top-left anchor — the plaque is a sign). */
    offset: { x: number; y: number; z: number };
    rotation: { x: number; y: number; z: number };
    size: { width: number; height: number };
  };
}

export interface ElevatorShell {
  floors: ElevatorFloorShell[];
  /** The shaft wall: one cylinder around every visible storey. */
  shaft: { centreX: number; centreZ: number; radius: number; topY: number; bottomY: number };
  /** Deck/soffit ring radii, as offsets from a storey's own ring radius —
   *  which varies per storey, so they cannot be radii themselves. */
  deckInner: number;
  deckOuter: number;
  /**
   * How thick the renderer may draw the trim (fascias, rails, cove strips):
   * 1 on a Quest-sized page, less on a smaller one. The gap left between two
   * storeys scales with the page, so anything the renderer hangs off a deck
   * has to scale with it too or the floors merge.
   */
  trim: number;
  /**
   * The balustrade standing on the deck's inner edge. It tops out below the
   * bottom edge of a full-size page, so it never draws itself across anything
   * on the ring — see ATRIUM_RAIL_HEIGHT.
   */
  railHeight: number;
  /** Names of the storeys just off the top and bottom of the shaft, for the
   *  directory's ▲/▼ lines — the whole point of a lift's floor indicator is
   *  telling you what is on the floors you cannot see. */
  above: string | null;
  below: string | null;
}

/**
 * The atrium around the rings: one storey per visible floor, plus the shaft
 * wall enclosing all of them. Returns an empty shell for every other view.
 */
export function computeElevatorShell(
  mode: PageDistribution,
  pageCount: number,
  panel: { width: number; height: number },
  focus: number,
  opts: PagePlacementOptions = {},
): ElevatorShell | null {
  if (mode !== "elevator" || pageCount < MIN_PAGES_FOR_PAGE_VIEWS) return null;
  const viewingDistance = opts.viewingDistance ?? 1.2;
  const ranges = elevatorFloors(
    resolveRanges(opts.sectionRanges, pageCount),
    pageCount,
  );
  const { index: focusFloor } = rangeOf(focus, ranges, pageCount);
  const ph = panel.height * ELEVATOR_S;
  const trim = atriumTrim(panel);

  const floors: ElevatorFloorShell[] = [];
  let maxRadius = 0;
  for (let s = 0; s < ranges.length; s++) {
    const delta = s - focusFloor;
    if (Math.abs(delta) > ELEVATOR_FLOOR_WINDOW) continue;
    const isFocusFloor = delta === 0;
    const { count, radius } = elevatorFloorRing(
      ranges[s],
      isFocusFloor,
      focus,
      panel,
      viewingDistance,
    );
    const centre = elevatorFloorCentre(delta, panel, viewingDistance);
    maxRadius = Math.max(maxRadius, radius);
    // The plaque fills its bay — from the top of the balustrade to the
    // soffit, less a reveal at each end — rather than stopping level with the
    // pages. It is the one slot on the ring that is architecture rather than
    // content, and a floor indicator that fills the bay reads as built into
    // the wall; at page height it read as a page with no page on it, and its
    // rows of signage had nowhere to go. It stops AT the rail rather than
    // running past it to the deck, because a plate whose last two rows sit
    // behind the balustrade is a plate with its controls hidden.
    // The bay holds whatever the pointer does to a page in it: a FULL-SIZE
    // page, plus headroom at the ceiling, plus the balustrade's whole height
    // below the page's bottom edge — the rail has to finish under the biggest
    // page there can be, or it draws itself across the one being read. The
    // ring pages, at 0.6 of full size, therefore hang in a tall bay with wall
    // to spare above and below them.
    const soffitY = centre.y + panel.height / 2 + ATRIUM_PAGE_CLEAR * trim;
    const railTopY = centre.y - panel.height / 2 - ATRIUM_PAGE_CLEAR * trim;
    const deckY = railTopY - ATRIUM_RAIL_HEIGHT * trim;
    const plaqueBottom = centre.y - ph / 2 + ATRIUM_PLAQUE_REVEAL * trim;
    const plaqueTop = soffitY - ATRIUM_PLAQUE_REVEAL * trim;
    floors.push({
      delta,
      index: s,
      floorCount: ranges.length,
      label: ranges[s].label,
      pageCount: ranges[s].end - ranges[s].start + 1,
      shownCount: count,
      centre,
      radius,
      bandTopY: centre.y + ph / 2,
      bandBottomY: centre.y - ph / 2,
      deckY,
      soffitY,
      plaque: {
        // Slot 0 is dead ahead of the reader (see elevatorAngle), and a slot
        // is one page wide — so the plaque is exactly as wide as the pages
        // flanking it, part of the wall rather than floating in front of it.
        offset: {
          x: centre.x,
          y: (plaqueBottom + plaqueTop) / 2,
          z: centre.z - radius,
        },
        rotation: rot0, // θ = 0: facing the axis is facing the reader
        size: {
          width: panel.width * ELEVATOR_S,
          height: plaqueTop - plaqueBottom,
        },
      },
    });
  }
  if (floors.length === 0) return null;

  const top = floors[0]; // ranges run top (earliest) to bottom
  const bottom = floors[floors.length - 1];
  return {
    floors,
    shaft: {
      centreX: floors[0].centre.x,
      centreZ: floors[0].centre.z,
      radius: maxRadius + ATRIUM_WALL_STANDOFF * trim,
      topY: top.soffitY + ATRIUM_SHAFT_OVERRUN,
      bottomY: bottom.deckY - ATRIUM_SHAFT_OVERRUN,
    },
    deckInner: -ATRIUM_DECK_INNER * trim,
    deckOuter: ATRIUM_DECK_OUTER * trim,
    trim,
    railHeight: ATRIUM_RAIL_HEIGHT * trim,
    above: ranges[top.index - 1]?.label ?? null,
    below: ranges[bottom.index + 1]?.label ?? null,
  };
}

// ── Wall ─────────────────────────────────────────────────────
// The wall is not a contact sheet of every page — it is a board of the
// document's OUTLINE that opens one level at a time (Anand, 2026-08-01):
//
//   1. Overview  — one tile per ROOT+1 section (the panel's top-level
//      sections). A hundred-page article is a dozen tiles, which is what a
//      wall is good for.
//   2. Section open — clicking a tile expands it IN PLACE into that
//      section's pages as previews. The tile stays at the head of its run
//      (click it again to close), and everything after it reflows around
//      the run rather than the wall being replaced — so the sections you
//      didn't open keep their place, and with it their spatial memory.
//   3. Page open — clicking a preview grows it to FULL SIZE in its own
//      cell, a WALL_OPEN_SPAN² block the rest of the board flows around.
//      No page ever flies to a separate stage; the wall has no stage.
//
// Everything is one reflowing grid, so all three states are the same
// layout problem: a list of cells with a footprint each, packed row-major
// into a gently arced board centred on the reader. `computeWallCells` is
// the whole of it, and being pure it is AABB-checkable offline like the
// other modes.
//
// HOVER: pointing at a cell makes EVERY cell on the board lean toward it
// (`WALL_TILT_MAX`, falling off with distance), so the board turns to face
// what you're looking at and the pointed-at cell reads as the focus of the
// room. The page being read full size is the one exception — it stays flat,
// because it is a reading surface, not scenery.

const WALL_TILE_SCALE = 0.24; // section tiles and page previews
const WALL_GAP = 0.05; // between grid cells, metres
/**
 * Preferred rows before the board grows sideways instead. Low on purpose:
 * the horizontal arc is the cheap axis (~±45° of head rotation) and
 * sustained up-gaze is the most fatiguing direction there is, so a wide
 * short board beats a tall narrow one at the same cell count.
 */
const WALL_MAX_ROWS = 3;
const WALL_MIN_COLS = 3;
const WALL_MAX_COLS = 8;
/**
 * Grid footprint (in cells, square) of a page opened to full size. Five is
 * the smallest span whose block holds a whole panel in BOTH axes at
 * WALL_TILE_SCALE — "full size" has to mean full size, not almost.
 */
export const WALL_OPEN_SPAN = 5;
const WALL_YAW_PER_M = 0.16; // gentle arc: yaw ∝ horizontal offset from centre
const WALL_DEPTH_PER_M = 0.06; // …and the board curls away by this much
/**
 * The board hangs behind the reading plane. It is centred on where the reader
 * is already looking (the panel's centre — up-gaze is the expensive
 * direction), which is also where the in-world view toggle and tab bar are
 * anchored, so the separation from the chrome has to be in DEPTH: the chrome
 * keeps the panel plane and the wall stands off behind it.
 */
const WALL_BACK = -0.55;
/** …and an opened page comes back to the reading plane to be read. */
const WALL_OPEN_LIFT = 0.55;
const WALL_TILT_MAX = 0.34; // ~19°: how far a cell leans toward the pointer
const WALL_TILT_FALLOFF = 0.35; // metres — roughly a cell, so neighbours lean too

/** One cell of the wall board: a section tile or one of a section's pages. */
export interface WallCell {
  /** Stable across reflows, so <AtPos> morphs a cell instead of cutting. */
  key: string;
  kind: "section" | "page";
  /** Index into the section ranges the board was built from. */
  sectionIndex: number;
  /** kind === "page". */
  pageIndex?: number;
  /** Section name, or the page's first heading. */
  label: string;
  /** kind === "section": how many pages the tile stands for. */
  pages?: number;
  /** The expanded section's tile, or the page opened to full size. */
  open: boolean;
  /** Top-left anchor, relative to the main panel's top-left anchor. */
  offset: { x: number; y: number; z: number };
  rotation: { x: number; y: number; z: number };
  scale: number;
  recession: number;
}

export interface WallOptions {
  sectionRanges?: SectionPageRange[];
  /** Index of the expanded section, or null for the outline overview. */
  openSection?: number | null;
  /** Page shown at full size inside the expanded section, or null. */
  openPage?: number | null;
  /** `key` of the cell under the pointer — the board leans toward it. */
  hoverKey?: string | null;
}

interface WallItem {
  key: string;
  kind: "section" | "page";
  sectionIndex: number;
  pageIndex?: number;
  label: string;
  pages?: number;
  open: boolean;
  span: number;
  row: number;
  col: number;
}

export function wallSectionKey(sectionIndex: number): string {
  return `wall-section-${sectionIndex}`;
}

export function wallPageKey(pageIndex: number): string {
  return `wall-page-${pageIndex}`;
}

/**
 * The cells the board shows, in reading order: every section's tile, with the
 * open section's pages spliced in right behind its own tile.
 */
function wallItems(
  ranges: SectionPageRange[],
  openSection: number | null,
  openPage: number | null,
  headingOf: (page: number) => string,
): WallItem[] {
  const items: WallItem[] = [];
  for (let s = 0; s < ranges.length; s++) {
    const r = ranges[s];
    const isOpen = s === openSection;
    items.push({
      key: wallSectionKey(s),
      kind: "section",
      sectionIndex: s,
      label: r.label || `Section ${s + 1}`,
      pages: r.end - r.start + 1,
      open: isOpen,
      span: 1,
      row: 0,
      col: 0,
    });
    if (!isOpen) continue;
    for (let p = r.start; p <= r.end; p++) {
      const full = p === openPage;
      items.push({
        key: wallPageKey(p),
        kind: "page",
        sectionIndex: s,
        pageIndex: p,
        label: headingOf(p),
        open: full,
        span: full ? WALL_OPEN_SPAN : 1,
        row: 0,
        col: 0,
      });
    }
  }
  return items;
}

/**
 * Column count: enough that the board stays inside the vertical comfort band
 * at WALL_MAX_ROWS, and at least wide enough to hold a full-size page's
 * block at all.
 *
 * Counted over cells, deliberately not over area: if opening a page widened
 * the board, every cell would shift under the reflow and the page would not
 * expand in place however carefully the block was positioned. The board's
 * width is a property of what the section holds, not of what is open in it.
 */
function wallColumns(items: WallItem[], hasOpenPage: boolean): number {
  let cols = Math.max(WALL_MIN_COLS, Math.ceil(items.length / WALL_MAX_ROWS));
  if (hasOpenPage) cols = Math.max(cols, WALL_OPEN_SPAN);
  return Math.min(cols, WALL_MAX_COLS);
}

/**
 * Packing. Every cell is 1×1 except the opened page, which gets a BAND of
 * its own: the whole of `WALL_OPEN_SPAN` rows, starting on the first row
 * after every cell that precedes it in reading order, with the page's block
 * centred in it. So the board reads strictly top to bottom — the cells
 * before the page in complete rows above the band, the page, then the cells
 * after it in complete rows below. Nothing is ever beside the page, which
 * is the whole point.
 *
 * Three earlier versions got this wrong, each in a way only visible on a
 * particular page:
 *
 *  - First-fit put the block at the earliest slot it fitted, so opening the
 *    LAST page of a section yanked it to the front of the board.
 *  - Centring the block on its own cell and clamping into the grid broke at
 *    the END of a document: the last page's cell is near the top of a short
 *    board, so the clamp pulled the block to row 0 and pushed every tile
 *    that should precede it underneath.
 *  - Anchoring the block's top-left on its own cell fixed both, but left the
 *    remaining cells flowing in a narrow strip beside it — and when the
 *    block sits right of centre that strip is on its LEFT, so reading ran
 *    backwards and down (Anand, 2026-08-01, on the first page of a
 *    13-page section: "it goes to the last row and the order might be a bit
 *    confusing"). A side strip reads badly whichever side it lands on: the
 *    cells next in order sit level with the middle of a five-row block.
 *
 * The tail of the row before the band is left dead — a line break before a
 * full-width figure, rather than a later cell reaching backwards into a
 * hole that sits before the page in reading order.
 *
 * Returns the number of rows used.
 */
function wallPack(items: WallItem[], cols: number): number {
  const occ = new Set<number>();
  const at = (row: number, col: number) => row * cols + col;
  let rows = 0;

  // ── the opened page's band ──
  const open = items.findIndex((it) => it.span > 1);
  if (open >= 0) {
    const span = items[open].span;
    // First row after the cells that precede it — they fill without holes,
    // so that is just their count over the row width.
    const row = Math.ceil(open / cols);
    const tail = open % cols;
    if (tail !== 0) for (let c = tail; c < cols; c++) occ.add(at(row - 1, c));
    // The page sits centred in its band, so it is in the same place every
    // time: whichever page you open, it is the one thing in the middle.
    items[open].row = row;
    items[open].col = Math.max(0, Math.floor((cols - span) / 2));
    for (let r = row; r < row + span; r++)
      for (let c = 0; c < cols; c++) occ.add(at(r, c));
    rows = row + span;
  }

  // ── everything else, row-major in reading order ──
  for (const it of items) {
    if (it.span > 1) continue;
    let placed = false;
    for (let row = 0; !placed; row++) {
      for (let col = 0; col < cols; col++) {
        if (occ.has(at(row, col))) continue;
        occ.add(at(row, col));
        it.row = row;
        it.col = col;
        rows = Math.max(rows, row + 1);
        placed = true;
        break;
      }
    }
  }
  return rows;
}

/**
 * Anchor of a cell whose CENTRE is `c` and whose rotation is (pitch, yaw, 0).
 * three.js's default "XYZ" Euler order composes as Rx·Ry, so the top-left
 * corner sits at c + Rx(φ)·Ry(θ)·(−w/2, +h/2, 0). Rotating about the anchor
 * without this correction would swing a leaning cell off its own grid slot.
 */
function wallAnchor(
  c: { x: number; y: number; z: number },
  w: number,
  h: number,
  pitch: number,
  yaw: number,
): { x: number; y: number; z: number } {
  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  return {
    x: c.x - (w / 2) * cy,
    y: c.y - (w / 2) * sp * sy + (h / 2) * cp,
    z: c.z + (w / 2) * cp * sy + (h / 2) * sp,
  };
}

/**
 * The board's arc, at a given x in the panel-anchor frame: how far back the
 * surface is there, and which way it faces. Cells ride this law, and so does
 * the backing wall behind them (`computeWallBoard`) — one function, so the
 * board can never drift out of the plane its own cells hang on.
 */
export function wallArcAt(
  x: number,
  panelWidth: number,
): { z: number; yaw: number } {
  const offX = x - panelWidth / 2;
  return {
    z: WALL_BACK - Math.abs(offX) * WALL_DEPTH_PER_M,
    yaw: -offX * WALL_YAW_PER_M,
  };
}

/** The packed grid a board is drawn from — shared by cells and backing. */
interface WallGrid {
  items: WallItem[];
  cols: number;
  rows: number;
  cw: number;
  ch: number;
  /** Left and top EDGES of the packed grid, panel-anchor-relative. */
  left: number;
  top: number;
  centres: { x: number; y: number }[];
}

function wallGrid(
  pageCount: number,
  panel: { width: number; height: number },
  opts: WallOptions & { headingOf?: (page: number) => string },
): WallGrid | null {
  if (pageCount < MIN_PAGES_FOR_PAGE_VIEWS) return null;
  const ranges =
    opts.sectionRanges && opts.sectionRanges.length > 0
      ? opts.sectionRanges
      : [{ start: 0, end: pageCount - 1, label: "" }];
  const openSection =
    opts.openSection != null && opts.openSection < ranges.length
      ? opts.openSection
      : null;
  const openPage = openSection === null ? null : (opts.openPage ?? null);

  const items = wallItems(
    ranges,
    openSection,
    openPage,
    opts.headingOf ?? (() => ""),
  );
  const cols = wallColumns(items, openPage !== null);
  const rows = wallPack(items, cols);

  // The cell size is a CONSTANT, never fitted to the current row count: a
  // board whose tiles resized every time something opened would undo the
  // whole point of leaving the closed sections where they were.
  const cw = panel.width * WALL_TILE_SCALE + WALL_GAP;
  const ch = panel.height * WALL_TILE_SCALE + WALL_GAP;
  const left = panel.width / 2 - (cols * cw - WALL_GAP) / 2;
  const top = -panel.height / 2 + (rows * ch - WALL_GAP) / 2;

  const centres = items.map((it) => ({
    x: left + it.col * cw + (it.span * cw - WALL_GAP) / 2,
    y: top - it.row * ch - (it.span * ch - WALL_GAP) / 2,
  }));
  return { items, cols, rows, cw, ch, left, top, centres };
}

/**
 * The board. Cells are packed into a grid centred on the panel, given the
 * arc's yaw/pushback, then leaned toward whatever the pointer is on.
 */
export function computeWallCells(
  pageCount: number,
  panel: { width: number; height: number },
  opts: WallOptions & { headingOf?: (page: number) => string } = {},
): WallCell[] {
  const grid = wallGrid(pageCount, panel, opts);
  if (!grid) return [];
  const { items, centres } = grid;

  // Grid centres first: the lean needs to know where the pointed-at cell is.
  const hovered = opts.hoverKey
    ? centres[items.findIndex((it) => it.key === opts.hoverKey)]
    : undefined;

  return items.map((it, i) => {
    const c = centres[i];
    const arc = wallArcAt(c.x, panel.width);
    let yaw = arc.yaw;
    let pitch = 0;
    // Lean toward the pointer. A cell's face is +z, and (φ, θ) turns it to
    // (sin θ, −sin φ cos θ, cos φ cos θ) — so +θ looks right and −φ looks up.
    // The full-size page is exempt: it is being read, not admired.
    if (hovered && !(it.kind === "page" && it.open)) {
      yaw += WALL_TILT_MAX * Math.tanh((hovered.x - c.x) / WALL_TILT_FALLOFF);
      pitch = -WALL_TILT_MAX * Math.tanh((hovered.y - c.y) / WALL_TILT_FALLOFF);
    }
    // The opened page is drawn at full size, centred in its block.
    const full = it.kind === "page" && it.open;
    const scale = full ? 1 : WALL_TILE_SCALE;
    const centre = {
      x: c.x,
      y: c.y,
      // Only the PAGE being read steps off the wall toward the reader. An
      // expanded section's tile stays flush with the rest of the board —
      // lifting it too put a thumbnail at reading distance, right in the
      // reader's face, for no reason: its accent bar and chevron already say
      // it is open.
      z: arc.z + (full ? WALL_OPEN_LIFT : 0),
    };
    return {
      key: it.key,
      kind: it.kind,
      sectionIndex: it.sectionIndex,
      pageIndex: it.pageIndex,
      label: it.label,
      pages: it.pages,
      open: it.open,
      offset: wallAnchor(
        centre,
        panel.width * scale,
        panel.height * scale,
        pitch,
        yaw,
      ),
      rotation: { x: pitch, y: yaw, z: 0 },
      scale,
      recession: it.open ? 0 : it.kind === "section" ? 0.2 : 0.3,
    };
  });
}

// ── The board's backing ──────────────────────────────────────
//
// Cells alone are cards hanging in a void: nothing says they belong to one
// another, and unlit text sits on whatever happens to be behind it. So the
// board carries a SURFACE — a real wall it hangs on, following the same arc,
// standing off far enough behind that a leaning cell never dips into it —
// and a sign plate above the grid saying where in the document you are.
//
// It is described here, with the cells, because it is the same geometry
// problem: the wall has to be exactly the surface the arc law implies, and
// that law lives in this file.

/**
 * How far the backing sits behind the plane the cells hang on.
 *
 * Not a taste value: a cell leaning at full `WALL_TILT_MAX` swings its far
 * corners back by roughly (w + h)/2 · sin(tilt) ≈ 0.1 m at tile scale, and a
 * card that dips into the wall it hangs on is worse than no wall at all. The
 * offline board check (corners of every cell, at several hover positions,
 * against the interpolated spine) is what this number is set from — keep at
 * least a centimetre of clearance there if the tilt or tile scale changes.
 */
export const WALL_BOARD_STANDOFF = 0.17;
/** Bare surface left around the packed grid — the board's mount. */
const WALL_BOARD_MARGIN = 0.16;
/** Sample spacing along the arc; small enough that the facets don't read. */
const WALL_BOARD_SEGMENT = 0.22;
/** The sign plate above the grid: its height, its gap, its stand-off. */
const WALL_HEADER_H = 0.1;
const WALL_HEADER_GAP = 0.055;
const WALL_HEADER_LIFT = 0.06;

export interface WallArcSample {
  x: number;
  z: number;
  yaw: number;
}

export interface WallBoard {
  /** Grid extent (no margin), panel-anchor-relative — what the cells fill. */
  grid: { left: number; right: number; top: number; bottom: number };
  /** Bottom and top edges of the backing surface, margins included. */
  bottom: number;
  top: number;
  /**
   * The backing's spine, left → right: the arc lofted vertically between
   * `bottom` and `top` IS the wall. Includes the stand-off, so a renderer
   * lofts these points as-is.
   */
  spine: WallArcSample[];
  /** Centre of the sign plate over the board, and its size. */
  header: {
    centre: { x: number; y: number; z: number };
    width: number;
    height: number;
  };
}

/**
 * The surface the cells hang on, for whatever the board is currently showing.
 * Pure and derived from the same grid as `computeWallCells`, so it resizes
 * with the disclosure instead of being a fixed backdrop the board grows out of.
 */
export function computeWallBoard(
  pageCount: number,
  panel: { width: number; height: number },
  opts: WallOptions & { headingOf?: (page: number) => string } = {},
): WallBoard | null {
  const grid = wallGrid(pageCount, panel, opts);
  if (!grid) return null;
  const { cols, rows, cw, ch, left, top } = grid;

  const gridRight = left + cols * cw - WALL_GAP;
  const gridBottom = top - (rows * ch - WALL_GAP);
  const x0 = left - WALL_BOARD_MARGIN;
  const x1 = gridRight + WALL_BOARD_MARGIN;

  const steps = Math.max(2, Math.ceil((x1 - x0) / WALL_BOARD_SEGMENT));
  const spine: WallArcSample[] = [];
  for (let i = 0; i <= steps; i++) {
    const x = x0 + ((x1 - x0) * i) / steps;
    const arc = wallArcAt(x, panel.width);
    spine.push({ x, z: arc.z - WALL_BOARD_STANDOFF, yaw: arc.yaw });
  }

  // The plate is centred, where the arc's yaw is zero and its pushback least,
  // so it can be one flat quad standing proud of the wall rather than a
  // second thing that has to be bent.
  const headerY = top + WALL_HEADER_GAP + WALL_HEADER_H / 2;
  const centreZ = wallArcAt(panel.width / 2, panel.width).z;
  return {
    grid: { left, right: gridRight, top, bottom: gridBottom },
    bottom: gridBottom - WALL_BOARD_MARGIN,
    top: headerY + WALL_HEADER_H / 2 + WALL_BOARD_MARGIN * 0.6,
    spine,
    header: {
      centre: {
        x: panel.width / 2,
        y: headerY,
        z: centreZ - WALL_BOARD_STANDOFF + WALL_HEADER_LIFT,
      },
      width: Math.min(panel.width * 0.92, (x1 - x0) * 0.62),
      height: WALL_HEADER_H,
    },
  };
}

/** The section range that owns `page` — the tile a fragment jump should open. */
export function wallSectionOf(
  page: number,
  ranges: SectionPageRange[],
  pageCount: number,
): number {
  return rangeOf(page, ranges, pageCount).index;
}

// ── Deck ─────────────────────────────────────────────────────
// Data-Mountain-style desk: one pile per section on an inclined surface
// below the reading panel. Pages fan down/right within their pile with a
// small z-lift per depth so edges read as a stack; the whole surface is
// pitched back so the piles face the (standing) viewer. Reading always
// happens by focusing a page onto the real panel — the desk is for triage.
function deck(
  pageCount: number,
  panel: { width: number; height: number },
  focus: number,
  ranges: SectionPageRange[],
): PagePlacement[] {
  const S = 0.26;
  const TILT = -0.9; // ~52° pitched back — lying on an inclined desk
  const FAN_Y = -0.025; // within-pile fan (down the desk)
  const LIFT = 0.006; // per-depth lift so stacked edges are visible
  const pw = panel.width * S;
  const cw = pw + 0.08;
  const piles = Math.max(1, ranges.length);
  const deskY = -panel.height - 0.02; // band just below the reading panel
  const BACK = -0.15;

  // A pile deeper than MAX_DEPTH wraps into an adjacent sub-pile, so a
  // section with dozens of pages (or a sectionless 98-page article) fans
  // across the desk instead of descending through the floor.
  const MAX_DEPTH = 6;
  const pileStart: number[] = [];
  let totalPiles = 0;
  for (const r of ranges) {
    pileStart.push(totalPiles);
    totalPiles += Math.max(1, Math.ceil((r.end - r.start + 1) / MAX_DEPTH));
  }
  totalPiles = Math.max(1, totalPiles, piles);

  const pileOf = (page: number): { pile: number; depth: number } => {
    for (let c = 0; c < ranges.length; c++) {
      const r = ranges[c];
      if (page >= r.start && page <= r.end) {
        const k = page - r.start;
        return {
          pile: pileStart[c] + Math.floor(k / MAX_DEPTH),
          depth: k % MAX_DEPTH,
        };
      }
    }
    return { pile: 0, depth: Math.min(page, MAX_DEPTH - 1) };
  };

  const out: PagePlacement[] = [];
  for (let i = 0; i < pageCount; i++) {
    const { pile, depth } = pileOf(i);
    const centreOffX = (pile - (totalPiles - 1) / 2) * cw;
    const cell = {
      offset: {
        x: panel.width / 2 + centreOffX - pw / 2,
        y: deskY + depth * FAN_Y,
        z: BACK + depth * LIFT,
      },
      rotation: { x: TILT, y: 0, z: 0 },
      scale: S,
    };
    if (i === focus) {
      out.push(stagePlacement(i));
      out.push({
        pageIndex: i,
        ...cell,
        recession: 0,
        isFocusCell: true,
        isStage: false,
      });
    } else {
      out.push({
        pageIndex: i,
        ...cell,
        recession: Math.min(1, 0.4 + depth * 0.06),
        isFocusCell: false,
        isStage: false,
      });
    }
  }
  return out;
}

// ── Rooms ────────────────────────────────────────────────────
// A CORRIDOR OF ROOMS YOU WALK THROUGH (2026-08-02, Anand). The document is a
// building laid out as one straight enfilade: a corridor leads to a door,
// the door has the section's NAMEPLATE over it, and through it is that
// section's room with its pages on the walls. The room's far wall has a
// SECOND door, and through that is the next stretch of corridor — the one
// whose walls carry that section's RELATED LINKS — which leads to the next
// section's door. The two doors of a room are therefore never the same way
// out: you came from the corridor behind and you leave into the corridor
// ahead, and the building reads as
//
//     lobby → [room 1] → links of 1 → [room 2] → links of 2 → …
//
// Inside a room the pages hang on the two side walls, alternating left and
// right as they advance, so reading a section walks you from its entrance to
// its exit and every page is one turn of the head away.
//
// YOU WALK; THE PAGES DO NOT MOVE. There is no stage and nothing ever flies
// to the reader. The reader has a POSE in the building — where they stand and
// which way they face — and the renderer carries the whole building rigidly
// so that pose lands at the origin (see `roomPoseTransform` and
// `scene/room-walk.tsx`). Focusing a page sets the pose to the spot square-on
// to it at reading distance; the arrow/WASD keys move it directly, and
// `roomWalkStep` slides that movement along the walls, so the doorways are
// the only way between a room and the corridor.
//
// The reading pose is exactly `viewingDistance`, square on, and the pages are
// the panel's own size, so a focused page lands ON the main panel's slot: the
// reading pose is identical to the flat panel's — which is what the flat
// preview's OrbitControls target (`readingLook`) and the XR recentre
// (`panelCentre`) already aim at, and where the in-world chrome expects the
// content to be.

/** The section range that owns `page` (whole document as fallback). */
function rangeOf(
  page: number,
  ranges: SectionPageRange[],
  pageCount: number,
): { range: SectionPageRange; index: number } {
  for (let i = 0; i < ranges.length; i++) {
    const r = ranges[i];
    if (page >= r.start && page <= r.end) return { range: r, index: i };
  }
  return { range: { start: 0, end: pageCount - 1, label: "" }, index: 0 };
}

/** Exhibits are life size: you walk up to a page, it does not grow for you. */
const ROOM_PAGE_SCALE = 1;
/** Gap between two pages hung side by side on the same wall. */
const ROOM_PAGE_GAP = 0.12;
/** Half-width of the corridor between rooms. */
const CORRIDOR_HALF = 1.15;
/** Corridor in front of the first room — the building's entrance hall. */
const CORRIDOR_LOBBY = 3.0;
/** Where the first room's near wall stands. */
const ROOM_Z0 = -1.4;
/** Wall length beyond the outermost page on it. */
const ROOM_WALL_MARGIN = 0.45;
/**
 * How far a wall carries on above the top edge of the pages hung on it. Rooms
 * are for reading in, not cathedrals: this puts the wall head at about 2 m of
 * world height, which leaves a lintel over a door without towering over the
 * pages (which hang with their tops on the panel-anchor line).
 */
const ROOM_WALL_HEADROOM = 0.55;
/**
 * Doorway opening, measured from the floor. Nearly as wide as the corridor on
 * purpose: a reader walking with the keys does not track the centre line to
 * the centimetre, and a narrow opening turns every doorway into a snag — the
 * jamb catches them and, since the push is straight into it, sliding cannot
 * help. Width here plus `roomWalkFunnel` is what keeps doors passable.
 */
const DOOR_WIDTH = 1.9;
const DOOR_HEIGHT = 1.75;
/** How wide the reader is, for walking into things. */
const WALK_RADIUS = 0.24;
/** A door out of the building: same opening, filled by the link's own leaf. */
const LINK_DOOR_W = 1.35;
const LINK_DOOR_PITCH = LINK_DOOR_W + 0.75;
/** Pages, plates and plaques sit this far proud of the wall they hang on. */
const MOUNT_PROUD = 0.02;
/** Shortest stretch of links corridor between one room and the next. */
const LINK_STRETCH_MIN = 3.4;
/** Metres past the reading distance over which a page dims to full recession. */
const ROOM_DIM_RANGE = 7;
/**
 * A room must be deep enough to stand back in: the reader reads a page from
 * `viewingDistance`, so a room shallower than this would put them in the far
 * wall. In reading distances.
 */
const ROOM_MIN_SPAN_D = 1.9;
/** How far outside a room's walls still counts as being in it (doorway slack). */
const ROOM_ENTERED_SLACK = 0.7;

/** One page's frame on a wall, in building space (panel-anchor-relative). */
interface RoomCell {
  /** Page centre. */
  centre: { x: number; y: number; z: number };
  /** Bearing of the page's face (radians about +y) — always faces into the room. */
  yaw: number;
  scale: number;
  /** Page size at room scale. */
  size: { width: number; height: number };
}

/**
 * One section's room: a box on the spine with a door in each end wall, its
 * pages on the two side walls. `zNear` is the entrance end (larger z, nearer
 * the way you came), `zFar` the exit end.
 */
interface Room {
  index: number;
  zNear: number;
  zFar: number;
  width: number;
  /** Page rows down each side wall (right wall takes the odd one). */
  rows: number;
  range: SectionPageRange;
  label: string;
}

/** A stretch of corridor past a room, whose walls carry that section's links. */
interface LinkStretch {
  sectionIndex: number;
  zNear: number;
  zFar: number;
}

/** The building: a lobby, then rooms and link corridors alternating. */
interface Museum {
  spineX: number;
  rooms: Room[];
  stretches: LinkStretch[];
  /** Corridor extent: the lobby's near edge down to the last stretch's end. */
  zStart: number;
  zEnd: number;
}

/** One outbound link found in a section's pages. */
export interface SectionLink {
  label: string;
  href: string;
}

/** Where the reader stands in the building, and which way they face. */
export interface ReaderPose {
  x: number;
  z: number;
  /** 0 looks down the corridor (−z); + turns left. */
  yaw: number;
}

/** Slot pitch: a page plus the gap that separates it from its neighbour. */
function roomSlot(panel: { width: number }): number {
  return panel.width * ROOM_PAGE_SCALE + ROOM_PAGE_GAP;
}

/** Room width: wide enough to stand back from either side wall. */
function roomWidth(viewingDistance: number): number {
  return 2 * viewingDistance + 1.1;
}

/**
 * The floor plan: lobby, then for each section its room followed by the
 * stretch of corridor carrying that section's links. Cheap enough (sections
 * number in the tens) to derive on demand rather than cache, which keeps every
 * entry point a pure function of its arguments — and keeps them consistent,
 * since placements, pose, shell, plates and plaques all read this one plan.
 */
function museumPlan(
  ranges: SectionPageRange[],
  panel: { width: number; height: number },
  viewingDistance: number,
  linkCounts: number[],
): Museum {
  const spineX = panel.width / 2;
  const step = roomSlot(panel);
  const rooms: Room[] = [];
  const stretches: LinkStretch[] = [];
  let z = ROOM_Z0;
  for (let k = 0; k < ranges.length; k++) {
    const range = ranges[k];
    const n = range.end - range.start + 1;
    // Pages alternate right/left as they advance, so the room is as deep as
    // one side wall's worth of them.
    const rows = Math.max(1, Math.ceil(n / 2));
    const depth = Math.max(
      viewingDistance * ROOM_MIN_SPAN_D,
      rows * step + 2 * ROOM_WALL_MARGIN,
    );
    const zNear = z;
    const zFar = z - depth;
    rooms.push({
      index: k,
      zNear,
      zFar,
      width: roomWidth(viewingDistance),
      rows,
      range,
      label: range.label,
    });
    // The links of the section just read, hung down the next stretch: half on
    // each wall, so the stretch is as long as one wall's worth of plates.
    const perWall = Math.ceil((linkCounts[k] ?? 0) / 2);
    const stretch = Math.max(LINK_STRETCH_MIN, perWall * LINK_DOOR_PITCH + 1.4);
    stretches.push({ sectionIndex: k, zNear: zFar, zFar: zFar - stretch });
    z = zFar - stretch;
  }
  return {
    spineX,
    rooms,
    stretches,
    zStart: ROOM_Z0 + CORRIDOR_LOBBY,
    zEnd: z,
  };
}

/**
 * Where page `slot` of a room hangs: pages alternate the right and left side
 * walls, advancing from the entrance toward the exit, so reading a section
 * through walks the reader the length of its room and leaves them at the far
 * door. Every page faces into the room, mounted proud of its wall.
 */
function roomCell(
  m: Museum,
  room: Room,
  slot: number,
  panel: { width: number; height: number },
): RoomCell {
  const pw = panel.width * ROOM_PAGE_SCALE;
  const ph = panel.height * ROOM_PAGE_SCALE;
  const step = roomSlot(panel);
  const side: 1 | -1 = slot % 2 === 0 ? 1 : -1; // first page on the right
  const row = Math.floor(slot / 2);
  const zc = (room.zNear + room.zFar) / 2;
  return {
    centre: {
      x: m.spineX + side * (room.width / 2 - MOUNT_PROUD),
      y: -panel.height / 2,
      z: zc + ((room.rows - 1) / 2 - row) * step,
    },
    yaw: (-side * Math.PI) / 2, // faces across the room
    scale: ROOM_PAGE_SCALE,
    size: { width: pw, height: ph },
  };
}

/**
 * A cell's top-left anchor — what a placement carries, since the renderer
 * rotates a cell about its anchor: anchor = centre + Ry(yaw)·(−pw/2, ph/2, 0).
 */
function roomCellAnchor(c: RoomCell): { x: number; y: number; z: number } {
  return {
    x: c.centre.x - (c.size.width / 2) * Math.cos(c.yaw),
    y: c.centre.y + c.size.height / 2,
    z: c.centre.z + (c.size.width / 2) * Math.sin(c.yaw),
  };
}

/** The cell page `page` hangs in, wherever in the building that is. */
function roomCellOf(
  page: number,
  m: Museum,
  panel: { width: number; height: number },
): RoomCell {
  const room =
    m.rooms.find((r) => page >= r.range.start && page <= r.range.end) ??
    m.rooms[0];
  return roomCell(m, room, page - room.range.start, panel);
}

/** The plan every rooms entry point works from, built from the same options. */
function planFor(
  pageCount: number,
  panel: { width: number; height: number },
  opts: PagePlacementOptions,
): Museum {
  const ranges = resolveRanges(opts.sectionRanges, pageCount);
  return museumPlan(
    ranges,
    panel,
    opts.viewingDistance ?? 1.2,
    ranges.map((_, i) => opts.sectionLinks?.[i]?.length ?? 0),
  );
}

/**
 * Every page on its wall, unchanged by focus — the building is architecture.
 * Only the dimming moves with the reader: a page recedes with how far it is
 * from where the reader is standing, not with how deep into the document it
 * sits.
 */
function rooms(
  pageCount: number,
  panel: { width: number; height: number },
  focus: number,
  opts: PagePlacementOptions,
): PagePlacement[] {
  const m = planFor(pageCount, panel, opts);
  const viewingDistance = opts.viewingDistance ?? 1.2;
  const eye =
    opts.readerPose ?? poseFacing(roomCellOf(focus, m, panel), viewingDistance);
  const out: PagePlacement[] = [];
  for (let i = 0; i < pageCount; i++) {
    const c = roomCellOf(i, m, panel);
    const dist = Math.hypot(c.centre.x - eye.x, c.centre.z - eye.z);
    out.push({
      pageIndex: i,
      offset: roomCellAnchor(c),
      rotation: { x: 0, y: c.yaw, z: 0 },
      scale: c.scale,
      recession:
        i === focus
          ? 0
          : Math.min(1, Math.max(0, (dist - viewingDistance) / ROOM_DIM_RANGE)),
      isFocusCell: false,
      // Not a stage: the page hasn't moved, the reader has. The flag just
      // says "this is the exhibit being read" — draw it live and interactive.
      isStage: i === focus,
    });
  }
  return out;
}

// ── Standing, walking, looking ───────────────────────────────

/**
 * The pose that reads a cell: square on to it, one reading distance back.
 *
 * ONE yaw convention, and everything else here obeys it: the reader's forward
 * is `(−sin yaw, −cos yaw)`, so yaw 0 looks down −z and + turns left — which
 * is what `useRoomWalking` moves along. Standing back along a page's normal
 * and facing the page therefore means taking the page's own bearing, NOT its
 * opposite: the page faces the reader, the reader faces the page, and both
 * bearings are the same number. (Getting this wrong by π still reads square
 * on to the page — the walk transform cancelled it — but reverses every
 * movement key, which is exactly how the bug showed up.)
 */
function poseFacing(c: RoomCell, viewingDistance: number): ReaderPose {
  const d = viewingDistance * c.scale;
  return {
    x: c.centre.x + Math.sin(c.yaw) * d,
    z: c.centre.z + Math.cos(c.yaw) * d,
    yaw: c.yaw,
  };
}

/**
 * Where the reader stands to read each page of a room: the spot on the floor
 * at reading distance, square on. The renderer marks these — one blue disc
 * per page — so a reader in a room can see where to stand for every page in
 * it, and walk (or click) to one. It is the rooms view's whole navigation:
 * a page-at-a-time widget belongs to a panel you sit in front of, not to a
 * building you walk around.
 */
export interface ReadingSpot {
  pageIndex: number;
  /** On the floor, at reading distance from the page. */
  centre: { x: number; y: number; z: number };
  /** Which way the reader faces standing here. */
  yaw: number;
}

export function computeReadingSpots(
  mode: PageDistribution,
  pageCount: number,
  panel: { width: number; height: number },
  opts: PagePlacementOptions = {},
): ReadingSpot[] {
  if (mode !== "rooms" || pageCount < MIN_PAGES_FOR_PAGE_VIEWS) return [];
  const m = planFor(pageCount, panel, opts);
  const vd = opts.viewingDistance ?? 1.2;
  const floorY = opts.floorY ?? -panel.height * 2;
  const out: ReadingSpot[] = [];
  for (let i = 0; i < pageCount; i++) {
    const pose = poseFacing(roomCellOf(i, m, panel), vd);
    out.push({
      pageIndex: i,
      centre: { x: pose.x, y: floorY, z: pose.z },
      yaw: pose.yaw,
    });
  }
  return out;
}

/** The centre of the page `page` hangs at — what proximity is measured to. */
export function roomPageCentre(
  mode: PageDistribution,
  pageCount: number,
  panel: { width: number; height: number },
  page: number,
  opts: PagePlacementOptions = {},
): { x: number; y: number; z: number } | null {
  if (mode !== "rooms" || pageCount < MIN_PAGES_FOR_PAGE_VIEWS) return null;
  return roomCellOf(page, planFor(pageCount, panel, opts), panel).centre;
}

/** Where the reader stands to read `focus`. */
export function roomReadingPose(
  mode: PageDistribution,
  pageCount: number,
  panel: { width: number; height: number },
  focus: number,
  opts: PagePlacementOptions = {},
): ReaderPose | null {
  if (mode !== "rooms" || pageCount < MIN_PAGES_FOR_PAGE_VIEWS) return null;
  const m = planFor(pageCount, panel, opts);
  return poseFacing(roomCellOf(focus, m, panel), opts.viewingDistance ?? 1.2);
}

/**
 * Which section's room the reader is standing in, or null out in the
 * corridor. The renderer mounts only that room's pages: a room you have not
 * walked into yet is a closed box with a door, and nothing inside it can be
 * seen — so nothing inside it needs to exist.
 *
 * The test is generous by `ROOM_ENTERED_SLACK` so a reader in the doorway has
 * already arrived rather than popping the room in as they cross the threshold.
 */
export function roomAtPose(
  mode: PageDistribution,
  pageCount: number,
  panel: { width: number; height: number },
  pose: ReaderPose,
  opts: PagePlacementOptions = {},
): number | null {
  if (mode !== "rooms" || pageCount < MIN_PAGES_FOR_PAGE_VIEWS) return null;
  const m = planFor(pageCount, panel, opts);
  const s = ROOM_ENTERED_SLACK;
  for (const room of m.rooms) {
    if (
      pose.z <= room.zNear + s &&
      pose.z >= room.zFar - s &&
      Math.abs(pose.x - m.spineX) <= room.width / 2 + s
    )
      return room.index;
  }
  return null;
}

/**
 * Move the reader by (dx, dz) in building space, stopped by the walls: a step
 * that would put them within `radius` of a wall is retried along each axis on
 * its own, so they slide along a wall instead of sticking to it, and a
 * doorway is the only way from a corridor into a room.
 *
 * Lintels are not obstacles — a wall piece whose foot is above the floor is
 * the bit OVER a door, and you walk under it — so pieces are only solid if
 * they reach down to `floorY`.
 */
export function roomWalkStep(
  from: { x: number; z: number },
  dx: number,
  dz: number,
  walls: RoomWall[],
  floorY: number,
  radius = WALK_RADIUS,
): { x: number; z: number } {
  const solid = walls.filter(
    (w) => w.centre.y - w.size.height / 2 <= floorY + 0.05,
  );
  const clear = (x: number, z: number) => {
    for (const w of solid) if (wallDistance(w, x, z) < radius) return false;
    return true;
  };
  if (clear(from.x + dx, from.z + dz))
    return { x: from.x + dx, z: from.z + dz };
  // Blocked head-on. If the push is toward a doorway the reader has not lined
  // up with, steer them at it: walking a corridor with the keys does not aim
  // to the centimetre, and a door you cannot get through is worse than no
  // door at all. The nudge is along the opening, never through the wall.
  const aim = roomWalkFunnel(from, dx, dz, walls, floorY);
  if (aim) {
    const step = Math.hypot(dx, dz);
    const nx = dx + aim.x * step;
    const nz = dz + aim.z * step;
    if (clear(from.x + nx, from.z + nz))
      return { x: from.x + nx, z: from.z + nz };
  }
  // Otherwise slide along whichever axis is still free.
  if (clear(from.x + dx, from.z)) return { x: from.x + dx, z: from.z };
  if (clear(from.x, from.z + dz)) return { x: from.x, z: from.z + dz };
  return { x: from.x, z: from.z };
}

/** Distance from a point to a wall piece, in the floor plane. */
function wallDistance(w: RoomWall, x: number, z: number): number {
  const ax = Math.cos(w.yaw);
  const az = -Math.sin(w.yaw);
  const half = w.size.width / 2;
  const t = Math.max(
    -half,
    Math.min(half, (x - w.centre.x) * ax + (z - w.centre.z) * az),
  );
  return Math.hypot(x - (w.centre.x + ax * t), z - (w.centre.z + az * t));
}

/**
 * A unit nudge toward the nearest doorway the reader is heading for, or null
 * if they are simply walking into a wall. A doorway is the gap between two
 * pieces of the same wall line, which is exactly what a lintel spans — so the
 * lintels the collision ignores are also what tells us where the doors are.
 */
function roomWalkFunnel(
  from: { x: number; z: number },
  dx: number,
  dz: number,
  walls: RoomWall[],
  floorY: number,
): { x: number; z: number } | null {
  const len = Math.hypot(dx, dz);
  if (len < 1e-6) return null;
  const ux = dx / len;
  const uz = dz / len;
  let best: { x: number; z: number } | null = null;
  let bestScore = Infinity;
  for (const w of walls) {
    if (w.centre.y - w.size.height / 2 <= floorY + 0.05) continue; // not a lintel
    const toX = w.centre.x - from.x;
    const toZ = w.centre.z - from.z;
    const ahead = toX * ux + toZ * uz;
    if (ahead <= 0 || ahead > 2.5) continue; // behind, or too far to be the way
    const off = Math.hypot(toX, toZ);
    if (off > 2.5 || off > bestScore) continue;
    // Sideways component of the offset: the direction to step to line up.
    const sx = toX - ux * ahead;
    const sz = toZ - uz * ahead;
    const s = Math.hypot(sx, sz);
    if (s < 1e-4) continue;
    bestScore = off;
    best = { x: sx / s, z: sz / s };
  }
  return best;
}

// ── The shell ────────────────────────────────────────────────

/**
 * One wall surface. The pages are what a reader reads, but a wall of floating
 * pages is not a room: these are the flat surfaces they hang on, standing on
 * the floor and carrying on a head above the page band, with the DOORWAYS
 * left as gaps in them (see `wallRun` — each opening becomes the pieces
 * either side plus the lintel over it). They are what encloses the reader,
 * hides the room next door, and — with `roomWalkStep` — makes a door the only
 * way through.
 */
export interface RoomWall {
  /** Wall centre, panel-anchor-relative. */
  centre: { x: number; y: number; z: number };
  yaw: number;
  size: { width: number; height: number };
  /**
   * Set on the leaf filling a LINK DOOR: this piece of wall is a door out of
   * the building, to the gallery of the page it names. It is solid to walk
   * into — walking into it is how you go through it (see `useRoomWalking`),
   * and clicking it does the same.
   */
  portal?: { href: string; label: string; sectionIndex: number };
  /**
   * True for the piece OVER a doorway. It is not an obstacle — you walk under
   * it — and the renderer picks it out in the trim colour, which is what
   * makes an opening read as a door rather than as a hole a reader has to
   * discover by bumping into the wall either side of it.
   */
  lintel?: boolean;
  /**
   * A room's SIDE wall — the one its pages hang on. Only these get a picture
   * rail: a rail is the line a gallery hangs from, and running one down the
   * corridor as well put a long horizontal edge at eye height that converged
   * on the far doorways and struck the section signs over them out.
   */
  hangs?: boolean;
}

/** A horizontal surface — the floor a room stands on, or the ceiling over it. */
export interface RoomSlab {
  centre: { x: number; y: number; z: number };
  /** Extent along x and along z. */
  size: { width: number; depth: number };
  facing: "up" | "down";
}

/**
 * A wall run from `from` to `to` (both on the wall's line, at floor level),
 * broken by doorways: the pieces either side of each opening, plus the lintel
 * over it. A wall with no doors is one piece.
 */
function wallRun(
  from: { x: number; z: number },
  to: { x: number; z: number },
  yaw: number,
  doors: { at: number; width: number }[],
  floorY: number,
  topY: number,
): RoomWall[] {
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  const len = Math.hypot(dx, dz);
  if (len < 0.01) return [];
  const ux = dx / len;
  const uz = dz / len;
  const doorTopY = Math.min(floorY + DOOR_HEIGHT, topY - 0.1);
  const piece = (a: number, b: number, y0: number, y1: number): RoomWall => ({
    centre: {
      x: from.x + ux * ((a + b) / 2),
      y: (y0 + y1) / 2,
      z: from.z + uz * ((a + b) / 2),
    },
    yaw,
    size: { width: b - a, height: y1 - y0 },
  });
  const out: RoomWall[] = [];
  let cursor = 0;
  for (const d of [...doors].sort((p, q) => p.at - q.at)) {
    const a = Math.max(0, d.at - d.width / 2);
    const b = Math.min(len, d.at + d.width / 2);
    if (a > cursor + 0.01) out.push(piece(cursor, a, floorY, topY));
    if (topY > doorTopY + 0.01)
      out.push({ ...piece(a, b, doorTopY, topY), lintel: true });
    cursor = b;
  }
  if (len > cursor + 0.01) out.push(piece(cursor, len, floorY, topY));
  return out;
}

export function computeRoomShell(
  mode: PageDistribution,
  pageCount: number,
  panel: { width: number; height: number },
  opts: PagePlacementOptions = {},
): RoomWall[] {
  if (mode !== "rooms" || pageCount < MIN_PAGES_FOR_PAGE_VIEWS) return [];
  const m = planFor(pageCount, panel, opts);
  // Pages hang with their tops on the panel-anchor line and their feet a page
  // height below, so a wall runs from the floor to a head above the tops.
  const floorY = opts.floorY ?? -panel.height * 2;
  const topY = ROOM_WALL_HEADROOM;
  const out: RoomWall[] = [];
  const run = (
    from: { x: number; z: number },
    to: { x: number; z: number },
    yaw: number,
    doors: { at: number; width: number }[] = [],
    hangs = false,
  ) =>
    out.push(
      ...wallRun(from, to, yaw, doors, floorY, topY).map((w) =>
        hangs && !w.lintel ? { ...w, hangs: true } : w,
      ),
    );

  for (const room of m.rooms) {
    const left = m.spineX - room.width / 2;
    const right = m.spineX + room.width / 2;
    const door = [{ at: room.width / 2, width: DOOR_WIDTH }];
    // End walls, each with its doorway on the spine: the one you come in by
    // and, at the far end, the one you leave by.
    run({ x: left, z: room.zNear }, { x: right, z: room.zNear }, Math.PI, door);
    run({ x: left, z: room.zFar }, { x: right, z: room.zFar }, 0, door);
    // The side walls the pages hang on.
    run(
      { x: left, z: room.zNear },
      { x: left, z: room.zFar },
      Math.PI / 2,
      [],
      true,
    );
    run(
      { x: right, z: room.zNear },
      { x: right, z: room.zFar },
      -Math.PI / 2,
      [],
      true,
    );
  }

  // The corridor: the lobby in front of the first room, then the stretch of
  // links past each one. Both walls, facing in, with the section's link doors
  // cut into them.
  const doors = linkDoorsOf(m, opts, floorY);
  const spans: { zNear: number; zFar: number }[] = [
    { zNear: m.zStart, zFar: ROOM_Z0 },
    ...m.stretches.map((s) => ({ zNear: s.zNear, zFar: s.zFar })),
  ];
  for (const s of spans) {
    for (const side of [-1, 1] as const) {
      const x = m.spineX + side * CORRIDOR_HALF;
      const yaw = (-side * Math.PI) / 2;
      const mine = doors.filter(
        (d) =>
          Math.abs(d.centre.x - x) < 0.01 &&
          d.centre.z <= s.zNear &&
          d.centre.z >= s.zFar,
      );
      run(
        { x, z: s.zNear },
        { x, z: s.zFar },
        yaw,
        mine.map((d) => ({ at: s.zNear - d.centre.z, width: d.size.width })),
      );
    }
  }
  // Each link door's leaf: a solid piece of wall filling its opening that
  // happens to be a way out of the building.
  for (const d of doors) {
    out.push({
      centre: { ...d.centre },
      yaw: d.yaw,
      size: { ...d.size },
      portal: {
        href: d.href,
        label: d.label,
        sectionIndex: d.sectionIndex,
      },
    });
  }
  return out;
}

/**
 * The floor every space stands on and the ceiling over it — without them a
 * room is four walls in a void, which is neither a room nor somewhere a
 * reader can tell up from down. One slab pair per space: the lobby, each
 * room, and each stretch of links corridor. Rooms are wider than the
 * corridor, and the spaces tile the spine end to end, so no two overlap.
 */
export function computeRoomSlabs(
  mode: PageDistribution,
  pageCount: number,
  panel: { width: number; height: number },
  opts: PagePlacementOptions = {},
): RoomSlab[] {
  if (mode !== "rooms" || pageCount < MIN_PAGES_FOR_PAGE_VIEWS) return [];
  const m = planFor(pageCount, panel, opts);
  const floorY = opts.floorY ?? -panel.height * 2;
  const topY = ROOM_WALL_HEADROOM;
  const out: RoomSlab[] = [];
  const space = (zNear: number, zFar: number, width: number) => {
    const centre = { x: m.spineX, y: floorY, z: (zNear + zFar) / 2 };
    const size = { width, depth: zNear - zFar };
    out.push({ centre, size, facing: "up" });
    out.push({ centre: { ...centre, y: topY }, size, facing: "down" });
  };
  space(m.zStart, ROOM_Z0, CORRIDOR_HALF * 2);
  for (const room of m.rooms) space(room.zNear, room.zFar, room.width);
  for (const s of m.stretches) space(s.zNear, s.zFar, CORRIDOR_HALF * 2);
  return out;
}

// ── Light fittings ───────────────────────────────────────────

/**
 * A light fitting in the building. Rooms lit by one flat global lamp read as
 * a diagram of a room rather than a room: what makes an interior is LOCAL
 * light — pools on the floor under the luminaires, a bright page and a
 * darker corner, a corridor that dims between one doorway and the next. So
 * the building carries its own fittings, and the renderer hangs a real light
 * in the ones near the reader (see `RoomLights`).
 *
 * Two kinds, for the two jobs light does here:
 *  - `ceiling` — a flush luminaire in the ceiling, lighting the space you
 *    walk through. Their spacing is what gives a corridor its rhythm.
 *  - `picture` — a gallery light over one page, angled at it. This is the
 *    one that matters for reading: it puts the brightest thing in the room
 *    on the thing you came to read.
 */
export interface RoomFixture {
  kind: "ceiling" | "picture";
  /** The fitting itself, panel-anchor-relative. */
  centre: { x: number; y: number; z: number };
  /** Footprint of the fitting's own body (a plate, or a small shade). */
  size: { width: number; depth: number };
  /** Bearing the fitting faces — the wall's, for a picture light. */
  yaw: number;
  /** Where its light lands: the floor below, or the page it is aimed at. */
  target: { x: number; y: number; z: number };
  /** Rooms are lit warmer than the corridors between them. */
  space: "room" | "corridor";
  /** The page a picture light belongs to. */
  pageIndex?: number;
}

/** How far below the ceiling a luminaire's plate sits. */
const FIXTURE_DROP = 0.03;
/** A ceiling luminaire's plate. */
const CEILING_LIGHT_W = 0.46;
const CEILING_LIGHT_D = 0.46;
/** Longest gap between luminaires down a corridor. */
const CORRIDOR_LIGHT_PITCH = 2.6;
/** A picture light stands this far above its page's top edge… */
const PICTURE_LIGHT_RISE = 0.26;
/** …and this far out from the wall, so it looks down the page's face. */
const PICTURE_LIGHT_PROUD = 0.2;
/** The shade of a picture light. */
const PICTURE_LIGHT_W = 0.34;
const PICTURE_LIGHT_D = 0.1;

/**
 * Every fitting in the building: the luminaires over each space, and a
 * picture light over every page. Cheap and static — the reader's position
 * decides which of them get a real light, not which of them exist.
 */
export function computeRoomFixtures(
  mode: PageDistribution,
  pageCount: number,
  panel: { width: number; height: number },
  opts: PagePlacementOptions = {},
): RoomFixture[] {
  if (mode !== "rooms" || pageCount < MIN_PAGES_FOR_PAGE_VIEWS) return [];
  const m = planFor(pageCount, panel, opts);
  const floorY = opts.floorY ?? -panel.height * 2;
  const lampY = ROOM_WALL_HEADROOM - FIXTURE_DROP;

  const out: RoomFixture[] = [];
  /** A run of luminaires down the middle of a space, evenly spaced. */
  const run = (
    zNear: number,
    zFar: number,
    space: "room" | "corridor",
    pitch: number,
  ) => {
    const depth = zNear - zFar;
    const n = Math.max(1, Math.round(depth / pitch));
    for (let i = 0; i < n; i++) {
      const z = zNear - (depth * (i + 0.5)) / n;
      out.push({
        kind: "ceiling",
        centre: { x: m.spineX, y: lampY, z },
        size: { width: CEILING_LIGHT_W, depth: CEILING_LIGHT_D },
        yaw: 0,
        target: { x: m.spineX, y: floorY, z },
        space,
      });
    }
  };

  run(m.zStart, ROOM_Z0, "corridor", CORRIDOR_LIGHT_PITCH);
  for (const s of m.stretches)
    run(s.zNear, s.zFar, "corridor", CORRIDOR_LIGHT_PITCH);
  for (const room of m.rooms) {
    // A room's own luminaires follow its page rows, so the light down the
    // middle keeps step with the exhibits either side of it.
    run(room.zNear, room.zFar, "room", (room.zNear - room.zFar) / room.rows);
    // …and every page gets its own gallery light.
    for (let page = room.range.start; page <= room.range.end; page++) {
      const c = roomCell(m, room, page - room.range.start, panel);
      // Out from the wall along the page's own normal — the face points at
      // whoever stands in front of it, which is (sin yaw, cos yaw) — and up
      // above its top edge.
      const nx = Math.sin(c.yaw);
      const nz = Math.cos(c.yaw);
      out.push({
        kind: "picture",
        centre: {
          x: c.centre.x + nx * PICTURE_LIGHT_PROUD,
          y: c.centre.y + c.size.height / 2 + PICTURE_LIGHT_RISE,
          z: c.centre.z + nz * PICTURE_LIGHT_PROUD,
        },
        size: { width: PICTURE_LIGHT_W, depth: PICTURE_LIGHT_D },
        yaw: c.yaw,
        target: { ...c.centre },
        space: "room",
        pageIndex: page,
      });
    }
  }
  return out;
}

// ── Related links ────────────────────────────────────────────

/**
 * The links out of a section become DOORS in the walls of the corridor past
 * its room — the second exit's payoff. Each is a real opening with a leaf in
 * it carrying the link's text and where it goes; walking into the leaf, or
 * clicking it, follows the link through `NavigateContext`, which is how a
 * link becomes a door to another gallery rather than a note on a wall.
 */
export interface LinkDoor extends SectionLink {
  /** Centre of the opening. */
  centre: { x: number; y: number; z: number };
  yaw: number;
  size: { width: number; height: number };
  sectionIndex: number;
}

function linkDoorsOf(
  m: Museum,
  opts: PagePlacementOptions,
  floorY: number,
): LinkDoor[] {
  const out: LinkDoor[] = [];
  if (!opts.sectionLinks) return out;
  for (const stretch of m.stretches) {
    const links = opts.sectionLinks[stretch.sectionIndex] ?? [];
    links.forEach((link, i) => {
      // Doors alternate walls and march down the stretch in pairs.
      const side: 1 | -1 = i % 2 === 0 ? 1 : -1;
      const row = Math.floor(i / 2);
      out.push({
        ...link,
        sectionIndex: stretch.sectionIndex,
        centre: {
          x: m.spineX + side * CORRIDOR_HALF,
          y: floorY + DOOR_HEIGHT / 2,
          z: stretch.zNear - 0.8 - row * LINK_DOOR_PITCH,
        },
        yaw: (-side * Math.PI) / 2, // faces the corridor
        size: { width: LINK_DOOR_W, height: DOOR_HEIGHT },
      });
    });
  }
  return out;
}

export function computeLinkDoors(
  mode: PageDistribution,
  pageCount: number,
  panel: { width: number; height: number },
  opts: PagePlacementOptions = {},
): LinkDoor[] {
  if (mode !== "rooms" || pageCount < MIN_PAGES_FOR_PAGE_VIEWS) return [];
  return linkDoorsOf(
    planFor(pageCount, panel, opts),
    opts,
    opts.floorY ?? -panel.height * 2,
  );
}

// ── The walk ─────────────────────────────────────────────────

/**
 * The rigid transform that carries the whole building so the reader's pose
 * lands at the origin, looking down −z. Applied by `scene/room-walk.tsx` as
 * one eased group around the entire field, which is what makes a change of
 * focus read as walking (and turning) through the building rather than as the
 * pages rearranging themselves: relative to each other, they never move.
 *
 * Moving the world rather than the camera is deliberate. In the flat preview
 * the camera belongs to OrbitControls and in XR it belongs to the headset —
 * neither is ours to drive — and keeping the reader at the origin leaves the
 * in-world chrome, the recentre and the reading pose exactly where every
 * other view puts them.
 *
 * The transform is Translate(station) ∘ Ry(−θ) ∘ Translate(−pose): take the
 * building to where the reader is standing, turn out the way they are facing,
 * then set them down at their station in front of the main panel slot.
 * Position is panel-anchor-relative metres; `yaw` is radians. It is
 * horizontal by construction (every page hangs at the same height), so a walk
 * never disturbs the world-space y that panel clipping is built from.
 */
export interface RoomWalkPose {
  position: { x: number; y: number; z: number };
  yaw: number;
}

export function roomPoseTransform(
  pose: ReaderPose,
  panel: { width: number; height: number },
  viewingDistance: number,
): RoomWalkPose {
  // The building turns by the opposite of where the reader looks, which puts
  // their forward down −z — the direction the flat preview's camera and the
  // headset both face, and where the panel slot is.
  const yaw = -pose.yaw;
  // The reader's station: centred on the main panel slot, one reading
  // distance in front of it. Landing the pose here is what makes the walk end
  // in the same reading pose the flip view starts in.
  const station = {
    x: panel.width / 2,
    y: -panel.height / 2,
    z: viewingDistance,
  };
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  return {
    position: {
      x: station.x - (pose.x * c + pose.z * s),
      y: 0,
      z: station.z - (-pose.x * s + pose.z * c),
    },
    yaw,
  };
}

// ── Field labels (section plaques) ───────────────────────────

/** A floating text label that annotates the page field (room plaques). */
export interface FieldLabel {
  text: string;
  /** Centre of the label (and of its card, when it has one). */
  offset: { x: number; y: number; z: number };
  rotation: { x: number; y: number; z: number };
  fontSize: number;
  /** 0…1, matching the recession of the ring the plaque belongs to. */
  opacity?: number;
  /**
   * rooms: draw this as an illuminated SIGN over the door — a backing plate
   * with the name lit on it — rather than as bare text. Its plate is sized
   * from the text, which only the renderer can measure, so this is a flag
   * and not a size.
   */
  sign?: boolean;
}

/**
 * Rooms: one plaque per section, hung over that room's mouth and facing the
 * aisle — the sign above a gallery door, readable from the corridor before
 * you walk in as well as from inside the room across from it.
 */
export function computeFieldLabels(
  mode: PageDistribution,
  pageCount: number,
  panel: { width: number; height: number },
  _focus: number,
  opts: PagePlacementOptions = {},
): FieldLabel[] {
  // The elevator's plaques are part of its shell — a lift's floor indicator
  // says more than a name (see ElevatorDirectory) — so it builds its own.
  if (mode !== "rooms" || pageCount < MIN_PAGES_FOR_PAGE_VIEWS) return [];
  const m = planFor(pageCount, panel, opts);
  const floorY = opts.floorY ?? -panel.height * 2;
  const doorTop = floorY + DOOR_HEIGHT;
  return m.rooms.map((room, index) => ({
    text: room.label || `Section ${index + 1}`,
    offset: {
      // Over the door you come in by, on the CORRIDOR face of the room's near
      // wall — the sign you read walking up to it — set in the upper part of
      // the lintel. Not midway: everything horizontal in the building (the
      // skirting, the rail, the pages' own top edges) converges on eye height
      // in the distance, and a sign parked at eye height is a sign with lines
      // drawn through it. Up here it has the lintel to itself.
      x: m.spineX,
      y: doorTop - 0.05,
      z: room.zNear + MOUNT_PROUD,
    },
    // Facing back up the corridor, i.e. at whoever is walking toward the door.
    rotation: { x: 0, y: 0, z: 0 },
    fontSize: 0.15,
    // A lit sign, not bare letters: the lintel it hangs on is the darkest
    // surface in the corridor (the luminaires point away from it), so the
    // name has to carry its own light or it is a grey word on a grey band
    // half a building away.
    sign: true,
  }));
}

// ── Entry point ──────────────────────────────────────────────

export function computePagePlacements(
  mode: PageDistribution,
  pageCount: number,
  panel: { width: number; height: number },
  focus: number,
  opts: PagePlacementOptions = {},
): PagePlacement[] {
  if (mode === "flip" || pageCount < MIN_PAGES_FOR_PAGE_VIEWS) return [];
  const ranges =
    opts.sectionRanges && opts.sectionRanges.length > 0
      ? opts.sectionRanges
      : [{ start: 0, end: pageCount - 1, label: "" }];
  switch (mode) {
    case "elevator":
      return elevator(
        pageCount,
        panel,
        focus,
        ranges,
        opts.viewingDistance ?? 1.2,
      );
    case "wall":
      // The wall is an outline board, not a page field: its cells are
      // sections as well as pages and it reflows as levels open, so it has
      // its own model — see computeWallCells.
      return [];
    case "deck":
      return deck(pageCount, panel, focus, ranges);
    case "rooms":
      return rooms(pageCount, panel, focus, opts);
    default:
      return [];
  }
}
