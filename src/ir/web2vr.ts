/**
 * Web2VR layout extraction — port of the kikoano/web2vr approach.
 *
 * Renders the HTML in an off-screen frame, then reads every visible element's
 * position + styles via `getBoundingClientRect()` and `getComputedStyle()`. The
 * resulting data array is consumed by Web2VRScene.tsx, which maps DOM
 * coordinates to 3D world space.
 *
 * Scale invariant: SCALE = 600 (same as Web2VR default).
 * 1 CSS pixel = 1/600 world units.  A 1200×900 px viewport → 2.0×1.5 m.
 *
 * ── The frame is NOT set up here ────────────────────────────────────────────
 *
 * This module used to own its own iframe with `sandbox="allow-scripts"`, and
 * that one attribute made the whole backend a no-op: a frame with
 * `allow-scripts` but no `allow-same-origin` gets an **opaque origin**, so
 * `iframe.contentDocument` reads back as `null` from the parent. Extraction
 * therefore hit its own "no document" guard on every single run and resolved
 * `[]` — the scene only ever drew "No visible elements extracted."
 *
 * Frame setup now lives in `render-frame.ts`, which inverts that choice
 * (`allow-same-origin`, no `allow-scripts`), inlines external stylesheets
 * through the dev proxy, and avoids the `about:blank` load race. See that
 * module's docblock for why each of those is load-bearing. Everything below is
 * pure measurement over a frame someone else rendered.
 */

import { renderInFrame } from "./render-frame";
import type { RenderFrameDiagnostics, RenderedFrame } from "./render-frame";

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

interface HexAlpha {
  hex: string;
  alpha: number;
}

const MIN_ALPHA = 0.04;

function hex2(n: number): string {
  return Math.max(0, Math.min(255, Math.round(n)))
    .toString(16)
    .padStart(2, "0");
}

/** Fast path: the legacy `rgb()` / `rgba()` form, which is most of the corpus. */
function parseLegacyRgb(value: string): HexAlpha | null {
  const m = value.match(
    /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([\d.]+)\s*)?\)$/,
  );
  if (!m) return null;
  const alpha = m[4] === undefined ? 1 : parseFloat(m[4]);
  if (!(alpha >= MIN_ALPHA)) return null;
  return { hex: `#${hex2(+m[1])}${hex2(+m[2])}${hex2(+m[3])}`, alpha };
}

/**
 * Slow path: rasterise one pixel and read the bytes back.
 *
 * `getComputedStyle` does not promise legacy `rgb()` output. A stylesheet
 * authored in `oklch()`, `lab()` or `color(srgb …)` computes to *that same
 * syntax*, and those fall straight through an `rgba()` regex as "unparseable",
 * so the element silently loses its background — on a modern site that is most
 * of the page.
 *
 * Round-tripping through `ctx.fillStyle` is not enough either: the canvas
 * accepts a wide-gamut colour but hands it back in the syntax it was given
 * (`oklch(0.25 0.03 250)` in, the same string out), so the regex fails again.
 * Painting the colour and calling `getImageData` is what forces the browser to
 * actually resolve it to sRGB bytes — and it yields the alpha in the same read.
 */
let pixelCtx: CanvasRenderingContext2D | null | undefined;

