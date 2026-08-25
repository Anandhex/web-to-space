/**
 * renderer/scene/__tests__/travel-motion.ts — a move never steps.
 *
 *   npm run test:travel
 *
 * The dice read as "blocky", and none of it was the easing curve. A transition
 * fails in the ORDER things happen in: how far round the board had got when the
 * document landed, which frame the swing-in started on. Both are invisible to a
 * screenshot and both are exactly reproducible from a timeline.
 *
 * So this drives the real state machine through scripted moves — a local page
 * that beats the leaving half, a slow network that does not, a parse that
 * stalls the frame loop on arrival — and measures the largest distance the pose
 * moves in one frame. A smooth move never exceeds the easing's own peak slope;
 * the build this replaces jumped a full 120° mid-turn on every local page,
 * because the arriving half started wherever the leaving half had got to
 * instead of at the far pose.
 *
 * The one step that IS allowed is the cross itself, and it is allowed only
 * because it happens AT the far pose, where the board is edge-on. That is what
 * `crossed at the far pose` checks.
 *
 * Pure — travel-motion.ts has no React and no R3F, which is the reason it is a
 * module of its own.
 */
import * as THREE from "three";

import { createTravelMotion } from "../travel-motion";

const DEG = 180 / Math.PI;
/** Must match travel-motion.ts. */
const HALF_S = 0.42;
const TURN = Math.PI / 2;

let checked = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, detail?: string): void {
  checked++;
  if (!cond) failures.push(detail ? `${name} — ${detail}` : name);
}

/**
 * The most a single frame may legitimately move the pose.
 *
 * `easeOutCubic` leaves the far pose at slope 3, so one frame of `dt` covers at
 * most 3·span·dt/HALF_S. Anything above that is a step, not a motion.
 */
function budget(dtS: number): number {
  return (3 * TURN * dtS) / HALF_S;
}

interface Script {
  name: string;
  /** ms after the door was taken that the navigation commits. */
  landAtMs: number;
  /** ms after that before the new plan is rendered — parse + map + layout + mount. */
  contentAtMs: number;
  /** Frame length in ms, given ms since the nav committed (-1 before it does). */
  frameMs: (sinceLandMs: number) => number;
}

const at60 = 1000 / 60;

function run(s: Script) {
  const m = createTravelMotion("turn");
  m.arm("left"); // the west door: the board leaves +90° about Y

  let plan: { id: string } = { id: "old" };
  let tMs = 0;
  let landed = false;
  const prev = new THREE.Vector3();
  let maxStep = 0;
  let maxStepPhase = "";
  let crossFrom = Number.NaN;
  let crossTo = Number.NaN;
  let sawCross = false;

  for (let i = 0; i < 2000; i++) {
    const dtMs = s.frameMs(landed ? tMs - s.landAtMs : -1);
    tMs += dtMs;

    if (!landed && tMs >= s.landAtMs) {
      landed = true;
      // Records what is rendered NOW, which is still the old document: the
      // parse has not even been kicked off at the moment the nav commits.
      m.land(plan);
    }
    if (landed && tMs >= s.landAtMs + s.contentAtMs) plan = { id: "new" };

    const before = m.phase;
    const wasY = m.pose.y;
    m.advance(dtMs / 1000, plan);

    const step = m.pose.distanceTo(prev);
    if (before === "crossing" && m.phase === "arriving") {
      sawCross = true;
      crossFrom = wasY;
      crossTo = m.pose.y;
    } else if (step > maxStep) {
      maxStep = step;
      maxStepPhase = before;
    }
    prev.copy(m.pose);
    if (m.phase === "idle" && landed) break;
  }

  const cap = budget(Math.max(at60, s.frameMs(0)) / 1000);
  check(
    `${s.name}: no frame steps`,
    maxStep <= cap * 1.05,
    `${(maxStep * DEG).toFixed(1)}° in "${maxStepPhase}", budget ${(cap * DEG).toFixed(1)}°`,
  );
  check(
    `${s.name}: crossed at the far pose`,
    sawCross &&
      Math.abs(Math.abs(crossFrom) - TURN) < 1e-6 &&
      Math.abs(crossTo + crossFrom) < 1e-6,
    sawCross
      ? `left ${(crossFrom * DEG).toFixed(1)}°, entered ${(crossTo * DEG).toFixed(1)}°`
      : "never crossed",
  );
  check(`${s.name}: settles at rest`, m.phase === "idle" && m.pose.length() < 1e-9);
  return { totalMs: tMs, maxStep };
}

// ── The moves ────────────────────────────────────────────────────────────
//
// `TRAVEL_LEAD_MS` asks for the document 180 ms into a 420 ms leaving half, so
// anything that answers in under ~240 ms lands MID-TURN. That is every local
// page and every warm cache — which is to say, the case the reader hits most.

