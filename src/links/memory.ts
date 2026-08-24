/**
 * links/memory.ts — where the reader has been, and what is still rendered.
 *
 * Shared by all four views and VIEW-INDEPENDENT: nothing here knows about
 * three.js, metres, faces, floors or tables. A view asks two questions —
 * "what is in each direction from here" and "which direction is the way back"
 * — and gets nodes, never positions. Pure, so it runs under `tsx` in Node the
 * same way `classify.ts` does; `__tests__/memory.ts` scores it.
 *
 * ── The two budgets, which are not the same budget ──
 *
 * The MEMORY is unbounded. Every document the reader has opened stays in
 * `history` for as long as the tab lives, and the minimap reads that.
 *
 * The WINDOW is a render budget — how many of those documents a view draws at
 * once. The wall draws 3 laterally each side; the deck draws 5 per direction.
 * Exceeding a window never truncates history, it only stops drawing.
 *
 * ── Corridors are reader-relative, and that is not the spec's sketch ──
 *
 * The spec sketches `NavAxis { path, cursor, reserved }` with the axes read as
 * absolute corridors from the session origin and `cursor` as how far out along
 * one the reader stands. That shape cannot represent a turn. Go east and then
 * north: the reader stands at the northern document, but on an absolute east
 * axis the cursor still points at the eastern one, so the eastern document —
 * which is the way back — renders in no direction at all, and the reader is
 * stranded one move into their second corridor.
 *
 * So the corridors here are RELATIVE to where the reader stands, and `path`
 * holds what lies in that direction from them, nearest first. `walked`
 * replaces `cursor`: it says how many of those entries are a retrace (the run
 * the reader came along) rather than a branch they stepped back out of.
 *
 * "Going east four times is a four-long east corridor" survives intact — after
 * four eastward moves the reader looks west down a four-long corridor of the
 * documents they walked through. It is the same corridor, described from the
 * reader rather than from the origin, and describing it from the reader is
 * what a headset reader can actually check.
 *
 * ── What a corridor holds, and what it does not ──
 *
 * A corridor holds only TRAVELLED documents: the unbroken run of same-axis
 * moves that ends where the reader stands, plus any branch they opened from
 * this exact node and came back out of. Once the run turns a corner the rest
 * of the ancestry is no longer on any single axis — it is diagonal on the
 * lattice — and it belongs to the minimap, which draws the lattice honestly.
 * A branch explored three documents ago is in `history` and not in the
 * geometry, because the reader is not standing anywhere near it.
 *
 * The remaining slots in a direction are filled by the CURRENT PAGE's own
 * links, which the view supplies; memory's job is only to say how many slots
 * the travelled path has already claimed and which one is reserved.
 *
 * ── Non-commutativity ──
 *
 * East-then-north does not land where north-then-east does, and no flat
 * four-axis structure can represent both. The dice re-normalises after every
 * move for exactly this reason (docs/directional-links.md, "Decisions taken"
 * item 3): the geometry is re-derived from where the reader now stands, and
 * `history` — which stays true — is what the minimap draws.
 */
import type { LateralSide, LinkDirection } from "./direction";

/**
 * The four travelled directions, resolved. `lateral` from `direction.ts` has
 * split into left and right by the time it reaches memory, because a corridor
 * has a side and a classification does not.
 */
export type Axis = "up" | "down" | "left" | "right";

export const AXES: readonly Axis[] = ["up", "down", "left", "right"];

export function opposite(axis: Axis): Axis {
  switch (axis) {
    case "up":
      return "down";
    case "down":
      return "up";
    case "left":
      return "right";
    case "right":
      return "left";
  }
}

/** The axis a classified direction travels, or null when it does not travel. */
export function axisFor(
  direction: LinkDirection,
  side: LateralSide = "right",
): Axis | null {
  switch (direction) {
    case "up":
      return "up";
    case "down":
      return "down";
    case "lateral":
      return side === "left" ? "left" : "right";
    case "here":
    case "inline":
      return null;
  }
}

/** Lattice coordinate. right/up are positive; the minimap plots this directly. */
export interface NavCoord {
  x: number;
  y: number;
}

export interface NavNode {
  /** Absolute URL of the document. The identity of a node. */
  url: string;
  label: string;
  /** The axis travelled to REACH this node; null on the session root. */
  direction: Axis | null;
  /** Index in `history` of the node this was reached from; -1 on the root. */
  from: number;
  /** Where it sits on the lattice, for the minimap. */
  coord: NavCoord;
}

