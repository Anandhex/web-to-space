import type { ParserConfig } from "./types";

export const SKIP_TAGS = new Set([
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

export const WRAPPER_TAGS = new Set(["div", "span", "picture"]);

export const LANDMARK_ROLES = new Set([
  "main",
  "navigation",
  "banner",
  "contentinfo",
  "complementary",
  "search",
  "form",
  "region",
]);

export const INTERACTIVE_ROLES = new Set([
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
  useSemanticLabels: true,
  useTextLabels: false,
  labelMaxChars: 280,
  includeSvg: false,
  includeCanvas: false,
  sourceConfidence: {
    explicit: 0.95,
    structural: 0.75,
    ai: 0.61,
    "ai-timeout": 0.4,
    generic: 0.55,
    inline: 0.9,
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
  /** Minimal label resolution - only semantic containers get labels */
  minimalLabels: {
    ...DEFAULT_CONFIG,
    useSemanticLabels: true,
    useTextLabels: false,
  },

  /** No labels at all - pure structure */
  noLabels: {
    ...DEFAULT_CONFIG,
    useSemanticLabels: false,
    useTextLabels: false,
  },

  /** Full labels - everything gets labels */
  fullLabels: {
    ...DEFAULT_CONFIG,
    useSemanticLabels: true,
    useTextLabels: true,
  },
} satisfies Record<string, ParserConfig>;

/**
 * Inline-level HTML tags. Text nodes and these elements together form prose
 * runs that should be grouped into a single paragraph-like node rather than
 * being split or silently dropped.
 */
export const INLINE_TAGS = new Set([
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
