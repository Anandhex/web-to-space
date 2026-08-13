/**
 * primitives/pointer-capture.ts
 *
 * Pointer capture for the drag-to-scroll rails, in a form that cannot throw.
 *
 * Why this is its own module, and why it matters far more than it looks
 * ────────────────────────────────────────────────────────────────────
 * `releasePointerCapture(id)` throws `NotFoundError` when `id` is not actually
 * captured. The rails bind their drag-end handler to `onPointerUp` AND
 * `onPointerLeave`, and a leave arrives with no matching down every time a
 * pointer merely crosses the panel — so the release ran for a pointer that had
 * never been captured, and threw. `?.` on the method does not help: the method
 * exists, the call fails.
 *
 * On the desktop that throw is nearly invisible. R3F sources its pointer events
 * from DOM listeners on the canvas, so the exception unwinds into the browser's
 * event dispatch, gets logged, and nothing else is affected.
 *
 * In an immersive session the same handler is called by @pmndrs/pointer-events
 * from inside `store.onBeforeFrame` — inside three's XR animation frame. And
 * three's WebGLAnimation is written as:
 *
 *     function onAnimationFrame( time, frame ) {
 *       animationLoop( time, frame );                          // ← throws here
 *       requestId = context.requestAnimationFrame( onAnimationFrame );  // ← never runs
 *     }
 *
 * The next frame is requested only AFTER the callback returns. So ONE throw
 * from ONE stray pointer-leave permanently ends the render loop: `isAnimating`
 * stays true so nothing can restart it, the session stays alive because the
 * browser owns it, and the compositor — receiving no more frames — falls back
 * to the headset's loading environment. The reader, who was reading a document
 * a moment ago, is left standing in limbo with no way out but the system menu.
 *
 * Measured on a Quest 3 (Oculus Browser 149): 106 frames drawn, then the throw,
 * then 2400+ more runtime frames with nothing drawn into any of them.
 *
 * The rule this module enforces: release only what we captured, and never let
 * the attempt escape. Anything called from inside an XR frame is one uncaught
 * exception away from ending the session's rendering for good.
 */

/**
 * Takes pointer capture on the canvas and returns the id to release later, or
 * null if capture was not available. Never throws.
 */
export function capturePointer(
  element: Element | null | undefined,
  pointerId: number | undefined,
): number | null {
  if (element == null || pointerId == null) return null;
  try {
    element.setPointerCapture(pointerId);
    return pointerId;
  } catch {
    // Capture is a convenience — a drag that loses the pointer at the edge of
    // the canvas is worse than one that never captured, but neither is worth a
    // dead frame loop.
    return null;
  }
}

/**
 * Releases a capture taken by `capturePointer`. `captured` is what that call
 * returned — pass null when there is no live capture and this does nothing.
 */
export function releasePointer(
  element: Element | null | undefined,
  captured: number | null,
): void {
  if (element == null || captured == null) return;
  try {
    // Checked as well as guarded: the pointer can be gone already (the drag
    // ended with the controller out of range, the session ended mid-drag), and
    // hasPointerCapture is the cheap way to know.
    if (element.hasPointerCapture(captured)) element.releasePointerCapture(captured);
  } catch {
    /* see the module comment: never throw from inside an XR frame */
  }
}
