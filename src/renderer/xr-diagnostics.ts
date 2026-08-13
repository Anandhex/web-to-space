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

export type LogLevel = "error" | "warn";

export interface LogEntry {
  level: LogLevel;
  /** Already flattened to text — the entry outlives the objects it came from. */
  message: string;
  /** ms since page load, so it can be read against the session timings above. */
  at: number;
  /** Consecutive repeats collapsed into one row. A throw inside an animation
   *  frame repeats at 72–90 Hz; without this the buffer holds one second of
   *  the same line and nothing else. */
  repeats: number;
  /** Whether this came through window.onerror rather than console.*(). */
  uncaught: boolean;
}

export interface XRDiagnostics {
  /** Enter-VR was clicked (ms since page load), or null if never. */
  enterRequestedAt: number | null;
  /** navigator.xr.requestSession() was called. */
  sessionRequestedAt: number | null;
  /** requestSession() resolved — the headset is now in the session, showing
   *  its own loading environment until we present something. */
  sessionCreatedAt: number | null;
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
  /** console.warn calls since the page loaded. */
  warnCount: number;
  /** True between sessionstart and sessionend. */
  presenting: boolean;
  /** Set when the watchdog ended a session that never presented a frame. */
  watchdogEndedAt: number | null;
  /** Newest last, capped at MAX_LOGS. */
  logs: LogEntry[];
}

const state: XRDiagnostics = {
  enterRequestedAt: null,
  sessionRequestedAt: null,
  sessionCreatedAt: null,
  sessionStartedAt: null,
  firstSessionFrameAt: null,
  firstRenderFrameAt: null,
  sessionFrames: 0,
  renderFrames: 0,
  errorCount: 0,
  lastError: null,
  warnCount: 0,
  presenting: false,
  watchdogEndedAt: null,
  logs: [],
};

/**
 * How many rows to keep. The interesting error is nearly always the FIRST one —
 * everything after it is usually the same frame failing again — so the buffer
 * drops from the middle rather than the front: the opening errors and the
 * latest ones both survive. See `record`.
 */
const MAX_LOGS = 80;

/** Snapshot handed to React. Replaced only when something changed. */
let snapshot: XRDiagnostics = { ...state };
const listeners = new Set<() => void>();

/** Coalesces the frame counters into at most one notification per this many ms. */
const NOTIFY_INTERVAL_MS = 500;
let notifyTimer: ReturnType<typeof setTimeout> | null = null;

