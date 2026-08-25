/**
 * scene/head-anchor.ts — the corner overlays, and how they follow the head.
 *
 * Two panels ride in the reader's lower-left field of view: the minimap, and
 * the transition mark directly above it. They are one corner as far as the
 * reader is concerned, so they follow the head by one rule, from here.
 *
 * ── Why it is a module and not two copies ──
 *
 * It WAS two copies. The mark was written against the minimap's constants and
 * inherited the follow but not the guard that goes with it (see `SNAP_DIST`
 * below) — so the one overlay that is on screen precisely WHILE the reader is
 * navigating was also the one that could be dragged through a building by a
 * teleport. Two panels in the same corner obeying two slightly different rules
 * is not a thing the reader can be asked to notice, which is exactly why it
 * survived.
 *
 * ── Following a head, not a frame ──
 *
 * The follow closes a fraction of the remaining error per SECOND, not per
 * frame. Per frame is the easy version and it was what this did: a flat
 * constant, tuned at 90 Hz, which is the rate `useXRSession` asks the headset
 * for. It is right at exactly that rate and nowhere else — the same constant
 * settles in 413 ms at 90 Hz, 620 ms at 60 (the flat preview) and 310 ms at
 * 120. Worse, "per frame" means the follow slows down in proportion to
 * DROPPED frames, so a corner panel lags hardest exactly when the scene is
 * heavy, which is when the reader is most likely to be looking for it.
 *
 * `1 - e^(-rate·dt)` is the same curve sampled correctly, and it is what every
 * other smoother in this renderer already uses (AtPos, RoomWalk, page-cells,
 * the deck's flying card). FOLLOW_RATE is picked to land on the 90 Hz feel the
 * constant used to give, so nothing changes on the device it was tuned on.
 */
import React from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";

import { headWorldPose } from "./xr-locomotion";

/** Distance from the eye. Close enough to read, far enough not to converge on. */
export const HEAD_ANCHOR_DIST = 0.85;

/**
 * Per second, not per frame: `-ln(0.1) / 0.413 s`, which is the settle the old
 * per-frame 0.06 gave at the 90 Hz the session asks for.
 */
const FOLLOW_RATE = 5.6;

/**
 * Past this the panel is not lagging, it is lost — so it is put back rather
 * than flown back.
 *
 * The follow is a comfort device for a head that turned; it is not a way of
 * travelling. A teleport, a jump to a history entry or the one-shot recentre
 * at the top of a session all move the reader metres at once, and easing a
 * corner overlay across that gap drags it through the walls of whatever room
 * it is crossing. Half a metre is more than any head movement produces in the
 * frame budget and less than the smallest jump.
 */
const SNAP_DIST = 0.5;

/** Scratch — this runs in a frame loop and must not allocate. */
const eye = new THREE.Vector3();
const quat = new THREE.Quaternion();
const target = new THREE.Vector3();

/**
 * Parks `ref`'s group in the reader's view at (`offX`, `offY`) metres off the
 * sight line, and keeps it there as the head turns.
 *
 * `active` false parks the follow AND re-arms the first-frame placement, so a
 * panel that comes back does not fly in from wherever it was last seen.
 */
export function useHeadAnchor(
  ref: React.RefObject<THREE.Group | null>,
  offX: number,
  offY: number,
  active: boolean,
): void {
  const camera = useThree((s) => s.camera);
  const settled = React.useRef(false);

  useFrame((_, dt) => {
    const g = ref.current;
    if (!g || !active) return;
    try {
      // Where the panel wants to be: DIST ahead of the eye, offset in the eye's
      // own frame so it stays in the corner as the head turns.
      //
      // The head in WORLD space, which `camera.position` is not once a session
      // is running — see headWorldPose. Read locally, the panel was placed at
      // the head's PLAYER-frame pose, i.e. displaced by exactly the recentre
      // <XRViewerAnchor> applies a frame into the session: it opened in the
      // corner, then left it and never came back, which in `rooms` (where the
      // recentre carries the reader to a point in the building) put it up and
      // away in the top corner for the rest of the session.
      headWorldPose(camera, eye, quat);
      target.set(offX, offY, -HEAD_ANCHOR_DIST).applyQuaternion(quat);
      target.add(eye);

      // Lagging, or lost? Anything past SNAP_DIST is a jump the reader made,
      // not a head they turned, and is put back in one frame.
      if (!settled.current || g.position.distanceTo(target) > SNAP_DIST) {
        g.position.copy(target);
        g.quaternion.copy(quat);
        settled.current = true;
        return;
      }
      const a = 1 - Math.exp(-FOLLOW_RATE * Math.min(dt, 0.1));
      g.position.lerp(target, a);
      g.quaternion.slerp(quat, a);
    } catch {
      // A corner overlay must never be the reason a session stops rendering.
      // Losing the follow leaves the panel wherever it last was, which is
      // legible; throwing out of an XR frame ends the session with no error
      // surfaced.
    }
  });

  React.useEffect(() => {
    if (!active) settled.current = false;
  }, [active]);
}
