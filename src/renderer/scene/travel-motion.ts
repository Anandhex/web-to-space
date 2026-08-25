/**
 * scene/travel-motion.ts — the move itself, with no React in it.
 *
 * Split out of `travel.tsx` so it can be driven frame by frame off a headset. A
 * transition is the one piece of this renderer whose bugs are all in the ORDER
 * things happen in — how far round the board had got when the document landed,
 * which frame the swing started on — and a scripted timeline is the only way to
 * see that order without a stopwatch and a device on your face. See the header
 * of `travel.tsx` for what the move is and what it used to get wrong.
 */
import * as THREE from "three";

import type { Axis } from "../../links/memory";

/** How a view expresses travel. */
export type TravelMode =
  /** A face turns away and the next turns in — the wall's dice. */
  | "turn"
  /** The world translates past — the deck's table. */
  | "slide";

/**
 * Seconds each half takes.
 *
 * 0.42 s is long enough to read as travel and short enough not to be a wait.
 * The first build ran the leaving half in about 0.26 s of exponential decay,
 * which is roughly 0.1 s of visible movement and then a settle — the reader
 * reported it as "it turns and then the other frame just appears", which is
 * exactly what a too-fast half plus a missing half looks like.
 */
const HALF_S = 0.42;

/** How far the world travels on a slide, metres. */
const TRAVEL_SLIDE = 1.15;

/**
 * The largest slice of time one frame is allowed to advance the move by.
 *
 * A clamp, not a cap on the duration: a 200 ms hitch that advanced the motion
 * by its true 200 ms would move the board halfway round in a single step,
 * which is the one thing an animation must never do — the reader reads a big
 * step as a broken frame, and a slightly longer turn as nothing at all. At
 * 1/20 s no frame can move it more than an eighth of a half.
 */
const MAX_STEP = 1 / 20;

/** A frame at least this quick means the scene is being drawn, not built. */
const CALM_DT = 1 / 30;

/** How many of those in a row before the arriving half is allowed to start. */
const CALM_FRAMES = 2;

/**
 * Longest the cross may wait, seconds.
 *
 * A scene that never gets back to 30 fps must still complete the move: holding
 * at the far pose forever would leave the reader looking at an edge-on board
 * with no way to tell that anything arrived.
 */
const CROSS_CAP_S = 1.2;

/** Accelerating away — the first half of `easeInOutCubic`, rescaled. */
function easeInCubic(t: number): number {
  return t * t * t;
}

/** Settling in — the second half of the same cubic. */
function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

/** The pose a direction takes the CURRENT document to. */
function leavingPose(mode: TravelMode, axis: Axis | null): THREE.Vector3 {
  const v = new THREE.Vector3(0, 0, 0);
  if (!axis) return v;
  if (mode === "turn") {
    // A board in the XY plane facing +Z. +90° about Y sends the front normal
    // (0,0,1) to (1,0,0): the face turns east, which is the WEST door's case —
    // the door you picked is the side the next face arrives from, so this one
    // leaves the opposite way. Up and down are the same argument about X.
    if (axis === "left") v.set(0, Math.PI / 2, 0);
    else if (axis === "right") v.set(0, -Math.PI / 2, 0);
    else if (axis === "up") v.set(Math.PI / 2, 0, 0);
    else v.set(-Math.PI / 2, 0, 0);
    return v;
  }
  // Slide: the world moves the opposite way to the direction taken, which is
  // what makes the reader feel they went that way rather than that the table
  // came to them.
  if (axis === "left") v.set(TRAVEL_SLIDE, 0, 0);
  else if (axis === "right") v.set(-TRAVEL_SLIDE, 0, 0);
  else if (axis === "up") v.set(0, -TRAVEL_SLIDE, 0);
  else v.set(0, TRAVEL_SLIDE, 0);
  return v;
}

type Phase = "idle" | "leaving" | "crossing" | "arriving";

const REST = new THREE.Vector3(0, 0, 0);

export interface TravelMotion {
  readonly mode: TravelMode;
  readonly phase: Phase;
  /** Rotation (turn) or position (slide) to apply this frame. Mutated in place. */
  readonly pose: THREE.Vector3;
  /** The reader took a door: start the leaving half. */
  arm(axis: Axis): void;
  /**
   * The next document's navigation committed.
   *
   * `contentKey` is whatever the caller uses to identify what is currently
   * RENDERED — the layout plan's identity. It is recorded, not compared: the
   * cross ends when the key stops being this one, which is the only signal
   * from inside the frame loop that the new document is really on screen.
   */
  land(contentKey?: unknown): void;
  /** One frame. `dt` is the real elapsed time; the clamp is applied inside. */
  advance(dt: number, contentKey?: unknown): void;
}

