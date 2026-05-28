import * as THREE from "three";
import type { PageIR, IRNode } from "../ir/parser";
import { collectLandmarkIds } from "../ir/parser";
import { createPrimitive } from "../primitives/index";

// ─── Spatial Constants ────────────────────────────────────────────────────────

// With CylinderGeometry arc centred on -Z, the visible surface sits at
// z = -CURVE_RADIUS (1.5 m) from the group origin. Panel positions therefore
// place the group so that surface lands at the intended viewing distance.
// Surface Z = group.z - 1.5  →  group.z = intended_surface_z + 1.5
const MAIN_POSITION = new THREE.Vector3(0, 0, 0); // surface at z=-1.5
const ASIDE_POSITION = new THREE.Vector3(1.05, 0, 0.1); // right lane
const NAV_POSITION = new THREE.Vector3(-1.1, 0.1, 0.1); // left TOC lane
const BANNER_POSITION = new THREE.Vector3(0, 0.75, 0.3); // surface at z=-1.2
const CONTENTINFO_POSITION = new THREE.Vector3(0, -0.75, 0); // surface at z=-1.5

const ASIDE_ANGLE_Y = Math.PI / 14; // slight inward angle
const NAV_ANGLE_X = 0;

// ─── Landmark Role Buckets ────────────────────────────────────────────────────

const MAIN_ROLES = new Set(["main"]);
const ASIDE_ROLES = new Set(["complementary"]);
const NAV_ROLES = new Set(["navigation"]);
const BANNER_ROLES = new Set(["banner"]);
const CONTENTINFO_ROLES = new Set(["contentinfo"]);
const REGION_ROLES = new Set(["region", "search", "form"]);

// ─── Shell ────────────────────────────────────────────────────────────────────

export class SpatialShell {
  private scene: THREE.Scene;
  private ir: PageIR;
  public root: THREE.Group;
  private panelByNodeId: Map<string, THREE.Group> = new Map();
  private defaultTransforms: Map<
    string,
    { position: THREE.Vector3; rotation: THREE.Euler; scale: THREE.Vector3 }
  > = new Map();

  // Panel groups — exposed for raycasting
  public mainPanel: THREE.Group | null = null;
  public asidePanel: THREE.Group | null = null;
  public navPanel: THREE.Group | null = null;
  public bannerPanel: THREE.Group | null = null;
  public contentInfoPanel: THREE.Group | null = null;
  public regionPanels: THREE.Group[] = [];

  constructor(scene: THREE.Scene, ir: PageIR) {
    this.scene = scene;
    this.ir = ir;
    this.root = new THREE.Group();
    this.root.name = "SpatialShell";
  }

