import * as THREE from "three";
import { createXRSessionManager } from "./session";
import { createDesktopControls } from "./controls";
import type { XRSessionManager } from "./session";
import type { DesktopControls } from "./controls";

export interface XRLayer {
  sessionManager: XRSessionManager;
  desktopControls: DesktopControls | null;
  enterXR: () => Promise<void>;
  dispose: () => void;
}

export function createXRLayer(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.PerspectiveCamera,
  getTargets: () => THREE.Object3D[],
  onHit: (nodeId: string, role: string, controls: string | null) => void,
): XRLayer {
  const sessionManager = createXRSessionManager(
    renderer,
    scene,
    camera,
    getTargets,
    onHit,
  );

  // Desktop controls active until XR session starts
  const desktopControls = sessionManager.isSupported
    ? null
    : createDesktopControls(camera, renderer, getTargets, onHit);

  async function enterXR(): Promise<void> {
    if (desktopControls) {
      desktopControls.dispose();
    }
    await sessionManager.start();
  }

  function dispose(): void {
    desktopControls?.dispose();
    sessionManager.end();
  }

  return { sessionManager, desktopControls, enterXR, dispose };
}
