/**
 * scene/chrome.tsx
 *
 * Non-3D chrome around the canvas: the Enter-VR button, the door-style TOC nav
 * overlay, and the shared inline style table.
 */
import React from "react";

import type {
  SemanticScene,
} from "../../mapper/types";
import type { LayoutPlan } from "../../layout/types";

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

// ─────────────────────────────────────────────────────────────
// Main component
// ─────────────────────────────────────────────────────────────


export function DoorTOCNav({
  scene,
  plan,
  expandedSectionId,
  setExpandedSectionId,
  setPage,
}: {
  scene: SemanticScene;
  plan: LayoutPlan;
  expandedSectionId: string | null;
  setExpandedSectionId: (id: string | null) => void;
  setPage: (id: string, page: number) => void;
}) {
  const mainPanelId = React.useMemo(
    () => scene.root.children.find((p) => p.type === "XRContentPanel")?.id,
    [scene.root.children],
  );

  // Build the same TOC-item list as CardsOverlay.
  const items = React.useMemo(() => {
    const result: { id: string; label: string; pageIndex: number }[] = [];

    const mainPanel = scene.root.children.find(
      (p) => p.type === "XRContentPanel",
    );
    const sectionPageByLabel = new Map<string, number>();
    if (mainPanel) {
      for (const child of mainPanel.children) {
        const heading = child.children.find((c) => c.type === "XRHeading");
        const label = (heading?.label ?? child.label ?? "")
          .toLowerCase()
          .trim();
        const pageIndex = plan.entries[child.id]?.pageIndex ?? 0;
        if (label) sectionPageByLabel.set(label, pageIndex);
      }
    }

    const tocNav = scene.root.children.find(
      (p) => p.type === "XRNavigationBar",
    );
    if (!tocNav) {
      if (mainPanel) {
        for (const child of mainPanel.children) {
          if (child.type !== "XRSection" && child.type !== "XRArticle")
            continue;
          const heading = child.children.find((c) => c.type === "XRHeading");
          const label = heading?.label ?? child.label ?? child.id;
          const pageIndex = plan.entries[child.id]?.pageIndex ?? 0;
          result.push({ id: child.id, label, pageIndex });
        }
      }
      return result;
    }

    for (const link of tocNav.children) {
      const label = link.label ?? link.content ?? "";
      if (!label) continue;
      const pageIndex = sectionPageByLabel.get(label.toLowerCase().trim()) ?? 0;
      result.push({ id: link.id, label, pageIndex });
    }
    return result;
  }, [scene.root.children, plan.entries]);

  if (items.length === 0) return null;

  return (
    <div
      style={{
        position: "absolute",
        top: 50,
        left: 14,
        bottom: 60,
        width: 200,
        display: "flex",
        flexDirection: "column",
        gap: 3,
        padding: "10px 8px",
        background: "rgba(6, 10, 20, 0.92)",
        border: "1px solid rgba(88, 166, 255, 0.18)",
        borderRadius: 12,
        backdropFilter: "blur(16px)",
        WebkitBackdropFilter: "blur(16px)",
        zIndex: 200,
        fontFamily: "system-ui, -apple-system, sans-serif",
        overflowY: "auto",
      }}
    >
      <div
        style={{
          fontSize: 10,
          color: "#3a5870",
          marginBottom: 4,
          paddingLeft: 4,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
        }}
      >
        Sections
      </div>
      {items.map(({ id, label, pageIndex }) => {
        const isActive = expandedSectionId === id;
        return (
          <button
            key={id}
            onClick={() => {
              setExpandedSectionId(id);
              if (mainPanelId) setPage(mainPanelId, pageIndex);
            }}
            style={{
              padding: "5px 8px",
              textAlign: "left",
              background: isActive ? "rgba(88, 166, 255, 0.15)" : "transparent",
              border: `1px solid ${isActive ? "rgba(88, 166, 255, 0.4)" : "transparent"}`,
              borderRadius: 6,
              color: isActive ? "#58a6ff" : "#7a9abf",
              fontSize: 11,
              cursor: "pointer",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
              transition: "all 0.12s",
            }}
            title={label}
          >
            {isActive ? "▶ " : "  "}
            {label}
          </button>
        );
      })}
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
  cardsBreadcrumb: {
    position: "absolute",
    top: 50,
    left: "50%",
    transform: "translateX(-50%)",
    display: "flex",
    alignItems: "center",
    gap: 10,
    padding: "6px 14px",
    background: "rgba(6, 10, 20, 0.88)",
    border: "1px solid rgba(88, 166, 255, 0.18)",
    borderRadius: 24,
    backdropFilter: "blur(16px)",
    WebkitBackdropFilter: "blur(16px)",
    zIndex: 200,
    fontFamily: "system-ui, -apple-system, sans-serif",
    pointerEvents: "auto" as const,
  },
  cardsBreadcrumbBack: {
    padding: "4px 12px",
    background: "rgba(88, 166, 255, 0.1)",
    border: "1px solid rgba(88, 166, 255, 0.3)",
    borderRadius: 16,
    color: "#58a6ff",
    fontSize: 11,
    cursor: "pointer",
    fontFamily: "inherit",
  },
  cardsBreadcrumbLabel: {
    fontSize: 11,
    color: "#7a9abf",
    maxWidth: 260,
    overflow: "hidden" as const,
    textOverflow: "ellipsis",
    whiteSpace: "nowrap" as const,
  },
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
