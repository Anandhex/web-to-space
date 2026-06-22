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
        html={`<main>
          <p><i><b>KPop Demon Hunters</b></i> is a 2025 American animated musical <a href="/wiki/Urban_fantasy" title="Urban fantasy">urban fantasy</a> film<sup id="cite_ref-ChosunBiz-20252_9-0" class="reference"><a href="#cite_note-ChosunBiz-20252-9"><span class="cite-bracket">[</span>9<span class="cite-bracket">]</span></a></sup><sup id="cite_ref-10" class="reference"><a href="#cite_note-10"><span class="cite-bracket">[</span>10<span class="cite-bracket">]</span></a></sup> co-written and directed by <a href="/wiki/Maggie_Kang" title="Maggie Kang">Maggie Kang</a> and <a href="/wiki/Chris_Appelhans" title="Chris Appelhans">Chris Appelhans</a>. It was produced by <a href="/wiki/Sony_Pictures_Animation" title="Sony Pictures Animation">Sony Pictures Animation</a> for <a href="/wiki/Netflix" title="Netflix">Netflix</a> and stars the voices of <a href="/wiki/Arden_Cho" title="Arden Cho">Arden Cho</a>, <a href="/wiki/Ahn_Hyo-seop" title="Ahn Hyo-seop">Ahn Hyo-seop</a>, <a href="/wiki/May_Hong" title="May Hong">May Hong</a>, <a href="/wiki/Ji-young_Yoo" title="Ji-young Yoo">Ji-young Yoo</a>, <a href="/wiki/Yunjin_Kim" title="Yunjin Kim">Yunjin Kim</a>, <a href="/wiki/Daniel_Dae_Kim" title="Daniel Dae Kim">Daniel Dae Kim</a>, <a href="/wiki/Ken_Jeong" title="Ken Jeong">Ken Jeong</a>, and <a href="/wiki/Lee_Byung-hun" title="Lee Byung-hun">Lee Byung-hun</a>. The story follows a <a href="/wiki/K-pop" title="K-pop">K-pop</a> girl group, Huntrix,<sup id="cite_ref-14" class="reference"><a href="#cite_note-14"><span class="cite-bracket">[</span>a<span class="cite-bracket">]</span></a></sup> who lead double lives as <a href="/wiki/Demon_hunter" title="Demon hunter">demon hunters</a>. They face off against a rival <a href="/wiki/Boy_band" title="Boy band">boy band</a>, the Saja Boys, whose members are secretly <a href="/wiki/Demon" title="Demon">demons</a>.
</p><p><i>KPop Demon Hunters</i> originated from Kang's desire to create a story inspired by her <a href="/wiki/Koreans" title="Koreans">Korean heritage</a>, drawing on elements of <a href="/wiki/Korean_mythology" title="Korean mythology">mythology</a>, <a href="/wiki/Demonology" title="Demonology">demonology</a>, and K-pop to craft a visually distinct and culturally rooted film. Production had begun by March 2021. The look of the film was influenced by <a href="/wiki/Stage_lighting" title="Stage lighting">concert lighting</a>, editorial photography, music videos, and <a href="/wiki/Anime" title="Anime">anime</a> and <a href="/wiki/Korean_drama" title="Korean drama">Korean dramas</a>. <a href="/wiki/KPop_Demon_Hunters_(soundtrack)" title="KPop Demon Hunters (soundtrack)">The soundtrack</a> includes original songs by several musicians and a score by <a href="/wiki/Marcelo_Zarvos" title="Marcelo Zarvos">Marcelo Zarvos</a>.
</p></main>`}
        url={url}
        height="700px"
        onPlanReady={onPlanReady}
      />
    </>
  );
}
