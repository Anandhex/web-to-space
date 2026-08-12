/**
 * scene/desk-decor.tsx
 *
 * The furniture the front-facing views sit in: `standard` (a reading desk)
 * and `carousel` (the same desk, with the neighbouring pages standing on an
 * arc either side of the one being read).
 *
 * Those two were the last views still drawn as bare panels hanging in a void,
 * which is the exact problem the wall and the rooms settled: an unlit plane
 * with no edge reads as a hole rather than a surface, every panel is the same
 * value as the next, and nothing says the pieces belong together. So the desk
 * is built on the same three principles the board and the table are:
 *
 *  1. A real SURFACE behind it (<DeskBoard>), curved on the same cylinder the
 *     panels are placed on, with the reading panel standing off it and casting
 *     a soft shadow. That one plane is what turns three stacked panels into a
 *     workstation, and it puts a known value behind every piece of text. The
 *     side rails get their own smaller mounts for the same reason.
 *  2. EDGES. Board, mounts and plate are rounded <Surface>s with a hairline
 *     rim, so a rail reads as a card on a bracket rather than two planes
 *     meeting.
 *  3. COLOUR that means something. The section the current page belongs to
 *     owns a hue (`sectionTint`, shared with the wall and the deck), carried
 *     by the spine down the board's leading edge and by the lit segment of the
 *     progress rail. A section is the same colour in every view, so spatial
 *     memory built in one carries into the others.
 *
 * The plate is where this view finally answers "where am I?". A paginated
 * document in `standard` used to give the reader a page and no way to know
 * which of forty-seven it was, or what section they were in; `carousel` shows
 * the two pages either side, which says what is next but not how far through
 * the document they are. The plate names the section and the page, and its rail draws
 * the whole document end to end with one segment per section — the same rail
 * the wall's sign plate uses, for the same reason.
 *
 * Geometry is world-space and derived entirely from the plan's slots, so it
 * follows whatever `deskSlots` decided for the active device profile; nothing
 * here is authored per-device. The pure parts are exported and free of any
 * three/react dependency at their boundary so the offline audit can check
 * them.
 */
import React from "react";
import { Text } from "@react-three/drei";

import type { LandmarkSlot, LayoutPlan, SlotName } from "../../layout/types";
import type { SemanticScene, XRPrimitive } from "../../mapper/types";
import { classifyLandmark } from "../../layout/engine/classify";
import { entryOnPage } from "./contexts";
import { useTheme, type XRTheme } from "../theme";
import { Surface } from "../primitives/surface";
import { Z_LAYER_ACCENT, Z_LAYER_OVERLAY_TEXT } from "../primitives/constants";
import {
  curvePoint,
  resolveCurveRadius,
  type PanelCurve,
} from "../primitives/curve";
import { FontContext } from "./contexts";
import type { SectionPageRange } from "../page-placements";
import { isDarkTheme, sectionTint, shade } from "./section-tint";

// ── Geometry ─────────────────────────────────────────────────

export interface Pose {
  centre: { x: number; y: number; z: number };
  /** Yaw only — every desk panel is upright. */
  yaw: number;
}

export interface Vec2 {
  width: number;
  height: number;
}

/**
 * A slot's CENTRE in world space.
 *
 * Slots are top-left anchored and rotate about that anchor, so the centre is
 * half a width along the panel's own +x axis (which yaw φ puts at
 * `(cos φ, 0, −sin φ)`) and half a height down.
 */
export function slotCentre(slot: {
  position: { x: number; y: number; z: number };
  size: Vec2;
  rotation: { y: number };
}): Pose {
  const half = slot.size.width / 2;
  const yaw = slot.rotation.y;
  return {
    centre: {
      x: slot.position.x + half * Math.cos(yaw),
      y: slot.position.y - slot.size.height / 2,
      z: slot.position.z - half * Math.sin(yaw),
    },
    yaw,
  };
}