function parseByRasterising(cssColor: string): HexAlpha | null {
  if (pixelCtx === undefined) {
    try {
      const canvas = document.createElement("canvas");
      canvas.width = 1;
      canvas.height = 1;
      pixelCtx = canvas.getContext("2d", { willReadFrequently: true });
    } catch {
      pixelCtx = null;
    }
  }
  if (!pixelCtx) return null;

  try {
    // A rejected `fillStyle` assignment leaves the previous value untouched, so
    // seed a sentinel and treat "unchanged" as a parse failure — otherwise an
    // invalid colour silently paints whatever the last element used.
    pixelCtx.fillStyle = "#000000";
    pixelCtx.fillStyle = cssColor;
    if (pixelCtx.fillStyle === "#000000") {
      pixelCtx.fillStyle = "#ffffff";
      pixelCtx.fillStyle = cssColor;
      if (pixelCtx.fillStyle === "#ffffff") return null; // rejected twice
      pixelCtx.fillStyle = cssColor;
    }

    pixelCtx.clearRect(0, 0, 1, 1);
    pixelCtx.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = pixelCtx.getImageData(0, 0, 1, 1).data;

    const alpha = a / 255;
    if (!(alpha >= MIN_ALPHA)) return null;
    return { hex: `#${hex2(r)}${hex2(g)}${hex2(b)}`, alpha };
  } catch {
    return null;
  }
}

/** Memoised — a page reuses the same handful of colours across many elements. */
const colorCache = new Map<string, HexAlpha | null>();

function cssToHexAlpha(cssColor: string): HexAlpha | null {
  if (!cssColor || cssColor === "transparent") return null;

  const cached = colorCache.get(cssColor);
  if (cached !== undefined) return cached;

  const parsed = parseLegacyRgb(cssColor) ?? parseByRasterising(cssColor);
  colorCache.set(cssColor, parsed);
  return parsed;
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

/** Virtual screen the extraction measures against, in CSS px. */
export const VIEWPORT_W = 1200;
export const VIEWPORT_H = 900;

/**
 * The colour the browser paints behind the whole document.
 *
 * Not the same thing as `<body>`'s background. Per CSS backgrounds §2.11 the
 * canvas takes its background from `<html>`, or from `<body>` when `<html>`'s
 * is transparent — and when neither sets one it is the browser's default
 * white, even though *both* elements compute to `rgba(0, 0, 0, 0)`.
 *
 * Reading only the computed values therefore yields "transparent" for the very
 * common case of a page that never styles its background, and the page ends up
 * drawn as its default black text over whatever the 3D scene's backdrop is —
 * i.e. invisible in a dark scene. A browser would have shown black on white.
 */
function canvasBackground(doc: Document, win: Window): string {
  for (const el of [doc.documentElement, doc.body]) {
    if (!el) continue;
    const parsed = cssToHexAlpha(win.getComputedStyle(el).backgroundColor);
    if (parsed && parsed.alpha >= 0.5) return parsed.hex;
  }
  return "#ffffff";
}

export interface Web2VRResult {
  elements: Web2VRElementData[];
  /** Colour behind the page — see `canvasBackground`. */
  background: string;
  /**
   * How the underlying render went. Surfaced by the scene so a frame that
   * never rendered reads as a failure rather than as an empty page — the two
   * were indistinguishable before, which is how the dead sandbox survived.
   */
  render: RenderFrameDiagnostics;
}

/**
 * Render `html` off-screen, then read `getBoundingClientRect()` +
 * `getComputedStyle()` for every visible element.
 *
 * This is the Web2VR approach: CSS layout → array of positioned element data.
 * `url` is the page's absolute address; it becomes the frame's `<base href>` so
 * relative stylesheets, fonts and images resolve against the real origin
 * instead of ours.
 */
export async function extractWeb2VRLayout(
  html: string,
  url?: string | null,
): Promise<Web2VRResult> {
  interface Extraction {
    elements: Web2VRElementData[];
    background: string;
  }

  const { value, diagnostics } = await renderInFrame(
    html,
    { baseHref: url ?? null, width: VIEWPORT_W, height: VIEWPORT_H },
    (frame: RenderedFrame): Extraction => {
      const elements: Web2VRElementData[] = [];
      traverseElement(frame.doc.body, 0, frame.win, elements, frame.bodyRect);
      return {
        elements,
        background: canvasBackground(frame.doc, frame.win),
      };
    },
  );

  return {
    elements: value?.elements ?? [],
    background: value?.background ?? "#ffffff",
    render: diagnostics,
  };
}
