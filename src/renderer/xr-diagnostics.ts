/**
 * renderer/xr-diagnostics.ts
 *
 * Answers one question the headset cannot: "did we ever present a frame?"
 *
 * The symptom this exists for is a reader who taps Enter VR on a Quest and is
 * left in the system's loading environment — the drifting-lights limbo the
 * compositor shows between apps. That environment stays up for exactly one
 * reason: the page holds an immersive session but has not submitted a frame to
 * it. Everything else (a black world, a frozen world, a world in the wrong
 * place) means frames ARE flowing and the fault is ours to see. So the split
 * that matters is between three counters:
 *
 *   sessionFrames — raw session.requestAnimationFrame callbacks. The runtime is
 *                   asking us to draw. If this is 0, the session never started
 *                   pumping and the problem is below three.js.
 *   renderFrames  — R3F useFrame ticks inside the session. If sessionFrames
 *                   climbs and this stays 0, the render loop is not attached:
 *                   the scene tree is suspended, unmounted, or throwing before
 *                   the loop runs.
 *   errors        — uncaught errors, which is how a throw inside an animation
 *                   frame surfaces. three re-requests the next frame BEFORE
 *                   invoking the callback, so a callback that throws every
 *                   frame loops forever without ever presenting: the counters
 *                   climb, nothing is drawn, and the reader sits in limbo.
 *
 * None of this is visible in the headset, so the numbers are kept on the DOM
 * side and rendered into the diagnostics bar, where they survive the session
 * and can be read after taking it off.
 *
 * Frame counters tick at 72–90 Hz. Subscribers are notified on a timer instead
 * of per tick — a React re-render per frame would be its own stall, and the
 * numbers are only ever read by a human.
 */

export interface XRDiagnostics {
  /** Enter-VR was clicked (ms since page load), or null if never. */
  enterRequestedAt: number | null;
  /** The session became active. */
  sessionStartedAt: number | null;
  /** First raw session.requestAnimationFrame callback. */
  firstSessionFrameAt: number | null;
  /** First R3F frame rendered while presenting. */
  firstRenderFrameAt: number | null;
  /** Raw session frames observed since the session started. */
  sessionFrames: number;
  /** R3F frames rendered while presenting. */
  renderFrames: number;
  /** Uncaught errors since the page loaded. */
  errorCount: number;
  /** The most recent uncaught error's message. */
  lastError: string | null;
  /** True between sessionstart and sessionend. */
  presenting: boolean;
}

const state: XRDiagnostics = {
  enterRequestedAt: null,
  sessionStartedAt: null,
  firstSessionFrameAt: null,
  firstRenderFrameAt: null,
  sessionFrames: 0,
  renderFrames: 0,
  errorCount: 0,
  lastError: null,
  presenting: false,
};

/** Snapshot handed to React. Replaced only when something changed. */
let snapshot: XRDiagnostics = { ...state };
const listeners = new Set<() => void>();

/** Coalesces the frame counters into at most one notification per this many ms. */
const NOTIFY_INTERVAL_MS = 500;
let notifyTimer: ReturnType<typeof setTimeout> | null = null;

function publish() {
  snapshot = { ...state };
  for (const l of listeners) l();
}

/** Milestone changes publish at once; counter ticks wait for the timer. */
function touch(immediate: boolean) {
  if (immediate) {
    if (notifyTimer != null) {
      clearTimeout(notifyTimer);
      notifyTimer = null;
    }
    publish();
    return;
  }
  if (notifyTimer != null) return;
  notifyTimer = setTimeout(() => {
    notifyTimer = null;
    publish();
  }, NOTIFY_INTERVAL_MS);
}

const now = () => Math.round(performance.now());

export function markEnterRequested() {
  state.enterRequestedAt = now();
  state.sessionStartedAt = null;
  state.firstSessionFrameAt = null;
  state.firstRenderFrameAt = null;
  state.sessionFrames = 0;
  state.renderFrames = 0;
  touch(true);
}

export function markSessionStart() {
  state.sessionStartedAt = now();
  state.presenting = true;
  touch(true);
}

export function markSessionEnd() {
  state.presenting = false;
  touch(true);
}

export function markSessionFrame() {
  state.sessionFrames++;
  if (state.firstSessionFrameAt == null) {
    state.firstSessionFrameAt = now();
    touch(true);
    return;
  }
  touch(false);
}

export function markRenderFrame() {
  state.renderFrames++;
  if (state.firstRenderFrameAt == null) {
    state.firstRenderFrameAt = now();
    touch(true);
    return;
  }
  touch(false);
}

/**
 * Uncaught errors are the only trace a throwing animation-frame callback
 * leaves: it is not inside any React render, so no error boundary sees it, and
 * on a headset there is no console to read. Installed once, on first use.
 */
let errorCaptureInstalled = false;

export function installXRErrorCapture() {
  if (errorCaptureInstalled || typeof window === "undefined") return;
  errorCaptureInstalled = true;
  window.addEventListener("error", (e) => {
    state.errorCount++;
    state.lastError = e.message || String(e.error ?? "error");
    touch(true);
  });
  window.addEventListener("unhandledrejection", (e) => {
    state.errorCount++;
    const reason = (e as PromiseRejectionEvent).reason;
    state.lastError =
      reason instanceof Error ? reason.message : String(reason ?? "rejection");
    touch(true);
  });
}

// ── React binding ────────────────────────────────────────────

export function subscribeXRDiagnostics(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getXRDiagnostics(): XRDiagnostics {
  return snapshot;
}

/**
 * One line for the diagnostics bar. Returns null before any attempt to enter,
 * so the bar is unchanged for readers who never press the button.
 */
export function formatXRDiagnostics(d: XRDiagnostics): string | null {
  if (d.enterRequestedAt == null) return null;
  const since = (t: number | null) =>
    t == null || d.enterRequestedAt == null
      ? "—"
      : `${((t - d.enterRequestedAt) / 1000).toFixed(2)}s`;
  const parts = [
    `XR session ${since(d.sessionStartedAt)}`,
    `1st runtime frame ${since(d.firstSessionFrameAt)}`,
    `1st render ${since(d.firstRenderFrameAt)}`,
    `${d.renderFrames}/${d.sessionFrames} frames`,
  ];
  if (d.errorCount > 0) parts.push(`${d.errorCount} err: ${d.lastError}`);
  return parts.join(" · ");
}
