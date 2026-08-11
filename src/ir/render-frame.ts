/**
 * render-frame.ts — shared off-screen iframe rendering.
 *
 * Several backends need a *rendered* document rather than a parsed one: they
 * depend on CSSOM-derived signals (`getBoundingClientRect`, `getComputedStyle`)
 * that a `DOMParser` document simply does not have. This module is the single
 * place that owns that capability.
 *
 * Consumers:
 *   • `ir/vips-visual.ts` — visual block extraction + separator detection.
 *   • `ir/web2vr.ts`      — CSS-box geometry extraction.
 *
 * ── Why this exists (and why the sandbox is configured the way it is) ────────
 *
 * Reading layout out of a frame requires same-origin access to its
 * `contentDocument`. A frame with `sandbox="allow-scripts"` but *without*
 * `allow-same-origin` gets an **opaque origin**: `contentDocument` is null from
 * the parent, and external stylesheets are fetched with an opaque origin too.
 * That combination silently yields "no styles, no readable layout" — which is
 * exactly the failure mode that made the DOM-only VIPS port necessary.
 *
 * So this module inverts the choice: **`allow-same-origin`, no `allow-scripts`.**
 *   • Parent can read `contentDocument` / `getComputedStyle`.        ✔ needed
 *   • External CSS loads and applies under normal CORS rules.        ✔ needed
 *   • No script from the fetched page ever executes.                 ✔ safe
 *
 * Not granting `allow-scripts` is what makes `allow-same-origin` acceptable
 * here: the two together are a documented sandbox escape (a scripted frame can
 * remove its own `sandbox` attribute), and we are rendering arbitrary remote
 * HTML. Scripts are also unnecessary — VIPS reasons about *visual layout*, which
 * is CSS. `<script>` elements are stripped before injection as defence in depth.
 *
 * ── Stylesheet loading ──────────────────────────────────────────────────────
 *
 * Even same-origin, a cross-origin `<link rel="stylesheet">` may be blocked. The
 * page HTML has already been fetched through the dev CORS proxy, so we reuse it:
 * external stylesheets are fetched via `proxyUrl()` and inlined as `<style>`
 * before injection. Relative `url(...)` references inside the CSS are rewritten
 * to absolute so backgrounds and `@font-face` files resolve.
 *
 * This is best-effort by design. `RenderFrameDiagnostics` reports how much CSS
 * actually landed, so callers can label their output honestly rather than
 * claiming a visual result they did not get.
 *
 * ── Why every timer here runs on the PARENT window ───────────────────────────
 *
 * Withholding `allow-scripts` disables the frame's scripting context entirely.
 * That does not merely stop the *page's* scripts: timers and animation-frame
 * callbacks scheduled on the frame's own `window` — even by us, from the parent —
 * never fire either. Waiting for layout via `frame.win.setTimeout` /
 * `frame.win.requestAnimationFrame` therefore blocks forever and every render
 * burns the full `timeoutMs` before falling back. All scheduling below runs on
 * the parent window, which is a normal scripted context; the frame still lays
 * out normally because layout is not scripting.
 */

import { proxyUrl } from "../proxy";

// ─────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────

export interface RenderFrameOptions {
  /** Absolute page URL — used for `<base href>` and to resolve stylesheets. */
  baseHref?: string | null;
  /** Virtual viewport width in CSS px. Default 1200. */
  width?: number;
  /** Virtual viewport height in CSS px. Default 900. */
  height?: number;
  /**
   * Fetch external stylesheets through the dev proxy and inline them.
   * Default true. Has no effect in the production build (no proxy).
   */
  inlineStylesheets?: boolean;
  /** Cap on external stylesheets fetched. Default 12. */
  maxStylesheets?: number;
  /** Quiet period after `load` before reading layout, ms. Default 120. */
  settleMs?: number;
  /**
   * How long to keep waiting for images/fonts *after* the document has parsed
   * and laid out, ms. Default 1500.
   *
   * Subresources refine the geometry (an unsized image is a zero-height box
   * until it arrives) but a single slow one must not hold the whole render
   * hostage — the page is already laid out and readable well before `load`.
   * Whichever comes first is reported as `settleReason`.
   */
  subresourceWaitMs?: number;
  /** Hard ceiling on the whole operation, ms. Default 8000. */
  timeoutMs?: number;
}

/** Why a render attempt produced what it produced. Callers surface this. */
export type RenderFrameStatus =
  | "rendered" // frame loaded, layout readable
  | "no-layout-engine" // Node/jsdom — no rendering available at all
  | "frame-inaccessible" // contentDocument unreadable (origin/sandbox)
  | "timeout"
  | "error";

