/**
 * compare/config.ts — tunable thresholds and static metadata for the
 * comparison panel (confidence cutoff, primitive-type universe, per-metric
 * help text, and the primitive types shown in the table).
 */

export const CONFIDENCE_THRESHOLD = 0.6;
export const TOTAL_PRIMITIVE_TYPES = 30; // approximate number of distinct XRPrimitiveType values

export const INLINE_PRIMITIVE_TYPES = new Set(["XRText", "XRLink"]);

export const METRIC_DESCRIPTIONS: Record<string, string> = {
  // Performance
  "Total pipeline":
    "Wall-clock time from raw HTML to a completed LayoutPlan, covering all three stages: IR parsing, semantic mapping, and 3D layout. Measured with performance.now() in the browser. Excludes network fetch and font loading.",
  "IR parse":
    "Time for Stage 1 — converting raw HTML into the Intermediate Representation. Covers DOM traversal, ARIA role resolution, structural inference (heading-bounded sections, link-run navigation, paragraph-run articles), and wrapper-piercing.",
  Mapper:
    "Time for Stage 2 — translating each IR node's role into a typed XR primitive (e.g. heading → XRHeading, nav → XRNavigationBar). No spatial positions are assigned here; only semantic facts are extracted.",
  "Layout engine":
    "Time for Stage 3 — assigning 3D positions, sizes, and pagination to every primitive. Includes template selection, landmark slot placement, content-panel stacking, and per-panel overflow pagination.",
  "HTML input size":
    "Size of the raw HTML source in kilobytes. Identical across all backends since they all receive the same document. Provides context for interpreting parse times and extraction efficiency.",

  // IR Structure
  "IR nodes total":
    "Total number of nodes in the Intermediate Representation after parsing. Includes all roles — landmarks, headings, paragraphs, inlines, and generics. Higher counts indicate finer-grained extraction or more wrapper-heavy source HTML.",
  Landmarks:
    "ARIA landmark regions detected: main, nav, banner, contentinfo (footer), aside (complementary), search, form. Each landmark becomes a top-level spatial panel in the XR scene.",
  Headings:
    "Elements resolved with the heading role (h1–h6 or explicit role=heading). Used to infer document hierarchy and section boundaries in Stage 1 structural inference.",
  "Sections (regions)":
    "Implicit or explicit sections inferred from heading-bounded content groups or ARIA region roles. Each maps to an XRSection primitive — a navigable card in Cards view.",
  "Interactive controls":
    "Nodes with interactive ARIA roles: button, textbox, checkbox, radio, combobox, slider, etc. Maps to form and control primitives in XR. High counts drive the form layout template selection.",
  "Word count":
    "Total words across all resolved node labels. Indicates how much textual content was successfully extracted and will be readable in the XR scene.",
  "Text length (chars)":
    "Total character count across all node labels. Combined with node count to compute text density.",
  "Text density (chars/node)":
    "Average label length per IR node. High values indicate nodes carry rich text content; low values suggest many structural or wrapper nodes.",
  "Live regions":
    "Nodes carrying aria-live attributes (status, alert, log). In XR these map to XRAlert primitives. Indicates pages with dynamic, real-time content regions.",

  // Semantic Precision & Recall
  "Heading recall":
    "IR headings extracted ÷ actual h1–h6 elements in the raw HTML DOM, as a percentage. A score of 100% means every HTML heading was recognised. Lower scores indicate the parser missed heading structure.",
  "Landmark recall":
    "IR landmarks extracted ÷ actual landmark elements in the raw HTML DOM (main, nav, header, footer, aside plus role= equivalents). Measures how completely the page's spatial frame was captured.",
  "Form input recall":
    "IR interactive controls extracted ÷ actual form inputs + buttons in the raw HTML. Indicates how well the parser captured interactive affordances.",
  "Image recall":
    "IR image primitives with labels ÷ images with non-empty alt text in the raw HTML. Measures how well alt-text-bearing images were surfaced for the XR scene.",
  "Nav region recall":
    "XRNavigationBar primitives ÷ actual nav / role=navigation elements in the raw HTML. A score of 100% means every navigation region was detected and mapped to a spatial nav panel.",

  // Accessibility preservation
  "aria-labelledby preserved":
    "IR nodes with a resolved aria-labelledby relationship ÷ total [aria-labelledby] elements in the raw HTML. Measures how faithfully the parser preserved ARIA labelling cross-references.",
  "aria-describedby preserved":
    "IR nodes with a resolved aria-describedby relationship ÷ total [aria-describedby] elements in the raw HTML. Describes how well supplemental descriptions were retained.",
  "Explicit role honor rate":
    "Explicit-source IR nodes with a non-generic role ÷ total explicit-source nodes. Measures the fraction of author-declared ARIA roles that were successfully classified into a typed XR primitive (not left as XRGenericPanel).",
  "Alt text coverage":
    "XRImage primitives with a resolved label ÷ total images with non-empty alt text in the raw HTML. Indicates how much visual content information is preserved for the XR scene.",

  // Information Fidelity
  "Text coverage":
    "IR word count ÷ full DOM word count of the raw HTML, as a percentage. 100% would mean every word in the page is represented in the IR. Values below 100% indicate text that was filtered, skipped, or lost during parsing.",
  "Heading text retention":
    "IR heading nodes with resolved labels ÷ actual heading elements in the raw HTML. A proxy for structural text fidelity — heading text drives section navigation in XR.",
  "Nodes per KB":
    "IR node count ÷ HTML input size in KB. Measures extraction density — how many semantic nodes were produced per kilobyte of source HTML. Higher values indicate more efficient semantic extraction from the same input.",

  // IR Quality
  "Labeling rate":
    "Percentage of IR nodes that have a non-null resolved label. Labels come from aria-label, aria-labelledby, <label for>, alt text, or text content. Higher rates mean more content is surfaced for XR display.",
  "Avg node confidence":
    "Mean classification confidence across all IR nodes (0–1). Confidence is assigned per source: explicit ARIA = 1.0, structural = 0.8, generic = 0.3. Higher averages indicate stronger overall evidence for role assignments.",
  "Parse confidence rate":
    "Percentage of IR nodes with confidence ≥ 0.6 (the default AI fallback threshold). Nodes below this threshold are candidates for AI-assisted reclassification. Higher rates indicate the parser resolved more nodes confidently from structure alone.",
  "Semantic node ratio":
    "Percentage of IR nodes that are neither generic (unclassified) nor inline (text runs). Represents the proportion of nodes that carry a meaningful typed role and will become a distinct spatial primitive in XR.",
  "Generic node ratio":
    "Percentage of IR nodes whose source is 'generic' — no semantic role could be inferred. High ratios indicate heavy reliance on unsemantic markup (div-soup). Generic nodes become transparent XRGenericPanel wrappers.",
  "Content-to-chrome ratio":
    "Content nodes (paragraph, heading, article, code, blockquote) ÷ chrome nodes (navigation, banner, footer). Higher values indicate the parser surfaced more readable content relative to page furniture.",
  "Nodes with ARIA relations":
    "Count of nodes carrying at least one ARIA relationship: aria-controls, aria-labelledby, aria-describedby, aria-owns, aria-flowto. Indicates richness of cross-element relationships preserved in the IR.",
  "Max semantic depth":
    "Deepest nesting level in the semantic containment tree. Top-level landmarks are depth 0; each nested section, article, list, or region adds 1. Affects Z-axis layering of nested panels in XR.",
  "Avg semantic depth":
    "Mean readingDepth across all IR nodes. Values near 0 indicate flat landmark-only structures; values above 2–3 indicate deeply nested content hierarchies.",

  // Source Breakdown
  explicit:
    "Nodes classified from an explicit role= ARIA attribute on the element. The highest-confidence source — the author directly declared semantic intent.",
  structural:
    "Nodes inferred from HTML structural patterns: heading-bounded implicit sections, consecutive <a> runs → navigation, consecutive <p> runs → article body, repeated identical subtrees → list.",
  ai: "Nodes that fell through layers 1 and 2 and were sent to the AI-assisted fallback classifier. Only active when useAIFallback=true and a provider is configured (stubbed in this build).",
  "ai-timeout":
    "Nodes sent to the AI provider that timed out and fell back to 'generic'. Indicates AI fallback latency issues.",
  inline:
    "Inline text and link runs within block elements (XRText, XRLink, XRButton). Rendered as flowing text inside their parent mesh — not given standalone plan entries.",
  generic:
    "Nodes that could not be classified by any layer. Rendered as XRGenericPanel — a transparent spatial wrapper whose children are dispatched at their panel-absolute positions.",

  // XR Primitive Types
  XRContentPanel:
    "The main scrollable content surface. Receives all body text, sections, and articles. Paginated when content height exceeds the device viewport. One per scene is expected.",
  XRSection:
    "A heading-delimited section within the content panel. Maps from ARIA region or structurally inferred content groups. Each becomes a navigable card in Cards view.",
  XRArticle:
    "An article-level content block. Similar to XRSection but mapped from <article> or ARIA article role. Typically represents self-contained editorial content.",
  XRNavigationBar:
    "A navigation landmark panel containing links. Rendered adjacent to the main content panel. If it mirrors section headings, it doubles as an in-scene table-of-contents.",
  XRHeading:
    "A heading element (h1–h6). Rendered with typographic prominence scaled to heading level.",
  XRParagraph:
    "A paragraph or block of prose text. The most common content primitive. Uses troika-three-text for GPU-rendered text.",
  XRListItem:
    "An individual list item. Can contain inline prose (text row) or nested block content (sibling primitives).",
  XRImage:
    "A resolved image node with an alt-text label. Rendered as a labelled plane in XR. Images without alt text are suppressed.",
  XRTable:
    "A tabular data structure. Layout strategy (flat-2d, curved-2d, scrollable, cards) is selected by the engine based on column count.",
  XRFormField:
    "An individual form control (input, select, textarea) with its resolved label. Grouped inside an XRFormPanel landmark.",
  XRButton:
    "A standalone button or call-to-action element. Rendered as an interactive rounded-box primitive.",
  XRCodeBlock:
    "A preformatted code block (<pre>/<code>). Rendered with monospace text in a distinct panel.",
  XRGenericPanel:
    "A transparent spatial wrapper for content that couldn't be more specifically typed. Its children are dispatched at their panel-absolute positions.",

  // XR Layout & Usability
  "Layout template":
    "Scene archetype auto-selected by the layout engine based on landmark counts, control density, and content volume. Determines spatial slot arrangement. Options: document, landing, generic, carousel, theatre.",
  "Primitives placed":
    "Total primitives assigned a valid 3D LayoutEntry — position, size, and rotation. The count of spatially realised nodes the renderer will draw.",
  "Paginated panels":
    "Number of content containers split across multiple virtual pages because their stacked children exceeded the panel viewport height.",
  "Total pages":
    "Sum of page counts across all paginated panels. Total number of virtual screens the user must navigate to read the entire page.",
  "Unplaced primitives":
    "Primitives in the semantic scene but not assigned a LayoutEntry. Inline XRText/XRLink are excluded (they render as text runs). Remaining unplaced primitives indicate layout engine coverage gaps.",
  "Fallback height estimates":
    "Primitives whose height could not be computed from font metrics and used a fixed floor value. Inaccurate heights degrade pagination — content may overflow or leave whitespace. Lower is better.",

  // XR Usability
  "Content panel present":
    "Whether a main XRContentPanel was detected and placed. This is the primary reading surface in the XR scene; its absence means the page's main content has no spatial container.",
  "TOC / nav available":
    "Whether at least one XRNavigationBar was detected. Enables in-scene section navigation and landmark jumping — a key usability feature for long-form XR documents.",
  "Words per page":
    "Average word count per virtual XR page (total words ÷ total pages). Higher values mean denser pages; lower values suggest over-paginated or sparse content. Useful for estimating reading time per page transition.",
  "Section granularity":
    "Sections per landmark (sectionCount ÷ landmarkCount). Higher values indicate richer hierarchical subdivision within each landmark — more navigable structure inside the main content panel.",
  "Semantic diversity":
    "Percentage of available XR primitive types that were actually instantiated (distinct types used ÷ 30 total). Higher values indicate the parser captured a broader range of semantic structures — headings, lists, tables, forms, code, media, alerts, etc.",

  // Composite
  "Semantic richness score":
    "Weighted composite (0–100) combining five dimensions equally: heading recall (structural capture), landmark recall (spatial frame), labeling rate (content accessibility), semantic node ratio (classification coverage), and accessibility preservation (ARIA fidelity). A single number summarising how semantically complete the XR representation is relative to the source HTML.",
};

// ─────────────────────────────────────────────────────────────
// Markdown export
// ─────────────────────────────────────────────────────────────


export const KEY_PRIMITIVE_TYPES = [
  "XRContentPanel",
  "XRSection",
  "XRArticle",
  "XRNavigationBar",
  "XRHeading",
  "XRParagraph",
  "XRListItem",
  "XRImage",
  "XRTable",
  "XRFormField",
  "XRButton",
  "XRCodeBlock",
  "XRGenericPanel",
];

// A row that shows a boolean as yes/no, coloured green/red
