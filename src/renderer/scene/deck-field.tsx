/**
 * scene/deck-field.tsx
 *
 * The deck view: a CARD TABLE the reader deals and re-deals by hand.
 *
 *   • The document arrives dealt into lanes — one per top-level section — as
 *     overlapping cards, each showing its number and heading on the strip the
 *     card in front of it leaves uncovered. The last card of a lane is whole.
 *   • Pointing at a card lifts it off the table and parts the cards in front
 *     of it, so a buried page can be looked at without disturbing the pile.
 *   • DRAGGING a card moves it: to another slot in its lane, to another lane,
 *     or to the SHELF at the end — an empty lane that stands for nothing but
 *     what the reader wants near to hand. The table keeps that arrangement,
 *     and the arrow keys then read the document in the reader's order rather
 *     than the author's. This is the whole point of the view.
 *   • Clicking a card focuses it and it reads at full size on the STAGE —
 *     the panel's own slot, lifted just clear of the table. Nothing flies:
 *     the card stays exactly where it was put, marked as the one being read.
 *
 * The geometry (scene/page-placements.ts: `computeDeckLayout`) is done in
 * table coordinates, and everything below hangs in ONE pitched group at the
 * table's origin. That is what makes the drag tractable: a pointer ray is
 * intersected with the group's own plane and `worldToLocal`d, so the pitch is
 * inverted by three rather than by hand.
 *
 * ── How it reads ──
 *
 * The same three principles as the wall board, applied to a horizontal-ish
 * surface: a real SURFACE (the table, with a lip along the near edge and a
 * sunken well per lane, so an EMPTY lane is still visibly a place a card can
 * go); EDGES on every card, with a shadow that grows as the card rises off
 * the table; and section COLOUR, shared with the wall (scene/section-tint.ts)
 * so a section is the same colour whichever view you are in.
 */
import React from "react";
import { Text } from "@react-three/drei";
import { useFrame, useThree, type ThreeEvent } from "@react-three/fiber";
import * as THREE from "three";

import type { XRPrimitive } from "../../mapper/types";
import type { LayoutEntry, LayoutPlan } from "../../layout/types";
import { useTheme } from "../theme";
import {
  DoorPlate,
  OverflowMark,
  drawable,
  overflowCount,
  useDoorSlots,
  type DirSlot,
  type DirSlots,
} from "./link-doors";
import { useTraversal, usePageLinks } from "./contexts";
import { useNeighbourhood, type Neighbourhood, type WingDoc } from "./use-neighbourhood";
import { WingCard } from "./neighbour-walls";
import { TravelGroup, TRAVEL_LEAD_MS } from "./travel";
import type { Axis } from "../../links/memory";
import {
  computeDeckLayout,
  deckApplyDrop,
  deckCardKey,
  deckDefaultLanes,
  deckDropTarget,
  deckIsRearranged,
  deckMoveLane,
  deckPlateSlots,
  deckPoint,
  deckReadingOrder,
  deckSameDrop,
  DECK_SHELF_ID,
  type DeckCardCell,
  type DeckDrop,
  type DeckLane,
  type DeckLaneCell,
  type DeckLayout,
  type DeckNewLaneZone,
  type SectionPageRange,
} from "../page-placements";
import { Surface } from "../primitives/surface";
import {
  Z_LAYER_ACCENT,
  Z_LAYER_OVERLAY_TEXT,
  Z_SURFACE,
  HIT_TARGET_MATERIAL,
} from "../primitives/constants";
import { AtPos } from "./AtPos";
import { FontContext, type PageState } from "./contexts";
import { CellShadow, LivePageGhost, usePageHeadings } from "./page-cells";
import {
  isDarkTheme,
  neutralTint,
  sectionTint,
  shade,
  type SectionTint,
} from "./section-tint";

/** How far a card being carried floats above the table. */
const DECK_FLY_PROUD = 0.11;
/** Below this much travel a press was a click, not a drag. */
const DECK_DRAG_THRESHOLD = 0.018;
/** Live (real, miniature) page renders on the table at once. */
const DECK_LIVE_CARDS = 6;

// Depth ladder within the pitched table group, in metres proud of it. The
// table's own slab is the floor of it; everything else stacks forward.
const Z_TABLE = -0.008;
const Z_WELL = -0.004;
/**
 * A card's shadow lies ON the table, however far the card has risen off it —
 * so it is pinned in the TABLE's depth, in front of the (opaque) well the
 * card lies in, and each card subtracts its own `proud` to get back down here.
 */
const Z_CARD_SHADOW = -0.002;

// ── The table ────────────────────────────────────────────────

/** Neutrals for the table itself, derived from the theme. */
function tableTones(panelBg: string, dark: boolean) {
  return {
    top: shade(panelBg, dark ? -0.05 : -0.14),
    bottom: shade(panelBg, dark ? -0.09 : -0.2),
    well: shade(panelBg, dark ? -0.1 : -0.24),
    rail: shade(panelBg, dark ? 0.02 : -0.06),
  };
}

/**
 * The surface everything is dealt onto: one slab, lightest at the far edge
 * (which is nearest the light and furthest from the reader) so the table
 * reads as a receding plane rather than a flat rectangle, plus a lip along
 * the near edge that carries what the view has to say for itself.
 */
function DeckSurface({
  layout,
  tones,
}: {
  layout: DeckLayout;
  tones: ReturnType<typeof tableTones>;
}) {
  const { frame } = layout;
  return (
    <>
      <Surface
        width={frame.width}
        height={frame.depth}
        color={tones.bottom}
        topColor={tones.top}
        rimColor={shade(tones.bottom, -0.04)}
        rimOpacity={0.6}
        origin={[0, frame.depth / 2]}
        roughness={0.95}
        z={Z_TABLE}
      />
      {/* The lip. A table with an edge is a table; without one the cards are
          floating on a rectangle of colour. */}
      <Surface
        width={frame.width}
        height={layout.rail.height}
        color={tones.rail}
        topColor={shade(tones.rail, 0.02)}
        origin={[0, layout.rail.height / 2]}
        roughness={0.9}
        z={Z_TABLE + 0.001}
      />
    </>
  );
}

