import {
  SKIP_TAGS,
  LANDMARK_ROLES,
  INTERACTIVE_ROLES,
  MEDIA_LEAF_TAGS,
} from "./defaults";
import type {
  IRNodeState,
  IRNodeAttributes,
  IRRole,
  IRNodeRelations,
  IRSource,
  ParserConfig,
  IRNode,
  ParseContext,
  BuildContext,
} from "./types";

export function getValidChildren(
  element: Element,
  skipTags: Set<string>,
): Element[] {
  return Array.from(element.children).filter((c) => {
    const tag = c.tagName.toLowerCase();
    // Media leaves are skipped for DESCENT but kept as siblings — see
    // MEDIA_LEAF_TAGS. Filtering them here made them invisible to the media-leaf
    // branch that exists to turn them into `img` nodes.
    return !skipTags.has(tag) || MEDIA_LEAF_TAGS.has(tag);
  });
}

export function createBaseNode(
  id: string,
  role: IRRole,
  parentId: string | null,
  ctx: BuildContext,
  overrides: Partial<IRNode> = {},
): IRNode {
  const source = overrides.source || "structural";
  return {
    id,
    role,
    level: overrides.level ?? null,
    label: overrides.label ?? null,
    content: overrides.content ?? null,
    unlabelledYet: overrides.label === undefined || overrides.label === null,
    landmark: overrides.landmark ?? false,
    source,
    confidence: overrides.confidence ?? confidenceForSource(source, ctx.config),
    readingIndex: overrides.readingIndex ?? ctx.counters.reading++,
    readingDepth: overrides.readingDepth ?? 0,
    parent: parentId,
    children: overrides.children ?? [],
    // Provenance. Both default to "not from an element / not from a grouping";
    // the call sites that know better say so.
    sourceTag: overrides.sourceTag ?? null,
    grouping: overrides.grouping ?? null,
    relations: overrides.relations ?? createEmptyRelations(),
    state: overrides.state ?? createEmptyState(),
    attributes: overrides.attributes ?? createEmptyAttributes(),
    ...overrides,
  };
}

export function collectSiblingRun(
  siblings: Element[],
  startIndex: number,
  ctx: BuildContext,
  peelWrapper: (el: Element, ctx: BuildContext) => { element: Element },
  predicate: (el: Element) => boolean,
): { run: Element[]; endIndex: number } {
  const run: Element[] = [];
  let scan = startIndex;

  while (scan < siblings.length) {
    const candidate = peelWrapper(siblings[scan], ctx).element;
    if (!predicate(candidate)) break;
    run.push(candidate);
    scan += 1;
  }

  return { run, endIndex: scan };
}

export function readNodeState(element: Element): IRNodeState {
  // Native form controls express their state through DOM attributes/properties
  // (`checked`, `value`, `readonly`, …), not ARIA — mirror those into the same
  // state fields so a plain `<input type="checkbox" checked>` or
  // `<input type="range" value="70">` reflects its real state, not a blank one.
  const tag = element.tagName.toLowerCase();
  const type = (element.getAttribute("type") ?? "").toLowerCase();
  const isCheckable =
    tag === "input" && (type === "checkbox" || type === "radio");
  const isRangey =
    (tag === "input" && (type === "range" || type === "number")) ||
    tag === "progress" ||
    tag === "meter";

  return {
    checked:
      element.getAttribute("aria-checked") ??
      (isCheckable
        ? element.hasAttribute("checked")
          ? "true"
          : "false"
        : null),
    selected:
      element.getAttribute("aria-selected") ??
      (tag === "option" && element.hasAttribute("selected") ? "true" : null),
    disabled:
      element.getAttribute("aria-disabled") ??
      (element.hasAttribute("disabled") ? "true" : null),
    pressed: element.getAttribute("aria-pressed") ?? null,
    current: element.getAttribute("aria-current") ?? null,
    hidden:
      element.getAttribute("aria-hidden") ??
      (element.hasAttribute("hidden") ? "true" : null),
    busy: element.getAttribute("aria-busy") ?? null,
    required:
      element.getAttribute("aria-required") ??
      (element.hasAttribute("required") ? "true" : null),
    live: element.getAttribute("aria-live") ?? null,
    invalid: element.getAttribute("aria-invalid") ?? null,
    readonly:
      element.getAttribute("aria-readonly") ??
      (element.hasAttribute("readonly") ? "true" : null),
    valueNow:
      element.getAttribute("aria-valuenow") ??
      (isRangey ? element.getAttribute("value") : null),
    valueMin:
      element.getAttribute("aria-valuemin") ??
      (isRangey ? element.getAttribute("min") : null),
    valueMax:
      element.getAttribute("aria-valuemax") ??
      (isRangey ? element.getAttribute("max") : null),
  };
}

