/**
 * scene/minimap-layout.ts — where the minimap's marks go, and nothing else.
 *
 * Pure: no three.js, no React, no metres-of-the-world — only panel-local
 * geometry. Split out of `minimap.tsx` so the one thing on that panel that can
 * be wrong in a way the reader notices (two documents drawn through each
 * other) is checkable offline under `tsx` the way `links/memory.ts` is, rather
 * than only by putting a headset on and travelling until it happens.
 *
 * `scripts/check-minimap-layout.ts` is that check.
 */
import type { NavNode } from "../../links/memory";

/**
 * Panel size in metres, at the distance below. Small: it is a corner, not a
 * view. 0.2 m at 0.85 m is about 13° across — big enough to pick a node out
 * of, small enough that it never competes with the document for the middle of
 * the frame.
 */
export const W = 0.2;
export const H = 0.16;
/**
 * MINIMUM lattice pitch at full size. The drawing is laid out at a pitch of at
 * least this and then fitted to the panel as a whole (see `plot`), so this is
 * the spacing a short history gets rather than a spacing every history is
 * forced into. `plot` raises it when the glyphs of THIS view need more room
 * than it gives — pitch is a free parameter once the fit rescales everything.
 */
const PITCH = 0.05;
export const NODE_R = 0.009;
/** The unit every glyph below is built from. */
export const U = NODE_R * 2;
/**
 * Half the box each view's glyph actually occupies, in units of U — measured
 * off the bars `NodeGlyph` draws, not off the dot they used to be.
 *
 * This is the number the layout used to be missing, and it was missing twice.
 * First the pitch was fitted to the panel from the lattice span alone, so six
 * rooms in a line got a 9 mm pitch while a room plan is 29 mm across. That was
 * fixed with a single worst-case half-extent — which was still wrong in the
 * other direction: one number cannot separate a room (1.6u × 1.2u, wide and
 * flat) from a deck card (1.68u × 1.68u with its lip), so a revisited
 * coordinate was offset by less than the width of the shape being offset and
 * the two plans were drawn through each other.
 *
 * So the extents are per view and per axis, and everything that needs to know
 * how much room a node takes — the fit, the stack step, the pitch and the hit
 * target — reads them.
 */
export const GLYPH: Record<string, { hx: number; hy: number }> = {
  // wall: a 1.25u face, plus the rim the current one stands proud with.
  wall: { hx: 0.8, hy: 0.8 },
  // deck: a 1.5u card, widened to 1.68u by the lifted edge and reaching 0.84u
  // below its centre for the lip.
  deck: { hx: 0.84, hy: 0.84 },
  // rooms: a 1.6u × 1.2u plan. Wide and flat, which is the whole reason one
  // number could not do this job.
  rooms: { hx: 0.8, hy: 0.6 },
};
export const GLYPH_FALLBACK = { hx: 0.85, hy: 0.85 };
/**
 * Clear air between two glyph boxes, in units of U. Half a unit rather than a
 * token sliver: at this size on the panel two rooms parked a third of a unit
 * apart put their walls close enough to read as one thick wall, which is the
 * same failure as overlapping with extra steps. Half a unit separates them and
 * costs almost nothing off the fitted glyph, because the fit is driven by the
 * span of the whole drawing and not by this gap.
 */
const GLYPH_GAP = 0.5;
/** The band between the two captions — all the map is allowed to draw in. */
const PLOT_TOP = H / 2 - 0.026;
const PLOT_BOTTOM = -H / 2 + 0.038;
const PLOT_HALF_W = W / 2 - 0.012;
const PLOT_MID_Y = (PLOT_TOP + PLOT_BOTTOM) / 2;
/**
 * Floor on the fit. Past this a glyph is under half a degree wide and the
 * shape stops being readable as a shape, so a very long history is allowed to
 * run off the panel edge rather than shrink into an unreadable smudge — the
 * map stays true about WHERE, and the reader can still tell a room from a
 * card. Reached at about eleven documents in a straight line.
 *
 * It cannot reintroduce overlap: the fit is uniform, so pitch and glyph shrink
 * by the same factor and the clearances below are preserved at every scale.
 */
