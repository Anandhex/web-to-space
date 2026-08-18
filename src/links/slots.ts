/**
 * links/slots.ts — what goes in each direction, and in what order.
 *
 * The one piece of the directional-link design that every view needs and none
 * of them should own. A wall's strips, a deck's paths and a building's
 * corridors are three geometries for one decision:
 *
 *   1. the way back comes first, and its direction takes nothing else
 *   2. then the rest of the corridor the reader walked to get here
 *   3. then this page's own links, in reading order, until the window is full
 *   4. what does not fit is MARKED, never dropped
 *
 * Written once so the three views cannot drift apart on it — a reader who
 * learns that the nearest door west is the way back must find that true in the
 * building and on the dice alike.
 *
 * Pure: no three.js, no React, no metres. A view turns a slot into geometry;
 * this decides which slot.
 *
 * ── Scope ──
 *
 * `links` is the CURRENT RENDERED PAGE's references, not the document's. A
 * corridor belongs to the page the reader is on and other pages' corridors are
 * not live (docs/directional-links.md, "Decisions taken" item 5) — so the
 * caller filters by page before calling, and this never sees the rest.
 */
import { assignLateralSides, directionOf } from "./direction";
import {
  AXES,
  visible,
  type Axis,
  type NavState,
  type WindowBudget,
} from "./memory";
import type { SpatialLink } from "./types";

export type SlotKind =
  /** The reserved way back, on the axis the reader arrived from. */
  | "return"
  /** Further down the corridor the reader walked to get here. */
  | "travelled"
  /** A link on this page that has not been followed yet. */
  | "link";

export interface DirSlot {
  /** Stable across a re-render, so a view can key an eased group on it. */
  key: string;
  label: string;
  /** Absolute where one could be formed, else the raw href. */
  url: string;
  axis: Axis;
  kind: SlotKind;
  /** 1 = adjacent. Views use it for depth down a corridor or along a path. */
  distance: number;
  /** `travelled`/`return` only: where a selection jumps to. */
  historyIndex?: number;
  /** `link` only: the anchor primitive's id — the key its inline mark shares. */
  linkId?: string;
  /** `link` only: a citation, which the renderer may still mark as one. */
  citation?: boolean;
  /**
   * Past the window. NEVER DROPPED — the census puts the sibling maximum at 50
   * against a p90 of 5, so overflow is real and rare, and a reader who cannot
   * see that there is more is worse off than one who can see they must page.
   */
  overflow: boolean;
}

export interface SlotOptions {
  /** The current rendered page's references, in reading order. */
  links: readonly SpatialLink[];
  /** The tab's navigation memory. Null before the first document loads. */
  nav: NavState | null;
  budget: WindowBudget;
}

/** What each direction holds, nearest first. */
export type DirSlots = Record<Axis, DirSlot[]>;

