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
   * isFocusCell marker behind. Rooms has no stage: nothing moves but the
   * reader, who walks to the page (see computeRoomWalk), so there the flag
   * only marks which exhibit is being read.
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
   * wall/deck/rooms: page ranges of the top-level sections, in
   * reading order.
   */
  sectionRanges?: SectionPageRange[];
  /** rooms: reading distance (LayoutConfig.viewingDistance). */
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
   * rooms: every page's links, indexed BY PAGE.
   *
   * A corridor belongs to a page, and all of them are built with the building
   * rather than summoned when the reader arrives — a reader walking a gallery
   * needs to see which pages lead somewhere before choosing which to stand at.
   * A page with no links has an empty entry and gets no corridor.
   *
   * Omitted means no corridors at all, which is what every other view passes.
   */
  pageLinks?: SectionLink[][];
  /**
   * rooms only: where the reader is actually standing, when they have walked
   * somewhere the focused page did not put them. Only the dimming reads it —
   * placements themselves never move — so leaving it out simply dims from the
   * focused page's reading spot instead.
   */
  readerPose?: ReaderPose;
  /**
   * rooms only: the page the reader is AT, whose corridor is BUILT OUT.
   *
   * A page's corridor now runs ALONG the wall it opens through rather than
   * away from it (see `LinkBranch`), so two pages on the same wall want the
   * same ground and only one of them can have it. Every other page keeps its
   * doorway and the lit crossing behind it — a reader walking the gallery
   * still sees which pages lead somewhere, which is why all of them used to
   * be built — and the arms, the hall and the flights arrive when the reader
   * does. Omitted means no corridor is built out at all.
   */
  activePage?: number;
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
//
// A CARD TABLE (2026-08-03, Anand: "a table of cards organized as section,
// and the user can re-organise to their liking"). The document is dealt onto
// an inclined table in front of the reader as one LANE per section — a
// solitaire tableau — and the reader may then deal it again by hand:
//
//   • Every lane is a run of overlapping cards, later pages nearer the reader
//     and on top, so each card keeps a visible top strip (its number and its
//     heading) however deep the pile gets. The last card of a lane is whole.
//   • DRAGGING a card puts it wherever the reader wants it — another lane,
//     another position in its own lane, or the empty SHELF lane at the end —
//     and the table keeps that arrangement. This is the whole point of the
//     view: the wall shows the document's structure, the deck shows YOURS.
//   • Pointing at a card lifts it off the table and parts the cards in front
//     of it, so a covered page can be read without disturbing the pile.
//   • Clicking one focuses it, and it reads at full size on the STAGE — the
//     panel's own slot, lifted just clear of the table's far edge, so the
//     table never has to be a reading surface. Nothing flies: the card stays
//     exactly where the reader put it, marked as the one being read.
//
// Geometry is done entirely in TABLE COORDINATES — u across (0 at the table's
// centre line), v up-slope from the near edge, and `proud` along the surface
// normal — and the renderer hangs one pitched group at `frame.origin`. So
// nothing here composes the pitch by hand, the drag inverts it with a single
// worldToLocal, and the whole layout is a 2D packing problem.
//
// The pitch is the one number that had to be solved rather than chosen: at
// 30° from horizontal, a table centred ~0.85 m in front of a standing reader
// and ~1 m below their eye presents its cards within ~10° of face-on. Flatter
// and the cards foreshorten to slivers; steeper and it stops being a table
// and starts being the wall.

/** Table pitch about x. Negative = the face tips up toward the reader. */
const DECK_TILT = -1.05;
/**
 * How far the reading page rises above its usual slot in this view. The table
 * has to start below the page it serves, and the page's bottom edge is
 * already low; without the lift the table would be laid out at knee height.
 *
 * Exported because both the flat preview's pivot and the headset recentre
 * have to be levelled with the page where it ACTUALLY is in this view, not
 * with the slot it would occupy in the others.
 */
export const DECK_STAGE_LIFT = 0.22;
/** Table's far edge, below the lifted page's bottom edge and in front of it. */
const DECK_FAR_DROP = 0.06;
const DECK_FAR_FORWARD = 0.14;
/** Depth of the table along its own slope. */
const DECK_DEPTH = 0.62;
/** Bare surface around the lanes. */
const DECK_MARGIN = 0.05;
/** The near strip: what the table says about itself, and the reset chip. */
const DECK_RAIL = 0.052;
/** Lane header plate — the section's name, count and reorder chips. */
const DECK_HEADER_H = 0.066;
const DECK_HEADER_GAP = 0.014;
/** Between two lane wells. */
const DECK_LANE_GAP = 0.02;
/** Bare well around the card it holds. */
const DECK_WELL_PAD = 0.012;
const DECK_MAX_SCALE = 0.2;
/** Past this the far lanes are outside a comfortable head turn. */
const DECK_MAX_WIDTH = 2.6;
/**
 * Section lanes the table will deal, before consecutive sections start
 * sharing one (the shelf is extra). A 2.6 m table at arm's length already
 * spans some ±55°, so more columns than this cannot be made wider — only
 * thinner, and a document whose structural inference finds twenty-two
 * top-level sections (the test page does) would deal itself into a row of
 * slivers nothing could be dragged into.
 */
const DECK_MAX_LANES = 8;
/**
 * …and the most the table will hold once the reader starts making lanes of
 * their own, shelf included. Past this another column can only be paid for
 * out of the width of the others, and cards too thin to pick up are worse
 * than a refused drop.
 */
const DECK_MAX_TABLE_LANES = 11;
/** Each card in a lane sits this much proud of the one behind it. */
const DECK_PROUD_STEP = 0.004;
/** …and the pointed-at card this much proud of everything. */
const DECK_HOVER_PROUD = 0.05;
/** How far the cards in front of a pointed-at one slide to uncover it. */
const DECK_HOVER_PART = 0.06;
/** The card being read stands a little off the table, marked. */
const DECK_READING_PROUD = 0.012;
/** A card's visible top strip, as a fraction of its height: number + heading. */
const DECK_MIN_STEP_FRACTION = 0.17;
/** …and the most of itself a card shows when the lane has room to spread. */
const DECK_MAX_STEP_FRACTION = 0.46;

/** The shelf: a lane that stands for no section, for the reader to fill. */
export const DECK_SHELF_ID = "lane-shelf";
/** Lanes the reader made by carrying a card off the end of the row. */
export const DECK_NEW_LANE_PREFIX = "lane-new-";

/** True for a lane the reader made, as opposed to a section's or the shelf. */
export function deckIsMadeLane(lane: { id: string }): boolean {
  return lane.id.startsWith(DECK_NEW_LANE_PREFIX);
}

/** The pitched plane the table's contents are laid out on. */
export interface DeckFrame {
  /**
   * Near-edge centre of the table, relative to the panel's top-left anchor.
   * The renderer puts one group here, rotated by `tilt`, and everything below
   * is expressed in that group's space.
   */
  origin: { x: number; y: number; z: number };
  tilt: number;
  width: number;
  depth: number;
}

/** One column of the table: a section's pages, or a lane the reader made. */
export interface DeckLane {
  /** Stable across reorders, so <AtPos> morphs a lane instead of cutting. */
  id: string;
  label: string;
  /** Index into the section ranges, or null for the shelf. */
  sectionIndex: number | null;
  /** Page indices, in the order the READER has them — not document order. */
  pages: number[];
}

/**
 * Where a carried card would land if it were dropped now.
 *
 * `new` is the answer for a card carried off the END of the row of lanes: it
 * starts a section of its own there (Anand, 2026-08-03 — a page pulled out of
 * every section has plainly been pulled out FOR something, and snapping it
 * back was the deck refusing to do the one thing the gesture asked for).
 * `null` is the only genuine no-op left: the card is off the table entirely,
 * or the table is already as many columns wide as it can go.
 */
export type DeckDrop =
  | { kind: "lane"; lane: number; slot: number }
  | { kind: "new"; at: number }
  | null;

/** The card being dragged, and where it would land if dropped now. */
export interface DeckDrag {
  pageIndex: number;
  to: DeckDrop;
}

export interface DeckOptions {
  sectionRanges?: SectionPageRange[];
  /** The reader's arrangement. Omitted → document order (deckDefaultLanes). */
  lanes?: DeckLane[];
  /** `key` of the card under the pointer. */
  hoverKey?: string | null;
  drag?: DeckDrag | null;
  /** First card shown, per lane id — for lanes longer than the table is deep. */
  laneWindows?: Record<string, number>;
  /** The page being read: its card is marked and stands proud. */
  focus?: number;
}

export interface DeckCardCell {
  key: string;
  pageIndex: number;
  lane: number;
  /** Position within the lane's visible window. */
  slot: number;
  sectionIndex: number | null;
  /** Top-left of the card, in table coordinates. */
  u: number;
  v: number;
  proud: number;
  width: number;
  height: number;
  scale: number;
  /**
   * Metres of the card's own top edge the next card leaves uncovered — the
   * strip its number and heading have to fit in. Equals its full height when
   * nothing is in front of it.
   */
  exposed: number;
  hovered: boolean;
  reading: boolean;
  recession: number;
}

export interface DeckLaneCell {
  index: number;
  id: string;
  label: string;
  sectionIndex: number | null;
  /** Pages the lane holds, and how many of them the table has room for. */
  total: number;
  shown: number;
  windowStart: number;
  /** Left edge and width of the well, in table coordinates. */
  u: number;
  width: number;
  /** The well: bottom edge and depth up-slope. */
  wellV: number;
  wellDepth: number;
  /** The header plate above it: bottom edge and height. */
  headerV: number;
  headerHeight: number;
  /** Gap between successive card tops in this lane. */
  step: number;
  /** A drop here is what the drag would do. */
  dropActive: boolean;
  /** A lane the reader made by carrying a card off the end of the row. */
  made: boolean;
}

/**
 * The place a carried card would start a new section: one just past each end
 * of the row of lanes, drawn only while something is in the air. Empty when
 * nothing is being carried, or when the table has no room for another column.
 */
export interface DeckNewLaneZone {
  /** Lane index the new lane would take. */
  at: number;
  u: number;
  width: number;
  wellV: number;
  wellDepth: number;
  /** This is the end the card is actually over. */
  active: boolean;
}

