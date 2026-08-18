/**
 * links/__tests__/memory.ts — navigation memory, asserted.
 *
 *   npm run test:memory
 *
 * The four cases the build plan names — reserve-on-arrival, path growth past
 * the window, back, and jump — plus the one the plan does not name and which
 * broke the first implementation: a TURN. Going east and then north leaves the
 * reader one move into a second corridor, and an absolute-axis model puts the
 * way back on no axis at all, stranding them. It is the cheapest possible
 * two-move sequence and it has to be in the test.
 *
 * Pure, no DOM, no three.js — the same discipline `classify.ts` follows.
 */
import {
  AXES,
  axisFor,
  back,
  canTake,
  current,
  enter,
  freeSlots,
  initNav,
  jump,
  opposite,
  visible,
  windowFor,
  type Axis,
  type NavState,
} from "../memory";

let checked = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, detail?: string): void {
  checked++;
  if (!cond) failures.push(detail ? `${name} — ${detail}` : name);
}

function eq<T>(name: string, got: T, want: T): void {
  check(name, Object.is(got, want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
}

/** The urls in a direction, nearest first — the shape most assertions want. */
function dir(state: NavState, budget: ReturnType<typeof windowFor>, axis: Axis): string[] {
  return visible(state, budget)[axis].map((v) => v.node.url);
}

const WALL = windowFor("wall"); // up 2, down 2, left 3, right 3
const DECK = windowFor("deck"); // 5 each way

// ── 1. A fresh session reserves nothing ──────────────────────────────────

{
  const s = initNav("https://a.example/", "a");
  eq("root: at", s.at, 0);
  eq("root: arrivedFrom", s.arrivedFrom, null);
  for (const a of AXES) check(`root: ${a} free`, canTake(s, a));
  for (const a of AXES) eq(`root: ${a} empty`, dir(s, WALL, a).length, 0);
  const free = freeSlots(s, WALL);
  eq("root: right budget intact", free.right, 3);
  eq("root: up budget intact", free.up, 2);
}

// ── 2. Reserve on arrival ────────────────────────────────────────────────
//
// Arriving eastward means west holds the way back and takes no new link; the
// other three keep their full budget.

{
  let s = initNav("https://a.example/", "a");
  s = enter(s, { url: "https://b.example/", label: "b", axis: "right" });

  eq("arrival: standing on b", current(s).url, "https://b.example/");
  eq("arrival: arrivedFrom", s.arrivedFrom, "left");
  check("arrival: left reserved", !canTake(s, "left"));
  check("arrival: right free", canTake(s, "right"));
  check("arrival: up free", canTake(s, "up"));
  check("arrival: down free", canTake(s, "down"));

  const seen = visible(s, WALL);
  eq("arrival: way back is west", seen.left[0]?.node.url, "https://a.example/");
  check("arrival: way back is flagged", seen.left[0]?.isReturn === true);
  eq("arrival: way back is adjacent", seen.left[0]?.distance, 1);

  const free = freeSlots(s, WALL);
  eq("arrival: reserved axis takes nothing", free.left, 0);
  eq("arrival: right keeps its budget", free.right, 3);
  eq("arrival: up keeps its budget", free.up, 2);
  eq("arrival: down keeps its budget", free.down, 2);
}

// ── 3. A path, not a set: east four times is a four-long corridor ────────

{
  let s = initNav("https://0.example/", "0");
  for (let i = 1; i <= 4; i++)
    s = enter(s, { url: `https://${i}.example/`, label: String(i), axis: "right" });

  eq("corridor: history is 5 long", s.history.length, 5);
  eq("corridor: standing at the far end", current(s).url, "https://4.example/");
  eq("corridor: lattice coordinate", current(s).coord.x, 4);

  // Looking back west: 3, 2, 1, 0 — four documents, nearest first.
  const all = s.axes.left.path.map((n) => n.url);
  eq("corridor: memory holds all four", all.length, 4);
  eq(
    "corridor: nearest first",
    all.join(" "),
    "https://3.example/ https://2.example/ https://1.example/ https://0.example/",
  );
  eq("corridor: the whole run is walked", s.axes.left.walked, 4);

  // ── The window is a RENDER budget, not a memory budget ──
  const wall = dir(s, WALL, "left");
  eq("window: wall draws 3 of the 4", wall.length, 3);
  eq("window: and drops the furthest", wall.includes("https://0.example/"), false);
  const deck = dir(s, DECK, "left");
  eq("window: deck draws all 4", deck.length, 4);
  eq("window: memory was not truncated", s.history.length, 5);

  // Walking back one brings the fourth into view — the proof that clamping
  // happened at render time and nothing was lost.
  const stepped = back(s);
  check("window: the dropped one reappears", dir(stepped, WALL, "left").includes("https://0.example/"));
}

// ── 4. A turn ────────────────────────────────────────────────────────────
//
// East then north. The way back must be SOUTH, and the eastern document must
// not vanish. An absolute-axis model fails exactly here.

{
  let s = initNav("https://a.example/", "a");
  s = enter(s, { url: "https://b.example/", label: "b", axis: "right" });
  s = enter(s, { url: "https://c.example/", label: "c", axis: "up" });

  eq("turn: standing on c", current(s).url, "https://c.example/");
  eq("turn: coordinate", `${current(s).coord.x},${current(s).coord.y}`, "1,1");
  eq("turn: arrivedFrom", s.arrivedFrom, "down");
  check("turn: down reserved", !canTake(s, "down"));
  check("turn: left NOT reserved — that corridor is behind the corner", canTake(s, "left"));

  const seen = visible(s, WALL);
  eq("turn: the way back is south", seen.down[0]?.node.url, "https://b.example/");
  check("turn: and it is flagged", seen.down[0]?.isReturn === true);
  // The run ended at the corner, so `a` is diagonal from here and renders
  // nowhere. It is still in history, which is what the minimap draws.
  eq("turn: the run stops at the corner", seen.down.length, 1);
  eq("turn: nothing stranded on the left", seen.left.length, 0);
  check("turn: but a is still in history", s.history.some((n) => n.url === "https://a.example/"));
}

// ── 5. Back ──────────────────────────────────────────────────────────────

{
  let s = initNav("https://a.example/", "a");
  s = enter(s, { url: "https://b.example/", label: "b", axis: "right" });
  s = enter(s, { url: "https://c.example/", label: "c", axis: "up" });
  const returned = back(s);

  eq("back: lands on b", current(returned).url, "https://b.example/");
  eq("back: history keeps c", returned.history.length, 3);
  eq("back: b's own arrival still reserves west", returned.arrivedFrom, "left");
  eq("back: the way back from b", dir(returned, WALL, "left")[0], "https://a.example/");
  // c was opened from b and stepped out of; the door north stays open.
  eq("back: the branch north stays open", dir(returned, WALL, "up")[0], "https://c.example/");
  check("back: a branch is not a retrace", returned.axes.up.walked === 0);
  check("back: so north is still free to take a link", canTake(returned, "up"));
  eq("back: north budget minus the branch", freeSlots(returned, WALL).up, 1);

  const atRoot = back(returned);
  eq("back: reaches the root", current(atRoot).url, "https://a.example/");
  eq("back: root reserves nothing", atRoot.arrivedFrom, null);
  eq("back: at the root it is a no-op", back(atRoot).at, atRoot.at);
}

// ── 6. Jump ──────────────────────────────────────────────────────────────

{
  let s = initNav("https://a.example/", "a");
  s = enter(s, { url: "https://b.example/", label: "b", axis: "right" });
  s = enter(s, { url: "https://c.example/", label: "c", axis: "up" });
  s = enter(s, { url: "https://d.example/", label: "d", axis: "down" });

  const jumped = jump(s, 1); // straight to b, three moves away
  eq("jump: lands on b", current(jumped).url, "https://b.example/");
  eq("jump: history is untouched", jumped.history.length, 4);
  eq("jump: corridors are re-derived, not carried", jumped.arrivedFrom, "left");
  eq("jump: b's way back", dir(jumped, WALL, "left")[0], "https://a.example/");
  eq("jump: b's northern branch", dir(jumped, WALL, "up")[0], "https://c.example/");

  eq("jump: out of range is a no-op (high)", jump(s, 99).at, s.at);
  eq("jump: out of range is a no-op (low)", jump(s, -1).at, s.at);

  // Deriving from history rather than mutating means a jump and a walk to the
  // same node produce the same state. That is the property that stops the
  // corridors drifting out of agreement with the minimap.
  const walked = back(back(s));
  eq("jump: a jump equals the walk", JSON.stringify(jumped.axes), JSON.stringify(walked.axes));
}

// ── 7. Re-entering a corridor does not duplicate it ──────────────────────

{
  let s = initNav("https://a.example/", "a");
  s = enter(s, { url: "https://b.example/", label: "b", axis: "right" });
  s = back(s);
  s = enter(s, { url: "https://b.example/", label: "b", axis: "right" });

  eq("re-enter: history did not grow", s.history.length, 2);
  eq("re-enter: standing on b", current(s).url, "https://b.example/");
  eq("re-enter: one entry west, not two", dir(s, WALL, "left").length, 1);
}

// ── 8. The small pure helpers ────────────────────────────────────────────

{
  eq("opposite: up", opposite("up"), "down");
  eq("opposite: left", opposite("left"), "right");
  for (const a of AXES) eq(`opposite: ${a} is an involution`, opposite(opposite(a)), a);

  eq("axisFor: up", axisFor("up"), "up");
  eq("axisFor: down", axisFor("down"), "down");
  eq("axisFor: lateral defaults right", axisFor("lateral"), "right");
  eq("axisFor: lateral left", axisFor("lateral", "left"), "left");
  eq("axisFor: here does not travel", axisFor("here"), null);
  eq("axisFor: inline does not travel", axisFor("inline"), null);

  eq("windowFor: wall lateral", windowFor("wall").left, 3);
  eq("windowFor: deck", windowFor("deck").up, 5);
  // The fallback is its own constant, not a borrowed view's — see
  // DEFAULT_WINDOW. This check caught it borrowing rooms' budget and following
  // it upward when rooms was retuned.
  eq("windowFor: unknown falls back to the tightest", windowFor("nope").up, 2);
  eq("windowFor: rooms is walked, so it is not the tightest", windowFor("rooms").up, 4);
}

// ── Report ───────────────────────────────────────────────────────────────

for (const f of failures) console.error("  ✗ " + f);
console.log("");
console.log(`navigation memory: ${checked - failures.length}/${checked} checks`);
console.log(failures.length === 0 ? "PASS" : `FAIL: ${failures.length} failing`);
process.exit(failures.length === 0 ? 0 : 1);