export function buildSlots({ links, nav, budget }: SlotOptions): DirSlots {
  const out: DirSlots = { up: [], down: [], left: [], right: [] };

  // ── 1 & 2. The travelled path, return door first ──
  if (nav) {
    const seen = visible(nav, budget);
    for (const axis of AXES) {
      for (const v of seen[axis]) {
        out[axis].push({
          key: `nav-${v.historyIndex}-${axis}`,
          label: v.node.label,
          url: v.node.url,
          axis,
          kind: v.isReturn ? "return" : "travelled",
          distance: v.distance,
          historyIndex: v.historyIndex,
          overflow: false,
        });
      }
    }
  }

  // ── 3. This page's own links ──
  //
  // A reserved axis takes none of them: it holds the way back, and a sibling
  // that happened to sort first must not overwrite the reader's return.
  //
  // Snapshotted BEFORE anything is pushed. Recomputing it per link would let
  // each one it admitted shrink the room for the next, so a direction with two
  // free slots would take one link and mark the second as overflow.
  const free: Record<Axis, number> = { up: 0, down: 0, left: 0, right: 0 };
  for (const axis of AXES)
    free[axis] = nav?.axes[axis].reserved
      ? 0
      : Math.max(0, budget[axis] - out[axis].length);

  const up: SpatialLink[] = [];
  const down: SpatialLink[] = [];
  const lateral: SpatialLink[] = [];
  for (const l of links) {
    switch (directionOf(l)) {
      case "up":
        up.push(l);
        break;
      case "down":
        down.push(l);
        break;
      case "lateral":
        lateral.push(l);
        break;
      // `here` points at something this view already draws, and `inline` stays
      // at its anchor. Neither opens anything, so neither takes a slot.
      default:
        break;
    }
  }

  const push = (axis: Axis, l: SpatialLink, overflow: boolean) => {
    out[axis].push({
      key: `link-${l.id}-${axis}`,
      label: l.label,
      url: l.resolved,
      axis,
      kind: "link",
      distance: out[axis].length + 1,
      linkId: l.id,
      citation: l.citation,
      overflow,
    });
  };

  up.forEach((l, i) => push("up", l, i >= free.up));
  down.forEach((l, i) => push("down", l, i >= free.down));

  // Lateral fills right, overflows to left, then marks the rest.
  //
  // A RESERVED side is not a side to spill onto. Arriving eastward reserves
  // west for the way back, so a run of four siblings with three slots east
  // does not put its fourth in the reader's return door — it stays east and is
  // marked. `assignLateralSides` is only consulted when both sides are open;
  // when one is reserved the run is a single-sided fill, which is what the
  // reader is actually looking at.
  const leftOpen = free.left > 0;
  const rightOpen = free.right > 0;
  if (leftOpen && rightOpen) {
    for (const { item, side, slot } of assignLateralSides(lateral, free.right)) {
      const axis: Axis = side === "left" ? "left" : "right";
      push(axis, item, slot >= free[axis]);
    }
  } else {
    // One side, or neither. With neither, everything is marked — which is the
    // honest answer to "both lateral directions are spoken for".
    const axis: Axis = rightOpen || !leftOpen ? "right" : "left";
    lateral.forEach((l, i) => push(axis, l, i >= free[axis]));
  }

  return out;
}

/**
 * A window sized to the links actually present, so nothing overflows.
 *
 * The per-view windows in `memory.ts` are budgets for a view that must hold a
 * whole SECTION's worth of pages at once — the wall's outline board. A view
 * that has narrowed to ONE rendered page is in a
 * different situation: the census puts outbound links at a median of 0 and a
 * p90 of 7 per rendered page, so there is usually nothing to ration, and a
 * reader looking at one page wants that page's doors, all of them.
 *
 * Laterals are split evenly rather than piled on the right — with no cap to
 * overflow past, "fill right then spill left" would put every sibling on one
 * side and leave the other empty.
 *
 * The travelled path still takes its slots first: `nav` is passed so the way
 * back and the corridor behind it are counted in, not squeezed out by a page
 * that happens to be link-heavy.
 */
export function fitBudget(
  links: readonly SpatialLink[],
  nav: NavState | null,
): WindowBudget {
  let up = 0;
  let down = 0;
  let lateral = 0;
  for (const l of links) {
    switch (directionOf(l)) {
      case "up":
        up++;
        break;
      case "down":
        down++;
        break;
      case "lateral":
        lateral++;
        break;
      default:
        break;
    }
  }
  // Whatever the travelled path already occupies in a direction has to fit
  // alongside, or the corridor the reader walked would push their own page's
  // links into an overflow that has no reason to exist here.
  const walked = (axis: Axis): number => nav?.axes[axis].path.length ?? 0;

  // A reserved side takes no sibling at all, so the OPEN side has to hold the
  // whole run — half of it would leave the other half overflowing against a
  // door that was never going to open.
  const leftReserved = nav?.axes.left.reserved === true;
  const rightReserved = nav?.axes.right.reserved === true;
  const half = Math.ceil(lateral / 2);
  const leftShare = leftReserved ? 0 : rightReserved ? lateral : half;
  const rightShare = rightReserved ? 0 : leftReserved ? lateral : half;

  return {
    up: up + walked("up"),
    down: down + walked("down"),
    left: leftShare + walked("left"),
    right: rightShare + walked("right"),
  };
}

/** The slots a view actually draws — overflow marked but not enumerated. */
export function drawable(slots: readonly DirSlot[]): DirSlot[] {
  return slots.filter((s) => !s.overflow);
}

/** How many a direction could not show. Views draw a count, not nothing. */
export function overflowCount(slots: readonly DirSlot[]): number {
  return slots.reduce((n, s) => n + (s.overflow ? 1 : 0), 0);
}
