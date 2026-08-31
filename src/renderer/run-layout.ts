/**
 * renderer/run-layout.ts
 *
 * How a run of doors is laid out along the edge of the page it belongs to.
 *
 * Pure and node-importable, like the rest of the placement math, because the
 * two properties that matter here are checkable without a renderer: a run must
 * FIT the edge it is drawn on, and its rank must read from the middle out.
 *
 * The second is a rule the design has had since the strips were built — the
 * way back and the nearest sibling belong where the reader is already looking,
 * not at whichever end the packing happened to start. The first arrived with
 * the neighbour cards: once items stopped being one size, a fixed pitch could
 * no longer place them, and a short run floated in the middle of a tall panel
 * while a long one ran off its end.
 *
 * NO three.js, no React, no metres beyond what the caller passes in.
 */

/** Most extra gap a run will take, in plate-sizes, before it stays a block. */
const MAX_SPREAD = 1.5;

export interface RunSpan {
  /** How many base units tall (or wide) this item wants to be. */
  rows: number;
}

export interface RunLayout {
  /** Offsets from the run's centre, in the caller's units, one per item. */
  centres: number[];
  /** The size each item ended up with. */
  size: number[];
}

/**
 * Stack a run outward from its middle, scaled to the span it has.
 *
 * `unit` is one plate's size; an item asking for `rows: 3` is three plates
 * tall. Everything scales DOWN together when the natural total overruns the
 * span, and the leftover of a short run is spent on gaps rather than on making
 * plates bigger — a two-door run drawn as two half-metre banners was the fault
 * the fixed plate size was introduced to fix.
 *
 * Items go to whichever end of the stack is currently shorter, which
 * alternates while the sizes match and stays balanced when they do not.
 */
export function stackRun(
  items: readonly RunSpan[],
  span: number,
  unit: number,
  gap: number,
): RunLayout {
  const n = items.length;
  if (n === 0) return { centres: [], size: [] };

  const natural = items.reduce((t, it) => t + it.rows * unit, 0) + gap * (n - 1);
  const scale = natural > span && natural > 0 ? span / natural : 1;
  const size = items.map((it) => it.rows * unit * scale);
  const used = size.reduce((a, b) => a + b, 0);
  // Slack becomes gap, but only so much of it.
  //
  // Dividing ALL the leftover of a two-item run between its two items puts one
  // at each end of the panel with three quarters of a metre of nothing between
  // them — filling the span, technically, and reading as two unrelated objects.
  // Past this the run stays a block and is centred instead.
  const spread =
    n > 1 ? Math.min(Math.max(gap * scale, (span - used) / (n - 1)), unit * MAX_SPREAD) : 0;

  const centres = new Array<number>(n);
  let lo = 0;
  let hi = 0;
  for (let i = 0; i < n; i++) {
    if (i === 0) {
      centres[i] = 0;
      lo = -size[i] / 2;
      hi = size[i] / 2;
    } else if (hi <= -lo) {
      centres[i] = hi + spread + size[i] / 2;
      hi = centres[i] + size[i] / 2;
    } else {
      centres[i] = lo - spread - size[i] / 2;
      lo = centres[i] - size[i] / 2;
    }
  }
  // Centre the finished run on the edge it sits on. Placing outward from item
  // 0 keeps the RANK right but lets the block drift toward whichever side took
  // the taller items; the reader should see a column centred on the page, not
  // one sagging to its bottom edge.
  const shift = (lo + hi) / 2;
  for (let i = 0; i < n; i++) centres[i] -= shift;
  return { centres, size };
}
