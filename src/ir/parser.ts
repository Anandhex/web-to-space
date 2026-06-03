export type IRRole =
  | "main"
  | "navigation"
  | "banner"
  | "contentinfo"
  | "complementary"
  | "search"
  | "form"
  | "region"
  | "heading"
  | "paragraph"
  | "list"
  | "listitem"
  | "link"
  | "button"
  | "img"
  | "figure"
  | "blockquote"
  | "separator"
  | "code"
  | "table"
  | "row"
  | "cell"
  | "columnheader"
  | "rowheader"
  | "textbox"
  | "searchbox"
  | "checkbox"
  | "radio"
  | "combobox"
  | "slider"
  | "spinbutton"
  | "switch"
  | "tab"
  | "tablist"
  | "tabpanel"
  | "menu"
  | "menubar"
  | "menuitem"
  | "dialog"
  | "tree"
  | "treeitem"
  | "grid"
  | "progressbar"
  | "status"
  | "alert"
  | "tooltip"
  | "feed"
  | "group"
  | "caption"
  | "video"
  | "audio"
  | "application"
  | "article"
  | "document"
  | "note"
  | "log"
  | "marquee"
  | "timer"
  | "toolbar"
  | "option"
  | "menuitemcheckbox"
  | "menuitemradio"
  | "presentation"
  | "none"
  | "generic";

export type IRSource =
  | "explicit"
  | "structural"
  | "ai"
  | "ai-timeout"
  | "generic";

export interface IRNodeAttributes {
  expanded: string | null;
  checked: string | null;
  selected: string | null;
  disabled: string | null;
  pressed: string | null;
  current: string | null;
  hidden: string | null;
  busy: string | null;
  required: string | null;
  controls: string | null;
  describedby: string | null;
  labelledby: string | null;
  owns: string | null;
  details: string | null;
  errormessage: string | null;
  flowto: string | null;
  haspopup: string | null;
  alt: string | null;
  src: string | null;
  href: string | null;
  live: string | null;
  rowspan: string | null;
  colspan: string | null;
  listType: "ordered" | "unordered" | null;
  placeholder: string | null;
  title: string | null;
  valueNow: string | null;
  valueMin: string | null;
  valueMax: string | null;
  orientation: string | null;
  invalid: string | null;
  readonly: string | null;
  modal: string | null;
  multiselectable: string | null;
  captions: string[];
  componentType: string | null;
}

export interface IRNodeState {
  expanded: string | null;
  checked: string | null;
  selected: string | null;
  disabled: string | null;
  pressed: string | null;
  current: string | null;
  hidden: string | null;
  busy: string | null;
  required: string | null;
  live: string | null;
  invalid: string | null;
  readonly: string | null;
  modal: string | null;
  multiselectable: string | null;
  orientation: string | null;
  valueNow: string | null;
  valueMin: string | null;
  valueMax: string | null;
}

export interface IRNodeRelations {
  controls: IRNode[];
  labelledBy: IRNode[];
  describedBy: IRNode[];
  owns: IRNode[];
  details: IRNode[];
  errorMessage: IRNode[];
  flowTo: IRNode[];
  figureCaption: IRNode[];
}

export interface XRMetadata {
  /** Semantic importance score (0.0 – 1.0). Used by XR layout engine for placement priority. */
  importance: number;
  /** Estimated rendered width in CSS pixels (heuristic). */
  estimatedWidth: number;
  /** Estimated rendered height in CSS pixels (heuristic). */
  estimatedHeight: number;
  /** Composite spatial priority for XR panel placement (0.0 – 1.0). */
  spatialPriority: number;
  /** Depth in the reading order tree — used to decide panel vs floating control. */
  readingDepth: number;
}

export interface IRNode {
  id: string;
  role: IRRole;
  level: number | null;
  label: string | null;
  unlabelledYet: boolean;
  landmark: boolean;
  source: IRSource;
  confidence: number;
  readingIndex: number;
  parent: string | null;
  children: string[];
  relations: IRNodeRelations;
  state: IRNodeState;
  attributes: IRNodeAttributes;
  xr: XRMetadata;
}

export interface IRMeta {
  url: string;
  title: string | null;
  lang: string | null;
  parsedAt: string;
  config: ParserConfig;
}

export interface IRFallbackEntry {
  id: string;
  tag: string;
  reason: "ai-timeout";
}

export interface LandmarkTOCNode {
  id: string;
  label: string | null;
  children: LandmarkTOCNode[];
}

export interface IRAnalytics {
  headingCount: number;
  landmarkCount: number;
  controlCount: number;
  sectionCount: number;
  textDensity: number;
  wordCount: number;
  textLength: number;
  childCount: number;
  liveRegionCount: number;
}

export interface PageIR {
  meta: IRMeta;
  landmarks: LandmarkTOCNode;
  root: string;
  fallbackLog: IRFallbackEntry[];
  analytics: IRAnalytics;
  readingOrder: string[];
  nodes: Record<string, IRNode>;
}

const SKIP_TAGS = new Set([
  "script",
  "style",
  "noscript",
  "meta",
  "link",
  "head",
  "br",
  "wbr",
  "svg",
  "canvas",
  "template",
]);

const WRAPPER_TAGS = new Set(["div", "span", "picture"]);

const LANDMARK_ROLES = new Set([
  "main",
  "navigation",
  "banner",
  "contentinfo",
  "complementary",
  "search",
  "form",
  "region",
]);

const INTERACTIVE_ROLES = new Set([
  "button",
  "link",
  "textbox",
  "searchbox",
  "checkbox",
  "radio",
  "combobox",
  "slider",
  "spinbutton",
  "switch",
  "tab",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "treeitem",
  "option",
]);

// ---------------------------------------------------------------------------
// Layer 3: AI-assisted fallback — provider interface and stub
// ---------------------------------------------------------------------------

/** The structured response the AI provider must return for each node. */
export interface AIFallbackResponse {
  role: IRRole;
  confidence: number;
  reasoning: string;
}

/**
 * Provider interface. Swap the stub for a real implementation that calls
 * Ollama / llama.cpp / a cloud API without changing any other parser code.
 */
export interface AIFallbackProvider {
  classify(
    domSubtree: string,
    nodeId: string,
  ): Promise<AIFallbackResponse | null>;
}

/**
 * Stub provider — always returns null so the node stays "generic".
 * Replace with a real implementation for Layer 3 classification.
 */
export class StubAIProvider implements AIFallbackProvider {
  async classify(
    _domSubtree: string,
    _nodeId: string,
  ): Promise<AIFallbackResponse | null> {
    return null; // ai-fallback-value: no classification attempted
  }
}

// ---------------------------------------------------------------------------
// Parser configuration — feature flags for controlled evaluation
// ---------------------------------------------------------------------------

/**
 * Controls which pipeline layers are active during a parse.
 *
 * Flags are checked at the exact decision point in the code — not as
 * top-level gates — so each flag isolates exactly one capability and
 * combinations are independently composable.
 */
export interface ParserConfig {
  // ── Layer flags ───────────────────────────────────────────────────────────

  /**
   * Layer 1 — honour explicit `role=` attributes.
   * When false every element is resolved through structural tag mapping only.
   * Disabling simulates a site that uses semantic HTML tags but no ARIA roles.
   */
  useExplicitSemantics: boolean;

  /**
   * Layer 2a — resolve labels from `aria-label`, `aria-labelledby`,
   * `<label for>`, wrapping `<label>`, and `alt`.
   * When false label resolution falls back to text-content heuristics only.
   * Disabling simulates a site with no accessible naming whatsoever.
   */
  useAriaLabels: boolean;

  /**
   * Layer 2b — structural inference: heading-bounded implicit sections,
   * `<a>`-run → navigation, `<p>`-run → article group, repeated-subtree → list.
   * When false no grouping is inferred beyond explicit landmark elements.
   * Disabling simulates a completely flat, un-sectioned document.
   */
  useStructuralInference: boolean;

