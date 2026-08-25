/**
 * eval/figures/svg.ts — dependency-free SVG chart primitives for the thesis
 * figures.
 *
 * Standalone `.svg` files, one per figure: vector, so they survive being scaled
 * into a page at whatever size the layout wants, and editable afterwards without
 * re-running the benchmark.
 *
 * Colour follows the validated reference palette. The figures deliberately use
 * EMPHASIS rather than a hue per system — the story in every one of them is a
 * single comparison, "ours against the rest", and eight categorical hues would
 * spend the colour channel on identity nobody needs to track. Ours is blue,
 * everything it is being compared against is grey, and every bar carries its
 * value as a direct label so the figure is readable in greyscale print and by a
 * colour-blind reader with no colour information at all.
 */

export const PALETTE = {
  surface: "#fcfcfb",
  ink: "#0b0b0b",
  inkSecondary: "#52514e",
  inkMuted: "#85847e",
  grid: "#e6e5e1",
  axis: "#c9c8c2",
  /** Emphasis: the system under test. */
  ours: "#2a78d6",
  /** Everything ours is compared against. */
  baseline: "#8a8a84",
  /** Ablation conditions — ordered, so an ordinal ramp rather than hues. */
  ablation: ["#86b6ef", "#5598e7", "#2a78d6", "#184f95"],
  /** Diverging poles for signed differences. Warm/cool, neutral midpoint. */
  positive: "#2a78d6",
  negative: "#e34948",
  neutral: "#f0efec",
  /** Categorical, for the ≤3-series figures (validated all-pairs). */
  series: ["#2a78d6", "#eb6834", "#1baf7a"],
  /** Sequential ramp, light → dark, for magnitude heatmaps. */
  ramp: [
    "#f5f8fe", "#cde2fb", "#b7d3f6", "#9ec5f4", "#86b6ef", "#6da7ec",
    "#5598e7", "#3987e5", "#2a78d6", "#256abf", "#1c5cab", "#184f95",
    "#104281", "#0d366b",
  ],
} as const;

const FONT = `-apple-system, "Segoe UI", Inter, Helvetica, Arial, sans-serif`;

export function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export interface TextOptions {
  size?: number;
  fill?: string;
  anchor?: "start" | "middle" | "end";
  weight?: number;
  baseline?: "auto" | "middle" | "hanging";
  rotate?: number;
  family?: string;
}

export function text(x: number, y: number, s: string, o: TextOptions = {}): string {
  const {
    size = 12,
    fill = PALETTE.ink,
    anchor = "start",
    weight = 400,
    baseline = "auto",
    rotate,
  } = o;
  const transform = rotate ? ` transform="rotate(${rotate} ${x} ${y})"` : "";
  const db = baseline === "auto" ? "" : ` dominant-baseline="${baseline}"`;
  return `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" font-family="${FONT}" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}"${db}${transform}>${esc(s)}</text>`;
}

/** Native tooltip on a mark — the hover layer an SVG gets for free. */
export function tip(s: string): string {
  return `<title>${esc(s)}</title>`;
}

export function rect(
  x: number,
  y: number,
  w: number,
  h: number,
  fill: string,
  extra = "",
): string {
  return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${Math.max(0, w).toFixed(1)}" height="${Math.max(0, h).toFixed(1)}" fill="${fill}"${extra ? " " + extra : ""}/>`;
}

/** A bar with its data end rounded and its baseline end square. */
export function bar(
  x: number,
  y: number,
  w: number,
  h: number,
  fill: string,
  orientation: "up" | "right",
  title?: string,
): string {
  const r = Math.min(4, orientation === "up" ? w / 2 : h / 2, Math.max(0, orientation === "up" ? h : w));
  if (h <= 0 || w <= 0) return "";
  let d: string;
  if (orientation === "up") {
    d = `M${x} ${y + h} L${x} ${y + r} Q${x} ${y} ${x + r} ${y} L${x + w - r} ${y} Q${x + w} ${y} ${x + w} ${y + r} L${x + w} ${y + h} Z`;
  } else {
    d = `M${x} ${y} L${x + w - r} ${y} Q${x + w} ${y} ${x + w} ${y + r} L${x + w} ${y + h - r} Q${x + w} ${y + h} ${x + w - r} ${y + h} L${x} ${y + h} Z`;
  }
  return `<path d="${d}" fill="${fill}">${title ? tip(title) : ""}</path>`;
}

export function line(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  stroke: string,
  width = 1,
  dash?: string,
): string {
  return `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="${stroke}" stroke-width="${width}"${dash ? ` stroke-dasharray="${dash}"` : ""}/>`;
}