const MIN_SCALE = 0.3;
/** Z order within the panel: edges under glyphs, glyphs under hit targets. */
export const Z_EDGE = 0.0005;

/** Which wall of a room a corridor meets. */
export type Side = "n" | "s" | "e" | "w";

interface Plotted {
  node: NavNode;
  historyIndex: number;
  /** Panel-local position, metres. */
  x: number;
  y: number;
}

interface Plot {
  points: Plotted[];
  /** Uniform scale the drawing was fitted by — glyphs wear it too. */
  scale: number;
  /** Fitted half-extents of one glyph, panel metres. */
  gx: number;
  gy: number;
  /** Fitted lattice pitch, panel metres. */
  cell: number;
}

/**
 * Lay the history out on its lattice, then fit the whole drawing to the panel.
 *
 * Two steps rather than one, and the order is the point. Laying out first at a
 * fixed pitch and fitting after means the thing being fitted is the drawing
 * the reader actually sees — glyph extents and stacked revisits included —
 * instead of a set of bare centres that the glyphs then overflow. The glyphs
 * are scaled by the same factor, so a node can never grow into its neighbour:
 * pitch and mark shrink together or not at all.
 *
 * Coordinates can collide — going east then west then east again returns to a
 * coordinate already occupied by a different document — so a collided node is
 * STACKED rather than drawn on top of its predecessor. Stacking is honest here
 * in a way that dropping would not be: the reader visited both.
 *
 * The stack goes up, by one glyph height plus clear air, and the pitch is
 * raised to cover the tallest stack on the map. That is what keeps the two
 * readings apart: a revisit sits a fraction of a lattice step above its twin,
 * a genuine northward move sits a full step away, and neither is ever drawn
 * through the other.
 */
export function plot(history: NavNode[], view: string): Plot {
  const g = GLYPH[view] ?? GLYPH_FALLBACK;
  const hx = g.hx * U;
  const hy = g.hy * U;
  const gap = GLYPH_GAP * U;
  if (history.length === 0) {
    return { points: [], scale: 1, gx: hx, gy: hy, cell: PITCH };
  }

  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  const perCoord = new Map<string, number>();
  for (const n of history) {
    minX = Math.min(minX, n.coord.x);
    maxX = Math.max(maxX, n.coord.x);
    minY = Math.min(minY, n.coord.y);
    maxY = Math.max(maxY, n.coord.y);
    const key = `${n.coord.x},${n.coord.y}`;
    perCoord.set(key, (perCoord.get(key) ?? 0) + 1);
  }
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;

  // One step of a stack, and the tallest stack anywhere on the map.
  const step = 2 * hy + gap;
  let deepest = 0;
  for (const count of perCoord.values()) deepest = Math.max(deepest, count - 1);

  // The pitch that keeps every pair of glyphs apart: wide enough for two boxes
  // side by side, and tall enough that the top of one cell's stack still
  // clears the bottom of the cell above it.
  const pitch = Math.max(PITCH, 2 * hx + gap, deepest * step + 2 * hy + gap);

  const used = new Map<string, number>();
  const raw = history.map((node, historyIndex) => {
    const key = `${node.coord.x},${node.coord.y}`;
    const stacked = used.get(key) ?? 0;
    used.set(key, stacked + 1);
    return {
      node,
      historyIndex,
      x: (node.coord.x - cx) * pitch,
      y: (node.coord.y - cy) * pitch + stacked * step,
    };
  });

  // The box the drawing occupies, glyphs and all.
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const p of raw) {
    x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x);
    y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y);
  }
  const drawW = x1 - x0 + hx * 2;
  const drawH = y1 - y0 + hy * 2;
  const scale = Math.max(
    MIN_SCALE,
    Math.min(1, (PLOT_HALF_W * 2) / drawW, (PLOT_TOP - PLOT_BOTTOM) / drawH),
  );

  // Recentre on the plot band rather than on the panel: the captions own the
  // top and bottom of it, and a map centred on the panel drifts under them.
  const midX = (x0 + x1) / 2;
  const midY = (y0 + y1) / 2;
  const points = raw.map((p) => ({
    ...p,
    x: (p.x - midX) * scale,
    y: (p.y - midY) * scale + PLOT_MID_Y,
  }));
  return { points, scale, gx: hx * scale, gy: hy * scale, cell: pitch * scale };
}

