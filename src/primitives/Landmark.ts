import * as THREE from "three";
import { Text } from "troika-three-text";
import type { PrimitiveOptions } from "./types";
import { createPrimitive } from "./index";

const CURVE_RADIUS = 1.5;
const PANEL_WIDTH = 1.2;
const PANEL_HEIGHT = 1.0;
const NAV_PANEL_WIDTH = 1.3;
const NAV_PANEL_HEIGHT = 1.85;
const SEGMENTS = 40;
const ROW_GAP = 0.012; // gap between items (not item height)
const CONTENT_PADDING_TOP = 0.06; // space below landmark label before first child
const CONTENT_PADDING_SIDE = 0.04;
const TOC_ITEM_WIDTH = 1.1;
const TOC_ITEM_HEIGHT = 0.045;
const TOC_ITEM_X = 0;
const TOC_ITEM_Z = 0.02;
const DISPLAY_LABEL_MAX_CHARS = 40;

function truncateDisplayLabel(label: string): string {
  if (label.length <= DISPLAY_LABEL_MAX_CHARS) return label;
  return `${label.slice(0, DISPLAY_LABEL_MAX_CHARS - 1)}…`;
}

// Per-role estimated heights so items don't overlap
const ROLE_HEIGHT: Record<string, number> = {
  heading: 0.045,
  paragraph: 0.055,
  listitem: 0.042,
  link: 0.038,
  button: 0.05,
  separator: 0.018,
  list: 0.04,
  group: 0.04,
  generic: 0.04,
};

function createTocItem(node: PrimitiveOptions["node"]): THREE.Group {
  const item = new THREE.Group();
  item.name = node.id;
  item.userData = {
    nodeId: node.id,
    role: node.role,
    controls: node.attributes.controls,
    interactive: true,
  };

  const hitGeometry = new THREE.PlaneGeometry(TOC_ITEM_WIDTH, TOC_ITEM_HEIGHT);
  const hitMaterial = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.001,
  });
  item.add(new THREE.Mesh(hitGeometry, hitMaterial));

  const title = new Text();
  title.text = truncateDisplayLabel(node.label ?? node.role);
  title.fontSize = 0.017;
  title.color = 0x111111;
  title.maxWidth = TOC_ITEM_WIDTH * 0.95;
  title.anchorX = "left";
  title.anchorY = "middle";
  title.position.set(-TOC_ITEM_WIDTH / 2 + 0.02, 0, 0.012);
  title.sync();
  item.add(title);

  return item;
}

export function createLandmark({ node, ir }: PrimitiveOptions): THREE.Object3D {
  const isNavigation = node.role === "navigation";
  const group = new THREE.Group();
  group.name = node.id;
  group.userData = {
    nodeId: node.id,
    role: node.role,
    controls: node.attributes.controls,
    interactive: false,
  };

  if (isNavigation) {
    const geometry = new THREE.PlaneGeometry(NAV_PANEL_WIDTH, NAV_PANEL_HEIGHT);
    const material = new THREE.MeshStandardMaterial({
      color: 0xf0f0f5,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.92,
    });
    const panel = new THREE.Mesh(geometry, material);
    panel.position.z = -0.01;
    group.add(panel);
  } else {
    // Curved panel backing — cylinder arc around Y-axis, concave toward viewer.
    // thetaStart centres the arc on -Z so the panel faces the camera at origin.
    const thetaLength = PANEL_WIDTH / CURVE_RADIUS;
    const thetaStart = -Math.PI / 2 - thetaLength / 2;
    const geometry = new THREE.CylinderGeometry(
      CURVE_RADIUS, // radiusTop
      CURVE_RADIUS, // radiusBottom
      PANEL_HEIGHT, // height (Y-axis)
      SEGMENTS, // radialSegments
      1, // heightSegments
      true, // openEnded
      thetaStart,
      thetaLength,
    );

    const material = new THREE.MeshStandardMaterial({
      color: 0x0d0d1a,
      side: THREE.FrontSide,
      transparent: true,
      opacity: 0.75,
    });

    group.add(new THREE.Mesh(geometry, material));
  }

  // Optional landmark label at top
  if (node.label) {
    const title = new Text();
    title.text = truncateDisplayLabel(node.label);
    title.fontSize = isNavigation ? 0.022 : 0.018;
    title.color = isNavigation ? 0x111111 : 0x8888bb;
    title.anchorX = "center";
    title.anchorY = "top";
    title.position.set(
      0,
      (isNavigation ? NAV_PANEL_HEIGHT : PANEL_HEIGHT) / 2 - 0.02,
      isNavigation ? 0.01 : -(CURVE_RADIUS - 0.003),
    );
    title.sync();
    group.add(title);
  }

  // Populate children in tree order — top-to-bottom inside the panel
  let offsetY =
    (isNavigation ? NAV_PANEL_HEIGHT : PANEL_HEIGHT) / 2 -
    CONTENT_PADDING_TOP -
    (node.label ? 0.04 : 0);

  for (const childId of node.children) {
    const childNode = ir.nodes[childId];
    if (!childNode) continue;

    // Height consumed by this child
    const itemH = isNavigation
      ? TOC_ITEM_HEIGHT
      : (ROLE_HEIGHT[childNode.role] ?? 0.04);

    // Advance to centre of this item
    offsetY -= itemH / 2;

    const childObject = isNavigation
      ? createTocItem(childNode)
      : createPrimitive({ node: childNode, ir });

    childObject.position.y = offsetY;
    childObject.position.x = isNavigation ? TOC_ITEM_X : CONTENT_PADDING_SIDE;
    childObject.position.z = isNavigation ? TOC_ITEM_Z : 0;

    if (isNavigation) {
      childObject.userData = {
        ...(childObject.userData ?? {}),
        interactive: true,
        nodeId: childId,
        role: childNode.role,
        controls: childNode.attributes.controls,
      };
    }

    group.add(childObject);

    // Advance past bottom of item + gap
    offsetY -= itemH / 2 + ROW_GAP;
    if (offsetY < -PANEL_HEIGHT / 2 + 0.02) break; // clip at panel bottom
  }

  return group;
}