const scripts: Script[] = [
  { name: "local page, lands mid-turn", landAtMs: 200, contentAtMs: 40, frameMs: () => at60 },
  { name: "warm cache, lands at once", landAtMs: 182, contentAtMs: 8, frameMs: () => at60 },
  { name: "slow network, lands after the turn", landAtMs: 1500, contentAtMs: 60, frameMs: () => at60 },
  {
    // Parse, map, layout, mount, then troika builds every glyph: a run of very
    // long frames beginning the moment the nav commits. The swing-in must not
    // be spent on them.
    name: "parse and mount stall the loop",
    landAtMs: 200,
    contentAtMs: 300,
    frameMs: (since) => (since >= 0 && since < 450 ? 150 : at60),
  },
  {
    // A scene that never recovers still has to finish the move.
    name: "sustained 20fps",
    landAtMs: 200,
    contentAtMs: 40,
    frameMs: () => 50,
  },
];

const runs = scripts.map((s) => ({ s, r: run(s) }));

// The stall must be waited out, not animated over: the whole point of the
// cross is that a move whose second half would land on 150 ms frames holds at
// the far pose until the frames come back.
const stall = runs.find((x) => x.s.name === "parse and mount stall the loop")!;
check(
  "the stall is waited out, not animated over",
  stall.r.totalMs > 200 + 450,
  `move finished at ${stall.r.totalMs.toFixed(0)}ms, stall ends at 650ms`,
);

// And a move that has nothing to wait for is not made slower by the machinery:
// leaving + a couple of settle frames + arriving, and no more.
const local = runs.find((x) => x.s.name === "local page, lands mid-turn")!;
check(
  "a ready document is not held up",
  local.r.totalMs < 2 * HALF_S * 1000 + 150,
  `${local.r.totalMs.toFixed(0)}ms`,
);

// ── The two directionless cases ──────────────────────────────────────────

// A minimap jump moves through the graph, not along a corridor: it arrives.
{
  const m = createTravelMotion("turn");
  m.land({ id: "x" });
  m.advance(0.016, { id: "y" });
  check("minimap jump arrives at rest", m.phase === "idle" && m.pose.length() === 0);
}

// ...and the move BEFORE it must not lend it an axis. `took` outliving its own
// move is how a jump ends up replaying the last door the reader took.
{
  const m = createTravelMotion("turn");
  m.arm("left");
  for (let i = 0; i < 40; i++) m.advance(0.016, { id: "old" });
  m.land({ id: "old" });
  for (let i = 0; i < 120; i++) m.advance(0.016, { id: "new" });
  check("the first move settles", m.phase === "idle");
  m.land({ id: "new" }); // a jump, with no arm() in front of it
  m.advance(0.016, { id: "newer" });
  check(
    "a settled move does not lend its axis to the next jump",
    m.phase === "idle" && m.pose.length() === 0,
    `phase=${m.phase} pose=${m.pose.toArray().map((v) => (v * DEG).toFixed(1))}`,
  );
}

// ── The slide says the same thing on a table ─────────────────────────────
{
  const m = createTravelMotion("slide");
  m.arm("right");
  const prev = new THREE.Vector3();
  let maxStep = 0;
  let span = 0;
  let landed = false;
  let plan = { id: "old" };
  for (let i = 0, tMs = 0; i < 2000; i++) {
    tMs += at60;
    if (!landed && tMs >= 200) {
      landed = true;
      m.land(plan);
    }
    if (landed && tMs >= 240) plan = { id: "new" };
    const before = m.phase;
    m.advance(at60 / 1000, plan);
    span = Math.max(span, m.pose.length());
    const step = m.pose.distanceTo(prev);
    if (!(before === "crossing" && m.phase === "arriving")) maxStep = Math.max(maxStep, step);
    prev.copy(m.pose);
    if (m.phase === "idle" && landed) break;
  }
  const cap = (3 * span * (at60 / 1000)) / HALF_S;
  check("slide: no frame steps", maxStep <= cap * 1.05,
    `${maxStep.toFixed(3)}m, budget ${cap.toFixed(3)}m`);
  check("slide: settles at rest", m.phase === "idle" && m.pose.length() < 1e-9);
}

// ── Report ───────────────────────────────────────────────────────────────

for (const f of failures) console.error("  ✗ " + f);
console.log("");
for (const { s, r } of runs)
  console.log(`  ${s.name.padEnd(36)} ${r.totalMs.toFixed(0).padStart(5)}ms  ` +
    `largest frame step ${(r.maxStep * DEG).toFixed(1)}°`);
console.log("");
console.log(`travel motion: ${checked - failures.length}/${checked} checks`);
console.log(failures.length === 0 ? "PASS" : `FAIL: ${failures.length} failing`);
process.exit(failures.length === 0 ? 0 : 1);
