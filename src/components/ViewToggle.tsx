import React, { useState } from "react";
import type { ViewMode } from "./viewTypes";

interface ViewToggleProps {
  mode: ViewMode;
  onChange: (m: ViewMode) => void;
}

const MODES: { id: ViewMode; icon: string; label: string }[] = [
  { id: "standard",  icon: "▣", label: "Standard"  },
  { id: "carousel",  icon: "◎", label: "Carousel"  },
  { id: "cards",     icon: "⊞", label: "Cards"     },
  { id: "door",      icon: "⊟", label: "Door"      },
  { id: "theatre",   icon: "⬭", label: "Theatre"   },
];

export function ViewToggle({ mode, onChange }: ViewToggleProps) {
  const [hoveredId, setHoveredId] = useState<ViewMode | null>(null);

  return (
    <div
      style={{
        position: "fixed",
        top: 14,
        right: 14,
        display: "flex",
        alignItems: "center",
        gap: 2,
        padding: "4px 6px",
        background: "rgba(8, 14, 24, 0.88)",
        border: "1px solid rgba(88, 166, 255, 0.18)",
        borderRadius: 24,
        backdropFilter: "blur(16px)",
        WebkitBackdropFilter: "blur(16px)",
        zIndex: 9999,
        fontFamily: "system-ui, -apple-system, sans-serif",
      }}
    >
      {MODES.map(({ id, icon, label }) => {
        const isActive = mode === id;
        const isHovered = hoveredId === id;
        return (
          <div key={id} style={{ position: "relative" }}>
            <button
              onClick={() => onChange(id)}
              onMouseEnter={() => setHoveredId(id)}
              onMouseLeave={() => setHoveredId(null)}
              title={label}
              style={{
                width: 30,
                height: 30,
                borderRadius: 18,
                background: isActive
                  ? "rgba(88, 166, 255, 0.2)"
                  : isHovered
                  ? "rgba(255,255,255,0.06)"
                  : "transparent",
                border: isActive
                  ? "1px solid rgba(88, 166, 255, 0.45)"
                  : "1px solid transparent",
                color: isActive ? "#58a6ff" : isHovered ? "#8ab4d4" : "#3a5870",
                fontSize: 14,
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                transition: "background 0.15s, border-color 0.15s, color 0.15s",
                lineHeight: 1,
              }}
            >
              {icon}
            </button>
            {/* Tooltip */}
            {isHovered && (
              <div
                style={{
                  position: "absolute",
                  top: "calc(100% + 6px)",
                  left: "50%",
                  transform: "translateX(-50%)",
                  background: "rgba(8, 14, 24, 0.96)",
                  border: "1px solid rgba(88,166,255,0.2)",
                  borderRadius: 6,
                  padding: "3px 8px",
                  fontSize: 11,
                  color: "#7a9abf",
                  whiteSpace: "nowrap",
                  pointerEvents: "none",
                  zIndex: 10000,
                }}
              >
                {label}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