export interface NavAxis {
  /**
   * Travelled documents lying in this direction FROM WHERE THE READER STANDS,
   * nearest first. See the header for why this is relative and not absolute.
   */
  path: NavNode[];
  /**
   * How many leading entries of `path` are a retrace — the run of same-axis
   * moves the reader arrived along. The rest are branches they opened from
   * this node and stepped back out of. Only the reserved axis can have
   * `walked > 0`, since only one direction can be the way back.
   */
  walked: number;
  /**
   * This axis holds the way back from where the reader now stands, so it does
   * not take a new link. Arriving eastward reserves west; the other three keep
   * their full budget.
   */
  reserved: boolean;
}

export interface NavState {
  axes: Record<Axis, NavAxis>;
  /** Unbounded. `history[0]` is the session root; the minimap reads all of it. */
  history: NavNode[];
  /** Index in `history` of where the reader is now. */
  at: number;
  /** The axis holding the way back — `opposite` of the one just travelled. */
  arrivedFrom: Axis | null;
}

/** How many slots a view renders in each direction. Never truncates history. */
export interface WindowBudget {
  up: number;
  down: number;
  left: number;
  right: number;
}

/**
 * The per-view windows.
 *
 * These ration a direction that many pages are competing for. A view that has
 * narrowed to ONE rendered page ignores them and shows every link that page
 * has — see `links/slots.ts`'s `fitBudget`, and the census figure behind it:
 * outbound links are a median of 0 and a p90 of 7 per rendered page.
 */
const WINDOWS: Record<string, WindowBudget> = {
  wall: { up: 2, down: 2, left: 3, right: 3 },
  deck: { up: 5, down: 5, left: 5, right: 5 },
  // Rooms' corridor is WALKED, not glanced down, so its budget is what a
  // reader will actually walk to the end of: four a direction is two ranks of
  // eight doors, about ten metres.
  rooms: { up: 4, down: 4, left: 4, right: 4 },
};

/**
 * The window an unknown view gets.
 *
 * Its own constant rather than a borrowed one. It used to be `WINDOWS.rooms`,
 * which was the tightest at the time and then stopped being — rooms' corridor
 * is walked rather than glanced down, so its budget went up and the fallback
 * silently went up with it. A default that moves when an unrelated view is
 * retuned is not a default.
 */
const DEFAULT_WINDOW: WindowBudget = { up: 2, down: 2, left: 2, right: 2 };

/** The window for a view. An unknown name gets the tightest budget there is. */
export function windowFor(viewMode: string | undefined): WindowBudget {
  return WINDOWS[viewMode ?? ""] ?? DEFAULT_WINDOW;
}

// ── Construction and moves ───────────────────────────────────────────────

interface NavMove {
  url: string;
  label: string;
  axis: Axis;
}

export function initNav(url: string, label: string): NavState {
  const root: NavNode = {
    url,
    label,
    direction: null,
    from: -1,
    coord: { x: 0, y: 0 },
  };
  return finalise({ history: [root], at: 0 });
}

/**
 * Follow a link. Appends a node to `history` and stands the reader on it.
 *
 * Re-entering a document already reached from this exact node by this exact
 * axis does not duplicate it — the reader is walking a corridor they have
 * walked, and a corridor with the same page twice in adjacent slots is a bug
 * the reader would read as two different documents.
 */
export function enter(state: NavState, move: NavMove): NavState {
  const existing = state.history.findIndex(
    (n) => n.from === state.at && n.direction === move.axis && n.url === move.url,
  );
  if (existing >= 0) return jump(state, existing);

  const here = state.history[state.at];
  const node: NavNode = {
    url: move.url,
    label: move.label,
    direction: move.axis,
    from: state.at,
    coord: step(here.coord, move.axis),
  };
  const history = [...state.history, node];
  return finalise({ history, at: history.length - 1 });
}

/**
 * Retreat along the reserved axis. A no-op at the session root, which has
 * nowhere to go back to — the caller renders no back door there.
 */
export function back(state: NavState): NavState {
  const from = state.history[state.at]?.from ?? -1;
  if (from < 0) return state;
  return jump(state, from);
}

/** Move the reader to any node the minimap offers. Out-of-range is a no-op. */
export function jump(state: NavState, historyIndex: number): NavState {
  if (historyIndex < 0 || historyIndex >= state.history.length) return state;
  return finalise({ history: state.history, at: historyIndex });
}

/** The node the reader is standing on. */
export function current(state: NavState): NavNode {
  return state.history[state.at];
}

/** True when a direction is free to take a new link — i.e. not the way back. */
export function canTake(state: NavState, axis: Axis): boolean {
  return !state.axes[axis].reserved;
}

// ── Rendering ────────────────────────────────────────────────────────────

