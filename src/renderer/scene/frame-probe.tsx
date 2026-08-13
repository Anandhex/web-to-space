/**
 * scene/frame-probe.tsx
 *
 * Counts the frames the app actually renders while presenting.
 *
 * Mounted inside <XR> but OUTSIDE the scene's Suspense boundary, so it keeps
 * counting even when the content tree is suspended — a suspended tree that
 * still renders (black world) and a tree that never renders at all (the
 * headset's loading environment, forever) look identical from the inside, and
 * this is what tells them apart. Pairs with the raw session-frame probe in
 * useXRSession; see renderer/xr-diagnostics.ts for what the two counters mean.
 */
import { useFrame } from "@react-three/fiber";
import { markRenderFrame } from "../xr-diagnostics";

export function XRFrameProbe() {
  useFrame((state) => {
    if (state.gl.xr.isPresenting) markRenderFrame();
  });
  return null;
}
