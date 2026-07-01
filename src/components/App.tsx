import React, { useCallback, useState } from "react";
import { XRSceneRenderer, type XRSceneRendererProps } from "../renderer";
import {
  HomeScreen,
  type HomeSettings,
  DEFAULT_HOME_SETTINGS,
} from "./HomeScreen";
import { TabBar } from "./TabBar";
import { ViewToggle } from "./ViewToggle";
import { ComparePanel } from "./ComparePanel";
import {
  type Tab,
  type ViewMode,
  makeTabId,
  labelFromUrl,
} from "./viewTypes";

function makeHomeTab(): Tab {
  return {
    id: makeTabId(),
    label: "New Tab",
    url: "",
    html: "",
    settings: DEFAULT_HOME_SETTINGS,
  };
}

export default function App() {
  const [tabs, setTabs] = useState<Tab[]>([makeHomeTab()]);
  const [activeTabId, setActiveTabId] = useState(tabs[0].id);
  const [viewMode, setViewMode] = useState<ViewMode>("standard");
  const [showCompare, setShowCompare] = useState(false);

  const activeTab = tabs.find((t) => t.id === activeTabId) ?? tabs[0];

  // ── Tab management ────────────────────────────────────────────

  function handleNewTab() {
    const tab = makeHomeTab();
    setTabs((prev) => [...prev, tab]);
    setActiveTabId(tab.id);
  }

  async function openInNewTab(url: string) {
    const tab: Tab = {
      ...makeHomeTab(),
      url,
      label: labelFromUrl(url),
    };
    setTabs((prev) => [...prev, tab]);
    setActiveTabId(tab.id);
    try {
      const res = await fetch(`/proxy?url=${encodeURIComponent(url)}`);
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const html = await res.text();
      setTabs((prev) =>
        prev.map((t) => (t.id === tab.id ? { ...t, html } : t)),
      );
    } catch (err) {
      console.error("Failed to load:", err);
    }
  }

  function handleCloseTab(id: string) {
    setTabs((prev) => {
      if (prev.length === 1) return prev;
      const idx = prev.findIndex((t) => t.id === id);
      const next = prev.filter((t) => t.id !== id);
      if (id === activeTabId) {
        const newActive = next[Math.max(0, idx - 1)];
        setActiveTabId(newActive.id);
      }
      return next;
    });
  }

  function patchActiveTab(patch: Partial<Tab>) {
    setTabs((prev) =>
      prev.map((t) => (t.id === activeTabId ? { ...t, ...patch } : t)),
    );
  }

  // ── URL loading ───────────────────────────────────────────────

  const [loading, setLoading] = useState(false);

  async function loadUrl(targetUrl: string, settings: HomeSettings) {
    setLoading(true);
    patchActiveTab({ settings });
    try {
      const res = await fetch(`/proxy?url=${encodeURIComponent(targetUrl)}`);
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const html = await res.text();
      patchActiveTab({
        url: targetUrl,
        html,
        label: labelFromUrl(targetUrl),
        settings,
      });
    } catch (err) {
      console.error("Failed to load:", err);
    } finally {
      setLoading(false);
    }
  }

  const onPlanReady: XRSceneRendererProps["onPlanReady"] = useCallback(
    (plan) => {
      console.log(plan);
    },
    [],
  );

  // ── Render ────────────────────────────────────────────────────

  const hasUrl = Boolean(activeTab.url);
  const hasContent = Boolean(activeTab.html);

  return (
    <div
      style={{
        width: "100vw",
        height: "100vh",
        position: "relative",
        overflow: "hidden",
      }}
    >
      {/* Main content area */}
      {!hasUrl ? (
        <HomeScreen
          onLoad={loadUrl}
          loading={loading}
        />
      ) : hasContent ? (
        <>
          {/* Active URL indicator */}
          <div
            style={{
              position: "fixed",
              top: 14,
              left: 14,
              padding: "7px 14px",
              background: "rgba(8, 14, 24, 0.8)",
              border: "1px solid rgba(30, 45, 61, 0.4)",
              color: "#7a8a9a",
              borderRadius: "8px",
              fontSize: "12px",
              zIndex: 9999,
              fontFamily: "monospace",
              maxWidth: "55vw",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              backdropFilter: "blur(12px)",
              WebkitBackdropFilter: "blur(12px)",
            }}
          >
            {activeTab.url}
          </div>

          <ViewToggle mode={viewMode} onChange={setViewMode} />

          {/* Compare button */}
          <button
            onClick={() => setShowCompare((v) => !v)}
            style={{
              position: "fixed",
              top: 14,
              right: 14,
              padding: "7px 14px",
              background: showCompare
                ? "rgba(88,166,255,0.18)"
                : "rgba(8,14,24,0.8)",
              border: `1px solid ${showCompare ? "rgba(88,166,255,0.5)" : "rgba(30,45,61,0.4)"}`,
              color: showCompare ? "#58a6ff" : "#7a8a9a",
              borderRadius: 8,
              fontSize: 12,
              zIndex: 9999,
              fontFamily: "monospace",
              cursor: "pointer",
              backdropFilter: "blur(12px)",
              WebkitBackdropFilter: "blur(12px)",
            }}
          >
            ⊞ Compare Parsers
          </button>

          <XRSceneRenderer
            html={activeTab.html}
            url={activeTab.url}
            width="100%"
            height="100vh"
            deviceType={activeTab.settings.deviceType}
            parserConfig={activeTab.settings.parserConfig}
            parserBackend={activeTab.settings.parserBackend}
            viewMode={viewMode}
            onPlanReady={onPlanReady}
            onExternalNavigate={openInNewTab}
          />
        </>
      ) : (
        /* URL set but HTML not yet fetched — loading state */
        <div
          style={{
            width: "100%",
            height: "100vh",
            background: "#050a10",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 16,
            fontFamily: "system-ui, -apple-system, sans-serif",
          }}
        >
          <div
            style={{
              width: 40,
              height: 40,
              border: "2px solid rgba(88, 166, 255, 0.15)",
              borderTop: "2px solid #58a6ff",
              borderRadius: "50%",
              animation: "app-spin 1s linear infinite",
            }}
          />
          <p style={{ margin: 0, color: "#58a6ff", fontSize: 13, letterSpacing: "0.06em" }}>
            Rendering in 3D…
          </p>
          <p style={{ margin: 0, color: "#3a5a7a", fontSize: 11, fontFamily: "monospace", maxWidth: "60vw", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {activeTab.url}
          </p>
          <style>{`@keyframes app-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
        </div>
      )}

      {/* Parser comparison overlay */}
      {showCompare && hasContent && (
        <ComparePanel
          html={activeTab.html}
          url={activeTab.url}
          onClose={() => setShowCompare(false)}
        />
      )}

      {/* Tab bar — always visible */}
      <TabBar
        tabs={tabs}
        activeTabId={activeTabId}
        onSwitch={setActiveTabId}
        onClose={handleCloseTab}
        onNewTab={handleNewTab}
      />
    </div>
  );
}
