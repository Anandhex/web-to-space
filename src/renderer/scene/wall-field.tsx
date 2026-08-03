/**
 * scene/wall-field.tsx
 *
 * The wall view: a board of the document's OUTLINE that opens one level at a
 * time, rather than a contact sheet of every page.
 *
 *   overview → one tile per root+1 section
 *   click a tile → that section expands IN PLACE into its pages as previews
 *   click a preview → that page grows to full size, still in its own cell
 *
 * Nothing flies to a separate stage: every level of the disclosure happens in
 * the board, which reflows around whatever is open, so the sections you did
 * not open keep their place on the wall (and with it their spatial memory).
 * Clicking an open tile closes it, the full-size page carries a ✕, Escape
 * steps back one level, and ←/→ walk pages when a page is open and sections
 * when one isn't.
 *
 * Pointing at any cell leans the WHOLE board toward it — the geometry of that
 * is `computeWallCells`; everything here is state and rendering.
 *
 * ── How it reads ──
 *
 * Cells alone are grey cards in a void: nothing says they belong together,
 * every one is the same value as the next, and an unlit plane with no edge
 * reads as a hole rather than a surface. So the board is drawn as a thing
 * somebody built, on the same three principles the rooms view settled on:
 *
 *  1. A real SURFACE behind it (`computeWallBoard` → <WallBacking>), following
 *     the same arc the cells do, with the cells standing off it and casting a
 *     soft shadow onto it. That one plane is what turns floating cards into a
 *     board, and it puts a known dark value behind every piece of text.
 *  2. EDGES. Every cell is a rounded <Surface> with a hairline rim, and a page
 *     sits in a mount rather than being a bare quad — the difference between
 *     "two planes meeting" and "a card on a wall".
 *  3. COLOUR that means something. Each section owns a hue (`sectionTint`),
 *     carried by its tile's fill and spine and by the mount and number badge
 *     of every page inside it — so a page is visibly OF its section, and the
 *     board's spatial memory gets a colour anchor as well as a position.
 *
 * The sign plate over the board says where in the document you are at every
 * level of the disclosure, and its rail shows it — the one thing the outline
 * could not tell you before, since a closed board is all closed tiles.
 */
import React from "react";
import { Text } from "@react-three/drei";
import * as THREE from "three";

import type { XRPrimitive } from "../../mapper/types";
import type { LayoutEntry, LayoutPlan } from "../../layout/types";
import { useTheme, type XRTheme } from "../theme";
import {
  computeWallBoard,
  computeWallCells,
  wallSectionOf,
  WALL_BOARD_STANDOFF,
  type SectionPageRange,
  type WallBoard,
  type WallCell,
} from "../page-placements";
import { Surface } from "../primitives/surface";
import {
  Z_LAYER_ACCENT,
  Z_LAYER_OVERLAY_TEXT,
  Z_SURFACE,
} from "../primitives/constants";
import { AtPos } from "./AtPos";
import { FontContext, type PageState } from "./contexts";
import {
  EasedScale,
  LivePageGhost,
  PageHitPlane,
  usePageHeadings,
} from "./page-cells";

/** Pages this far from the open one render as real (mini) content, not cards. */
const WALL_LIVE_PREVIEWS = 3;

/** How far the cell under the pointer steps off the board toward the reader. */
const WALL_HOVER_LIFT = 0.014;
/**
 * Behind the cell: its mount, and — back on the wall itself — its shadow.
 * The mount clears 13 mm because a live preview's own <PanelBacking> is a
 * RoundedBox occupying z ∈ [−0.01, 0]; anything shallower sits INSIDE it and
 * only the ring beyond the card's silhouette would ever be drawn.
 */
const Z_MAT = -0.013;
const Z_SHADOW = -(WALL_BOARD_STANDOFF - 0.014);

// ── Section colour ───────────────────────────────────────────
//
// Six hues, walked in order and wrapped. Six because that is about as many as
// stay tellable apart at a glance across a board (and a document with more
// top-level sections than that has bigger problems than colour); walked in
// order rather than hashed from the label so neighbouring sections are always
// adjacent hues — a board that reads left to right in the spectrum, not a
// bag of confetti.

const WALL_HUES = [212, 168, 268, 36, 344, 104];

// Every colour on this board is mixed in sRGB, explicitly.
//
// three's default working space is LINEAR sRGB, so `setHSL(h, s, 0.19)` and
// `offsetHSL(0, 0, -0.07)` operate on linear values — and a lightness step
// that reads as a nudge on paper is enormous down there. Left implicit, the
// board's backing came out PURE BLACK in the dark theme (panelBg #323232 is
// linear-lightness 0.033; subtracting 0.07 clamps at zero) and every section
// tint landed a good two stops brighter than asked for. Both were caught by
// the offline palette audit, not by looking, which is the only way this kind
// of bug gets caught at all — so the colour space is spelled out at every
// call, and the numbers below mean what they say.

