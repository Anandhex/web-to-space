import React, { useCallback, useState } from "react";
import { XRSceneRenderer } from "../renderer";
import {
  HomeScreen,
  type HomeSettings,
  DEFAULT_HOME_SETTINGS,
} from "./HomeScreen";
import { ComparePanel } from "./ComparePanel";
import { type Tab, makeTabId, labelFromUrl } from "./viewTypes";
import { proxyUrl } from "../proxy";
import { DiagnosticsLog } from "../renderer/scene/chrome";
import {
  initNav,
  enter as navEnter,
  back as navBackStep,
  jump as navJumpTo,
  current as navCurrent,
  type Axis,
} from "../links/memory";

function makeHomeTab(): Tab {
  return {
    id: makeTabId(),
    label: "New Tab",
    url: "",
    html: "",
    settings: DEFAULT_HOME_SETTINGS,
    nav: null,
    pending: null,
  };
}

export default function App() {
  const [tabs, setTabs] = useState<Tab[]>([makeHomeTab()]);
  const [activeTabId, setActiveTabId] = useState(tabs[0].id);
  const [showCompare, setShowCompare] = useState(false);

  const activeTab = tabs.find((t) => t.id === activeTabId) ?? tabs[0];

  // ── Tab management ────────────────────────────────────────────

  function handleNewTab() {
    const tab = makeHomeTab();
    setTabs((prev) => [...prev, tab]);
    setActiveTabId(tab.id);
  }

  /**
   * Following a link off the page being read.
   *
   * The new tab inherits the CURRENT tab's settings rather than starting from
   * `DEFAULT_HOME_SETTINGS`. Those settings are how the reader has chosen to
   * read — the spatial view, the device profile, the palette, the parser
   * backend — not anything about the particular document, so resetting them on
   * every link meant a reader who picked Wall, followed a citation, and landed
   * back in Standard, with the parser backend they were comparing quietly
   * swapped out from under them.
   */
  async function openInNewTab(url: string) {
    const tab: Tab = {
      ...makeHomeTab(),
      url,
      label: labelFromUrl(url),
      settings: activeTab.settings,
      // A new tab is a new reading session, so this document is its own
      // session root rather than a step in the corridor it was opened from.
      nav: initNav(url, labelFromUrl(url)),
      pending: null,
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

  /** Fetch a document. The CORS proxy is dev-only and same-origin skips it. */
  async function fetchHtml(targetUrl: string): Promise<string> {
    const isSameOrigin = targetUrl.startsWith(window.location.origin);
    const res = await fetch(isSameOrigin ? targetUrl : proxyUrl(targetUrl));
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return res.text();
  }

  async function loadUrl(targetUrl: string, settings: HomeSettings) {
    setLoading(true);
    patchActiveTab({ settings });
    try {
      const html = await fetchHtml(targetUrl);
      patchActiveTab({
        url: targetUrl,
        html,
        label: labelFromUrl(targetUrl),
        settings,
        // The first document of a tab is the session root: the origin every
        // corridor is measured from.
        nav: initNav(targetUrl, labelFromUrl(targetUrl)),
        pending: null,
      });
    } catch (err) {
      console.error("Failed to load:", err);
    } finally {
      setLoading(false);
    }
  }

  // ── Directional traversal ─────────────────────────────────────
  //
  // A door, a stair, a strip or a path off the table. This is the ONE route
  // in-world navigation takes, for the reason `openInNewTab` already gives
  // below: the settings are how the reader has chosen to read, not anything
  // about the document, and a reader who picks Wall and walks east must still
  // be in Wall when they get there.
  //
  // It navigates IN PLACE rather than opening a tab. A corridor is a reading
  // session — spawning a tab per door would give every document a fresh
  // memory and there would be no corridor to walk back down.

  /**
   * Load a document into a tab, keeping its settings, and apply a nav move.
   *
   * The move is committed in ONE step, on arrival: url, html and navigation
   * memory all change together. Nothing about the current document is touched
   * while the next one is in flight — it stays mounted and rendered, and the
   * view goes on animating the direction the reader chose over the top of it.
   *
   * The earlier version cleared `html` up front, which unmounted the scene and
   * put a DOM spinner over the whole canvas. That threw away the only feedback
   * the reader had: they took a door and the world went blank instead of
   * moving. `pending` replaces it — every view can show that a move is under
   * way, in its own geometry, without the document going anywhere.
   */
  async function navigateTab(
    tabId: string,
    targetUrl: string,
    axis: Axis | null,
    advance: (tab: Tab) => Tab["nav"],
  ) {
    setTabs((prev) =>
      prev.map((t) =>
        t.id === tabId ? { ...t, pending: { url: targetUrl, axis } } : t,
      ),
    );
    try {
      const html = await fetchHtml(targetUrl);
      setTabs((prev) =>
        prev.map((t) =>
          // Only commit if this is still the move in flight: a reader who took
          // a second door while the first was loading gets the second one.
          t.id === tabId && t.pending?.url === targetUrl
            ? {
                ...t,
                url: targetUrl,
                label: labelFromUrl(targetUrl),
                html,
                nav: advance(t),
                pending: null,
              }
            : t,
        ),
      );
    } catch (err) {
      console.error("Failed to load:", err);
      // The reader stays where they were, with the door still there. Clearing
      // `pending` is what ends the transition — a view left mid-turn against a
      // document that never arrived is worse than not having moved.
      setTabs((prev) =>
        prev.map((t) =>
          t.id === tabId && t.pending?.url === targetUrl
            ? { ...t, pending: null }
            : t,
        ),
      );
    }
  }

  /** Follow a link in a direction. Records the move so the way back exists. */
  const traverse = useCallback(
    (url: string, axis: Axis, label?: string) => {
      const tab = tabs.find((t) => t.id === activeTabId);
      if (!tab) return;
      void navigateTab(tab.id, url, axis, (t) =>
        t.nav
          ? navEnter(t.nav, { url, label: label ?? labelFromUrl(url), axis })
          : initNav(url, label ?? labelFromUrl(url)),
      );
    },
    [tabs, activeTabId],
  );

  /** The back door every floor, face and table carries. */
  const traverseBack = useCallback(() => {
    const tab = tabs.find((t) => t.id === activeTabId);
    if (!tab?.nav) return;
    const next = navBackStep(tab.nav);
    if (next === tab.nav) return; // at the session root: nowhere to go
    // The way back runs along the axis the reader arrived from.
    void navigateTab(tab.id, navCurrent(next).url, tab.nav.arrivedFrom, () => next);
  }, [tabs, activeTabId]);

  /** A minimap selection: move the world to any node the reader has visited. */
  const traverseJump = useCallback(
    (historyIndex: number) => {
      const tab = tabs.find((t) => t.id === activeTabId);
      if (!tab?.nav) return;
      const next = navJumpTo(tab.nav, historyIndex);
      if (next === tab.nav) return;
      // A minimap jump has no direction: it is a move through the graph, not
      // along a corridor, so the views show it as an arrival rather than a
      // turn. Passing an axis here would animate a direction nobody took.
      void navigateTab(tab.id, navCurrent(next).url, null, () => next);
    },
    [tabs, activeTabId],
  );

  /** A link the reader followed out of the document: opens in a new tab. */
  const handleExternalNavigate = useCallback(
    (href: string) => {
      void openInNewTab(href);
    },
    [openInNewTab],
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
      ) : (
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

          {/* Compare launcher. Kept in a fixed group of its own so it stays
              clear of the URL badge on the opposite corner. */}
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
            {/* View-mode switching now lives on the Home screen — it is part
                of the tab's HomeSettings and is fixed for the loaded page.
                Only the parser-comparison launcher remains here. */}
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
            aiSettings={activeTab.settings.ai}
            viewMode={activeTab.settings.viewMode}
            onExternalNavigate={handleExternalNavigate}
            onTraverse={traverse}
            onTraverseBack={traverseBack}
            onTraverseJump={traverseJump}
            nav={activeTab.nav}
            pending={activeTab.pending}
            tabs={tabs}
            activeTabId={activeTabId}
            onSwitchTab={setActiveTabId}
            onCloseTab={handleCloseTab}
            onNewTab={handleNewTab}
          />
          {/* URL set but HTML not yet fetched.
              An OVERLAY, not a branch. This used to replace <XRSceneRenderer>
              outright, which unmounted its <Canvas> and destroyed the WebGL
              context — while the immersive XRSession, owned by the browser and
              not by React, stayed alive. The session's frame loop then ran
              against a lost context every frame: gl.getParameter() returns null
              once a context is lost, so the Immersive Web Emulator's
              onDeviceFrame threw "Cannot read properties of null (reading '0')"
              on clearColor(A[0], …) forever after any in-scene link click.
              In a real headset the same swap blacks the world out mid-session.
              Keeping the canvas mounted with empty html costs an idle frame
              loop and keeps the session on a live context. */}
          {!hasContent && (
            <div
              style={{
                position: "absolute",
                inset: 0,
                zIndex: 9998,
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
        </>
      )}

      {/* Parser comparison overlay */}
      {showCompare && hasContent && (
        <ComparePanel
          html={activeTab.html}
          url={activeTab.url}
          onClose={() => setShowCompare(false)}
        />
      )}


      {/* Captured console, pinned to the bottom of every screen.
          Global on purpose: the capture is global (see renderer/xr-diagnostics.ts),
          and the errors worth reading here are as likely to happen while a page
          is loading on the Home screen as inside the scene. Renders nothing
          until something is actually logged. */}
      <div
        style={{
          position: "fixed",
          left: 0,
          right: 0,
          bottom: 0,
          zIndex: 10001,
        }}
      >
        <DiagnosticsLog />
      </div>

      {/* Tab switcher is rendered in 3D on both screens now:
          XR3DTabBar inside the Home canvas and inside the XRSceneRenderer
          canvas. No HTML tab bar remains. */}
    </div>
  );
}
