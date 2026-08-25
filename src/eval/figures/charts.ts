/**
 * eval/figures/charts.ts — the thesis figures.
 *
 * Each builder takes plain data and returns a complete SVG document, so a
 * figure can be regenerated, diffed and eyeballed without running the benchmark.
 */
import {
  PALETTE,
  bar,
  footnoteHeight,
  subtitleHeight,
  inkOnRamp,
  line,
  linearScale,
  rampColour,
  rect,
  svgDocument,
  text,
  tip,
} from "./svg";

const AXIS_LABEL = { size: 11, fill: PALETTE.inkSecondary } as const;

// ─────────────────────────────────────────────────────────────
// 1. Horizontal bars with confidence intervals
// ─────────────────────────────────────────────────────────────

export interface BarRow {
  label: string;
  value: number;
  lower?: number;
  upper?: number;
  /** Emphasised (ours) or recessive (a baseline). */
  emphasis?: boolean;
  /** Optional colour override — used by the ablation ladder. */
  colour?: string;
  annotation?: string;
}

export interface BarsSpec {
  title: string;
  subtitle?: string;
  footnote?: string;
  rows: BarRow[];
  /** Axis label for the measured quantity. */
  valueLabel: string;
  domain?: [number, number];
  /** Value formatter for the direct labels. */
  format?: (v: number) => string;
  width?: number;
}

export function barsWithCI(spec: BarsSpec): string {
  const {
    rows,
    valueLabel,
    format = (v) => v.toFixed(3),
    width = 760,
  } = spec;
  const left = 210;
  const right = 64;
  const top = 76 + subtitleHeight(spec.subtitle, width);
  const rowH = 30;
  const height = top + rows.length * rowH + 52 + footnoteHeight(spec.footnote, width);
  const plotW = width - left - right;

  const lo = Math.min(0, ...rows.map((r) => r.lower ?? r.value));
  const hi = Math.max(...rows.map((r) => r.upper ?? r.value));
  const domain = spec.domain ?? [lo, hi * 1.12 || 1];
  const x = linearScale(domain, [left, left + plotW]);

  const b: string[] = [];
  // Grid first, so marks sit on top of it.
  for (const t of x.ticks(5)) {
    b.push(line(x(t), top - 8, x(t), top + rows.length * rowH, PALETTE.grid, 1));
    b.push(text(x(t), top + rows.length * rowH + 18, format(t), { ...AXIS_LABEL, anchor: "middle" }));
  }
  b.push(
    text(left + plotW / 2, top + rows.length * rowH + 40, valueLabel, {
      ...AXIS_LABEL,
      anchor: "middle",
    }),
  );

  rows.forEach((r, i) => {
    const y = top + i * rowH;
    const h = rowH - 12;
    const colour = r.colour ?? (r.emphasis ? PALETTE.ours : PALETTE.baseline);
    const w = x(r.value) - x(Math.max(domain[0], 0));
    b.push(
      bar(
        x(Math.max(domain[0], 0)),
        y + 3,
        w,
        h,
        colour,
        "right",
        `${r.label}: ${format(r.value)}${r.lower !== undefined ? ` (95% CI ${format(r.lower)}–${format(r.upper ?? r.value)})` : ""}`,
      ),
    );
    if (r.lower !== undefined && r.upper !== undefined) {
      const cy = y + 3 + h / 2;
      b.push(line(x(r.lower), cy, x(r.upper), cy, PALETTE.ink, 1.5));
      b.push(line(x(r.lower), cy - 4, x(r.lower), cy + 4, PALETTE.ink, 1.5));
      b.push(line(x(r.upper), cy - 4, x(r.upper), cy + 4, PALETTE.ink, 1.5));
    }
    b.push(
      text(left - 10, y + rowH / 2, r.label, {
        ...AXIS_LABEL,
        anchor: "end",
        baseline: "middle",
        weight: r.emphasis ? 600 : 400,
        fill: r.emphasis ? PALETTE.ink : PALETTE.inkSecondary,
      }),
    );
    // A value label sitting outside a nearly-full bar collides with the CI cap
    // and then with the plot edge. Past ~80% of the axis it goes inside the bar
    // instead, in surface ink — the only place it still has room.
    const outsideRoom = left + plotW - x(r.upper ?? r.value) > 46;
    b.push(
      text(
        outsideRoom ? x(r.upper ?? r.value) + 8 : x(r.value) - 8,
        y + rowH / 2,
        format(r.value) + (r.annotation ? `  ${r.annotation}` : ""),
        {
          size: 11,
          fill: outsideRoom ? PALETTE.ink : PALETTE.surface,
          anchor: outsideRoom ? "start" : "end",
          baseline: "middle",
          weight: r.emphasis ? 600 : 400,
        },
      ),
    );
  });

  return svgDocument(
    { width, height, title: spec.title, subtitle: spec.subtitle, footnote: spec.footnote },
    b.join("\n"),
  );
}

