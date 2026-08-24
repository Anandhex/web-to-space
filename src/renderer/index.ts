/**
 * renderer/index.ts
 *
 * Barrel export for the XR renderer package.
 *
 * Peer dependencies (install separately):
 *   npm install three @react-three/fiber @react-three/drei
 *   npm install --save-dev @types/three
 *
 * Usage:
 *   import { XRSceneRenderer } from "./renderer";
 *
 *   <XRSceneRenderer
 *     html={rawHTMLString}
 *     height="700px"
 *     onPlanReady={(plan) => console.log(plan.diagnostics)}
 *   />
 */

export { XRSceneRenderer } from "./XRSceneRenderer";
export type { XRSceneRendererProps } from "./XRSceneRenderer";