/** Set a colour's saturation and lightness outright, keeping only its hue. */
function atLightness(hue: number, s: number, l: number): string {
  const c = new THREE.Color();
  c.setHSL(hue / 360, s, l, THREE.SRGBColorSpace);
  return `#${c.getHexString()}`;
}

/** Move a colour up or down in sRGB lightness, keeping hue and saturation. */
function shade(hex: string, delta: number): string {
  const c = new THREE.Color(hex);
  const hsl = { h: 0, s: 0, l: 0 };
  c.getHSL(hsl, THREE.SRGBColorSpace);
  c.setHSL(
    hsl.h,
    hsl.s,
    Math.max(0, Math.min(1, hsl.l + delta)),
    THREE.SRGBColorSpace,
  );
  return `#${c.getHexString()}`;
}

function isDarkTheme(theme: XRTheme): boolean {
  const hsl = { h: 0, s: 0, l: 0 };
  new THREE.Color(theme.panelBg).getHSL(hsl, THREE.SRGBColorSpace);
  return hsl.l < 0.5;
}

/**
 * A section's palette: the saturated accent that carries its identity (spine,
 * badge, rail), and the two quiet surface tints its tile and its pages' mounts
 * are made of. Lightnesses are set outright rather than nudged from the hue,
 * so all six sections sit at exactly the same value and only the hue varies —
 * anything else and one section reads as "highlighted".
 */
interface SectionTint {
  accent: string;
  /** Fill for the section's own tile, closed and open. */
  tile: string;
  tileOpen: string;
  /** Mount around each of the section's page cells. */
  mount: string;
  /** Ink that reads on `accent` — a badge's number. */
  onAccent: string;
}

/** WCAG relative luminance of an sRGB hex. */
function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const u = v / 255;
    return u <= 0.03928 ? u / 12.92 : ((u + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}

const INK_DARK = "#141414";
const INK_LIGHT = "#F7F7F7";

/** WCAG contrast ratio between two sRGB hexes. */
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Whichever ink reads better on a given fill. Fixed per THEME instead, the
 * badge numbers on the teal and green sections came out at 3:1 — those hues
 * are far more luminous than blue at the same nominal lightness, so hue by
 * hue there is no one ink that works. The accent lightnesses above are then
 * chosen to keep the WORST hue clear of 4.5:1 with the ink it picks (the
 * break-even between the two inks is the low point, so a lightness that sits
 * on it is the one thing to avoid).
 */
function inkOn(fill: string): string {
  return contrast(INK_LIGHT, fill) >= contrast(INK_DARK, fill)
    ? INK_LIGHT
    : INK_DARK;
}

function sectionTint(index: number, dark: boolean): SectionTint {
  const hue = WALL_HUES[index % WALL_HUES.length];
  // Accent lightness is picked so the WORST of the six hues still clears
  // 4.5:1 against whichever ink `inkOn` gives it — see there.
  const accent = dark
    ? atLightness(hue, 0.62, 0.64)
    : atLightness(hue, 0.58, 0.3);
  return {
    accent,
    tile: dark ? atLightness(hue, 0.14, 0.19) : atLightness(hue, 0.16, 0.8),
    tileOpen: dark ? atLightness(hue, 0.22, 0.27) : atLightness(hue, 0.26, 0.72),
    // The light mount sits at the tile's own level rather than nearer the
    // wall: held any lower it separated from the backing by hue alone, at
    // 1.06:1, and a mount you cannot see is not a mount.
    mount: dark ? atLightness(hue, 0.2, 0.23) : atLightness(hue, 0.18, 0.79),
    onAccent: inkOn(accent),
  };
}

/** The board's own neutrals, derived from the theme so it follows the product. */
function boardTones(theme: XRTheme, dark: boolean) {
  return {
    // The light theme has almost no headroom above panelBg (#DADADA is the
    // top of Meta's brightness band), so its wall goes DOWN a long way — a
    // mid-grey gallery wall with pale cards on it. Held any closer, a page's
    // mount separated from the wall by hue alone, at 1.06:1.
    backing: shade(theme.panelBg, dark ? -0.07 : -0.2),
    backingTop: shade(theme.panelBg, dark ? -0.04 : -0.16),
    plate: shade(theme.panelBg, dark ? 0.03 : -0.02),
    rim: theme.panelRim,
    // Captions on a TINTED tile, not on panelBg: the light theme's muted grey
    // is calibrated for the latter and drops under 3:1 on the former, so the
    // tile's small print steps up to body ink there.
    caption: dark ? theme.mutedTextCol : theme.bodyCol,
  };
}

// ── Shadow ───────────────────────────────────────────────────

/**
 * The soft drop every cell casts on the board behind it. One texture for the
 * whole wall — a rounded-rect falloff written per pixel rather than through
 * canvas `filter`, so it is deterministic and needs no blur support.
 */
let SHADOW_TEX: THREE.Texture | null = null;

function shadowTexture(): THREE.Texture {
  if (SHADOW_TEX) return SHADOW_TEX;
  const N = 96;
  const c = document.createElement("canvas");
  c.width = N;
  c.height = N;
  const g = c.getContext("2d")!;
  const img = g.createImageData(N, N);
  const half = N / 2 - 0.5;
  const box = N * 0.28; // half-extent of the solid core
  const feather = N * 0.2;
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const dx = Math.max(Math.abs(x - half) - box, 0);
      const dy = Math.max(Math.abs(y - half) - box, 0);
      const t = Math.max(0, 1 - Math.hypot(dx, dy) / feather);
      const i = (y * N + x) * 4;
      img.data[i] = 0;
      img.data[i + 1] = 0;
      img.data[i + 2] = 0;
      img.data[i + 3] = Math.round(255 * t * t);
    }
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  SHADOW_TEX = t;
  return t;
}