export function circle(cx: number, cy: number, r: number, fill: string, title?: string, extra = ""): string {
  return `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${r}" fill="${fill}"${extra ? " " + extra : ""}>${title ? tip(title) : ""}</circle>`;
}

export interface FigureFrame {
  width: number;
  height: number;
  title: string;
  subtitle?: string;
  /** Printed at the foot of every figure — provenance travels with the picture. */
  footnote?: string;
}

/**
 * Wrap the footnote to the figure width. SVG has no flow text, so the wrap is
 * done by hand — a footnote that runs off the right edge is how provenance
 * stops being read.
 */
function wrapAt(s: string, perLine: number): string[] {
  const lines: string[] = [];
  let cur = "";
  for (const w of s.split(" ")) {
    if ((cur + " " + w).trim().length > perLine) {
      lines.push(cur.trim());
      cur = w;
    } else cur += " " + w;
  }
  if (cur.trim()) lines.push(cur.trim());
  return lines;
}

export function wrapFootnote(footnote: string | undefined, width: number): string[] {
  if (!footnote) return [];
  return wrapAt(footnote, Math.floor((width - 40) / 5.4));
}

/**
 * Vertical space a footnote needs. Charts add this to their own height —
 * otherwise the footnote is drawn up into the axis labels, which is how a
 * figure ends up with two overlapping lines of text along its bottom edge.
 */
/** Subtitle wrapped to the figure width, at the subtitle's own character width. */
export function wrapSubtitle(subtitle: string | undefined, width: number): string[] {
  if (!subtitle) return [];
  return wrapAt(subtitle, Math.floor((width - 40) / 6.1));
}

/** Extra height a multi-line subtitle needs above the plot. */
export function subtitleHeight(subtitle: string | undefined, width: number): number {
  return Math.max(0, wrapSubtitle(subtitle, width).length - 1) * 15;
}

export function footnoteHeight(footnote: string | undefined, width: number): number {
  const lines = wrapFootnote(footnote, width);
  return lines.length === 0 ? 8 : lines.length * 13 + 14;
}

/** Wrap body markup in a complete, standalone SVG document. */
export function svgDocument(frame: FigureFrame, body: string): string {
  const { width, height, title, subtitle, footnote } = frame;
  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(title)}">`,
  );
  parts.push(`<title>${esc(title)}</title>`);
  parts.push(rect(0, 0, width, height, PALETTE.surface));
  parts.push(text(20, 28, title, { size: 15, weight: 600 }));
  if (subtitle) {
    // Subtitles wrap on the same rule as footnotes; an unwrapped one runs off
    // the right edge and the sentence that qualifies the figure is lost.
    wrapSubtitle(subtitle, width).forEach((l, i) => {
      parts.push(text(20, 47 + i * 15, l, { size: 11.5, fill: PALETTE.inkSecondary }));
    });
  }
  parts.push(body);
  if (footnote) {
    const lines = wrapFootnote(footnote, width);
    lines.forEach((l, i) => {
      parts.push(
        text(20, height - 12 - (lines.length - 1 - i) * 13, l, {
          size: 9.5,
          fill: PALETTE.inkMuted,
        }),
      );
    });
  }
  parts.push("</svg>");
  return parts.join("\n");
}

// ─────────────────────────────────────────────────────────────
// Scales
// ─────────────────────────────────────────────────────────────

export interface LinearScale {
  (v: number): number;
  domain: [number, number];
  ticks: (count: number) => number[];
}

export function linearScale(
  domain: [number, number],
  range: [number, number],
): LinearScale {
  const [d0, d1] = domain;
  const [r0, r1] = range;
  const span = d1 - d0 || 1;
  const f = ((v: number) => r0 + ((v - d0) / span) * (r1 - r0)) as LinearScale;
  f.domain = domain;
  f.ticks = (count: number) => {
    const step = niceStep((d1 - d0) / Math.max(1, count));
    const start = Math.ceil(d0 / step) * step;
    const out: number[] = [];
    for (let v = start; v <= d1 + 1e-9; v += step) out.push(Math.round(v / step) * step);
    return out;
  };
  return f;
}

function niceStep(raw: number): number {
  if (raw <= 0) return 1;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const nice = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
  return nice * mag;
}

/** Pick a ramp colour for t in [0,1]. */
export function rampColour(t: number): string {
  const clamped = Math.max(0, Math.min(1, t));
  const i = Math.round(clamped * (PALETTE.ramp.length - 1));
  return PALETTE.ramp[i];
}

/** Readable ink over a ramp cell — the dark half of the ramp needs light text. */
export function inkOnRamp(t: number): string {
  return t > 0.55 ? "#ffffff" : PALETTE.ink;
}
