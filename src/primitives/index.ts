import type { PrimitiveOptions } from "./types";
import { createTextAtom } from "./TextAtom";
import { createInteractiveAtom } from "./InteractiveAtom";
import { createCollection } from "./Collection";
import { createHierarchy } from "./Hierarchy";
import { createLandmark } from "./Landmark";
import { createComposition } from "./Composition";
import * as THREE from "three";

const INTERACTIVE_ROLES = new Set([
  "textbox",
  "searchbox",
  "checkbox",
  "radio",
  "combobox",
  "slider",
  "spinbutton",
  "switch",
  "button",
  "link",
  "tab",
  "menuitem",
  "treeitem",
  "option",
]);

const COLLECTION_ROLES = new Set([
  "list",
  "table",
  "row",
  "menu",
  "menubar",
  "tablist",
  "tree",
  "grid",
  "feed",
]);

const LANDMARK_ROLES = new Set([
  "main",
  "navigation",
  "banner",
  "contentinfo",
  "complementary",
  "search",
  "form",
  "region",
]);

const COMPOSITION_ROLES = new Set(["form", "search", "dialog", "tabpanel"]);

const HIERARCHY_ROLES = new Set(["figure", "blockquote"]);

export function createPrimitive(options: PrimitiveOptions): THREE.Object3D {
  const { role } = options.node;

  if (COMPOSITION_ROLES.has(role)) return createComposition(options);
  if (LANDMARK_ROLES.has(role)) return createLandmark(options);
  if (COLLECTION_ROLES.has(role)) return createCollection(options);
  if (HIERARCHY_ROLES.has(role)) return createHierarchy(options);
  if (INTERACTIVE_ROLES.has(role)) return createInteractiveAtom(options);

  return createTextAtom(options);
}
