/**
 * scene/link-doors.tsx — the shared parts of a door.
 *
 * Every view opens links in the same four directions (docs/directional-links.md),
 * so what a door SAYS is one thing written once, and where a door STANDS is
 * each view's own answer: a strip on the wall's edge, a path off the deck's
 * table, a corridor in the building.
 *
 * This module owns the first half — the slot list a view fills, the plate a
 * slot is drawn as, and the traversal a selection performs. The geometry stays
 * with the view.
 *
 * ── What a plate carries ──
 *
 *  · the same directional glyph as the anchor's inline mark, so the legend the
 *    reader learned at the anchor is the legend on the door
 *  · the destination's name — `links/identity.ts` synthesises one when the
 *    anchor text was too weak, which the census says is only 0.7% of anchors
 *  · nothing chromatic. Colour is spent entirely on the gaze binding, which
 *    is the only channel left for saying WHICH anchor this door came from.
 *
 * ── The one per-frame rule ──
 *
 * Nothing here runs per frame. A door is state and geometry; the transitions
 * that do animate live in the view, where they can be guarded — an uncaught
 * throw inside an XR frame ends rendering permanently.
 */
import React from "react";
import { Text } from "@react-three/drei";

import { useTheme } from "../theme";
import { FontContext } from "./contexts";
import { useLinkBinding, usePageLinks, useTraversal } from "./contexts";
import {
  buildSlots,
  drawable,
  fitBudget,
  overflowCount,
  type DirSlot,
  type DirSlots,
} from "../../links/slots";
import { markFor, markForSide } from "../../links/direction";
import type { LateralSide } from "../../links/direction";
import { windowFor, type Axis } from "../../links/memory";

/** The glyph a direction is drawn with — the anchor's mark, at door size. */
const AXIS_MARK: Record<Axis, string> = {
  up: markFor("up"),
  down: markFor("down"),
  // A door on the reader's left carries a left-pointing mark. It used to carry
  // `▸` like its right-hand twin, which pointed the reader across the corridor
  // at the wall opposite the door they were being told to take.
  left: markForSide("lateral", "left"),
  right: markForSide("lateral", "right"),
};

/** The lateral mark points right; a westward door mirrors it. */
export function markForAxis(axis: Axis): string {
  return axis === "left" ? "◂" : AXIS_MARK[axis];
}

interface DoorSlots {
  slots: DirSlots;
  /** Follow a slot: a link travels, a travelled node jumps back to itself. */
  take: (slot: DirSlot) => void;
  /** True when there is anything at all to draw. */
  any: boolean;
}

/**
 * The doors for the page the reader is currently on.
 *
 * SCOPED TO THAT PAGE, not the document. A corridor belongs to the page the
 * reader is on and other pages' corridors are not live — a paginated panel
 * that dropped a whole nav sidebar onto page 4 would otherwise hang 167 doors
 * off every page of the document (docs/directional-links.md, "Decisions
 * taken" item 5, and the census figure behind it).
 */
export function useDoorSlots(
  pageIndex: number,
  /** The view's name — `windowFor` maps it to a window budget. */
  viewMode: string | undefined,
  /**
   * Size the window to the links actually on this page instead, so every one
   * of them gets a door.
   *
   * For a view that has narrowed to ONE rendered page. A window is there to
   * ration a direction that many pages are competing for; a reader looking at
   * a single page is not in that situation, and the census says they usually
   * have nothing to ration anyway — outbound links are a median of 0 and a p90
   * of 7 per rendered page. See `fitBudget`.
   */
  fit = false,
): DoorSlots {
  const pageLinks = usePageLinks();
  const traversal = useTraversal();
  const nav = traversal?.nav ?? null;

  const links = React.useMemo(
    () => (pageLinks?.links ?? []).filter((l) => l.pageIndex === pageIndex),
    [pageLinks, pageIndex],
  );

  const budget = React.useMemo(
    () => (fit ? fitBudget(links, nav) : windowFor(viewMode)),
    [fit, links, nav, viewMode],
  );

  const slots = React.useMemo(
    () => buildSlots({ links, nav, budget }),
    [links, nav, budget],
  );

  // Tell the inline marks which hand each sibling's door took, so a mark on
  // the left-hand half of a lateral run draws `◂` and not `▸`. This view is
  // the only thing that knows: the side falls out of the budget, which is the
  // view's, not the classifier's.
  const publishSides = pageLinks?.publishSides;
  React.useEffect(() => {
    if (!publishSides) return;
    const sides = new Map<string, LateralSide>();
    for (const axis of ["left", "right"] as const)
      for (const slot of slots[axis])
        if (slot.kind === "link" && slot.linkId) sides.set(slot.linkId, axis);
    publishSides(sides);
  }, [slots, publishSides]);

  const take = React.useCallback(
    (slot: DirSlot) => {
      if (!traversal) return;
      // A travelled node is somewhere the reader has already been, so it moves
      // them THROUGH memory rather than adding to it; following a fresh link
      // is what grows a corridor.
      if (slot.historyIndex !== undefined) traversal.jump(slot.historyIndex);
      else traversal.traverse(slot.url, slot.axis, slot.label);
    },
    [traversal],
  );

  const any =
    slots.up.length + slots.down.length + slots.left.length + slots.right.length > 0;

  return { slots, take, any };
}

export { drawable, overflowCount };
export type { DirSlot, DirSlots };

/**
 * One door, as a plate.
 *
 * `width`/`height` are the view's to choose — a wall strip is long and thin, a
 * corridor door is tall. Everything else is shared so a door reads the same
 * wherever the reader meets one.
 */