  /**
   * Layer 3 — AI-assisted fallback for nodes that remain `generic` after
   * layers 1 and 2.
   * When false generic nodes stay generic; nothing is sent to the provider.
   */
  useAIFallback: boolean;

  // ── Wrapper behaviour ─────────────────────────────────────────────────────

  /**
   * Pierce inert `div`/`span`/`picture` wrapper chains to reach the real
   * semantic child.  When false every wrapper element is emitted as its own
   * `generic` node, reproducing the raw "div soup" tree.
   *
   * Disabling this is the most direct simulation of what happens when a
   * site has no semantic structure and wrappers are not elided.
   */
  useWrapperPiercing: boolean;

  /**
   * Extra tags treated as potentially-inert wrappers in addition to the
   * fixed set (`div`, `span`, `picture`).  Each tag is only pierced when it
   * carries no ARIA attributes or `id`.
   *
   * Useful for testing whether `article` / `section` without ARIA should be
   * collapsed in the same way as anonymous divs.
   *
   * @example ["article", "section"]
   */
  extraWrapperTags: string[];

  // ── Run-detection thresholds ──────────────────────────────────────────────

  /**
   * Minimum consecutive identical siblings required to trigger the
   * repeated-subtree → inferred list heuristic.
   * Default 3.  Lower values produce more (possibly spurious) list nodes;
   * higher values suppress grouping on short runs.
   */
  minListRun: number;

  /**
   * Minimum consecutive `<a>` siblings required to trigger the
   * `<a>`-run → inferred navigation heuristic.
   * Default 3.
   */
  minLinkRun: number;

  /**
   * Minimum consecutive `<p>` siblings required to trigger the
   * `<p>`-run → inferred article-body group heuristic.
   * Default 3.
   */
  minParagraphRun: number;

  // ── Label behaviour ───────────────────────────────────────────────────────

  /**
   * Maximum characters kept from any resolved label string.
   * Longer labels are truncated at this boundary.
   * Default 280.
   */
  labelMaxChars: number;

  // ── SVG / Canvas inclusion ────────────────────────────────────────────────

  /**
   * When true `<svg>` elements are not skipped; the parser attempts to
   * extract a label from their `aria-label`, `aria-labelledby`, or `<title>`
   * child and emits them as `img` nodes.
   *
   * Useful for testing sites that place meaningful content inside SVG
   * (icon labels, inline charts).
   */
  includeSvg: boolean;

  /**
   * When true `<canvas>` elements are not skipped and are emitted as `img`
   * nodes (label sourced from `aria-label` or `aria-labelledby` only, since
   * canvas has no accessible text content by default).
   */
  includeCanvas: boolean;

  // ── Confidence scores ─────────────────────────────────────────────────────

  /**
   * Per-source confidence scores used when tagging IR nodes.
   * Override individual values to explore how confidence weighting affects
   * downstream spatial mapping decisions.
   */
  sourceConfidence: Record<IRSource, number>;

  /**
   * Confidence threshold below which a node is sent to the AI fallback.
   * Any node whose resolved confidence is strictly less than this value
   * triggers a provider call (when `useAIFallback` is also true).
   * Default 0.6.
   */
  aiFallbackThreshold: number;

  // ── Reading order strategy ────────────────────────────────────────────────

  /**
   * How the final `readingOrder` array is computed.
   *
   * - `"dom"` — nodes are ordered by DOM traversal sequence (default).
   *   Produces the most faithful left-to-right, top-to-bottom reading order.
   *
   * - `"landmark-first"` — all landmark nodes are sorted before their
   *   non-landmark children, preserving DOM order within each tier.
   *   Useful for spatial layouts that render the navigation shell before
   *   content panels.
   *
   * - `"flowto-aware"` — follows `aria-flowto` relationships via graph
   *   traversal. Nodes with an outgoing flowTo relation are visited in
   *   flowTo order; remaining nodes are appended in DOM order.
   */
  readingOrderStrategy: "dom" | "landmark-first" | "flowto-aware";

  excludeHiddenContent: boolean;
}

/** All layers enabled — the default production configuration. */
export const DEFAULT_CONFIG: ParserConfig = {
  useExplicitSemantics: true,
  useAriaLabels: true,
  useStructuralInference: true,
  useAIFallback: true,
  useWrapperPiercing: true,
  extraWrapperTags: [],
  minListRun: 3,
  minLinkRun: 3,
  minParagraphRun: 3,
  labelMaxChars: 280,
  includeSvg: false,
  includeCanvas: false,
  sourceConfidence: {
    explicit: 0.95,
    structural: 0.75,
    ai: 0.61,
    "ai-timeout": 0.4,
    generic: 0.55,
  },
  aiFallbackThreshold: 0.6,
  readingOrderStrategy: "dom",
  excludeHiddenContent: true,
};

/** Convenience presets for evaluation conditions. */
export const PARSER_CONFIGS = {
  /**
   * Absolute baseline — div/span soup with no ARIA, no inference, no
   * wrapper elision.  Represents the worst-case accessible HTML quality.
   */
  baseline: {
    ...DEFAULT_CONFIG,
    useExplicitSemantics: false,
    useAriaLabels: false,
    useStructuralInference: false,
    useAIFallback: false,
    useWrapperPiercing: false,
  },

  /**
   * Wrapper piercing only — elides inert div/span chains but applies no
   * ARIA or structural inference.  Isolates the contribution of wrapper
   * elision to IR quality.
   */
  withWrapperPiercing: {
    ...DEFAULT_CONFIG,
    useExplicitSemantics: false,
    useAriaLabels: false,
    useStructuralInference: false,
    useAIFallback: false,
    useWrapperPiercing: true,
  },

  /** Add explicit ARIA `role=` mapping over wrapper piercing. */
  withExplicitSemantics: {
    ...DEFAULT_CONFIG,
    useExplicitSemantics: true,
    useAriaLabels: false,
    useStructuralInference: false,
    useAIFallback: false,
    useWrapperPiercing: true,
  },

  /** Add ARIA label resolution over explicit semantics. */
  withAriaLabels: {
    ...DEFAULT_CONFIG,
    useExplicitSemantics: true,
    useAriaLabels: true,
    useStructuralInference: false,
    useAIFallback: false,
    useWrapperPiercing: true,
  },

  /** Add structural inference — full Layer 2, no AI. */
  withStructuralInference: {
    ...DEFAULT_CONFIG,
    useExplicitSemantics: true,
    useAriaLabels: true,
    useStructuralInference: true,
    useAIFallback: false,
    useWrapperPiercing: true,
  },

  /** Full pipeline including AI fallback. */
  full: DEFAULT_CONFIG,

  /** DOM reading order (same as full, explicit for comparison harness). */
  readingOrderDom: {
    ...DEFAULT_CONFIG,
    readingOrderStrategy: "dom" as const,
  },

  /** Landmark-first reading order — all landmarks before content nodes. */
  readingOrderLandmarkFirst: {
    ...DEFAULT_CONFIG,
    readingOrderStrategy: "landmark-first" as const,
  },

  /** Flow-to-aware reading order — follows aria-flowto edges via graph traversal. */
  readingOrderFlowtoAware: {
    ...DEFAULT_CONFIG,
    readingOrderStrategy: "flowto-aware" as const,
  },
} satisfies Record<string, ParserConfig>;

