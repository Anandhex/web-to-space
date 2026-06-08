/**
 * useXRSession.ts
 *
 * React hook that manages the full WebXR session lifecycle:
 *   - Detects whether the browser supports immersive-vr
 *   - Tracks session state: "idle" | "inline" | "immersive"
 *   - Exposes enterVR / exitVR imperatively
 *   - Provides the raw XRSession to the renderer so R3F can tick
 *     the XR frame loop via @react-three/xr's <XR> provider
 *
 * Architecture position:
 *   useXRSession  ←→  XRSceneRenderer (wires session to <XR session={...}>)
 *
 * Usage
 * ─────
 * const { sessionState, capabilities, session, enterVR, exitVR, error }
 *   = useXRSession();
 */

import { useEffect, useState, useCallback, useRef } from "react";

// ─────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────

export type XRSessionState =
  /** No XR session active; showing inline 3-D preview. */
  | "idle"
  /** Immersive-VR session is active. */
  | "immersive";

export interface XRSessionCapabilities {
  /** True when the UA declares support for immersive-vr. */
  immersiveVR: boolean;
}

export interface UseXRSessionReturn {
  sessionState: XRSessionState;
  capabilities: XRSessionCapabilities;
  /** The active XRSession, or null when idle. */
  session: XRSession | null;
  /** Enter immersive-vr. Rejects on failure. */
  enterVR: () => Promise<void>;
  /** Exit the current immersive session. No-op if already idle. */
  exitVR: () => void;
  /** Error from the last failed enterVR attempt. */
  error: string | null;
}

// ─────────────────────────────────────────────────────────────
// WebXR session init options
// ─────────────────────────────────────────────────────────────

/**
 * local-floor: reference space anchored to the physical floor.
 * Essential for correct eye-level placement in our scene — the layout
 * engine places panels relative to a 1.5 m eye-level origin.
 *
 * Optional: hand-tracking for future pointer/ray input.
 */
const REQUIRED_FEATURES: XRSessionInit["requiredFeatures"] = ["local-floor"];
const OPTIONAL_FEATURES: XRSessionInit["optionalFeatures"] = ["hand-tracking"];

// ─────────────────────────────────────────────────────────────
// Hook
// ─────────────────────────────────────────────────────────────

export function useXRSession(): UseXRSessionReturn {
  const [sessionState, setSessionState] = useState<XRSessionState>("idle");
  const [capabilities, setCapabilities] = useState<XRSessionCapabilities>({
    immersiveVR: false,
  });
  const [session, setSession] = useState<XRSession | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Ref so cleanup callbacks see the current session without stale closures
  const sessionRef = useRef<XRSession | null>(null);

  // ── Capability detection (once on mount) ─────────────────
  useEffect(() => {
    if (!("xr" in navigator)) return;
    (navigator.xr as XRSystem)
      .isSessionSupported("immersive-vr")
      .then((supported) => setCapabilities({ immersiveVR: supported }))
      .catch(() => {});
  }, []);

  // ── Session end handler ───────────────────────────────────
  const handleSessionEnd = useCallback(() => {
    sessionRef.current = null;
    setSession(null);
    setSessionState("idle");
  }, []);

  // ── enterVR ───────────────────────────────────────────────
  const enterVR = useCallback(async () => {
    if (!("xr" in navigator)) {
      setError("WebXR is not supported in this browser.");
      return;
    }
    if (sessionRef.current) return; // already in session
    setError(null);

    try {
      const newSession = await (navigator.xr as XRSystem).requestSession(
        "immersive-vr",
        {
          requiredFeatures: REQUIRED_FEATURES,
          optionalFeatures: OPTIONAL_FEATURES,
        },
      );
      newSession.addEventListener("end", handleSessionEnd);
      sessionRef.current = newSession;
      setSession(newSession);
      setSessionState("immersive");
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to start XR session.",
      );
    }
  }, [handleSessionEnd]);

  // ── exitVR ────────────────────────────────────────────────
  const exitVR = useCallback(() => {
    sessionRef.current?.end().catch(() => {});
  }, []);

  // ── Cleanup on unmount ────────────────────────────────────
  useEffect(() => {
    return () => {
      sessionRef.current?.end().catch(() => {});
    };
  }, []);

  return { sessionState, capabilities, session, enterVR, exitVR, error };
}