/**
 * Intrinsic pixel dimensions recovered from an image URL.
 *
 * Modern news sites and image CDNs almost never put `width`/`height` on the
 * `<img>` — on a Guardian front page 97 of 98 images carry no dimension
 * attributes at all. Without an aspect ratio resolveImageDisplaySize falls back
 * to (full column width x the profile's max image height), a ~4:1 letterbox
 * that a 5:4 press photo can only be stretched or cropped into.
 *
 * The size is still there, just in the URL — as explicit `width`/`height` (or
 * `w`/`h`) params, as an aspect `crop=5:4` / `ar=16:9`, or as the CDN's crop
 * rectangle path segment (`.../845_0_4240_3392/master/4240.jpg` = x_y_w_h).
 * Query params are the generic case and are tried first; the path rectangle is
 * a guarded last resort (four ints in one segment, immediately before a
 * `master`/`quality`-style segment) so it cannot fire on arbitrary paths.
 *
 * Only the ASPECT RATIO is trusted. A CDN's `width=465` is the size the page
 * asked the CDN to encode for that breakpoint, NOT the size the image is drawn
 * at — a "most viewed" thumbnail requested at width=120 is still rendered as a
 * full card. Taking those numbers literally shrank images to 12cm stamps. So
 * the ratio is normalised to a canonical height here, letting the layout's own
 * `metrics.image.height` cap decide the size exactly as it did before, with
 * only the width now corrected to the true aspect.
 *
 * Returns null when nothing usable is present — callers keep the old fallback.
 */
const CANONICAL_IMAGE_PX = 1000;
function intrinsicDimsFromUrl(
  src: string | null,
): { width: number; height: number } | null {
  if (!src) return null;
  let q: URLSearchParams;
  let pathname: string;
  try {
    const u = new URL(src, "https://x.invalid");
    q = u.searchParams;
    pathname = u.pathname;
  } catch {
    return null;
  }

  const num = (...keys: string[]): number | null => {
    for (const k of keys) {
      const raw = q.get(k);
      if (raw === null) continue;
      const n = parseInt(raw, 10);
      if (Number.isFinite(n) && n > 0) return n;
    }
    return null;
  };

  const fromAspect = (a: number) => ({
    width: Math.round(CANONICAL_IMAGE_PX * a),
    height: CANONICAL_IMAGE_PX,
  });

  const w = num("width", "w");
  const h = num("height", "h");
  if (w !== null && h !== null) return fromAspect(w / h);

  // Aspect params: "5:4", "16:9" (":" often arrives percent-encoded).
  let aspect: number | null = null;
  for (const k of ["crop", "ar", "aspect", "aspect_ratio"]) {
    const raw = q.get(k);
    const m = raw?.match(/^(\d{1,4})\s*[:x]\s*(\d{1,4})$/);
    if (m) {
      const a = parseInt(m[1], 10) / parseInt(m[2], 10);
      if (Number.isFinite(a) && a > 0) {
        aspect = a;
        break;
      }
    }
  }

  if (aspect === null) {
    // CDN crop rectangle: /<x>_<y>_<w>_<h>/master/… — use the w/h of the crop.
    const m = pathname.match(
      /\/(\d{1,5})_(\d{1,5})_(\d{2,5})_(\d{2,5})\/(?=[a-z]+\/)/,
    );
    if (m) {
      const cw = parseInt(m[3], 10);
      const ch = parseInt(m[4], 10);
      if (cw > 0 && ch > 0) aspect = cw / ch;
    }
  }

  return aspect === null ? null : fromAspect(aspect);
}

export function readNodeAttributes(
  element: Element,
  context?: ParseContext,
): IRNodeAttributes {
  const resolveUrl = (url: string | null) => {
    if (!url) return null;
    if (!context?.sourceUrl) return url;
    return new URL(url, context.sourceUrl).href;
  };

  // Fall back to dimensions encoded in the image URL when the markup omits
  // width/height (see intrinsicDimsFromUrl) — without an aspect ratio the
  // layout can only letterbox the image.
  // Computed unconditionally: an element can carry width/height attributes
  // that are present but unusable ("auto", "100%"), which readIntrinsicDim
  // rejects — gating on attribute PRESENCE would skip the fallback there.
  const urlDims = intrinsicDimsFromUrl(element.getAttribute("src"));

  const readIntrinsicDim = (
    attrName: string,
    dataAttrName: string,
  ): number | null => {
    const raw =
      element.getAttribute(attrName) ?? element.getAttribute(dataAttrName);
    if (!raw) return null;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  };

  return {
    checked: element.getAttribute("aria-checked") ?? null,
    selected: element.getAttribute("aria-selected") ?? null,
    disabled:
      element.getAttribute("aria-disabled") ??
      (element.hasAttribute("disabled") ? "true" : null),
    hidden:
      element.getAttribute("aria-hidden") ??
      (element.hasAttribute("hidden") ? "true" : null),
    required: element.getAttribute("aria-required") ?? null,
    describedby: element.getAttribute("aria-describedby") ?? null,
    labelledby: element.getAttribute("aria-labelledby") ?? null,
    haspopup: element.getAttribute("aria-haspopup") ?? null,
    alt: element.getAttribute("alt") ?? null,
    src: resolveUrl(element.getAttribute("src")),
    intrinsicWidth:
      readIntrinsicDim("width", "data-file-width") ?? urlDims?.width ?? null,
    intrinsicHeight:
      readIntrinsicDim("height", "data-file-height") ?? urlDims?.height ?? null,
    href: element.getAttribute("href"),
    live: element.getAttribute("aria-live") ?? null,
    rowspan: element.getAttribute("rowspan") ?? null,
    colspan: element.getAttribute("colspan") ?? null,
    listType:
      element.tagName.toLowerCase() === "ol"
        ? "ordered"
        : element.tagName.toLowerCase() === "ul"
          ? "unordered"
          : null,
    placeholder: element.getAttribute("placeholder") ?? null,
    title: element.getAttribute("title") ?? null,
    valueNow: element.getAttribute("aria-valuenow") ?? null,
    valueMin: element.getAttribute("aria-valuemin") ?? null,
    valueMax: element.getAttribute("aria-valuemax") ?? null,
    readonly: element.getAttribute("aria-readonly") ?? null,
    captions: (() => {
      const tracks = Array.from(
        element.querySelectorAll("track[kind='captions']"),
      );
      return tracks.map((t) => t.getAttribute("src") ?? "").filter(Boolean);
    })(),
    componentType: null,
    content: element.textContent?.trim() ?? null,
    styleTags: [],
    domId: element.getAttribute("id") ?? null,
  };
}

