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
import { useFrame } from "@react-three/fiber";
import { XROrigin } from "@react-three/xr";

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
 * Only x/y are corrected. z is left alone so the viewer keeps the standing-off
 * distance the layout engine already authored via `viewingDistance`.
 */
export function XRViewerAnchor({
  target,
}: {
  target: [number, number, number] | null;
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

    const key = target.join(",");
    if (appliedKey.current === key) return;

    // camera.position is the head in world space, i.e. it already includes the
    // current origin. Shifting the origin by (target - head) therefore lands the
    // head exactly on target, whatever the user's height.
    const cam = state.camera;
    setOrigin((prev) => [
      prev[0] + (target[0] - cam.position.x),
      prev[1] + (target[1] - cam.position.y),
      prev[2],
    ]);
    appliedKey.current = key;
  });

  return <XROrigin position={origin} />;
}