/**
 * How far behind the panels the board hangs.
 *
 * Small on purpose. The board is bent on the SAME cylinder as the panels, so
 * the two surfaces stay parallel and this only has to separate them — a flat
 * board at any standoff would be pierced by the panel's own corners, since a
 * 1.39 m panel on a 1.2 m radius bulges 0.195 m toward the reader at its
 * edges.
 */
export const DESK_BOARD_STANDOFF = 0.045;

/**
 * Margin the board leaves around the panels it backs.
 *
 * A MOUNT, not a wall. At 0.09/0.07 with the board spanning banner→footer the
 * result was a slab 1.54× the height of the reading panel, most of it empty —
 * a big dark rectangle with a page floating in the middle of it. The margin a
 * mount shows is a margin, so it reads as an edge rather than as a surface in
 * its own right.
 */
const BOARD_PAD_X = 0.055;
const BOARD_PAD_Y = 0.05;

/** Margin a rail mount leaves around its rail. */
const MOUNT_PAD = 0.028;

/** Hairline between two sections on the outline rail, split across both. */
const SEG_SEPARATION = 0.004;

/**
 * Force whatever ranges arrive into a gap-free, ordered partition of
 * [0, pageCount − 1].
 *
 * `fillRanges` upstream is supposed to guarantee this and now does, but the
 * rail is the one place where getting it wrong is loudly visible — a range
 * with `end < start` draws as a 9 mm nub (the <Surface> minimum) at a position
 * derived from a negative width, and the pages it should have covered get
 * nothing, so the bar comes out as a few short dashes on a long black track.
 * The rail is also fed from several call sites and the section outline is
 * derived from wherever each primitive happened to paginate, so it is worth
 * the dozen lines to not depend on that being tidy.
 *
 * Anything that survives is a real span of pages, in order, butted against its
 * neighbours — which is what makes the bar read as the whole document.
 */
export function partitionRanges(
  ranges: SectionPageRange[],
  pageCount: number,
): SectionPageRange[] {
  if (pageCount <= 0) return [];
  const byStart = new Map<number, string>();
  for (const r of ranges) {
    const at = Math.max(0, Math.min(pageCount - 1, Math.floor(r.start)));
    if (!byStart.has(at)) byStart.set(at, r.label);
  }
  if (byStart.size === 0) return [{ start: 0, end: pageCount - 1, label: "Document" }];
  if (!byStart.has(0)) byStart.set(0, "Intro");

  const starts = [...byStart.keys()].sort((a, b) => a - b);
  return starts.map((start, i) => ({
    start,
    end: (i + 1 < starts.length ? starts[i + 1] : pageCount) - 1,
    label: byStart.get(start)!,
  }));
}

export interface DeskBoard {
  pose: Pose;
  size: Vec2;
  /** Cylinder the board is bent on — the reading radius, or 0 when flat. */
  curveRadius: number;
}

/** The mount behind the reading panel. */
export function computeDeskBoard(main: LandmarkSlot): DeskBoard {
  return {
    pose: {
      centre: {
        x: main.position.x + main.size.width / 2,
        y: main.position.y - main.size.height / 2,
        z: main.position.z - DESK_BOARD_STANDOFF,
      },
      yaw: 0,
    },
    size: {
      width: main.size.width + 2 * BOARD_PAD_X,
      height: main.size.height + 2 * BOARD_PAD_Y,
    },
    curveRadius: main.curveRadius,
  };
}

// ── Placing things ON the cylinder ────────────────────────────

/**
 * Puts a child at panel-local `(x, y)` ON the desk's cylinder, tangent to it.
 *
 * Everything the desk draws over a curved surface has to go through this.
 * Drawn as plain flat children of the board's group instead — which is what
 * the first version did — a decoration is placed on the CHORD rather than the
 * arc, and on the Quest 3's 1.2 m reading cylinder that is not a subtle
 * error: the section spine, sitting at the board's left margin, ended up
 * 0.246 m behind the surface it was supposed to be painted on (invisible),
 * and the sign plate's own edges floated 0.10 m off it, so a plate that was
 * correctly centred still read as a separate card hanging at the wrong angle.
 *
 * Same mapping `AtPos` uses for every primitive inside a curved panel, so
 * decoration and content land on one cylinder.
 */