/** What ended the wait for the frame to settle. */
export type SettleReason =
  | "load" // every subresource arrived
  | "subresource-deadline" // laid out and readable, still fetching images
  | "not-reached"; // never got that far (timeout / error)

export interface RenderFrameDiagnostics {
  status: RenderFrameStatus;
  /** Wall-clock time for the whole render, ms. */
  elapsedMs: number;
  /** Time from injection to a parsed, laid-out document, ms. */
  domReadyMs: number;
  /** Why waiting stopped — `load`, or the subresource soft deadline. */
  settleReason: SettleReason;
  /** `<link rel=stylesheet>` elements found in the source HTML. */
  stylesheetsFound: number;
  /** How many were successfully fetched and inlined. */
  stylesheetsInlined: number;
  /** `<style>` blocks already present inline in the source HTML. */
  inlineStyleBlocks: number;
  /**
   * CSS rules the frame actually applied (sum over readable style sheets).
   * Zero here with a non-zero `stylesheetsFound` means the visual signal is
   * degraded — the caller should say so rather than claim a visual result.
   */
  cssRulesApplied: number;
  /** Rendered content height in px — sanity signal that layout really ran. */
  documentHeightPx: number;
}

export interface RenderFrameResult<T> {
  /** `null` when the frame could not be rendered or the reader threw. */
  value: T | null;
  diagnostics: RenderFrameDiagnostics;
}

/** Everything a reader callback needs from the rendered frame. */
export interface RenderedFrame {
  doc: Document;
  win: Window;
  /** Body's bounding rect, for converting viewport coords to page coords. */
  bodyRect: DOMRect;
}

const DEFAULTS = {
  width: 1200,
  height: 900,
  inlineStylesheets: true,
  maxStylesheets: 12,
  settleMs: 120,
  subresourceWaitMs: 1_500,
  timeoutMs: 8_000,
};

/**
 * Stamped on the injected `<html>` so we can tell it apart from `about:blank`.
 *
 * Appending an iframe with no `src` loads `about:blank` and fires its own `load`
 * event. That event races the `srcdoc` assignment, so a bare `load` listener can
 * hand the reader an empty document — which looks exactly like "the algorithm
 * found nothing" and silently degrades to the fallback path.
 */
const FRAME_MARKER = "data-render-frame";

// ─────────────────────────────────────────────────────────────
// Capability probe
// ─────────────────────────────────────────────────────────────

let layoutProbeCache: boolean | null = null;

/**
 * True only in an environment that actually performs CSS layout.
 *
 * jsdom provides the full DOM API but no layout engine: every
 * `getBoundingClientRect()` returns all-zeros. Feature-detecting `document`
 * alone is therefore not enough — we lay out a real element and check that it
 * reports a non-zero box. Result is cached (the answer cannot change).
 */
export function hasLayoutEngine(): boolean {
  if (layoutProbeCache !== null) return layoutProbeCache;
  if (typeof document === "undefined" || typeof window === "undefined") {
    layoutProbeCache = false;
    return false;
  }
  try {
    const probe = document.createElement("div");
    probe.style.cssText =
      "position:absolute;top:-9999px;left:-9999px;width:37px;height:11px";
    document.body.appendChild(probe);
    const rect = probe.getBoundingClientRect();
    document.body.removeChild(probe);
    layoutProbeCache = rect.width > 0 && rect.height > 0;
  } catch {
    layoutProbeCache = false;
  }
  return layoutProbeCache;
}

// ─────────────────────────────────────────────────────────────
// Stylesheet inlining
// ─────────────────────────────────────────────────────────────

/** Resolve `href` against `base`; returns null if it cannot be made absolute. */
function absolutise(href: string, base: string | null): string | null {
  try {
    return base ? new URL(href, base).href : new URL(href).href;
  } catch {
    return null;
  }
}

/**
 * Rewrite relative `url(...)` references inside a stylesheet to absolute, using
 * the stylesheet's own URL as the base. Without this, an inlined stylesheet's
 * background images and `@font-face` sources resolve against *our* origin and
 * 404 — and missing web fonts change text metrics, which changes the block
 * geometry VIPS reads.
 */
