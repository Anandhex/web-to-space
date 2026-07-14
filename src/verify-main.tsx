import React from "react";
import ReactDOM from "react-dom/client";
import { XRSceneRenderer } from "./renderer/XRSceneRenderer";
import { DARK_THEME } from "./renderer/theme";

const RED_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const HTML = `
<main>
  <section aria-labelledby="q">
    <h2 id="q">Blockquote</h2>
    <blockquote cite="https://example.com">
      <p>This is a block quotation. It should map to an XRBlockQuote with its
        own distinct visual treatment and a vertical accent rule.</p>
      <footer>— A Notable Person</footer>
    </blockquote>
  </section>
  <section aria-labelledby="a">
    <h2 id="a">Alerts</h2>
    <div role="alert">Assertive alert — something needs attention now.</div>
    <div role="status">Polite status — changes saved.</div>
  </section>
  <section aria-labelledby="b">
    <h2 id="b">Buttons</h2>
    <button type="submit">Submit</button>
    <button type="button">Secondary Button</button>
    <button type="button" disabled>Disabled Button</button>
  </section>
  <section aria-labelledby="i">
    <h2 id="i">Images</h2>
    <figure>
      <img src="${RED_PNG}" alt="A pug wrapped in a blanket" />
      <figcaption>Figure 1 — a figure with an image and caption.</figcaption>
    </figure>
  </section>
</main>
`;

ReactDOM.createRoot(document.getElementById("root")!).render(
  <div style={{ width: "100vw", height: "100vh" }}>
    <XRSceneRenderer
      html={HTML}
      url="https://localhost/verify"
      deviceType="QUEST_3"
      theme={DARK_THEME}
      width="100%"
      height="100%"
    />
  </div>,
);