/** Serialise a DOM subtree to a compact string for the AI prompt. */
function serialiseDOMSubtree(
  element: Element,
  skipTags: Set<string>,
  maxDepth = 3,
): string {
  function walk(el: Element, depth: number): string {
    if (depth > maxDepth) return "";
    const tag = el.tagName.toLowerCase();
    const attrs = Array.from(el.attributes)
      .filter((a) => !["style", "class"].includes(a.name))
      .map((a) => ` ${a.name}="${a.value}"`)
      .join("");
    const children = Array.from(el.children)
      .filter((c) => !skipTags.has(c.tagName.toLowerCase()))
      .map((c) => walk(c, depth + 1))
      .join("");
    const directText = Array.from(el.childNodes)
      .filter((n) => n.nodeType === Node.TEXT_NODE)
      .map((n) => n.textContent?.trim() ?? "")
      .filter(Boolean)
      .join(" ");
    const inner = directText
      ? `${directText}${children ? " " + children : ""}`
      : children;
    return `<${tag}${attrs}>${inner}</${tag}>`;
  }
  return walk(element, 0);
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
  tablist: "tablist",
  tabpanel: "tabpanel",
  menu: "menu",
  menubar: "menubar",
  menuitem: "menuitem",
  grid: "grid",
  tree: "tree",
  treeitem: "treeitem",
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
  tab: "tab",
  group: "group",
  menuitemcheckbox: "menuitemcheckbox",
  menuitemradio: "menuitemradio",
  option: "option",
  application: "application",
  article: "article",
  document: "document",
  note: "note",
  log: "log",
  marquee: "marquee",
  timer: "timer",
  toolbar: "toolbar",
  presentation: "presentation",
  none: "none",
};

interface LandmarkRecord {
  id: string;
  label: string;
  parentId: string;
}

interface TreeCounters {
  node: number;
  section: number;
  reading: number;
}

interface BuildContext {
  nodes: Record<string, IRNode>;
  landmarkRecords: LandmarkRecord[];
  doc?: Document;
  counters: TreeCounters;
  elementToNodeId: WeakMap<Element, string>;
  nodeLookup: Map<string, IRNode>;
  fallbackProvider: AIFallbackProvider;
  fallbackLog: IRFallbackEntry[];
  config: ParserConfig;
  /** Effective skip-tag set derived from config (excludes svg/canvas when their include flags are on). */
  skipTags: Set<string>;
  /** Effective wrapper-tag set derived from config + extraWrapperTags. */
  wrapperTags: Set<string>;
}

function parseIdRefs(value: string | null): string[] {
  return value?.trim() ? value.trim().split(/\s+/) : [];
}

function createEmptyAttributes(): IRNodeAttributes {
  return {
    expanded: null,
    checked: null,
    selected: null,
    disabled: null,
    pressed: null,
    current: null,
    hidden: null,
    busy: null,
    required: null,
    controls: null,
    describedby: null,
    labelledby: null,
    owns: null,
    details: null,
    errormessage: null,
    flowto: null,
    haspopup: null,
    alt: null,
    src: null,
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
    orientation: null,
    invalid: null,
    readonly: null,
    modal: null,
    multiselectable: null,
    captions: [],
    componentType: null,
  };
}

function createEmptyState(): IRNodeState {
  return {
    expanded: null,
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
    modal: null,
    multiselectable: null,
    orientation: null,
    valueNow: null,
    valueMin: null,
    valueMax: null,
  };
}

function createEmptyRelations(): IRNodeRelations {
  return {
    controls: [],
    labelledBy: [],
    describedBy: [],
    owns: [],
    details: [],
    errorMessage: [],
    flowTo: [],
    figureCaption: [],
  };
}

/**
 * Assign `value` into `target[key]` only when `value` is defined
 * (not `undefined` or `null`) and the target slot is currently empty
 * (`null` or `undefined`). Centralises the repeated pattern used by
 * `pierceWrapperChain` and `mergeAttributes`.
 */
function assignIfDefined<T extends Record<string, any>>(
  target: T,
  key: keyof T,
  value: any,
): void {
  if (value !== undefined && value !== null && target[key] == null) {
    target[key] = value as any;
  }
}

function confidenceForSource(source: IRSource, config: ParserConfig): number {
  return config.sourceConfidence[source];
}

function isAccessibilityHidden(element: Element): boolean {
  const html = element as HTMLElement;
  return (
    element.getAttribute("aria-hidden") === "true" ||
    element.hasAttribute("hidden") ||
    element.hasAttribute("inert") ||
    html.style?.display === "none" ||
    html.style?.visibility === "hidden"
  );
}

function isExplicitSemantics(element: Element): boolean {
  return (
    element.hasAttribute("role") ||
    element.hasAttribute("aria-label") ||
    element.hasAttribute("aria-labelledby") ||
    element.hasAttribute("aria-describedby") ||
    element.hasAttribute("aria-controls") ||
    element.hasAttribute("aria-owns") ||
    element.hasAttribute("aria-details") ||
    element.hasAttribute("aria-errormessage") ||
    element.hasAttribute("aria-flowto") ||
    element.hasAttribute("aria-expanded") ||
    element.hasAttribute("aria-checked") ||
    element.hasAttribute("aria-selected") ||
    element.hasAttribute("aria-disabled") ||
    element.hasAttribute("aria-pressed") ||
    element.hasAttribute("aria-current") ||
    element.hasAttribute("aria-hidden") ||
    element.hasAttribute("aria-busy") ||
    element.hasAttribute("aria-required") ||
    element.hasAttribute("aria-haspopup")
  );
}

function readNodeState(element: Element): IRNodeState {
  return {
    expanded: element.getAttribute("aria-expanded") ?? null,
    checked: element.getAttribute("aria-checked") ?? null,
    selected: element.getAttribute("aria-selected") ?? null,
    disabled:
      element.getAttribute("aria-disabled") ??
      (element.hasAttribute("disabled") ? "true" : null),
    pressed: element.getAttribute("aria-pressed") ?? null,
    current: element.getAttribute("aria-current") ?? null,
    hidden:
      element.getAttribute("aria-hidden") ??
      (element.hasAttribute("hidden") ? "true" : null),
    busy: element.getAttribute("aria-busy") ?? null,
    required: element.getAttribute("aria-required") ?? null,
    live: element.getAttribute("aria-live") ?? null,
    invalid: element.getAttribute("aria-invalid") ?? null,
    readonly: element.getAttribute("aria-readonly") ?? null,
    modal: element.getAttribute("aria-modal") ?? null,
    multiselectable: element.getAttribute("aria-multiselectable") ?? null,
    orientation: element.getAttribute("aria-orientation") ?? null,
    valueNow: element.getAttribute("aria-valuenow") ?? null,
    valueMin: element.getAttribute("aria-valuemin") ?? null,
    valueMax: element.getAttribute("aria-valuemax") ?? null,
  };
}

function readNodeAttributes(element: Element): IRNodeAttributes {
  return {
    expanded: element.getAttribute("aria-expanded") ?? null,
    checked: element.getAttribute("aria-checked") ?? null,
    selected: element.getAttribute("aria-selected") ?? null,
    disabled:
      element.getAttribute("aria-disabled") ??
      (element.hasAttribute("disabled") ? "true" : null),
    pressed: element.getAttribute("aria-pressed") ?? null,
    current: element.getAttribute("aria-current") ?? null,
    hidden:
      element.getAttribute("aria-hidden") ??
      (element.hasAttribute("hidden") ? "true" : null),
    busy: element.getAttribute("aria-busy") ?? null,
    required: element.getAttribute("aria-required") ?? null,
    controls: element.getAttribute("aria-controls") ?? null,
    describedby: element.getAttribute("aria-describedby") ?? null,
    labelledby: element.getAttribute("aria-labelledby") ?? null,
    owns: element.getAttribute("aria-owns") ?? null,
    details: element.getAttribute("aria-details") ?? null,
    errormessage: element.getAttribute("aria-errormessage") ?? null,
    flowto: element.getAttribute("aria-flowto") ?? null,
    haspopup: element.getAttribute("aria-haspopup") ?? null,
    alt: element.getAttribute("alt") ?? null,
    src: element.getAttribute("src") ?? null,
    href: element.getAttribute("href") ?? null,
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
    orientation: element.getAttribute("aria-orientation") ?? null,
    invalid: element.getAttribute("aria-invalid") ?? null,
    readonly: element.getAttribute("aria-readonly") ?? null,
    modal: element.getAttribute("aria-modal") ?? null,
    multiselectable: element.getAttribute("aria-multiselectable") ?? null,
    captions: (() => {
      const tracks = Array.from(
        element.querySelectorAll("track[kind='captions']"),
      );
      return tracks.map((t) => t.getAttribute("src") ?? "").filter(Boolean);
    })(),
    componentType: null,
  };
}