function OnArc({
  x,
  y,
  z = 0,
  curve,
  children,
}: {
  x: number;
  y: number;
  z?: number;
  curve: PanelCurve | null;
  children: React.ReactNode;
}) {
  if (!curve) {
    return <group position={[x, y, z]}>{children}</group>;
  }
  const p = curvePoint(x, y, z, curve.radius, 0);
  return (
    <group position={p.position} rotation={[0, p.yaw, 0]}>
      {children}
    </group>
  );
}

// ── Tones ────────────────────────────────────────────────────

/**
 * The desk's own neutrals. Same shape as the wall's `boardTones`: the light
 * theme has almost no headroom above `panelBg` (#DADADA is the top of Meta's
 * brightness band), so its mount goes DOWN — a mid-grey surround with a pale
 * page on it — while the dark theme steps down only slightly.
 */
function deskTones(theme: XRTheme, dark: boolean) {
  return {
    board: shade(theme.panelBg, dark ? -0.05 : -0.15),
    boardTop: shade(theme.panelBg, dark ? -0.02 : -0.11),
    mount: shade(theme.panelBg, dark ? -0.035 : -0.1),
    plate: shade(theme.panelBg, dark ? 0.03 : -0.02),
    rim: theme.panelRim,
    /** The rail's unfilled track — darker than the plate it sits on. */
    track: shade(theme.panelBg, dark ? -0.08 : -0.12),
  };
}

// ── Sign plate ───────────────────────────────────────────────

/**
 * Where you are, and how far through.
 *
 * The rail below the labels draws the whole document end to end with one
 * segment per section, each in that section's own hue, and a marker at the
 * current page — so the reader can see both which section they are in and how
 * much is behind them without opening anything. `standard` and `carousel`
 * previously gave a page and no way to know which of forty it was.
 *
 * Every part of it is placed with <OnArc>: the plate is a metre wide on a
 * 1.2 m cylinder, which is 48° of arc, far too much to lay out flat.
 */
