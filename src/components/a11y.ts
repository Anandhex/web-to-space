/**
 * components/a11y.ts
 *
 * The shared pieces of the accessibility layer that sits alongside the WebGL
 * canvases. Its own module because both the launcher (components/HomeScreen)
 * and the document viewer (renderer/XRSceneRenderer) need it, and importing
 * one from the other would close a components → renderer → components cycle.
 */
import { useEffect, useState } from "react";
import type { CSSProperties } from "react";

/**
 * Clipped out of sight, but still in the accessibility tree and still
 * focusable — the classic `.sr-only` / `.visually-hidden` recipe.
 *
 * The two rules that make it work, and that are easy to undo by accident:
 *
 *  • NOT `display: none` and NOT `visibility: hidden`. Either removes the
 *    element from the accessibility tree AND from the tab order, which is the
 *    whole point of having it.
 *  • It keeps a real, non-zero box (1 × 1) and is clipped rather than sized to
 *    nothing, because some browsers will not focus a zero-area element.
 */
export const SR_ONLY: CSSProperties = {
  position: "absolute",
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: "hidden",
  clip: "rect(0 0 0 0)",
  clipPath: "inset(50%)",
  whiteSpace: "nowrap",
  border: 0,
};

/**
 * Tracks the OS "reduce motion" setting, live.
 *
 * Both surfaces have background motion that nothing depends on — the
 * launcher's drifting starfield, the loading spinner — and a slow field-wide
 * drift is exactly the kind of thing that provokes symptoms in vestibular
 * disorders (WCAG 2.3.3).
 */
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function")
      return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const apply = () => setReduced(mq.matches);
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);
  return reduced;
}