/**
 * The move, as a state machine with no React in it.
 *
 * Pulled out of the component so it can be driven frame by frame off a headset
 * — a transition is the one piece of this renderer whose bugs are all in the
 * ORDER things happen in, and a scripted timeline is the only way to see that
 * order without a stopwatch and a headset.
 */
export function createTravelMotion(mode: TravelMode): TravelMotion {
  const pose = new THREE.Vector3();
  /** Where the current half started from. */
  const origin = new THREE.Vector3();
  /** The far pose: where the leaving half ends and the cross waits. */
  const away = new THREE.Vector3();
  /** The opposite far pose: where the next document enters from. */
  const back = new THREE.Vector3();

  let phase: Phase = "idle";
  /** Seconds into the current half. */
  let t = 0;
  /** The direction the move in flight was taken in, kept past `axis` clearing. */
  let took: Axis | null = null;
  /** The nav has committed; the cross may end as soon as the content is up. */
  let landed = false;
  /** What was rendered when it committed — see `land`. */
  let keyAtLand: unknown;
  /** Real seconds spent at the far pose, against `CROSS_CAP_S`. */
  let waited = 0;
  /** Consecutive frames quick enough to animate over. */
  let calm = 0;

  /** Park at the far pose and wait for the next document. */
  function park() {
    phase = "crossing";
    t = 0;
    waited = 0;
    calm = 0;
    pose.copy(away);
  }

  /**
   * Turn the dice over.
   *
   * The pose jumps by twice the far pose in one step, which is the whole point
   * and is invisible precisely because it happens AT the far pose: edge-on the
   * board is a sliver, and on a table the world is already off to the side.
   * The same jump anywhere else in the turn is the stutter this used to have.
   */
  function cross() {
    pose.copy(back);
    origin.copy(back);
    phase = "arriving";
    t = 0;
  }

  function settle() {
    phase = "idle";
    pose.set(0, 0, 0);
    origin.set(0, 0, 0);
    // Cleared, so the NEXT thing to land without a direction — a minimap jump,
    // which moves through the graph rather than along a corridor — arrives at
    // rest instead of replaying the axis of the move before it.
    took = null;
    landed = false;
    keyAtLand = undefined;
    t = 0;
  }

  return {
    mode,
    get phase() {
      return phase;
    },
    pose,

    arm(axis: Axis) {
      took = axis;
      landed = false;
      keyAtLand = undefined;
      origin.copy(pose);
      away.copy(leavingPose(mode, axis));
      back.copy(away).multiplyScalar(-1);
      t = 0;
      phase = "leaving";
    },

    land(contentKey?: unknown) {
      if (!took) {
        // No direction — arrive rather than travel.
        settle();
        return;
      }
      landed = true;
      keyAtLand = contentKey;
      // A fetch slower than the leaving half lands with the board already
      // parked; one faster than it lands mid-turn and is queued, which is what
      // keeps the flip at the far pose.
      if (phase === "idle") park();
    },

    advance(dt: number, contentKey?: unknown) {
      const step = Math.min(Math.max(dt, 0), MAX_STEP);

      if (phase === "leaving") {
        t += step;
        const a = Math.min(1, t / HALF_S);
        pose.lerpVectors(origin, away, easeInCubic(a));
        if (a >= 1) park();
        return;
      }

      if (phase === "crossing") {
        // Real time, not the clamped step: the cap exists to bound how long the
        // reader waits, and a stalled frame is exactly the wait it bounds.
        waited += Math.max(dt, 0);
        if (!landed) return;
        // With no `contentKey` from the caller there is nothing to wait on but
        // the frame rate.
        const swapped = keyAtLand === undefined || contentKey !== keyAtLand;
        calm = swapped && dt <= CALM_DT ? calm + 1 : 0;
        if (calm >= CALM_FRAMES || waited >= CROSS_CAP_S) cross();
        return;
      }

      if (phase === "arriving") {
        t += step;
        const b = Math.min(1, t / HALF_S);
        pose.lerpVectors(origin, REST, easeOutCubic(b));
        if (b >= 1) settle();
      }
    },
  };
}

