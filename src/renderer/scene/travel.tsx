/**
 * scene/travel.tsx — the two halves of a move.
 *
 * A directional move has a LEAVING half and an ARRIVING half, and the first
 * build only had the first one. The board turned away, the fetch landed, and
 * the next document was snapped into place at rest — so what the reader saw
 * was a turn followed by a cut. The direction they had just chosen was
 * animated; the direction they had just gone was not.
 *
 * So a move is one continuous motion in one direction, in two parts:
 *
 *   leaving   the current document rotates/slides away, the way the door said
 *   held      it stays away for as long as the fetch takes
 *   arriving  the NEW document enters from the opposite side, completing the
 *             same motion, and settles at rest
 *
 * Take the west door and this page swings off east while the next one comes
 * round from the west — one turn of a dice, not two half-turns that meet in a
 * cut. The slide is the same claim on a table.
 *
 * ── Duration, not decay ──
 *
 * Eased over a fixed duration rather than by exponential smoothing. Decay is
 * fast and then asymptotic: most of the travel happens in the first few frames
 * and the rest is a crawl the eye reads as "already arrived". A move the reader
 * is supposed to feel as travel needs the opposite shape — ease in, cross, ease
 * out — which is what `easeInOutCubic` over a fixed time gives.
 *
 * ── The one hazard ──
 *
 * The per-frame body is wrapped. An uncaught throw inside an XR frame ends
 * rendering permanently and the headset falls back to its loading environment
 * with nothing surfaced; a transition is not allowed to be that throw.
 */
import React from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";

import type { Axis } from "../../links/memory";

/** How a view expresses travel. */
type TravelMode =
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

function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
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

type Phase = "idle" | "leaving" | "held" | "arriving";

/**
 * Wraps a view's whole world and plays the move.
 *
 * `axis` is the direction the reader took, held for as long as the move is in
 * flight and cleared on arrival. `resetKey` changes when a new document lands —
 * that is the cue to jump to the far side and swing in.
 *
 * `pivot` matters for `turn` and is ignored for `slide`: the wall's board hangs
 * a metre and a half in front of the reader and well off the world origin, so a
 * rotation applied at the origin swings it AROUND them on a metre-and-a-half
 * arc instead of turning it in place.
 */
export function TravelGroup({
  axis,
  resetKey,
  mode,
  pivot,
  children,
}: {
  axis: Axis | null;
  resetKey: string;
  mode: TravelMode;
  pivot?: [number, number, number];
  children: React.ReactNode;
}) {
  const ref = React.useRef<THREE.Group>(null);

  const phase = React.useRef<Phase>("idle");
  const t = React.useRef(0);
  const from = React.useRef(new THREE.Vector3());
  const to = React.useRef(new THREE.Vector3());
  const now = React.useRef(new THREE.Vector3());
  /** The direction the move in flight was taken in, kept past `axis` clearing. */
  const took = React.useRef<Axis | null>(null);
  /**
   * The direction the LEAVING half has already been started for.
   *
   * Separate from `took` on purpose, and the separation is load-bearing. The
   * arriving half is triggered by `resetKey` while `axis` is often still set —
   * the view clears its own transition state in an effect, which runs after
   * render — so any re-render in that gap saw a non-null `axis` that had not
   * been "taken" and started the leaving half AGAIN. The board turned away,
   * the new document arrived, and then it turned away a second time and held
   * there edge-on, which is exactly what the reader reported.
   *
   * Arming is cleared only when `axis` itself goes null, so a re-render in the
   * gap is a no-op and a genuinely new move still re-arms.
   */
  const armed = React.useRef<Axis | null>(null);
  const lastReset = React.useRef(resetKey);

  // ── Leaving ──
  if (axis === null) {
    armed.current = null;
  } else if (armed.current !== axis) {
    armed.current = axis;
    took.current = axis;
    from.current.copy(now.current);
    to.current.copy(leavingPose(mode, axis));
    t.current = 0;
    phase.current = "leaving";
  }

  // ── Arriving ──
  //
  // The new document starts on the OPPOSITE side and completes the same
  // motion. Jumping it to rest instead is the cut the reader saw.
  if (lastReset.current !== resetKey) {
    lastReset.current = resetKey;
    const took0 = took.current;
    if (took0) {
      from.current.copy(leavingPose(mode, took0)).multiplyScalar(-1);
      to.current.set(0, 0, 0);
      now.current.copy(from.current);
      t.current = 0;
      phase.current = "arriving";
    } else {
      // A minimap jump has no direction — it is a move through the graph, not
      // along a corridor, so it arrives rather than travels.
      now.current.set(0, 0, 0);
      from.current.set(0, 0, 0);
      to.current.set(0, 0, 0);
      phase.current = "idle";
    }
  }

  useFrame((_, dt) => {
    const g = ref.current;
    if (!g) return;
    try {
      if (phase.current === "leaving" || phase.current === "arriving") {
        t.current = Math.min(1, t.current + Math.min(dt, 0.1) / HALF_S);
        const e = easeInOutCubic(t.current);
        now.current.lerpVectors(from.current, to.current, e);
        if (t.current >= 1)
          phase.current = phase.current === "leaving" ? "held" : "idle";
      }
      if (mode === "turn") g.rotation.set(now.current.x, now.current.y, now.current.z);
      else g.position.set(now.current.x, now.current.y, now.current.z);
    } catch {
      // A stalled transition is legible. A throw inside an XR frame is not.
    }
  });

  if (mode === "turn" && pivot) {
    // Translate to the pivot, rotate, translate back — the standard way to
    // turn a thing about a point that is not the origin.
    return (
      <group position={pivot}>
        <group ref={ref}>
          <group position={[-pivot[0], -pivot[1], -pivot[2]]}>{children}</group>
        </group>
      </group>
    );
  }
  return <group ref={ref}>{children}</group>;
}

/**
 * How long a view should let its own transition run before it asks for the
 * document — enough of the leaving half to read as a departure.
 *
 * Not the whole half: the fetch and the animation overlap, and a reader who has
 * committed to a door should not wait on an animation before the network is
 * even asked.
 */
export const TRAVEL_LEAD_MS = 180;