function CellShadow({
  width,
  height,
  opacity = 0.45,
}: {
  width: number;
  height: number;
  opacity?: number;
}) {
  const map = React.useMemo(() => shadowTexture(), []);
  const grow = 1.34;
  return (
    <mesh
      position={[width / 2, -height / 2, Z_SHADOW]}
      raycast={() => null}
      renderOrder={-1}
    >
      <planeGeometry args={[width * grow, height * grow]} />
      <meshBasicMaterial
        map={map}
        transparent
        opacity={opacity}
        depthWrite={false}
        toneMapped={false}
      />
    </mesh>
  );
}

// ── The backing surface ──────────────────────────────────────

/**
 * The wall itself: the board's arc lofted between its top and bottom edges
 * into one mesh. Vertex-coloured rather than textured — a wash down the
 * surface plus a darkening toward the wings, which is what stops a 3 m board
 * from reading as a flat grey rectangle and quietly says "the middle is where
 * you are looking".
 */
function useBackingGeometry(
  board: WallBoard,
  centreX: number,
  top: string,
  bottom: string,
): THREE.BufferGeometry {
  return React.useMemo(() => {
    const n = board.spine.length;
    const positions = new Float32Array(n * 2 * 3);
    const colors = new Float32Array(n * 2 * 3);
    const cTop = new THREE.Color(top);
    const cBot = new THREE.Color(bottom);
    const half = Math.max(
      0.001,
      Math.abs(board.spine[n - 1].x - board.spine[0].x) / 2,
    );
    const c = new THREE.Color();
    for (let i = 0; i < n; i++) {
      const s = board.spine[i];
      // Wings fall away from the centre — the same cue the depth pushback
      // gives, in value, so it survives being seen head-on.
      const wing = 1 - 0.16 * Math.min(1, Math.abs(s.x - centreX) / half) ** 1.5;
      for (const [k, y] of [
        [0, board.top],
        [1, board.bottom],
      ] as const) {
        const v = (i * 2 + k) * 3;
        positions[v] = s.x;
        positions[v + 1] = y;
        positions[v + 2] = s.z;
        c.copy(k === 0 ? cTop : cBot).multiplyScalar(wing);
        colors[v] = c.r;
        colors[v + 1] = c.g;
        colors[v + 2] = c.b;
      }
    }
    const index: number[] = [];
    for (let i = 0; i < n - 1; i++) {
      const a = i * 2;
      const b = i * 2 + 1;
      const d = (i + 1) * 2;
      const e = (i + 1) * 2 + 1;
      index.push(a, b, d, d, b, e);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    geo.setIndex(index);
    geo.computeVertexNormals();
    return geo;
  }, [board, centreX, top, bottom]);
}

function WallBacking({
  board,
  centreX,
  tones,
}: {
  board: WallBoard;
  centreX: number;
  tones: ReturnType<typeof boardTones>;
}) {
  const geo = useBackingGeometry(
    board,
    centreX,
    tones.backingTop,
    tones.backing,
  );
  React.useEffect(() => () => geo.dispose(), [geo]);
  return (
    <mesh geometry={geo} raycast={() => null} renderOrder={-2}>
      <meshStandardMaterial
        vertexColors
        roughness={1}
        metalness={0}
        side={THREE.FrontSide}
      />
    </mesh>
  );
}

// ── The sign over the board ──────────────────────────────────

/**
 * Where you are, at whatever level is open, plus a rail of the whole document
 * with this section lit and the page you are on marked. A closed board is all
 * closed tiles, so without this there is nothing on the wall that says how
 * long the document is or how far into it you have got.
 *
 * Deliberately inert — it is a sign, not a control. Everything it describes is
 * reachable by clicking the board, and the hint line under the board says how.
 */
function WallHeader({
  board,
  ranges,
  pageCount,
  focus,
  openSection,
  openPage,
  dark,
}: {
  board: WallBoard;
  ranges: SectionPageRange[];
  pageCount: number;
  focus: number;
  openSection: number | null;
  openPage: number | null;
  dark: boolean;
}) {
  const theme = useTheme();
  const fontType = React.useContext(FontContext);
  const tones = boardTones(theme, dark);
  const { width: w, height: h } = board.header;
  const pad = h * 0.34;
  const railW = w - 2 * pad;
  const railY = -h * 0.17;
  // <Surface> floors any dimension at MIN_DIM (9 mm), so a rail written as a
  // bare fraction of the plate would come out three times its nominal height
  // and quietly stop matching the number here. Ask for what we get.
  const railH = Math.max(0.009, h * 0.075);
  const here = openSection === null ? null : ranges[openSection];

  const title =
    here === null
      ? "Outline"
      : here.label || `Section ${(openSection ?? 0) + 1}`;
  const detail =
    here === null
      ? `${ranges.length} section${ranges.length === 1 ? "" : "s"} · ${pageCount} pages`
      : openPage !== null
        ? `Page ${openPage + 1} of ${pageCount}`
        : `${here.end - here.start + 1} page${here.end - here.start === 0 ? "" : "s"}`;

  return (
    <group
      position={[board.header.centre.x, board.header.centre.y, board.header.centre.z]}
    >
      <Surface
        width={w}
        height={h}
        color={tones.plate}
        topColor={shade(tones.plate, dark ? 0.035 : 0.02)}
        rimColor={tones.rim}
        rimOpacity={0.55}
        origin={[0, 0]}
        roughness={0.95}
      />
      <Text
        font={fontType}
        anchorX="left"
        anchorY="middle"
        position={[-w / 2 + pad, h * 0.22, Z_LAYER_OVERLAY_TEXT]}
        fontSize={h * 0.3}
        color={theme.headingCol}
        maxWidth={w * 0.62}
        overflowWrap="break-word"
      >
        {title.slice(0, 64)}
      </Text>
      <Text
        font={fontType}
        anchorX="right"
        anchorY="middle"
        position={[w / 2 - pad, h * 0.22, Z_LAYER_OVERLAY_TEXT]}
        fontSize={h * 0.2}
        color={theme.mutedTextCol}
      >
        {detail}
      </Text>

      {/* The rail: the whole document end to end, one segment per section. */}
      <Surface
        width={railW}
        height={railH}
        radius={railH / 2}
        color={shade(tones.plate, dark ? -0.05 : -0.06)}
        origin={[0, railY]}
        flat
        z={Z_LAYER_ACCENT}
      />
      {ranges.map((r, i) => {
        const t0 = r.start / pageCount;
        const t1 = (r.end + 1) / pageCount;
        const segW = Math.max(0.004, (t1 - t0) * railW - 0.004);
        const tint = sectionTint(i, dark);
        return (
          <Surface
            key={`rail-${i}`}
            width={segW}
            height={railH}
            radius={railH / 2}
            color={tint.accent}
            opacity={i === openSection ? 1 : 0.45}
            origin={[-railW / 2 + ((t0 + t1) / 2) * railW, railY]}
            flat
            z={Z_LAYER_ACCENT + 0.0004}
          />
        );
      })}
      {/* …and the page being read, on it. */}
      <Surface
        width={Math.max(0.009, h * 0.055)}
        height={Math.max(0.018, h * 0.2)}
        radius={Math.max(0.0045, h * 0.0275)}
        color={theme.headingCol}
        origin={[-railW / 2 + ((focus + 0.5) / pageCount) * railW, railY]}
        flat
        z={Z_LAYER_ACCENT + 0.001}
      />
    </group>
  );
}

/** The keys the board answers to, written under it where they cost nothing. */
function WallHints({ board, centreX }: { board: WallBoard; centreX: number }) {
  const theme = useTheme();
  const fontType = React.useContext(FontContext);
  const mid = board.spine[Math.floor(board.spine.length / 2)];
  return (
    <Text
      font={fontType}
      anchorX="center"
      anchorY="middle"
      position={[
        centreX,
        (board.grid.bottom + board.bottom) / 2,
        mid.z + 0.02,
      ]}
      fontSize={0.032}
      color={theme.mutedTextCol}
      fillOpacity={0.8}
    >
      {"Esc  step back      ←  →  step through"}
    </Text>
  );
}

// ── Cells ────────────────────────────────────────────────────

/** Mount width for a cell — a print's border, held inside the grid gap. */
function matOf(width: number): number {
  return Math.max(0.008, Math.min(0.02, width * 0.035));
}

/**
 * A section tile: the closed state of a whole run of pages. Shows the section
 * name, how many pages it stands for, and a chevron for its open/closed
 * state — the tile is also the affordance for closing again, so it stays on
 * the board at the head of its expanded run.
 *
 * Its identity is the colour: the fill is the section's hue at surface
 * strength and the spine down its left edge is the same hue at accent
 * strength, both of which reappear on every page cell the tile opens into.
 */
function SectionTile({
  width,
  height,
  label,
  index,
  pages,
  maxPages,
  open,
  hovered,
  reading,
  readingAt,
  tint,
  captionCol,
}: {
  width: number;
  height: number;
  label: string;
  index: number;
  pages: number;
  /** Longest section on the board — what this one's rail is measured against. */
  maxPages: number;
  open: boolean;
  hovered: boolean;
  /** The page being read is in this section. */
  reading: boolean;
  /** …and this far through it, 0–1. */
  readingAt: number;
  tint: SectionTint;
  captionCol: string;
}) {
  const theme = useTheme();
  const fontType = React.useContext(FontContext);
  const pad = width * 0.075;
  const spineW = width * 0.028;
  const textX = pad + spineW + width * 0.06;
  const footY = -height * 0.86;
  const railW = width * 0.4;
  const railFill = railW * Math.max(0.12, Math.min(1, pages / maxPages));
  const railH = Math.max(0.009, height * 0.026);

  return (
    <>
      <Surface
        width={width}
        height={height}
        color={open ? tint.tileOpen : tint.tile}
        topColor={shade(open ? tint.tileOpen : tint.tile, 0.035)}
        rimColor={hovered || reading ? theme.accentCol : tint.accent}
        rimOpacity={hovered ? 1 : reading ? 0.8 : 0.4}
        roughness={0.9}
      />
      {/* The spine — thicker and at full strength once the section is open. */}
      <Surface
        width={open ? spineW * 1.7 : spineW}
        height={height * 0.72}
        radius={spineW}
        color={tint.accent}
        opacity={open ? 1 : 0.85}
        origin={[pad + spineW / 2, -height / 2]}
        flat
        z={Z_LAYER_ACCENT}
      />
      {/* The plate number, large and quiet in the section's own hue. */}
      <Text
        font={fontType}
        anchorX="right"
        anchorY="top"
        position={[width - pad, -height * 0.07, Z_LAYER_ACCENT + 0.0006]}
        fontSize={height * 0.26}
        color={tint.accent}
        fillOpacity={0.34}
      >
        {String(index + 1).padStart(2, "0")}
      </Text>
      <Text
        font={fontType}
        anchorX="left"
        anchorY="top"
        position={[textX, -height * 0.15, Z_LAYER_OVERLAY_TEXT]}
        fontSize={Math.min(0.085, height * 0.125)}
        color={theme.headingCol}
        maxWidth={width - textX - width * 0.26}
        overflowWrap="break-word"
      >
        {label.slice(0, 56)}
      </Text>

      {/* How long the section is, drawn to the same scale on every tile — so
          the board shows the shape of the document, not just its names. */}
      <Surface
        width={railW}
        height={railH}
        radius={railH / 2}
        color={tint.accent}
        opacity={0.22}
        origin={[textX + railW / 2, footY]}
        flat
        z={Z_LAYER_ACCENT}
      />
      <Surface
        width={railFill}
        height={railH}
        radius={railH / 2}
        color={tint.accent}
        opacity={0.9}
        origin={[textX + railFill / 2, footY]}
        flat
        z={Z_LAYER_ACCENT + 0.0004}
      />
      {reading && (
        <Surface
          width={Math.max(0.009, height * 0.03)}
          height={Math.max(0.02, height * 0.062)}
          radius={Math.max(0.0045, height * 0.015)}
          color={theme.headingCol}
          origin={[textX + railFill * readingAt, footY]}
          flat
          z={Z_LAYER_ACCENT + 0.0008}
        />
      )}

      <Text
        font={fontType}
        anchorX="right"
        anchorY="middle"
        position={[width - pad - width * 0.075, footY, Z_LAYER_OVERLAY_TEXT]}
        fontSize={Math.min(0.05, height * 0.072)}
        color={captionCol}
      >
        {`${pages} page${pages === 1 ? "" : "s"}`}
      </Text>
      <Text
        font={fontType}
        anchorX="right"
        anchorY="middle"
        position={[width - pad, footY, Z_LAYER_OVERLAY_TEXT]}
        fontSize={Math.min(0.058, height * 0.085)}
        color={tint.accent}
      >
        {open ? "▾" : "▸"}
      </Text>
    </>
  );
}

/**
 * The mount a page cell sits in: the section's hue at surface strength, so a
 * page is visibly OF its section however far it has drifted from its tile, and
 * a hairline that says where the page ends — a live preview's own backing is
 * the same colour as the board behind it, and without this the two run
 * together.
 */
function PageMount({
  width,
  height,
  mat,
  tint,
  hovered,
  reading,
}: {
  width: number;
  height: number;
  mat: number;
  tint: SectionTint;
  hovered: boolean;
  reading: boolean;
}) {
  const theme = useTheme();
  return (
    <Surface
      width={width + mat * 2}
      height={height + mat * 2}
      color={tint.mount}
      topColor={shade(tint.mount, 0.03)}
      rimColor={hovered || reading ? theme.accentCol : tint.accent}
      rimOpacity={hovered ? 1 : reading ? 0.85 : 0.35}
      origin={[width / 2, -height / 2]}
      roughness={0.9}
      z={Z_MAT}
    />
  );
}

/**
 * The page's number, on a tab over the mount's top-left corner. Every page
 * cell carries one — preview or stand-in card, thumbnail or full size — so the
 * board is numbered end to end and a page never has to be identified by
 * counting cells.
 */
function PageBadge({
  width,
  height,
  pageIndex,
  tint,
  reading,
}: {
  width: number;
  height: number;
  pageIndex: number;
  tint: SectionTint;
  reading: boolean;
}) {
  const theme = useTheme();
  const fontType = React.useContext(FontContext);
  const bh = Math.max(0.024, height * 0.13);
  const bw = Math.max(bh * 1.5, width * 0.17);
  const cx = -bw * 0.2;
  const cy = bh * 0.2;
  return (
    <>
      <Surface
        width={bw}
        height={bh}
        radius={bh / 2}
        color={reading ? theme.accentCol : tint.accent}
        origin={[cx, cy]}
        flat
        z={Z_LAYER_OVERLAY_TEXT}
      />
      <Text
        font={fontType}
        anchorX="center"
        anchorY="middle"
        position={[cx, cy, Z_LAYER_OVERLAY_TEXT + 0.0008]}
        fontSize={bh * 0.56}
        color={reading ? "#FFFFFF" : tint.onAccent}
      >
        {reading ? `${pageIndex + 1} ●` : `${pageIndex + 1}`}
      </Text>
    </>
  );
}

/**
 * The stand-in for a page too far from the open one to be worth mounting for
 * real: the page's first heading on a blank card, under a rule in its
 * section's colour. It is a CARD, not a mini page — pretending to be a page it
 * cannot afford to render would only invite a reader to try to read it.
 */
function PageCard({
  width,
  height,
  heading,
  pageIndex,
  tint,
}: {
  width: number;
  height: number;
  heading?: string;
  pageIndex: number;
  tint: SectionTint;
}) {
  const theme = useTheme();
  const fontType = React.useContext(FontContext);
  const pad = width * 0.09;
  return (
    <>
      <Surface
        width={width}
        height={height}
        color={theme.panelBg}
        topColor={shade(theme.panelBg, 0.03)}
        roughness={0.9}
        z={Z_SURFACE}
      />
      <Surface
        width={width * 0.2}
        height={Math.max(0.009, height * 0.022)}
        radius={Math.max(0.0045, height * 0.011)}
        color={tint.accent}
        origin={[pad + width * 0.1, -height * 0.135]}
        flat
        z={Z_LAYER_ACCENT}
      />
      <Text
        font={fontType}
        anchorX="left"
        anchorY="top"
        position={[pad, -height * 0.22, Z_LAYER_OVERLAY_TEXT]}
        fontSize={Math.min(0.08, height * 0.11)}
        color={theme.bodyCol}
        maxWidth={width - 2 * pad}
        overflowWrap="break-word"
      >
        {heading ? heading.slice(0, 90) : `Page ${pageIndex + 1}`}
      </Text>
    </>
  );
}

/**
 * Close affordance for the full-size page. The other cells are one big hit
 * target, but this one's content is live — a plane over it would eat every
 * link — so it gets a chip on its top edge instead.
 */
function CloseChip({ width, onClose }: { width: number; onClose: () => void }) {
  const theme = useTheme();
  const fontType = React.useContext(FontContext);
  const [hover, setHover] = React.useState(false);
  const d = 0.075;
  return (
    <group position={[width - 0.055, 0.062, 0.02]}>
      <Surface
        width={d}
        height={d}
        radius={d / 2}
        color={hover ? theme.accentCol : theme.navBg}
        rimColor={hover ? theme.accentCol : theme.panelRim}
        rimOpacity={0.8}
        origin={[0, 0]}
        flat
      />
      <mesh
        position={[0, 0, 0.004]}
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        onPointerOver={(e) => {
          e.stopPropagation();
          setHover(true);
        }}
        onPointerOut={() => setHover(false)}
      >
        <circleGeometry args={[d / 2, 24]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} />
      </mesh>
      <Text
        font={fontType}
        anchorX="center"
        anchorY="middle"
        position={[0, 0, 0.006]}
        fontSize={0.032}
        color={hover ? "#FFFFFF" : theme.headingCol}
      >
        ✕
      </Text>
    </group>
  );
}

export function WallField({
  panel,
  plan,
  pageState,
  setPage,
  primitiveMap,
  sectionRanges,
}: {
  panel: XRPrimitive;
  plan: LayoutPlan;
  pageState: PageState;
  setPage: (id: string, page: number) => void;
  primitiveMap: Map<string, XRPrimitive>;
  sectionRanges: SectionPageRange[];
}) {
  const theme = useTheme();
  const entry = plan.entries[panel.id];
  const pageCount = entry?.pagination?.pageCount ?? 1;
  const focus = pageState[panel.id] ?? 0;
  const headings = usePageHeadings(primitiveMap, plan);
  const dark = React.useMemo(() => isDarkTheme(theme), [theme]);

  // The board starts on the outline: sections only, nothing expanded.
  const [openSection, setOpenSection] = React.useState<number | null>(null);
  const [openPage, setOpenPage] = React.useState<number | null>(null);
  const [hoverKey, setHoverKey] = React.useState<string | null>(null);

  const ranges = React.useMemo(
    () =>
      sectionRanges.length > 0
        ? sectionRanges
        : [{ start: 0, end: Math.max(0, pageCount - 1), label: "" }],
    [sectionRanges, pageCount],
  );

  // Handlers read state through this ref rather than their closure: a held
  // arrow key repeats faster than React re-renders, and every repeat would
  // otherwise start from the same stale cell and land one step away however
  // long you hold it.
  const state = React.useRef({ openSection, openPage, ranges });
  state.current = { openSection, openPage, ranges };

  // A focus change the board did NOT make — a #fragment jump, or a tab
  // restoring its page — opens the section that owns that page, so the wall
  // follows the document instead of silently disagreeing with it. Keyed off a
  // real CHANGE, so arriving on the wall still shows the outline.
  const lastFocus = React.useRef(focus);
  React.useEffect(() => {
    if (lastFocus.current === focus) return;
    lastFocus.current = focus;
    const s = state.current;
    const r = s.openSection === null ? undefined : ranges[s.openSection];
    if (r && focus >= r.start && focus <= r.end) return;
    setOpenSection(wallSectionOf(focus, ranges, pageCount));
    setOpenPage((p) => (p === null ? null : focus));
  }, [focus, ranges, pageCount]);

  const openTile = React.useCallback(
    (s: number) => {
      if (s === state.current.openSection) {
        setOpenSection(null);
        setOpenPage(null);
        return;
      }
      setOpenSection(s);
      setOpenPage(null);
      setPage(panel.id, state.current.ranges[s].start);
    },
    [setPage, panel.id],
  );

  const openPageCell = React.useCallback(
    (p: number) => {
      setOpenPage((cur) => (cur === p ? null : p));
      setPage(panel.id, p);
    },
    [setPage, panel.id],
  );

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (
        t &&
        (t.isContentEditable ||
          t.tagName === "INPUT" ||
          t.tagName === "TEXTAREA" ||
          t.tagName === "SELECT")
      )
        return;
      const s = state.current;
      if (e.key === "Escape") {
        // Step back exactly one level of disclosure.
        if (s.openPage !== null) setOpenPage(null);
        else if (s.openSection !== null) setOpenSection(null);
        else return;
        e.preventDefault();
        return;
      }
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      const dir = e.key === "ArrowRight" ? 1 : -1;
      e.preventDefault();
      if (s.openPage !== null && s.openSection !== null) {
        // Walk the open section's pages.
        const r = s.ranges[s.openSection];
        const next = Math.min(Math.max(s.openPage + dir, r.start), r.end);
        if (next === s.openPage) return;
        s.openPage = next;
        setOpenPage(next);
        setPage(panel.id, next);
        return;
      }
      // Otherwise walk the outline, opening the section stepped onto.
      const at = s.openSection ?? (dir === 1 ? -1 : s.ranges.length);
      const next = Math.min(Math.max(at + dir, 0), s.ranges.length - 1);
      if (next === s.openSection) return;
      s.openSection = next;
      setOpenSection(next);
      setOpenPage(null);
      setPage(panel.id, s.ranges[next].start);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setPage, panel.id]);

  const layoutOpts = React.useMemo(
    () => ({
      sectionRanges: ranges,
      openSection,
      openPage,
      headingOf: (p: number) => headings.get(p) ?? "",
    }),
    [ranges, openSection, openPage, headings],
  );

  const cells = React.useMemo(
    () =>
      entry
        ? computeWallCells(pageCount, entry.size, { ...layoutOpts, hoverKey })
        : [],
    [entry, pageCount, layoutOpts, hoverKey],
  );

  // The backing follows the same packing, but not the hover: the wall a board
  // hangs on does not lean when you point at a card on it.
  const board = React.useMemo(
    () => (entry ? computeWallBoard(pageCount, entry.size, layoutOpts) : null),
    [entry, pageCount, layoutOpts],
  );

  if (!entry) return null;

  const maxPages = ranges.reduce((m, r) => Math.max(m, r.end - r.start + 1), 1);
  const openRange = openSection === null ? null : ranges[openSection];
  const tones = boardTones(theme, dark);
  const cellEntry = (c: WallCell): LayoutEntry => ({
    ...entry,
    pagination: undefined,
    curveRadius: 0,
    position: {
      x: entry.position.x + c.offset.x,
      y: entry.position.y + c.offset.y,
      z: entry.position.z + c.offset.z,
    },
    rotation: c.rotation,
  });

  return (
    <>
      {board && (
        <group
          position={[entry.position.x, entry.position.y, entry.position.z]}
        >
          <WallBacking
            board={board}
            centreX={entry.size.width / 2}
            tones={tones}
          />
          <WallHeader
            board={board}
            ranges={ranges}
            pageCount={pageCount}
            focus={focus}
            openSection={openSection}
            openPage={openPage}
            dark={dark}
          />
          <WallHints board={board} centreX={entry.size.width / 2} />
        </group>
      )}

      {cells.map((c) => {
        const w = entry.size.width * c.scale;
        const h = entry.size.height * c.scale;
        const ce = cellEntry(c);
        const isOpenPage = c.kind === "page" && c.open;
        const hovered = hoverKey === c.key;
        const tint = sectionTint(c.sectionIndex, dark);
        const mat = matOf(w);
        const isPage = c.kind === "page";
        const reading = isPage
          ? c.pageIndex === focus
          : focus >= ranges[c.sectionIndex].start &&
            focus <= ranges[c.sectionIndex].end;
        // The mount is the cell's real silhouette — its shadow and its hit
        // target are both sized to it, so pointing anywhere on a framed page
        // opens it and nothing has to be hit dead centre.
        const outerW = isPage ? w + mat * 2 : w;
        const outerH = isPage ? h + mat * 2 : h;
        const outerX = isPage ? -mat : 0;

        // One persistent eased group per cell (stable key), so opening a
        // level reflows the board by morphing every cell to its new slot
        // instead of cutting to a new arrangement.
        return (
          <AtPos key={c.key} entry={ce}>
            <EasedScale target={c.scale}>
              {/* A cell drops its shadow on the board a few centimetres
                  behind it. The opened page does not: it has left the board
                  for the reading plane half a metre in front, and a blob
                  hanging in the air behind it is a smudge, not a shadow. */}
              {!isOpenPage && (
                <group position={[outerX, -outerX, 0]}>
                  <CellShadow width={outerW} height={outerH} />
                </group>
              )}
              {/* Pointing at a cell steps it off the board as well as leaning
                  the board toward it — a local answer to go with the global
                  one, so you can see which cell a ray is actually on. */}
              <group position={[0, 0, hovered && !isOpenPage ? WALL_HOVER_LIFT : 0]}>
                {c.kind === "section" ? (
                  <SectionTile
                    width={w}
                    height={h}
                    label={c.label || `Section ${c.sectionIndex + 1}`}
                    index={c.sectionIndex}
                    pages={c.pages ?? 0}
                    maxPages={maxPages}
                    open={c.open}
                    hovered={hovered}
                    reading={reading}
                    readingAt={
                      (focus - ranges[c.sectionIndex].start + 0.5) /
                      Math.max(1, c.pages ?? 1)
                    }
                    tint={tint}
                    captionCol={tones.caption}
                  />
                ) : (
                  <>
                    <PageMount
                      width={w}
                      height={h}
                      mat={mat}
                      tint={tint}
                      hovered={hovered}
                      reading={reading}
                    />
                    {renderLive(c, openRange, openPage) ? (
                      <LivePageGhost
                        panel={panel}
                        plan={plan}
                        primitiveMap={primitiveMap}
                        entry={ce}
                        targetPage={c.pageIndex!}
                        scale={c.scale}
                        // The board now gives depth with a real surface,
                        // shadows and a mount, so a preview no longer has to
                        // be faded to sit back — and a crisp preview is worth
                        // more than a dim one.
                        recession={c.recession * 0.4}
                        // The flat top/bottom clip planes only hold while the
                        // cell is unpitched, which a leaning board rarely is;
                        // clipping is a safety net here, not a correctness
                        // requirement.
                        clip={c.rotation.x === 0}
                        // Only the full-size page is interactive — on a
                        // preview a ray hit means "open this page", never
                        // "follow that link".
                        stage={isOpenPage}
                        controls={false}
                        setPage={setPage}
                      />
                    ) : (
                      <PageCard
                        width={w}
                        height={h}
                        heading={headings.get(c.pageIndex!)}
                        pageIndex={c.pageIndex!}
                        tint={tint}
                      />
                    )}
                    <PageBadge
                      width={w}
                      height={h}
                      pageIndex={c.pageIndex!}
                      tint={tint}
                      reading={reading}
                    />
                  </>
                )}
              </group>
              {isOpenPage ? (
                <CloseChip width={w} onClose={() => setOpenPage(null)} />
              ) : (
                <group position={[outerX, -outerX, 0]}>
                  <PageHitPlane
                    width={outerW}
                    height={outerH}
                    onSelect={() =>
                      c.kind === "section"
                        ? openTile(c.sectionIndex)
                        : openPageCell(c.pageIndex!)
                    }
                    onOver={() => setHoverKey(c.key)}
                    onOut={() =>
                      setHoverKey((cur) => (cur === c.key ? null : cur))
                    }
                  />
                </group>
              )}
            </EasedScale>
          </AtPos>
        );
      })}
    </>
  );
}

/**
 * Preview policy: a real (mini) render of the page beats an imposter card,
 * but only pages near the one being read are worth the troika text cost —
 * a section can be dozens of pages long.
 */
function renderLive(
  c: WallCell,
  openRange: SectionPageRange | null,
  openPage: number | null,
): boolean {
  if (c.kind !== "page" || c.pageIndex === undefined) return false;
  if (c.open) return true;
  const anchor = openPage ?? openRange?.start ?? 0;
  return Math.abs(c.pageIndex - anchor) <= WALL_LIVE_PREVIEWS;
}