function DeskPlate({
  width,
  curve,
  ranges,
  pageCount,
  page,
  dark,
}: {
  width: number;
  curve: PanelCurve | null;
  ranges: SectionPageRange[];
  pageCount: number;
  page: number;
  dark: boolean;
}) {
  const theme = useTheme();
  const fontType = React.useContext(FontContext);
  const tones = deskTones(theme, dark);

  const h = Math.max(0.08, width * 0.072);
  const pad = h * 0.32;
  const railW = width - 2 * pad;
  // <Surface> floors every dimension at MIN_DIM (9 mm — the `0.025 m` note on
  // MIN_DIM in primitives/constants.ts is stale), so a rail written as a bare
  // fraction of the plate would come out several times its nominal height and
  // quietly stop matching the number here. Ask for what we get.
  const railH = Math.max(0.009, h * 0.1);
  const railY = -h * 0.3;
  const labelY = h * 0.2;

  // `curveRadius` is a valid troika-three-text prop forwarded at runtime, but
  // drei's <Text> type doesn't declare it — pass it through an untyped spread,
  // the same way primitives/inline.tsx does. Without it the plate's own label
  // runs stay straight while the plate under them bends.
  const curveProp = (curve ? { curveRadius: curve.radius } : {}) as Record<
    string,
    unknown
  >;

  const spans = partitionRanges(ranges, pageCount);
  const here = spans.findIndex((r) => page >= r.start && page <= r.end);
  const section = here >= 0 ? spans[here] : null;
  const title = section?.label || "Document";
  const detail =
    pageCount > 1 ? `Page ${page + 1} of ${pageCount}` : `${pageCount} page`;

  return (
    <>
      {/* The plate itself bends; its contents are placed on the same arc. */}
      <Surface
        width={width}
        height={h}
        color={tones.plate}
        topColor={shade(tones.plate, dark ? 0.035 : 0.02)}
        rimColor={tones.rim}
        rimOpacity={0.55}
        origin={[0, 0]}
        roughness={0.95}
        curve={curve}
      />
      <OnArc x={-width / 2 + pad} y={labelY} z={Z_LAYER_OVERLAY_TEXT} curve={curve}>
        <Text
          font={fontType}
          anchorX="left"
          anchorY="middle"
          fontSize={h * 0.3}
          color={theme.headingCol}
          maxWidth={width * 0.55}
          {...curveProp}
        >
          {title.slice(0, 64)}
        </Text>
      </OnArc>
      <OnArc x={width / 2 - pad} y={labelY} z={Z_LAYER_OVERLAY_TEXT} curve={curve}>
        <Text
          font={fontType}
          anchorX="right"
          anchorY="middle"
          fontSize={h * 0.21}
          color={theme.mutedTextCol}
          {...curveProp}
        >
          {detail}
        </Text>
      </OnArc>

      {/* The track, then one segment per section over it. */}
      <Surface
        width={railW}
        height={railH}
        radius={railH / 2}
        color={tones.track}
        origin={[0, railY]}
        flat
        z={Z_LAYER_ACCENT}
        curve={curve}
      />
      {spans.map((r, i) => {
        // Each section owns the slot [t0, t1] of the track and its segment is
        // CENTRED in it, with the hairline separation split between the two
        // sides. Taking the separation off one end instead — which is what
        // `x = t0·railW + segW/2` did — walks every segment left of its slot
        // and leaves the last one short of the track's end, so the rail read
        // as not quite reaching.
        const x0 = (r.start / pageCount) * railW;
        const x1 = ((r.end + 1) / pageCount) * railW;
        const segW = Math.max(0.004, x1 - x0 - SEG_SEPARATION);
        const segX = (x0 + x1) / 2 - railW / 2;
        const tint = sectionTint(i, dark);
        // The rail is an OUTLINE first and a progress bar second, so every
        // section is drawn at full strength. Holding the ones ahead back to a
        // third — the first attempt — meant that on page 1 the whole outline
        // was washed out, which is the one moment a reader most wants to see
        // the shape of what they are about to read. The section being read is
        // marked by standing proud of the track instead.
        const current = i === here;
        return (
          <OnArc
            key={`seg-${i}`}
            x={segX}
            y={railY}
            z={Z_LAYER_ACCENT + 0.0004}
            curve={curve}
          >
            {/* BENT, not flat. <OnArc> puts the segment's CENTRE on the
                cylinder and turns it tangent, but a flat quad then chords
                across the arc and its ends dip behind it — and the track it
                sits on is a bent surface following that arc exactly, only
                0.4 mm behind. Solving R(1 − cos(x/R)) = 0.0004 at R = 1.2 m
                gives x = 31 mm, so a flat segment was occluded beyond ±31 mm
                of its centre no matter how many pages it spanned: every
                section came out as the same ~60 mm dash on a long dark track.
                Bending it around its own centre keeps the whole span in
                front. */}
            <Surface
              width={segW}
              height={current ? railH * 1.7 : railH}
              radius={railH / 2}
              color={tint.accent}
              flat
              origin={[0, 0]}
              z={0}
              curve={curve ? { radius: curve.radius, centerX: 0 } : null}
            />
          </OnArc>
        );
      })}
      {/* Where the current page falls, to the page rather than the section.
          Drawn ABOVE the track, not across it: as a pill straddling the rail
          it sat on top of the very segment whose colour it was reporting, and
          on page 1 that is the first segment — the marker hid the answer. */}
      <OnArc
        x={-railW / 2 + ((page + 0.5) / pageCount) * railW}
        y={railY + railH * 1.6}
        z={Z_LAYER_ACCENT + 0.001}
        curve={curve}
      >
        <Surface
          width={railH * 0.8}
          height={railH}
          radius={railH * 0.4}
          color={theme.headingCol}
          flat
          origin={[0, 0]}
          z={0}
        />
      </OnArc>
    </>
  );
}

