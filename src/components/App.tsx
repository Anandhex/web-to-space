import React, { useCallback, useState } from "react";
import { XRSceneRenderer, type XRSceneRendererProps } from "../renderer";
import { HomeScreen, type HomeSettings, DEFAULT_HOME_SETTINGS } from "./HomeScreen";

export default function App() {
  const [url, setUrl] = useState("");
  const [html, setHtml] = useState("");
  const [loading, setLoading] = useState(false);
  const [activeSettings, setActiveSettings] = useState<HomeSettings>(DEFAULT_HOME_SETTINGS);

  async function loadUrl(targetUrl: string, settings: HomeSettings) {
    setLoading(true);
    setActiveSettings(settings);
    try {
      const res = await fetch(`/proxy?url=${encodeURIComponent(targetUrl)}`);
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const pageHtml = await res.text();
      setUrl(targetUrl);
      setHtml(pageHtml);
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

  if (!html) {
    return <HomeScreen onLoad={loadUrl} loading={loading} />;
  }

  return (
    <div
      style={{ width: "100vw", height: "100vh", position: "relative", overflow: "hidden" }}
    >
      {/* Back to home */}
      <button
        onClick={() => {
          setHtml("");
          setUrl("");
        }}
        style={{
          position: "fixed",
          top: 14,
          left: 14,
          padding: "7px 14px",
          background: "rgba(8, 14, 24, 0.92)",
          border: "1px solid rgba(88, 166, 255, 0.25)",
          color: "#58a6ff",
          borderRadius: "8px",
          cursor: "pointer",
          fontSize: "13px",
          zIndex: 9999,
          fontFamily: "system-ui, sans-serif",
          backdropFilter: "blur(12px)",
          WebkitBackdropFilter: "blur(12px)",
        }}
      >
        ← Home
      </button>

      {/* Active URL indicator */}
      <div
        style={{
          position: "fixed",
          top: 14,
          left: 100,
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
        {url}
      </div>

      <XRSceneRenderer
        html={html}
        url={url}
        width="100%"
        height="100vh"
        deviceType={activeSettings.deviceType}
        parserConfig={activeSettings.parserConfig}
        onPlanReady={onPlanReady}
      />
    </div>
  );
}
