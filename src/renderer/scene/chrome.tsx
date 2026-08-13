/**
 * scene/chrome.tsx
 *
 * Non-3D chrome around the canvas: the Enter-VR button and the shared inline
 * style table.
 */
import React from "react";
import {
  clearXRDiagnosticsLog,
  formatXRDiagnosticsReport,
  getXRDiagnostics,
  subscribeXRDiagnostics,
  type LogEntry,
} from "../xr-diagnostics";

export function VRButton({
  supported,
  sessionState,
  error,
  onEnter,
  onExit,
}: {
  supported: boolean;
  sessionState: "idle" | "immersive";
  error: string | null;
  onEnter: () => void;
  onExit: () => void;
}) {
  return (
    <div style={styles.vrButtonRow}>
      {!supported && (
        <span style={styles.unsupported}>
          WebXR not available — inline preview only
        </span>
      )}
      {supported && sessionState === "idle" && (
        <button style={styles.vrBtn} onClick={onEnter}>
          <span style={styles.vrBtnIcon}>◎</span> Enter VR
        </button>
      )}
      {supported && sessionState === "immersive" && (
        <button
          style={{ ...styles.vrBtn, ...styles.vrBtnExit }}
          onClick={onExit}
        >
          <span style={styles.vrBtnIcon}>✕</span> Exit VR
        </button>
      )}
      {error && <span style={styles.error}>{error}</span>}
    </div>
  );
}

/**
 * The console, drawn back into the page.
 *
 * Everything this reader could have learned from devtools is unreachable in a
 * headset: they take it off knowing only that nothing appeared. The capture in
 * renderer/xr-diagnostics.ts mirrors console.error/warn and window.onerror into
 * a buffer, and this is where it is read — a badge that only appears once
 * something has gone wrong, and a panel that survives the session so it can be
 * read afterwards.
 *
 * Deliberately DOM, not in-world: the case it exists for is the one where the
 * scene never renders, so anything drawn in the scene would be invisible too.
 */
