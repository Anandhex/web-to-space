/**
 * Web2VR layout extraction — port of the kikoano/web2vr approach.
 *
 * Injects HTML into a hidden off-screen iframe, waits for layout, then
 * reads every visible element's position + styles via getBoundingClientRect()
 * and getComputedStyle().  The resulting data array is consumed by
 * Web2VRScene.tsx which maps DOM coordinates to 3D world space.
 *
 * Scale invariant: SCALE = 600 (same as Web2VR default).
 * 1 CSS pixel = 1/600 world units.  A 1200×900 px viewport → 2.0×1.5 m.
 *
 * Limitation: external CSS/fonts cannot load inside the sandboxed iframe
 * (opaque origin), so computed styles reflect inline/default styles only.
 */

export interface Web2VRElementData {
  id: string;
  domX: number;    // px, relative to iframe body top-left
  domY: number;
  domWidth: number;
  domHeight: number;
  depth: number;   // nesting level — maps to z-offset (Web2VR "layer")
  bgColor: string | null;    // "#rrggbb" or null if transparent
  bgAlpha: number;           // 0-1
  textColor: string;         // "#rrggbb"
  fontSize: number;          // px
  borderColor: string | null;
  borderWidth: number;       // px
  text: string;              // direct text content only (no descendant text)
  tag: string;               // lowercase tag name
  type: "image" | "video" | "input" | "block";
  src: string | null;        // img/video src
}

/** px → world-unit scale factor. 1 CSS px = 1/SCALE world units. */
export const SCALE = 600;

const MAX_ELEMENTS = 800;

const IGNORE_TAGS = new Set([
  "script", "style", "meta", "link", "head", "noscript",
  "template", "br", "wbr", "hr", "base", "title",
]);

function cssToHexAlpha(cssColor: string): { hex: string; alpha: number } | null {
  if (!cssColor || cssColor === "transparent") return null;

  const rgba = cssColor.match(
    /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([\d.]+))?\s*\)/,
  );
  if (rgba) {
    const alpha = rgba[4] !== undefined ? parseFloat(rgba[4]) : 1;
    if (alpha < 0.04) return null;
    const r = parseInt(rgba[1]).toString(16).padStart(2, "0");
    const g = parseInt(rgba[2]).toString(16).padStart(2, "0");
    const b = parseInt(rgba[3]).toString(16).padStart(2, "0");
    return { hex: `#${r}${g}${b}`, alpha };
  }

  // Named colour or hex literal — pass through, alpha = 1
  if (cssColor.startsWith("#") || /^[a-z]+$/i.test(cssColor)) {
    return { hex: cssColor, alpha: 1 };
  }

  return null;
}

function getDirectText(el: Element): string {
  const parts: string[] = [];
  for (const node of Array.from(el.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE) {
      const t = (node.textContent ?? "").trim();
      if (t) parts.push(t);
    }
  }
  return parts.join(" ").slice(0, 220);
}

function elementType(tag: string): Web2VRElementData["type"] {
  if (tag === "img" || tag === "picture") return "image";
  if (tag === "video") return "video";
  if (tag === "input" || tag === "textarea" || tag === "select") return "input";
  return "block";
}

function traverseElement(
  el: Element,
  depth: number,
  win: Window,
  results: Web2VRElementData[],
  bodyRect: DOMRect,
): void {
  if (results.length >= MAX_ELEMENTS) return;

  const tag = el.tagName.toLowerCase();
  if (IGNORE_TAGS.has(tag)) return;

  const style = win.getComputedStyle(el);
  if (style.display === "none" || style.visibility === "hidden") return;
  if (parseFloat(style.opacity) < 0.04) return;

  const rect = el.getBoundingClientRect();
  const w = rect.width;
  const h = rect.height;

  const domX = rect.left - bodyRect.left;
  const domY = rect.top - bodyRect.top;

  // Skip zero-area or elements entirely off the virtual viewport
  const visible = w >= 2 && h >= 2 && domX + w > 0 && domY + h > 0;

  if (visible) {
    const bgRaw = style.backgroundColor;
    const bg = cssToHexAlpha(bgRaw);

    const textRaw = style.color;
    const text = cssToHexAlpha(textRaw);

    const bwRaw = parseFloat(style.borderTopWidth) || 0;
    const border = bwRaw >= 1 ? cssToHexAlpha(style.borderTopColor) : null;

    const directText = getDirectText(el);
    const src = tag === "img" ? el.getAttribute("src") : null;

    const opacity = parseFloat(style.opacity) || 1;

    // Include element only if it contributes something visible
    if (bg || border || directText.length > 0 || src) {
      results.push({
        id: `w2v-${results.length}`,
        domX,
        domY,
        domWidth: w,
        domHeight: h,
        depth,
        bgColor: bg?.hex ?? null,
        bgAlpha: bg ? bg.alpha * opacity : 0,
        textColor: text?.hex ?? "#cccccc",
        fontSize: parseFloat(style.fontSize) || 16,
        borderColor: border?.hex ?? null,
        borderWidth: bwRaw,
        text: directText,
        tag,
        type: elementType(tag),
        src,
      });
    }
  }

  for (const child of Array.from(el.children)) {
    traverseElement(child as Element, depth + 1, win, results, bodyRect);
  }
}

/**
 * Inject HTML into a hidden off-screen iframe, wait for layout, then read
 * getBoundingClientRect() + getComputedStyle() for every visible element.
 *
 * This is the Web2VR approach: CSS layout → array of positioned element data.
 */
export function extractWeb2VRLayout(html: string): Promise<Web2VRElementData[]> {
  return new Promise((resolve) => {
    const iframe = document.createElement("iframe");
    iframe.style.cssText = [
      "position:fixed",
      "top:0",
      "left:-1300px", // off-screen but rendered
      "width:1200px",
      "height:900px",
      "visibility:hidden",
      "pointer-events:none",
      "z-index:-9999",
    ].join(";");

    // allow-scripts: inline JS can apply styles; without allow-same-origin
    // the iframe has an opaque origin so external resources won't load.
    iframe.setAttribute("sandbox", "allow-scripts");

    const cleanup = () => {
      try {
        document.body.removeChild(iframe);
      } catch {
        /* already removed */
      }
    };

    const timeout = setTimeout(() => {
      cleanup();
      resolve([]);
    }, 10_000);

    iframe.addEventListener(
      "load",
      () => {
        // 150 ms: enough for synchronous JS to apply inline styles
        setTimeout(() => {
          clearTimeout(timeout);

          const doc = iframe.contentDocument;
          const win = iframe.contentWindow;
          if (!doc || !win || !doc.body) {
            cleanup();
            resolve([]);
            return;
          }

          const bodyRect = doc.body.getBoundingClientRect();
          const results: Web2VRElementData[] = [];
          traverseElement(doc.body, 0, win, results, bodyRect);

          cleanup();
          resolve(results);
        }, 150);
      },
      { once: true },
    );

    document.body.appendChild(iframe);
    iframe.srcdoc = html;
  });
}
