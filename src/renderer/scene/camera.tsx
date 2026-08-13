/**
 * scene/camera.tsx
 *
 * Camera rig: the viewer recentre that lines the headset up with the content.
 *
 * Session binding lives in @react-three/xr's <XR store={...}> now — it owns
 * gl.xr.setSession() as well as rendering the controllers/hands that drive
 * R3F's pointer handlers.
 */
import React from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { XROrigin } from "@react-three/xr";
import type * as THREE from "three";

/**
 * Recentres the viewer on `target` (the main content panel's centre) once per
 * immersive session.
 *
 * Panels are top-left anchored at eyeLevel + eyeLevelOffset, so a panel's centre
 * hangs half a viewport BELOW that line — 0.95 m for Quest against a real
 * standing eye height of ~1.65 m, which left the content well under the sight
 * line. The flat preview solves this by aiming OrbitControls at the panel centre
 * (`readingLook`); in XR the camera is owned by the device, so we move the
 * player's origin instead.
 *
 * <XROrigin> is the player's feet. Rather than needing the user's real height,
 * we let one frame render and then correct by however far the head actually
 * landed from the target — the delta folds the unknown height in for free.
 *
 * Applied as a one-shot recentre rather than every frame: once the offset is in,
 * the user must remain free to physically lean and walk relative to the panel.
 * A change of `target` (e.g. switching view mode) re-centres on the new panel.
 *
 * Only x/y are corrected by default: z is left alone so the viewer keeps the
 * standing-off distance the layout engine already authored via
 * `viewingDistance`.
 *
 * `standing` turns that off, and the views that need it are the ones the reader
 * is INSIDE. The elevator builds a cylinder about one point and `rooms` builds a
 * building about one point, and in both the reader has to be ON it. Leaving z to
 * wherever the headset's own play space happened to put them stands them
 * anywhere up to a couple of metres up or down the corridor — which is inside a
 * wall about as often as it is not, and from inside a wall the view is whatever
 * is on the far side of it. (This is why `rooms` could open onto black: not a
 * rendering fault, a reader standing in the plaster.) Those views place the eye;
 * their geometry is meaningless anywhere else.
 */
export function XRViewerAnchor({
  target,
  standing = false,
}: {
  target: [number, number, number] | null;
  /** Correct z as well: the reader must be AT the target, not merely level with it. */
  standing?: boolean;
}) {
  const [origin, setOrigin] = React.useState<[number, number, number]>([
    0, 0, 0,
  ]);
  /** Target the current origin was solved for; null = not yet applied. */
  const appliedKey = React.useRef<string | null>(null);

  useFrame((state) => {
    if (!state.gl.xr.isPresenting) {
      // Session ended — reset so the next entry re-measures against a fresh head pose.
      if (appliedKey.current !== null) {
        appliedKey.current = null;
        setOrigin([0, 0, 0]);
      }
      return;
    }
    if (!target) return;

    const key = `${target.join(",")}|${standing}`;
    if (appliedKey.current === key) return;

    // camera.position is the head in world space, i.e. it already includes the
    // current origin. Shifting the origin by (target - head) therefore lands the
    // head exactly on target, whatever the user's height.
    const cam = state.camera;
    setOrigin((prev) => [
      prev[0] + (target[0] - cam.position.x),
      prev[1] + (target[1] - cam.position.y),
      standing ? prev[2] + (target[2] - cam.position.z) : prev[2],
    ]);
    appliedKey.current = key;
  });

  return <XROrigin position={origin} />;
}

/**
 * How far in front of the eye the flat preview's orbit pivot sits when the
 * reader is standing INSIDE the scene rather than looking at it. One
 * centimetre: OrbitControls always keeps the camera on a sphere of the
 * current radius about its target, so a pivot this close turns an orbit into
 * a turn of the head, and the eye can never wander more than 2 cm off the
 * spot it was put on.
 */
export const LOOK_PIVOT = 0.01;

/**
 * Stands the flat preview's camera AT `axis` and lets it look around from
 * there — the elevator's rig.
 *
 * The elevator builds a cylinder of pages about the reader, so there is
 * exactly one right place for the eye: the axis. The default preview rig
 * orbits the camera around the main panel's centre, which is a point one
 * reading distance in FRONT of that axis, so the first drag carried the
 * reader out through the wall of their own building — the section plaque
 * stopped being dead ahead, the ring stopped being a ring, and the
 * balustrade started cutting across pages it is nowhere near.
 *
 * Rather than replace the controls (they own the drag, the damping, and the
 * gesture the whole app shares), this parks the pivot a centimetre ahead of
 * the eye. Rotation still works exactly as before; it just rotates in place.
 * Panning and dollying are the caller's to disable — there is nowhere to pan
 * or dolly TO.
 */
export function AxisLook({ axis }: { axis: [number, number, number] | null }) {
  const camera = useThree((s) => s.camera);
  const controls = useThree((s) => s.controls) as {
    target?: THREE.Vector3;
    update?: () => void;
  } | null;
  const key = axis ? axis.join(",") : null;

  React.useEffect(() => {
    if (!axis || !controls?.target) return;
    // Face the plaque, which the ring keeps in the slot dead ahead — i.e.
    // down −z, the bearing the placement side calls θ = 0.
    camera.position.set(axis[0], axis[1], axis[2]);
    controls.target.set(axis[0], axis[1], axis[2] - LOOK_PIVOT);
    controls.update?.();
    // `key` stands in for the axis tuple, which is rebuilt on every render of
    // the parent; re-running on a new *position* is the point, not on a new
    // array with the same numbers in it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, camera, controls]);

  return null;
}

/**
 * Field of view for the flat preview. The default 60° lens sits one reading
 * distance from a panel as wide as the reading distance itself, so the page
 * fills the frame by construction — which is right for a view whose whole
 * subject is that panel, and wrong for `rooms`, where the reader is standing
 * IN somewhere and the room around the page is the point. A wider lens shows
 * the walls, the neighbouring pages and the spot underfoot without moving the
 * reader back off the reading mark.
 *
 * Preview only: in an immersive session the field of view belongs to the
 * headset, and three.js builds those projections itself.
 */
export function PreviewFieldOfView({ fov }: { fov: number }) {
  const camera = useThree((s) => s.camera);
  const gl = useThree((s) => s.gl);
  React.useEffect(() => {
    if (gl.xr.isPresenting) return;
    const cam = camera as THREE.PerspectiveCamera;
    if (!cam.isPerspectiveCamera || cam.fov === fov) return;
    cam.fov = fov;
    cam.updateProjectionMatrix();
  }, [camera, fov, gl]);
  return null;
}
