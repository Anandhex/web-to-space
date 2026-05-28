import * as THREE from "three";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface XRSessionManager {
  isSupported: boolean;
  isActive: boolean;
  start: () => Promise<void>;
  end: () => Promise<void>;
}

interface ControllerState {
  controller: THREE.XRTargetRaySpace;
  raycaster: THREE.Raycaster;
  line: THREE.Line; // visual ray for debugging
}

// ─── Ray Visual ───────────────────────────────────────────────────────────────

function createRayLine(): THREE.Line {
  const points = [new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1)];
  const geometry = new THREE.BufferGeometry().setFromPoints(points);
  const material = new THREE.LineBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.4,
  });
  return new THREE.Line(geometry, material);
}

// ─── Session Manager ──────────────────────────────────────────────────────────

export function createXRSessionManager(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.PerspectiveCamera,
  getTargets: () => THREE.Object3D[],
  onHit: (nodeId: string, role: string, controls: string | null) => void,
): XRSessionManager {
  renderer.xr.enabled = true;

  const controllers: ControllerState[] = [];

  // ─── Controller Setup ───────────────────────────────────────────────────────

  function setupControllers(): void {
    for (let i = 0; i < 2; i++) {
      const controller = renderer.xr.getController(i);
      const raycaster = new THREE.Raycaster();
      const line = createRayLine();

      controller.add(line);
      scene.add(controller);

      controller.addEventListener("selectstart", () => {
        handleSelect(controller, raycaster);
      });

      controllers.push({ controller, raycaster, line });
    }
  }

  function teardownControllers(): void {
    for (const { controller, line } of controllers) {
      controller.remove(line);
      scene.remove(controller);
      controller.removeEventListener("selectstart", () => {});
    }
    controllers.length = 0;
  }

  // ─── Hit Detection ──────────────────────────────────────────────────────────

  function handleSelect(
    controller: THREE.XRTargetRaySpace,
    raycaster: THREE.Raycaster,
  ): void {
    const targets = getTargets();
    if (!targets.length) return;

    // Point raycaster along controller's forward direction
    const tempMatrix = new THREE.Matrix4();
    tempMatrix.identity().extractRotation(controller.matrixWorld);
    raycaster.ray.origin.setFromMatrixPosition(controller.matrixWorld);
    raycaster.ray.direction.set(0, 0, -1).applyMatrix4(tempMatrix);

    const intersects = raycaster.intersectObjects(targets, true);
    if (!intersects.length) return;

    // Walk up to find the group with userData
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

  // ─── Per-frame Controller Ray Update ───────────────────────────────────────

  function updateControllerRays(): void {
    for (const { controller, raycaster, line } of controllers) {
      const targets = getTargets();
      if (!targets.length) continue;

      const tempMatrix = new THREE.Matrix4();
      tempMatrix.identity().extractRotation(controller.matrixWorld);
      raycaster.ray.origin.setFromMatrixPosition(controller.matrixWorld);
      raycaster.ray.direction.set(0, 0, -1).applyMatrix4(tempMatrix);

      const intersects = raycaster.intersectObjects(targets, true);

      // Highlight ray on hit
      const lineMat = line.material as THREE.LineBasicMaterial;
      lineMat.color.set(intersects.length ? 0x00ffcc : 0xffffff);
      lineMat.opacity = intersects.length ? 0.9 : 0.4;
    }
  }

  // ─── Public Interface ───────────────────────────────────────────────────────

  let supported = false;

  async function checkSupport(): Promise<void> {
    if (!navigator.xr) return;
    supported = await navigator.xr.isSessionSupported("immersive-vr");
  }

  async function start(): Promise<void> {
    if (!supported) throw new Error("WebXR immersive-vr not supported");

    setupControllers();

    // Inject per-frame controller update into render loop
    renderer.setAnimationLoop((_, frame) => {
      if (frame) updateControllerRays();
      renderer.render(scene, camera);
    });
  }

  async function end(): Promise<void> {
    const session = renderer.xr.getSession();
    if (session) await session.end();
    teardownControllers();
    renderer.setAnimationLoop(null);
  }

  // Run support check immediately
  checkSupport();

  return {
    get isSupported() {
      return supported;
    },
    get isActive() {
      return renderer.xr.isPresenting;
    },
    start,
    end,
  };
}
