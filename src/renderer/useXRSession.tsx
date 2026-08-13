/**
 * useXRSession.ts
 *
 * Owns the @react-three/xr store and adapts it to the DOM-side session API the
 * chrome needs (VRButton) plus the flat-preview gating in XRSceneRenderer.
 *
 * Why a store rather than a raw XRSession
 * ───────────────────────────────────────
 * We previously called navigator.xr.requestSession() directly and handed the
 * session to three via gl.xr.setSession(). That put the renderer into XR, but
 * input was left unimplemented: the app drives every interaction through R3F's
 * declarative handlers (onClick / onPointerOver on links, pager buttons, the
 * tab bar), and R3F sources those from DOM pointer events on the canvas — which
 * an immersive session never delivers. Every handler went dead inside VR.
 *
 * @react-three/xr's store renders the controllers/hands and drives the same R3F
 * handlers from their pointers, so interaction works in VR and on the desktop
 * preview from one set of props.
 *
 * The hooks in @react-three/xr (useXR, useXRStore) only work inside the <XR>
 * component, which lives inside <Canvas>. VRButton is DOM, outside the canvas —
 * so this hook reads the store directly via useSyncExternalStore instead.
 *
 * Usage
 * ─────
 * const { store, sessionState, capabilities, enterVR, exitVR, error }
 *   = useXRSession();
 * // <XR store={store}> inside <Canvas>
 */

import { useEffect, useState, useCallback, useMemo, useSyncExternalStore } from "react";
import { createXRStore, type XRStore } from "@react-three/xr";
import {
  installXRErrorCapture,
  markEnterRequested,
  markSessionEnd,
  markSessionFrame,
  markSessionStart,
} from "./xr-diagnostics";

// ─────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────

export type XRSessionState =
  /** No XR session active; showing inline 3-D preview. */
  | "idle"
  /** Immersive-VR session is active. */
  | "immersive";

export interface XRSessionCapabilities {
  /** True when immersive-vr can be entered — real device or injected emulator. */
  immersiveVR: boolean;
}

export interface UseXRSessionReturn {
  /** Pass to <XR store={...}> inside the Canvas. */
  store: XRStore;
  sessionState: XRSessionState;
  capabilities: XRSessionCapabilities;
  /** The active XRSession, or undefined when idle. */
  session: XRSession | undefined;
  /** Enter immersive-vr. */
  enterVR: () => Promise<void>;
  /** Exit the current immersive session. No-op if already idle. */
  exitVR: () => void;
  /** Error from the last failed enterVR attempt. */
  error: string | null;
}

// ─────────────────────────────────────────────────────────────
// Hook
// ─────────────────────────────────────────────────────────────

export function useXRSession(): UseXRSessionReturn {
  // One store for the app's lifetime.
  //
  // `emulate` would inject IWER's Quest 3 emulator on localhost, but it is
  // broken upstream as of @pmndrs/xr 6.6.30 and buys us only a heavy dynamic
  // import (iwer + devui + sem) and a console warning every dev load:
  //   • iwer >= 2.3.0 (what ^2.1.0 resolves to) refuses to install over
  //     Chromium's native navigator.xr, so emulation silently no-ops.
  //   • iwer <= 2.2.1 installs and the session starts, but its frame loop never
  //     pumps, so nothing renders and no input sources appear.
  // Turn this back on (and pin iwer) if the upstream fix lands. Real headsets
  // are unaffected — they never take this path.
  const store = useMemo(
    () =>
      createXRStore({
        emulate: false,
        handTracking: true,
      }),
    [],
  );

  const session = useSyncExternalStore(
    store.subscribe,
    () => store.getState().session,
    () => undefined,
  );

  // An XRSession outlives React. It is owned by the browser (or the emulator),
  // and it holds the canvas's WebGL context through its baseLayer — so if the
  // component that owns this store unmounts, the context dies while the session
  // keeps requesting frames against it. gl.getParameter() returns null on a lost
  // context, which is how the Immersive Web Emulator ends up throwing
  // "Cannot read properties of null (reading '0')" once per frame, forever.
  //
  // store.destroy() only unbinds; it does not end the session. Ending it here is
  // the only thing that stops the frame loop.
  //
  // Callers should prefer to keep the canvas mounted across navigation (see the
  // loading overlay in App.tsx) — an unmount mid-session still blacks the world
  // out for anyone wearing a headset. This just makes it fail cleanly.
  useEffect(
    () => () => {
      store.getState().session?.end().catch(() => {});
      store.destroy();
    },
    [store],
  );

  // Instrumentation for "the headset is stuck in the loading environment".
  //
  // The compositor shows its own limbo until the page submits its first frame,
  // and from inside a headset there is no way to tell a session that never
  // started from one that started and never drew. This probe rides along on the
  // session's own animation frames, so `sessionFrames` counts what the runtime
  // asked for and `renderFrames` (marked from inside the R3F loop, see
  // <XRFrameProbe>) counts what we actually drew. The gap between them is the
  // whole diagnosis. See renderer/xr-diagnostics.ts.
  useEffect(() => {
    installXRErrorCapture();
    if (session == null) return;
    markSessionStart();
    let stopped = false;
    const tick = () => {
      if (stopped) return;
      markSessionFrame();
      try {
        session.requestAnimationFrame(tick);
      } catch {
        /* session ended between frames */
      }
    };
    try {
      session.requestAnimationFrame(tick);
    } catch {
      /* session already gone */
    }
    return () => {
      stopped = true;
      markSessionEnd();
    };
  }, [session]);

  const [vrSupported, setVRSupported] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // isSessionSupported is the single source of truth for the button. Notably it
  // is NOT the same question as "is an emulator object present" — an emulator
  // can exist whose runtime failed to install, and gating on that would light up
  // an Enter-VR button that can only throw "No XR hardware found".
  useEffect(() => {
    if (!("xr" in navigator)) return;
    let cancelled = false;
    (navigator.xr as XRSystem)
      .isSessionSupported("immersive-vr")
      .then((supported) => {
        if (!cancelled) setVRSupported(supported);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const enterVR = useCallback(async () => {
    setError(null);
    markEnterRequested();
    try {
      await store.enterVR();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to start XR session.",
      );
    }
  }, [store]);

  const exitVR = useCallback(() => {
    store.getState().session?.end().catch(() => {});
  }, [store]);

  return {
    store,
    sessionState: session ? "immersive" : "idle",
    capabilities: { immersiveVR: vrSupported },
    session,
    enterVR,
    exitVR,
    error,
  };
}
