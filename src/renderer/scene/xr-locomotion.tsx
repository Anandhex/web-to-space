/**
 * scene/xr-locomotion.tsx
 *
 * THE INPUT THE HEADSET ACTUALLY HAS.
 *
 * Every page view in this app was navigated from the keyboard: W/A/S/D and the
 * arrow keys walk the `rooms` building, ←/→ turn a page. Inside an immersive
 * session there is no keyboard — the reader has two controllers, or two bare
 * hands, and nothing else. So each of those views was navigable at a desk and
 * frozen in a headset: you could look around whatever the view had put in
 * front of you and never move through it.
 *
 * What lives here is the STICK half of the answer — the thumbsticks, read raw,
 * fed into the same walk the keys drive. Continuous for walking, detented for
 * anything that steps (a floor, a page) so one push is one step and a held
 * stick repeats at a readable rate rather than sweeping the whole document in
 * half a second.
 *
 * ── The half that is no longer here ──
 *
 * Going somewhere without walking to it is {@link RoomTeleport}, over in
 * `room-walk.tsx`, and it is no longer built out of anything in this file. It
 * used to be: aim with the HEAD by looking more than fifteen degrees below the
 * horizon, then `select` TWICE inside 450 ms. Both halves were wrong, and they
 * were wrong in the same way — each existed to keep the gesture from colliding
 * with something else, and the reader paid for both.
 *
 *  - **Aiming with the head** meant aiming with the thing you read with. To
 *    put the reticle on a doorway eight metres off you had to point your face
 *    at the floor, which is the one direction from which you cannot see where
 *    you are going; and the pitch gate that stopped a glance at a page from
 *    arming it also meant every short hop needed a deliberate stoop. Aiming
 *    and looking were the same channel, so you could not do both at once.
 *  - **Double-tapping** existed because a single `select` is the app's click.
 *    But the ambiguity was never in the tap count — it was in WHERE the tap
 *    was aimed, and the head has no ray to answer that with.
 *
 * The pointer does. Both hands already carry one, drawn and visible (see
 * `RAY_POINTER` in `useXRSession.tsx`), and a ray that lands on the floor is
 * not landing on a link. So the aim moved to the hand, the tap count went back
 * to one, and the pitch gate and the 450 ms window both went with them.
 */
import React from "react";
import { useXRInputSourceState } from "@react-three/xr";
import * as THREE from "three";

/** A thumbstick's position: +x right, +y forward (the stick pushed away). */
interface StickAxes {
  x: number;
  y: number;
}

/** Below this a stick is at rest — thumbsticks do not return to exactly zero. */
const STICK_DEAD_ZONE = 0.2;

function readStick(
  state: { gamepad: Record<string, { xAxis?: number; yAxis?: number } | undefined> } | undefined,
): StickAxes {
  const s = state?.gamepad["xr-standard-thumbstick"];
  if (!s) return { x: 0, y: 0 };
  const x = s.xAxis ?? 0;
  // WebXR's standard mapping has the stick's forward push as −1 on y; every
  // caller here thinks in "forward is positive", so flip it once, at the edge.
  const y = -(s.yAxis ?? 0);
  return {
    x: Math.abs(x) < STICK_DEAD_ZONE ? 0 : x,
    y: Math.abs(y) < STICK_DEAD_ZONE ? 0 : y,
  };
}

/**
 * Live thumbstick axes for both hands, as a getter rather than a value.
 *
 * The gamepad state is mutated in place by @react-three/xr once per frame, so
 * there is nothing to re-render on and nothing to subscribe to — the caller is
 * a frame loop and wants whatever is true right now.
 */
export function useXRThumbsticks(): () => { left: StickAxes; right: StickAxes } {
  const left = useXRInputSourceState("controller", "left");
  const right = useXRInputSourceState("controller", "right");
  return React.useCallback(
    () => ({ left: readStick(left), right: readStick(right) }),
    [left, right],
  );
}

// ── Where the head actually is ───────────────────────────────

/**
 * The head's pose in WORLD space, written into the caller's vectors.
 *
 * Not `camera.position` / `camera.quaternion`, and the difference is a whole
 * class of bug. Outside a session R3F's default camera hangs off the scene and
 * the two are the same thing. Inside one, `<XR>` swaps `state.camera` for
 * three's XR `ArrayCamera` — and @react-three/xr parents THAT to the
 * `<XROrigin>` group, which is how the origin moves the player at all. Its
 * `.position` is therefore the head in the PLAYER's frame, and the origin
 * offset only appears in `matrixWorld`.
 *
 * Read the local pose as if it were world and everything anchored to the head
 * is displaced by exactly the recentre `XRViewerAnchor` applied — which is
 * metres in `rooms`, where the reader is stood at a point in the building. The
 * minimap drifted out of its corner, and it went wrong only AFTER the recentre
 * landed, a frame into the session.
 *
 * The world matrix is REFRESHED first, and that is not belt and braces. three
 * writes `cameraXR.matrix` (and decomposes it into position/quaternion) inside
 * `onAnimationFrame`, BEFORE it calls the render loop — but it only writes
 * `matrixWorld` later, inside `render()`. So on any frame this is called from a
 * `useFrame`, `matrixWorld` is one frame old, and on the FIRST frame of a
 * session it is worse than old: it still holds what the flat preview left
 * there, where the XR camera sat in the graph with an identity matrix, i.e. the
 * origin itself. Read raw, the head came back as (0, 0, 0) on exactly the frame
 * <XRViewerAnchor> takes its one-shot measurement — so it solved the recentre
 * against a head that was nowhere, and the reader entered VR standing a play
 * space away from the room. `updateWorldMatrix(true, false)` walks the
 * ancestors and then this object, which is the same composition three is about
 * to do, so nothing is lost by doing it early.
 *
 * A camera's world matrix carries no scale, so its upper 3×3 is a rotation as
 * it stands and `setFromRotationMatrix` needs no normalising.
 */
export function headWorldPose(
  camera: THREE.Camera,
  position: THREE.Vector3,
  quaternion?: THREE.Quaternion,
): void {
  camera.updateWorldMatrix(true, false);
  position.setFromMatrixPosition(camera.matrixWorld);
  quaternion?.setFromRotationMatrix(camera.matrixWorld);
}
