/**
 * primitives.tsx — barrel
 *
 * Core XR primitive React Three Fiber components. The implementation was split
 * out of this (formerly ~3300-line) file into the `primitives/` package for
 * readability; this barrel preserves the original public import surface so no
 * consumer (`import { ... } from "./primitives"`) needs to change.
 *
 * Package layout:
 *   primitives/constants.ts   — panel geometry + Z-depth/render-order ladder
 *   primitives/contexts.tsx   — shared React contexts + hooks
 *   primitives/surface.tsx    — <Surface> card + geometry/transform helpers
 *   primitives/inline.tsx     — <ClippedText> + inline-prose row system
 *   primitives/meshes/*.tsx   — the primitive meshes, grouped by family
 *
 * Design decisions, colour system, and depth-ladder rules are documented in
 * primitives/constants.ts and the individual modules.
 */

export * from "./primitives/constants";
export * from "./primitives/contexts";
export * from "./primitives/surface";
export * from "./primitives/inline";

export * from "./primitives/meshes/block";
export * from "./primitives/meshes/navigation";
export * from "./primitives/meshes/media";
export * from "./primitives/meshes/list";
export * from "./primitives/meshes/controls";
export * from "./primitives/meshes/inline-mesh";
