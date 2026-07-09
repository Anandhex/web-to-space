/**
 * scene/camera.tsx
 *
 * Camera rigs: the default orbit/desktop rig, the XR-session binder, and the
 * snap-to-target helper used when entering cards reading view.
 */
import React from "react";
import { useThree, useFrame } from "@react-three/fiber";
import * as THREE from "three";

export function CameraRig({
  targetPos,
  targetLook,
}: {
  targetPos: [number, number, number];
  targetLook: [number, number, number];
}) {
  const { camera } = useThree();
  const tp = React.useRef(
    new THREE.Vector3(targetPos[0], targetPos[1], targetPos[2]),
  );
  const tl = React.useRef(
    new THREE.Vector3(targetLook[0], targetLook[1], targetLook[2]),
  );

  React.useEffect(() => {
    tp.current.set(targetPos[0], targetPos[1], targetPos[2]);
    tl.current.set(targetLook[0], targetLook[1], targetLook[2]);
  }, [
    targetPos[0],
    targetPos[1],
    targetPos[2],
    targetLook[0],
    targetLook[1],
    targetLook[2],
  ]); // eslint-disable-line react-hooks/exhaustive-deps

  useFrame(() => {
    camera.position.lerp(tp.current, 0.08);
    camera.lookAt(tl.current);
  });

  return null;
}

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

/** Instantly snap camera position+orientation once on mount, then yield to OrbitControls. */
export function CameraSnapTo({
  position,
  lookAt,
}: {
  position: [number, number, number];
  lookAt: [number, number, number];
}) {
  const { camera } = useThree();
  React.useLayoutEffect(() => {
    camera.position.set(position[0], position[1], position[2]);
    camera.lookAt(lookAt[0], lookAt[1], lookAt[2]);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}

// Reading-view camera constants: camera 1.2 m in front of the panel, looking
// at the panel's vertical centre so content fills the viewport comfortably.
