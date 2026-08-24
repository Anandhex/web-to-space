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
 * This module is the other end of those same actions, and nothing more. It does
 * not invent a second navigation model; it hands the existing ones the two
 * gestures a headset can make:
 *
 *  - **The thumbstick**, when the reader is holding controllers. Continuous for
 *    walking, detented for anything that steps (a floor, a page) so one push is
 *    one step and a held stick repeats at a readable rate rather than sweeping
 *    the whole document in half a second.
 *
 *  - **Look, and double-tap**, which is all that is left when the reader has no
 *    controllers at all. A pinch is a `select`, exactly as a trigger pull is, so
 *    one listener covers hand tracking and controllers together — and the aim
 *    comes from the HEAD, which every input mode has. That is why the gesture is
 *    "look at the floor and tap twice" rather than "point at the floor": there
 *    is no ray to point with when the reader's hands are their input.
 *
 * Why double, not single: a single `select` is already the app's click. Links,
 * pager buttons, reading spots, the tab bar and every page hit-plane are wired
 * to it through R3F's pointer events, which @react-three/xr drives from these
 * same input sources. A single-tap teleport would fire on every one of them.
 * Two taps inside {@link DOUBLE_TAP_MS}, aimed below the horizon at a piece of
 * floor the reader could walk to, is a gesture nothing else in the scene makes.
 */
import React from "react";
import { useXR, useXRInputSourceState } from "@react-three/xr";
import * as THREE from "three";

/**
 * How far apart two `select`s may be and still read as one double tap.
 *
 * Generous, because a pinch is a slower gesture than a trigger pull and hand
 * tracking's own recognition latency is inside this budget — but short enough
 * that two deliberate, separate clicks on two different links never collide.
 */
const DOUBLE_TAP_MS = 450;

/**
 * Fires `onTap` when one input source selects twice in quick succession.
 *
 * Per input source, not global: the reader's two hands are two devices, and a
 * tap from each inside the window is two people's worth of one gesture, not one
 * double tap. The handler is held in a ref so a caller can pass a fresh closure
 * every render without tearing down the session listener each time.
 */
export function useXRDoubleTap(enabled: boolean, onTap: () => void) {
  const session = useXR((s) => s.session);
  const handler = React.useRef(onTap);
  handler.current = onTap;

  React.useEffect(() => {
    if (!enabled || !session) return;
    const last = new Map<XRInputSource, number>();
    const onSelect = (ev: XRInputSourceEvent) => {
      const now = performance.now();
      const prev = last.get(ev.inputSource) ?? -Infinity;
      if (now - prev <= DOUBLE_TAP_MS) {
        // Consume both taps: a triple tap is one double tap and a stray, not
        // two overlapping doubles.
        last.delete(ev.inputSource);
        handler.current();
        return;
      }
      last.set(ev.inputSource, now);
    };
    session.addEventListener("select", onSelect as EventListener);
    return () =>
      session.removeEventListener("select", onSelect as EventListener);
  }, [enabled, session]);
}

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

// ── Gaze ─────────────────────────────────────────────────────

/**
 * How far down the reader must be looking for a gaze to count as aimed at the
 * floor rather than at the page in front of them.
 *
 * Pages hang to a gallery centre line at eye height, so a glance at one is
 * within a few degrees of level. Fifteen degrees below the horizon is a
 * deliberate look down and, at a standing eye height, is already six metres out
 * — comfortably past anything hanging on a wall.
 */
const GAZE_MIN_PITCH = Math.sin(THREE.MathUtils.degToRad(15));
/**
 * …and how far out a gaze may reach. Past this the floor is a sliver a degree
 * of head movement swings tens of metres across, which is not aiming.
 */
const GAZE_MAX_RANGE = 14;

/** Scratch, module-level: this runs every frame and must not allocate. */
const gazeDir = new THREE.Vector3();
const gazeEye = new THREE.Vector3();

/**
 * Where the reader is looking, on the floor plane — in WORLD space, or null if
 * they are not looking at the floor at all (level or up, or so far out that the
 * aim is meaningless).
 *
 * The head, not a controller ray, on purpose: a headset always has one, hands
 * and controllers alike, and it is the aim the reader is already using to read
 * with. Taking it from `state.camera` is exact in both worlds — provided the
 * eye is read off the WORLD matrix and not off `camera.position`, which inside
 * a session is the head in the player's frame. See {@link headWorldPose}: the
 * aim came from `getWorldDirection` and the eye from the local position, so the
 * ray was cast from a point displaced by the whole recentre and the reticle
 * solved against floor the reader was not looking at.
 */
export function gazeFloorPoint(
  camera: THREE.Camera,
  floorWorldY: number,
  out: THREE.Vector3,
): THREE.Vector3 | null {
  camera.getWorldDirection(gazeDir);
  if (-gazeDir.y < GAZE_MIN_PITCH) return null;
  headWorldPose(camera, gazeEye);
  const drop = gazeEye.y - floorWorldY;
  if (drop <= 0.05) return null;
  const t = drop / -gazeDir.y;
  if (t > GAZE_MAX_RANGE) return null;
  return out.set(
    gazeEye.x + gazeDir.x * t,
    floorWorldY,
    gazeEye.z + gazeDir.z * t,
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
 * minimap drifted out of its corner, the teleport reticle was solved against a
 * piece of floor nowhere near the one the reader was looking at, and both went
 * wrong only AFTER the recentre landed, a frame into the session.
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
