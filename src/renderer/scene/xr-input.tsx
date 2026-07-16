/**
 * scene/xr-input.tsx
 *
 * <XRControllers> — adds the WebXR controller target-ray and grip spaces to the
 * R3F scene graph.
 *
 * three only writes controller poses onto the objects returned by
 * `gl.xr.getController(i)` / `gl.xr.getControllerGrip(i)`; their `matrixWorld`
 * is refreshed by the normal scene traversal. An object that is never added to
 * the scene therefore stays invisible AND stays at a stale identity transform —
 * which is why the "hand" reference frame in scene-graph.tsx also needs these
 * grips mounted to track anything.
 */
import React from "react";
import { useThree } from "@react-three/fiber";
import * as THREE from "three";

/** Length of the pointer ray, in metres. */
const RAY_LENGTH = 3;

function createRayLine(): THREE.Line {
  const geometry = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(0, 0, -RAY_LENGTH),
  ]);
  const material = new THREE.LineBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.5,
  });
  return new THREE.Line(geometry, material);
}

/**
 * Simple hand-held stand-in. Deliberately procedural rather than
 * XRControllerModelFactory, which fetches per-vendor glTF from a CDN at runtime.
 */
function createGripMesh(): THREE.Mesh {
  const geometry = new THREE.CylinderGeometry(0.014, 0.02, 0.09, 12);
  // Lay the grip along the controller's forward axis.
  geometry.rotateX(-Math.PI / 2);
  const material = new THREE.MeshStandardMaterial({
    color: 0x2b3442,
    roughness: 0.6,
    metalness: 0.1,
  });
  return new THREE.Mesh(geometry, material);
}

export function XRControllers() {
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);

  React.useEffect(() => {
    const mounted: THREE.Object3D[] = [];
    const disposables: (THREE.BufferGeometry | THREE.Material)[] = [];

    for (let i = 0; i < 2; i++) {
      const controller = gl.xr.getController(i);
      const ray = createRayLine();
      controller.add(ray);
      scene.add(controller);
      mounted.push(controller);
      disposables.push(ray.geometry, ray.material as THREE.Material);

      const grip = gl.xr.getControllerGrip(i);
      const mesh = createGripMesh();
      grip.add(mesh);
      scene.add(grip);
      mounted.push(grip);
      disposables.push(mesh.geometry, mesh.material as THREE.Material);
    }

    return () => {
      for (const obj of mounted) {
        obj.clear();
        scene.remove(obj);
      }
      for (const d of disposables) d.dispose();
    };
  }, [gl, scene]);

  return null;
}