/** What the table says about itself, on the lip, plus the way back. */
function DeckRail({
  layout,
  rearranged,
  onReset,
}: {
  layout: DeckLayout;
  rearranged: boolean;
  onReset: () => void;
}) {
  const theme = useTheme();
  const fontType = React.useContext(FontContext);
  const [hover, setHover] = React.useState(false);
  const y = layout.rail.height / 2;
  const chipW = 0.15;
  const chipH = 0.032;
  const chipX = layout.frame.width / 2 - chipW / 2 - 0.03;
  return (
    <group position={[0, 0, Z_TABLE + 0.003]}>
      <Text
        font={fontType}
        anchorX="left"
        anchorY="middle"
        position={[-layout.frame.width / 2 + 0.03, y, 0.001]}
        fontSize={0.018}
        color={theme.mutedTextCol}
        fillOpacity={0.9}
      >
        {
          "drag a card to re-arrange, or past the ends to start a new section · click to read · ← → step"
        }
      </Text>
      {rearranged && (
        <group position={[chipX, y, 0]}>
          <Surface
            width={chipW}
            height={chipH}
            radius={chipH / 2}
            color={hover ? theme.accentCol : theme.navBg}
            rimColor={hover ? theme.accentCol : theme.panelRim}
            rimOpacity={0.8}
            origin={[0, 0]}
            flat
          />
          <Text
            font={fontType}
            anchorX="center"
            anchorY="middle"
            position={[0, 0, 0.002]}
            fontSize={0.016}
            color={hover ? "#FFFFFF" : theme.headingCol}
          >
            ↺ reset order
          </Text>
          <mesh
            position={[0, 0, 0.004]}
            onClick={(e) => {
              e.stopPropagation();
              onReset();
            }}
            onPointerOver={(e) => {
              e.stopPropagation();
              setHover(true);
            }}
            onPointerOut={() => setHover(false)}
          >
            <planeGeometry args={[chipW, chipH]} />
            <primitive
              object={HIT_TARGET_MATERIAL}
              attach="material"
              dispose={null}
            />
          </mesh>
        </group>
      )}
    </group>
  );
}

// ── Lanes ────────────────────────────────────────────────────

/** A small square chip — the lane's ‹ › reorder controls and its window step. */
function Chip({
  x,
  y,
  width,
  height,
  label,
  color,
  ink,
  fontSize,
  onSelect,
}: {
  x: number;
  y: number;
  width: number;
  height: number;
  label: string;
  color: string;
  ink: string;
  fontSize: number;
  onSelect: () => void;
}) {
  const theme = useTheme();
  const fontType = React.useContext(FontContext);
  const [hover, setHover] = React.useState(false);
  return (
    <group position={[x, y, 0]}>
      <Surface
        width={width}
        height={height}
        radius={Math.min(width, height) / 2}
        color={hover ? theme.accentCol : color}
        origin={[0, 0]}
        flat
        z={Z_LAYER_ACCENT}
      />
      <Text
        font={fontType}
        anchorX="center"
        anchorY="middle"
        position={[0, 0, Z_LAYER_OVERLAY_TEXT]}
        fontSize={fontSize}
        color={hover ? "#FFFFFF" : ink}
      >
        {label}
      </Text>
      <mesh
        position={[0, 0, Z_LAYER_OVERLAY_TEXT + 0.002]}
        onClick={(e) => {
          e.stopPropagation();
          onSelect();
        }}
        onPointerOver={(e) => {
          e.stopPropagation();
          setHover(true);
        }}
        onPointerOut={() => setHover(false)}
      >
        <planeGeometry args={[width * 1.2, height * 1.2]} />
        <primitive
          object={HIT_TARGET_MATERIAL}
          attach="material"
          dispose={null}
        />
      </mesh>
    </group>
  );
}

/**
 * A lane: the sunken well its cards lie in, and the plate above it naming the
 * section. The well is drawn whether or not the lane holds anything — an
 * empty lane has to look like somewhere a card can be PUT, which is the whole
 * of the shelf's job.
 */
function Lane({
  cell,
  tint,
  wellColor,
  isShelf,
  reading,
  hidden,
  canLeft,
  canRight,
  onMoveLane,
  onStepWindow,
}: {
  cell: DeckLaneCell;
  tint: SectionTint;
  wellColor: string;
  isShelf: boolean;
  /** The page being read is in this lane. */
  reading: boolean;
  /** Pages the table has no room for below the window. */
  hidden: number;
  canLeft: boolean;
  canRight: boolean;
  onMoveLane: (dir: -1 | 1) => void;
  onStepWindow: () => void;
}) {
  const theme = useTheme();
  const fontType = React.useContext(FontContext);
  const w = cell.width;
  const slots = deckPlateSlots(w, cell.headerHeight);

  return (
    <group position={[cell.u, 0, 0]}>
      {/* The well. Recessed, in the lane's own hue, and lit at its rim while
          a dragged card is over it — the drop target has to answer. */}
      <Surface
        width={w}
        height={cell.wellDepth}
        color={cell.dropActive ? shade(wellColor, 0.06) : wellColor}
        rimColor={cell.dropActive ? theme.accentCol : tint.accent}
        rimOpacity={cell.dropActive ? 1 : isShelf ? 0.35 : 0.28}
        origin={[w / 2, cell.wellV + cell.wellDepth / 2]}
        roughness={0.95}
        z={Z_WELL}
      />
      {/* An empty lane says what it is for, rather than being a blank slot. */}
      {cell.total === 0 && (
        <Text
          font={fontType}
          anchorX="center"
          anchorY="middle"
          position={[
            w / 2,
            cell.wellV + cell.wellDepth / 2,
            Z_WELL + 0.002,
          ]}
          fontSize={0.016}
          color={theme.mutedTextCol}
          fillOpacity={0.75}
          maxWidth={w * 0.8}
          textAlign="center"
        >
          drag pages here
        </Text>
      )}

      {/* The plate: which section this is, how long it is, and the two chips
          that move the whole lane sideways. */}
      <Surface
        width={w}
        height={cell.headerHeight}
        color={reading ? tint.tileOpen : tint.tile}
        topColor={shade(reading ? tint.tileOpen : tint.tile, 0.03)}
        rimColor={reading ? theme.accentCol : tint.accent}
        rimOpacity={reading ? 0.9 : 0.4}
        origin={[w / 2, cell.headerV + cell.headerHeight / 2]}
        roughness={0.9}
        z={Z_WELL}
      />
      <group position={[0, cell.headerV + cell.headerHeight, Z_LAYER_ACCENT]}>
        {/* Spine, in the section's hue: the same mark its cards carry. */}
        <Surface
          width={slots.spine.width}
          height={slots.spine.height}
          radius={slots.spine.width}
          color={tint.accent}
          origin={[slots.spine.x, slots.spine.y]}
          flat
        />
        <Text
          font={fontType}
          anchorX="left"
          anchorY="top"
          position={[
            slots.label.x - slots.label.width / 2,
            slots.label.y + slots.label.height / 2,
            0.0006,
          ]}
          fontSize={0.019}
          color={theme.headingCol}
          maxWidth={slots.label.width}
          // A long section name wraps, and the plate is a line and a bit
          // tall — clip it there rather than letting it run over the chips.
          clipRect={[0, -slots.label.height, slots.label.width, 0.01]}
          overflowWrap="break-word"
        >
          {cell.label.slice(0, 42)}
        </Text>
        <Text
          font={fontType}
          anchorX="left"
          anchorY="middle"
          position={[slots.count.x - slots.count.width / 2, slots.count.y, 0.0006]}
          fontSize={0.0135}
          color={theme.mutedTextCol}
          maxWidth={slots.count.width}
          clipRect={[
            0,
            -slots.count.height / 2,
            slots.count.width,
            slots.count.height / 2,
          ]}
        >
          {cell.total === 0
            ? "empty"
            : `${cell.total} page${cell.total === 1 ? "" : "s"}${
                cell.made ? " · yours" : ""
              }`}
        </Text>
        {/* Lanes deeper than the table is long show a window of themselves,
            and this steps it on and wraps back to the top. It lives on the
            PLATE, not at the foot of the well where it belongs logically:
            down there the lane's own front card lies over it. */}
        {(hidden > 0 || cell.windowStart > 0) && (
          <Chip
            x={slots.window.x}
            y={slots.window.y}
            width={slots.window.width}
            height={slots.window.height}
            label={hidden > 0 ? `▾ ${hidden}` : "↺"}
            color={tint.accent}
            ink={tint.onAccent}
            fontSize={0.014}
            onSelect={onStepWindow}
          />
        )}
        {canLeft && (
          <Chip
            x={slots.left.x}
            y={slots.left.y}
            width={slots.left.width}
            height={slots.left.height}
            label="‹"
            color={tint.accent}
            ink={tint.onAccent}
            fontSize={0.018}
            onSelect={() => onMoveLane(-1)}
          />
        )}
        {canRight && (
          <Chip
            x={slots.right.x}
            y={slots.right.y}
            width={slots.right.width}
            height={slots.right.height}
            label="›"
            color={tint.accent}
            ink={tint.onAccent}
            fontSize={0.018}
            onSelect={() => onMoveLane(1)}
          />
        )}
      </group>
    </group>
  );
}

