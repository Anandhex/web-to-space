import type { XRInlineRun } from "../mapper/types";

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
  autoplay: string | null;
  content: string | null;
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

/**
 * ARIA relationship fields stored as node ID arrays.
 * Using string IDs rather than direct object references prevents graph cycles
 * that break JSON serialisation, snapshot testing, and diffing.
 * Consumers resolve IDs via `PageIR.nodes`.
 */
export interface IRNodeRelations {
  controls: string[];
  labelledBy: string[];
  describedBy: string[];
  owns: string[];
  details: string[];
  errorMessage: string[];
  flowTo: string[];
  /** IDs of caption nodes that are direct children of a figure node. */
  figureCaption: string[];
  /** IDs of header cells (th) associated with this cell via headers= or scope=. */
  headers: string[];
}

export interface IRNode {
  id: string;
  role: IRRole;
  level: number | null;
  label: string | null;
  content: string | null;
  unlabelledYet: boolean;
  landmark: boolean;
  source: IRSource;
  confidence: number;
  readingIndex: number;
  /**
   * Depth of this node in the semantic containment tree.
   * 0 = top-level landmarks (main, nav, aside).
   * Increases by 1 for each nested semantic container (region, article, list).
   * Used by the spatial mapping engine to decide panel vs. floating control placement.
   * This is a semantic property — the mapping engine converts it to physical depth offset.
   */
  readingDepth: number;
  parent: string | null;
  children: string[];
  relations: IRNodeRelations;
  state: IRNodeState;
  attributes: IRNodeAttributes;
  inlineRuns?: XRInlineRun[]; // for text-bearing nodes, the decomposed inline content with metadata
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

export interface LandmarkRecord {
  id: string;
  label: string;
  parentId: string;
}

export interface TreeCounters {
  node: number;
  section: number;
  reading: number;
}

export interface BuildContext {
  nodes: Record<string, IRNode>;
  landmarkRecords: LandmarkRecord[];
  doc?: Document;
  counters: TreeCounters;
  elementToNodeId: WeakMap<Element, string>;
  fallbackProvider: AIFallbackProvider;
  fallbackLog: IRFallbackEntry[];
  config: ParserConfig;
  skipTags: Set<string>;
  wrapperTags: Set<string>;
  pageUrl: string;
}

export interface ParseContext {
  sourceUrl: string;
}
