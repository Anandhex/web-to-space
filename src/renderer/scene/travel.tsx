/**
 * scene/travel.tsx — the two halves of a move.
 *
 * A directional move has a LEAVING half and an ARRIVING half, and the first
 * build only had the first one. The board turned away, the fetch landed, and
 * the next document was snapped into place at rest — so what the reader saw
 * was a turn followed by a cut. The direction they had just chosen was
 * animated; the direction they had just gone was not.
 *
 * So a move is one continuous motion in one direction, in three parts:
 *
 *   leaving   the current document rotates/slides away, the way the door said
 *   crossing  it waits at the far pose until the NEXT document is actually up
 *   arriving  the new document enters from the opposite side, completing the
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
 * out.
 *
 * That shape is why the two halves ease DIFFERENTLY. The first build ran a full
 * `easeInOutCubic` over each half separately, which decelerates the board to a
 * dead stop at the cross and then accelerates it again from rest — two moves
 * that meet, not one turn. `easeInCubic` out and `easeOutCubic` back in are the
 * two halves of that same cubic split at the cross, so when the document is
 * ready immediately the whole turn is one continuous eased sweep, and when it
 * is not the entrance still starts at the far pose (edge-on, or off the side of
 * the table) where nothing is visible to jerk.
 *
 * ── Where the "blocky" came from ──
 *
 * Two things, both fixed here, and neither of them the easing:
 *
 * 1. The arriving half used to start the instant the nav committed, wherever
 *    the leaving half had got to. `TRAVEL_LEAD_MS` asks for the document 180 ms
 *    into a 420 ms half, so any fetch faster than ~240 ms — every local page,
 *    every warm cache — landed with the board only about a third of the way
 *    round, and the arriving half then teleported it to the OPPOSITE far pose
 *    to swing in from. That jump is a full 2× the turn, and the reader sees it
 *    as a stutter in the middle of the move. The cross is invisible only if it
 *    happens AT the far pose, so the arrival is now queued: the leaving half
 *    always runs to the edge, and the flip happens there.
 *
 * 2. The arriving half used to play across the heaviest frames in the app.
 *    `resetKey` changes when the nav commits, but `usePipeline` only swaps the
 *    plan in when the parse, the mapping and the layout are done — and then
 *    React mounts a whole new scene graph and troika builds every glyph. So the
 *    swing-in was animated over frames that were tens to hundreds of
 *    milliseconds long, with the OLD document still on screen for the first
 *    part of it and the new one popping in mid-swing. `crossing` waits out both:
 *    it holds at the far pose until the content behind it has actually changed
 *    and the frame rate has recovered, and only then swings in. A held cross is
 *    honest — it is the same "the fetch is still out" state the design already
 *    had — where a swing across a stalled main thread is just dropped frames.
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
import { createTravelMotion } from "./travel-motion";
import type { TravelMode, TravelMotion } from "./travel-motion";

/**
 * Wraps a view's whole world and plays the move.
 *
 * `axis` is the direction the reader took, held for as long as the move is in
 * flight and cleared on arrival. `resetKey` changes when a new document lands —
 * that is the cue to cross.
 *
 * `contentKey` is what is currently RENDERED, and is what tells the cross that
 * the new document is really up: `resetKey` changes when the navigation
 * commits, which is one whole parse, mapping, layout and mount before there is
 * anything new to swing in. Pass the layout plan.
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
  contentKey,
  children,
}: {
  axis: Axis | null;
  resetKey: string;
  mode: TravelMode;
  pivot?: [number, number, number];
  contentKey?: unknown;
  children: React.ReactNode;
}) {
  const ref = React.useRef<THREE.Group>(null);

  const held = React.useRef<TravelMotion | null>(null);
  if (held.current === null || held.current.mode !== mode)
    held.current = createTravelMotion(mode);
  const motion = held.current;

  /**
   * The direction the LEAVING half has already been started for.
   *
   * Separate from the motion's own `took` on purpose, and the separation is
   * load-bearing. The cross is triggered by `resetKey` while `axis` is often
   * still set — the view clears its own transition state in an effect, which
   * runs after render — so any re-render in that gap saw a non-null `axis` that
   * had not been "taken" and started the leaving half AGAIN. The board turned
   * away, the new document arrived, and then it turned away a second time and
   * held there edge-on, which is exactly what the reader reported.
   *
   * Arming is cleared only when `axis` itself goes null, so a re-render in the
   * gap is a no-op and a genuinely new move still re-arms.
   */
  const armed = React.useRef<Axis | null>(null);
  const lastReset = React.useRef(resetKey);
  /** Read from inside the frame loop, which does not re-run on a prop change. */
  const content = React.useRef(contentKey);
  content.current = contentKey;

  // ── Leaving ──
  if (axis === null) {
    armed.current = null;
  } else if (armed.current !== axis) {
    armed.current = axis;
    motion.arm(axis);
  }

  // ── Crossing ──
  if (lastReset.current !== resetKey) {
    lastReset.current = resetKey;
    motion.land(contentKey);
  }

  useFrame((_, dt) => {
    const g = ref.current;
    if (!g) return;
    try {
      motion.advance(dt, content.current);
      const p = motion.pose;
      if (mode === "turn") g.rotation.set(p.x, p.y, p.z);
      else g.position.set(p.x, p.y, p.z);
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
 * even asked. A fetch that beats the leaving half no longer cuts it short —
 * see `land`.
 */
export const TRAVEL_LEAD_MS = 180;
