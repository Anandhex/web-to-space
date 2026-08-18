/**
 * renderer/scene/__tests__/minimap-layout.ts — no two marks drawn through each other.
 *
 *   npm run test:minimap
 *
 * The minimap is the one surface that must stay true (see minimap.tsx), and
 * the way it stops being true is not a wrong coordinate — it is two documents
 * plotted so close that the reader sees one shape. That happened: a revisited
 * lattice coordinate was offset by less than the width of the glyph being
 * offset, so on the rooms map two plans were drawn through each other and the
 * result read as a broken building rather than as two rooms.
 *
 * A screenshot catches that only if the reader happens to walk a history that
 * produces it. This does not: it walks histories that are known to produce
 * collisions, then checks every PAIR of glyph boxes on the panel for overlap,
 * in every view's own extents.
 *
 * Pure — the layout module has no three.js and no React, which is the reason
 * it is a module.
 */
import { GLYPH, GLYPH_FALLBACK, corridor, plot } from "../minimap-layout";
import { enter, initNav, type Axis, type NavState } from "../../../links/memory";

let checked = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, detail?: string): void {
  checked++;
  if (!cond) failures.push(detail ? `${name} — ${detail}` : name);
}

const VIEWS = ["rooms", "wall", "deck", "unknown-view"];

/** Walk a history: one node per axis given, plus the root. */
function walk(axes: Axis[]): NavState {
  let nav: NavState = initNav("https://0.example/", "0");
  axes.forEach((axis, i) => {
    nav = enter(nav, { url: `https://${i + 1}.example/`, label: String(i + 1), axis });
  });
  return nav;
}

/**
 * Histories chosen for what they do to the LAYOUT, not for what they mean:
 * every one of them either revisits a coordinate or spans the panel.
 */
const CASES: { name: string; axes: Axis[] }[] = [
  { name: "one move", axes: ["up"] },
  // The reported case: out and back and out again lands on an occupied
  // coordinate, which is the collision the stack exists for.
  { name: "there and back and there", axes: ["right", "left", "right"] },
  // Same coordinate three times over — the stack has to keep going.
  { name: "a coordinate visited four times", axes: ["up", "down", "up", "down", "up", "down"] },
  // A loop: four moves that close on the origin.
  { name: "a closed loop", axes: ["right", "up", "left", "down"] },
  // A turn, so the ancestry goes diagonal on the lattice.
  { name: "a turn", axes: ["right", "right", "up", "up", "left"] },
  // Long enough to hit the MIN_SCALE floor, where the drawing overflows the
  // panel — overlap must not come back at the bottom of the fit.
  { name: "a long straight run", axes: Array<Axis>(14).fill("right") },
  // Long and collided at once.
  {
    name: "a long run with revisits",
    axes: ["right", "right", "left", "right", "up", "down", "up", "right", "left", "right"],
  },
];

/**
 * Does an axis-aligned segment pass through a room's box? The segment is
 * shrunk by nothing and the box by nothing: a corridor that merely TOUCHES a
 * wall is a doorway, so the comparison is strict.
 */
function segmentHitsBox(
  a: readonly [number, number],
  b: readonly [number, number],
  room: { x: number; y: number },
  hx: number,
  hy: number,
): boolean {
  const EPS = 1e-9;
  const loX = Math.min(a[0], b[0]), hiX = Math.max(a[0], b[0]);
  const loY = Math.min(a[1], b[1]), hiY = Math.max(a[1], b[1]);
  return (
    hiX > room.x - hx + EPS &&
    loX < room.x + hx - EPS &&
    hiY > room.y - hy + EPS &&
    loY < room.y + hy - EPS
  );
}

/** Do two axis-aligned boxes of the same half-size overlap? */
function overlaps(
  a: { x: number; y: number },
  b: { x: number; y: number },
  hx: number,
  hy: number,
): boolean {
  const EPS = 1e-9;
  return Math.abs(a.x - b.x) < hx * 2 - EPS && Math.abs(a.y - b.y) < hy * 2 - EPS;
}

for (const view of VIEWS) {
  const g = GLYPH[view] ?? GLYPH_FALLBACK;
  for (const c of CASES) {
    const nav = walk(c.axes);
    const { points, gx, gy, cell, scale } = plot(nav.history, view);
    const byIndex = new Map(points.map((q) => [q.historyIndex, q]));

    check(
      `${view} / ${c.name}: every document is plotted`,
      points.length === nav.history.length,
      `got ${points.length} of ${nav.history.length}`,
    );

    // The invariant: no pair of glyph boxes intersects.
    let worst = "";
    for (let i = 0; i < points.length; i++) {
      for (let j = i + 1; j < points.length; j++) {
        if (overlaps(points[i], points[j], gx, gy)) {
          worst =
            `#${i} at (${points[i].x.toFixed(4)}, ${points[i].y.toFixed(4)}) ` +
            `and #${j} at (${points[j].x.toFixed(4)}, ${points[j].y.toFixed(4)}), ` +
            `box ${(gx * 2).toFixed(4)} × ${(gy * 2).toFixed(4)}`;
        }
      }
    }
    check(`${view} / ${c.name}: no two glyphs overlap`, worst === "", worst);

    // The fit is uniform, so the extents it reports must be the declared
    // glyph wearing the same scale as everything else.
    check(
      `${view} / ${c.name}: extents wear the fitted scale`,
      Math.abs(gx - g.hx * 0.018 * scale) < 1e-9 && Math.abs(gy - g.hy * 0.018 * scale) < 1e-9,
      `gx ${gx}, gy ${gy}, scale ${scale}`,
    );

    // No corridor may be drawn through a room it does not connect. This is
    // the check the dogleg failed: it was orthogonal and it still crossed the
    // room standing in the row it walked back along.
    if (view === "rooms") {
      let through = "";
      for (const p of points) {
        const from = p.node.from >= 0 ? byIndex.get(p.node.from) : undefined;
        if (!from) continue;
        const run = corridor(from, p, gx, gy, cell, points);
        for (let i = 1; i < run.pts.length; i++) {
          for (const room of points) {
            if (room === from || room === p) continue;
            if (segmentHitsBox(run.pts[i - 1], run.pts[i], room, gx, gy)) {
              through = `corridor #${from.historyIndex}→#${p.historyIndex} crosses #${room.historyIndex}`;
            }
          }
        }
      }
      check(`${view} / ${c.name}: no corridor crosses a room`, through === "", through);
    }

    // A hit target is capped at the pitch, so the pitch must clear a glyph.
    check(
      `${view} / ${c.name}: the pitch is wider than a glyph`,
      cell > gx * 2 && cell > gy * 2,
      `cell ${cell.toFixed(4)}, box ${(gx * 2).toFixed(4)} × ${(gy * 2).toFixed(4)}`,
    );
  }
}

