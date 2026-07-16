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
    "XR form-control primitives (XRFormField, XRToggle, XRSlider, XRComboBox, XRSearchBox) ÷ actual form inputs in the raw HTML (text/number/select/textarea/checkbox/radio/range/search — excludes hidden, submit, button). Each input type maps to a different primitive, so all are counted. Clamped at 100%.",
  "Image recall":
    "IR image primitives with labels ÷ images with non-empty alt text in the raw HTML. Measures how well alt-text-bearing images were surfaced for the XR scene.",
  "Nav region recall":
    "XRNavigationBar primitives ÷ actual nav / role=navigation elements in the raw HTML — excluding navs nested inside page chrome (header/footer/banner/contentinfo), which the parser drops and so are not recoverable. 100% when there are no such content navs to recover.",

  // Accessibility preservation
  "aria-labelledby preserved":
    "IR nodes with a resolved aria-labelledby relationship ÷ total [aria-labelledby] elements in the raw HTML. Measures how faithfully the parser preserved ARIA labelling cross-references.",
  "aria-describedby preserved":
    "IR nodes with a resolved aria-describedby relationship ÷ total [aria-describedby] elements in the raw HTML. Describes how well supplemental descriptions were retained.",
  "Explicit role honor rate":
    "Explicit-source IR nodes with a non-generic role ÷ total explicit-source nodes. Measures the fraction of author-declared ARIA roles that were successfully classified into a typed XR primitive (not left as XRGenericPanel).",
  "Alt text coverage":
    "Fraction of the DOM's non-empty alt strings that survive into the scene as an XRImage's alt/label (matched by content). A true set intersection, so it is ≤100% — the parser cannot preserve more alt text than the page contains.",

  // Structure & Interaction
  "Interactive affordance preservation":
    "Interactive XR primitives produced (buttons, links, form fields, toggles, sliders, combo/search boxes, tabs, menu/tree items) ÷ interactive elements in the raw HTML (links, buttons, inputs, interactive ARIA roles). Clamped at 100% — the scene should not invent affordances the page lacks.",
  "Control label coverage":
    "Of the interactive primitives placed in the scene, the fraction that carry a non-empty label. Unlabeled controls are unusable in XR — there is nothing to speak aloud or show on laser-pointer hover — so higher is critical for an accessible spatial UI.",
  "Heading hierarchy validity":
    "Fraction of consecutive heading transitions (in reading order) that do not skip a level when descending — e.g. h2→h4 is a violation, h2→h3 or h3→h2 are valid. A proxy for WCAG 1.3.1 structural correctness that drives sane section nesting in XR. 100% when there are fewer than two headings.",
  "Reading-order fidelity":
    "Does the scene present content in the same order as the page? Kendall's τ rank agreement between the DOM document order of content units and the scene's reading order (aligned by text), mapped so 100% = identical order, 50% = uncorrelated, 0% = fully reversed. A reordered scene disorients spatial reading and screen-reader traversal.",
  "Link target retention":
    "Combined rollup: all links that survived with a usable href ÷ all DOM <a href> (clamped at 100%). A dropped href is a dead link in XR. Broken out below into navigation vs inline, which are different XR affordances with independent failure modes.",
  "— navigation links":
    "Navigation/standalone links (in a nav/menu, or a link-only list item) that became a placed XRLink primitive with a usable href ÷ DOM navigation links. These are the spatial, raycast-targetable wayfinding affordances.",
  "— inline links":
    "In-prose links (surrounded by other text) that survived as an inline run carrying a usable href ÷ DOM in-prose links. These are followable links within reading flow, not standalone spatial buttons.",
  "Table structure preservation":
    "XRTableCell primitives ÷ DOM table cells (td + th), clamped at 100%. Indicates how much tabular structure the pipeline reconstructed; low values mean tables collapsed or cells were lost. 100% when the page has no tables.",
  "Media preservation":
    "XRMediaPlayer primitives ÷ DOM <video> + <audio> elements, clamped at 100%. Whether embedded media survived into the spatial scene as a playable panel. 100% when the page has no media.",

  // Information Fidelity
  "Text coverage":
    "IR word count ÷ full DOM word count of the raw HTML, as a percentage. 100% would mean every word in the page is represented in the IR. Values below 100% indicate text that was filtered, skipped, or lost during parsing.",

  // IR Quality
  "Labeling rate":
    "Percentage of IR nodes that surface something readable in XR — either an explicit accessible name (aria-label, aria-labelledby, <label for>, alt) OR text content. Structural and prose nodes (headings, paragraphs, text runs) carry their text in content rather than a label, so they count here too; the shortfall is empty wrapper/container nodes that carry neither.",
  "Avg node confidence":
    "Mean classification confidence across all IR nodes (0–1). Confidence is assigned per source: explicit ARIA = 1.0, structural = 0.8, generic = 0.3. Higher averages indicate stronger overall evidence for role assignments.",
  "Parse confidence rate":
    "Percentage of IR nodes with confidence ≥ 0.6 (the default AI fallback threshold). Nodes below this threshold are candidates for AI-assisted reclassification. Higher rates indicate the parser resolved more nodes confidently from structure alone.",
  "Semantic node ratio":
    "Percentage of IR nodes that are neither generic (unclassified) nor inline (text runs). Represents the proportion of nodes that carry a meaningful typed role and will become a distinct spatial primitive in XR.",
  "Generic node ratio":
    "Percentage of IR nodes whose source is 'generic' — no semantic role could be inferred. High ratios indicate heavy reliance on unsemantic markup (div-soup). Generic nodes become transparent XRGenericPanel wrappers.",
  "Nodes with ARIA relations":
    "Count of nodes carrying at least one ARIA relationship: aria-controls, aria-labelledby, aria-describedby, aria-owns, aria-flowto. Indicates richness of cross-element relationships preserved in the IR.",

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

  // XR Spatial Quality (literature-grounded — see src/eval/xr-quality.ts)
  "Mean text angular size":
    "Char-weighted mean cap-height visual angle (degrees) of all text primitives at the profile's viewing distance (1.2 m), θ = 2·atan(h/2d). Legibility floor ≈ 0.29°; comfortable-reading target ≈ 1.375° per VR text-legibility studies (IEEE VR 2020, ACM VRST 2025).",
  "Legible text fraction":
    "Fraction of text (weighted by character count) whose angular size is at or above the 0.29° legibility floor. Below the floor, XR text becomes hard to read.",
  "Comfortable text fraction":
    "Fraction of text at or above the 1.375° comfortable-reading target. A value near 0 means text is legible but smaller than the cited XR comfort ideal.",
  "Comfort envelope coverage":
    "Fraction of top-level panel area whose centre lies within the ±comfort-half-angle horizontal cone around forward gaze. Content outside the cone costs a head turn.",
  "Peripheral panels":
    "Number of top-level panels whose centre falls beyond the comfort cone and therefore requires a head rotation to read. Lower is better.",
  "Main panel FOV fill":
    "Main content-panel area ÷ comfort-viewport area at the viewing distance. ~0.4–0.9 is a comfortable fill; ≫1 spills past the cone, ≪ wastes the field of view.",
  "Page turns to read all":
    "Sequential virtual-page transitions needed to read every paginated panel (Σ pages − #paginated panels). A navigation-cost proxy; lower is better.",
  "Reading distance error":
    "Area-weighted mean |panel distance − profile viewing distance| in metres. Panels placed nearer than 0.5 m or farther than 20 m are outside the legible window.",

  // Segmentation (per backend — see src/eval/segmentation.ts)
  "Segmentation F-measure":
    "Harmonic mean of segmentation precision and recall (0–1). Measures how well THIS backend's produced scene groups the page into blocks, vs the page's semantic sectioning. Size-weighted BCubed per Kiesel et al., CIKM 2020. Higher is better.",
  "Segmentation precision":
    "Of the content this backend grouped together into a block, the fraction that truly belongs together in the reference. Low precision = the backend merged distinct sections. Size-weighted BCubed.",
  "Segmentation recall":
    "Of the content that belongs together in the reference, the fraction this backend kept in the same block. Low recall = the backend split one section across several blocks. Size-weighted BCubed.",
  "Segments produced":
    "Number of distinct blocks this backend's scene grouped the aligned content into. Not better-or-worse on its own — read alongside precision/recall.",
  "Aligned units (of reference)":
    "How many of the reference's atomic content units were found in this backend's scene (text-matched). Lower means the backend dropped or transformed more content; the F-measure is computed over these matched units only.",
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
