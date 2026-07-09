import React, { useCallback, useState } from "react";
import { XRSceneRenderer, type XRSceneRendererProps } from "../renderer";
import {
  HomeScreen,
  type HomeSettings,
  DEFAULT_HOME_SETTINGS,
} from "./HomeScreen";
import { ComparePanel } from "./ComparePanel";
import {
  type Tab,
  type ViewMode,
  makeTabId,
  labelFromUrl,
} from "./viewTypes";
import { proxyUrl } from "../proxy";

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
      const res = await fetch(proxyUrl(url));
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
      // Same-origin URLs (e.g. the built-in /test-elements.html) are fetched
      // directly — no CORS proxy needed, and the proxy is dev-only anyway.
      const isSameOrigin = targetUrl.startsWith(window.location.origin);
      const res = await fetch(isSameOrigin ? targetUrl : proxyUrl(targetUrl));
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
          tabs={tabs}
          activeTabId={activeTabId}
          onSwitchTab={setActiveTabId}
          onCloseTab={handleCloseTab}
          onNewTab={handleNewTab}
        />
      ) : hasContent ? (
        <>
          {/* Active URL indicator.
              top: 78 clears XRSceneRenderer's own in-flow header (VR button
              row + diag row, ~64px tall) — XRSceneRenderer fills 100vh
              starting at y=0, so a top:14 fixed badge here used to sit
              directly on top of the Enter/Exit VR button, eating its clicks. */}
          <div
            style={{
              position: "fixed",
              top: 78,
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

          {/* ViewToggle and Compare button share one fixed group so they
              lay out side by side instead of both claiming top:14/right:14
              independently (which stacked them directly on top of each
              other). */}
          <div
            style={{
              position: "fixed",
              top: 78,
              right: 14,
              zIndex: 9999,
              display: "flex",
              alignItems: "center",
              gap: 8,
            }}
          >
            {/* View-mode switching now lives in the 3D world (XR3DViewToggle).
                Only the parser-comparison launcher remains as an HTML overlay. */}
            <button
              onClick={() => setShowCompare((v) => !v)}
              style={{
                padding: "7px 14px",
                background: showCompare
                  ? "rgba(88,166,255,0.18)"
                  : "rgba(8,14,24,0.8)",
                border: `1px solid ${showCompare ? "rgba(88,166,255,0.5)" : "rgba(30,45,61,0.4)"}`,
                color: showCompare ? "#58a6ff" : "#7a8a9a",
                borderRadius: 8,
                fontSize: 12,
                fontFamily: "monospace",
                cursor: "pointer",
                backdropFilter: "blur(12px)",
                WebkitBackdropFilter: "blur(12px)",
              }}
            >
              ⊞ Compare Parsers
            </button>
          </div>

          <XRSceneRenderer
            html={activeTab.html}
            url={activeTab.url}
            width="100%"
            height="100vh"
            deviceType={activeTab.settings.deviceType}
            theme={activeTab.settings.xrTheme}
            parserConfig={activeTab.settings.parserConfig}
            parserBackend={activeTab.settings.parserBackend}
            viewMode={viewMode}
            onViewModeChange={setViewMode}
            onPlanReady={onPlanReady}
            onExternalNavigate={openInNewTab}
            tabs={tabs}
            activeTabId={activeTabId}
            onSwitchTab={setActiveTabId}
            onCloseTab={handleCloseTab}
            onNewTab={handleNewTab}
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

      {/* Tab switcher is rendered in 3D on both screens now:
          XR3DTabBar inside the Home canvas and inside the XRSceneRenderer
          canvas. No HTML tab bar remains. */}
    </div>
  );
}
