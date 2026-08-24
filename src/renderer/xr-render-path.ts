/**
 * xr-render-path.ts
 *
 * Picks — once, before anything renders — which of three's two WebXR render
 * paths this page will use, and makes that choice readable by the code that
 * builds the session request. Both halves have to agree or the session dies on
 * entry.
 *
 * The two paths
 * ─────────────
 * three's WebXRManager reads `typeof XRWebGLBinding` ONCE, at renderer
 * construction, into `supportsGlBinding`. Present ⇒ it builds an
 * XRProjectionLayer and calls `updateRenderState({ layers: [...] })`. Absent ⇒
 * it falls back to the legacy `new XRWebGLLayer(session, gl)` +
 * `updateRenderState({ baseLayer })`.
 *
 * Why they must agree with the session request
 * ────────────────────────────────────────────
 * @pmndrs/xr asks for the `layers` feature on every session it opens. Once a
 * runtime grants it, `baseLayer` becomes illegal on that session — Chromium
 * (and so the Quest browser) throws
 *
 *   InvalidStateError: Failed to execute 'updateRenderState' on 'XRSession':
 *   Can't use baseLayer with layers feature requested
 *
 * out of `setSession`, after the compositor has already switched the headset
 * into the session. The reader is left staring at the loading environment. The
 * mirror image is just as fatal: request no `layers` feature and then hand the
 * session a projection layer.
 *
 * So the render path is chosen here, and `xrSessionUsesLayers()` feeds the
 * store's session init (see useXRSession) from the same decision.
 *
 * Why the binding is ever deleted
 * ───────────────────────────────
 * WebXR device emulators (Immersive Web Emulator, IWER) polyfill navigator.xr
 * with plain JS objects, and the browser's real XRWebGLBinding constructor
 * rejects those with "parameter 1 is not of type 'XRSession'". Deleting the
 * global is the only way to steer three off that path. Native `navigator.xr` is
 * an instance of the browser's own XRSystem; every emulator's is not.
 *
 * Either path can be forced from the URL — no rebuild, which matters when the
 * only machine that can reproduce the fault is the headset:
 *
 *   ?xr=legacy   force the XRWebGLLayer path (delete the binding)
 *   ?xr=layers   keep the projection-layer path even under an emulator
 */

type XRRenderPath = "projection-layers" | "webgl-layer";

let selected: XRRenderPath = "projection-layers";

/**
 * Deletes `window.XRWebGLBinding` when the legacy path is chosen, so three's
 * one-shot capability read at renderer construction sees the same decision.
 * Call before the first WebGLRenderer is constructed — i.e. from main.tsx,
 * before React renders. Returns a human-readable reason for the log.
 */
export function selectXRRenderPath(): string {
  const forced = new URLSearchParams(window.location.search).get("xr");

  if (forced === "layers") {
    selected = "projection-layers";
    return "projection layers (forced)";
  }
  if (forced === "legacy") {
    selected = "webgl-layer";
    delete (window as unknown as { XRWebGLBinding?: unknown }).XRWebGLBinding;
    return "XRWebGLLayer (forced)";
  }

  const nativeXR =
    typeof XRSystem !== "undefined" &&
    navigator.xr instanceof (XRSystem as unknown as { new (): unknown });
  if (nativeXR) {
    selected = "projection-layers";
    return "projection layers (native WebXR)";
  }

  selected = "webgl-layer";
  delete (window as unknown as { XRWebGLBinding?: unknown }).XRWebGLBinding;
  return "XRWebGLLayer (no native WebXR — emulator or polyfill)";
}

/**
 * Whether the session request may ask for the `layers` feature. False on the
 * legacy path: asking for it there is what makes `baseLayer` illegal.
 */
export function xrSessionUsesLayers(): boolean {
  return selected === "projection-layers";
}