function publish() {
  snapshot = { ...state, logs: state.logs.slice() };
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
  state.sessionRequestedAt = null;
  state.sessionCreatedAt = null;
  state.watchdogEndedAt = null;
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

// ── Console capture ──────────────────────────────────────────
//
// A headset has no devtools. Everything the app would have said — three.js
// warnings, React errors, a throw inside an animation frame — is said to a
// console nobody can open, and the reader is left with a world that simply
// never appears. So the console is mirrored into this buffer and rendered back
// into the page, where it can be read after taking the headset off.
//
// The original console methods are still called: this observes, it does not
// replace. Anything reading the log in a browser that HAS devtools sees exactly
// what it saw before.

/** Flattens one console argument to a line without ever throwing itself. */
function stringifyArg(arg: unknown): string {
  if (typeof arg === "string") return arg;
  if (arg instanceof Error) {
    // The first stack line is the only part worth the width; the rest is
    // framework frames on a 0.72rem panel.
    const frame = arg.stack?.split("\n")[1]?.trim();
    return frame ? `${arg.name}: ${arg.message} (${frame})` : `${arg.name}: ${arg.message}`;
  }
  if (arg === null) return "null";
  if (arg === undefined) return "undefined";
  if (typeof arg === "object") {
    try {
      return JSON.stringify(arg);
    } catch {
      return Object.prototype.toString.call(arg);
    }
  }
  return String(arg);
}

/** Long single lines (three.js shader dumps) would push everything else off. */
const MAX_MESSAGE_CHARS = 400;

function record(level: LogLevel, message: string, uncaught: boolean) {
  const trimmed =
    message.length > MAX_MESSAGE_CHARS
      ? `${message.slice(0, MAX_MESSAGE_CHARS)}…`
      : message;

  if (level === "error") {
    state.errorCount++;
    state.lastError = trimmed;
  } else {
    state.warnCount++;
  }

  const last = state.logs[state.logs.length - 1];
  if (last && last.level === level && last.message === trimmed) {
    // Per-frame repeats collapse into a count rather than filling the buffer.
    last.repeats++;
    last.at = now();
    touch(false);
    return;
  }

  state.logs.push({ level, message: trimmed, at: now(), repeats: 1, uncaught });
  if (state.logs.length > MAX_LOGS) {
    // Drop from the middle: the first errors caused the rest, and the last ones
    // are what is happening now. The middle is repetition.
    state.logs.splice(Math.floor(MAX_LOGS / 2), 1);
  }
  touch(true);
}

/**
 * Uncaught errors are the only trace a throwing animation-frame callback
 * leaves: it is not inside any React render, so no error boundary sees it.
 * Installed once, as early as possible — call it at boot, not from a component,
 * so it is already listening while the app is still starting up.
 */
let captureInstalled = false;

export function installXRErrorCapture() {
  if (captureInstalled || typeof window === "undefined") return;
  captureInstalled = true;

  window.addEventListener("error", (e) => {
    const err = (e as ErrorEvent).error;
    const where = e.filename ? ` (${e.filename}:${e.lineno})` : "";
    record(
      "error",
      err instanceof Error
        ? `${stringifyArg(err)}${where}`
        : `${e.message || "error"}${where}`,
      true,
    );
  });

  window.addEventListener("unhandledrejection", (e) => {
    const reason = (e as PromiseRejectionEvent).reason;
    record("error", `Unhandled rejection: ${stringifyArg(reason)}`, true);
  });

  const nativeError = console.error.bind(console);
  const nativeWarn = console.warn.bind(console);

  console.error = (...args: unknown[]) => {
    nativeError(...args);
    try {
      record("error", args.map(stringifyArg).join(" "), false);
    } catch {
      /* never let instrumentation break the thing it instruments */
    }
  };

  console.warn = (...args: unknown[]) => {
    nativeWarn(...args);
    try {
      record("warn", args.map(stringifyArg).join(" "), false);
    } catch {
      /* as above */
    }
  };
}

// ── Session watchdog ─────────────────────────────────────────
//
// The trap this exists for: `requestSession` succeeds — the headset switches to
// immersive and the compositor puts up its loading environment — and then
// something downstream fails before a single frame is drawn. three's
// `setSession` rejecting partway through is enough (it awaits makeXRCompatible,
// the layer construction and requestReferenceSpace, and any of them can throw).
// The store's `enterVR` promise rejects, the app writes an error into a DOM
// button row nobody can see from inside a headset, and NOBODY ENDS THE SESSION.
// The browser owns it, so it stays. The reader is left standing in limbo with
// the system menu as their only way out.
//
// So: if a session is created and nothing is ever presented through it, end it.
// A reader dropped back into the browser with a line saying why is strictly
// better off than one stranded in a grey room. The bar is deliberately the
// lowest possible one — ONE rendered frame, ever — so a session that is merely
// slow, or stuttering, or drawing a black scene is never touched. Only a
// session that has drawn literally nothing gets ended.

/** How long a session may exist without presenting anything. Generous: a cold
 *  first frame on a mobile GPU (shader compilation, texture upload) is slow,
 *  and killing a session that was about to work would be its own bug. */
const NO_FRAME_TIMEOUT_MS = 12_000;

/**
 * How long the app may go without drawing WHILE the runtime is still asking.
 *
 * This is the stall that a throw inside an XR frame produces: three requests
 * the next frame only after the animation callback returns, so one exception
 * ends the render loop for good while the session — owned by the browser —
 * keeps running. Frames drawn freezes; frames asked for keeps climbing. The
 * headset falls back to its loading environment and the reader is stranded.
 * See primitives/pointer-capture.ts for the instance of this that was found on
 * a Quest 3, and note the general shape: ANY uncaught throw does it.
 *
 * Four seconds is far longer than the worst legitimate hitch (a page turn
 * re-laying out a 28-page document) and far shorter than a reader's patience.
 */
const STALL_TIMEOUT_MS = 4_000;

/** How often the monitor looks. */
const WATCHDOG_TICK_MS = 1_000;

function startSessionWatchdog(session: XRSession) {
  const startedAt = now();
  let lastRenderFrames = 0;
  let lastProgressAt = startedAt;

  const end = (reason: string) => {
    record("error", `Watchdog: ${reason} Ending the session so the headset is not left in the loading environment.`, false);
    state.watchdogEndedAt = now();
    touch(true);
    clearInterval(timer);
    session.end().catch(() => {
      /* already ending */
    });
  };

  const timer = setInterval(() => {
    const elapsed = now() - startedAt;

    if (state.renderFrames > lastRenderFrames) {
      lastRenderFrames = state.renderFrames;
      lastProgressAt = now();
      return;
    }

    // Never drew anything at all.
    if (state.renderFrames === 0) {
      if (elapsed < NO_FRAME_TIMEOUT_MS) return;
      end(
        `no frame was ever presented after ${(elapsed / 1000).toFixed(1)}s — ` +
          (state.sessionFrames > 0
            ? `the runtime asked for ${state.sessionFrames} frames and the app drew none.`
            : `the runtime never asked for a frame.`),
      );
      return;
    }

    // Drew, then stopped, while the runtime kept asking: the render loop is
    // dead rather than slow. A merely slow app still advances the counter.
    const sinceProgress = now() - lastProgressAt;
    if (sinceProgress >= STALL_TIMEOUT_MS && state.sessionFrames > lastRenderFrames) {
      end(
        `rendering stopped after ${state.renderFrames} frames — nothing drawn ` +
          `for ${(sinceProgress / 1000).toFixed(1)}s while the runtime asked ` +
          `for ${state.sessionFrames}. The XR animation loop is dead; the usual ` +
          `cause is an uncaught exception thrown inside a frame.`,
      );
    }
  }, WATCHDOG_TICK_MS);

  session.addEventListener("end", () => clearInterval(timer), { once: true });
}

/**
 * Records every session this page creates, whoever creates it.
 *
 * Wrapping `requestSession` rather than watching the XR store is the point: the
 * failure worth catching is the one where the session is created but the store
 * never learns about it, which is exactly when the store cannot be asked to
 * clean it up. This observes and forwards — the call, its arguments and its
 * result are unchanged.
 */
let watchdogInstalled = false;

export function installXRSessionWatchdog() {
  if (watchdogInstalled || typeof navigator === "undefined") return;
  const xr = navigator.xr;
  if (xr == null) return;
  watchdogInstalled = true;

  const native = xr.requestSession.bind(xr);
  xr.requestSession = async (mode: XRSessionMode, init?: XRSessionInit) => {
    state.sessionRequestedAt = now();
    touch(true);
    try {
      const session = await native(mode, init);
      state.sessionCreatedAt = now();
      touch(true);
      startSessionWatchdog(session);
      return session;
    } catch (err) {
      record("error", `requestSession("${mode}") failed: ${stringifyArg(err)}`, false);
      throw err;
    }
  };
}

/** Empties the buffer (the panel's Clear button). Counters reset with it. */
export function clearXRDiagnosticsLog() {
  state.logs = [];
  state.errorCount = 0;
  state.warnCount = 0;
  state.lastError = null;
  touch(true);
}

/**
 * The whole report as text, for the panel's copy button — timings first, then
 * the log, so a pasted report says what the session did as well as what broke.
 */
export function formatXRDiagnosticsReport(d: XRDiagnostics): string {
  const lines = [
    `userAgent: ${typeof navigator === "undefined" ? "?" : navigator.userAgent}`,
    `enterRequestedAt: ${d.enterRequestedAt ?? "never"}`,
    `sessionRequestedAt: ${d.sessionRequestedAt ?? "never"}`,
    `sessionCreatedAt: ${d.sessionCreatedAt ?? "never"}`,
    `sessionStartedAt: ${d.sessionStartedAt ?? "never"}`,
    `firstSessionFrameAt: ${d.firstSessionFrameAt ?? "never"}`,
    `firstRenderFrameAt: ${d.firstRenderFrameAt ?? "never"}`,
    `frames rendered/runtime: ${d.renderFrames}/${d.sessionFrames}`,
    `errors: ${d.errorCount}  warnings: ${d.warnCount}`,
    `watchdogEndedAt: ${d.watchdogEndedAt ?? "no"}`,
    "",
  ];
  for (const e of d.logs) {
    const tag = e.uncaught ? "UNCAUGHT" : e.level.toUpperCase();
    const rep = e.repeats > 1 ? ` (x${e.repeats})` : "";
    lines.push(`[${(e.at / 1000).toFixed(2)}s] ${tag}${rep}: ${e.message}`);
  }
  return lines.join("\n");
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
 * A handle on the live counters for whoever is holding the debugger.
 *
 * The only machine that can reproduce the fault is the headset, and the only
 * way into it is a remote console — where `import()` is not enough: Vite gives
 * an HMR-updated module a new URL, so an imported copy is a SECOND instance
 * with all its counters at zero, which reads exactly like "nothing happened".
 * This is the app's own instance, by reference.
 */
if (typeof window !== "undefined") {
  (window as unknown as { __xrdiag?: unknown }).__xrdiag = {
    get: getXRDiagnostics,
    report: () => formatXRDiagnosticsReport(getXRDiagnostics()),
    clear: clearXRDiagnosticsLog,
  };
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
    // "session" is requestSession resolving — the headset is in limbo from
    // this moment. "bound" is three finishing setSession. A session with no
    // bind is the stranded case: the headset switched over and the renderer
    // never took the session.
    `XR session ${since(d.sessionCreatedAt)}`,
    `bound ${since(d.sessionStartedAt)}`,
    `1st runtime frame ${since(d.firstSessionFrameAt)}`,
    `1st render ${since(d.firstRenderFrameAt)}`,
    `${d.renderFrames}/${d.sessionFrames} frames`,
  ];
  if (d.watchdogEndedAt != null) parts.push("ended by watchdog");
  if (d.errorCount > 0) parts.push(`${d.errorCount} err: ${d.lastError}`);
  return parts.join(" · ");
}