function absolutiseCssUrls(css: string, sheetUrl: string): string {
  return css.replace(
    /url\(\s*(['"]?)([^'")]+)\1\s*\)/g,
    (whole, quote: string, ref: string) => {
      const trimmed = ref.trim();
      if (
        !trimmed ||
        trimmed.startsWith("data:") ||
        trimmed.startsWith("blob:") ||
        trimmed.startsWith("#") ||
        /^[a-z][a-z0-9+.-]*:/i.test(trimmed)
      ) {
        return whole;
      }
      const abs = absolutise(trimmed, sheetUrl);
      return abs ? `url(${quote}${abs}${quote})` : whole;
    },
  );
}

interface InlineResult {
  css: string[];
  found: number;
  inlined: number;
}

/**
 * Fetch every `<link rel="stylesheet">` through the dev proxy and return the
 * CSS text. Failures are swallowed per-sheet: a page that loses one of eight
 * stylesheets still renders far closer to reality than one with none, and the
 * shortfall is reported in the diagnostics.
 */
async function inlineExternalStylesheets(
  doc: Document,
  baseHref: string | null,
  max: number,
): Promise<InlineResult> {
  const links = Array.from(
    doc.querySelectorAll('link[rel~="stylesheet" i][href]'),
  );
  const found = links.length;
  if (found === 0) return { css: [], found: 0, inlined: 0 };

  const targets = links.slice(0, max);
  const fetched = await Promise.all(
    targets.map(async (link) => {
      const href = link.getAttribute("href");
      if (!href) return null;
      const abs = absolutise(href, baseHref);
      if (!abs) return null;
      try {
        const res = await fetch(proxyUrl(abs));
        if (!res.ok) return null;
        const text = await res.text();
        if (!text.trim()) return null;
        return absolutiseCssUrls(text, abs);
      } catch {
        return null;
      }
    }),
  );

  // Drop the originals so the frame does not re-request them cross-origin.
  for (const link of links) link.parentNode?.removeChild(link);

  const css = fetched.filter((c): c is string => c !== null);
  return { css, found, inlined: css.length };
}

// ─────────────────────────────────────────────────────────────
// HTML preparation
// ─────────────────────────────────────────────────────────────

interface PreparedHtml {
  html: string;
  stylesheetsFound: number;
  stylesheetsInlined: number;
  inlineStyleBlocks: number;
}

/**
 * Strip scripts, install `<base href>`, and inline external CSS.
 *
 * `<base>` matters more than it looks: without it every relative stylesheet,
 * image and font URL in the injected document resolves against our own origin.
 */
async function prepareHtml(
  rawHtml: string,
  opts: Required<Pick<RenderFrameOptions, "inlineStylesheets" | "maxStylesheets">> & {
    baseHref: string | null;
  },
): Promise<PreparedHtml> {
  const doc = new DOMParser().parseFromString(rawHtml, "text/html");

  // Defence in depth — the sandbox already withholds `allow-scripts`.
  doc
    .querySelectorAll("script, noscript")
    .forEach((el) => el.parentNode?.removeChild(el));

  doc.documentElement.setAttribute(FRAME_MARKER, "1");

  const inlineStyleBlocks = doc.querySelectorAll("style").length;

  const head = doc.head ?? doc.createElement("head");
  if (!doc.head) doc.documentElement.insertBefore(head, doc.body);

  if (opts.baseHref) {
    head.querySelectorAll("base").forEach((b) => b.parentNode?.removeChild(b));
    const base = doc.createElement("base");
    base.setAttribute("href", opts.baseHref);
    head.insertBefore(base, head.firstChild);
  }

  let stylesheetsFound = 0;
  let stylesheetsInlined = 0;
  if (opts.inlineStylesheets) {
    const result = await inlineExternalStylesheets(
      doc,
      opts.baseHref,
      opts.maxStylesheets,
    );
    stylesheetsFound = result.found;
    stylesheetsInlined = result.inlined;
    for (const css of result.css) {
      const style = doc.createElement("style");
      style.setAttribute("data-inlined", "1");
      style.textContent = css;
      head.appendChild(style);
    }
  }

  return {
    html: `<!DOCTYPE html>${doc.documentElement.outerHTML}`,
    stylesheetsFound,
    stylesheetsInlined,
    inlineStyleBlocks,
  };
}

// ─────────────────────────────────────────────────────────────
// Render
// ─────────────────────────────────────────────────────────────

/** Count CSS rules the frame actually applied, across readable style sheets. */
function countAppliedCssRules(doc: Document): number {
  let total = 0;
  for (const sheet of Array.from(doc.styleSheets)) {
    try {
      total += (sheet as CSSStyleSheet).cssRules.length;
    } catch {
      // Cross-origin sheet without CORS headers — readable by the renderer but
      // not by script. It still styles the page, so count it as present.
      total += 1;
    }
  }
  return total;
}

/** The frame's document, but only once it is the one we injected and parsed. */
function injectedDocument(iframe: HTMLIFrameElement): Document | null {
  let doc: Document | null;
  try {
    doc = iframe.contentDocument;
  } catch {
    return null; // opaque origin — not readable, and not ours
  }
  if (!doc?.documentElement?.hasAttribute(FRAME_MARKER)) return null;
  // "loading" means the parser is still running; past it there is a body with a
  // layout box.
  if (doc.readyState === "loading" || !doc.body) return null;
  return doc;
}

/**
 * Wait for the injected document to appear and finish parsing.
 *
 * Polled on parent animation frames rather than driven by the frame's `load`
 * event, because appending an iframe with no `src` loads `about:blank` and fires
 * a `load` of its own that races the `srcdoc` assignment. A bare `load` listener
 * can therefore hand the reader that empty document — indistinguishable from
 * "the algorithm found nothing", and silently degrading to the fallback path.
 */
async function waitForInjectedDocument(
  iframe: HTMLIFrameElement,
  deadlineMs: number,
): Promise<Document | null> {
  const until = Date.now() + deadlineMs;
  for (;;) {
    const doc = injectedDocument(iframe);
    if (doc) return doc;
    if (Date.now() >= until) return null;
    // Timer, not `requestAnimationFrame`. Laying out a full page in the frame
    // stalls the parent's frame production, and the compare panel runs while
    // the 3D scene is already driving its own rAF loop — so the one clock we
    // must not poll on is the one this work is starving. Measured on an
    // in-app run, an rAF poll turned a ~0.4 s render into ~7 s.
    await new Promise<void>((resolve) => window.setTimeout(resolve, 16));
  }
}

/**
 * Wait for the frame to be worth reading, then report why waiting stopped.
 *
 * Two things make this subtler than "await the load event".
 *
 * 1. **Every timer must run on the PARENT window.** See the module docblock: the
 *    frame has no scripting context (no `allow-scripts`), so `setTimeout` and
 *    `requestAnimationFrame` scheduled on *its* window never fire. Waiting on
 *    them would hang until `timeoutMs` and fall back to DOM-only on every render
 *    — the feature would look implemented and never actually run.
 *
 * 2. **`load` is later than "readable".** It waits for every image, and an
 *    unsized image is a zero-height box until it arrives, so the geometry does
 *    improve. But one slow subresource must not hold the whole render hostage
 *    when the page laid out long ago. So: wait for `load` if it comes promptly,
 *    otherwise proceed at the soft deadline and say so.
 *
 * `frameWin` is used only to reach the frame's `FontFaceSet` — also raced,
 * because it too belongs to an unscripted document and may never settle.
 *
 * There is deliberately no "wait two animation frames for layout to flush" step.
 * Reading `getBoundingClientRect()` forces a synchronous layout of the frame's
 * document, so the flush is guaranteed by the measurement itself — and waiting on
 * parent animation frames is actively harmful here, since the frame's own layout
 * work is what stalls them.
 */
function waitForSettle(
  iframe: HTMLIFrameElement,
  frameWin: Window,
  settleMs: number,
  subresourceWaitMs: number,
): Promise<SettleReason> {
  const loaded = new Promise<SettleReason>((resolve) => {
    if (frameWin.document.readyState === "complete") {
      resolve("load");
      return;
    }
    iframe.addEventListener("load", () => resolve("load"), { once: true });
  });

  const deadline = new Promise<SettleReason>((resolve) => {
    window.setTimeout(() => resolve("subresource-deadline"), subresourceWaitMs);
  });

  // Raced in parallel with the load wait, not after it — fonts and images are
  // in flight at the same time, so serialising the two waits doubles the worst
  // case for no benefit.
  const fonts = (frameWin.document as Document & { fonts?: FontFaceSet }).fonts;
  const fontsReady: Promise<void> = fonts?.ready
    ? Promise.race([
        fonts.ready.then(() => undefined),
        new Promise<void>((r) => window.setTimeout(r, subresourceWaitMs)),
      ]).catch(() => undefined)
    : Promise.resolve();

  return Promise.all([Promise.race([loaded, deadline]), fontsReady]).then(
    ([reason]) =>
      new Promise<SettleReason>((resolve) => {
        window.setTimeout(() => resolve(reason), settleMs);
      }),
  );
}

/**
 * Render `html` in an off-screen frame and hand the live document to `read`.
 *
 * The frame is always torn down, including when `read` throws. `read` must be
 * synchronous and must not retain references to nodes in the frame — they are
 * detached the moment this resolves.
 */
export async function renderInFrame<T>(
  html: string,
  options: RenderFrameOptions,
  read: (frame: RenderedFrame) => T,
): Promise<RenderFrameResult<T>> {
  const started = Date.now();
  const opts = { ...DEFAULTS, ...options, baseHref: options.baseHref ?? null };

  const fail = (
    status: RenderFrameStatus,
    partial?: Partial<RenderFrameDiagnostics>,
  ): RenderFrameResult<T> => ({
    value: null,
    diagnostics: {
      status,
      elapsedMs: Date.now() - started,
      domReadyMs: 0,
      settleReason: "not-reached",
      stylesheetsFound: 0,
      stylesheetsInlined: 0,
      inlineStyleBlocks: 0,
      cssRulesApplied: 0,
      documentHeightPx: 0,
      ...partial,
    },
  });

  if (!hasLayoutEngine()) return fail("no-layout-engine");

  let prepared: PreparedHtml;
  try {
    prepared = await prepareHtml(html, {
      baseHref: opts.baseHref,
      inlineStylesheets: opts.inlineStylesheets,
      maxStylesheets: opts.maxStylesheets,
    });
  } catch {
    return fail("error");
  }

  const sheetStats = {
    stylesheetsFound: prepared.stylesheetsFound,
    stylesheetsInlined: prepared.stylesheetsInlined,
    inlineStyleBlocks: prepared.inlineStyleBlocks,
  };

  return new Promise<RenderFrameResult<T>>((resolve) => {
    const iframe = document.createElement("iframe");
    iframe.setAttribute("aria-hidden", "true");
    iframe.setAttribute("tabindex", "-1");
    iframe.style.cssText = [
      "position:fixed",
      "top:0",
      `left:-${opts.width + 100}px`, // off-screen but laid out
      `width:${opts.width}px`,
      `height:${opts.height}px`,
      "border:0",
      "visibility:hidden",
      "pointer-events:none",
      "z-index:-9999",
    ].join(";");

    // allow-same-origin WITHOUT allow-scripts — see the module docblock. This is
    // the whole reason the frame's layout is readable at all.
    iframe.setAttribute("sandbox", "allow-same-origin");

    let settled = false;
    const cleanup = () => {
      try {
        iframe.remove();
      } catch {
        /* already detached */
      }
    };

    const finish = (result: RenderFrameResult<T>) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      cleanup();
      resolve(result);
    };

    const timer = window.setTimeout(
      () => finish(fail("timeout", sheetStats)),
      opts.timeoutMs,
    );

    const begin = () => {
      void (async () => {
        try {
          // Leave the hard ceiling room to settle and read in, so a slow parse
          // reports "frame-inaccessible" rather than burning the whole budget
          // and surfacing as an unexplained timeout.
          const doc = await waitForInjectedDocument(
            iframe,
            Math.max(500, opts.timeoutMs - opts.subresourceWaitMs - 500),
          );
          if (settled) return;
          const win = iframe.contentWindow;
          if (!doc || !win || !doc.body) {
            finish(fail("frame-inaccessible", sheetStats));
            return;
          }
          const domReadyMs = Date.now() - started;

          const settleReason = await waitForSettle(
            iframe,
            win,
            opts.settleMs,
            opts.subresourceWaitMs,
          );
          if (settled) return;

          const bodyRect = doc.body.getBoundingClientRect();

          // Measure the document BEFORE handing it to the reader. `read` is free
          // to mutate the frame — pruning boilerplate is the normal case — and a
          // rule count taken afterwards describes the reader's leftovers, not
          // what the browser applied. Read after, and a caller that prunes
          // `<style>` sees `cssRulesApplied: 0` and concludes the frame had no
          // CSS at all.
          const cssRulesApplied = countAppliedCssRules(doc);
          const documentHeightPx = Math.round(
            doc.documentElement.scrollHeight || bodyRect.height,
          );

          const value = read({ doc, win, bodyRect });

          finish({
            value,
            diagnostics: {
              status: "rendered",
              elapsedMs: Date.now() - started,
              domReadyMs,
              settleReason,
              ...sheetStats,
              cssRulesApplied,
              documentHeightPx,
            },
          });
        } catch {
          finish(fail("error", sheetStats));
        }
      })();
    };

    document.body.appendChild(iframe);
    iframe.srcdoc = prepared.html;
    begin();
  });
}
