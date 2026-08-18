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
  wallArcAt,
  wallSectionOf,
  WALL_BOARD_STANDOFF,
  type SectionPageRange,
  type WallBoard,
  type WallCell,
} from "../page-placements";
import {
  DoorPlate,
  OverflowMark,
  drawable,
  overflowCount,
  useDoorSlots,
  type DirSlot,
  type DirSlots,
} from "./link-doors";
import { useTraversal } from "./contexts";
import { TravelGroup, TRAVEL_LEAD_MS } from "./travel";
import type { Axis } from "../../links/memory";
import { Surface } from "../primitives/surface";
import {
  Z_LAYER_ACCENT,
  Z_LAYER_OVERLAY_TEXT,
  Z_SURFACE,
} from "../primitives/constants";
import { AtPos } from "./AtPos";
import { FontContext, type PageState } from "./contexts";
import {
  CellShadow,
  EasedScale,
  LivePageGhost,
  PageHitPlane,
  usePageHeadings,
} from "./page-cells";
import {
  isDarkTheme,
  sectionTint,
  shade,
  type SectionTint,
} from "./section-tint";

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
// A section's hue, and the sRGB mixing helpers, are shared with the deck's
// table (scene/section-tint.ts) so the same section is the same colour in
// both views — a board and a table that disagreed about which section was
// blue would each be undoing the other's spatial memory.

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
  viewMode,
}: {
  panel: XRPrimitive;
  plan: LayoutPlan;
  pageState: PageState;
  setPage: (id: string, page: number) => void;
  primitiveMap: Map<string, XRPrimitive>;
  sectionRanges: SectionPageRange[];
  /** Selects this view's window budget — see links/memory.ts WINDOWS. */
  viewMode?: string;
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

  // ── The dice ──
  //
  // The strips only appear once the reader has OPENED a page, and then they
  // carry every link that page has — not a window onto them.
  //
  // The board has three levels: an outline of section tiles, a section's pages
  // as previews, and one page at full size. Only the last of those is a reader
  // reading, and only then is "the links of the page you are on" a question
  // with an answer — on the outline `focus` is just whichever page a section
  // happens to start at, so its doors would belong to a page nobody chose.
  //
  // Once it IS one page, the ration a window exists to impose has nothing to
  // ration: the census puts outbound links at a median of 0 and a p90 of 7 per
  // rendered page. So the window is fitted to the page instead and every
  // connected link gets a strip. (Anand, 2026-08-16.)
  const { slots, take } = useDoorSlots(openPage ?? focus, viewMode, true);
  const showStrips = openPage !== null;
  const [turning, setTurning] = React.useState<Axis | null>(null);
  const turnTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  React.useEffect(
    () => () => {
      if (turnTimer.current) clearTimeout(turnTimer.current);
    },
    [],
  );

  // What the board re-normalises against: the document it is showing. A jump
  // that lands on a document already in memory changes `nav.at` without
  // changing the URL's identity, so both are folded in.
  const traversal = useTraversal();
  const traversalNav = traversal?.nav ?? null;
  const resetKey = `${traversalNav?.at ?? 0}|${traversalNav ? traversalNav.history[traversalNav.at]?.url : panel.id}`;

  // Select a strip: start the swing, THEN ask for the document. The order
  // matters — a fetch that resolved instantly would otherwise replace the
  // scene before the reader saw which way they went, and the direction is the
  // entire channel this design navigates by.
  //
  // The document stays on screen for the whole fetch (see `Tab.pending`), so
  // what the reader watches is their own page turning away, which is the
  // truthful animation of what is happening.
  const takeStrip = React.useCallback(
    (slot: DirSlot) => {
      if (turnTimer.current) clearTimeout(turnTimer.current);
      setTurning(slot.axis);
      turnTimer.current = setTimeout(() => {
        turnTimer.current = null;
        take(slot);
      }, TRAVEL_LEAD_MS);
    },
    [take],
  );

  // The turn ends when the move does — on arrival, or on a fetch that failed.
  // Without this the board would stay face-down against whichever document it
  // is showing: `resetKey` snaps the GROUP back but `turning` would still be
  // pointing it away.
  const arrived = traversal?.pending == null;
  React.useEffect(() => {
    if (arrived) setTurning(null);
  }, [arrived, resetKey]);

  if (!entry) return null;

  // The open page's cell, in the board group's own frame. `cells` are already
  // laid out for the current disclosure, so this follows the reflow for free.
  const openCell = cells.find((c) => c.kind === "page" && c.open) ?? null;
  const stripFrame: StripFrame | null = openCell
    ? {
        left: openCell.offset.x,
        right: openCell.offset.x + entry.size.width * openCell.scale,
        top: openCell.offset.y,
        bottom: openCell.offset.y - entry.size.height * openCell.scale,
      }
    : null;

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

  // The board's own centre, in the world space the children are placed in:
  // the panel anchor plus half its extent, pushed back onto the board's plane.
  const pivot: [number, number, number] = [
    entry.position.x + entry.size.width / 2,
    entry.position.y - entry.size.height / 2,
    entry.position.z +
      wallArcAt(entry.size.width / 2, entry.size.width).z -
      WALL_BOARD_STANDOFF,
  ];

  return (
    <TravelGroup mode="turn" axis={turning} pivot={pivot} resetKey={resetKey}>
      {board && (
        <group
          position={[entry.position.x, entry.position.y, entry.position.z]}
        >
          <WallBacking
            board={board}
            centreX={entry.size.width / 2}
            tones={tones}
          />
          {/* Links, on the edges the legend puts them on: parent above,
              external below, siblings to the sides — hung off the OPEN PAGE's
              own cell, which is the page whose links they are. Only while a
              page is open; see the note at `showStrips`. */}
          {showStrips && stripFrame && (
            <WallLinkStrips
              frame={stripFrame}
              panelWidth={entry.size.width}
              slots={slots}
              onTake={takeStrip}
            />
          )}
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
                  <CellShadow width={outerW} height={outerH} z={Z_SHADOW} />
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
    </TravelGroup>
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

// ─────────────────────────────────────────────────────────────
// The dice: link strips on the board's edges
// ─────────────────────────────────────────────────────────────

/**
 * The board's four edges, carrying the page's links
 * (docs/directional-links.md, Phase 5).
 *
 *   top edge     parent / top-level
 *   bottom edge  external
 *   left, right  siblings
 *
 * The wall is first among the four views deliberately: it is the flattest
 * geometry of the set, so it tests the IDEA — relation read as direction —
 * rather than a view's own quirks.
 *
 * Strips sit OUTSIDE the grid, in the board's margin, and stop short of the
 * header plate. They are read by turning the head, which is the whole channel:
 * a reader who wants the level above looks up.
 */
/**
 * Strip size, metres.
 *
 * Bigger than the first build's, which the reader could not read: a 0.052 m
 * plate at 0.2 m wide gave the label about nine characters at a 1.5 m viewing
 * distance, so every door on the wall said "Measuremen…" or "en.wikipedia…"
 * and the reader had to guess. A door whose name is truncated to nothing is a
 * door with no name.
 *
 * These are sized off the same viewing distance the wall itself is authored
 * to: 0.076 m of height is about 2.9° of arc, comfortably over the 0.29°
 * legibility floor for the body size inside it, and 0.42 m of width takes a
 * two-to-three word destination name whole.
 */
const STRIP_H = 0.076;
const STRIP_GAP = 0.016;
/** Lateral strips stack down the side edges; this is their long axis. */
const STRIP_W_LATERAL = 0.42;
/**
 * How far a strip stands off the CELL plane — the plane the pages hang in,
 * `WALL_BOARD_STANDOFF` in front of the board's surface.
 *
 * The plane matters more than the number. Drawn on the board's own surface,
 * the strips sat BEHIND the open page and its mount and were occluded by the
 * very thing whose links they are: the wall looked like it had no links at
 * all. They belong in the page's plane, standing slightly proud of it.
 */
const STRIP_LIFT = 0.02;

/** The rectangle the strips hang off: the open page's own cell. */
export interface StripFrame {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

function WallLinkStrips({
  frame,
  panelWidth,
  slots,
  onTake,
}: {
  frame: StripFrame;
  panelWidth: number;
  slots: DirSlots;
  onTake: (slot: DirSlot) => void;
}) {
  // ── The strips hang off the OPEN PAGE, not off the board ──
  //
  // The board is the whole document's outline and grows to four metres wide
  // with a long section open; its literal edges are then a metre either side
  // of the reader and its top and bottom are past the top and bottom of what
  // they can see without moving. Doors placed there are doors nobody finds.
  //
  // The page is the right frame for two reasons. It is a known, modest size —
  // one reading panel — so the strips are always within a glance of the thing
  // they belong to. And they ARE the page's links: "a corridor belongs to the
  // page the reader is on" is the model, so hanging them off the page rather
  // than off the building it sits in is what the model already said.
  const centreX = (frame.left + frame.right) / 2;
  const centreY = (frame.top + frame.bottom) / 2;
  const gridW = Math.max(0.2, frame.right - frame.left);

  /**
   * Rows and columns both fill from the MIDDLE OUT (Anand, 2026-08-16).
   *
   * Filling from an edge put the nearest door — the way back, the first
   * sibling — at whichever end of the board the packing happened to start,
   * which changes as the board reflows. Fanning from the centre puts slot 0
   * where the reader is already looking and grows the run outward, so the
   * order is stable and reads as a rank rather than a queue.
   *
   * Offsets go 0, +1, −1, +2, −2 …, which is the sequence the reader's eye
   * follows anyway.
   */
  const centreOut = (n: number): number[] =>
    Array.from({ length: n }, (_, i) =>
      i === 0 ? 0 : (i % 2 === 1 ? 1 : -1) * Math.ceil(i / 2),
    );

  /** The drawable slots plus the overflow mark, as one list to lay out. */
  const runOf = (axis: Axis): (DirSlot | null)[] => {
    const drawn = drawable(slots[axis]);
    const extra = overflowCount(slots[axis]);
    return extra > 0 ? [...drawn, null] : drawn;
  };

  const plate = (
    s: DirSlot | null,
    axis: Axis,
    w: number,
    x: number,
    y: number,
  ): React.ReactNode => {
    const arc = wallArcAt(x, panelWidth);
    return (
      <group
        key={s ? s.key : `${axis}-overflow`}
        position={[x, y, arc.z + STRIP_LIFT]}
        rotation={[0, arc.yaw, 0]}
      >
        {s ? (
          <DoorPlate
            slot={s}
            width={w}
            height={STRIP_H}
            recession={s.distance - 1}
            onSelect={() => onTake(s)}
          />
        ) : (
          <OverflowMark count={overflowCount(slots[axis])} width={w} height={STRIP_H} />
        )}
      </group>
    );
  };

  // Parent and external rows run ALONG the edge, fanning from the centre. The
  // plate width is fixed rather than divided into the span: dividing made a
  // two-door row into two half-metre banners and a six-door row into slivers,
  // so the same link was a different size on every page.
  const horizontal = (axis: "up" | "down", y: number): React.ReactNode => {
    const run = runOf(axis);
    if (run.length === 0) return null;
    const w = Math.min(STRIP_W_LATERAL, (gridW - STRIP_GAP * 2) / Math.max(1, Math.min(run.length, 5)));
    const pitch = w + STRIP_GAP;
    return centreOut(run.length).map((k, i) =>
      plate(run[i], axis, w, centreX + k * pitch, y),
    );
  };

  // Lateral strips stack DOWN the side edges, fanning from the board's own
  // vertical centre for the same reason the rows fan from its horizontal one.
  const vertical = (axis: "left" | "right"): React.ReactNode => {
    const run = runOf(axis);
    if (run.length === 0) return null;
    const x =
      axis === "left"
        ? frame.left - STRIP_GAP - STRIP_W_LATERAL / 2
        : frame.right + STRIP_GAP + STRIP_W_LATERAL / 2;
    const pitch = STRIP_H + STRIP_GAP;
    return centreOut(run.length).map((k, i) =>
      plate(run[i], axis, STRIP_W_LATERAL, x, centreY - k * pitch),
    );
  };

  // Above the page's top edge and below its bottom one — up is up.
  const upY = frame.top + STRIP_GAP + STRIP_H / 2;
  const downY = frame.bottom - STRIP_GAP - STRIP_H / 2;

  return (
    <>
      {horizontal("up", upY)}
      {horizontal("down", downY)}
      {vertical("left")}
      {vertical("right")}
    </>
  );
}