function mergeAttributes(
  base: IRNodeAttributes,
  lifted: Partial<IRNodeAttributes>,
): IRNodeAttributes {
  const result = { ...base };
  for (const key of Object.keys(lifted) as (keyof IRNodeAttributes)[]) {
    assignIfDefined(result, key, lifted[key]);
  }
  return result;
}

function directTextContent(element: Element): string {
  let text = "";
  for (const node of Array.from(element.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE) text += node.textContent ?? "";
  }
  return text.trim();
}

function resolveNodeLabel(
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
        const labelEl = doc.querySelector(`label[for="${CSS.escape(id)}"]`);
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

    // FIX: Extract native HTML label for figures
    if (tag === "figure") {
      const figcaption = element
        .querySelector("figcaption")
        ?.textContent?.trim();
      if (figcaption) return cap(figcaption);
    }

    // SVG: extract label from <title> child when includeSvg is on
    if (tag === "svg" && config.includeSvg) {
      const title = element.querySelector("title")?.textContent?.trim();
      if (title) return cap(title);
    }
  }

  // Text-content fallback — always active regardless of config
  const hasElementChildren = Array.from(element.children).some(
    (child) => !SKIP_TAGS.has(child.tagName.toLowerCase()),
  );

  if (!hasElementChildren) {
    const text = element.textContent?.trim() ?? "";
    return text ? cap(text) : null;
  }

  const direct = directTextContent(element);
  return direct ? cap(direct) : null;
}

function resolveSectionLabel(
  fallbackLabel: string,
  config: ParserConfig,
  element?: Element,
  doc?: Document,
): string {
  const cap = (s: string) => s.slice(0, config.labelMaxChars);

  if (config.useAriaLabels && element && doc) {
    const labelledby = element.getAttribute("aria-labelledby")?.trim();
    if (labelledby) {
      const text = labelledby
        .split(/\s+/)
        .map((id) => doc.getElementById(id)?.textContent?.trim() ?? "")
        .filter(Boolean)
        .join(" ");
      if (text) return cap(text);
    }
    const ariaLabel = element.getAttribute("aria-label")?.trim();
    if (ariaLabel) return cap(ariaLabel);
  }
  // Heading fallback is structural — active regardless of useAriaLabels.
  // Only direct children are considered — headings nested inside sub-sections
  // belong to those sub-sections, not to this one.
  // A heading level is only used as a label when exactly one direct-child
  // heading at that level exists — multiple siblings (e.g. h2, h2, h2)
  // indicate repeated items rather than a section title, so that level is
  // skipped and the search continues at the next level down.
  if (element) {
    for (let level = 1; level <= 6; level++) {
      const tag = `h${level}`;
      const headings = Array.from(element.children).filter(
        (c) => c.tagName.toLowerCase() === tag,
      );
      if (headings.length === 1) {
        const text = headings[0].textContent?.trim();
        if (text) return cap(text);
      }
      // headings.length === 0 → no direct-child headings at this level, try next
      // headings.length > 1  → repeated, not a section title, try next
    }
  }
  return fallbackLabel;
}