export interface DeckLayout {
  frame: DeckFrame;
  lanes: DeckLaneCell[];
  cards: DeckCardCell[];
  /** Where a carried card could start a section of its own. */
  newLaneZones: DeckNewLaneZone[];
  /** Where the focused page reads: the panel's slot, lifted clear. */
  stage: PagePlacement;
  scale: number;
  cardWidth: number;
  cardHeight: number;
  /** The near strip below the wells. */
  rail: { v: number; height: number };
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Table coordinates → an offset from the panel's top-left anchor. The
 * renderer never needs this (it hangs one pitched group and lets three
 * compose the transform); it is here so the offline placement checks can put
 * a card in the same space as everything else in this file.
 */
export function deckPoint(
  frame: DeckFrame,
  u: number,
  v: number,
  proud = 0,
): { x: number; y: number; z: number } {
  const c = Math.cos(frame.tilt);
  const s = Math.sin(frame.tilt);
  return {
    x: frame.origin.x + u,
    // Up-slope is (0, cos, sin) and the surface normal (0, −sin, cos) — the
    // columns of Rx(tilt) the renderer's group applies.
    y: frame.origin.y + v * c - proud * s,
    z: frame.origin.z + v * s + proud * c,
  };
}

/**
 * Document order: one lane per section, plus the reader's empty shelf.
 *
 * Past DECK_MAX_LANES, CONSECUTIVE sections share a lane — in order, so the
 * table still reads left to right, top to bottom, in the document's own
 * order, and a shared lane is named after the first section in it. Grouping
 * consecutive sections is the only merge that keeps that property; anything
 * cleverer (by length, by depth) would interleave them.
 */
export function deckDefaultLanes(
  ranges: SectionPageRange[] | undefined,
  pageCount: number,
): DeckLane[] {
  const rs = resolveRanges(ranges, pageCount);
  // As many lanes as the table will take, with the sections spread evenly
  // over them — nine sections make eight lanes, one of which holds two, not
  // five lanes of two apiece.
  const laneCount = Math.min(rs.length, DECK_MAX_LANES);
  const base = Math.floor(rs.length / laneCount);
  const extra = rs.length % laneCount;
  const lanes: DeckLane[] = [];
  for (let i = 0, lane = 0; i < rs.length; lane++) {
    const take = base + (lane < extra ? 1 : 0);
    const group = rs.slice(i, i + take);
    const pages: number[] = [];
    for (const r of group)
      for (let p = Math.max(0, r.start); p <= Math.min(r.end, pageCount - 1); p++)
        pages.push(p);
    const head = group[0].label || `Section ${i + 1}`;
    lanes.push({
      id: `lane-s${i}`,
      label: group.length > 1 ? `${head} +${group.length - 1}` : head,
      // The FIRST section's index, so a lane's hue is the one the wall gives
      // the same section (they can only agree exactly when nothing is
      // grouped, but the leading section is the one the lane is named for).
      sectionIndex: i,
      pages,
    });
    i += take;
  }
  lanes.push({
    id: DECK_SHELF_ID,
    label: "Shelf",
    sectionIndex: null,
    pages: [],
  });
  return lanes;
}

/** True once the reader has moved anything — i.e. the reset chip has a job. */
export function deckIsRearranged(
  lanes: DeckLane[],
  ranges: SectionPageRange[] | undefined,
  pageCount: number,
): boolean {
  const base = deckDefaultLanes(ranges, pageCount);
  if (base.length !== lanes.length) return true;
  for (let i = 0; i < base.length; i++) {
    if (base[i].id !== lanes[i].id) return true;
    if (base[i].pages.length !== lanes[i].pages.length) return true;
    for (let k = 0; k < base[i].pages.length; k++)
      if (base[i].pages[k] !== lanes[i].pages[k]) return true;
  }
  return false;
}

/** Stable card key — the same card wherever the reader moves it. */
export function deckCardKey(pageIndex: number): string {
  return `deck-card-${pageIndex}`;
}

/**
 * Card size and lane pitch for a given number of lanes. The table widens with
 * the lane count until it hits the width a head can sweep, and only then do
 * the cards shrink — a six-section document should not get five-centimetre
 * cards because a twenty-section one would need them.
 */
function deckMetrics(
  panel: { width: number; height: number },
  laneCount: number,
): { scale: number; laneWidth: number; stride: number; width: number } {
  const n = Math.max(1, laneCount);
  // The widest a lane is ever worth making: one card at full size, matted.
  const roomy = panel.width * DECK_MAX_SCALE + 2 * DECK_WELL_PAD;
  const available = DECK_MAX_WIDTH - 2 * DECK_MARGIN - (n - 1) * DECK_LANE_GAP;
  const laneWidth = Math.max(0.04, Math.min(roomy, available / n));
  // The card is derived FROM the lane it has to sit in, never the other way
  // round — so a card can no more overflow its well than the wells can
  // overflow the table.
  const scale = Math.max(0.04, (laneWidth - 2 * DECK_WELL_PAD) / panel.width);
  const width = Math.max(
    panel.width * 1.05,
    n * laneWidth + (n - 1) * DECK_LANE_GAP + 2 * DECK_MARGIN,
  );
  return { scale, laneWidth, stride: laneWidth + DECK_LANE_GAP, width };
}

/** Where the table hangs, for a given number of lanes. */
export function deckFrame(
  panel: { width: number; height: number },
  laneCount: number,
): DeckFrame {
  const { width } = deckMetrics(panel, laneCount);
  const c = Math.cos(DECK_TILT);
  const s = Math.sin(DECK_TILT);
  // Solve the origin from the FAR edge: that is the edge with a constraint on
  // it (it must clear the lifted page and stand in front of its plane), and
  // the near edge is wherever the depth then lands.
  const farY = -panel.height + DECK_STAGE_LIFT - DECK_FAR_DROP;
  const farZ = DECK_FAR_FORWARD;
  return {
    origin: {
      x: panel.width / 2,
      y: farY - DECK_DEPTH * c,
      z: farZ - DECK_DEPTH * s,
    },
    tilt: DECK_TILT,
    width,
    depth: DECK_DEPTH,
  };
}

/**
 * The lane plate's internal furniture: a spine, the section's name, its page
 * count, and the three chips (window, ‹, ›). Rectangles, centre-anchored, in
 * the plate's own frame — origin at its top-left corner, +x right, −y down.
 *
 * It is here, with the rest of the geometry, rather than laid out inline in
 * the renderer, for one reason: a plate is at most 21 cm wide on a
 * nine-section document, five things have to fit on it, and whether they do
 * is arithmetic — so it can be CHECKED offline (`deckPlateOverlaps`) instead
 * of being something you notice colliding in a headset.
 */
export interface DeckRect {
  /** Centre. */
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DeckPlateSlots {
  spine: DeckRect;
  label: DeckRect;
  count: DeckRect;
  window: DeckRect;
  left: DeckRect;
  right: DeckRect;
}

const DECK_CHIP = 0.022;
const DECK_WINDOW_CHIP_W = 0.042;

export function deckPlateSlots(width: number, height: number): DeckPlateSlots {
  const w = width;
  const h = height;
  const pad = DECK_WELL_PAD;
  const textLeft = pad + w * 0.05;
  const chipY = -h * 0.7;
  const right = { x: w - 0.018, y: chipY, width: DECK_CHIP, height: DECK_CHIP };
  const left = { x: w - 0.045, y: chipY, width: DECK_CHIP, height: DECK_CHIP };
  const windowChip = {
    x: w - 0.082,
    y: chipY,
    width: DECK_WINDOW_CHIP_W,
    height: DECK_CHIP + 0.002,
  };
  const labelW = Math.max(0.02, w - textLeft - 0.008);
  const labelH = h * 0.4;
  const countW = Math.max(
    0.02,
    windowChip.x - windowChip.width / 2 - 0.006 - textLeft,
  );
  return {
    spine: { x: pad + w * 0.01, y: -h / 2, width: w * 0.02, height: h * 0.62 },
    label: {
      x: textLeft + labelW / 2,
      y: -h * 0.1 - labelH / 2,
      width: labelW,
      height: labelH,
    },
    count: { x: textLeft + countW / 2, y: chipY, width: countW, height: h * 0.3 },
    window: windowChip,
    left,
    right,
  };
}

/** Pairs of plate furniture that overlap — empty is the only passing answer. */
export function deckPlateOverlaps(slots: DeckPlateSlots): string[] {
  const named = Object.entries(slots) as [string, DeckRect][];
  const hit: string[] = [];
  const laps = (a: DeckRect, b: DeckRect) =>
    Math.abs(a.x - b.x) < (a.width + b.width) / 2 - 1e-9 &&
    Math.abs(a.y - b.y) < (a.height + b.height) / 2 - 1e-9;
  for (let i = 0; i < named.length; i++)
    for (let j = i + 1; j < named.length; j++) {
      // The spine runs the full height of the plate down its left margin; the
      // label starts to the right of it, and nothing else goes near it.
      if (named[i][0] === "spine" || named[j][0] === "spine") continue;
      if (laps(named[i][1], named[j][1]))
        hit.push(`${named[i][0]}×${named[j][0]}`);
    }
  return hit;
}

/**
 * What the deck wants looked at: between the page being read and the middle
 * of the table, biased toward the page, as an offset from the panel's
 * top-left anchor. The view is a composition of two surfaces at very
 * different heights — aiming at either one alone puts the other off the
 * bottom (or the top) of a flat preview's frame.
 */
export function deckLookAt(panel: {
  width: number;
  height: number;
}): { x: number; y: number; z: number } {
  const frame = deckFrame(panel, 1);
  const table = deckPoint(frame, 0, frame.depth / 2);
  const stage = {
    x: panel.width / 2,
    y: -panel.height / 2 + DECK_STAGE_LIFT,
    z: 0,
  };
  const t = 0.42; // …toward the table
  return {
    x: stage.x + (table.x - stage.x) * t,
    y: stage.y + (table.y - stage.y) * t,
    z: stage.z + (table.z - stage.z) * t,
  };
}

/** The focused page's reading placement: the panel slot, lifted clear. */
function deckStage(pageIndex: number): PagePlacement {
  return {
    ...stagePlacement(pageIndex),
    offset: { x: 0, y: DECK_STAGE_LIFT, z: 0 },
  };
}

/** Rows of the table, in table coordinates: the wells, headers and rail. */
function deckRows(depth: number): {
  headerV: number;
  wellTop: number;
  wellBottom: number;
} {
  const headerV = depth - DECK_MARGIN - DECK_HEADER_H;
  return {
    headerV,
    wellTop: headerV - DECK_HEADER_GAP,
    wellBottom: DECK_RAIL + 0.012,
  };
}

/**
 * The gap between successive cards in a lane holding `n` of them, and how
 * many of them fit at all.
 *
 * A lane spreads its cards as far as the run allows, up to showing nearly
 * half of each; past that it closes them up, down to a strip just tall enough
 * for a number and a heading. A lane with more pages than even that leaves
 * room for shows a window of them (see `laneWindows`) rather than a stack of
 * slivers nobody could hit with a ray.
 */
function deckLaneStep(
  n: number,
  run: number,
  cardHeight: number,
): { step: number; capacity: number } {
  const min = Math.max(0.02, cardHeight * DECK_MIN_STEP_FRACTION);
  const max = cardHeight * DECK_MAX_STEP_FRACTION;
  const capacity = Math.max(1, 1 + Math.floor(run / min));
  const shown = Math.min(Math.max(1, n), capacity);
  const step = shown > 1 ? clamp(run / (shown - 1), min, max) : max;
  return { step, capacity };
}

/**
 * The whole table: where every lane, card and plate sits, for the reader's
 * current arrangement and whatever the pointer is doing.
 *
 * Pure, like the rest of this file — the drag preview is expressed as a
 * `drag` input (the card taken out of the flow, a gap opened where it would
 * land) rather than as mutation, so the same function draws the table at rest
 * and mid-drag, and the offline check can exercise both.
 */
export function computeDeckLayout(
  pageCount: number,
  panel: { width: number; height: number },
  opts: DeckOptions = {},
): DeckLayout {
  const lanes =
    opts.lanes && opts.lanes.length > 0
      ? opts.lanes
      : deckDefaultLanes(opts.sectionRanges, pageCount);
  const frame = deckFrame(panel, lanes.length);
  const { scale, laneWidth, stride } = deckMetrics(panel, lanes.length);
  const cardWidth = panel.width * scale;
  const cardHeight = panel.height * scale;
  const rows = deckRows(frame.depth);
  const wellDepth = rows.wellTop - rows.wellBottom;
  const run = Math.max(0, wellDepth - 2 * DECK_WELL_PAD - cardHeight);
  const focus = opts.focus ?? -1;
  const dragging = opts.drag?.pageIndex ?? null;
  const drop = opts.drag?.to ?? null;

  const left = -((lanes.length - 1) * stride) / 2 - laneWidth / 2;
  const laneCells: DeckLaneCell[] = [];
  const cards: DeckCardCell[] = [];

  for (let i = 0; i < lanes.length; i++) {
    const lane = lanes[i];
    // The dragged card is out of the flow wherever it came from, so the lane
    // it left closes up under it rather than holding its place.
    const held = lane.pages.filter((p) => p !== dragging);
    const gapAt =
      drop?.kind === "lane" && drop.lane === i
        ? clamp(drop.slot, 0, held.length)
        : -1;
    const occupancy = held.length + (gapAt >= 0 ? 1 : 0);
    const { step, capacity } = deckLaneStep(occupancy, run, cardHeight);

    const start = clamp(
      opts.laneWindows?.[lane.id] ?? 0,
      0,
      Math.max(0, held.length - 1),
    );
    const shown = Math.min(held.length - start, Math.max(1, capacity));
    const u = left + i * stride;
    laneCells.push({
      index: i,
      id: lane.id,
      label: lane.label,
      sectionIndex: lane.sectionIndex,
      total: lane.pages.length,
      shown: Math.max(0, shown),
      windowStart: start,
      u,
      width: laneWidth,
      wellV: rows.wellBottom,
      wellDepth,
      headerV: rows.headerV,
      headerHeight: DECK_HEADER_H,
      step,
      dropActive: gapAt >= 0,
      made: deckIsMadeLane(lane),
    });

    const top = rows.wellTop - DECK_WELL_PAD;
    const hoverIndex = held.findIndex(
      (p) => deckCardKey(p) === opts.hoverKey,
    );
    // How far the cards in front of a pointed-at one may slide before the
    // last of them runs off the near edge of its well.
    const slack = Math.max(
      0,
      run - Math.max(0, occupancy - 1) * step,
    );
    const part = hoverIndex >= 0 ? Math.min(DECK_HOVER_PART, slack) : 0;

    for (let k = 0; k < shown; k++) {
      const pageIndex = held[start + k];
      if (pageIndex === undefined) break;
      // A gap opened for the drop pushes everything at or after it down one
      // step, so the lane visibly makes room for the card being carried.
      const offsetSlots = gapAt >= 0 && start + k >= gapAt ? 1 : 0;
      const hovered = start + k === hoverIndex;
      const parted = part > 0 && start + k > hoverIndex ? part : 0;
      const reading = pageIndex === focus;
      const v = top - (k + offsetSlots) * step - parted;
      const next = k + 1 < shown ? top - (k + 1 + offsetSlots) * step -
        (part > 0 && start + k + 1 > hoverIndex ? part : 0) : null;
      const exposed = next === null ? cardHeight : Math.min(cardHeight, v - next);
      cards.push({
        key: deckCardKey(pageIndex),
        pageIndex,
        lane: i,
        slot: start + k,
        sectionIndex: lane.sectionIndex,
        u: u + DECK_WELL_PAD,
        v,
        proud:
          (k + offsetSlots) * DECK_PROUD_STEP +
          (hovered ? DECK_HOVER_PROUD : 0) +
          (reading && !hovered ? DECK_READING_PROUD : 0),
        width: cardWidth,
        height: cardHeight,
        scale,
        exposed,
        hovered,
        reading,
        // Covered cards recede; the whole card, and the one being read, come
        // forward. Never past 0.6: a card nobody can read is not triage.
        recession: reading ? 0 : hovered ? 0.05 : exposed >= cardHeight ? 0.18 : 0.34,
      });
    }
  }

  // While a card is in the air, both ends of the row offer it a section of
  // its own. Both are drawn, not just the one under the pointer: a drop
  // target nobody can see before they reach it is a drop target nobody finds.
  const newLaneZones: DeckNewLaneZone[] = [];
  if (opts.drag && lanes.length < DECK_MAX_TABLE_LANES) {
    for (const at of [0, lanes.length]) {
      newLaneZones.push({
        at,
        u: at === 0 ? left - stride : left + lanes.length * stride,
        width: laneWidth,
        wellV: rows.wellBottom,
        wellDepth: wellDepth,
        active: drop?.kind === "new" && drop.at === at,
      });
    }
  }

  return {
    frame,
    lanes: laneCells,
    cards,
    newLaneZones,
    stage: deckStage(focus >= 0 ? focus : 0),
    scale,
    cardWidth,
    cardHeight,
    rail: { v: 0, height: DECK_RAIL },
  };
}

/**
 * Where a pointer at table coordinates (u, v) would drop the card it is
 * carrying: the lane under it and the slot the card's own CENTRE falls in,
 * or — for a card carried off either end of the row — a section of its own.
 *
 * null is left for the two cases where there is genuinely nothing to do:
 * the card is off the table's depth altogether, or the table is already as
 * many columns wide as it can be.
 */
export function deckDropTarget(
  layout: DeckLayout,
  u: number,
  v: number,
): DeckDrop {
  const { lanes, cardHeight, frame } = layout;
  if (lanes.length === 0) return null;
  if (v < -0.12 || v > frame.depth + 0.12) return null;
  let lane = -1;
  for (let i = 0; i < lanes.length; i++) {
    const c = lanes[i];
    if (u >= c.u - DECK_LANE_GAP / 2 && u <= c.u + c.width + DECK_LANE_GAP / 2) {
      lane = i;
      break;
    }
  }
  if (lane < 0) {
    // Off the row: a section of its own, at whichever end the card is over.
    //
    // The end lanes used to claim a generous margin beyond themselves, so a
    // card carried toward the shelf did not have to be centred on it. That
    // margin cannot survive this: it covered the very ground the new-lane
    // zone is DRAWN on, so aiming at the zone dropped the card in the shelf
    // instead — caught by the offline check, and invisible in a headset.
    // Every lane now claims exactly its own well plus half a gap, the zones
    // sit one full lane pitch past the ends, and what is drawn is what
    // answers.
    if (lanes.length >= DECK_MAX_TABLE_LANES) return null;
    return { kind: "new", at: u < 0 ? 0 : lanes.length };
  }
  const c = lanes[lane];
  const rows = deckRows(frame.depth);
  const top = rows.wellTop - DECK_WELL_PAD;
  const slot = Math.round((top - cardHeight / 2 - v) / Math.max(0.001, c.step));
  return { kind: "lane", lane, slot: clamp(slot, 0, c.total) };
}

/** Two drops are the same target — so a drag only re-renders when it moves. */
export function deckSameDrop(a: DeckDrop, b: DeckDrop): boolean {
  if (a === null || b === null) return a === b;
  if (a.kind !== b.kind) return false;
  return a.kind === "lane" && b.kind === "lane"
    ? a.lane === b.lane && a.slot === b.slot
    : (a as { at: number }).at === (b as { at: number }).at;
}

/** Move a page to `slot` of lane `to`, taking it out of wherever it was. */
export function deckMoveCard(
  lanes: DeckLane[],
  pageIndex: number,
  to: number,
  slot: number,
): DeckLane[] {
  const next = lanes.map((l) => ({ ...l, pages: l.pages.slice() }));
  for (const l of next) {
    const at = l.pages.indexOf(pageIndex);
    if (at >= 0) l.pages.splice(at, 1);
  }
  const target = next[clamp(to, 0, next.length - 1)];
  target.pages.splice(clamp(slot, 0, target.pages.length), 0, pageIndex);
  return next;
}

/**
 * A page carried off the row becomes a section of its own, at `at`.
 *
 * The new lane takes the next hue in the walk (`sectionIndex` one past the
 * highest in use) so it is as distinct from its neighbours as two document
 * sections would be — the reader made a section, so it looks like one — and
 * an id derived from the ones already there, which keeps this deterministic
 * and lets the renderer key on it across the reflow.
 */
export function deckAddLane(
  lanes: DeckLane[],
  pageIndex: number,
  at: number,
): DeckLane[] {
  const stripped = lanes.map((l) => ({
    ...l,
    pages: l.pages.filter((p) => p !== pageIndex),
  }));
  let ordinal = 1;
  while (stripped.some((l) => l.id === `${DECK_NEW_LANE_PREFIX}${ordinal}`))
    ordinal++;
  const hue = stripped.reduce((m, l) => Math.max(m, l.sectionIndex ?? -1), -1);
  stripped.splice(clamp(at, 0, stripped.length), 0, {
    id: `${DECK_NEW_LANE_PREFIX}${ordinal}`,
    label: `New section ${ordinal}`,
    sectionIndex: hue + 1,
    pages: [pageIndex],
  });
  return stripped;
}

/**
 * Lanes the reader MADE disappear once they are emptied again — an empty
 * column that stands for nothing is just a hole in the table. A section's own
 * lane stays whatever happens to it: emptying one is a statement about the
 * document, and you have to be able to put pages back into it. The shelf
 * stays for the same reason.
 */
export function deckPruneLanes(lanes: DeckLane[]): DeckLane[] {
  return lanes.filter((l) => !deckIsMadeLane(l) || l.pages.length > 0);
}

/** Carry out a drop, whichever kind it turned out to be. */
export function deckApplyDrop(
  lanes: DeckLane[],
  pageIndex: number,
  drop: DeckDrop,
): DeckLane[] {
  if (!drop) return lanes;
  return deckPruneLanes(
    drop.kind === "lane"
      ? deckMoveCard(lanes, pageIndex, drop.lane, drop.slot)
      : deckAddLane(lanes, pageIndex, drop.at),
  );
}

/** Swap a lane with its neighbour — what the header's ‹ › chips do. */
export function deckMoveLane(lanes: DeckLane[], index: number, dir: -1 | 1): DeckLane[] {
  const to = index + dir;
  if (index < 0 || index >= lanes.length || to < 0 || to >= lanes.length)
    return lanes;
  const next = lanes.slice();
  const [moved] = next.splice(index, 1);
  next.splice(to, 0, moved);
  return next;
}

/** The reader's reading order: every lane's pages, lane by lane. */
export function deckReadingOrder(lanes: DeckLane[]): number[] {
  const out: number[] = [];
  for (const l of lanes) out.push(...l.pages);
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
/** What separates two pages when neither of them opens a corridor. */
const ROOM_PAGE_MIN_GAP = 0.5;
/** Half-width of the corridor between rooms. */
const CORRIDOR_HALF = 1.45;
/** Corridor in front of the first room — the building's entrance hall. */
const CORRIDOR_LOBBY = 3.4;
/** Where the first room's near wall stands. */
const ROOM_Z0 = -1.4;
/** Wall length beyond the outermost page on it. */
const ROOM_WALL_MARGIN = 0.7;
/**
 * How far a wall carries on above the top edge of the pages hung on it —
 * which, with the floor at world y = 0 and the pages' tops on the panel-anchor
 * line, is what sets the ceiling height.
 *
 * This used to be 0.55, putting the head at about 2 m — the ceiling of a
 * service corridor, and inside the reader's peripheral vision the whole time.
 * It was then tried at 1.15 (a 2.65 m head), which overshot: with the pages
 * hanging at the main panel's height and topping out at 1.5 m, a 2.65 m
 * ceiling leaves over a metre of blank wall above every exhibit and the room
 * reads as a hall the pages are lost in. This lands at about 2.35 m — over a
 * head of clear wall above the pages, and no more.
 */
const ROOM_WALL_HEADROOM = 0.95;

/**
 * WHERE THE ART HANGS: the height of a page's CENTRE above the floor.
 *
 * Galleries hang to a fixed centre line — the museum convention is 57 inches,
 * which is 1.45 m — because that is eye level, and a wall of work whose
 * centres agree reads as a hang rather than as things stuck on a wall.
 *
 * The pages used to hang at the main panel's own slot, whose centre is about
 * 0.95 m: half a metre low, waist height, which is what made every doorway
 * and every link door out-measure the exhibits and made a reader standing at
 * a normal height feel like they were looming over the work. Both of those
 * were reported as other problems (doors too tall, camera too high) and both
 * were this.
 *
 * Breaking the pages away from the panel slot is only possible because
 * nothing in this view still reads content off that slot: the preview camera
 * is on `roomsAxis`, the XR recentre is on the same point, the in-world
 * chrome is not mounted in rooms, and panel clipping is derived from each
 * page's own placed entry.
 */
export const ROOM_HANG_CENTRE = 1.45;
/**
 * …and where the reader's eye is. A shade above the hang line, which is how
 * a standing adult meets a picture hung to centre.
 */
export const ROOM_EYE_HEIGHT = 1.55;
/** Clear floor under the lowest edge of a page — art is not skirting board. */
const ROOM_HANG_FLOOR_CLEAR = 0.25;
/**
 * The dropped band round the ceiling perimeter, drawn by `RoomSlabs`. It
 * lives here rather than with the geometry that draws it because it HANGS IN
 * FRONT OF THE WALL: anything mounted high — a section sign above a doorway,
 * say — has to keep clear of it or it is quietly sliced off at the top, which
 * is exactly what happened to the signs.
 */
export const ROOM_SOFFIT_DROP = 0.09;
export const ROOM_SOFFIT_BAND = 0.26;
/**
 * Doorway opening, measured from the floor. Nearly as wide as the corridor on
 * purpose: a reader walking with the keys does not track the centre line to
 * the centimetre, and a narrow opening turns every doorway into a snag — the
 * jamb catches them and, since the push is straight into it, sliding cannot
 * help. Width here plus `roomWalkFunnel` is what keeps doors passable.
 */
const DOOR_WIDTH = 2.3;
const DOOR_HEIGHT = 2.0;
/** How wide the reader is, for walking into things. */
const WALK_RADIUS = 0.24;
/**
 * A door out of the building, filled by the link's own leaf.
 *
 * A DOOR, at human scale. It was briefly sized off the pages instead —
 * shrunk to about 1.7 m so it would stop towering over exhibits that hung
 * 0.45–1.50 m — but that was treating the symptom. The pages were the thing
 * in the wrong place, and now that they hang to a gallery centre line (see
 * ROOM_HANG_CENTRE) a page tops out around 1.95 m and a normal door beside
 * it reads as exactly that.
 *
 * The proportion (a bit over 2:1) is what makes the eye call it a door; the
 * original 1.35 × 1.75 was 0.77:1, which is a hatch.
 */
const LINK_DOOR_W = 0.92;
const LINK_DOOR_H = 2.05;

function linkDoorSize(): { width: number; height: number } {
  return { width: LINK_DOOR_W, height: LINK_DOOR_H };
}

/** Gap between one link door and the next down a stretch of corridor. */
function linkDoorPitch(): number {
  return LINK_DOOR_W + 1.15;
}
/** Pages, plates and plaques sit this far proud of the wall they hang on. */
const MOUNT_PROUD = 0.02;
/**
 * …but a section SIGN sits further out than that, because it hangs over a
 * doorway and a doorway has an architrave round it (`JAMB_PROUD` in
 * room-decor.tsx, 0.028). At the pages' 0.02 the frame's head band stood in
 * front of the sign and took the bottom off every letter.
 */
const SIGN_PROUD = 0.055;
/** Shortest stretch of links corridor between one room and the next. */
const LINK_STRETCH_MIN = 3.4;
/** Metres past the reading distance over which a page dims to full recession. */
const ROOM_DIM_RANGE = 7;
/**
 * A room must be deep enough to stand back in: the reader reads a page from
 * `viewingDistance`, so a room shallower than this would put them in the far
 * wall. In reading distances.
 */
const ROOM_MIN_SPAN_D = 2.5;
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
  /**
   * Centre z of each page row, and the bay after it.
   *
   * NOT a uniform pitch. A room used to space every page by a full bay whether
   * or not it had a corridor to open, which made a forty-page document a
   * building you could not walk the length of — "the rooms are getting longer
   * unnecessarily". A row only gets a bay when one of its two pages actually
   * has links; otherwise the next row follows at a hairline gap.
   *
   * `bayZ[r]` is where that row's corridor opening goes, or null when neither
   * of its pages has one. BOTH walls' openings sit at that same z, so a facing
   * pair of pages faces a facing pair of doorways rather than one near and one
   * far.
   */
  rowZ: number[];
  bayZ: (number | null)[];
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
  /**
   * A link door's leaf, and the gap between one and the next. Carried on the
   * plan rather than read from a constant because both now scale with the
   * page (see `linkDoorSize`), and the stretch of corridor a section's links
   * hang in is sized from the same numbers — a plan whose doors and whose
   * corridor length disagreed would put leaves through the end wall.
   */
  doorSize: { width: number; height: number };
  doorPitch: number;
  /** The floor, panel-anchor-relative — what the hang height is measured from. */
  floorY: number;
}

/**
 * The height a page's centre hangs at, panel-anchor-relative.
 *
 * `ROOM_HANG_CENTRE` is the gallery line and is what this returns in every
 * ordinary case. The clamps are for profiles whose panel is a very different
 * size from Quest's: a tall page hung to the same centre would push its own
 * gallery light up into the soffit, and a short one would sit needlessly low.
 */
function roomHangCentre(panel: { height: number }, floorY: number): number {
  const ceiling = ROOM_WALL_HEADROOM - floorY;
  // The highest a page's top edge can go and still leave its light clear of
  // the dropped soffit band.
  const topLimit = ceiling - ROOM_SOFFIT_DROP - PICTURE_LIGHT_RISE - 0.14;
  return Math.max(
    panel.height / 2 + ROOM_HANG_FLOOR_CLEAR,
    Math.min(ROOM_HANG_CENTRE, topLimit - panel.height / 2),
  );
}

/**
 * The picture rail — the line a gallery hangs from — which sits just above
 * the top edge of the pages and therefore has to move with them. Exported
 * because the shell draws it and only this file knows where the art is.
 */
export function roomRailY(
  panel: { height: number },
  floorY: number,
): number {
  return floorY + roomHangCentre(panel, floorY) + panel.height / 2 + 0.06;
}

/** One outbound link found in a section's pages. */
export interface SectionLink {
  label: string;
  href: string;
  /**
   * Which way this link goes (docs/directional-links.md). Optional so the
   * placement side stays usable without the link layer, but supplied in
   * practice — it decides which wall of the corridor the door is cut into,
   * and the glyph the door's sign carries.
   *
   * "right"/"left" are siblings and take the corresponding corridor wall.
   * "up" (a parent) and "down" (an external) have no wall of their own in a
   * single-storey building; see `linkDoorsOf` for where they go and what is
   * not built.
   */
  axis?: "up" | "down" | "left" | "right";
  /** The way back. Drawn first, nearest the reader, and never reassigned. */
  isReturn?: boolean;
}

/** Where the reader stands in the building, and which way they face. */
export interface ReaderPose {
  x: number;
  z: number;
  /** 0 looks down the corridor (−z); + turns left. */
  yaw: number;
  /**
   * How far ABOVE the reading floor the reader is standing, metres.
   *
   * Continuous, not an integer storey. A storey index cannot represent
   * "halfway up a flight", so with one the only way onto a landing was to be
   * put there — which is the teleport Anand rejected. This is sampled from
   * `walkSurfaceAt` every step, so walking onto a flight raises the reader
   * tread by tread and walking off it sets them down on the landing.
   *
   * The BUILDING moves by it, not the reader (see `roomPoseTransform`), which
   * keeps the reader at the origin where the XR recentre and the in-world
   * chrome expect them.
   */
  rise?: number;
}

/**
 * Room width: wide enough to stand back from either side wall — and then
 * some. The reading spots sit one viewing distance off each side wall, so
 * `2·vd` is the bare minimum where two readers would be back to back; the
 * slack on top is the aisle between them. At 1.1 m of slack the room was
 * exactly as wide as it had to be and no wider, which is the width of a
 * passage, not of a gallery.
 *
 * Not too much, though. A room wider than the corridor it opens off has to
 * make up the difference in its END walls, and those returns are what a
 * reader standing in the doorway is looking at — go to 2.6 and each return is
 * a metre and a half of blank plaster squarely across the view back down the
 * building. 1.9 keeps the aisle and keeps the returns to the width of a pier.
 */
function roomWidth(viewingDistance: number): number {
  return 2 * viewingDistance + 1.9;
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
  floorY: number,
  /** Whether page `i` has links, and so needs a bay to open a corridor into. */
  hasLinks: (page: number) => boolean = () => true,
): Museum {
  const spineX = panel.width / 2;
  const rooms: Room[] = [];
  const stretches: LinkStretch[] = [];
  const doorPitch = linkDoorPitch();
  let z = ROOM_Z0;
  for (let k = 0; k < ranges.length; k++) {
    const range = ranges[k];
    const n = range.end - range.start + 1;
    // Pages alternate right/left as they advance, so the room is as deep as
    // one side wall's worth of them.
    const rows = Math.max(1, Math.ceil(n / 2));

    // ── Lay the rows out, giving a BAY only where one is needed ──
    //
    // A row is one page on each wall. It takes the page's own width, and then
    // either a bay (when either of its pages has links, so a corridor opens
    // off it) or a hairline gap (when neither does). Spacing every row by a
    // full bay regardless is what made the building unwalkably long.
    const pw = panel.width * ROOM_PAGE_SCALE;
    const rowZ: number[] = [];
    const bayZ: (number | null)[] = [];
    let cursor = ROOM_WALL_MARGIN;
    for (let r = 0; r < rows; r++) {
      rowZ.push(cursor + pw / 2);
      cursor += pw;
      const pair = [range.start + 2 * r, range.start + 2 * r + 1].filter(
        (pg) => pg <= range.end,
      );
      if (pair.some(hasLinks)) {
        // The bay, and the opening at its centre — the SAME z for both walls,
        // so a facing pair of pages gets a facing pair of doorways.
        bayZ.push(cursor + BRANCH_PAGE_CLEAR + BRANCH_HALF);
        cursor += 2 * BRANCH_HALF + 2 * BRANCH_PAGE_CLEAR;
      } else {
        bayZ.push(null);
        cursor += ROOM_PAGE_MIN_GAP;
      }
    }
    const depth = Math.max(
      viewingDistance * ROOM_MIN_SPAN_D,
      cursor + ROOM_WALL_MARGIN,
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
      // Measured from zNear, which decreases into the room.
      rowZ: rowZ.map((d) => zNear - d),
      bayZ: bayZ.map((d) => (d === null ? null : zNear - d)),
    });
    // The stretch joining this room to the next. A fixed length now: the links
    // used to hang here and sized it, and they have moved to the branch beside
    // the page they belong to, so this is circulation and wants to be short.
    void linkCounts;
    void doorPitch;
    const stretch = LINK_STRETCH_MIN;
    stretches.push({ sectionIndex: k, zNear: zFar, zFar: zFar - stretch });
    z = zFar - stretch;
  }
  return {
    spineX,
    rooms,
    stretches,
    zStart: ROOM_Z0 + CORRIDOR_LOBBY,
    zEnd: z,
    doorSize: linkDoorSize(),
    doorPitch,
    floorY,
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
  const side: 1 | -1 = slot % 2 === 0 ? 1 : -1; // first page on the right
  const row = Math.floor(slot / 2);
  const zc = (room.zNear + room.zFar) / 2;
  return {
    centre: {
      x: m.spineX + side * (room.width / 2 - MOUNT_PROUD),
      // Hung to the gallery centre line, NOT to the main panel's slot. See
      // ROOM_HANG_CENTRE for why that changed and what had to be true first.
      y: m.floorY + roomHangCentre(panel, m.floorY),
      z: room.rowZ[row] ?? zc,
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

// ── The links branches ──────────────────────────────────────
//
// A corridor of doors and stairs opening off the wall BESIDE EACH PAGE
// (Anand, 2026-08-16: "next to the page not section" … "next to the page not
// in the page" … "I want the corridors present irrespective whether the user
// is standing on the page, they should be pre-rendered before not after
// standing").
//
// So: EVERY page with links has one, built with the building rather than
// summoned when the reader arrives. That is a departure from the spec, which
// says only the page the reader is on has a live corridor — and it is the
// right one for a view you WALK. A reader coming down a gallery needs to see
// which pages lead somewhere before choosing which to stand at; a corridor
// that only exists once you are already there cannot be part of that choice.
// (The wall still opens one at a time; its reader is not walking past
// anything.)
//
// Building them all also removes the hard part. The old single branch had to
// hunt for a gap in a wall that was already full of pages, and the hunt
// failed on a shallow room and put the opening through the page. Now every
// page owns the BAY immediately after it, the room is built with those bays
// in it, and the position is arithmetic rather than a search.

/** Half-width of the branch corridor. It has to fit the bay between two pages. */
const BRANCH_HALF = 1.05;
/**
 * Clear wall between a page's edge and the near jamb of its corridor.
 *
 * Read by `ROOM_PAGE_GAP`, which is `2 × BRANCH_HALF + 2 × BRANCH_PAGE_CLEAR`
 * — the bay is sized to hold a corridor with this much wall either side of it,
 * which is what makes "beside the page, never through it" arithmetic instead
 * of a search that can fail.
 */
export const BRANCH_PAGE_CLEAR = 0.45;
/** Shortest branch, so a page with one link still gets a corridor. */
const BRANCH_MIN = 3.2;
/** Clear run past the last door before the end wall. */
const BRANCH_END_RUN = 1.6;
/** Head height of the way in from the room. A doorway, not a missing wall. */
const BRANCH_DOORWAY_H = 2.35;
/**
 * Clear WALL between one door and the next down a branch.
 *
 * A pier, not a gap — and it is the thing that makes the corridor a corridor.
 * Tuned as a fraction of the spine's pitch it came out at 0.37 m, at which
 * point the run reads as a colonnade of openings with slivers between them and
 * the reader sees straight through to the void: "no boundary".
 */
const BRANCH_PIER = 0.95;
/**
 * The two long walls are STAGGERED by half a pitch.
 *
 * Facing each door with another door put every opening opposite an opening, so
 * the two walls cancelled and a reader looking down the branch saw through both
 * sides at once. Offsetting one wall faces every door with a pier.
 */
const BRANCH_STAGGER = 0.5;

/**
 * How far the corridor stands off the room wall — and, because the arms run
 * ALONG that wall, the width of the arms themselves.
 *
 * The crossing is the square immediately outside a page's doorway, and it is
 * where the whole legend is read in one look: step through, and the building
 * offers three ways at once — left and right along the arms to the siblings,
 * straight on into the stair hall for the storeys above and below. Anand,
 * 2026-08-18: "the stairs are at the starting at corridor next to each other
 * and left and right are doors to the siblings pages there by having similar
 * direction to which links are pointing".
 *
 * The corridor that ran straight out from the wall could not say that. Its
 * siblings hung down its two long walls in the order they happened to come
 * in, so a "left" link was as likely to be on the reader's right as their
 * left, and the flights were at the far end — four metres and a walk away
 * from the choice they belong to.
 */
const BRANCH_CROSS = 2 * BRANCH_HALF;
/** Where an arm's first door stands, measured out from the crossing's edge. */
const ARM_DOOR_START = 0.95;
/** Clear run past an arm's last door before its end wall. */
const ARM_END_RUN = 0.7;
/** Shortest arm, so a hand with one door is still a stretch of corridor. */
const ARM_MIN = 2.4;
/** Clear floor between the crossing and the first riser. */
const STAIR_LIP = 0.2;

/**
 * Floor-to-floor height of the building, metres.
 *
 * A storey is the wall height plus a slab, so the floor above starts where the
 * ceiling below ends and a flight between them is a real climb rather than a
 * step up onto a shelf.
 */
export const ROOM_STOREY_H = (ROOM_WALL_HEADROOM + 2.2) * 1.0 + 0.45;

/**
 * The flight at the end of a branch corridor.
 *
 * `STAIR_STEPS` risers of `ROOM_STOREY_H / STAIR_STEPS` on a `STAIR_GOING`
 * tread, so the run on the floor is `STAIR_RUN`. Both the plan (which has to
 * lengthen a corridor to hold its flights) and the geometry read these, and
 * they disagreed silently while the numbers were written out twice.
 *
 * The up and the down flight sit SIDE BY SIDE across the corridor, not one
 * beyond the other, so a corridor reserves ONE run at its end however many
 * directions it serves — Anand, 2026-08-18: "the top and bottom stairs should
 * be next to each other rather one in front and other in back". End to end
 * they also read wrongly: the reader met the descending flight first and the
 * ascending one four metres past it, when what the legend claims is that up
 * and down are the same choice made at the same place.
 */
const STAIR_STEPS = 14;
const STAIR_GOING = 0.29;
const STAIR_RUN = STAIR_STEPS * STAIR_GOING;
/** Floor kept solid at the end a flight ARRIVES at — a stride, not a lip. */
const STAIR_ARRIVE = 0.4;
/** Balustrade round the opening a flight leaves in the floor it climbs through. */
const STAIR_RAIL_H = 1.0;

/**
 * How high the floor is under the reader, metres above the reading floor.
 *
 * Flat almost everywhere. Across a flight's footprint it ramps, which is what
 * makes the stair something you climb rather than something you are put on top
 * of: the walk samples this every step and the reader rises with the treads.
 *
 * A flight is walked along its own axis, so the ramp is parameterised on the
 * distance from its foot in that direction, clamped at both ends — before the
 * foot you are on the corridor floor, past the head you are on the landing.
 *
 * ── Why it needs to know where the reader already is ──
 *
 * Three storeys share one footprint, so most of a branch has three floors over
 * each other and (x, z) alone cannot say which one is underfoot. The first
 * version answered "whichever is furthest from the reading floor", which is
 * only ever right by accident: it dropped a reader off the up flight onto the
 * landing BELOW the moment the two overlapped in plan, and it made the whole
 * corridor at ±1 unreachable from the flight that leads to it.
 *
 * The surface is a function of the reader's CURRENT height as well as their
 * position: of the floors over this spot, take the one nearest to where they
 * are standing. Steps are small and the ramps continuous, so this follows a
 * climb tread by tread, hands the reader to the landing at the top, and holds
 * them on that landing while they walk its full length — and stepping back
 * onto the flight is the only way down, which is what a stairwell is. Ties go
 * to the flight, so the head of a stair yields to the stair and not to the
 * landing it meets.
 */
export function walkSurfaceAt(
  stairs: RoomStair[],
  x: number,
  z: number,
  floorY: number,
  fromRise = 0,
): number {
  // Every floor over this spot, and whether it insists.
  let rise = 0;
  let best = Infinity;
  let onFlight = false;
  const take = (h: number, insists = false) => {
    const d = Math.abs(h - fromRise);
    if (d < best || (insists && d <= best)) {
      rise = h;
      best = d;
    }
  };
  for (const s of stairs) {
    // The flight first: along its own axis, and across it.
    const ax = Math.sin(s.yaw);
    const az = Math.cos(s.yaw);
    const dx = x - s.foot.x;
    const dz = z - s.foot.z;
    const along = dx * ax + dz * az;
    const across = Math.abs(-dx * az + dz * ax);
    const run = s.steps * s.going;
    if (across <= s.width / 2 + 0.15 && along >= -0.2 && along <= run + 0.2) {
      // Over a flight you are on the TREADS. The reading floor beneath them
      // is not a surface here and neither is the flight's own landing: a
      // flight is the hole in the floor it leads to, and offering the landing
      // as well meant it won everywhere but the exact head, so a reader on the
      // storey above walked over their own stairwell with no way back down.
      onFlight = true;
      take(
        s.dir * ROOM_STOREY_H * Math.min(1, Math.max(0, along / Math.max(0.01, run))),
        true,
      );
      continue;
    }
    // Otherwise the LANDING: the whole corridor at the top or bottom of a
    // flight is floor, not merely the strip the flight is wide. This includes
    // the ground over the OTHER direction's flight — a stairwell going down is
    // a floor when you are standing a storey above it.
    if (x >= s.landing.x0 && x <= s.landing.x1 && z >= s.landing.z0 && z <= s.landing.z1)
      take(s.dir * ROOM_STOREY_H);
  }
  // …and the reading floor, underfoot everywhere a flight is not.
  if (!onFlight) take(0);
  return floorY + rise;
}

/** One flight, from the branch's floor to the landing above or below it. */
export interface RoomStair {
  page: number;
  /** +1 climbs to the parents' landing, −1 descends to the externals'. */
  dir: 1 | -1;
  /** Foot of the flight, on the branch floor. */
  foot: { x: number; y: number; z: number };
  /** Head of it, on the landing — where the reader arrives. */
  head: { x: number; y: number; z: number };
  /** Bearing of the climb, so the treads face the way you walk up them. */
  yaw: number;
  /**
   * Height of the flight's overhead sign, panel-anchor-relative.
   *
   * Derived here rather than in the renderer because only the plan knows how
   * much room there is: a corridor's clear height is the wall headroom plus
   * the floor's own drop, which moves with the page size, so a sign hung at a
   * height written into the view sat inside the ceiling of a short document
   * and halfway down the wall of a tall one. Just over the head of a link
   * door, and never within a hand's breadth of the ceiling.
   */
  signY: number;
  width: number;
  steps: number;
  /** Depth of one tread. `steps × going` is the flight's run on the floor. */
  going: number;
  /**
   * The corridor this flight arrives on, in plan.
   *
   * The whole of it is floor at `head.y`. Without this the walking surface was
   * only raised across the flight's own WIDTH, so a reader who stepped
   * sideways on the landing — which is what walking to a door on either wall
   * is — dropped back to the reading floor, and with it out of the storey
   * whose walls were holding them. That is why the doors up there could not be
   * reached.
   */
  landing: { x0: number; x1: number; z0: number; z1: number };
}

export interface LinkBranch {
  /** Which page's corridor this is. */
  page: number;
  /** The room wall it opens through, and which side of the spine that is. */
  wallX: number;
  side: 1 | -1;
  /** Centre of the opening down the wall — the middle of the page's own bay. */
  zCentre: number;
  halfWidth: number;
  /**
   * The corridor's outer face, `BRANCH_CROSS` out from the room wall. The
   * sibling doors hang on it, and the stair hall opens through it at the
   * crossing.
   */
  crossX: number;
  /**
   * Built out, or a vestibule? Only the reader's own page gets its arms, its
   * hall and its flights — see `PagePlacementOptions.activePage`.
   */
  full: boolean;
  /**
   * Standing INSIDE the built-out corridor, and so drawing nothing of its
   * own: the arm running past supplies the floor, the ceiling and the outer
   * wall already. Its doorway stays cut in the gallery wall, so what the
   * reader sees from inside the room never changes.
   */
  hidden: boolean;
  /** The corridor's extent along the wall: the crossing plus its arms. */
  zLo: number;
  zHi: number;
  /**
   * Reach of each arm from `zCentre`, 0 for a hand with no doors. Right and
   * left are the READER'S, as they step out through the doorway and face away
   * from the room — so right is +z off a right-hand wall and −z off a
   * left-hand one, and a "right" link is a door on their right in both.
   */
  arm: { right: number; left: number };
  /** Far face of the stair hall on the reading floor… */
  hallEndX: number;
  /**
   * …and on the landings above and below, which run further out because the
   * parents' and externals' doors hang there. Two lengths rather than one:
   * built to the longer, the floor the reader actually walks would end in
   * five metres of blank dead-end corridor past the flights.
   */
  landingEndX: number;
  /** Siblings, split by the hand they are on. */
  right: SectionLink[];
  left: SectionLink[];
  /** Parents — the landing ABOVE, up the flight straight ahead. */
  up: SectionLink[];
  /** Externals — the landing BELOW. */
  down: SectionLink[];
}

/**
 * Where the first door of a run stands, measured out from the room wall.
 *
 * A doorway cannot start ON the corner it turns, so the run is held off the
 * wall by a pier's worth. `linkDoorsOf` hangs from here and `branchLength`
 * measures from here; they were the same number written twice, and the copy in
 * the length was missing, so every run of doors ended half a metre further out
 * than the corridor had been built for — which put the last door of a storey
 * inside the stairwell at the end of it, behind the balustrade, with no floor
 * in front of it to stand on. Anand, 2026-08-18: "can't reach this door".
 */
const BRANCH_DOOR_START = 0.95;

/** How far out a branch must run to hold `perWall` doors on its longer wall. */
function branchLength(doorWidth: number, perWall: number): number {
  const pitch = doorWidth + BRANCH_PIER;
  return Math.max(
    BRANCH_MIN,
    BRANCH_DOOR_START +
      (Math.max(1, perWall) - 1 + BRANCH_STAGGER) * pitch +
      doorWidth / 2 +
      BRANCH_END_RUN,
  );
}

/** Reach of one arm from the corridor's centre line — 0 when it has no doors. */
function armReach(n: number, doorWidth: number): number {
  if (n <= 0) return 0;
  const pitch = doorWidth + BRANCH_PIER;
  return (
    BRANCH_HALF +
    Math.max(
      ARM_MIN,
      ARM_DOOR_START + (n - 1) * pitch + doorWidth / 2 + ARM_END_RUN,
    )
  );
}

/**
 * The stair hall, out from the crossing's face — on the reading floor, and on
 * a landing. See `LinkBranch.landingEndX` for why they differ.
 */
function hallLengths(
  doorWidth: number,
  up: number,
  down: number,
): { floor: number; landing: number } {
  if (up === 0 && down === 0) return { floor: 0, landing: 0 };
  const perWall = Math.max(Math.ceil(up / 2), Math.ceil(down / 2));
  return {
    // Far enough to stand at the head of a flight and turn round.
    floor: STAIR_LIP + STAIR_RUN + STAIR_ARRIVE + 0.5,
    // The doors start PAST the head of the flight: the near half of a landing
    // is the stairwell, and a door over a stairwell has no floor in front of
    // it to stand on (Anand, 2026-08-18: "can't reach this door").
    landing: STAIR_LIP + STAIR_RUN + branchLength(doorWidth, perWall),
  };
}

/**
 * One corridor per page that has links: a crossing outside the page's own
 * doorway, an arm to each hand carrying that hand's siblings, and the stair
 * hall straight ahead.
 *
 * The opening sits in the BAY AFTER the page — half a slot along the wall in
 * the direction the pages advance — so it is beside its own page and clear of
 * the next. `ROOM_PAGE_GAP` is sized for exactly this, and the room's depth
 * carries one extra bay so the last page on a wall has one too.
 *
 * Only `activePage`'s corridor is built out. The arms run along the room wall,
 * which every page on that wall shares, so two built-out corridors would want
 * the same ground — Anand, 2026-08-18: "I know the other page corridors will
 * overlap". What every page still has, always, is its doorway and the lit
 * crossing behind it.
 */
function branchesOf(
  m: Museum,
  pageLinks: SectionLink[][] | undefined,
  activePage?: number,
): LinkBranch[] {
  if (!pageLinks) return [];
  const out: LinkBranch[] = [];
  for (const room of m.rooms) {
    for (let page = room.range.start; page <= room.range.end; page++) {
      const links = pageLinks[page];
      if (!links || links.length === 0) continue;
      const slot = page - room.range.start;
      const side: 1 | -1 = slot % 2 === 0 ? 1 : -1;
      const row = Math.floor(slot / 2);
      // The bay this row was given. A page with links always has one — the
      // room was laid out knowing it — so a missing bay means the plan and the
      // link list disagree, and drawing a corridor into a wall that was never
      // widened for it is worse than drawing none.
      const bay = room.bayZ[row];
      if (bay === null || bay === undefined) continue;
      // ── The legend, laid out as a crossroads ──
      //
      // Siblings are lateral and stay on this floor, one hand each. Parents
      // are UP and externals are DOWN, and in a building that means a flight
      // of stairs and a landing at the top and bottom of it (Anand's floor
      // plan, 2026-08-16: 0f / 1f / 2f, the dark and light blocks being the
      // two flights). Both flights start at the same place, side by side, so
      // up and down are one choice made once — and they start where the
      // reader arrives rather than at the far end of a walk.
      const right = links.filter((l) => l.axis === "right");
      const left = links.filter((l) => l.axis === "left");
      const up = links.filter((l) => l.axis === "up");
      const down = links.filter((l) => l.axis === "down");
      const full = page === activePage;
      const arm = {
        right: full ? armReach(right.length, m.doorSize.width) : 0,
        left: full ? armReach(left.length, m.doorSize.width) : 0,
      };
      const hall = full
        ? hallLengths(m.doorSize.width, up.length, down.length)
        : { floor: 0, landing: 0 };
      const wallX = m.spineX + side * (room.width / 2);
      const crossX = wallX + side * BRANCH_CROSS;
      // Which way each hand runs. Facing out of the room, the reader's right
      // is +z off the right-hand wall and −z off the left-hand one.
      const rEnd = bay + side * (arm.right || BRANCH_HALF);
      const lEnd = bay - side * (arm.left || BRANCH_HALF);
      out.push({
        page,
        wallX,
        side,
        // The bay belongs to the ROW, not to one page, so the openings for a
        // facing pair land at the same z — Anand, 2026-08-16: "I want the
        // corridor opening of page 2 at same position as the page 3".
        zCentre: bay,
        halfWidth: BRANCH_HALF,
        crossX,
        full,
        hidden: false,
        zLo: Math.min(rEnd, lEnd),
        zHi: Math.max(rEnd, lEnd),
        arm,
        hallEndX: crossX + side * hall.floor,
        landingEndX: crossX + side * hall.landing,
        right,
        left,
        up,
        down,
      });
    }
  }

  // ── An arm swallows the vestibules it runs past ──
  //
  // It runs along the wall those doorways are cut into, so it arrives at them
  // from outside: the neighbour's crossing becomes a stretch of this corridor
  // with a way back into the gallery in its inner wall. What must not happen
  // is an arm stopping HALFWAY across one, which would leave half a vestibule
  // drawn inside the corridor — so the ends snap out to take in any crossing
  // they reach at all, and then a vestibule is either wholly inside the
  // corridor (and draws nothing) or wholly outside it (and draws itself).
  const active = out.find((b) => b.full);
  if (active) {
    const near = out.filter(
      (b) => b !== active && Math.abs(b.wallX - active.wallX) < 0.01,
    );
    // Snapping to take in one crossing can bring the end within reach of the
    // next, so repeat until it settles.
    for (let pass = 0; pass < near.length + 1; pass++) {
      let grew = false;
      for (const b of near) {
        const lo = b.zCentre - b.halfWidth;
        const hi = b.zCentre + b.halfWidth;
        if (hi <= active.zLo + 0.01 || lo >= active.zHi - 0.01) continue;
        if (lo < active.zLo) {
          active.zLo = lo;
          grew = true;
        }
        if (hi > active.zHi) {
          active.zHi = hi;
          grew = true;
        }
      }
      if (!grew) break;
    }
    for (const b of near)
      b.hidden =
        b.zCentre - b.halfWidth >= active.zLo - 0.01 &&
        b.zCentre + b.halfWidth <= active.zHi + 0.01;
  }
  return out;
}

/**
 * The branches, for callers that need to reason about the corridors rather
 * than draw them — the walk (to know where a corridor runs) and the offline
 * checks (to assert it does not cross its own page).
 */
export function computeLinkBranches(
  mode: PageDistribution,
  pageCount: number,
  panel: { width: number; height: number },
  opts: PagePlacementOptions = {},
): LinkBranch[] {
  if (mode !== "rooms" || pageCount < MIN_PAGES_FOR_PAGE_VIEWS) return [];
  return branchesOf(planFor(pageCount, panel, opts), opts.pageLinks, opts.activePage);
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
    opts.floorY ?? -panel.height * 2,
    // A page only earns a bay when it has a corridor to open into it.
    (page) => (opts.pageLinks?.[page]?.length ?? 0) > 0,
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
 *
 * `slack` overrides that for callers who need the opposite answer: pass 0 and
 * a reader who has crossed the wall line — standing in a doorway, or out in
 * the corridor — reads as OUT. That is the question "have they committed to
 * leaving?", and it is not the same question as "which room's pages should be
 * mounted?" (see the corridor election in `page-ghosts.tsx`).
 */
export function roomAtPose(
  mode: PageDistribution,
  pageCount: number,
  panel: { width: number; height: number },
  pose: ReaderPose,
  opts: PagePlacementOptions = {},
  slack: number = ROOM_ENTERED_SLACK,
): number | null {
  if (mode !== "rooms" || pageCount < MIN_PAGES_FOR_PAGE_VIEWS) return null;
  const m = planFor(pageCount, panel, opts);
  const s = slack;
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
 * Close enough to a page to be AT it — which is what opens its corridor.
 *
 * Standing on the mark (`SPOT_REACH`, 0.55 m) is a much smaller thing than
 * being at the page, and the corridor used to be gated on the mark: it arrived
 * only once the reader had both feet on the disc. Anand, 2026-08-18: *"the
 * corridors for the room activates when I am at the pointer, it should
 * activate when I am the vicinity"*. This is most of a bay — the bays are
 * `ROOM_PAGE_GAP` apart along the wall — so walking up to a page opens its
 * corridor beside it, while the page one bay along keeps its own.
 */
export const VICINITY_REACH = 2.6;
/**
 * How much nearer a page must be than the one whose corridor is already open
 * before it takes it over. A reader standing between two bays would otherwise
 * swap the whole corridor — floor, walls, doors and flights — back and forth
 * on every reported step.
 */
export const VICINITY_MARGIN = 0.5;

/**
 * Which page's corridor should be BUILT OUT, for a reader at `pose`.
 *
 * Two rules, and the second is the one that matters:
 *
 *  1. **Vicinity, not the mark.** The nearest page within `VICINITY_REACH`,
 *     among the pages of the room the reader is in — a spot the same distance
 *     off through a wall is not somewhere they are about to be.
 *  2. **A corridor you entered is the corridor you leave by.** The moment the
 *     reader crosses the gallery wall line — standing in the threshold counts,
 *     which is why the room test is taken with NO slack — the election stops
 *     and `held` is returned unchanged. Anand, 2026-08-18: *"the corridor
 *     should have same entrance and exit"*. An arm runs along the room wall
 *     and past the neighbouring bays, so a few strides down one the nearest
 *     spot belongs to a neighbour; re-electing there would rebuild the floor,
 *     the walls and the very doorway the reader came in by while they stood on
 *     them, and the way back out would be somewhere else.
 *
 * Returns `held` when nothing is in reach, too: a reader crossing the middle
 * of a long room is not asking for the building to close up behind them.
 */
export function corridorPageAt(
  mode: PageDistribution,
  pageCount: number,
  panel: { width: number; height: number },
  pose: ReaderPose,
  held: number,
  opts: PagePlacementOptions = {},
): number {
  if (mode !== "rooms" || pageCount < MIN_PAGES_FOR_PAGE_VIEWS) return held;
  // Past the wall line: committed to a corridor, so nothing may move.
  const room = roomAtPose(mode, pageCount, panel, pose, opts, 0);
  if (room === null) return held;
  const range = resolveRanges(opts.sectionRanges, pageCount)[room];
  if (!range) return held;
  let best = held;
  let bestD = VICINITY_REACH;
  let heldD = Infinity;
  for (const s of computeReadingSpots(mode, pageCount, panel, opts)) {
    if (s.pageIndex < range.start || s.pageIndex > range.end) continue;
    const d = Math.hypot(pose.x - s.centre.x, pose.z - s.centre.z);
    if (s.pageIndex === held) heldD = d;
    if (d < bestD) {
      bestD = d;
      best = s.pageIndex;
    }
  }
  if (best === held) return held;
  return bestD <= heldD - VICINITY_MARGIN ? best : held;
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
 *
 * THE STEP IS SWEPT, not sampled at its far end. A wall here is a line
 * segment with no thickness, so testing only where the step LANDS lets a long
 * enough step cross one without ever being inside it — and the steps do get
 * long. `dt` is clamped at 0.1 s and `WALK_SPEED` is 2.4, so a frame the
 * renderer takes its time over produces a 0.24 m step, which is exactly
 * `WALK_RADIUS`: land 0.24 m past a wall and the endpoint test says "clear".
 * A heavy page makes that the normal case rather than the rare one, which is
 * how a building whose whole point is that doorways are the only way through
 * became one a reader could walk out of in any direction.
 */
export function roomWalkStep(
  from: { x: number; z: number },
  dx: number,
  dz: number,
  walls: RoomWall[],
  floorY: number,
  radius = WALK_RADIUS,
): { x: number; z: number } {
  // A wall is solid to this reader when it SPANS their floor.
  //
  // The base test alone was enough while the building had one storey. It is
  // not now: a wall on the landing BELOW has its base under the reading floor
  // and passed, so the reader was stopped on the reading floor by a wall one
  // storey down — collision is worked in plan, and in plan the two are the
  // same line. Requiring the wall to reach ABOVE the floor as well drops both
  // the storey below and the storey above.
  const solid = walls.filter(
    (w) =>
      w.centre.y - w.size.height / 2 <= floorY + 0.05 &&
      w.centre.y + w.size.height / 2 > floorY + 0.05,
  );
  const clear = (x: number, z: number) => {
    for (const w of solid) if (wallDistance(w, x, z) < radius) return false;
    return true;
  };

  // Standing inside a wall already — which a reader who tunnelled through one
  // before this was fixed can still be, and which nothing below can recover
  // from, since every candidate step is blocked and the reader is frozen for
  // good. Push them out along the face they are nearest to, on the side they
  // are already on, rather than leaving them stuck.
  if (!clear(from.x, from.z)) {
    let worst = 0;
    let deepest: RoomWall | null = null;
    for (const w of solid) {
      const d = radius - wallDistance(w, from.x, from.z);
      if (d > worst) {
        worst = d;
        deepest = w;
      }
    }
    if (deepest) {
      const nx = Math.sin(deepest.yaw);
      const nz = Math.cos(deepest.yaw);
      const side =
        (from.x - deepest.centre.x) * nx + (from.z - deepest.centre.z) * nz >= 0
          ? 1
          : -1;
      const px = from.x + side * nx * (worst + 0.02);
      const pz = from.z + side * nz * (worst + 0.02);
      if (clear(px, pz)) return { x: px, z: pz };
    }
    return { x: from.x, z: from.z };
  }

  /**
   * Walk from `from` along (ax, az) in sub-steps no longer than half the
   * reader's radius, stopping at the last point that was clear. Returns how
   * far it got, so the caller can prefer the candidate that moved furthest
   * instead of only ever taking one that completed.
   */
  const sweep = (ax: number, az: number) => {
    const len = Math.hypot(ax, az);
    if (len < 1e-9) return { x: from.x, z: from.z, moved: 0, full: true };
    const n = Math.max(1, Math.ceil(len / (radius * 0.5)));
    let x = from.x;
    let z = from.z;
    for (let i = 1; i <= n; i++) {
      const cx = from.x + (ax * i) / n;
      const cz = from.z + (az * i) / n;
      if (!clear(cx, cz))
        return { x, z, moved: Math.hypot(x - from.x, z - from.z), full: false };
      x = cx;
      z = cz;
    }
    return { x, z, moved: len, full: true };
  };

  const direct = sweep(dx, dz);
  if (direct.full) return { x: direct.x, z: direct.z };

  // Blocked head-on. If the push is toward a doorway the reader has not lined
  // up with, steer them at it: walking a corridor with the keys does not aim
  // to the centimetre, and a door you cannot get through is worse than no
  // door at all. The nudge is along the opening, never through the wall.
  const aim = roomWalkFunnel(from, dx, dz, walls, floorY);
  let best = direct;
  if (aim) {
    const step = Math.hypot(dx, dz);
    // Renormalised to the step the reader actually asked for. Added raw, the
    // nudge made the steered step up to twice as long as an unsteered one —
    // so the one move most likely to be aimed at a wall was also the one most
    // able to cross it.
    const rx = dx + aim.x * step;
    const rz = dz + aim.z * step;
    const rl = Math.hypot(rx, rz) || 1;
    const steered = sweep((rx / rl) * step, (rz / rl) * step);
    if (steered.full) return { x: steered.x, z: steered.z };
    if (steered.moved > best.moved) best = steered;
  }
  // Otherwise slide along whichever axis gets furthest.
  for (const c of [sweep(dx, 0), sweep(0, dz)])
    if (c.moved > best.moved) best = c;
  return { x: best.x, z: best.z };
}

/**
 * WHERE A TELEPORT LANDS — the headset's equivalent of a walk.
 *
 * In VR the reader has no keyboard, so `useRoomWalking` reaches them not at
 * all: they look at a piece of floor and double-tap, and that is the whole of
 * their locomotion (see scene/xr-locomotion.tsx). This answers the two
 * questions that gesture asks — may I stand THERE, and may I get there from
 * HERE — with the same geometry walking already uses, so the building means
 * the same thing on foot and in a headset.
 *
 * The path test is a STRAIGHT sweep, deliberately unlike `roomWalkStep`,
 * which slides along whatever it hits. Sliding is right for a key held down
 * and wrong for a marker on the floor: a landing spot that quietly slid two
 * metres sideways from the one the reader was looking at is a teleport that
 * lied. Blocked means blocked — and because the sweep stops at the last clear
 * point, the reticle can stand there and say so.
 *
 * It also means doorways still matter. The only line from the corridor into a
 * room that does not cross a wall is the one through its opening, so a reader
 * can teleport into a room they can see into and not through its back wall —
 * the same rule their feet obey.
 *
 * @returns the point actually reachable along the way to `to`, and whether a
 *   wall cut the journey short.
 */
export function roomTeleportPath(
  from: { x: number; z: number },
  to: { x: number; z: number },
  walls: RoomWall[],
  floorY: number,
  radius = WALK_RADIUS,
): { x: number; z: number; blocked: boolean } {
  const solid = walls.filter(
    (w) => w.centre.y - w.size.height / 2 <= floorY + 0.05,
  );
  const clear = (x: number, z: number) => {
    for (const w of solid) if (wallDistance(w, x, z) < radius) return false;
    return true;
  };
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  const len = Math.hypot(dx, dz);
  if (len < 1e-6) return { x: from.x, z: from.z, blocked: false };
  // Same sub-step as the walk: half the reader's radius, so nothing thinner
  // than they are can be stepped over.
  const n = Math.max(1, Math.ceil(len / (radius * 0.5)));
  let x = from.x;
  let z = from.z;
  for (let i = 1; i <= n; i++) {
    const cx = from.x + (dx * i) / n;
    const cz = from.z + (dz * i) / n;
    if (!clear(cx, cz)) return { x, z, blocked: true };
    x = cx;
    z = cz;
  }
  return { x, z, blocked: false };
}

/**
 * Whether (x, z) is over a floor the building actually laid — i.e. inside the
 * corridor or one of the rooms.
 *
 * The floor is mathematically a plane at y = 0 and stretches to the horizon;
 * the BUILDING's floor is the union of the up-facing slabs. Without this a
 * gaze aimed past the end of the enfilade lands the reader in the void
 * outside, where there is nothing to read and no wall to walk back through.
 */
export function roomFloorContains(
  slabs: RoomSlab[],
  x: number,
  z: number,
  margin = 0,
): boolean {
  for (const s of slabs) {
    if (s.facing !== "up") continue;
    if (
      Math.abs(x - s.centre.x) <= s.size.width / 2 + margin &&
      Math.abs(z - s.centre.z) <= Math.abs(s.size.depth) / 2 + margin
    )
      return true;
  }
  return false;
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
  // A link door's opening has a leaf in it, so it is not a way through and
  // steering anybody at it is steering them into a solid object. Worse, it is
  // the one opening a reader is regularly walking straight at (that is how
  // you follow the link), so the nudge fired constantly and pushed them
  // sideways along the corridor wall while they leaned on the door.
  const leaves = walls.filter((w) => w.portal);
  let best: { x: number; z: number } | null = null;
  let bestScore = Infinity;
  for (const w of walls) {
    if (w.centre.y - w.size.height / 2 <= floorY + 0.05) continue; // not a lintel
    if (
      leaves.some(
        (p) =>
          Math.abs(p.centre.x - w.centre.x) < 0.02 &&
          Math.abs(p.centre.z - w.centre.z) < 0.02,
      )
    )
      continue;
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
  portal?: {
    href: string;
    label: string;
    sectionIndex: number;
    /** Which way the door goes — see SectionLink.axis. */
    axis?: "up" | "down" | "left" | "right";
    /** The reserved way back, drawn as such. */
    isReturn?: boolean;
  };
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
  doors: { at: number; width: number; height?: number }[],
  floorY: number,
  topY: number,
): RoomWall[] {
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  const len = Math.hypot(dx, dz);
  if (len < 0.01) return [];
  const ux = dx / len;
  const uz = dz / len;
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
    // Each opening carries its own height: a room doorway is a full-height
    // way through, a link door is a leaf a shade over two metres tall, and
    // cutting both to the same height left a strip of void above every leaf.
    const doorTopY = Math.min(floorY + (d.height ?? DOOR_HEIGHT), topY - 0.1);
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
  const out: RoomWall[] = [];
  const run = (
    from: { x: number; z: number },
    to: { x: number; z: number },
    yaw: number,
    doors: { at: number; width: number; height?: number }[] = [],
    hangs = false,
  ) =>
    out.push(
      // Floor to FLOOR here too, for the same reason the branch storeys do it
      // (see `storey`): a reader on a landing looks down the well and along
      // the storey below, over the tops of its walls, and everything above a
      // wall that stopped at the ceiling was a band of black at the end of
      // every corridor. The ceiling slab hides the extra height from anyone
      // standing in the space itself.
      ...wallRun(from, to, yaw, doors, floorY, floorY + ROOM_STOREY_H).map((w) =>
        hangs && !w.lintel ? { ...w, hangs: true } : w,
      ),
    );

  // Every page's branch. The openings have to be cut into the room's side
  // walls as those walls are built, which is why they are resolved before the
  // rooms loop rather than added after it.
  const branches = branchesOf(m, opts.pageLinks, opts.activePage);
  const stairs = computeRoomStairs(mode, pageCount, panel, opts);
  const doors = linkDoorsOf(m, opts, floorY);

  for (const room of m.rooms) {
    const left = m.spineX - room.width / 2;
    const right = m.spineX + room.width / 2;
    const door = [{ at: room.width / 2, width: DOOR_WIDTH }];
    // End walls, each with its doorway on the spine: the one you come in by
    // and, at the far end, the one you leave by.
    run({ x: left, z: room.zNear }, { x: right, z: room.zNear }, Math.PI, door);
    run({ x: left, z: room.zFar }, { x: right, z: room.zFar }, 0, door);

    // The side walls the pages hang on — with an opening for every branch that
    // leaves through them. `wallRun` measures a doorway from the run's start,
    // and a side wall runs zNear → zFar (decreasing z), so the openings have to
    // be sorted along that direction or the run walks backwards over itself.
    const sideOpenings = (wallX: number) =>
      branches
        .filter(
          (b) =>
            Math.abs(b.wallX - wallX) < 0.01 &&
            b.zCentre <= room.zNear &&
            b.zCentre >= room.zFar,
        )
        .map((b) => ({
          at: room.zNear - b.zCentre,
          // A DOORWAY, not a missing wall.
          //
          // With no height `wallRun` cuts the opening floor-to-ceiling, so the
          // way into a corridor was a full-height gap the width of the corridor
          // itself — an entrance frame bigger than the space behind it, which
          // reads as a hole in the room rather than a way through. A doorway is
          // door-height and a little narrower than the corridor, which leaves
          // reveals either side and lets the corridor read as the wider thing.
          width: b.halfWidth * 2 - 0.5,
          height: BRANCH_DOORWAY_H,
        }))
        .sort((a, b) => a.at - b.at);
    run(
      { x: left, z: room.zNear },
      { x: left, z: room.zFar },
      Math.PI / 2,
      sideOpenings(left),
      true,
    );
    run(
      { x: right, z: room.zNear },
      { x: right, z: room.zFar },
      -Math.PI / 2,
      sideOpenings(right),
      true,
    );
  }

  // ── The corridors, and the landings above and below their halls ──
  //
  // Each is a crossing outside a page's doorway, an arm to each hand running
  // ALONG the room wall, and the stair hall straight ahead — with the hall
  // repeated one storey up for the parents and one down for the externals.
  //
  // Openings are measured from each run's start and must be SORTED along it.
  // Unsorted, a run walks backwards over itself and emits overlapping and
  // negative-width pieces — invisible with one door, and most of the wall with
  // a dozen. `wallRun` sorts them; the measurements below still have to be
  // taken from the same end the run starts at.
  for (const branch of branches) {
    const zC = branch.zCentre;
    const hw = branch.halfWidth;
    const top0 = floorY + ROOM_STOREY_H;
    const mine = doors.filter((d) => d.sectionIndex === branch.page);

    // ── A vestibule: the crossing on its own, closed on three sides ──
    //
    // What every page that is not the reader's own still has, so the gallery
    // shows which pages lead somewhere before the reader picks one to stand
    // at. `hidden` ones are inside the built-out corridor, which supplies all
    // of this and more.
    if (!branch.full) {
      if (branch.hidden) continue;
      out.push(
        ...wallRun(
          { x: branch.crossX, z: zC + hw },
          { x: branch.crossX, z: zC - hw },
          (-branch.side * Math.PI) / 2,
          [],
          floorY,
          top0,
        ),
      );
      for (const z of [zC + hw, zC - hw])
        out.push(
          ...wallRun(
            { x: branch.wallX, z },
            { x: branch.crossX, z },
            z > zC ? Math.PI : 0,
            [],
            floorY,
            top0,
          ),
        );
      continue;
    }

    // ── The outer wall: the whole length of the corridor, in one run ──
    //
    // It carries every sibling door and, at the crossing, the way into the
    // stair hall. One run rather than one per arm, so the piers between the
    // doors and the reveals either side of the hall's opening are cut from the
    // same wall and cannot drift apart.
    const outerDoors = mine
      .filter((d) => Math.abs(d.centre.x - branch.crossX) < 0.01)
      .map((d) => ({
        at: Math.abs(d.centre.z - branch.zLo),
        width: d.size.width,
        height: d.size.height,
      }));
    // The way into the hall is the FULL width of the crossing, under a lintel
    // — an arch, not a door. The two flights sit side by side across that
    // width with a hair to spare, so a doorway narrower than the hall (which
    // is what the way in from the gallery is, and rightly) would put a jamb
    // over a quarter of each of them: the reader would step onto a stair whose
    // outer edge was behind a pier.
    if (Math.abs(branch.hallEndX - branch.crossX) > 0.01)
      outerDoors.push({
        at: Math.abs(zC - branch.zLo),
        width: hw * 2,
        height: BRANCH_DOORWAY_H,
      });
    out.push(
      ...wallRun(
        { x: branch.crossX, z: branch.zLo },
        { x: branch.crossX, z: branch.zHi },
        (-branch.side * Math.PI) / 2,
        outerDoors,
        floorY,
        top0,
      ),
    );

    // The two ends of it. An arm that was never built ends AT the crossing,
    // which is exactly where its end wall belongs.
    for (const zEnd of [branch.zLo, branch.zHi])
      out.push(
        ...wallRun(
          { x: branch.wallX, z: zEnd },
          { x: branch.crossX, z: zEnd },
          zEnd > zC ? Math.PI : 0,
          [],
          floorY,
          top0,
        ),
      );

    // ── The inner wall, wherever the gallery's own is not there to serve ──
    //
    // An arm runs along the room wall and takes it as its inner face: the
    // reader walks behind the pages they have been reading, and the doorways
    // of the neighbouring pages open into the corridor along the way. Past the
    // end of a room, though, the building narrows to the spine corridor and
    // there is no wall on that line at all — so an arm that overruns a room
    // has to bring its own, or it opens onto the void.
    let spans = [{ a: branch.zLo, b: branch.zHi }];
    for (const room of m.rooms) {
      const next: typeof spans = [];
      for (const sp of spans) {
        if (room.zFar >= sp.b || room.zNear <= sp.a) {
          next.push(sp);
          continue;
        }
        if (room.zFar > sp.a) next.push({ a: sp.a, b: room.zFar });
        if (room.zNear < sp.b) next.push({ a: room.zNear, b: sp.b });
      }
      spans = next;
    }
    for (const sp of spans)
      if (sp.b - sp.a > 0.01)
        out.push(
          ...wallRun(
            { x: branch.wallX, z: sp.a },
            { x: branch.wallX, z: sp.b },
            (branch.side * Math.PI) / 2,
            [],
            floorY,
            top0,
          ),
        );

    // ── The stair hall, straight ahead: one storey per direction ──
    //
    // The same footprint three times over — the hall itself, the parents'
    // landing above it and the externals' below — joined by the flights at
    // its mouth. Walls run floor to FLOOR, not floor to ceiling: a reader on a
    // landing looks down the well and along the storey below over the tops of
    // its walls, and anything that stopped at a ceiling was a band of black.
    const hall = (level: -1 | 0 | 1) => {
      const fy = floorY + level * ROOM_STOREY_H;
      const ty = fy + ROOM_STOREY_H;
      const endX = level === 0 ? branch.hallEndX : branch.landingEndX;
      if (Math.abs(endX - branch.crossX) < 0.01) return;
      const at = mine.filter(
        (d) => Math.abs(d.centre.y - (fy + d.size.height / 2)) < 0.01,
      );
      for (const z of [zC + hw, zC - hw])
        out.push(
          ...wallRun(
            { x: branch.crossX, z },
            { x: endX, z },
            // These run along X, so their yaw is 0 or π — the far wall faces
            // −z into the hall, the near one +z. Declared as running along Z
            // they were turned a quarter each, and a single-sided plane seen
            // edge-on is nothing at all.
            z > zC ? Math.PI : 0,
            at
              .filter((d) => Math.abs(d.centre.z - z) < 0.01)
              .map((d) => ({
                at: Math.abs(d.centre.x - branch.crossX),
                width: d.size.width,
                height: d.size.height,
              })),
            fy,
            ty,
          ),
        );
      // The end wall closes the run…
      out.push(
        ...wallRun(
          { x: endX, z: zC + hw },
          { x: endX, z: zC - hw },
          (-branch.side * Math.PI) / 2,
          [],
          fy,
          ty,
        ),
      );
      // …and a landing needs one where the crossing would be, too. Up here
      // the corridor below does not exist, and a landing left open at that
      // end is a reader stepping off it into their own stairwell.
      if (level !== 0)
        out.push(
          ...wallRun(
            { x: branch.crossX, z: zC + hw },
            { x: branch.crossX, z: zC - hw },
            (branch.side * Math.PI) / 2,
            [],
            fy,
            ty,
          ),
        );
    };

    hall(0);
    if (branch.up.length > 0) hall(1);
    if (branch.down.length > 0) hall(-1);

    // ── The balustrade round the stairwell ──
    //
    // A flight leaves an opening in the floor it passes through, and an
    // opening with nothing round it is a hole. Standing on the floor above,
    // the well was a rectangle of the storey below let into the floor — Anand,
    // 2026-08-18: "there is a gap". And from halfway up a flight the reader's
    // head came through that opening at floor level with nothing beside it, so
    // they looked straight out ACROSS the landing they were climbing to and
    // down the well at the same time: "i can see the other side from the
    // stairs part". A stairwell in a building is enclosed — that enclosure is
    // what makes a flight a shaft you climb through rather than a plank over a
    // gap.
    //
    // Being walls, they are also solid to `roomWalkStep`, so a reader on the
    // landing can no longer step sideways off it into the well.
    for (const st of stairs) {
      if (st.page !== branch.page) continue;
      const ax = Math.sin(st.yaw);
      const climb = st.steps * st.going;
      const up = st.dir === 1;
      // The opening, in the floor the flight passes through: the shaft of
      // `computeRoomSlabs`, which these have to agree with piece for piece.
      const a0 = up ? -0.25 : STAIR_ARRIVE;
      const a1 = up ? climb - STAIR_ARRIVE : climb + 0.25;
      const across = st.width + 0.04;
      const yOpen = floorY + (up ? ROOM_STOREY_H : 0);
      const xA = st.foot.x + ax * a0;
      const xB = st.foot.x + ax * a1;
      // Which side of the hall the flight is on, and so which of its long
      // sides faces the walkway.
      const inward = st.foot.z > zC ? -1 : 1;
      const zRail = st.foot.z + inward * (across / 2);
      // ── The long side is a WALL, not a rail ──
      //
      // It runs from the floor the flight starts on all the way up to a
      // balustrade's height above the floor it arrives at: a stair channel
      // below, a parapet above, one surface. A rail that stood only on the
      // upper floor left the flight climbing through open corridor beneath it
      // — halfway up, the reader was in the air above the storey below with
      // its whole length beside them and the landing above over the rail, both
      // at once ("it is mid cliimb").
      const yFoot = floorY + (up ? 0 : -ROOM_STOREY_H);
      out.push(
        ...wallRun(
          { x: xA, z: zRail },
          { x: xB, z: zRail },
          inward === 1 ? 0 : Math.PI,
          [],
          yFoot,
          yOpen + STAIR_RAIL_H,
        ),
      );
      // …and across the end the reader neither steps on to nor off at: the
      // foot end of a climb (its head is the way off), the head end of a
      // descent (its foot is the way on).
      const xEnd = up ? xA : xB;
      out.push(
        ...wallRun(
          { x: xEnd, z: st.foot.z - across / 2 },
          { x: xEnd, z: st.foot.z + across / 2 },
          branch.side === 1 ? -Math.PI / 2 : Math.PI / 2,
          [],
          yOpen,
          yOpen + STAIR_RAIL_H,
        ),
      );
    }
  }

  // The spine: the lobby in front of the first room, then the stretch joining
  // each room to the next. Plain walls now — the links moved off the spine and
  // into the branch beside the page they belong to, so what is left here is
  // circulation and nothing else.
  const spans: { zNear: number; zFar: number }[] = [
    { zNear: m.zStart, zFar: ROOM_Z0 },
    ...m.stretches.map((s) => ({ zNear: s.zNear, zFar: s.zFar })),
  ];
  for (const s of spans) {
    for (const side of [-1, 1] as const) {
      const x = m.spineX + side * CORRIDOR_HALF;
      run({ x, z: s.zNear }, { x, z: s.zFar }, (-side * Math.PI) / 2);
    }
  }
  // THE TWO ENDS OF THE BUILDING. Every space is walled along its sides and
  // separated from the next by an end wall with a doorway in it — but the
  // enfilade as a whole had nothing closing it off, so it was a tube open at
  // both ends: a reader who walked backwards out of the lobby, or forwards
  // past the last stretch of corridor, left the building entirely and stood
  // in the void looking at the outside of it. Backwards out of the lobby is
  // the one that bites, because the lobby is where every reader starts.
  const ends = {
    left: m.spineX - CORRIDOR_HALF,
    right: m.spineX + CORRIDOR_HALF,
  };
  run({ x: ends.left, z: m.zStart }, { x: ends.right, z: m.zStart }, Math.PI);
  run({ x: ends.left, z: m.zEnd }, { x: ends.right, z: m.zEnd }, 0);

  // Each link door's leaf: a solid piece of wall filling its opening that
  // happens to be a way out of the building.
  for (const d of doors) {
    out.push({
      centre: { ...d.centre },
      yaw: d.yaw,
      // The leaf is cut slightly PROUD of its opening. Sized exactly to the
      // hole it fills, a plane leaves a hairline at every jamb and head, and a
      // hairline onto nothing reads as a black wedge — which at a grazing
      // angle down a corridor of a dozen doors is most of what the reader
      // sees. The overlap is hidden by the architrave either way.
      size: { width: d.size.width + 0.06, height: d.size.height + 0.04 },
      portal: {
        href: d.href,
        label: d.label,
        sectionIndex: d.sectionIndex,
        axis: d.axis,
        isReturn: d.isReturn,
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

  // The branches run ACROSS the spine rather than along it, so each needs its
  // own pair rather than another `space()` — without them the reader walks out
  // of the room and off the edge of the world.
  //
  // Each is extended half a metre back THROUGH the room wall so its floor and
  // the room's overlap at the threshold. Butted exactly to the wall they left
  // a hairline of nothing at the join, which reads as a black seam across the
  // doorway — and at a grazing angle as a hole.
  //
  // One pair per STOREY: the branch itself, and the landings above and below
  // it that the flights at its far end lead to.
  // ── The shafts a flight passes through ──
  //
  // A flight climbs from one storey to the next, so it crosses the ceiling of
  // the one it leaves and the floor of the one it reaches. Without a hole in
  // both it climbs into a slab: the reader walks up and hits the underside of
  // the landing, which is why the floor above "did not exist" — it did, it was
  // capping the stairwell.
  //
  // `RoomSlab` is a single quad with no hole of its own, so an opening is made
  // by emitting the pieces AROUND it.
  const shafts = computeRoomStairs(mode, pageCount, panel, opts).map((st) => {
    const ax = Math.sin(st.yaw);
    const az = Math.cos(st.yaw);
    const run = st.steps * st.going;
    const up = st.dir === 1;
    // ── Where the hole starts and stops along the flight ──
    //
    // Open at the end the reader LEAVES, so there is head-room stepping on,
    // and closed a tread short of the end they ARRIVE at, so they arrive on
    // floor rather than stepping off the top step into the shaft.
    //
    // Which end is which turns on the direction. Climbing, the flight leaves
    // at its foot and lands on the slab at its head; descending, it leaves
    // through the floor at its foot and lands at the bottom — so the bounds
    // mirror, and a single pair of them (written for the up case) had the
    // down flight cutting the floor it arrives on and leaving the floor it
    // departs through solid.
    //
    // The arrival margin is a real stride, and the shaft is padded ACROSS the
    // flight but never ALONG it: a padding of 0.15 m at both ends of a margin
    // of 0.17 m left three centimetres of floor to arrive on, so the reader
    // stood at the head of the flight with the opening under their heels.
    const a0 = up ? -0.25 : STAIR_ARRIVE;
    const a1 = up ? run - STAIR_ARRIVE : run + 0.25;
    const cAlong = (a0 + a1) / 2;
    const lenAlong = a1 - a0;
    // Across, the opening is the flight and a hair more. It was the flight
    // plus 0.3 m, which left a 15 cm slot of open floor down each side of a
    // descending flight — a gap in the corridor floor beside the stair, doing
    // nothing but showing the storey below through it.
    const across = st.width + 0.04;
    return {
      x: st.foot.x + ax * cAlong,
      z: st.foot.z + az * cAlong,
      w: Math.abs(ax) * lenAlong + Math.abs(az) * across,
      d: Math.abs(az) * lenAlong + Math.abs(ax) * across,
      // ── Which slabs it cuts ──
      //
      // Only the ones it passes THROUGH, never the one it arrives on. An up
      // flight cuts everything above its foot up to and including the floor it
      // comes through; a down flight cuts the floor it drops through and the
      // ceiling below, and stops short of the floor it lands on.
      //
      // The down bounds were the up ones with the signs swapped, which is not
      // the same thing: they cut the landing's own floor and left both the
      // slab the flight drops through and the ceiling below it solid — so an
      // external's landing was a hole and the descent hit a lid.
      lo: up ? st.foot.y + 0.05 : st.head.y + 0.05,
      hi: up ? st.head.y + 0.05 : st.foot.y + 0.05,
    };
  });

  /** A slab, minus any shaft that passes through it. Up to four pieces. */
  const slab = (
    centre: { x: number; y: number; z: number },
    size: { width: number; depth: number },
    facing: "up" | "down",
  ) => {
    const hole = shafts.find(
      (h) =>
        centre.y > h.lo &&
        centre.y < h.hi &&
        Math.abs(h.x - centre.x) < size.width / 2 + h.w / 2 &&
        Math.abs(h.z - centre.z) < Math.abs(size.depth) / 2 + h.d / 2,
    );
    if (!hole) {
      out.push({ centre, size, facing });
      return;
    }
    const x0 = centre.x - size.width / 2;
    const x1 = centre.x + size.width / 2;
    const z0 = centre.z - Math.abs(size.depth) / 2;
    const z1 = centre.z + Math.abs(size.depth) / 2;
    const hx0 = Math.max(x0, hole.x - hole.w / 2);
    const hx1 = Math.min(x1, hole.x + hole.w / 2);
    const hz0 = Math.max(z0, hole.z - hole.d / 2);
    const hz1 = Math.min(z1, hole.z + hole.d / 2);
    const piece = (a: number, b: number, c: number, d: number) => {
      if (b - a < 0.01 || d - c < 0.01) return;
      out.push({
        centre: { x: (a + b) / 2, y: centre.y, z: (c + d) / 2 },
        size: { width: b - a, depth: d - c },
        facing,
      });
    };
    piece(x0, hx0, z0, z1); // before the shaft
    piece(hx1, x1, z0, z1); // after it
    piece(hx0, hx1, z0, hz0); // beside it, near
    piece(hx0, hx1, hz1, z1); // beside it, far
  };

  for (const branch of branchesOf(m, opts.pageLinks, opts.activePage)) {
    // Inside the built-out corridor: its arm lays this floor already.
    if (branch.hidden) continue;
    // The slab runs UNDER the walls, not up to them.
    //
    // A floor whose edge lands exactly on the wall's centre line leaves a
    // sliver of nothing at every pier base, and a sliver onto nothing is a
    // black wedge — which down a corridor of a dozen piers is most of what the
    // reader sees at a grazing angle. The ceiling has the same seam above
    // every door head. A third of a metre of overrun buries both.
    const under = 0.34;
    // …and half a metre back THROUGH the room wall, so the corridor's floor
    // and the room's overlap at the threshold. Butted exactly they leave a
    // hairline of nothing at the join, which reads as a black seam across the
    // doorway, and at a grazing angle as a hole.
    const overlap = 0.5;
    const hw = branch.halfWidth;

    // ── The reading floor: the crossing and its arms, in one pair ──
    //
    // Pushed straight rather than through `slab()`: no flight crosses this
    // ground (they are all past the crossing, in the hall), and the shaft
    // bounds overrun a quarter of a metre back past the foot for headroom —
    // enough for the hole test to bite on the corridor's own outer overrun and
    // cut a slot out of the ceiling right over the hall's doorway.
    const armSize = {
      width: BRANCH_CROSS + overlap + under,
      depth: branch.zHi - branch.zLo + under,
    };
    const armCentre = {
      x:
        branch.wallX +
        branch.side * (BRANCH_CROSS / 2) -
        (branch.side * overlap) / 2,
      y: floorY,
      z: (branch.zLo + branch.zHi) / 2,
    };
    out.push({ centre: armCentre, size: armSize, facing: "up" });
    out.push({
      centre: { ...armCentre, y: topY },
      size: armSize,
      facing: "down",
    });

    // ── The stair hall, one pair per storey ──
    //
    // These DO go through `slab()`: a flight climbs from one storey to the
    // next, so it crosses the ceiling of the one it leaves and the floor of
    // the one it reaches, and without a hole in both it climbs into a slab.
    const hall = (level: number) => {
      const endX = level === 0 ? branch.hallEndX : branch.landingEndX;
      const len = Math.abs(endX - branch.crossX);
      if (len < 0.01) return;
      const size = { width: len + overlap + under, depth: hw * 2 + under };
      const x = (branch.crossX + endX) / 2 - (branch.side * overlap) / 2;
      const dy = level * ROOM_STOREY_H;
      slab({ x, y: floorY + dy, z: branch.zCentre }, size, "up");
      slab({ x, y: topY + dy, z: branch.zCentre }, size, "down");
    };
    hall(0);
    if (branch.up.length > 0) hall(1);
    if (branch.down.length > 0) hall(-1);
  }
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
const CEILING_LIGHT_W = 0.62;
const CEILING_LIGHT_D = 0.62;
/**
 * Longest gap between luminaires down a corridor. A point light falls off
 * with the square of the distance, so the pitch is what decides how dark the
 * middle of each bay gets — and a corridor that alternates lit and unlit
 * every two and a half metres is the lighting of a horror film, not of a
 * gallery. Tighter than the ceiling is high, so the pools overlap.
 */
const CORRIDOR_LIGHT_PITCH = 1.9;
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
  /** A run of luminaires down a space, evenly spaced along its length. */
  const run = (
    zNear: number,
    zFar: number,
    space: "room" | "corridor",
    pitch: number,
    x = m.spineX,
  ) => {
    const depth = zNear - zFar;
    const n = Math.max(1, Math.round(depth / pitch));
    for (let i = 0; i < n; i++) {
      const z = zNear - (depth * (i + 0.5)) / n;
      out.push({
        kind: "ceiling",
        centre: { x, y: lampY, z },
        size: { width: CEILING_LIGHT_W, depth: CEILING_LIGHT_D },
        yaw: 0,
        target: { x, y: floorY, z },
        space,
      });
    }
  };

  run(m.zStart, ROOM_Z0, "corridor", CORRIDOR_LIGHT_PITCH);
  for (const s of m.stretches)
    run(s.zNear, s.zFar, "corridor", CORRIDOR_LIGHT_PITCH);
  for (const room of m.rooms) {
    // A room's own luminaires follow its page rows, so the light down the
    // middle keeps step with the exhibits either side of it — but never
    // sparser than a corridor's, or a deep room with few pages goes dark
    // between its own lamps.
    const pitch = Math.min(
      CORRIDOR_LIGHT_PITCH,
      (room.zNear - room.zFar) / room.rows,
    );
    // Two files, not one: a room this wide lit only down its spine leaves the
    // aisle either side of the centre line noticeably dimmer than the middle,
    // and an unevenly lit floor is the single strongest "abandoned building"
    // cue there is. The files sit a third of the way in from each wall, which
    // is roughly over where a reader walks.
    const inset = room.width / 6;
    run(room.zNear, room.zFar, "room", pitch, m.spineX - inset);
    run(room.zNear, room.zFar, "room", pitch, m.spineX + inset);
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

  // ── The link corridors ──
  //
  // A doorway onto an unlit space is a dead end, not a way on: from inside a
  // lit gallery the crossing behind every door read as a black rectangle. So
  // the corridors carry luminaires too — down the arms at the corridor pitch,
  // and down the stair hall on each of its storeys.
  for (const branch of branchesOf(m, opts.pageLinks, opts.activePage)) {
    if (branch.hidden) continue;
    const lamp = (x: number, z: number, dy: number) =>
      out.push({
        kind: "ceiling",
        centre: { x, y: lampY + dy, z },
        size: { width: CEILING_LIGHT_W, depth: CEILING_LIGHT_D },
        yaw: 0,
        target: { x, y: floorY + dy, z },
        space: "corridor",
      });
    const armLen = branch.zHi - branch.zLo;
    const armN = Math.max(1, Math.round(armLen / CORRIDOR_LIGHT_PITCH));
    const armX = branch.wallX + (branch.side * BRANCH_CROSS) / 2;
    for (let i = 0; i < armN; i++)
      lamp(armX, branch.zLo + (armLen * (i + 0.5)) / armN, 0);
    for (const level of [0, 1, -1] as const) {
      if (level === 1 && branch.up.length === 0) continue;
      if (level === -1 && branch.down.length === 0) continue;
      // A landing's lamps hang over the stretch BEYOND the reading floor's own
      // hall — which is the stretch its doors are on. Run over the whole
      // landing and every one of them would stack directly above a hall lamp:
      // `RoomLights` picks the handful nearest the reader in PLAN, knowing
      // nothing about which storey they are standing on, so three lamps on one
      // spot would take three of the six slots and light one storey between
      // them.
      const from = level === 0 ? branch.crossX : branch.hallEndX;
      const to = level === 0 ? branch.hallEndX : branch.landingEndX;
      const len = Math.abs(to - from);
      if (len < 0.01) continue;
      const n = Math.max(1, Math.round(len / CORRIDOR_LIGHT_PITCH));
      for (let i = 0; i < n; i++)
        lamp(
          from + (branch.side * len * (i + 0.5)) / n,
          branch.zCentre,
          level * ROOM_STOREY_H,
        );
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
  const pitch = m.doorSize.width + BRANCH_PIER;

  for (const branch of branchesOf(m, opts.pageLinks, opts.activePage)) {
    if (!branch.full) continue;
    const { side, zCentre, halfWidth, crossX } = branch;

    /**
     * ── Siblings: one hand each, down the corridor's outer wall ──
     *
     * A "right" link is a door on the reader's right and a "left" one a door
     * on their left, taken as they step out of the room and face away from
     * it. That is the whole reason the corridor was turned to run along the
     * wall: hung down the two long walls of a corridor running AWAY from the
     * room, the two lists were simply the first half and the second half of
     * whatever order the links came in, and the direction the mark on the
     * anchor promised was true only by accident.
     *
     * One wall, not two: the corridor's inner face is the gallery wall the
     * page itself hangs on, and a door cut through it would open behind a
     * picture.
     */
    const hangArm = (list: SectionLink[], hand: 1 | -1) => {
      list.forEach((link, i) => {
        out.push({
          ...link,
          sectionIndex: branch.page,
          centre: {
            x: crossX,
            y: floorY + m.doorSize.height / 2,
            z: zCentre + hand * side * (halfWidth + ARM_DOOR_START + i * pitch),
          },
          // Faces back across the corridor, into it.
          yaw: (-side * Math.PI) / 2,
          size: { ...m.doorSize },
        });
      });
    };
    hangArm(branch.right, 1);
    hangArm(branch.left, -1);

    /**
     * ── Parents and externals: the landing at the head or foot of a flight ──
     *
     * Down the two side walls of the stair hall, the far wall staggered half a
     * pitch so every door faces a PIER rather than another door — two walls of
     * paired openings cancel and the reader sees straight through both sides
     * into the void.
     *
     * They start past the head of the flight, which is what `landingEndX` is
     * measured for: the near half of a landing is the stairwell.
     */
    const hangLanding = (list: SectionLink[], level: 1 | -1) => {
      const y = floorY + level * ROOM_STOREY_H + m.doorSize.height / 2;
      const half = Math.ceil(list.length / 2);
      list.forEach((link, i) => {
        const onFar = i < half;
        const row = onFar ? i : i - half;
        const stagger = onFar ? 0 : BRANCH_STAGGER;
        out.push({
          ...link,
          sectionIndex: branch.page,
          centre: {
            x:
              crossX +
              side *
                (STAIR_LIP +
                  STAIR_RUN +
                  BRANCH_DOOR_START +
                  (row + stagger) * pitch),
            y,
            z: zCentre + (onFar ? 1 : -1) * halfWidth,
          },
          // A wall's yaw is which way it FACES: the far wall looks back at −z,
          // the near one at +z.
          yaw: onFar ? Math.PI : 0,
          size: { ...m.doorSize },
        });
      });
    };
    hangLanding(branch.up, 1);
    hangLanding(branch.down, -1);
  }
  return out;
}

/**
 * The flights joining a corridor to its landings.
 *
 * At the CROSSING, straight ahead as the reader steps out of the room, and
 * side by side across the stair hall: up on one half of its width, down on
 * the other, both climbing away from the room. Anand, 2026-08-18: "the stairs
 * are at the starting at corridor next to each other".
 *
 * They used to stand at the far end of a corridor that ran away from the
 * room, which cost the thing the crossing is for: up, down, left and right
 * are one choice with four answers, and a reader who has to walk four metres
 * to find two of them is not choosing between four. Half the corridor's width
 * each, even when only one direction has links, because the other half is the
 * landing past the shaft — a flight the full width makes a stairwell the full
 * width, and the reader who climbs it stands at the head with the opening
 * between them and every door on that storey ("when I go up I can't reach the
 * end").
 */
export function computeRoomStairs(
  mode: PageDistribution,
  pageCount: number,
  panel: { width: number; height: number },
  opts: PagePlacementOptions = {},
): RoomStair[] {
  if (mode !== "rooms" || pageCount < MIN_PAGES_FOR_PAGE_VIEWS) return [];
  const m = planFor(pageCount, panel, opts);
  const floorY = opts.floorY ?? -panel.height * 2;
  const out: RoomStair[] = [];
  for (const branch of branchesOf(m, opts.pageLinks, opts.activePage)) {
    if (!branch.full) continue;
    // `STAIR_LIP` is clear floor between the crossing and the first riser —
    // room to arrive at the foot of a flight before starting to climb it.
    const start = branch.crossX + branch.side * STAIR_LIP;
    const headX = start + branch.side * STAIR_RUN;
    for (const dir of [1, -1] as const) {
      const list = dir === 1 ? branch.up : branch.down;
      if (list.length === 0) continue;
      const width = branch.halfWidth * 0.9;
      // Up on the reader's right half of the hall, down on their left — the
      // reader's hand, not the world's +z, for the same reason the siblings
      // are: on the far wall of the building an absolute convention puts the
      // up flight on the opposite hand from the one it was on in the last
      // corridor, and a legend that swaps sides halfway down a gallery is not
      // a legend.
      const zOff = dir * branch.side * branch.halfWidth * 0.5;
      out.push({
        page: branch.page,
        dir,
        foot: { x: start, y: floorY, z: branch.zCentre + zOff },
        head: {
          x: headX,
          y: floorY + dir * ROOM_STOREY_H,
          z: branch.zCentre + zOff,
        },
        // The bearing the flight is CLIMBED in, which is out along the hall.
        yaw: branch.side === 1 ? Math.PI / 2 : -Math.PI / 2,
        signY: Math.min(floorY + LINK_DOOR_H + 0.18, ROOM_WALL_HEADROOM - 0.16),
        width,
        steps: STAIR_STEPS,
        going: STAIR_GOING,
        // ── The landing is the WHOLE hall at that level ──
        //
        // Not the patch beyond the head, which is what it was: the doors of a
        // direction hang the length of their storey, so a reader who arrived
        // at the top could stand on the last metre and a half of a corridor
        // whose doors were all behind them, over the void ("when I go up I
        // can't reach the end"). It is the hall and NOT the arms — those are
        // the reading floor's alone, and a landing that reached over them
        // would hold the reader a storey up with nothing under their feet.
        landing: {
          x0: Math.min(branch.crossX, branch.landingEndX),
          x1: Math.max(branch.crossX, branch.landingEndX),
          z0: branch.zCentre - branch.halfWidth,
          z1: branch.zCentre + branch.halfWidth,
        },
      });
    }
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
      // Height is something the BUILDING moves by, not something the reader
      // climbs: going up a flight means the world comes down. That keeps the
      // reader at the origin, which is where the XR recentre and every piece
      // of in-world chrome expect them to be.
      y: -(pose.rise ?? 0),
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
  /**
   * The tallest the sign's plate may be. The renderer sizes the plate from
   * the text (only it knows the font), but only the placement side knows how
   * much clear wall there is between the door head and the soffit — so it
   * ships the budget and the renderer shrinks the name to fit it. Without
   * this a long section name simply grew until the soffit cut it in half.
   */
  maxHeight?: number;
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
  if (mode !== "rooms" || pageCount < MIN_PAGES_FOR_PAGE_VIEWS) return [];
  const m = planFor(pageCount, panel, opts);
  const floorY = opts.floorY ?? -panel.height * 2;
  const doorTop = floorY + DOOR_HEIGHT;
  // The clear band on the lintel: from the door head up to the underside of
  // the dropped soffit, which hangs in front of the wall and will occlude
  // anything mounted behind it.
  // …less a margin, because the renderer draws a rule round the plate that
  // stands outside the height budgeted here, and the sign is mounted proud
  // enough to be well inside the soffit's overhang.
  const bandTop = ROOM_WALL_HEADROOM - ROOM_SOFFIT_DROP;
  const band = Math.max(0.12, bandTop - doorTop - 0.05);
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
      // Centred in that clear band, measured rather than nudged: it follows
      // the ceiling, the doorway and the soffit, so a fixed offset from the
      // door head would drift the moment any of the three is tuned.
      y: doorTop + band / 2,
      z: room.zNear + SIGN_PROUD,
    },
    // Facing back up the corridor, i.e. at whoever is walking toward the door.
    rotation: { x: 0, y: 0, z: 0 },
    // A ceiling, not a target: the renderer starts here and comes down until
    // the plate fits `maxHeight`.
    fontSize: 0.17,
    maxHeight: band,
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
  switch (mode) {
    case "wall":
      // The wall is an outline board, not a page field: its cells are
      // sections as well as pages and it reflows as levels open, so it has
      // its own model — see computeWallCells.
      return [];
    case "deck":
      // The deck is a card table the reader rearranges by hand, not a page
      // field: its cells are lanes and cards whose order is the READER's, so
      // it has its own model — see computeDeckLayout.
      return [];
    case "rooms":
      return rooms(pageCount, panel, focus, opts);
    default:
      return [];
  }
}