/**
 * The place a carried card can start a section of its own: an outline of a
 * well just past each end of the row, drawn only while something is in the
 * air. Deliberately an OUTLINE — it is not furniture, it is an offer, and it
 * has to be legible as somewhere the table is not yet.
 */
function NewLaneZone({ zone }: { zone: DeckNewLaneZone }) {
  const theme = useTheme();
  const fontType = React.useContext(FontContext);
  const cy = zone.wellV + zone.wellDepth / 2;
  return (
    <group position={[zone.u, 0, 0]}>
      <Surface
        width={zone.width}
        height={zone.wellDepth}
        color={theme.accentCol}
        opacity={zone.active ? 0.22 : 0.08}
        rimColor={theme.accentCol}
        rimOpacity={zone.active ? 1 : 0.4}
        origin={[zone.width / 2, cy]}
        flat
        z={Z_WELL}
      />
      <Text
        font={fontType}
        anchorX="center"
        anchorY="middle"
        position={[zone.width / 2, cy, Z_WELL + 0.003]}
        fontSize={0.018}
        color={zone.active ? theme.headingCol : theme.mutedTextCol}
        fillOpacity={zone.active ? 1 : 0.8}
        maxWidth={zone.width * 0.8}
        textAlign="center"
      >
        {zone.active ? "＋ new section" : "＋ new"}
      </Text>
    </group>
  );
}

// ── Cards ────────────────────────────────────────────────────

/**
 * The face of a card. Its top strip is an accent band carrying the page
 * number and heading, because that strip is ALL that shows of a card with
 * another one in front of it — everything below the band is a bonus the pile
 * may well be covering.
 */
function CardFace({
  width,
  height,
  band,
  pageIndex,
  heading,
  tint,
  tone,
  reading,
  hovered,
  children,
}: {
  width: number;
  height: number;
  band: number;
  pageIndex: number;
  heading?: string;
  tint: SectionTint;
  tone: string;
  reading: boolean;
  hovered: boolean;
  children?: React.ReactNode;
}) {
  const theme = useTheme();
  const fontType = React.useContext(FontContext);
  const numW = width * 0.15;
  return (
    <>
      <Surface
        width={width}
        height={height}
        color={tone}
        topColor={shade(tone, 0.025)}
        rimColor={reading || hovered ? theme.accentCol : tint.accent}
        rimOpacity={reading ? 1 : hovered ? 0.9 : 0.45}
        roughness={0.9}
        // Opaque, always. A stack of overlapping translucent cards is a
        // sorting problem, and the recession is already carried by the
        // sketch, the miniature and the rim.
        z={Z_SURFACE}
      />
      {children}
      {/* The band, over whatever the body drew. */}
      <Surface
        width={width}
        height={band}
        radius={band * 0.28}
        color={reading ? theme.accentCol : tint.accent}
        origin={[width / 2, -band / 2]}
        flat
        z={Z_LAYER_ACCENT}
      />
      <Text
        font={fontType}
        anchorX="left"
        anchorY="middle"
        position={[width * 0.035, -band / 2, Z_LAYER_OVERLAY_TEXT]}
        fontSize={band * 0.5}
        color={reading ? "#FFFFFF" : tint.onAccent}
      >
        {reading ? `● ${pageIndex + 1}` : `${pageIndex + 1}`}
      </Text>
      <Text
        font={fontType}
        anchorX="left"
        anchorY="middle"
        position={[numW, -band / 2, Z_LAYER_OVERLAY_TEXT]}
        fontSize={band * 0.44}
        color={reading ? "#FFFFFF" : tint.onAccent}
        fillOpacity={0.92}
        maxWidth={width - numW - width * 0.04}
        clipRect={[0, -band, width - numW - width * 0.04, band]}
      >
        {(heading ?? `Page ${pageIndex + 1}`).slice(0, 46)}
      </Text>
    </>
  );
}

/**
 * The body of a card too far down a pile to be worth mounting for real: the
 * shape of a page rather than its text. Deliberately abstract — a card
 * pretending to be readable at this size invites a reader to try.
 */
