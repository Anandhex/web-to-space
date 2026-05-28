import * as THREE from "three";
import { Text } from "troika-three-text";
import type { PrimitiveOptions } from "./types";

const CURVE_RADIUS = 1.5;
const PLANE_WIDTH = 0.4;
const PLANE_HEIGHT = 0.08;
const SEGMENTS = 20;

export function createTextAtom({ node }: PrimitiveOptions): THREE.Object3D {
  const group = new THREE.Group();
  group.name = node.id;

  // Curved backing plane
  const geometry = new THREE.CylinderGeometry(
    CURVE_RADIUS, // radiusTop
    CURVE_RADIUS, // radiusBottom
    PLANE_HEIGHT, // height (Y-axis)
    SEGMENTS, // radialSegments
    1, // heightSegments
    true, // openEnded
    -Math.PI / 2 - PLANE_WIDTH / CURVE_RADIUS / 2, // thetaStart — centred on -Z
    PLANE_WIDTH / CURVE_RADIUS, // thetaLength
  );
  // No rotateX — cylinder is upright, arc faces -Z (toward camera)

  const material = new THREE.MeshStandardMaterial({
    color: 0x1a1a2e,
    side: THREE.FrontSide,
    transparent: true,
    opacity: 0.85,
  });

  const mesh = new THREE.Mesh(geometry, material);
  group.add(mesh);

  // SDF text via troika-three-text
  const label = node.label ?? "";
  if (label) {
    const text = new Text();
    text.text = label;
    text.fontSize =
      node.role === "heading" ? 0.022 + 0.004 * (3 - (node.level ?? 3)) : 0.016;
    text.color = 0xe0e0e0;
    text.maxWidth = PLANE_WIDTH * 0.9;
    text.anchorX = "center";
    text.anchorY = "middle";
    text.position.z = -(CURVE_RADIUS - 0.003); // sit just inside the curved surface
    text.sync();
    group.add(text);
  }

  // Tag role as user data for raycaster lookup
  group.userData = {
    nodeId: node.id,
    role: node.role,
    controls: node.attributes.controls,
    interactive: false,
  };

  return group;
}