// ── Corridors ────────────────────────────────────────────────────────────
//
// A corridor must start and end ON a wall, never inside a room, and it must
// run orthogonally: buildings do not have diagonal hallways, and the diagonal
// wire is what made the rooms map read as a scribble over its own plans.

{
  const HX = 0.0144;
  const HY = 0.0108;
  let seq = 0;
  const at = (x: number, y: number) =>
    ({ x, y, historyIndex: seq++, node: null as never });
  const CELL = 0.054;

  const cases: { name: string; from: [number, number]; to: [number, number] }[] = [
    { name: "east", from: [0, 0], to: [0.05, 0] },
    { name: "west", from: [0, 0], to: [-0.05, 0] },
    { name: "north", from: [0, 0], to: [0, 0.05] },
    { name: "south", from: [0, 0], to: [0, -0.05] },
    { name: "a stacked revisit", from: [0, 0], to: [0, 0.027] },
    { name: "east and up (a dogleg)", from: [0, 0], to: [0.05, 0.027] },
    { name: "west and down (a dogleg)", from: [0, 0], to: [-0.05, -0.027] },
  ];

  for (const c of cases) {
    const from = at(...c.from);
    const to = at(...c.to);
    const run = corridor(from, to, HX, HY, CELL, [from, to]);

    // Orthogonal: every leg moves in one axis only.
    let bent = false;
    for (let i = 1; i < run.pts.length; i++) {
      const dx = Math.abs(run.pts[i][0] - run.pts[i - 1][0]);
      const dy = Math.abs(run.pts[i][1] - run.pts[i - 1][1]);
      if (dx > 1e-9 && dy > 1e-9) bent = true;
    }
    check(`corridor ${c.name}: runs orthogonally`, !bent);

    // The ends sit on a wall of their own room: exactly one axis is at the
    // half-extent, and the other is within it.
    const onWall = (p: [number, number], room: { x: number; y: number }) => {
      const dx = Math.abs(p[0] - room.x);
      const dy = Math.abs(p[1] - room.y);
      const xWall = Math.abs(dx - HX) < 1e-9 && dy <= HY + 1e-9;
      const yWall = Math.abs(dy - HY) < 1e-9 && dx <= HX + 1e-9;
      return xWall || yWall;
    };
    check(`corridor ${c.name}: leaves on a wall`, onWall(run.pts[0], from),
      JSON.stringify(run.pts[0]));
    check(`corridor ${c.name}: arrives on a wall`, onWall(run.pts[run.pts.length - 1], to),
      JSON.stringify(run.pts[run.pts.length - 1]));

    // And the wall it reports is the wall it touched, because that is the one
    // the glyph leaves a doorway in.
    const side = (p: [number, number], room: { x: number; y: number }) =>
      Math.abs(Math.abs(p[0] - room.x) - HX) < 1e-9
        ? p[0] > room.x ? "e" : "w"
        : p[1] > room.y ? "n" : "s";
    check(`corridor ${c.name}: names the wall it left by`,
      side(run.pts[0], from) === run.fromSide,
      `${side(run.pts[0], from)} vs ${run.fromSide}`);
    check(`corridor ${c.name}: names the wall it arrived by`,
      side(run.pts[run.pts.length - 1], to) === run.toSide,
      `${side(run.pts[run.pts.length - 1], to)} vs ${run.toSide}`);

    // A run that is neither flat nor a clear column goes out into the band
    // between the columns and comes back — three legs, not two.
    const offset = Math.abs(c.to[0] - c.from[0]) > 1e-9 && Math.abs(c.to[1] - c.from[1]) > 1e-9;
    check(`corridor ${c.name}: ${offset ? "uses the band" : "runs straight"}`,
      run.pts.length === (offset ? 4 : 2), `${run.pts.length} points`);
  }
}

// ── Report ───────────────────────────────────────────────────────────────

for (const f of failures) console.error("  ✗ " + f);
console.log("");
console.log(`minimap layout: ${checked - failures.length}/${checked} checks`);
console.log(failures.length === 0 ? "PASS" : `FAIL: ${failures.length} failing`);
process.exit(failures.length === 0 ? 0 : 1);
