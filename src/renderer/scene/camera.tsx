/**
 * scene/camera.tsx
 *
 * Camera rigs: the XR-session binder that puts the R3F renderer into and out of
 * XR presentation, and the viewer recentre that lines the headset up with the
 * content.
 */
import React from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";

/**
 * Binds the imperatively-requested XRSession (from useXRSession) to the R3F
 * WebGLRenderer. Canvas's `onCreated` only fires once at mount, when the
 * session is still null — it can't pick up a session granted later by
 * clicking "Enter VR". This effect re-runs on every session change instead,
 * which is what actually puts the renderer into (and out of) XR presentation.
 */
export function XRSessionBinder({ session }: { session: XRSession | null }) {
  const { gl } = useThree();
  React.useEffect(() => {
    gl.xr.enabled = true;
    gl.xr.setSession(session);
  }, [gl, session]);
  return null;
}

/**
 * Recentres the viewer on `target` (the main content panel's centre) once per
 * immersive session.
 *
 * Panels are top-left anchored at eyeLevel + eyeLevelOffset, so a panel's centre
 * hangs half a viewport BELOW that line — roughly 0.95 m for Quest. `local-floor`
 * meanwhile reports the user's true standing eye height (~1.6-1.75 m), which
 * leaves the content sitting well below the sight line. The flat preview solves
 * this by aiming OrbitControls at the panel centre (`readingLook`); in XR the
 * camera is owned by the device, so we move the reference space instead.
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
  /** Translation currently baked into the active offset reference space. */
  const applied = React.useRef<THREE.Vector3 | null>(null);
  const baseSpace = React.useRef<XRReferenceSpace | null>(null);
  const appliedKey = React.useRef<string | null>(null);
  const headBase = React.useRef(new THREE.Vector3());

  useFrame((state) => {
    const { gl, camera } = state;

    if (!gl.xr.isPresenting) {
      // Session ended — drop the cached spaces so the next entry re-measures.
      baseSpace.current = null;
      applied.current = null;
      appliedKey.current = null;
      return;
    }
    if (!target) return;

    const key = target.join(",");
    if (appliedKey.current === key) return;

    const current = gl.xr.getReferenceSpace();
    if (!current) return;
    if (!baseSpace.current) baseSpace.current = current;

    // The head pose three reports is expressed in whatever space is active, so
    // add back any offset we already applied to recover the base-space pose.
    headBase.current.copy(camera.position);
    if (applied.current) headBase.current.add(applied.current);

    // getOffsetReferenceSpace(T) yields a space where pose = poseInBase - T.
    // Solving pose.xy == target.xy gives T = headBase.xy - target.xy.
    const next = new THREE.Vector3(
      headBase.current.x - target[0],
      headBase.current.y - target[1],
      0,
    );

    gl.xr.setReferenceSpace(
      baseSpace.current.getOffsetReferenceSpace(
        new XRRigidTransform({ x: next.x, y: next.y, z: next.z }),
      ),
    );
    applied.current = next;
    appliedKey.current = key;
  });

  return null;
}