export function DiagnosticsLog() {
  const d = React.useSyncExternalStore(
    subscribeXRDiagnostics,
    getXRDiagnostics,
    getXRDiagnostics,
  );
  const [open, setOpen] = React.useState(false);
  const [copied, setCopied] = React.useState(false);

  if (d.logs.length === 0) return null;

  const copy = async () => {
    const text = formatXRDiagnosticsReport(d);
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard permission is not a given in the Quest browser. Falling back
      // to a selectable <textarea> beats failing silently: the reader can still
      // select-all and copy by hand.
      setOpen(true);
    }
  };

  return (
    <div style={styles.logBar}>
      <button
        style={{
          ...styles.logToggle,
          color: d.errorCount > 0 ? "#ff6b6b" : "#f6a623",
          borderColor: d.errorCount > 0 ? "#ff6b6b55" : "#f6a62355",
        }}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        {open ? "▾" : "▸"} {d.errorCount} error{d.errorCount === 1 ? "" : "s"} ·{" "}
        {d.warnCount} warning{d.warnCount === 1 ? "" : "s"}
      </button>
      {open && (
        <>
          <button style={styles.logAction} onClick={copy}>
            {copied ? "copied" : "copy all"}
          </button>
          <button style={styles.logAction} onClick={clearXRDiagnosticsLog}>
            clear
          </button>
        </>
      )}
      {open && (
        <div style={styles.logPanel}>
          {d.logs.map((e: LogEntry, i: number) => (
            <div
              key={`${e.at}-${i}`}
              style={{
                ...styles.logRow,
                color: e.level === "error" ? "#ff9d9d" : "#e3c07b",
              }}
            >
              <span style={styles.logTime}>{(e.at / 1000).toFixed(2)}s</span>
              {e.uncaught && <span style={styles.logTag}>uncaught</span>}
              {e.repeats > 1 && (
                <span style={styles.logTag}>×{e.repeats}</span>
              )}
              <span style={styles.logMessage}>{e.message}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}


// ─────────────────────────────────────────────────────────────
// Styles
// ─────────────────────────────────────────────────────────────

export const styles: Record<string, React.CSSProperties> = {
  root: {
    display: "flex",
    flexDirection: "column",
    fontFamily: "'IBM Plex Mono', 'Fira Code', monospace",
    background: "#fff",
    borderRadius: "8px",
    overflow: "hidden",
    border: "1px solid #1e2d3d",
  },
  vrButtonRow: {
    display: "flex",
    alignItems: "center",
    gap: "0.75rem",
    padding: "0.6rem 1rem",
    background: "#0a0e17",
    borderBottom: "1px solid #1e2d3d",
  },
  vrBtn: {
    display: "flex",
    alignItems: "center",
    gap: "0.4rem",
    padding: "0.4rem 1.1rem",
    background: "linear-gradient(135deg, #1a2840 0%, #0f1e33 100%)",
    border: "1px solid #58a6ff",
    borderRadius: "6px",
    color: "#58a6ff",
    fontSize: "0.82rem",
    fontWeight: 600,
    cursor: "pointer",
    fontFamily: "inherit",
    letterSpacing: "0.04em",
    transition: "background 0.15s, box-shadow 0.15s",
  },
  vrBtnExit: {
    borderColor: "#ff6b6b",
    color: "#ff6b6b",
    background: "linear-gradient(135deg, #2a1010 0%, #1a0a0a 100%)",
  },
  vrBtnIcon: { fontSize: "1rem", lineHeight: 1 },
  unsupported: { fontSize: "0.75rem", color: "#4a5568", fontStyle: "italic" },
  error: { fontSize: "0.75rem", color: "#ff6b6b" },
  diag: {
    display: "flex",
    alignItems: "center",
    gap: "0",
    padding: "0.3rem 1rem",
    background: "#080c14",
    borderBottom: "1px solid #111927",
    fontSize: "0.72rem",
    color: "#4a5568",
    fontFamily: "inherit",
    letterSpacing: "0.02em",
  },
  logBar: {
    display: "flex",
    alignItems: "center",
    flexWrap: "wrap" as const,
    gap: "0.5rem",
    padding: "0.3rem 1rem",
    background: "#0d0608",
    borderBottom: "1px solid #2a1417",
    fontSize: "0.72rem",
    fontFamily: "inherit",
  },
  logToggle: {
    background: "transparent",
    border: "1px solid",
    borderRadius: 4,
    padding: "0.15rem 0.5rem",
    fontSize: "0.72rem",
    fontFamily: "inherit",
    cursor: "pointer",
    letterSpacing: "0.02em",
  },
  logAction: {
    background: "transparent",
    border: "1px solid #2a3441",
    borderRadius: 4,
    padding: "0.15rem 0.5rem",
    fontSize: "0.7rem",
    fontFamily: "inherit",
    color: "#7a8a9a",
    cursor: "pointer",
  },
  logPanel: {
    // Its own row under the buttons, and scrollable rather than tall: a page
    // that errors every frame must not push the canvas off the screen.
    flexBasis: "100%",
    maxHeight: "9rem",
    overflowY: "auto" as const,
    background: "#080405",
    border: "1px solid #2a1417",
    borderRadius: 4,
    padding: "0.35rem 0.5rem",
  },
  logRow: {
    display: "flex",
    gap: "0.4rem",
    alignItems: "baseline",
    padding: "0.1rem 0",
    lineHeight: 1.45,
  },
  logTime: { color: "#4a5568", flexShrink: 0 },
  logTag: {
    color: "#8b949e",
    background: "#1a1114",
    borderRadius: 3,
    padding: "0 0.25rem",
    flexShrink: 0,
    fontSize: "0.66rem",
  },
  logMessage: { wordBreak: "break-word" as const, whiteSpace: "pre-wrap" as const },
  flatOverlay: {
    position: "absolute" as const,
    inset: 0,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 10,
    pointerEvents: "none" as const,
  },
  flatPanel: {
    pointerEvents: "all" as const,
    width: "80%",
    maxWidth: 1100,
    height: "90%",
    borderRadius: 16,
    overflow: "hidden",
    boxShadow:
      "0 8px 80px rgba(88, 166, 255, 0.2), 0 0 0 1px rgba(88, 166, 255, 0.28)",
    background: "rgba(8, 14, 24, 0.98)",
    display: "flex",
    flexDirection: "column" as const,
  },
  flatChrome: {
    padding: "9px 16px",
    borderBottom: "1px solid rgba(88, 166, 255, 0.18)",
    color: "#58a6ff",
    fontSize: 12,
    fontFamily: "system-ui, -apple-system, sans-serif",
    background: "rgba(6, 10, 20, 0.95)",
    flexShrink: 0,
    display: "flex",
    alignItems: "center",
    gap: 8,
  },
};
