import * as THREE from "three";
import type { PrimitiveOptions } from "./types";
import { createPrimitive } from "./index";

const ROW_GAP = 0.06;

export function createCollection({
  node,
  ir,
}: PrimitiveOptions): THREE.Object3D {
  const group = new THREE.Group();
  group.name = node.id;
  group.userData = {
    nodeId: node.id,
    role: node.role,
    controls: node.attributes.controls,
    interactive: false,
  };

  let offsetY = 0;

  for (const childId of node.children) {
    const childNode = ir.nodes[childId];
    if (!childNode) continue;

    const childObject = createPrimitive({ node: childNode, ir });
    childObject.position.y = offsetY;
    group.add(childObject);

    offsetY -= ROW_GAP;
  }

  return group;
}
