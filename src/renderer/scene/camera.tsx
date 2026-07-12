/**
 * scene/camera.tsx
 *
 * Camera rigs: the XR-session binder that puts the R3F renderer into and out of
 * XR presentation.
 */
import React from "react";
import { useThree } from "@react-three/fiber";

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
