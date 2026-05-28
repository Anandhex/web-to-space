import * as THREE from "three";
import type { PrimitiveOptions } from "./types";
import { createPrimitive } from "./index";

const DEPTH_OFFSET = 0.02;
const ROW_GAP = 0.07;

export function createHierarchy({
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
    childObject.position.z = DEPTH_OFFSET; // z-indent for hierarchy
    group.add(childObject);

    offsetY -= ROW_GAP;
  }

  return group;
}
