import type { ParserConfig } from "./types";

/**
 * Tags that are a single piece of media rather than a subtree to walk. They are
 * in `SKIP_TAGS` so that nothing descends into them — an `<svg>`'s `<path>` and
 * `<g>` children are drawing instructions, not content — but the ELEMENT itself
 * is content and gets an `img` node. `getValidChildren` therefore keeps them and
 * `buildChildrenFromSiblings` handles them before it consults the skip set.
 *
 * Without that exception the skip test ran first and `handleMediaLeaf`, which
 * exists for exactly these two tags, was unreachable: every inline diagram on
 * every page produced no IR node at all.
 */
export const MEDIA_LEAF_TAGS = new Set(["svg", "canvas"]);

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

export const WRAPPER_TAGS = new Set(["div", "span", "picture", "center"]);

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
  aiFallbackIncludeWrappers: false,
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

export const PRUNE_SELECTORS = [
  ".mw-editsection",
  ".mw-editsection-bracket",
  ".mw-jump-link",
  ".mw-cite-backlink",
  ".reference",
  ".noprint",
  ".mw-ui-button",
  "#toc",
  "#catlinks",
  ".catlinks",
  ".navbox",
  ".sistersitebox",
  ".metadata",
  // Wikipedia Vector-2022 skin chrome that lives *inside* <main>, as
  // siblings of the real article body (#bodyContent) rather than outside
  // it — pruning the outer skip-to-main slice doesn't remove these, so
  // without this they get paginated ahead of the article as blank pages.
  ".vector-page-titlebar-toc",
  "#p-lang-btn",
  ".vector-page-toolbar",
  ".vector-column-end",
  "svg[aria-hidden='true']",
  "img[aria-hidden='true']",
  "span[aria-hidden='true']:empty",
  ".Z3988",
  "span[title^='ctx_ver=']",
  // Deferred-hydration skeletons. A site that renders islands client-side
  // (the Guardian's <gu-island deferUntil="visible">, and the same pattern
  // under other names) ships a placeholder subtree that its own JS swaps for
  // the real content. We parse static HTML and never run that JS, so all
  // that survives is a set of contentless boxes — which still reserve height
  // and paginate, reading as empty tiles where "most viewed" or the comment
  // thread should be.
  '[data-name="placeholder"]',
  '[data-testid="placeholder"]',
  "style",
  "script",
];