function CardSketch({
  width,
  height,
  band,
  color,
}: {
  width: number;
  height: number;
  band: number;
  color: string;
}) {
  const pad = width * 0.09;
  const top = -band - height * 0.09;
  const barH = Math.max(0.003, height * 0.028);
  const gap = barH * 2.1;
  const rows = Math.max(0, Math.floor((height - band - height * 0.2) / gap));
  return (
    <>
      {Array.from({ length: Math.min(rows, 7) }, (_, i) => (
        <Surface
          key={`bar-${i}`}
          width={(width - 2 * pad) * (i === 0 ? 0.62 : i % 3 === 2 ? 0.74 : 1)}
          height={barH}
          radius={barH / 2}
          color={color}
          opacity={i === 0 ? 0.55 : 0.3}
          origin={[
            pad + ((width - 2 * pad) * (i === 0 ? 0.62 : i % 3 === 2 ? 0.74 : 1)) / 2,
            top - i * gap - (i === 0 ? 0 : barH),
          ]}
          flat
          z={Z_LAYER_ACCENT}
        />
      ))}
    </>
  );
}

/**
 * A card's hit target. Unlike the shared <PageHitPlane> this sits all but ON
 * the card: a plane held centimetres in front would be picked ahead of the
 * cards stacked over it, so pointing at the top of a pile would select the
 * card at the bottom.
 */
function CardTarget({
  width,
  height,
  onOver,
  onOut,
  onDown,
}: {
  width: number;
  height: number;
  onOver: () => void;
  onOut: () => void;
  onDown: (e: ThreeEvent<PointerEvent>) => void;
}) {
  return (
    <mesh
      position={[width / 2, -height / 2, 0.0015]}
      onPointerDown={onDown}
      onPointerOver={(e) => {
        e.stopPropagation();
        onOver();
      }}
      onPointerOut={() => onOut()}
    >
      <planeGeometry args={[width, height]} />
      <primitive
        object={HIT_TARGET_MATERIAL}
        attach="material"
        dispose={null}
      />
    </mesh>
  );
}

// ── The field ────────────────────────────────────────────────