// ─────────────────────────────────────────────────────────────
// 2. Heatmap (confusion matrix, and system × label F1)
// ─────────────────────────────────────────────────────────────

export interface HeatmapSpec {
  title: string;
  subtitle?: string;
  footnote?: string;
  rowLabels: string[];
  colLabels: string[];
  /** values[row][col], already normalised to 0–1 for colour. */
  values: number[][];
  /** Raw values for the cell text, if different from the colour value. */
  display?: (row: number, col: number) => string;
  rowAxisLabel?: string;
  colAxisLabel?: string;
  cell?: number;
  legendLabel?: string;
}

export function heatmap(spec: HeatmapSpec): string {
  const cell = spec.cell ?? 40;
  const left = 132;
  const top = 108 + subtitleHeight(spec.subtitle, Math.max(760, left + spec.colLabels.length * cell + 60));
  const width = Math.max(760, left + spec.colLabels.length * cell + 60);
  const height =
    top + spec.rowLabels.length * cell + 76 + footnoteHeight(spec.footnote, width);

  const b: string[] = [];
  if (spec.colAxisLabel) {
    b.push(text(left, top - 44, spec.colAxisLabel, { size: 10.5, fill: PALETTE.inkMuted }));
  }
  spec.colLabels.forEach((c, j) => {
    b.push(
      text(left + j * cell + cell / 2, top - 10, c, {
        size: 10,
        fill: PALETTE.inkSecondary,
        anchor: "start",
        rotate: -55,
      }),
    );
  });
  spec.rowLabels.forEach((r, i) => {
    b.push(
      text(left - 10, top + i * cell + cell / 2, r, {
        size: 10.5,
        fill: PALETTE.inkSecondary,
        anchor: "end",
        baseline: "middle",
      }),
    );
    spec.values[i].forEach((v, j) => {
      const t = Math.max(0, Math.min(1, v));
      const label = spec.display ? spec.display(i, j) : v.toFixed(2);
      // A 2px surface gap between cells — adjacent fills must not touch.
      b.push(
        `<rect x="${left + j * cell + 1}" y="${top + i * cell + 1}" width="${cell - 2}" height="${cell - 2}" rx="3" fill="${rampColour(t)}">${tip(`${spec.rowLabels[i]} → ${spec.colLabels[j]}: ${label}`)}</rect>`,
      );
      if (label !== "" && label !== "0" && label !== "0.00") {
        b.push(
          text(left + j * cell + cell / 2, top + i * cell + cell / 2, label, {
            size: 9.5,
            fill: inkOnRamp(t),
            anchor: "middle",
            baseline: "middle",
          }),
        );
      }
    });
  });
  if (spec.rowAxisLabel) {
    b.push(
      text(18, top + (spec.rowLabels.length * cell) / 2, spec.rowAxisLabel, {
        size: 10.5,
        fill: PALETTE.inkMuted,
        anchor: "middle",
        rotate: -90,
      }),
    );
  }

  // Scale legend — a sequential ramp is unreadable without one.
  const legY = top + spec.rowLabels.length * cell + 34;
  const legW = 180;
  for (let i = 0; i < 40; i++) {
    b.push(rect(left + (i * legW) / 40, legY, legW / 40 + 0.6, 10, rampColour(i / 39)));
  }
  b.push(text(left, legY + 24, "0", { size: 9.5, fill: PALETTE.inkMuted }));
  b.push(text(left + legW, legY + 24, "1", { size: 9.5, fill: PALETTE.inkMuted, anchor: "end" }));
  if (spec.legendLabel) {
    b.push(text(left + legW + 14, legY + 9, spec.legendLabel, { size: 10, fill: PALETTE.inkMuted }));
  }

  return svgDocument(
    { width, height, title: spec.title, subtitle: spec.subtitle, footnote: spec.footnote },
    b.join("\n"),
  );
}

// ─────────────────────────────────────────────────────────────
// 3. Forest plot — paired differences with confidence intervals
// ─────────────────────────────────────────────────────────────