// ── Which rails are actually in use ──────────────────────────

/** Types that put something on screen by themselves rather than via children. */
const SELF_DRAWING_TYPES = new Set([
  "XRImage",
  "XRMediaPlayer",
  "XRSeparator",
  "XRProgressBar",
  "XRToggle",
  "XRSlider",
  "XRComboBox",
  "XRSearchBox",
  "XRFormField",
  "XRButton",
]);

/**
 * Does any part of this subtree draw something on `page`?
 *
 * `inheritedOnPage` carries the parent's answer down to nodes that have no
 * LayoutEntry of their own — the inline children an ancestor draws as prose.
 * Defaulting those to visible would report an aside as occupied on the very
 * pages the mutual-exclusion pass gated it off, since only entries carry the
 * page window.
 */
function drawsOnPage(
  node: XRPrimitive,
  plan: LayoutPlan,
  page: number,
  inheritedOnPage = true,
): boolean {
  const entry = plan.entries[node.id];
  if (entry?.suppressed) return false;

  const onPage = entry ? entryOnPage(entry, page) : inheritedOnPage;
  if (onPage) {
    if (SELF_DRAWING_TYPES.has(node.type)) return true;
    if ((node.content ?? node.label ?? "").trim().length > 0) return true;
  }
  return node.children.some((child) =>
    drawsOnPage(child, plan, page, onPage),
  );
}

/**
 * The slots that have something visible in them on this page.
 *
 * `LayoutPlan.occupiedSlots` cannot answer this: it is filled when a landmark
 * is *classified* to a slot, before pagination and before the mutual-exclusion
 * pass decides which pages that landmark is actually shown on. Mounting rails
 * from it therefore hangs an empty slab beside the reading panel on every page
 * where the aside is gated off — or where the landmark routed there turned out
 * to hold nothing renderable at all (a deferred-hydration shell, a wrapper the
 * source page fills with JS we never run).
 *
 * A rail is furniture for content. With no content there is nothing to mount.
 */
export function slotsWithVisibleContent(
  scene: SemanticScene,
  plan: LayoutPlan,
  page: number,
): Set<SlotName> {
  const occupied = new Set<SlotName>();

  const consider = (primitive: XRPrimitive): void => {
    const slot = classifyLandmark(primitive);
    if (occupied.has(slot)) return;
    if (!plan.slots?.[slot]) return;
    if (drawsOnPage(primitive, plan, page)) occupied.add(slot);
  };

  for (const child of scene.root.children) consider(child);

  // Section-nested asides are re-homed to the complementary slot by the
  // engine's extraction pass, so they never appear among the scene's top-level
  // children — but they are exactly what fills that rail on most article pages.
  if (!occupied.has("complementary")) {
    for (const primitive of Object.values(scene.primitives)) {
      if (primitive.type !== "XRComplementary") continue;
      if (plan.entries[primitive.id]?.pageIndex === undefined) continue;
      if (drawsOnPage(primitive, plan, page)) {
        occupied.add("complementary");
        break;
      }
    }
  }

  return occupied;
}

// ── The desk ─────────────────────────────────────────────────

export interface DeskDecorProps {
  /** The plan's landmark slots — the desk is derived entirely from these. */
  slots: Partial<Record<SlotName, LandmarkSlot>>;
  /**
   * The slots that have visible content on the current page — see
   * `slotsWithVisibleContent`. A template offers a rail whether or not the
   * document has anything for it, and a landmark routed to a rail may be
   * page-gated off or hold nothing at all, so mounting anything broader than
   * this hangs an empty slab beside the reading panel.
   */
  occupied: ReadonlySet<SlotName>;
  pageCount: number;
  page: number;
  sectionRanges: SectionPageRange[];
}

/** Rails that get a mount. `main` stands on the board. */
const MOUNTED_RAILS: SlotName[] = ["toc", "complementary", "navigation"];

