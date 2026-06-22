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
          <section class="devsite-landing-row devsite-landing-row-3-up devsite-landing-row-cards devsite-landing-row-item-centered" background="white" header-position="top">
    <div class="devsite-landing-row-inner">

    
      

      
      

      

        <div class="devsite-landing-row-group">
        
          <div class="devsite-landing-row-item" background="grey" description-position="bottom">

  
    
<div class="devsite-landing-row-item-media
            ">
  
    <figure class="devsite-landing-row-item-image">
  
  <a href="https://web.dev/learn/html">
    
  
  <picture>
    
    <img alt="" src="https://web.dev/static/learn/html/card.png" srcset="https://web.dev/static/learn/html/card_36.png 36w,https://web.dev/static/learn/html/card_48.png 48w,https://web.dev/static/learn/html/card_72.png 72w,https://web.dev/static/learn/html/card_96.png 96w,https://web.dev/static/learn/html/card_480.png 480w,https://web.dev/static/learn/html/card_720.png 720w,https://web.dev/static/learn/html/card_856.png 856w,https://web.dev/static/learn/html/card_960.png 960w,https://web.dev/static/learn/html/card_1440.png 1440w,https://web.dev/static/learn/html/card_1920.png 1920w,https://web.dev/static/learn/html/card_2880.png 2880w" sizes="(max-width: 840px) 50vw, 464px" loading="lazy">
  </picture>
  
  </a>
  
</figure>
  
</div>


    
    <div class="devsite-landing-row-item-description">

      

      <div class="devsite-landing-row-item-body">
        
          <div class="devsite-landing-row-item-labels">
  

  
  <span class="devsite-label
             
             ">Course</span>

</div>
        

        
    <h3 id="learn-html" data-text="Learn HTML" class="hide-from-toc no-link">
      
  <a href="https://web.dev/learn/html">
    
        Learn HTML
      
  </a>
  
    </h3>
  

        
          <div class="devsite-landing-row-item-description-content">
            A solid overview of HTML for developers, from novice to expert level HTML.
          </div>
        

        

        
          <div class="devsite-landing-row-item-buttons">
  

  
  <a href="https://web.dev/learn/html" class="button
      ">Start course</a>

</div>
        
      </div>
    </div>
    
  

</div>
        
          <div class="devsite-landing-row-item" background="grey" description-position="bottom">

  
    
<div class="devsite-landing-row-item-media
            ">
  
    <figure class="devsite-landing-row-item-image">
  
  <a href="https://web.dev/learn/css">
    
  
  <picture>
    
    <img alt="" src="https://web.dev/static/learn/css/card.png" srcset="https://web.dev/static/learn/css/card_36.png 36w,https://web.dev/static/learn/css/card_48.png 48w,https://web.dev/static/learn/css/card_72.png 72w,https://web.dev/static/learn/css/card_96.png 96w,https://web.dev/static/learn/css/card_480.png 480w,https://web.dev/static/learn/css/card_720.png 720w,https://web.dev/static/learn/css/card_856.png 856w,https://web.dev/static/learn/css/card_960.png 960w,https://web.dev/static/learn/css/card_1440.png 1440w,https://web.dev/static/learn/css/card_1920.png 1920w,https://web.dev/static/learn/css/card_2880.png 2880w" sizes="(max-width: 840px) 50vw, 464px" loading="lazy">
  </picture>
  
  </a>
  
</figure>
  
</div>


    
    <div class="devsite-landing-row-item-description">

      

      <div class="devsite-landing-row-item-body">
        
          <div class="devsite-landing-row-item-labels">
  

  
  <span class="devsite-label
             
             ">Course</span>

</div>
        

        
    <h3 id="learn-css" data-text="Learn CSS" class="hide-from-toc no-link">
      
  <a href="https://web.dev/learn/css">
    
        Learn CSS
      
  </a>
  
    </h3>
  

        
          <div class="devsite-landing-row-item-description-content">
            A guide to CSS with modules covering everything from accessibility to z-index.
          </div>
        

        

        
          <div class="devsite-landing-row-item-buttons">
  

  
  <a href="https://web.dev/learn/css" class="button
      ">Start course</a>

</div>
        
      </div>
    </div>
    
  

</div>
        
          <div class="devsite-landing-row-item" background="grey" description-position="bottom">

  
    
<div class="devsite-landing-row-item-media
            ">
  
    <figure class="devsite-landing-row-item-image">
  
  <a href="https://web.dev/learn/javascript">
    
  
  <picture>
    
    <img alt="" src="https://web.dev/static/learn/javascript/card.png" srcset="https://web.dev/static/learn/javascript/card_36.png 36w,https://web.dev/static/learn/javascript/card_48.png 48w,https://web.dev/static/learn/javascript/card_72.png 72w,https://web.dev/static/learn/javascript/card_96.png 96w,https://web.dev/static/learn/javascript/card_480.png 480w,https://web.dev/static/learn/javascript/card_720.png 720w,https://web.dev/static/learn/javascript/card_856.png 856w,https://web.dev/static/learn/javascript/card_960.png 960w,https://web.dev/static/learn/javascript/card_1440.png 1440w,https://web.dev/static/learn/javascript/card_1920.png 1920w,https://web.dev/static/learn/javascript/card_2880.png 2880w" sizes="(max-width: 840px) 50vw, 464px" loading="lazy">
  </picture>
  
  </a>
  
</figure>
  
</div>


    
    <div class="devsite-landing-row-item-description">

      

      <div class="devsite-landing-row-item-body">
        
          <div class="devsite-landing-row-item-labels">
  

  
  <span class="devsite-label
             
             ">Course</span>

</div>
        

        
    <h3 id="learn-javascript" data-text="Learn JavaScript" class="hide-from-toc no-link">
      
  <a href="https://web.dev/learn/javascript">
    
        Learn JavaScript
      
  </a>
  
    </h3>
  

        
          <div class="devsite-landing-row-item-description-content">
            An in-depth course on the basics of JavaScript.
          </div>
        

        

        
          <div class="devsite-landing-row-item-buttons">
  

  
  <a href="https://web.dev/learn/javascript" class="button
      ">Start course</a>

</div>
        
      </div>
    </div>
    
  

</div>
        
        </div>
      

    
    </div>
  </section>
          </main>`}
        url={url}
        height="700px"
        onPlanReady={onPlanReady}
      />
    </>
  );
}
