import React, { useCallback } from "react";
import { useState } from "react";
import { XRSceneRenderer, type XRSceneRendererProps } from "../renderer";

export default function App() {
  const [url, setUrl] = useState("https://web.dev/");

  const [html, setHtml] = useState("");

  async function fetchHTML(url: string) {
    const res = await fetch(`/proxy?url=${encodeURIComponent(url)}`);

    if (!res.ok) {
      throw new Error(`Fetch failed: ${res.status} ${res.statusText}`);
    }

    return res.text();
  }

  async function handleLoad() {
    try {
      const pageHtml = await fetchHTML(url);
      setHtml(pageHtml);
    } catch (err) {
      console.error(err);
    }
  }

  const onPlanReady: XRSceneRendererProps["onPlanReady"] = useCallback(
    (plan) => {
      console.log(plan);
    },
    [],
  );

  return (
    <>
      <div
        style={{
          position: "fixed",
          left: 12,
          top: 12,
          padding: 8,
          background: "rgba(0,0,0,0.6)",
          color: "#fff",
          borderRadius: 6,
          zIndex: 9999,
        }}
      >
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          style={{ width: 260, marginRight: 8 }}
        />

        <button onClick={handleLoad}>Load</button>
      </div>

      <XRSceneRenderer
        html={html}
        url={url}
        height="700px"
        onPlanReady={onPlanReady}
      />
    </>
  );
}