function resolveRoleFromElement(
  element: Element,
  config: ParserConfig,
): {
  role: IRRole;
  level: number | null;
  source: Extract<IRSource, "explicit" | "structural">;
} {
  if (config.useExplicitSemantics) {
    const ariaRole = element.getAttribute("role")?.trim().toLowerCase();
    if (ariaRole) {
      const level =
        ariaRole === "heading"
          ? Number.parseInt(element.getAttribute("aria-level") ?? "2", 10) || 2
          : null;
      return {
        role: ARIA_ROLE_MAP[ariaRole] ?? "generic",
        level,
        source: "explicit",
      };
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
    tagResolved = {
      role: "button",
      level: null,
    };
  }

  return { ...tagResolved, source: "structural" };
}

function resolveRoleFromTag(
  tag: string,
  element?: Element,
): { role: IRRole; level: number | null } {
  if (tag === "main") return { role: "main", level: null };
  if (tag === "header") {
    // A header is only a banner if it is NOT scoped to a sectioning element
    if (element && element.closest("main, article, section, nav, aside")) {
      return { role: "generic", level: null };
    }
    return { role: "banner", level: null };
  }
  if (tag === "footer") {
    // A footer is only a contentinfo if it is NOT scoped to a sectioning element
    if (element && element.closest("main, article, section, nav, aside")) {
      return { role: "generic", level: null };
    }
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
  if (tag === "summary") return { role: "button", level: null };
  if (tag === "progress") return { role: "progressbar", level: null };
  if (tag === "meter") return { role: "progressbar", level: null };
  if (tag === "output") return { role: "status", level: null };

  if (tag === "button") return { role: "button", level: null };

  if (tag === "input") {
    const type = element?.getAttribute("type")?.toLowerCase() ?? "text";
    if (type === "checkbox") return { role: "checkbox", level: null };
    if (type === "radio") return { role: "radio", level: null };
    if (type === "range") return { role: "slider", level: null };
    if (type === "number") return { role: "spinbutton", level: null };
    if (type === "search") return { role: "searchbox", level: null };
    if (["button", "submit", "reset", "image"].includes(type)) {
      return { role: "button", level: null };
    }
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
  if (tag === "tr") return { role: "row", level: null };
  if (tag === "td") return { role: "cell", level: null };
  if (tag === "th") {
    const scope = element?.getAttribute("scope");
    return {
      role: scope === "row" ? "rowheader" : "columnheader",
      level: null,
    };
  }
  if (tag === "thead" || tag === "tbody" || tag === "tfoot") {
    return { role: "group", level: null };
  }
  if (tag === "fieldset") return { role: "group", level: null };

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

function isInertWrapper(element: Element, ctx: BuildContext): boolean {
  const tag = element.tagName.toLowerCase();
  if (!ctx.wrapperTags.has(tag)) return false;
  if (element.hasAttribute("role")) return false;
  if (element.hasAttribute("aria-label")) return false;
  if (element.hasAttribute("id")) return false;

  // FIX: Protect elements that developers have explicitly made focusable/interactive
  if (element.hasAttribute("tabindex")) return false;

  const ariaAttrs = [
    "aria-expanded",
    "aria-checked",
    "aria-selected",
    "aria-disabled",
    "aria-pressed",
    "aria-current",
    "aria-hidden",
    "aria-busy",
    "aria-required",
    "aria-controls",
    "aria-describedby",
    "aria-labelledby",
    "aria-owns",
    "aria-details",
    "aria-errormessage",
    "aria-flowto",
    "aria-haspopup",
  ];
  for (const attr of ariaAttrs) {
    if (element.hasAttribute(attr)) return false;
  }
  return true;
}

function pierceWrapperChain(
  element: Element,
  ctx: BuildContext,
): {
  element: Element;
  liftedAttrs: Partial<IRNodeAttributes>;
} {
  // When wrapper piercing is disabled return immediately
  if (!ctx.config.useWrapperPiercing) {
    return { element, liftedAttrs: {} };
  }

  const liftedAttrs: Partial<IRNodeAttributes> = {};
  let current = element;

  while (true) {
    const tag = current.tagName.toLowerCase();
    if (!ctx.wrapperTags.has(tag)) break;

    if (
      current.hasAttribute("role") ||
      current.hasAttribute("aria-label") ||
      current.hasAttribute("id")
    ) {
      break;
    }

    // Lift any ARIA attributes from this wrapper before piercing it
    const snap = readNodeAttributes(current);
    for (const key of Object.keys(snap) as (keyof IRNodeAttributes)[]) {
      assignIfDefined(liftedAttrs, key, snap[key]);
    }

    // FIX: Check if the element contains direct text nodes that would be lost
    const hasText = directTextContent(current).length > 0;

    const children = Array.from(current.children).filter(
      (child) => !ctx.skipTags.has(child.tagName.toLowerCase()),
    );

    // Stop piercing if there is text content OR if there isn't exactly one element child
    if (hasText || children.length !== 1) {
      return { element: current, liftedAttrs };
    }

    current = children[0];
  }

  return { element: current, liftedAttrs };
}

function childSignature(element: Element): string {
  return [
    element.tagName.toLowerCase(),
    element.getAttribute("role") ?? "",
    element.getAttribute("class") ?? "",
  ].join("|");
}

function isListCandidate(element: Element, config: ParserConfig): boolean {
  const role = resolveRoleFromElement(element, config).role;
  if (LANDMARK_ROLES.has(role)) return false;
  if (INTERACTIVE_ROLES.has(role)) return false;
  if (role === "heading") return false;
  const tag = element.tagName.toLowerCase();
  return tag !== "ul" && tag !== "ol" && tag !== "li";
}

function relationTargets(
  raw: string | null,
  doc: Document | undefined,
  elementToNodeId: WeakMap<Element, string>,
  nodeLookup: Map<string, IRNode>,
): IRNode[] {
  if (!doc) return [];
  const nodes: IRNode[] = [];
  for (const id of parseIdRefs(raw)) {
    const element = doc.getElementById(id);
    if (!element) continue;
    const nodeId = elementToNodeId.get(element);
    if (!nodeId) continue;
    const node = nodeLookup.get(nodeId);
    if (node) nodes.push(node);
  }
  return nodes;
}

function hydrateRelations(
  nodes: Record<string, IRNode>,
  doc: Document | undefined,
  elementToNodeId: WeakMap<Element, string>,
  nodeLookup: Map<string, IRNode>,
): void {
  nodeLookup.clear();
  for (const node of Object.values(nodes)) nodeLookup.set(node.id, node);

  for (const node of Object.values(nodes)) {
    node.relations = {
      controls: relationTargets(
        node.attributes.controls,
        doc,
        elementToNodeId,
        nodeLookup,
      ),
      labelledBy: relationTargets(
        node.attributes.labelledby,
        doc,
        elementToNodeId,
        nodeLookup,
      ),
      describedBy: relationTargets(
        node.attributes.describedby,
        doc,
        elementToNodeId,
        nodeLookup,
      ),
      owns: relationTargets(
        node.attributes.owns,
        doc,
        elementToNodeId,
        nodeLookup,
      ),
      details: relationTargets(
        node.attributes.details,
        doc,
        elementToNodeId,
        nodeLookup,
      ),
      errorMessage: relationTargets(
        node.attributes.errormessage,
        doc,
        elementToNodeId,
        nodeLookup,
      ),
      flowTo: relationTargets(
        node.attributes.flowto,
        doc,
        elementToNodeId,
        nodeLookup,
      ),
      figureCaption: relationTargets(
        node.attributes.flowto,
        doc,
        elementToNodeId,
        nodeLookup,
      ),
    };
  }

  // Populate figureCaption from children of figure nodes
  for (const node of Object.values(nodes)) {
    if (node.role === "figure") {
      node.relations.figureCaption = node.children
        .map((id) => nodes[id])
        .filter((n): n is IRNode => !!n && n.role === "caption");
    }
  }
}

const XR_IMPORTANCE: Partial<Record<IRRole, number>> = {
  heading: 1.0,
  button: 0.9,
  link: 0.85,
  textbox: 0.85,
  searchbox: 0.85,
  checkbox: 0.8,
  radio: 0.8,
  combobox: 0.8,
  slider: 0.8,
  dialog: 0.9,
  alert: 0.95,
  navigation: 0.8,
  main: 0.75,
  banner: 0.7,
  img: 0.6,
  figure: 0.6,
  list: 0.55,
  table: 0.6,
  paragraph: 0.5,
  group: 0.4,
  region: 0.4,
  generic: 0.2,
};

function computeXRMetadata(role: IRRole, readingDepth: number): XRMetadata {
  const importance = XR_IMPORTANCE[role] ?? 0.3;
  // Heuristic dimensions based on role — refined by layout engine at runtime
  const estimatedWidth =
    role === "heading"
      ? 600
      : role === "button" || role === "checkbox" || role === "radio"
        ? 200
        : role === "img" || role === "figure"
          ? 400
          : role === "table"
            ? 700
            : 500;
  const estimatedHeight =
    role === "heading"
      ? 60
      : role === "button"
        ? 44
        : role === "img" || role === "figure"
          ? 300
          : role === "table"
            ? 400
            : 80;
  // spatialPriority decays with depth so deeply nested nodes float further away
  const spatialPriority = importance * Math.max(0.1, 1 - readingDepth * 0.05);
  return {
    importance,
    estimatedWidth,
    estimatedHeight,
    spatialPriority,
    readingDepth,
  };
}

// ---------------------------------------------------------------------------
// Mixed-content normalisation
// ---------------------------------------------------------------------------

/**
 * Inline-level HTML tags. Text nodes and these elements together form prose
 * runs that should be grouped into a single paragraph-like node rather than
 * being split or silently dropped.
 */
const INLINE_TAGS = new Set([
  "a",
  "abbr",
  "acronym",
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
]);

/**
 * Normalise the direct children of `element` for parser consumption.
 *
 * The DOM distinguishes element nodes from text nodes, but `element.children`
 * only returns the former. This means mixed content like:
 *
 *   "Get up to speed with <a href="/baseline">Baseline</a>."
 *
 * loses the surrounding text entirely when we iterate `element.children`.
 *
 * This function walks `element.childNodes` and:
 * 1. Collects consecutive non-empty text nodes and inline elements into a
 *    "prose run".
 * 2. When a block-level element is encountered it flushes the current prose
 *    run (if any) as a synthetic `<span data-ir-prose>` element, then emits
 *    the block element directly.
 * 3. Any remaining prose run after the last block element is also flushed.
 *
 * The resulting array is a flat list of Elements that `buildChildrenFromSiblings`
 * can process as normal siblings — prose runs become `generic`/`paragraph`
 * nodes whose label resolves from their full text content, and block elements
 * are parsed as usual.
 *
 * If the element has no text nodes and no inline elements mixed with blocks
 * (i.e. pure block content) the output is identical to `Array.from(element.children)`.
 */
function normaliseChildContent(
  element: Element,
  skipTags: Set<string>,
): Element[] {
  if (element.hasAttribute("data-ir-prose")) {
    return Array.from(element.children).filter(
      (child) => !skipTags.has(child.tagName.toLowerCase()),
    );
  }

  const result: Element[] = [];
  let proseNodes: ChildNode[] = [];

  // FIX: Track if we actually need to split mixed content
  let hasBlockElements = false;

  const flushProse = (): void => {
    const hasContent = proseNodes.some((n) => {
      if (n.nodeType === Node.TEXT_NODE)
        return (n.textContent ?? "").trim().length > 0;
      return true;
    });

    if (!hasContent) {
      proseNodes = [];
      return;
    }

    const wrapper = element.ownerDocument!.createElement("span");
    wrapper.setAttribute("data-ir-prose", "true");
    for (const n of proseNodes) wrapper.appendChild(n.cloneNode(true));
    result.push(wrapper);
    proseNodes = [];
  };

  for (const node of Array.from(element.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE) {
      proseNodes.push(node);
      continue;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) continue;

    const el = node as Element;
    const tag = el.tagName.toLowerCase();

    if (skipTags.has(tag)) continue;

    if (INLINE_TAGS.has(tag)) {
      proseNodes.push(el);
    } else {
      hasBlockElements = true; // Block element found!
      flushProse();
      result.push(el);
    }
  }

  flushProse();

  // FIX: If there are no block elements, the parent itself is the prose container.
  // Do not emit synthetic wrappers. Just return the standard element children (e.g., inline <a> tags).
  if (!hasBlockElements) {
    return Array.from(element.children).filter(
      (child) => !skipTags.has(child.tagName.toLowerCase()),
    );
  }

  return result;
}

async function createNode(
  element: Element,
  parentId: string,
  landmarkParentId: string,
  ctx: BuildContext,
  liftedAttrs: Partial<IRNodeAttributes> = {},
  readingDepth = 0,
): Promise<string> {
  const id = `${parentId}-node-${ctx.counters.node++}`;
  const roleInfo = resolveRoleFromElement(element, ctx.config);
  const label = resolveNodeLabel(element, ctx.config, ctx.doc);
  const readingIndex = ctx.counters.reading++;

  ctx.elementToNodeId.set(element, id);

  // ── Layer 3: AI-assisted fallback ───────────────────────────────────────
  // Invoked when layers 1 & 2 left the node at "generic" confidence.
  let resolvedRole = roleInfo.role;
  let resolvedSource: IRSource = roleInfo.source;
  let resolvedConfidence = confidenceForSource(roleInfo.source, ctx.config);

  if (
    ctx.config.useAIFallback &&
    resolvedConfidence < ctx.config.aiFallbackThreshold
  ) {
    const subtree = serialiseDOMSubtree(element, ctx.skipTags);
    const tag = element.tagName.toLowerCase();
    try {
      const aiResult = await ctx.fallbackProvider.classify(subtree, id);
      if (
        aiResult !== null &&
        aiResult.confidence >= ctx.config.aiFallbackThreshold
      ) {
        resolvedRole = aiResult.role;
        resolvedSource = "ai";
        resolvedConfidence = aiResult.confidence;
      } else {
        // Provider returned null or low confidence — log as timeout/fallback
        ctx.fallbackLog.push({ id, tag, reason: "ai-timeout" });
        resolvedSource = "ai-timeout";
        resolvedConfidence = confidenceForSource("ai-timeout", ctx.config);
      }
    } catch {
      ctx.fallbackLog.push({ id, tag, reason: "ai-timeout" });
      resolvedSource = "ai-timeout";
      resolvedConfidence = confidenceForSource("ai-timeout", ctx.config);
    }
  }

  const isSemanticContainer =
    LANDMARK_ROLES.has(resolvedRole) ||
    resolvedRole === "region" ||
    resolvedRole === "article" ||
    resolvedRole === "list";

  const childDepth = isSemanticContainer ? readingDepth + 1 : readingDepth;

  const children = await buildChildrenFromSiblings(
    normaliseChildContent(element, ctx.skipTags),
    id,
    landmarkParentId,
    ctx,
    childDepth,
  );

  ctx.nodes[id] = {
    id,
    role: resolvedRole,
    level: roleInfo.level,
    label,
    unlabelledYet: label === null,
    landmark: LANDMARK_ROLES.has(resolvedRole),
    source: resolvedSource,
    confidence: resolvedConfidence,
    readingIndex,
    parent: parentId,
    children,
    relations: createEmptyRelations(),
    state: readNodeState(element),
    attributes: mergeAttributes(readNodeAttributes(element), liftedAttrs),
    xr: computeXRMetadata(resolvedRole, readingDepth),
  };

  return id;
}

async function buildChildrenFromSiblings(
  siblings: Element[],
  parentId: string,
  landmarkParentId: string,
  ctx: BuildContext,
  readingDepth = 0,
): Promise<string[]> {
  const childIds: string[] = [];

  for (let index = 0; index < siblings.length; ) {
    const rawChild = siblings[index];
    const peeled = isInertWrapper(rawChild, ctx)
      ? pierceWrapperChain(rawChild, ctx)
      : { element: rawChild, liftedAttrs: {} as Partial<IRNodeAttributes> };
    const child = peeled.element;

    if (ctx.config.excludeHiddenContent && isAccessibilityHidden(child)) {
      index += 1;
      continue;
    }

    const liftedAttrs = peeled.liftedAttrs;
    const tag = child.tagName.toLowerCase();

    if (ctx.skipTags.has(tag)) {
      index += 1;
      continue;
    }

    // ── SVG / canvas → img short-circuit ────────────────────────────────
    // Only reached when includeSvg / includeCanvas removed them from skipTags.
    if (tag === "svg" || tag === "canvas") {
      const id = `${parentId}-node-${ctx.counters.node++}`;
      const readingIndex = ctx.counters.reading++;
      const label = resolveNodeLabel(child, ctx.config, ctx.doc);
      ctx.elementToNodeId.set(child, id);
      ctx.nodes[id] = {
        id,
        role: "img",
        level: null,
        label,
        unlabelledYet: label === null,
        landmark: false,
        source: "structural",
        confidence: confidenceForSource("structural", ctx.config),
        readingIndex,
        parent: parentId,
        children: [],
        relations: createEmptyRelations(),
        state: createEmptyState(),
        attributes: mergeAttributes(readNodeAttributes(child), liftedAttrs),
        xr: computeXRMetadata("img", readingDepth),
      };
      childIds.push(id);
      index += 1;
      continue;
    }

    const roleInfo = resolveRoleFromElement(child, ctx.config);
    const isLandmark = tag === "section" || LANDMARK_ROLES.has(roleInfo.role);

    if (isLandmark) {
      const landmarkId = `${parentId}-section-${ctx.counters.section++}`;
      const readingIndex = ctx.counters.reading++;

      // Register before descending so aria-controls/labelledby can resolve to this landmark
      ctx.elementToNodeId.set(child, landmarkId);

      const nestedChildren = await buildChildrenFromSiblings(
        Array.from(child.children).filter(
          (candidate) => !ctx.skipTags.has(candidate.tagName.toLowerCase()),
        ),
        landmarkId,
        landmarkId,
        ctx,
        readingDepth + 1,
      );

      const label =
        resolveNodeLabel(child, ctx.config, ctx.doc) ??
        resolveSectionLabel(landmarkId, ctx.config, child, ctx.doc);
      ctx.landmarkRecords.push({
        id: landmarkId,
        label,
        parentId: landmarkParentId,
      });
      ctx.nodes[landmarkId] = {
        id: landmarkId,
        role: roleInfo.role,
        level: roleInfo.level,
        label,
        unlabelledYet: label === null,
        landmark: true,
        source: roleInfo.source,
        confidence: confidenceForSource(roleInfo.source, ctx.config),
        readingIndex,
        parent: parentId,
        children: nestedChildren,
        relations: createEmptyRelations(),
        state: readNodeState(child),
        attributes: mergeAttributes(readNodeAttributes(child), liftedAttrs),
        xr: computeXRMetadata(roleInfo.role, readingDepth),
      };

      childIds.push(landmarkId);
      index += 1;
      continue;
    }

    if (ctx.config.useStructuralInference && roleInfo.role === "heading") {
      const headingLevel = roleInfo.level ?? 0;
      let endIndex = index + 1;

      while (endIndex < siblings.length) {
        const lookaheadPeeled = isInertWrapper(siblings[endIndex], ctx)
          ? pierceWrapperChain(siblings[endIndex], ctx)
          : {
              element: siblings[endIndex],
              liftedAttrs: {} as Partial<IRNodeAttributes>,
            };
        const lookaheadRole = resolveRoleFromElement(
          lookaheadPeeled.element,
          ctx.config,
        );
        if (
          lookaheadRole.role === "heading" &&
          (lookaheadRole.level ?? 0) <= headingLevel
        ) {
          break;
        }
        endIndex += 1;
      }

      if (endIndex > index + 1) {
        const sectionId = `${parentId}-section-${ctx.counters.section++}`;
        const readingIndex = ctx.counters.reading++;
        const sectionNodePromises: Promise<string>[] = [];
        for (let childIndex = index; childIndex < endIndex; childIndex += 1) {
          const sectionPeeled = isInertWrapper(siblings[childIndex], ctx)
            ? pierceWrapperChain(siblings[childIndex], ctx)
            : {
                element: siblings[childIndex],
                liftedAttrs: {} as Partial<IRNodeAttributes>,
              };
          sectionNodePromises.push(
            createNode(
              sectionPeeled.element,
              sectionId,
              sectionId,
              ctx,
              sectionPeeled.liftedAttrs,
              readingDepth + 1,
            ),
          );
        }
        const sectionChildren = await Promise.all(sectionNodePromises);

        // For heading-inferred sections `child` is the heading element itself,
        // so its text content directly IS the section label.
        const label =
          resolveNodeLabel(child, ctx.config, ctx.doc) ??
          child.textContent?.trim() ??
          sectionId;
        ctx.landmarkRecords.push({
          id: sectionId,
          label,
          parentId: landmarkParentId,
        });
        ctx.nodes[sectionId] = {
          id: sectionId,
          role: "region",
          level: null,
          label,
          unlabelledYet: label === null,
          landmark: true,
          source: "structural",
          confidence: confidenceForSource("structural", ctx.config),
          readingIndex,
          parent: parentId,
          children: sectionChildren,
          relations: createEmptyRelations(),
          state: createEmptyState(),
          attributes: createEmptyAttributes(),
          xr: computeXRMetadata("region", readingDepth),
        };

        childIds.push(sectionId);
        index = endIndex;
        continue;
      }
    }

    const signature =
      ctx.config.useStructuralInference && isListCandidate(child, ctx.config)
        ? childSignature(child)
        : null;
    if (signature) {
      const run: Element[] = [];
      let scan = index;

      while (scan < siblings.length) {
        const candidatePeeled = isInertWrapper(siblings[scan], ctx)
          ? pierceWrapperChain(siblings[scan], ctx)
          : {
              element: siblings[scan],
              liftedAttrs: {} as Partial<IRNodeAttributes>,
            };
        if (!isListCandidate(candidatePeeled.element, ctx.config)) break;
        if (childSignature(candidatePeeled.element) !== signature) break;
        run.push(candidatePeeled.element);
        scan += 1;
      }

      if (run.length >= ctx.config.minListRun) {
        const listId = `${parentId}-list-${ctx.counters.section++}`;
        const readingIndex = ctx.counters.reading++;
        const listChildren = await Promise.all(
          run.map((item) =>
            createNode(
              item,
              listId,
              landmarkParentId,
              ctx,
              {},
              readingDepth + 1,
            ),
          ),
        );

        ctx.nodes[listId] = {
          id: listId,
          role: "list",
          level: null,
          label: null,
          unlabelledYet: true,
          landmark: false,
          source: "structural",
          confidence: confidenceForSource("structural", ctx.config),
          readingIndex,
          parent: parentId,
          children: listChildren,
          relations: createEmptyRelations(),
          state: createEmptyState(),
          attributes: {
            ...createEmptyAttributes(),
            listType: "unordered",
          },
          xr: computeXRMetadata("list", readingDepth),
        };

        childIds.push(listId);
        index = scan;
        continue;
      }
    }

    // ── Layer 2: <a>-run → inferred navigation landmark ──────────────────
    if (
      ctx.config.useStructuralInference &&
      child.tagName.toLowerCase() === "a"
    ) {
      const run: Element[] = [];
      let scan = index;
      while (scan < siblings.length) {
        const candidatePeeled = isInertWrapper(siblings[scan], ctx)
          ? pierceWrapperChain(siblings[scan], ctx)
          : {
              element: siblings[scan],
              liftedAttrs: {} as Partial<IRNodeAttributes>,
            };
        if (candidatePeeled.element.tagName.toLowerCase() !== "a") break;
        run.push(candidatePeeled.element);
        scan += 1;
      }
      if (run.length >= ctx.config.minLinkRun) {
        const navId = `${parentId}-nav-${ctx.counters.section++}`;
        const readingIndex = ctx.counters.reading++;
        const navChildren = await Promise.all(
          run.map((item) =>
            createNode(
              item,
              navId,
              landmarkParentId,
              ctx,
              {},
              readingDepth + 1,
            ),
          ),
        );
        const inferredLabel =
          resolveNodeLabel(child.parentElement!, ctx.config, ctx.doc) ??
          "Navigation";
        ctx.landmarkRecords.push({
          id: navId,
          label: inferredLabel,
          parentId: landmarkParentId,
        });
        ctx.nodes[navId] = {
          id: navId,
          role: "navigation",
          level: null,
          label: inferredLabel,
          unlabelledYet: false,
          landmark: true,
          source: "structural",
          confidence: confidenceForSource("structural", ctx.config),
          readingIndex,
          parent: parentId,
          children: navChildren,
          relations: createEmptyRelations(),
          state: createEmptyState(),
          attributes: createEmptyAttributes(),
          xr: computeXRMetadata("navigation", readingDepth),
        };
        childIds.push(navId);
        index = scan;
        continue;
      }
    }

    // ── Layer 2: <p>-run → inferred article-body group ───────────────────
    if (
      ctx.config.useStructuralInference &&
      child.tagName.toLowerCase() === "p"
    ) {
      const run: Element[] = [];
      let scan = index;
      while (scan < siblings.length) {
        const candidatePeeled = isInertWrapper(siblings[scan], ctx)
          ? pierceWrapperChain(siblings[scan], ctx)
          : {
              element: siblings[scan],
              liftedAttrs: {} as Partial<IRNodeAttributes>,
            };
        if (candidatePeeled.element.tagName.toLowerCase() !== "p") break;
        run.push(candidatePeeled.element);
        scan += 1;
      }
      if (run.length >= ctx.config.minParagraphRun) {
        const articleId = `${parentId}-article-${ctx.counters.section++}`;
        const readingIndex = ctx.counters.reading++;
        const articleChildren = await Promise.all(
          run.map((item) =>
            createNode(
              item,
              articleId,
              landmarkParentId,
              ctx,
              {},
              readingDepth + 1,
            ),
          ),
        );
        ctx.nodes[articleId] = {
          id: articleId,
          role: "article",
          level: null,
          label: null,
          unlabelledYet: true,
          landmark: false,
          source: "structural",
          confidence: confidenceForSource("structural", ctx.config),
          readingIndex,
          parent: parentId,
          children: articleChildren,
          relations: createEmptyRelations(),
          state: createEmptyState(),
          attributes: createEmptyAttributes(),
          xr: computeXRMetadata("article", readingDepth),
        };
        childIds.push(articleId);
        index = scan;
        continue;
      }
    }

    childIds.push(
      await createNode(
        child,
        parentId,
        landmarkParentId,
        ctx,
        liftedAttrs,
        readingDepth,
      ),
    );
    index += 1;
  }

  return childIds;
}

function buildLandmarkTree(
  rootLabel: string | null,
  records: LandmarkRecord[],
): LandmarkTOCNode {
  const childrenByParent = new Map<string, LandmarkRecord[]>();
  for (const record of records) {
    const bucket = childrenByParent.get(record.parentId);
    if (bucket) bucket.push(record);
    else childrenByParent.set(record.parentId, [record]);
  }

  const buildChildren = (parentId: string): LandmarkTOCNode[] =>
    (childrenByParent.get(parentId) ?? []).map((record) => ({
      id: record.id,
      label: record.label,
      children: buildChildren(record.id),
    }));

  return {
    id: "landmarks",
    label: rootLabel ?? "main",
    children: buildChildren("landmarks"),
  };
}

export function collectLandmarkIds(tree: LandmarkTOCNode): string[] {
  const ids: string[] = [];
  const walk = (node: LandmarkTOCNode): void => {
    ids.push(node.id);
    for (const child of node.children) walk(child);
  };
  walk(tree);
  return ids;
}

export const parsePageToIR = async (
  htmlString: string,
  url: string,
  fallbackProvider: AIFallbackProvider = new StubAIProvider(),
  config: ParserConfig = DEFAULT_CONFIG,
): Promise<PageIR> => {
  const parser = new DOMParser();
  const parsedDoc = parser.parseFromString(htmlString, "text/html");

  // Build effective skip/wrapper sets from config
  const skipTags = new Set(SKIP_TAGS);
  if (config.includeSvg) skipTags.delete("svg");
  if (config.includeCanvas) skipTags.delete("canvas");

  const wrapperTags = new Set([
    ...WRAPPER_TAGS,
    ...config.extraWrapperTags.map((t) => t.toLowerCase()),
  ]);

  const nodes: Record<string, IRNode> = {};
  const fallbackLog: IRFallbackEntry[] = [];
  const landmarkRecords: LandmarkRecord[] = [];
  // Reserve reading indices for the fixed structural nodes:
  // 0 = body, 1 = toc, 2 = main, 3 = section-0
  // Traversal-generated nodes start at 4.
  const READING_BODY = 0;
  const READING_TOC = 1;
  const READING_MAIN = 2;
  const READING_SECTION0 = 3;

  const ctx: BuildContext = {
    nodes,
    landmarkRecords,
    doc: parsedDoc,
    counters: { node: 0, section: 0, reading: 4 },
    elementToNodeId: new WeakMap<Element, string>(),
    nodeLookup: new Map<string, IRNode>(),
    fallbackProvider,
    fallbackLog,
    config,
    skipTags,
    wrapperTags,
  };

  // Register body so aria refs pointing at it can resolve
  ctx.elementToNodeId.set(parsedDoc.body, "section-0");

  const bodyChildren = Array.from(parsedDoc.body.children).filter(
    (child) => !skipTags.has(child.tagName.toLowerCase()),
  );

  const sectionChildIds = await buildChildrenFromSiblings(
    bodyChildren,
    "section-0",
    "section-0",
    ctx,
  );
  const parsedTitle = parsedDoc.title?.trim() || null;
  const sectionLabel = resolveSectionLabel(
    "section-0",
    config,
    parsedDoc.body,
    parsedDoc,
  );

  landmarkRecords.push({
    id: "section-0",
    label: sectionLabel,
    parentId: "main",
  });
  landmarkRecords.push({
    id: "toc",
    label: "Table of contents",
    parentId: "main",
  });
  landmarkRecords.push({
    id: "main",
    label: parsedTitle ?? "main",
    parentId: "landmarks",
  });

  nodes["section-0"] = {
    id: "section-0",
    role: "region",
    level: null,
    label: sectionLabel,
    unlabelledYet: false,
    landmark: true,
    source: "structural",
    confidence: confidenceForSource("structural", ctx.config),
    readingIndex: READING_SECTION0,
    parent: "main",
    children: sectionChildIds,
    relations: createEmptyRelations(),
    state: createEmptyState(),
    attributes: createEmptyAttributes(),
    xr: computeXRMetadata("region", 0),
  };

  nodes["toc"] = {
    id: "toc",
    role: "navigation",
    level: null,
    label: "Table of contents",
    unlabelledYet: false,
    landmark: true,
    source: "structural",
    confidence: confidenceForSource("structural", ctx.config),
    readingIndex: READING_TOC,
    parent: "main", // toc lives inside main, not at landmark root level
    children: [], // no generated link items — TOC is a structural shell
    relations: createEmptyRelations(),
    state: createEmptyState(),
    attributes: createEmptyAttributes(),
    xr: computeXRMetadata("navigation", 0),
  };

  nodes["main"] = {
    id: "main",
    role: "main",
    level: null,
    label: parsedTitle ?? "main",
    unlabelledYet: parsedTitle === null,
    landmark: true,
    source: "structural",
    confidence: confidenceForSource("structural", ctx.config),
    readingIndex: READING_MAIN,
    parent: "landmarks",
    children: ["toc", "section-0"],
    relations: createEmptyRelations(),
    state: createEmptyState(),
    attributes: createEmptyAttributes(),
    xr: computeXRMetadata("main", 0),
  };

  nodes["body"] = {
    id: "body",
    role: "generic",
    level: null,
    label: parsedTitle,
    unlabelledYet: parsedTitle === null,
    landmark: false,
    source: "structural",
    confidence: confidenceForSource("structural", ctx.config),
    readingIndex: READING_BODY,
    parent: null,
    children: ["main"],
    relations: createEmptyRelations(),
    state: createEmptyState(),
    attributes: createEmptyAttributes(),
    xr: computeXRMetadata("generic", 0),
  };

  hydrateRelations(nodes, parsedDoc, ctx.elementToNodeId, ctx.nodeLookup);

  const allNodes = Object.values(nodes);

  let orderedNodes: IRNode[];
  if (config.readingOrderStrategy === "landmark-first") {
    // Landmarks sorted before non-landmarks within each DOM-order tier.
    // Within each tier, DOM order (readingIndex) is preserved.
    const landmarks = allNodes
      .filter((n) => n.landmark)
      .sort((a, b) => a.readingIndex - b.readingIndex);
    const content = allNodes
      .filter((n) => !n.landmark)
      .sort((a, b) => a.readingIndex - b.readingIndex);
    orderedNodes = [...landmarks, ...content];
  } else if (config.readingOrderStrategy === "flowto-aware") {
    // Graph traversal following aria-flowto edges where present.
    // Nodes with no incoming flowTo edge (roots in the flowTo graph) are
    // visited in DOM order; flowTo successors are inserted immediately after.
    const domOrdered = [...allNodes].sort(
      (a, b) => a.readingIndex - b.readingIndex,
    );
    const visited = new Set<string>();
    const result: IRNode[] = [];

    const visit = (node: IRNode): void => {
      if (visited.has(node.id)) return;
      visited.add(node.id);
      result.push(node);
      for (const target of node.relations.flowTo) {
        visit(target);
      }
    };

    for (const node of domOrdered) {
      visit(node);
    }
    orderedNodes = result;
  } else {
    // "dom" — strict DOM traversal order
    orderedNodes = allNodes.sort((a, b) => a.readingIndex - b.readingIndex);
  }

  const readingOrder = orderedNodes.map((node) => node.id);

  const analytics: IRAnalytics = {
    headingCount: 0,
    landmarkCount: 0,
    controlCount: 0,
    sectionCount: 0,
    textDensity: 0,
    wordCount: 0,
    textLength: 0,
    childCount: 0,
    liveRegionCount: 0,
  };

  for (const node of orderedNodes) {
    if (node.role === "heading") analytics.headingCount += 1;
    if (node.landmark) analytics.landmarkCount += 1;
    if (INTERACTIVE_ROLES.has(node.role)) analytics.controlCount += 1;
    if (node.role === "region") analytics.sectionCount += 1;

    const text = node.label ?? "";
    analytics.textLength += text.length;
    analytics.wordCount += text ? text.split(/\s+/).filter(Boolean).length : 0;
    analytics.childCount += node.children.length;

    if (node.attributes.live) analytics.liveRegionCount += 1;
  }

  analytics.textDensity =
    orderedNodes.length > 0 ? analytics.textLength / orderedNodes.length : 0;

  const landmarks = buildLandmarkTree(parsedTitle, landmarkRecords);

  return {
    meta: {
      url,
      title: parsedTitle,
      lang: parsedDoc.documentElement.getAttribute("lang") || null,
      parsedAt: new Date().toISOString(),
      config,
    },
    landmarks,
    root: "body",
    fallbackLog,
    analytics,
    readingOrder,
    nodes,
  };
};
