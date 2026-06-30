import React from "react";
import type { Tab } from "./viewTypes";

interface TabBarProps {
  tabs: Tab[];
  activeTabId: string;
  onSwitch: (id: string) => void;
  onClose: (id: string) => void;
  onNewTab: () => void;
}

export function TabBar({ tabs, activeTabId, onSwitch, onClose, onNewTab }: TabBarProps) {
  return (
    <div
      style={{
        position: "fixed",
        bottom: 0,
        left: 0,
        right: 0,
        height: 44,
        display: "flex",
        alignItems: "center",
        gap: 4,
        padding: "0 10px",
        background: "rgba(6, 10, 20, 0.94)",
        borderTop: "1px solid rgba(88, 166, 255, 0.12)",
        backdropFilter: "blur(16px)",
        WebkitBackdropFilter: "blur(16px)",
        zIndex: 9999,
        fontFamily: "system-ui, -apple-system, sans-serif",
        overflowX: "auto",
        overflowY: "hidden",
      }}
    >
      {tabs.map((tab) => {
        const isActive = tab.id === activeTabId;
        const initial = tab.label === "New Tab" ? "+" : tab.label[0].toUpperCase();
        return (
          <div
            key={tab.id}
            onClick={() => onSwitch(tab.id)}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              padding: "0 8px 0 10px",
              height: 30,
              borderRadius: 8,
              flexShrink: 0,
              maxWidth: 180,
              cursor: "pointer",
              background: isActive
                ? "rgba(88, 166, 255, 0.14)"
                : "rgba(255, 255, 255, 0.04)",
              border: `1px solid ${isActive ? "rgba(88, 166, 255, 0.35)" : "rgba(255,255,255,0.07)"}`,
              transition: "background 0.15s, border-color 0.15s",
              userSelect: "none",
            }}
          >
            {/* Favicon initial */}
            <span
              style={{
                width: 16,
                height: 16,
                borderRadius: 4,
                background: isActive ? "rgba(88, 166, 255, 0.25)" : "rgba(255,255,255,0.08)",
                color: isActive ? "#58a6ff" : "#4a6080",
                fontSize: 9,
                fontWeight: 700,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                flexShrink: 0,
              }}
            >
              {initial}
            </span>

            {/* Label */}
            <span
              style={{
                fontSize: 11,
                color: isActive ? "#d0e8ff" : "#5a7090",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                flex: 1,
                minWidth: 0,
              }}
            >
              {tab.label}
            </span>

            {/* Close button */}
            <button
              onClick={(e) => {
                e.stopPropagation();
                onClose(tab.id);
              }}
              disabled={tabs.length === 1}
              style={{
                background: "none",
                border: "none",
                padding: "2px 2px",
                color: tabs.length === 1 ? "#1a2840" : isActive ? "#7a9abf" : "#2a4060",
                cursor: tabs.length === 1 ? "default" : "pointer",
                fontSize: 13,
                lineHeight: 1,
                flexShrink: 0,
                borderRadius: 3,
                display: "flex",
                alignItems: "center",
              }}
            >
              ×
            </button>
          </div>
        );
      })}

      {/* New tab button */}
      <button
        onClick={onNewTab}
        style={{
          flexShrink: 0,
          width: 28,
          height: 28,
          borderRadius: 7,
          background: "rgba(255,255,255,0.04)",
          border: "1px solid rgba(255,255,255,0.07)",
          color: "#3a6090",
          fontSize: 17,
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          lineHeight: 1,
          marginLeft: 2,
          transition: "background 0.15s, color 0.15s",
        }}
        onMouseEnter={(e) => {
          (e.currentTarget as HTMLButtonElement).style.background = "rgba(88,166,255,0.1)";
          (e.currentTarget as HTMLButtonElement).style.color = "#58a6ff";
        }}
        onMouseLeave={(e) => {
          (e.currentTarget as HTMLButtonElement).style.background = "rgba(255,255,255,0.04)";
          (e.currentTarget as HTMLButtonElement).style.color = "#3a6090";
        }}
      >
        +
      </button>
    </div>
  );
}