export function DeskDecor({
  slots,
  occupied,
  pageCount,
  page,
  sectionRanges,
}: DeskDecorProps) {
  const theme = useTheme();
  const dark = isDarkTheme(theme);
  const mainSlot = slots.main;
  if (!mainSlot) return null;

  const board = computeDeskBoard(mainSlot);
  const tones = deskTones(theme, dark);
  const radius = resolveCurveRadius(board.curveRadius);
  // The board bends on the reading cylinder, tangent at its own centre, so it
  // stays parallel to the page standing on it.
  const curve: PanelCurve | null = radius ? { radius, centerX: 0 } : null;

  // The hue the desk is wearing: the section the current page falls in. With
  // no sections parsed there is no hue to wear, so the spine falls back to the
  // theme's own accent rather than claiming a section that isn't there.
  const sectionIndex = sectionRanges.findIndex(
    (r) => page >= r.start && page <= r.end,
  );
  const accent =
    sectionIndex >= 0 ? sectionTint(sectionIndex, dark).accent : theme.accentCol;

  /**
   * The spine: the current section's hue, down the mount's leading edge and
   * spanning exactly the reading band. It is the one part of the desk that
   * changes as you read, so it is what the colour language hangs off — the
   * same hue this section wears on the wall and on the deck.
   */
  const spineW = Math.max(0.009, board.size.width * 0.011);
  const spineX = -board.size.width / 2 + BOARD_PAD_X * 0.5;

  const plateW = board.size.width;
  const plateH = Math.max(0.08, plateW * 0.072);

  return (
    <group>
      {/* ── The mount ─────────────────────────────────────────── */}
      <group
        position={[board.pose.centre.x, board.pose.centre.y, board.pose.centre.z]}
      >
        <Surface
          width={board.size.width}
          height={board.size.height}
          color={tones.board}
          topColor={tones.boardTop}
          rimColor={tones.rim}
          rimOpacity={0.5}
          origin={[0, 0]}
          roughness={0.95}
          curve={curve}
        />
        <OnArc x={spineX} y={0} z={Z_LAYER_ACCENT} curve={curve}>
          <Surface
            width={spineW}
            height={mainSlot.size.height}
            radius={spineW / 2}
            color={accent}
            flat
            origin={[0, 0]}
            z={0}
          />
        </OnArc>
      </group>

      {/* ── Sign plate, flush above the mount ─────────────────── */}
      {pageCount > 0 && (
        <group
          position={[
            board.pose.centre.x,
            board.pose.centre.y + board.size.height / 2 + plateH / 2 + 0.018,
            board.pose.centre.z,
          ]}
        >
          <DeskPlate
            width={plateW}
            curve={curve}
            ranges={
              sectionRanges.length > 0
                ? sectionRanges
                : [{ start: 0, end: pageCount - 1, label: "Document" }]
            }
            pageCount={pageCount}
            page={page}
            dark={dark}
          />
        </group>
      )}

      {/* ── Rail mounts ───────────────────────────────────────── */}
      {MOUNTED_RAILS.map((role) => {
        const slot = slots[role];
        if (!slot || !occupied.has(role)) return null;
        const pose = slotCentre(slot);
        const rr = resolveCurveRadius(slot.curveRadius);
        return (
          <group
            key={role}
            position={[pose.centre.x, pose.centre.y, pose.centre.z]}
            rotation={[0, pose.yaw, 0]}
          >
            <group position={[0, 0, -DESK_BOARD_STANDOFF * 0.5]}>
              <Surface
                width={slot.size.width + 2 * MOUNT_PAD}
                height={slot.size.height + 2 * MOUNT_PAD}
                color={tones.mount}
                rimColor={tones.rim}
                rimOpacity={0.45}
                origin={[0, 0]}
                roughness={0.95}
                curve={rr ? { radius: rr, centerX: 0 } : null}
              />
            </group>
          </group>
        );
      })}
    </group>
  );
}