export function DeckField({
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
  const fontType = React.useContext(FontContext);
  const entry = plan.entries[panel.id];
  const pageCount = entry?.pagination?.pageCount ?? 1;
  const focus = pageState[panel.id] ?? 0;
  const headings = usePageHeadings(primitiveMap, plan);
  const dark = React.useMemo(() => isDarkTheme(theme), [theme]);
  const controls = useThree((s) => s.controls) as
    | { enabled?: boolean }
    | null;

  // ── The reader's arrangement ──
  const [lanes, setLanes] = React.useState<DeckLane[]>(() =>
    deckDefaultLanes(sectionRanges, pageCount),
  );
  // A new document is a new deal; the reader's arrangement belongs to the one
  // they made it on.
  const dealt = React.useRef<string>("");
  React.useEffect(() => {
    const key = `${panel.id}:${pageCount}:${sectionRanges
      .map((r) => `${r.start}-${r.label}`)
      .join("|")}`;
    if (dealt.current === key) return;
    dealt.current = key;
    setLanes(deckDefaultLanes(sectionRanges, pageCount));
    setWindows({});
  }, [panel.id, pageCount, sectionRanges]);

  // ── Connected tables ──
  //
  // The deck always has a page on the stage, so unlike the wall there is no
  // "nothing is open" state to gate on: `focus` is always a page somebody is
  // reading. Its paths are fitted to it for the same reason the wall's strips
  // are — one rendered page's links are few enough to show whole.
  const { slots: linkSlots, take: takeLink } = useDoorSlots(focus, viewMode, true);
  const traversal = useTraversal();
  const traversalNav = traversal?.nav ?? null;
  const slideResetKey = `${traversalNav?.at ?? 0}|${
    traversalNav ? traversalNav.history[traversalNav.at]?.url : panel.id
  }`;
  const [sliding, setSliding] = React.useState<Axis | null>(null);
  const slideTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  React.useEffect(
    () => () => {
      if (slideTimer.current) clearTimeout(slideTimer.current);
    },
    [],
  );
  // ── The neighbourhood ──
  //
  // The deck has no "open a section" gesture the way the wall does; what it
  // has is a card on the stage, and that card belongs to a section. So the
  // scope is THAT section — stable while the reader reads it, and re-aimed
  // when they move to another part of the document, which is the same rule
  // the wall follows from the other end.
  const pageLinks = usePageLinks();
  const focusSection = React.useMemo(() => {
    const i = sectionRanges.findIndex((r) => focus >= r.start && focus <= r.end);
    return i === -1 ? null : i;
  }, [sectionRanges, focus]);
  const scopedLinks = React.useMemo(() => {
    const all = pageLinks?.links ?? [];
    const r = focusSection === null ? null : sectionRanges[focusSection];
    if (!r) return all;
    return all.filter((l) => l.pageIndex >= r.start && l.pageIndex <= r.end);
  }, [pageLinks, focusSection, sectionRanges]);
  const hood = useNeighbourhood({
    url: traversalNav ? (traversalNav.history[traversalNav.at]?.url ?? null) : null,
    links: scopedLinks,
    scopeKey: focusSection === null ? "doc" : `s${focusSection}`,
    nav: traversalNav,
    viewMode: viewMode ?? "deck",
    lanesFor: () => 2,
    enabled: true,
  });

  const takeWing = React.useCallback(
    (wing: WingDoc) => {
      if (!traversal) return;
      if (slideTimer.current) clearTimeout(slideTimer.current);
      setSliding(wing.axis);
      slideTimer.current = setTimeout(() => {
        slideTimer.current = null;
        if (wing.historyIndex !== undefined) traversal.jump(wing.historyIndex);
        else traversal.traverse(wing.url, wing.axis, wing.label);
      }, TRAVEL_LEAD_MS);
    },
    [traversal],
  );

  const takePath = React.useCallback(
    (slot: DirSlot) => {
      if (slideTimer.current) clearTimeout(slideTimer.current);
      setSliding(slot.axis);
      slideTimer.current = setTimeout(() => {
        slideTimer.current = null;
        takeLink(slot);
      }, TRAVEL_LEAD_MS);
    },
    [takeLink],
  );
  // The slide ends when the move does — see the matching note in wall-field.
  const arrived = traversal?.pending == null;
  React.useEffect(() => {
    if (arrived) setSliding(null);
  }, [arrived, slideResetKey]);

  const [windows, setWindows] = React.useState<Record<string, number>>({});
  const [hoverKey, setHoverKey] = React.useState<string | null>(null);
  const [dragPage, setDragPage] = React.useState<number | null>(null);
  const [drop, setDrop] = React.useState<DeckDrop>(null);

  const layout = React.useMemo(
    () =>
      entry
        ? computeDeckLayout(pageCount, entry.size, {
            sectionRanges,
            lanes,
            hoverKey: dragPage === null ? hoverKey : null,
            drag: dragPage === null ? null : { pageIndex: dragPage, to: drop },
            laneWindows: windows,
            focus,
          })
        : null,
    [entry, pageCount, sectionRanges, lanes, hoverKey, dragPage, drop, windows, focus],
  );

  // ── Reading order is the reader's, not the author's ──
  const order = React.useMemo(() => deckReadingOrder(lanes), [lanes]);
  const state = React.useRef({ order, lanes, focus });
  state.current = { order, lanes, focus };

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
      let next: number | null = null;
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        const dir = e.key === "ArrowRight" ? 1 : -1;
        const at = s.order.indexOf(s.focus);
        const to = Math.min(Math.max((at < 0 ? 0 : at) + dir, 0), s.order.length - 1);
        next = s.order[to] ?? null;
      } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        // Lane to lane, landing on the page the reader was last on in it, or
        // its first — the table is columns, so the vertical keys are columns.
        const dir = e.key === "ArrowDown" ? 1 : -1;
        const at = s.lanes.findIndex((l) => l.pages.includes(s.focus));
        for (let i = (at < 0 ? 0 : at) + dir; i >= 0 && i < s.lanes.length; i += dir) {
          if (s.lanes[i].pages.length > 0) {
            next = s.lanes[i].pages[0];
            break;
          }
        }
      } else return;
      e.preventDefault();
      if (next !== null && next !== s.focus) {
        s.focus = next; // a held key keeps stepping from where it got to
        setPage(panel.id, next);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setPage, panel.id]);

  // Focusing a page buried below a lane's window scrolls that lane to it, so
  // the card being read is always one the reader can see.
  React.useEffect(() => {
    if (!layout) return;
    const laneIndex = lanes.findIndex((l) => l.pages.includes(focus));
    if (laneIndex < 0) return;
    const lane = lanes[laneIndex];
    const cell = layout.lanes[laneIndex];
    if (!cell) return;
    const at = lane.pages.indexOf(focus);
    if (at >= cell.windowStart && at < cell.windowStart + cell.shown) return;
    setWindows((w) => ({
      ...w,
      [lane.id]: Math.max(0, Math.min(at, lane.pages.length - 1)),
    }));
    // `layout` is derived from the same inputs; keying off the focus and the
    // arrangement is what actually decides whether the window has to move.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus, lanes]);

  // ── Dragging ──
  //
  // The pointer's ray is intersected with the TABLE's own plane and pulled
  // into its local frame, so (u, v) come out in exactly the coordinates the
  // layout is written in. While a card is up, a catcher plane over the whole
  // table takes the moves — the cards themselves must not, or the card the
  // pointer happens to cross would steal the drag.
  const tableRef = React.useRef<THREE.Group>(null);
  const drag = React.useRef<{
    page: number;
    grabU: number;
    grabV: number;
    travel: number;
    lastU: number;
    lastV: number;
  } | null>(null);
  const flyTarget = React.useRef(new THREE.Vector3());
  const plane = React.useMemo(() => new THREE.Plane(), []);
  const scratch = React.useMemo(() => new THREE.Vector3(), []);

  const toTable = React.useCallback(
    (e: ThreeEvent<PointerEvent>): { u: number; v: number } | null => {
      const g = tableRef.current;
      if (!g) return null;
      g.updateMatrixWorld();
      const normal = scratch
        .set(0, 0, 1)
        .transformDirection(g.matrixWorld)
        .normalize()
        .clone();
      const origin = new THREE.Vector3().setFromMatrixPosition(g.matrixWorld);
      plane.setFromNormalAndCoplanarPoint(normal, origin);
      const hit = e.ray.intersectPlane(plane, new THREE.Vector3());
      if (!hit) return null;
      const local = g.worldToLocal(hit);
      return { u: local.x, v: local.y };
    },
    [plane, scratch],
  );

  const endDrag = React.useCallback(() => {
    drag.current = null;
    setDragPage(null);
    setDrop(null);
    if (controls) controls.enabled = true;
  }, [controls]);

  // A pointer released anywhere — off the table, outside the canvas — still
  // ends the drag, so a card can never be left stuck to the hand.
  React.useEffect(() => {
    if (dragPage === null) return;
    const onUp = () => {
      if (drag.current) endDrag();
    };
    window.addEventListener("pointerup", onUp);
    return () => window.removeEventListener("pointerup", onUp);
  }, [dragPage, endDrag]);

  // …and a view switched away from mid-drag gives the camera back. The orbit
  // is disabled for the length of a drag, and this field is unmounted by
  // something outside it.
  React.useEffect(
    () => () => {
      if (controls) controls.enabled = true;
    },
    [controls],
  );

  const beginDrag = React.useCallback(
    (card: DeckCardCell, e: ThreeEvent<PointerEvent>) => {
      const p = toTable(e);
      if (!p) return;
      e.stopPropagation();
      drag.current = {
        page: card.pageIndex,
        grabU: p.u - card.u,
        grabV: p.v - card.v,
        travel: 0,
        lastU: p.u,
        lastV: p.v,
      };
      flyTarget.current.set(card.u, card.v, DECK_FLY_PROUD);
      setDragPage(card.pageIndex);
      setHoverKey(null);
      // OrbitControls listen on the canvas, so stopping the R3F event is not
      // enough — the drag and the orbit are the same gesture otherwise.
      if (controls) controls.enabled = false;
    },
    [toTable, controls],
  );

  const moveDrag = React.useCallback(
    (e: ThreeEvent<PointerEvent>) => {
      const d = drag.current;
      if (!d || !layout) return;
      const p = toTable(e);
      if (!p) return;
      d.travel += Math.hypot(p.u - d.lastU, p.v - d.lastV);
      d.lastU = p.u;
      d.lastV = p.v;
      const u = p.u - d.grabU;
      const v = p.v - d.grabV;
      flyTarget.current.set(u, v, DECK_FLY_PROUD);
      const target = deckDropTarget(
        layout,
        u + layout.cardWidth / 2,
        v - layout.cardHeight / 2,
      );
      setDrop((cur) => (deckSameDrop(cur, target) ? cur : target));
    },
    [layout, toTable],
  );

  const finishDrag = React.useCallback(() => {
    const d = drag.current;
    if (!d) return;
    if (d.travel < DECK_DRAG_THRESHOLD) {
      // A press that went nowhere is a click: read this page.
      setPage(panel.id, d.page);
    } else if (drop) {
      // …and a card carried off the row starts a section of its own, which
      // deckApplyDrop makes as readily as it moves one between lanes.
      setLanes((ls) => deckApplyDrop(ls, d.page, drop));
    }
    endDrag();
  }, [drop, endDrag, setPage, panel.id]);

  if (!entry || !layout) return null;

  // ── What renders live ──
  //
  // A miniature of the real page is worth having where it can actually be
  // seen: the card being read, the one under the pointer, and the whole cards
  // at the near end of each lane. Everything else is a sketch — it is under
  // another card anyway.
  const liveSet = new Set<number>();
  if (focus >= 0) liveSet.add(focus);
  for (const c of layout.cards) {
    if (liveSet.size >= DECK_LIVE_CARDS) break;
    if (c.hovered || c.exposed >= c.height) liveSet.add(c.pageIndex);
  }

  const anchor = entry.position;
  const frameOrigin = layout.frame.origin;
  const dragged =
    dragPage === null ? null : layout.cards.find((c) => c.pageIndex === dragPage);
  const draggedCard: DeckCardCell | null =
    dragPage === null
      ? null
      : (dragged ?? {
          // The card is out of the flow while it is in the air, so its own
          // cell is gone from the layout — rebuild just enough of one.
          key: deckCardKey(dragPage),
          pageIndex: dragPage,
          lane: 0,
          slot: 0,
          sectionIndex:
            lanes.find((l) => l.pages.includes(dragPage))?.sectionIndex ?? null,
          u: 0,
          v: 0,
          proud: DECK_FLY_PROUD,
          width: layout.cardWidth,
          height: layout.cardHeight,
          scale: layout.scale,
          exposed: layout.cardHeight,
          hovered: false,
          reading: dragPage === focus,
          recession: 0,
        });

  const tones = tableTones(theme.panelBg, dark);
  const tintOf = (sectionIndex: number | null): SectionTint =>
    sectionIndex === null ? neutralTint(theme, dark) : sectionTint(sectionIndex, dark);

  /** The entry a card's own <AtPos> gets: table-local, unrotated. */
  const cardEntry = (c: DeckCardCell): LayoutEntry => ({
    ...entry,
    pagination: undefined,
    curveRadius: 0,
    position: { x: c.u, y: c.v, z: c.proud },
    rotation: { x: 0, y: 0, z: 0 },
  });

  /**
   * …and the one its live miniature gets. Same size, but positioned in the
   * PANEL's frame: <LivePageGhost> hands `position.y` down as the panel
   * origin, which list cards turn into world-space self-clip planes, and a
   * table-local y down there would cull them.
   */
  const ghostEntry = (c: DeckCardCell): LayoutEntry => {
    const p = deckPoint(layout.frame, c.u, c.v, c.proud);
    return {
      ...entry,
      pagination: undefined,
      curveRadius: 0,
      position: {
        x: anchor.x + p.x,
        y: anchor.y + p.y,
        z: anchor.z + p.z,
      },
      rotation: { x: layout.frame.tilt, y: 0, z: 0 },
    };
  };

  const stageEntry: LayoutEntry = {
    ...entry,
    pagination: undefined,
    curveRadius: 0,
    position: {
      x: anchor.x + layout.stage.offset.x,
      y: anchor.y + layout.stage.offset.y,
      z: anchor.z + layout.stage.offset.z,
    },
    rotation: { x: 0, y: 0, z: 0 },
  };

  const band = Math.max(0.026, layout.cardHeight * 0.16);
  const focusLane = lanes.findIndex((l) => l.pages.includes(focus));
  const rearranged = deckIsRearranged(lanes, sectionRanges, pageCount);

  const renderCard = (c: DeckCardCell, flying: boolean) => {
    const tint = tintOf(c.sectionIndex);
    const live = liveSet.has(c.pageIndex) || flying;
    // A live miniature is MOUNTED in the card below the band, not laid over
    // it: the page is the card's own size, so at full scale it would hide the
    // mount that says which section this is and hang its last centimetres
    // over the card in front.
    const inset = c.width * 0.045;
    const shrink = Math.min(
      (c.width - 2 * inset) / c.width,
      (c.height - band - 1.6 * inset) / c.height,
    );
    return (
      <>
        <CellShadow
          width={c.width}
          height={c.height}
          z={-c.proud + Z_CARD_SHADOW}
          opacity={flying ? 0.5 : 0.3}
          grow={1.18 + Math.min(0.3, c.proud * 2)}
        />
        <CardFace
          width={c.width}
          height={c.height}
          band={band}
          pageIndex={c.pageIndex}
          heading={headings.get(c.pageIndex)}
          tint={tint}
          tone={tint.mount}
          reading={c.reading}
          hovered={c.hovered || flying}
        >
          {live ? (
            <group
              position={[
                (c.width - c.width * shrink) / 2,
                -band - inset * 0.6,
                0,
              ]}
            >
              <LivePageGhost
                panel={panel}
                plan={plan}
                primitiveMap={primitiveMap}
                entry={ghostEntry(c)}
                targetPage={c.pageIndex}
                scale={c.scale * shrink}
                recession={c.recession * 0.5}
                // The cards lie on a pitched table; the flat top/bottom clip
                // planes only hold while a cell is unpitched.
                clip={false}
                stage={false}
                controls={false}
                setPage={setPage}
              />
            </group>
          ) : (
            <CardSketch
              width={c.width}
              height={c.height}
              band={band}
              color={theme.mutedTextCol}
            />
          )}
        </CardFace>
      </>
    );
  };

  return (
    // Travelling moves the WORLD, not the reader: the stage and the table
    // leave together the way the door said, and the next document's table
    // completes the same motion coming in from the far side.
    <TravelGroup
      mode="slide"
      axis={sliding}
      resetKey={slideResetKey}
      // The plan identity — the cross waits for the next document to be up,
      // not just for its navigation to have committed.
      contentKey={plan}
    >
      {/* ── The stage: the page being read ── */}
      <AtPos key="deck-stage" entry={stageEntry}>
        <LivePageGhost
          panel={panel}
          plan={plan}
          primitiveMap={primitiveMap}
          entry={stageEntry}
          targetPage={focus}
          scale={1}
          recession={0}
          clip
          stage
          controls
          setPage={setPage}
        />
        {/* Which card on the table this is — the tie between the page being
            read and the lane it came out of. */}
        <group position={[0, 0.042, 0]}>
          <Text
            font={fontType}
            anchorX="left"
            anchorY="middle"
            position={[0.004, 0, 0.002]}
            fontSize={0.026}
            color={theme.mutedTextCol}
          >
            {`${
              focusLane >= 0 ? lanes[focusLane].label : "Deck"
            }  ·  page ${focus + 1} of ${pageCount}`}
          </Text>
          <Surface
            width={0.02}
            height={0.02}
            radius={0.01}
            color={
              focusLane >= 0 ? tintOf(lanes[focusLane].sectionIndex).accent : theme.accentCol
            }
            origin={[-0.024, 0]}
            flat
          />
        </group>
      </AtPos>

      {/* ── The table ── */}
      <group
        ref={tableRef}
        // Named because the drag inverts this group's own transform, so being
        // able to find it in a scene dump is the difference between debugging
        // the table and guessing at it.
        name="deck-table"
        position={[
          anchor.x + frameOrigin.x,
          anchor.y + frameOrigin.y,
          anchor.z + frameOrigin.z,
        ]}
        rotation={[layout.frame.tilt, 0, 0]}
      >
        <DeckSurface layout={layout} tones={tones} />
        {/* Paths off the table: north to the level above, south off-site,
            east and west to this site's other documents. */}
        <DeckLinkPaths
          layout={layout}
          slots={linkSlots}
          hood={hood}
          onTake={takePath}
          onTakeWing={takeWing}
        />
        <DeckRail
          layout={layout}
          rearranged={rearranged}
          onReset={() => {
            setLanes(deckDefaultLanes(sectionRanges, pageCount));
            setWindows({});
          }}
        />

        {layout.lanes.map((cell) => {
          const lane = lanes[cell.index];
          if (!lane) return null;
          const hidden = Math.max(
            0,
            cell.total - (cell.windowStart + cell.shown),
          );
          return (
            <Lane
              key={cell.id}
              cell={cell}
              tint={tintOf(cell.sectionIndex)}
              wellColor={tones.well}
              isShelf={cell.id === DECK_SHELF_ID}
              reading={focusLane === cell.index}
              hidden={hidden}
              canLeft={cell.index > 0}
              canRight={cell.index < layout.lanes.length - 1}
              onMoveLane={(dir) =>
                setLanes((ls) => deckMoveLane(ls, cell.index, dir))
              }
              onStepWindow={() =>
                setWindows((w) => {
                  const next = hidden > 0 ? cell.windowStart + Math.max(1, cell.shown - 1) : 0;
                  return { ...w, [lane.id]: next };
                })
              }
            />
          );
        })}

        {layout.newLaneZones.map((z) => (
          <NewLaneZone key={`new-zone-${z.at}`} zone={z} />
        ))}

        {/* One persistent eased group per card, keyed by PAGE — so a card
            dropped in another lane travels there instead of cutting. */}
        {layout.cards.map((c) => (
          <AtPos key={c.key} entry={cardEntry(c)}>
            {renderCard(c, false)}
            <CardTarget
              width={c.width}
              // Only the exposed strip of a buried card is its own; the rest
              // belongs to whatever is lying on top of it.
              height={Math.max(band, c.exposed)}
              onOver={() => setHoverKey(c.key)}
              onOut={() =>
                setHoverKey((cur) => (cur === c.key ? null : cur))
              }
              onDown={(e) => beginDrag(c, e)}
            />
          </AtPos>
        ))}

        {/* ── The card in the air ── */}
        {draggedCard && (
          <>
            <FlyingCard target={flyTarget}>
              <group>{renderCard(draggedCard, true)}</group>
            </FlyingCard>
            {/* Everything that happens while a card is up happens here. */}
            <mesh
              position={[0, layout.frame.depth / 2, 0.16]}
              onPointerMove={moveDrag}
              onPointerUp={(e) => {
                e.stopPropagation();
                finishDrag();
              }}
            >
              <planeGeometry
                args={[layout.frame.width * 3, layout.frame.depth * 4]}
              />
              <primitive
                object={HIT_TARGET_MATERIAL}
                attach="material"
                dispose={null}
              />
            </mesh>
          </>
        )}
      </group>
    </TravelGroup>
  );
}

/**
 * The card being carried. Its target is a ref the pointer handler writes
 * every move, and this eases toward it — going through React state at pointer
 * rate would re-render the whole table for every millimetre, and a card that
 * lags its hand by a frame or two is what makes it feel picked up rather than
 * teleported.
 */
function FlyingCard({
  target,
  children,
}: {
  target: React.RefObject<THREE.Vector3>;
  children: React.ReactNode;
}) {
  const ref = React.useRef<THREE.Group>(null);
  React.useLayoutEffect(() => {
    ref.current?.position.copy(target.current);
  }, [target]);
  useFrame((_, dt) => {
    const g = ref.current;
    if (!g) return;
    g.position.lerp(target.current, 1 - Math.exp(-24 * Math.min(dt, 0.1)));
  });
  return (
    <group ref={ref} raycast={() => null}>
      {children}
    </group>
  );
}

// ─────────────────────────────────────────────────────────────
// Connected tables: paths leading off this one
// ─────────────────────────────────────────────────────────────

/**
 * Paths off the table (docs/directional-links.md, Phase 6).
 *
 *   north (up-slope, past the far edge)  parent / top-level
 *   south (past the near lip)            external
 *   east and west (past the side edges)  siblings
 *
 * Drawn in TABLE COORDINATES like everything else in this view — u across, v
 * up-slope — so they lie flat on the surface and continue off it, which is
 * what makes them read as paths rather than as signs standing on the table.
 * The pitched group they hang in does the rest.
 *
 * The reverse path is reserved, exactly as on the wall: arriving from the west
 * means the westward path is the way back and takes no sibling.
 */
/** How far past the table's edge a path runs before its first plate. */
const PATH_LEAD = 0.06;
/**
 * Where a neighbour table starts: past the longest run of path plates, so a
 * wing never lands on top of the strips that name the same direction.
 * `PATH_LEAD` plus five plates is the deck's window (links/memory.ts WINDOWS).
 */
export const DECK_WING_LEAD = 0.06 + 5 * (0.056 + 0.014) + 0.05;
/** Plate size for a path marker, metres. Wider than the wall's: a path is read
 *  from above and a little off-axis, so it gets the room a strip does not. */
const PATH_W = 0.24;
const PATH_H = 0.056;
const PATH_GAP = 0.014;

/** The four directions a path can lead, in a fixed order. */
const PATH_AXES: Axis[] = ["up", "down", "left", "right"];

function DeckLinkPaths({
  layout,
  slots,
  hood,
  onTake,
  onTakeWing,
}: {
  layout: DeckLayout;
  slots: DirSlots;
  /** Neighbours whose documents have arrived — a card on the path, not a plate. */
  hood: Neighbourhood;
  onTake: (slot: DirSlot) => void;
  onTakeWing: (wing: WingDoc) => void;
}) {
  const theme = useTheme();
  const { frame } = layout;

  /**
   * One direction's run, laid along its path.
   *
   * Plates and CARDS together, the same as the wall's columns: a neighbour is
   * one of this page's links drawn bigger, not a separate table parked at the
   * end of the path. (An earlier build put whole neighbouring tables out past
   * the paths, which read as two unrelated systems.)
   */
  type PathItem =
    | { kind: "slot"; slot: DirSlot | null }
    | { kind: "wing"; wing: WingDoc };

  /**
   * Which plate each card stands in for, across all four directions.
   *
   * Same rule as the wall's columns, and for the same reason: the ranker
   * splits its laterals by score and `links/slots.ts` splits the page's by
   * reading order, so a card can be ranked west while its own link points
   * east. The PATH the link takes decides, and a plate is never drawn beside
   * its own card.
   */
  const claim = React.useMemo(() => {
    const byUrl = new Map<string, WingDoc>();
    for (const a of PATH_AXES)
      for (const w of hood[a]) if (w.state === "ready") byUrl.set(w.url, w);
    const at = new Map<string, string>();
    for (const a of PATH_AXES)
      for (const slot of drawable(slots[a])) {
        const w = byUrl.get(slot.url);
        if (w && !at.has(w.key)) at.set(w.key, slot.key);
      }
    return { byUrl, at };
  }, [hood, slots]);

  const itemsOf = (axis: Axis): PathItem[] => {
    const out: PathItem[] = [];
    for (const slot of drawable(slots[axis])) {
      const wing = claim.byUrl.get(slot.url);
      if (wing && claim.at.get(wing.key) === slot.key) out.push({ kind: "wing", wing });
      else out.push({ kind: "slot", slot });
    }
    for (const w of hood[axis])
      if (w.state === "ready" && !claim.at.has(w.key)) out.push({ kind: "wing", wing: w });
    if (overflowCount(slots[axis]) > 0) out.push({ kind: "slot", slot: null });
    // Cards nearest the table, plates beyond them — the same order the wall's
    // columns use, so a reader who learns it on one view keeps it on the other.
    const back = out.filter((it) => it.kind === "slot" && it.slot?.kind === "return");
    const cards = out.filter((it) => it.kind === "wing");
    const rest = out.filter((it) => it.kind === "slot" && it.slot?.kind !== "return");
    return [...back, ...cards, ...rest];
  };

  /** A card is worth this many plate-heights on the table. */
  const rowsOf = (it: PathItem) =>
    it.kind === "wing" ? (it.wing.depth === 1 ? 3 : it.wing.depth === 2 ? 2.4 : 1.7) : 1;

  const run = (
    axis: Axis,
    /** Table-space position of a run offset `d`, measured in plate-heights. */
    at: (d: number) => [number, number],
  ): React.ReactNode => {
    const items = itemsOf(axis);
    if (items.length === 0) return null;
    let cursor = 0;
    return (
      <group key={`path-${axis}`}>
        {items.map((it) => {
          const rows = rowsOf(it);
          const [u, v] = at(cursor + rows / 2);
          cursor += rows;
          const h = PATH_H * rows;
          const key = it.kind === "wing" ? it.wing.key : (it.slot?.key ?? `${axis}-overflow`);
          return (
            <group key={key} position={[u, v, 0.004]}>
              {it.kind === "wing" ? (
                <WingCard wing={it.wing} width={PATH_W} height={h} onTake={onTakeWing} />
              ) : it.slot ? (
                <DoorPlate
                  slot={it.slot}
                  width={PATH_W}
                  height={h}
                  recession={it.slot.distance - 1}
                  onSelect={() => onTake(it.slot as DirSlot)}
                />
              ) : (
                <OverflowMark count={overflowCount(slots[axis])} width={PATH_W} height={h} />
              )}
            </group>
          );
        })}
      </group>
    );
  };

  const halfW = frame.width / 2;

  return (
    <>
      {/* A path is a path because something joins it to the table. One thin
          strip per direction, under the plates. */}
      {(["up", "down", "left", "right"] as Axis[]).map((axis) => {
        const n = drawable(slots[axis]).length + (overflowCount(slots[axis]) > 0 ? 1 : 0);
        if (n === 0) return null;
        const runLen = PATH_LEAD + n * (PATH_H + PATH_GAP);
        const vertical = axis === "up" || axis === "down";
        const w = vertical ? PATH_W * 0.5 : runLen;
        const h = vertical ? runLen : PATH_W * 0.5;
        const cu = vertical
          ? 0
          : (axis === "right" ? 1 : -1) * (halfW + runLen / 2);
        const cv = vertical
          ? axis === "up"
            ? frame.depth + runLen / 2
            : -runLen / 2
          : frame.depth / 2;
        return (
          <mesh key={`track-${axis}`} position={[cu, cv, 0.001]}>
            <planeGeometry args={[w, h]} />
            <meshBasicMaterial
              color={theme.navBg}
              transparent
              opacity={0.4}
              depthWrite={false}
            />
          </mesh>
        );
      })}

      {run("up", (d) => [0, frame.depth + PATH_LEAD + d * (PATH_H + PATH_GAP)])}
      {run("down", (d) => [0, -PATH_LEAD - d * (PATH_H + PATH_GAP)])}
      {/* Lateral plates sit off the side edge and stack DOWN-SLOPE rather than
          further out: a run of five siblings pushed out sideways would be
          three metres from the table by the last one, and the reader has to
          be able to read them all from where they sit. */}
      {run("right", (d) => [
        halfW + PATH_LEAD + PATH_W / 2,
        frame.depth / 2 - d * (PATH_H + PATH_GAP),
      ])}
      {run("left", (d) => [
        -halfW - PATH_LEAD - PATH_W / 2,
        frame.depth / 2 - d * (PATH_H + PATH_GAP),
      ])}
    </>
  );
}