const ARIA_ROLE_MAP: Partial<Record<string, IRRole>> = {
  main: "main",
  navigation: "navigation",
  banner: "banner",
  contentinfo: "contentinfo",
  complementary: "complementary",
  search: "search",
  form: "form",
  region: "region",
  heading: "heading",
  dialog: "dialog",
  grid: "grid",
  progressbar: "progressbar",
  status: "status",
  alert: "alert",
  tooltip: "tooltip",
  feed: "feed",
  list: "list",
  listitem: "listitem",
  link: "link",
  button: "button",
  img: "img",
  figure: "figure",
  separator: "separator",
  table: "table",
  row: "row",
  cell: "cell",
  columnheader: "columnheader",
  rowheader: "rowheader",
  textbox: "textbox",
  searchbox: "searchbox",
  checkbox: "checkbox",
  radio: "radio",
  combobox: "combobox",
  slider: "slider",
  spinbutton: "spinbutton",
  switch: "switch",
  group: "group",
  option: "option",
  article: "article",
  document: "document",
  marquee: "marquee",
  timer: "timer",
  presentation: "presentation",
  none: "none",
};

function parseIdRefs(value: string | null): string[] {
  return value?.trim() ? value.trim().split(/\s+/) : [];
}

export function createEmptyAttributes(): IRNodeAttributes {
  return {
    checked: null,
    selected: null,
    disabled: null,
    hidden: null,
    required: null,
    describedby: null,
    labelledby: null,
    haspopup: null,
    alt: null,
    src: null,
    intrinsicWidth: null,
    intrinsicHeight: null,
    href: null,
    live: null,
    rowspan: null,
    colspan: null,
    listType: null,
    placeholder: null,
    title: null,
    valueNow: null,
    valueMin: null,
    valueMax: null,
    readonly: null,
    captions: [],
    componentType: null,
    content: null,
    styleTags: [],
    domId: null,
  };
}

export function createEmptyState(): IRNodeState {
  return {
    checked: null,
    selected: null,
    disabled: null,
    pressed: null,
    current: null,
    hidden: null,
    busy: null,
    required: null,
    live: null,
    invalid: null,
    readonly: null,
    valueNow: null,
    valueMin: null,
    valueMax: null,
  };
}

export function createEmptyRelations(): IRNodeRelations {
  return {
    labelledBy: [],
    describedBy: [],
    headers: [],
  };
}

export function assignIfDefined<T extends Record<string, any>>(
  target: T,
  key: keyof T,
  value: any,
): void {
  if (value !== undefined && value !== null && target[key] == null) {
    target[key] = value as any;
  }
}

export function confidenceForSource(
  source: IRSource,
  config: ParserConfig,
): number {
  return config.sourceConfidence[source];
}

/**
 * Escape a value for use inside a quoted attribute selector.
 *
 * `CSS.escape` is the obvious tool and is why this exists: `CSS` is a browser
 * global that the offline DOM shim does not provide, so `resolveNodeLabel`
 * threw `ReferenceError: CSS is not defined` on any `<input>`/`<select>`/
 * `<textarea>` that carried an id and sat outside pruned chrome. In a browser
 * the parse was fine; under Node — which is every benchmark, every evaluation
 * run and every check in this repository — it aborted the whole parse. The
 * corpus hid it only because its forms are all in page headers, which get
 * pruned before this is reached; the app-like stratum walks straight into it.
 *
 * Inside a quoted selector only the quote and the backslash need escaping, so
 * the full CSS.escape algorithm is not required here.
 */