  build(): void {
    this.panelByNodeId.clear();
    const landmarkNodes = collectLandmarkIds(this.ir.landmarks)
      .map((id) => this.ir.nodes[id])
      .filter((node): node is IRNode => node !== undefined);

    for (const node of landmarkNodes) {
      const primitive = createPrimitive({ node, ir: this.ir });

      if (MAIN_ROLES.has(node.role)) {
        this.mainPanel = this.wrapPanel(primitive, MAIN_POSITION, 0, 0);
        this.panelByNodeId.set(node.id, this.mainPanel);
        this.defaultTransforms.set(node.id, {
          position: this.mainPanel.position.clone(),
          rotation: this.mainPanel.rotation.clone(),
          scale: this.mainPanel.scale.clone(),
        });
        this.root.add(this.mainPanel);
      } else if (ASIDE_ROLES.has(node.role)) {
        this.asidePanel = this.wrapPanel(
          primitive,
          ASIDE_POSITION,
          ASIDE_ANGLE_Y,
          0,
        );
        this.panelByNodeId.set(node.id, this.asidePanel);
        this.defaultTransforms.set(node.id, {
          position: this.asidePanel.position.clone(),
          rotation: this.asidePanel.rotation.clone(),
          scale: this.asidePanel.scale.clone(),
        });
        this.root.add(this.asidePanel);
      } else if (NAV_ROLES.has(node.role)) {
        this.navPanel = this.wrapPanel(primitive, NAV_POSITION, 0, NAV_ANGLE_X);
        this.navPanel.scale.setScalar(1.0);
        this.panelByNodeId.set(node.id, this.navPanel);
        this.defaultTransforms.set(node.id, {
          position: this.navPanel.position.clone(),
          rotation: this.navPanel.rotation.clone(),
          scale: this.navPanel.scale.clone(),
        });
        this.root.add(this.navPanel);
      } else if (BANNER_ROLES.has(node.role)) {
        this.bannerPanel = this.wrapPanel(primitive, BANNER_POSITION, 0, 0);
        this.panelByNodeId.set(node.id, this.bannerPanel);
        this.defaultTransforms.set(node.id, {
          position: this.bannerPanel.position.clone(),
          rotation: this.bannerPanel.rotation.clone(),
          scale: this.bannerPanel.scale.clone(),
        });
        this.root.add(this.bannerPanel);
      } else if (CONTENTINFO_ROLES.has(node.role)) {
        this.contentInfoPanel = this.wrapPanel(
          primitive,
          CONTENTINFO_POSITION,
          0,
          0,
        );
        this.panelByNodeId.set(node.id, this.contentInfoPanel);
        this.defaultTransforms.set(node.id, {
          position: this.contentInfoPanel.position.clone(),
          rotation: this.contentInfoPanel.rotation.clone(),
          scale: this.contentInfoPanel.scale.clone(),
        });
        this.root.add(this.contentInfoPanel);
      } else if (REGION_ROLES.has(node.role)) {
        // Keep auxiliary regions available but outside the primary 3-lane layout.
        const offset = this.regionPanels.length;
        const pos = new THREE.Vector3(2.2, 0.3 - offset * 0.4, -1.6);
        const panel = this.wrapPanel(primitive, pos, -ASIDE_ANGLE_Y, 0);
        this.regionPanels.push(panel);
        this.panelByNodeId.set(node.id, panel);
        this.defaultTransforms.set(node.id, {
          position: panel.position.clone(),
          rotation: panel.rotation.clone(),
          scale: panel.scale.clone(),
        });
        this.root.add(panel);
      }
    }

    this.scene.add(this.root);
  }

  // Collect all interactive Object3Ds for raycasting
  getInteractives(): THREE.Object3D[] {
    const interactives: THREE.Object3D[] = [];
    this.root.traverse((obj) => {
      if (obj.userData?.interactive === true) {
        interactives.push(obj);
      }
    });
    return interactives;
  }

  // Clean up — call before loading a new page
  dispose(): void {
    this.scene.remove(this.root);
    this.root.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        obj.geometry.dispose();
        if (Array.isArray(obj.material)) {
          obj.material.forEach((m) => m.dispose());
        } else {
          obj.material.dispose();
        }
      }
    });
    this.mainPanel = null;
    this.asidePanel = null;
    this.navPanel = null;
    this.bannerPanel = null;
    this.contentInfoPanel = null;
    this.regionPanels = [];
    this.panelByNodeId.clear();
    this.defaultTransforms.clear();
  }

  focusNode(nodeId: string): void {
    for (const [id, panel] of this.panelByNodeId.entries()) {
      const defaults = this.defaultTransforms.get(id);
      if (!defaults) continue;
      panel.position.copy(defaults.position);
      panel.rotation.copy(defaults.rotation);
      panel.scale.copy(defaults.scale);
    }

    const panel = this.panelByNodeId.get(nodeId);
    if (!panel) return;

    panel.position.copy(MAIN_POSITION);
    panel.rotation.set(0, 0, 0);
    panel.scale.setScalar(1.08);
  }

  private wrapPanel(
    object: THREE.Object3D,
    position: THREE.Vector3,
    rotationY: number,
    rotationX: number,
  ): THREE.Group {
    const wrapper = new THREE.Group();
    wrapper.add(object);
    wrapper.position.copy(position);
    wrapper.rotation.y = rotationY;
    wrapper.rotation.x = rotationX;
    return wrapper;
  }
}
