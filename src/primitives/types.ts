import * as THREE from "three";
import type { IRNode, PageIR } from "../ir/parser";

export interface PrimitiveOptions {
  node: IRNode;
  ir: PageIR;
}

export type PrimitiveMapper = (options: PrimitiveOptions) => THREE.Object3D;