/**
 * Route a corridor from the node a document was reached FROM to the document
 * itself, and report which wall it meets at each end.
 *
 * Buildings do not have diagonal hallways, and a wire from centre to centre
 * crosses both rooms it connects and leaves through their walls — which is
 * what stopped the rooms map reading as a plan. So the run is orthogonal, and
 * it starts and ends ON the walls rather than at the centres.
 *
 * Orthogonal is not enough on its own. A two-leg dogleg turns at a cell
 * CENTRE-LINE, and a centre-line is where rooms live: go east, come back west
 * to a coordinate already visited, and the leg that walks back runs the length
 * of the row it is leaving — straight through the room standing in it.
 *
 * So a corridor that cannot go straight is routed through the clear vertical
 * band halfway between two columns. That band is guaranteed empty: the pitch
 * is never less than two glyphs plus clear air (see `plot`), so half a pitch
 * from any column centre is outside every glyph in the map, at every y. The
 * straight cases are kept for the same reason they look right — nothing is
 * between two rooms in the same row — and the occupancy test below is what
 * decides, rather than an assumption about which moves can collide.
 */
export function corridor(
  from: Plotted,
  to: Plotted,
  hx: number,
  hy: number,
  cell: number,
  all: readonly Plotted[],
): { pts: [number, number][]; fromSide: Side; toSide: Side } {
  const EPS = 1e-6;
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const east = dx > 0;
  const up = dy > 0;

  const strictlyBetween = (v: number, a: number, b: number) =>
    v > Math.min(a, b) + EPS && v < Math.max(a, b) - EPS;
  /** Is a third room standing on the straight run between these two? */
  const blocked = (vertical: boolean) =>
    all.some(
      (q) =>
        q !== from &&
        q !== to &&
        (vertical
          ? Math.abs(q.x - from.x) < hx * 2 && strictlyBetween(q.y, from.y, to.y)
          : Math.abs(q.y - from.y) < hy * 2 && strictlyBetween(q.x, from.x, to.x)),
    );

  // Same row: the two rooms are neighbours in x with nothing between them.
  if (Math.abs(dy) < EPS) {
    return {
      pts: [
        [from.x + (east ? hx : -hx), from.y],
        [to.x + (east ? -hx : hx), to.y],
      ],
      fromSide: east ? "e" : "w",
      toSide: east ? "w" : "e",
    };
  }
  // Same column, and nothing stacked in the way.
  if (Math.abs(dx) < EPS && !blocked(true)) {
    return {
      pts: [
        [from.x, from.y + (up ? hy : -hy)],
        [to.x, to.y + (up ? -hy : hy)],
      ],
      fromSide: up ? "n" : "s",
      toSide: up ? "s" : "n",
    };
  }

  // Out into the clear band, along it, and back in. Both doors are in a side
  // wall, which is what a room reached along a corridor actually has.
  const band = Math.abs(dx) > EPS ? (from.x + to.x) / 2 : from.x + cell / 2;
  const leaveEast = band > from.x;
  const enterEast = band > to.x;
  return {
    pts: [
      [from.x + (leaveEast ? hx : -hx), from.y],
      [band, from.y],
      [band, to.y],
      [to.x + (enterEast ? hx : -hx), to.y],
    ],
    fromSide: leaveEast ? "e" : "w",
    toSide: enterEast ? "e" : "w",
  };
}