export function DoorPlate({
  slot,
  width,
  height,
  /** Drawn dimmer the further down a corridor it sits. 1 = adjacent. */
  recession = 0,
  onSelect,
}: {
  slot: DirSlot;
  width: number;
  height: number;
  recession?: number;
  onSelect: () => void;
}) {
  const theme = useTheme();
  const fontType = React.useContext(FontContext);
  const { lit, setLit } = useLinkBinding();
  const [hover, setHover] = React.useState(false);

  // The binding: this door is lit when its anchor is, and lighting the door
  // lights the anchor. One id, both ends — see LinkBindingContext.
  const isLit = slot.linkId !== undefined && lit === slot.linkId;
  const active = isLit || hover;

  // The way back is drawn as a way back: a heavier rim, because it is the one
  // door the reader must be able to find without reading anything.
  const isReturn = slot.kind === "return";

  // Recession applies to the TRAVELLED path only.
  //
  // Down a corridor, the fourth document back really is further away and
  // drawing it dimmer says so. A page's own links are not a corridor — their
  // `distance` is just the slot they landed in, and they are all equally
  // reachable — so fading them by index made the fourth sibling on a page a
  // near-black plate the reader could not read. Same number, opposite meaning.
  const dim =
    slot.kind === "link" ? 1 : Math.max(0.45, 1 - recession * 0.18);

  const glyph = markForAxis(slot.axis);

  // ── Fitting the name to the plate ──
  //
  // Sized off the plate rather than clamped to a constant, and truncated to
  // what will actually FIT rather than to a fixed character count. The first
  // build capped the label at 30 characters on a plate that had room for nine,
  // so every door on the wall read "Measuremen…" or "en.wikipedia…" — a door
  // whose name is truncated to nothing is a door with no name.
  //
  // 0.5 em per character is the usual working average for mixed-case text at
  // this weight; erring low would clip, so it errs slightly high and the plate
  // ends with a little air.
  const pad = height * 0.2;
  const glyphSize = height * 0.4;
  const labelSize = height * 0.3;
  const prefix = isReturn ? "back to " : "";
  const textW = width - pad * 2 - glyphSize * 1.15;
  const fits = Math.max(6, Math.floor(textW / (labelSize * 0.5)) - prefix.length);
  const name = slot.label || "link";
  const label = name.length > fits ? `${name.slice(0, Math.max(3, fits - 1))}…` : name;

  return (
    <group
      onClick={(e) => {
        e.stopPropagation();
        onSelect();
      }}
      onPointerOver={(e) => {
        e.stopPropagation();
        setHover(true);
        if (slot.linkId) setLit(slot.linkId);
      }}
      onPointerOut={() => {
        setHover(false);
        if (slot.linkId) setLit(null);
      }}
    >
      {/* Face. Fully opaque: a translucent plate over a dark board took the
          board's value through it and the name lost most of its contrast. */}
      <mesh>
        <planeGeometry args={[width, height]} />
        <meshBasicMaterial
          color={active ? theme.listItemBg : theme.navBg}
          transparent
          opacity={dim}
          depthWrite={false}
        />
      </mesh>
      {/* Rim. The way back gets a heavier one — it is the single door the
          reader has to be able to find without reading anything. */}
      <mesh position={[0, 0, -0.0012]}>
        <planeGeometry args={[width + 0.006, height + 0.006]} />
        <meshBasicMaterial
          color={active || isReturn ? theme.headingCol : theme.panelRim}
          transparent
          opacity={(active ? 0.95 : isReturn ? 0.8 : 0.55) * dim}
          depthWrite={false}
        />
      </mesh>
      {/* The glyph — the same mark as at the anchor. */}
      <Text
        font={fontType}
        anchorX="left"
        anchorY="middle"
        position={[-width / 2 + pad, 0, 0.003]}
        fontSize={glyphSize}
        color={theme.headingCol}
        fillOpacity={dim}
      >
        {glyph}
      </Text>
      <Text
        font={fontType}
        anchorX="left"
        anchorY="middle"
        position={[-width / 2 + pad + glyphSize * 1.15, 0, 0.003]}
        fontSize={labelSize}
        color={active ? theme.headingCol : theme.bodyCol}
        fillOpacity={dim}
        // No maxWidth and no clipRect: the label has already been cut to what
        // fits, and letting troika wrap it instead would put a second line
        // outside a plate that is one line tall.
      >
        {prefix + label}
      </Text>
      {/* Hit plane, sized to the whole plate so nothing needs a centre hit. */}
      <mesh position={[0, 0, 0.004]}>
        <planeGeometry args={[width, height]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} />
      </mesh>
    </group>
  );
}

/**
 * "…and N more." Drawn instead of the links that did not fit, never instead of
 * nothing: the census puts the sibling maximum at 50 against a p90 of 5, so a
 * page that overruns its window is rare and a reader who cannot tell that it
 * has is worse off than one who can.
 */
export function OverflowMark({
  count,
  width,
  height,
}: {
  count: number;
  width: number;
  height: number;
}) {
  const theme = useTheme();
  const fontType = React.useContext(FontContext);
  if (count <= 0) return null;
  return (
    <group>
      <mesh>
        <planeGeometry args={[width, height]} />
        <meshBasicMaterial
          color={theme.navBg}
          transparent
          opacity={0.5}
          depthWrite={false}
        />
      </mesh>
      <Text
        font={fontType}
        anchorX="center"
        anchorY="middle"
        position={[0, 0, 0.002]}
        fontSize={Math.min(height * 0.42, 0.018)}
        color={theme.mutedTextCol}
      >
        {`+${count} more`}
      </Text>
    </group>
  );
}