/** One rendered slot: a travelled node and how to describe it to the reader. */
interface VisibleNode {
  node: NavNode;
  /** Its index in `history`, so a click can `jump` straight to it. */
  historyIndex: number;
  /** This is the way back — the reserved slot on the arrival direction. */
  isReturn: boolean;
  /** Steps from the reader: 1 is the adjacent document. */
  distance: number;
}

/**
 * What each direction shows, clamped to the window.
 *
 * `path` is already reader-relative and nearest-first, so this is a slice —
 * the projection the absolute model needed happens once, in `finalise`.
 *
 * The window clamps what comes out and never touches `history`: a reader four
 * documents deep in a corridor a view draws three of still has all four in the
 * minimap, and walking back one brings the fourth into view.
 */
export function visible(
  state: NavState,
  budget: WindowBudget,
): Record<Axis, VisibleNode[]> {
  const index = new Map<NavNode, number>();
  state.history.forEach((n, i) => index.set(n, i));

  const out: Record<Axis, VisibleNode[]> = { up: [], down: [], left: [], right: [] };
  for (const axis of AXES) {
    const { path, walked, reserved } = state.axes[axis];
    out[axis] = path.slice(0, budget[axis]).map((node, i) => ({
      node,
      historyIndex: index.get(node) ?? -1,
      // Only the nearest entry of a retrace run on the reserved axis is the
      // way back; everything past it is a document further along that run.
      isReturn: i === 0 && reserved && walked > 0,
      distance: i + 1,
    }));
  }
  return out;
}

/**
 * How many slots a direction has left for the CURRENT page's own links, after
 * the travelled path and the reserved return have taken theirs.
 *
 * A reserved direction returns 0: it holds the way back and does not take a
 * new link, which is the rule that stops a reader's return door being
 * overwritten by whichever sibling happened to sort first.
 */
export function freeSlots(
  state: NavState,
  budget: WindowBudget,
  seen: Record<Axis, VisibleNode[]> = visible(state, budget),
): Record<Axis, number> {
  const out: Record<Axis, number> = { up: 0, down: 0, left: 0, right: 0 };
  for (const axis of AXES) {
    if (state.axes[axis].reserved) continue;
    out[axis] = Math.max(0, budget[axis] - seen[axis].length);
  }
  return out;
}

// ── Derivation ───────────────────────────────────────────────────────────

function step(from: NavCoord, axis: Axis): NavCoord {
  switch (axis) {
    case "up":
      return { x: from.x, y: from.y + 1 };
    case "down":
      return { x: from.x, y: from.y - 1 };
    case "left":
      return { x: from.x - 1, y: from.y };
    case "right":
      return { x: from.x + 1, y: from.y };
  }
}

/**
 * Rebuild `axes` and `arrivedFrom` from `history` and the reader's position.
 *
 * Derived rather than mutated on purpose: `back` and `jump` land the reader
 * anywhere in an unbounded history, and a structure carried forward across
 * those moves drifts out of agreement with the history the minimap draws. This
 * way there is one source of truth and the corridors cannot disagree with it.
 */
function finalise({ history, at }: { history: NavNode[]; at: number }): NavState {
  const axes: Record<Axis, NavAxis> = {
    up: { path: [], walked: 0, reserved: false },
    down: { path: [], walked: 0, reserved: false },
    left: { path: [], walked: 0, reserved: false },
    right: { path: [], walked: 0, reserved: false },
  };

  const here = history[at];
  const arrivedFrom =
    here && here.direction !== null ? opposite(here.direction) : null;
  if (arrivedFrom) axes[arrivedFrom].reserved = true;

  // ── The retrace run ──
  //
  // Walk the ancestry backwards while every move used the SAME axis. Those
  // documents all lie behind the reader on one line, so they render in the
  // return direction, nearest first. The first turn ends the run: past it the
  // ancestry is diagonal on the lattice and no direction describes it, which
  // is what the minimap is for.
  if (here && here.direction !== null && arrivedFrom) {
    const runAxis = here.direction;
    for (let i = here.from; i >= 0; ) {
      const n = history[i];
      if (!n) break;
      axes[arrivedFrom].path.push(n);
      if (n.direction !== runAxis) break; // this node is the run's far end
      i = n.from;
    }
    axes[arrivedFrom].walked = axes[arrivedFrom].path.length;
  }

  // ── Branches ──
  //
  // Documents reached from this exact node and stepped back out of. They are
  // still ahead of the reader in the direction they were taken, so the door
  // that opened them stays open — the reader does not have to remember that a
  // corridor they already used is there.
  for (const n of history) {
    if (n.from !== at || n.direction === null) continue;
    if (axes[n.direction].path.includes(n)) continue;
    axes[n.direction].path.push(n);
  }

  return { axes, history, at, arrivedFrom };
}
