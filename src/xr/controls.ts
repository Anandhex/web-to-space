import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface DesktopControls {
  update: () => void;
  dispose: () => void;
}

// ─── Desktop Fallback ─────────────────────────────────────────────────────────

export function createDesktopControls(
  camera: THREE.PerspectiveCamera,
  renderer: THREE.WebGLRenderer,
  getTargets: () => THREE.Object3D[],
  onHit: (nodeId: string, role: string, controls: string | null) => void,
): DesktopControls {
  const orbit = new OrbitControls(camera, renderer.domElement);
  orbit.enableDamping = true;
  orbit.dampingFactor = 0.08;
  orbit.target.set(0, 0, -1.5);
  orbit.update();

  const raycaster = new THREE.Raycaster();
  const mouse = new THREE.Vector2();

  // ─── Mouse Move — hover highlight ──────────────────────────────────────────

  function onMouseMove(e: MouseEvent): void {
    const rect = renderer.domElement.getBoundingClientRect();
    mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  }

  // ─── Click — hit detection ─────────────────────────────────────────────────

  function onClick(): void {
    const targets = getTargets();
    if (!targets.length) return;

    raycaster.setFromCamera(mouse, camera);
    const intersects = raycaster.intersectObjects(targets, true);
    if (!intersects.length) return;

    let obj: THREE.Object3D | null = intersects[0].object;
    while (obj) {
      if (obj.userData?.nodeId) {
        onHit(
          obj.userData.nodeId,
          obj.userData.role,
          obj.userData.controls ?? null,
        );
        break;
      }
      obj = obj.parent;
    }
  }

  renderer.domElement.addEventListener("mousemove", onMouseMove);
  renderer.domElement.addEventListener("click", onClick);

  return {
    update() {
      orbit.update();
      // Per-frame hover raycast
      const targets = getTargets();
      if (!targets.length) return;
      raycaster.setFromCamera(mouse, camera);
      raycaster.intersectObjects(targets, true);
    },
    dispose() {
      renderer.domElement.removeEventListener("mousemove", onMouseMove);
      renderer.domElement.removeEventListener("click", onClick);
      orbit.dispose();
    },
  };
}