function escapeAttr(value: string): string {
  return value.replace(/(["\\])/g, "\\$1");
}

export function isAccessibilityHidden(element: Element): boolean {
  const html = element as HTMLElement;
  return (
    element.getAttribute("aria-hidden") === "true" ||
    element.hasAttribute("hidden") ||
    element.hasAttribute("inert") ||
    html.style?.display === "none" ||
    html.style?.visibility === "hidden"
  );
}

export function mergeAttributes(
  base: IRNodeAttributes,
  lifted: Partial<IRNodeAttributes>,
): IRNodeAttributes {
  const result = { ...base };
  for (const key of Object.keys(lifted) as (keyof IRNodeAttributes)[]) {
    assignIfDefined(result, key, lifted[key]);
  }
  return result;
}

/**
 * Inline elements per HTML's default stylesheet. Everything else creates a
 * line box, so a browser renders a visible break at its boundary even when the
 * markup has no whitespace there.
 */
const INLINE_TEXT_TAGS = new Set([
  "a",
  "abbr",
  "b",
  "bdi",
  "bdo",
  "cite",
  "code",
  "data",
  "dfn",
  "em",
  "i",
  "kbd",
  "mark",
  "q",
  "rp",
  "rt",
  "ruby",
  "s",
  "samp",
  "small",
  "span",
  "strong",
  "sub",
  "sup",
  "time",
  "u",
  "var",
  "wbr",
  "font",
  "big",
  "tt",
  "nobr",
  "label",
  "output",
]);

/**
 * An element's text as a browser would RENDER it, not as `textContent`
 * concatenates it.
 *
 * `textContent` glues adjacent elements together with nothing between them, so
 * a news card's kicker — a block `<div>Review</div>` sitting above the headline
 * `<span>` with no whitespace in the source — comes out as "ReviewI Give You My
 * Silence…". A browser puts those on separate lines because the div is a block.
 *
 * This walks the subtree, collapsing whitespace the way inline flow does and
 * emitting a break at every block-level boundary and `<br>`. Use it anywhere a
 * string is destined for a reader (labels, headings, node content); raw
 * `textContent` is still correct for structural comparison, where only the
 * character sequence matters.
 */
export function renderedTextContent(element: Element): string {
  let out = "";
  const BREAK = "\u0000"; // placeholder; collapsed to a single space at the end

  const walk = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      out += (node.textContent ?? "").replace(/\s+/g, " ");
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as Element;
    const tag = el.tagName.toLowerCase();
    if (SKIP_TAGS.has(tag)) return;
    if (tag === "br") {
      out += BREAK;
      return;
    }
    const isBlock = !INLINE_TEXT_TAGS.has(tag);
    if (isBlock) out += BREAK;
    for (const child of Array.from(el.childNodes)) walk(child);
    if (isBlock) out += BREAK;
  };

  for (const child of Array.from(element.childNodes)) walk(child);

  // Block boundaries become a single space: these strings are drawn as one
  // wrapped run, and a real newline would be a HARD break in troika.
  return out
    .replace(/\u0000+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function directTextContent(element: Element): string {
  let text = "";
  for (const node of Array.from(element.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE) text += node.textContent ?? "";
  }
  return text.trim();
}

export function resolveNodeLabel(
  element: Element,
  config: ParserConfig,
  doc?: Document,
): string | null {
  const cap = (s: string) => s.slice(0, config.labelMaxChars) || null;

  if (config.useAriaLabels) {
    if (doc) {
      const labelledby = element.getAttribute("aria-labelledby")?.trim();
      if (labelledby) {
        const text = labelledby
          .split(/\s+/)
          .map((id) => doc.getElementById(id)?.textContent?.trim() ?? "")
          .filter(Boolean)
          .join(" ");
        if (text) return cap(text);
      }
    }

    const ariaLabel = element.getAttribute("aria-label")?.trim() ?? "";
    if (ariaLabel) return cap(ariaLabel);

    const tag = element.tagName.toLowerCase();
    if (tag === "img") {
      const alt = element.getAttribute("alt")?.trim() ?? "";
      if (alt) return cap(alt);
      const src = element.getAttribute("src")?.trim() ?? "";
      if (src) return cap(src.split("/").pop() ?? src);
    }

    if (doc && (tag === "input" || tag === "textarea" || tag === "select")) {
      const id = element.getAttribute("id");
      if (id) {
        const labelEl = doc.querySelector(`label[for="${escapeAttr(id)}"]`);
        const labelText = labelEl?.textContent?.trim();
        if (labelText) return cap(labelText);
      }
      const wrappingLabel = element.closest("label");
      if (wrappingLabel) {
        const clone = wrappingLabel.cloneNode(true) as Element;
        clone.querySelector("input,textarea,select")?.remove();
        const labelText = clone.textContent?.trim();
        if (labelText) return cap(labelText);
      }
    }
    if (tag === "fieldset") {
      const legend = element.querySelector("legend")?.textContent?.trim();
      if (legend) return cap(legend);
    }

    if (tag === "figure") {
      const figcaption = element
        .querySelector("figcaption")
        ?.textContent?.trim();
      if (figcaption) return cap(figcaption);
    }

    if (tag === "svg" && config.includeSvg) {
      const title = element.querySelector("title")?.textContent?.trim();
      if (title) return cap(title);
    }

    if (tag === "button" || tag === "summary" || tag === "a") {
      const text = renderedTextContent(element);
      if (text) return cap(text);
    }

    const titleAttr = element.getAttribute("title")?.trim();
    if (titleAttr) return cap(titleAttr);

    if (tag === "input" || tag === "textarea") {
      const placeholder = element.getAttribute("placeholder")?.trim();
      if (placeholder) return cap(placeholder);
    }
  }

  const hasElementChildren = Array.from(element.children).some(
    (child) => !SKIP_TAGS.has(child.tagName.toLowerCase()),
  );

  if (!hasElementChildren) {
    const text = renderedTextContent(element);
    return text ? cap(text) : null;
  }

  const direct = directTextContent(element);
  return direct ? cap(direct) : null;
}

const LANDMARK_SCOPE_SELECTOR =
  "main, article, section, nav, aside, " +
  '[role="main"], [role="article"], [role="region"], ' +
  '[role="navigation"], [role="complementary"]';

export function resolveRoleFromElement(
  element: Element,
  config: ParserConfig,
): {
  role: IRRole;
  level: number | null;
  source: Extract<IRSource, "explicit" | "structural" | "ai" | "ai-timeout">;
} {
  if (config.useExplicitSemantics) {
    const ariaRole = element.getAttribute("role")?.trim().toLowerCase();
    if (ariaRole) {
      const mapped = ARIA_ROLE_MAP[ariaRole] ?? "generic";
      const level =
        ariaRole === "heading"
          ? Number.parseInt(element.getAttribute("aria-level") ?? "2", 10) || 2
          : null;

      if (
        (mapped === "banner" || mapped === "contentinfo") &&
        element.closest(LANDMARK_SCOPE_SELECTOR)
      ) {
        return { role: "generic", level: null, source: "explicit" };
      }
      return { role: mapped, level, source: "explicit" };
    }
  }

  const tag = element.tagName.toLowerCase();
  let tagResolved = resolveRoleFromTag(tag, element);
  if (tagResolved.role === "generic" && element.hasAttribute("aria-live")) {
    const liveValue = element.getAttribute("aria-live")?.toLowerCase();
    tagResolved = {
      role: liveValue === "assertive" ? "alert" : "status",
      level: null,
    };
  }

  if (
    tagResolved.role === "generic" &&
    element.getAttribute("tabindex") === "0"
  ) {
    tagResolved = { role: "button", level: null };
  }

  return { ...tagResolved, source: "structural" };
}

function resolveRoleFromTag(
  tag: string,
  element?: Element,
): { role: IRRole; level: number | null } {
  if (tag === "main") return { role: "main", level: null };
  if (tag === "header") {
    if (!element || element.closest(LANDMARK_SCOPE_SELECTOR))
      return { role: "generic", level: null };
    return { role: "banner", level: null };
  }
  if (tag === "footer") {
    if (!element || element.closest(LANDMARK_SCOPE_SELECTOR))
      return { role: "generic", level: null };
    return { role: "contentinfo", level: null };
  }
  if (tag === "aside") return { role: "complementary", level: null };
  if (tag === "nav") return { role: "navigation", level: null };
  if (tag === "form") return { role: "form", level: null };
  if (tag === "section") return { role: "region", level: null };

  if (tag === "p") return { role: "paragraph", level: null };
  if (tag === "article") return { role: "article", level: null };
  if (tag === "img") return { role: "img", level: null };
  if (tag === "ul" || tag === "ol") return { role: "list", level: null };
  if (tag === "li") return { role: "listitem", level: null };
  if (tag === "a") return { role: "link", level: null };
  if (tag === "dialog") return { role: "dialog", level: null };
  if (tag === "details") return { role: "group", level: null };
  if (tag === "summary" || tag === "button")
    return { role: "button", level: null };
  if (tag === "progress" || tag === "meter")
    return { role: "progressbar", level: null };
  if (tag === "output") return { role: "status", level: null };

  if (tag === "input") {
    const type = element?.getAttribute("type")?.toLowerCase() ?? "text";
    if (type === "checkbox") return { role: "checkbox", level: null };
    if (type === "radio") return { role: "radio", level: null };
    if (type === "range") return { role: "slider", level: null };
    if (type === "number") return { role: "spinbutton", level: null };
    if (type === "search") return { role: "searchbox", level: null };
    if (["button", "submit", "reset", "image"].includes(type))
      return { role: "button", level: null };
    return { role: "textbox", level: null };
  }

  if (tag === "textarea") return { role: "textbox", level: null };
  if (tag === "select") return { role: "combobox", level: null };
  if (tag === "figure") return { role: "figure", level: null };
  if (tag === "figcaption") return { role: "caption", level: null };
  if (tag === "blockquote") return { role: "blockquote", level: null };
  if (tag === "code" || tag === "pre") return { role: "code", level: null };
  if (tag === "hr") return { role: "separator", level: null };

  if (tag === "table") return { role: "table", level: null };
  // A <caption> is the table's title. It resolved to `generic` because only
  // <figcaption> was listed above, which left every table caption as an
  // unclassified wrapper — 164 of them on the WAI-ARIA specification alone.
  if (tag === "caption") return { role: "caption", level: null };
  if (tag === "tr") return { role: "row", level: null };
  if (tag === "td") return { role: "cell", level: null };
  if (tag === "th") {
    const scope = element?.getAttribute("scope");
    return {
      role: scope === "row" ? "rowheader" : "columnheader",
      level: null,
    };
  }
  if (
    tag === "thead" ||
    tag === "tbody" ||
    tag === "tfoot" ||
    tag === "fieldset"
  ) {
    return { role: "group", level: null };
  }

  if (tag.length === 2 && tag[0] === "h") {
    const parsed = Number.parseInt(tag[1], 10);
    if (!Number.isNaN(parsed) && parsed >= 1 && parsed <= 6) {
      return { role: "heading", level: parsed };
    }
  }
  if (tag === "video") return { role: "video", level: null };
  if (tag === "audio") return { role: "audio", level: null };

  return { role: "generic", level: null };
}

export function isListCandidate(
  element: Element,
  config: ParserConfig,
): boolean {
  function unwrap(el: Element): Element {
    const tag = el.tagName.toLowerCase();
    if (
      (tag === "div" || tag === "span") &&
      !el.hasAttribute("role") &&
      !el.hasAttribute("aria-label") &&
      !el.hasAttribute("id")
    ) {
      const children = Array.from(el.children).filter(
        (c) => !SKIP_TAGS.has(c.tagName.toLowerCase()),
      );
      if (children.length === 1) return unwrap(children[0]);
    }
    return el;
  }

  const unwrapped = unwrap(element);
  const role = resolveRoleFromElement(unwrapped, config).role;

  if (
    LANDMARK_ROLES.has(role) ||
    INTERACTIVE_ROLES.has(role) ||
    role === "heading" ||
    // Table/grid cells (<td>/<th>) carry positional meaning — which row and
    // column they occupy — that mapTable/mapTableRowIndexed depends on to
    // reconstruct the grid. Nothing here rejected "cell"/"columnheader"/
    // "rowheader" before, so a row of structurally-similar cells (a common
    // shape: image + link + diagram per cell, repeated across a table like
    // Wikipedia's polytope comparison tables) got swept into a single
    // synthetic list child instead of staying N separate cells. mapTable then
    // saw a row with one "cell" where the header row still had N real ones,
    // mismatching columnCount and rendering the header row as an empty bar
    // with no visible text. Cells must never be candidates for this
    // structural list-run grouping, and nor must the rows that hold them.
    role === "cell" ||
    role === "columnheader" ||
    role === "rowheader" ||
    // ...and neither must ROWS, for the same reason and with worse
    // consequences. A `<tbody>` with three or more structurally similar `<tr>`
    // children is the ordinary shape of a data table, so this heuristic
    // collected them into a synthesised list and rewrote every row as a
    // `listitem` — the ARIA specification's role-characteristics tables lost
    // their row structure entirely, 769 of them. mapTable then has no rows to
    // reconstruct a grid from, so this was breaking the rendered table as well
    // as the score.
    role === "row"
  )
    return false;

  const hasContent =
    unwrapped.textContent?.trim() || unwrapped.children.length > 0;
  if (!hasContent) return false;

  const tag = unwrapped.tagName.toLowerCase();
  return tag !== "ul" && tag !== "ol" && tag !== "li";
}

function relationTargets(
  raw: string | null,
  doc: Document | undefined,
  elementToNodeId: WeakMap<Element, string>,
): string[] {
  if (!doc || !raw?.trim()) return [];
  const ids: string[] = [];
  for (const ref of parseIdRefs(raw)) {
    const element = doc.getElementById(ref);
    if (element) {
      const nodeId = elementToNodeId.get(element);
      if (nodeId) ids.push(nodeId);
    }
  }
  return ids;
}

export function hydrateRelations(
  nodes: Record<string, IRNode>,
  doc: Document | undefined,
  elementToNodeId: WeakMap<Element, string>,
): void {
  for (const node of Object.values(nodes)) {
    node.relations.labelledBy = relationTargets(
      node.attributes.labelledby,
      doc,
      elementToNodeId,
    );
    node.relations.describedBy = relationTargets(
      node.attributes.describedby,
      doc,
      elementToNodeId,
    );
  }

  if (doc) {
    for (const labelEl of Array.from(doc.querySelectorAll("label[for]"))) {
      const forId = labelEl.getAttribute("for");
      if (!forId) continue;
      const targetEl = doc.getElementById(forId);
      if (!targetEl) continue;
      const labelNodeId = elementToNodeId.get(labelEl);
      const targetNodeId = elementToNodeId.get(targetEl);
      if (!labelNodeId || !targetNodeId) continue;
      const targetNode = nodes[targetNodeId];
      if (
        targetNode &&
        !targetNode.relations.labelledBy.includes(labelNodeId)
      ) {
        targetNode.relations.labelledBy.push(labelNodeId);
      }
    }

    for (const tableEl of Array.from(doc.querySelectorAll("table"))) {
      for (const cellEl of Array.from(tableEl.querySelectorAll("td, th"))) {
        const headersAttr = cellEl.getAttribute("headers");
        if (!headersAttr?.trim()) continue;
        const cellNodeId = elementToNodeId.get(cellEl);
        if (!cellNodeId || !nodes[cellNodeId]) continue;
        const resolved = relationTargets(headersAttr, doc, elementToNodeId);
        for (const hId of resolved) {
          if (!nodes[cellNodeId].relations.headers.includes(hId)) {
            nodes[cellNodeId].relations.headers.push(hId);
          }
        }
      }

      const rows = Array.from(tableEl.querySelectorAll("tr"));
      const colHeaders: Map<number, string> = new Map();
      const rowHeadersByRow: Map<Element, string[]> = new Map();

      for (const rowEl of rows) {
        const cells = Array.from(rowEl.children).filter(
          (c) => c.tagName === "TD" || c.tagName === "TH",
        );
        const rowScopeIds: string[] = [];

        cells.forEach((cellEl, colIndex) => {
          if (cellEl.tagName !== "TH") return;
          const scope = cellEl.getAttribute("scope")?.toLowerCase();
          const nodeId = elementToNodeId.get(cellEl);
          if (!nodeId) return;

          const inThead = !!cellEl.closest("thead");
          if (scope === "col" || (!scope && inThead)) {
            colHeaders.set(colIndex, nodeId);
          } else if (scope === "row") {
            rowScopeIds.push(nodeId);
          }
        });

        if (rowScopeIds.length) rowHeadersByRow.set(rowEl, rowScopeIds);
      }

      for (const rowEl of rows) {
        const cells = Array.from(rowEl.children).filter(
          (c) => c.tagName === "TD" || c.tagName === "TH",
        );
        const rowScopeIds = rowHeadersByRow.get(rowEl) ?? [];

        cells.forEach((cellEl, colIndex) => {
          if (cellEl.getAttribute("headers")?.trim()) return;
          const cellNodeId = elementToNodeId.get(cellEl);
          if (!cellNodeId || !nodes[cellNodeId]) return;

          const toAdd: string[] = [];
          const colHeaderId = colHeaders.get(colIndex);
          if (colHeaderId && colHeaderId !== cellNodeId)
            toAdd.push(colHeaderId);
          for (const rId of rowScopeIds) {
            if (rId !== cellNodeId) toAdd.push(rId);
          }
          for (const hId of toAdd) {
            if (!nodes[cellNodeId].relations.headers.includes(hId)) {
              nodes[cellNodeId].relations.headers.push(hId);
            }
          }
        });
      }
    }
  }
}

export function getSemanticSignature(
  element: Element,
  ctx: BuildContext,
): string {
  function pierceWrappers(el: Element): Element[] {
    const result: Element[] = [];
    const tag = el.tagName.toLowerCase();

    if ((tag === "div" || tag === "span") && !el.hasAttribute("role")) {
      const children = getValidChildren(el, ctx.skipTags);
      if (children.length === 1) return pierceWrappers(children[0]);
      if (children.length > 1) {
        for (const child of children) result.push(...pierceWrappers(child));
        return result;
      }
    }
    return [el];
  }

  const elements = pierceWrappers(element);
  const roles: string[] = [];

  for (const el of elements) {
    const tag = el.tagName.toLowerCase();
    if (ctx.skipTags.has(tag)) continue;

    const roleInfo = resolveRoleFromElement(el, ctx.config);
    if (roleInfo.role !== "generic") {
      roles.push(roleInfo.role);
      if (roleInfo.level !== null) roles.push(`h${roleInfo.level}`);
    } else {
      roles.push(tag);
    }

    for (const child of Array.from(el.children)) {
      const childTag = child.tagName.toLowerCase();
      if (ctx.skipTags.has(childTag)) continue;
      const childRole = resolveRoleFromElement(child, ctx.config);
      if (childRole.role !== "generic") roles.push(childRole.role);
    }
  }

  return Array.from(new Set(roles)).sort().join("|");
}

/**
 * Does this element read as a paragraph of prose?
 *
 * The run heuristics decide between two groupings that treat their members very
 * differently: a paragraph-run keeps each member's own role and only wraps them,
 * while a list-run REPLACES each member's role with `listitem`. Dispatching that
 * choice on tag name alone meant `<p>` runs became article bodies and every
 * other run became a list — so a page that writes its paragraphs as
 * `<div class="p">` had its prose relabelled as list items, which is exactly the
 * page the structural layer exists to rescue. On the div-soup fixture that was
 * 12 of 14 disagreements with the annotator.
 *
 * The test is on shape rather than on tag, and deliberately conservative: prose
 * is long, punctuated into sentences, and mostly not a link. A list item can be
 * a full sentence too, so the threshold is set where a genuine list item is
 * unlikely to reach rather than where prose begins — misfiring toward `list` is
 * the status quo, and misfiring toward prose loses the grouping that makes a
 * card grid lay out as a grid.
 */
export function isProseBlock(el: Element, config: ParserConfig): boolean {
  // A block that contains its own structure is a container, whatever its text
  // looks like: grouping it as a paragraph would flatten the structure inside.
  for (const child of Array.from(el.children)) {
    const tag = child.tagName.toLowerCase();
    if (BLOCK_STRUCTURE_TAGS.has(tag)) return false;
    const role = resolveRoleFromElement(child, config).role;
    if (
      LANDMARK_ROLES.has(role) ||
      INTERACTIVE_ROLES.has(role) ||
      role === "heading" ||
      role === "list" ||
      role === "table"
    )
      return false;
  }

  const text = (el.textContent ?? "").replace(/\s+/g, " ").trim();
  if (text.length < PROSE_MIN_CHARS) return false;

  // Sentence structure. A caption or a nav label is long enough to pass a length
  // test on its own; ending a sentence is what separates prose from a phrase.
  if (!/[.!?][")\]]?$/.test(text) && !/[.!?]\s+[A-Z0-9"'(]/.test(text)) return false;

  // Mostly-link text is a navigation affordance that happens to be wordy.
  let linked = 0;
  for (const a of Array.from(el.querySelectorAll("a[href]"))) {
    linked += (a.textContent ?? "").replace(/\s+/g, " ").trim().length;
  }
  return linked / text.length < PROSE_MAX_LINK_DENSITY;
}

/** Shortest block that can count as prose rather than as a list item. */
const PROSE_MIN_CHARS = 120;

/** Above this share of linked text, a block is an affordance, not prose. */
const PROSE_MAX_LINK_DENSITY = 0.3;

/** Tags whose presence means the block is a container, not a paragraph. */
const BLOCK_STRUCTURE_TAGS = new Set([
  "ul", "ol", "dl", "li", "table", "thead", "tbody", "tr", "td", "th",
  "h1", "h2", "h3", "h4", "h5", "h6", "figure", "form", "nav", "section",
  "article", "aside", "header", "footer", "pre", "blockquote",
]);

export function areStructurallySimilar(
  el1: Element,
  el2: Element,
  ctx: BuildContext,
): boolean {
  if (getSemanticSignature(el1, ctx) !== getSemanticSignature(el2, ctx))
    return false;

  function getContentDepth(el: Element): number {
    let depth = 0;
    let current = el;
    while (current.children.length === 1) {
      const tag = current.children[0].tagName.toLowerCase();
      if (tag === "div" || tag === "span") {
        depth++;
        current = current.children[0];
      } else break;
    }
    return depth;
  }

  return Math.abs(getContentDepth(el1) - getContentDepth(el2)) <= 1;
}

/** An element's text, whitespace-collapsed, for structural comparison. */
function comparableText(el: Element): string {
  return (el.textContent ?? "").replace(/\s+/g, " ").trim();
}

/**
 * The nearest enclosing "one piece of content" boundary. Duplicate detection is
 * scoped to it so that a headline legitimately appearing in two different parts
 * of a page (a feed and a "most viewed" rail) is never mistaken for a
 * responsive duplicate.
 */
const DUPLICATE_SCOPE = "li, article, section, [data-link-name]";

/**
 * Drop breakpoint duplicates.
 *
 * Responsive sites routinely emit the same content once per breakpoint and hide
 * all but one copy with a media query — the Guardian ships every card's
 * `<ul class="sublinks">` twice, in two differently-classed wrappers. A browser
 * shows one; we have no CSSOM, so both reach the IR. The cost is not only the
 * visible double: each duplicate doubles its card's estimated height, which is
 * what pushes a card past the page box and inflates the page count.
 *
 * Rule: within one content boundary, if two subtrees carry identical text and
 * neither contains the other, the later one is a duplicate. The length floor
 * keeps short repeats that are genuinely meant to appear twice ("Read more",
 * a byline echoed in a caption) out of scope.
 */
export function pruneResponsiveDuplicates(doc: Document): void {
  const MIN_TEXT_LEN = 30;
  const seen = new Map<string, Element>();

  for (const el of Array.from(doc.body?.querySelectorAll("*") ?? [])) {
    // Removing a subtree disconnects its descendants; they are still in this
    // snapshot, so skip anything already detached.
    if (!el.isConnected) continue;

    const text = comparableText(el);
    if (text.length < MIN_TEXT_LEN) continue;

    const first = seen.get(text);
    if (!first || !first.isConnected) {
      seen.set(text, el);
      continue;
    }
    // A wrapper always repeats its own child's text — never a duplicate.
    if (first.contains(el) || el.contains(first)) continue;

    const scope = el.closest(DUPLICATE_SCOPE);
    if (!scope || scope !== first.closest(DUPLICATE_SCOPE)) continue;

    el.parentNode?.removeChild(el);
  }
}
