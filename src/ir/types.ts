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
  | "dialog"
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
  | "article"
  | "document"
  | "marquee"
  | "timer"
  | "option"
  | "presentation"
  | "none"
  | "text"
  | "generic";

export type IRSource =
  | "explicit"
  | "structural"
  | "ai"
  | "ai-timeout"
  | "inline"
  | "generic";

export interface IRNodeAttributes {
  checked: string | null;
  selected: string | null;
  disabled: string | null;
  hidden: string | null;
  required: string | null;
  describedby: string | null;
  labelledby: string | null;
  haspopup: string | null;
  alt: string | null;
  src: string | null;
  intrinsicWidth: number | null;
  intrinsicHeight: number | null;
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
  readonly: string | null;
  captions: string[];
  componentType: string | null;
  content: string | null;
  styleTags: string[];
  /** Original HTML `id` attribute — the target of same-page `#fragment` links. */
  domId: string | null;
}

export interface IRNodeState {
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
  labelledBy: string[];
  describedBy: string[];
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

/** One node the parser could not classify, as handed to the provider. */
export interface AIClassifyRequest {
  /** IR node id — the key the response must come back under. */
  nodeId: string;
  /** The element's tag name, lower-cased. */
  tag: string;
  /** Serialised DOM subtree (attributes + a few levels of children). */
  subtree: string;
  /** What layers 1–2 settled on — always `generic` today, but say it anyway. */
  currentRole: IRRole;
}

/**
 * Provider interface. Swap the stub for a real implementation that calls a
 * cloud API or a local model without changing any other parser code.
 *
 * **`classifyBatch` is the real entry point.** A page that falls through to
 * layer 3 does so for tens of nodes at once, and one round trip per node is
 * the difference between a parse that finishes and one the reader abandons:
 * the walk is sequential, so per-node calls serialise end to end — 40 nodes ×
 * ~1 s is 40 s of staring at nothing, and it pays the prompt overhead 40
 * times over. The parser therefore collects every unresolved node during the
 * tree walk and calls this ONCE, after the walk (see `parsePageToIR`), which
 * also lets an implementation chunk and parallelise as it sees fit.
 *
 * The returned array is positional: `out[i]` answers `items[i]`, and `null`
 * means "no answer for this one" (unparseable, filtered, or dropped by a
 * failed chunk) — never a shorter array, never a re-ordered one.
 */
export interface AIFallbackProvider {
  classifyBatch(
    items: AIClassifyRequest[],
  ): Promise<(AIFallbackResponse | null)[]>;
  /**
   * Single-node convenience, kept for callers outside the parser. Implement it
   * as a batch of one rather than as a second code path.
   */
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

  /**
   * Whether a surviving `div`/`span` container may be sent to layer 3.
   *
   * Default false, which is the parser's long-standing behaviour: the layer-3
   * gate excluded every div and span outright. That exclusion made sense while
   * layer 3 was a stub — a node it declines to classify is recorded as
   * `ai-timeout`, and marking every anonymous div on every page that way would
   * be noise in the IR for no gain.
   *
   * It stops making sense the moment a real provider is configured, because
   * div soup is the entire problem layer 3 exists for: a div that reaches the
   * gate has already survived wrapper-piercing and the pure-text and
   * inline-container splices, so it is a real container with block children
   * and no semantics — exactly the node worth asking about. The renderer's
   * pipeline turns this on when, and only when, the reader has configured a
   * provider (see scene/use-pipeline.ts), so a parse with no AI configured is
   * byte-for-byte what it was before.
   */
  aiFallbackIncludeWrappers: boolean;

  /**
   * When true, semantic containers (landmarks, sections) will attempt to
   * resolve labels from headings, ARIA, etc.
   * When false, labels for semantic containers are skipped.
   */
  useSemanticLabels: boolean;

  /**
   * When true, text-bearing nodes (paragraph, heading, text) will
   * have labels derived from their text content.
   * When false, text-bearing nodes skip label resolution.
   */
  useTextLabels: boolean;

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

/**
 * A node parked during the tree walk for the layer-3 batch pass.
 *
 * It carries the `element` as well as the serialised subtree because a node
 * the AI re-roles may want its label resolved again: `resolveNodeLabelSmart`
 * treats a semantic container differently from a `generic` div, and the walk
 * had already labelled it as generic by the time we asked.
 */
export interface AIPendingNode extends AIClassifyRequest {
  element: Element;
}

export interface BuildContext {
  nodes: Record<string, IRNode>;
  landmarkRecords: LandmarkRecord[];
  doc?: Document;
  counters: TreeCounters;
  elementToNodeId: WeakMap<Element, string>;
  fallbackProvider: AIFallbackProvider;
  /** Nodes awaiting layer 3, in walk order. Drained once, after the walk. */
  aiQueue: AIPendingNode[];
  fallbackLog: IRFallbackEntry[];
  config: ParserConfig;
  skipTags: Set<string>;
  wrapperTags: Set<string>;
  inlineTags: Set<string>;
  pageUrl: string;
}

export interface ParseContext {
  sourceUrl: string;
}

/**
 * Selects which HTML processing strategy is applied before the XR pipeline.
 *
 * - "custom"      Full ARIA + structural inference + wrapper-piercing (default).
 * - "readability" @mozilla/readability article extraction, then full pipeline.
 * - "naive"       PARSER_CONFIGS.baseline — tag-to-role mapping only, no ARIA or inference.
 * - "flat"        Raw HTML rendered in a flat browser iframe; skips the XR pipeline entirely.
 * - "vips"        Simplified VIPS visual block segmentation (Cai et al., 2003), then semantic pipeline.
 * - "web2vr"      Direct CSS layout → 3D mapping via getBoundingClientRect() (kikoano/web2vr approach).
 */
export type ParserBackend =
  | "custom"
  | "readability"
  | "naive"
  | "flat"
  | "vips"
  | "web2vr";
