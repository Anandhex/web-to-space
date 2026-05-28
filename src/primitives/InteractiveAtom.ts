import * as THREE from "three";
import { Text } from "troika-three-text";
import type { PrimitiveOptions } from "./types";

const WIDTH = 0.18;
const HEIGHT = 0.05;

export function createInteractiveAtom({
  node,
}: PrimitiveOptions): THREE.Object3D {
  const group = new THREE.Group();
  group.name = node.id;

  const geometry = new THREE.PlaneGeometry(WIDTH, HEIGHT);
  const material = new THREE.MeshStandardMaterial({
    color: 0x2a2a4a,
    side: THREE.FrontSide,
    transparent: true,
    opacity: 0.9,
  });

  const mesh = new THREE.Mesh(geometry, material);
  group.add(mesh);

  const label = node.label ?? node.role;
  const text = new Text();
  text.text = label;
  text.fontSize = 0.014;
  text.color = 0xffffff;
  text.maxWidth = WIDTH * 0.85;
  text.anchorX = "center";
  text.anchorY = "middle";
  text.position.z = 0.001;
  text.sync();
  group.add(text);

  // Interactive flag — raycaster uses this
  group.userData = {
    nodeId: node.id,
    role: node.role,
    controls: node.attributes.controls,
    interactive: true,
  };

  return group;
}
