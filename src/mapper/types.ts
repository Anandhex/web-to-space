import type { IRRole, PageIR } from "../ir/types";

/**
 * Every XR primitive type in the spatial vocabulary.
 * These are data structures, not React components or Three.js objects.
 * The rendering layer reads these and instantiates the appropriate meshes.
 */
export type XRPrimitiveType =
  | "XRScene"
  | "XRNavigationBar"
  | "XRContentPanel"
  | "XRSection"
  | "XRArticle"
  | "XRList"
  | "XRListItem"
  | "XRHeading"
  | "XRParagraph"
  | "XRImage"
  | "XRFigure"
  | "XRTable"
  | "XRTableRow"
  | "XRTableCell"
  | "XRFormPanel"
  | "XRFormField"
  | "XRButton"
  | "XRLink"
  | "XRSearchBox"
  | "XRSlider"
  | "XRToggle"
  | "XRComboBox"
  | "XRDialog"
  | "XRText"
  | "XRAlert"
  | "XRTooltip"
  | "XRMediaPlayer"
  | "XRCodeBlock"
  | "XRBlockQuote"
  | "XRSeparator"
  | "XRProgressBar"
  | "XRTabGroup"
  | "XRTab"
  | "XRTabPanel"
  | "XRMenu"
  | "XRMenuItem"
  | "XRTree"
  | "XRTreeItem"
  | "XRBanner"
  | "XRFooter"
  | "XRComplementary"
  | "XRGenericPanel";

// ============================================================
// Spatial geometry
// ============================================================

/** 3-D position in metres, WebXR right-handed coordinate system. */
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** Euler rotation in radians (XYZ order). */
export interface Rotation3 {
  x: number;
  y: number;
  z: number;
}

/** 2-D size in metres. */
export interface Size2 {
  width: number;
  height: number;
}

/**
 * Spatial placement hint produced by the mapper.
 * The rendering layer may override these values based on runtime constraints
 * (headset FOV, room-scale boundaries, user preferences).
 */
export interface SpatialPlacement {
  /** Position relative to the scene origin (metres). */
  position: Vec3;
  /** Euler rotation (radians). Default is facing the viewer (0, 0, 0). */
  rotation: Rotation3;
  /** Preferred panel size (metres). Renderer may scale proportionally. */
  preferredSize: Size2;
  /**
   * Curvature radius for curved panels (metres).
   * 0 = flat. Default panels use PANEL_CURVE_RADIUS.
   * Justified by FOV ergonomics: a curved surface at ~1 m keeps all
   * content within the comfortable ±30° horizontal viewing angle.
   */
  curveRadius: number;
  /** World-locked (true) vs head-locked (false). Default true. */
  worldLocked: boolean;
}

// ============================================================
// State and interaction
// ============================================================

/** Interactive state extracted from IRNodeState and mapped to XR affordances. */
export interface XRInteractionState {
  disabled: boolean;
  expanded: boolean | null;
  checked: boolean | null;
  selected: boolean | null;
  pressed: boolean | null;
  required: boolean;
  readonly: boolean;
  invalid: boolean;
  busy: boolean;
  /** Current value for range inputs / progress bars (normalised 0–1). */
  valueFraction: number | null;
}

// ============================================================
// Base primitive
// ============================================================

/**
 * All XR primitives extend this base.
 * Fields common to every node in the spatial scene graph.
 */
export interface XRPrimitiveBase {
  /** Unique identifier — mirrors the source IR node ID. */
  id: string;
  type: XRPrimitiveType;
  /** Accessible label for XR UI (speech, laser pointer hover). */
  label: string | null;
  content: string | null;
  /** Source IR node ID(s). One-to-many when the mapper merges nodes. */
  sourceIds: string[];
  /** Semantic confidence inherited from the highest-confidence source node. */
  confidence: number;
  /** Semantic containment depth (from IRNode.readingDepth). */
  depth: number;
  // to be set via the layout engine, not the mapper directly, since it may be overridden by runtime constraints
  //   placement: SpatialPlacement;
  /** Child primitives in the spatial scene graph. */
  children: XRPrimitive[];
  /** IDs of related primitives (controls, labelledBy, etc.). */
  relations: {
    controls: string[];
    labelledBy: string[];
    describedBy: string[];
    details: string[];
    errorMessage: string[];
  };

  placement?: SpatialPlacement; // optional in the base, since not all primitives need to specify it
}

// ============================================================
// Concrete primitive types
// ============================================================

/** The root of the spatial scene. One per PageIR. */
export interface XRScene extends XRPrimitiveBase {
  type: "XRScene";
  /** Page title from IRMeta. */
  pageTitle: string | null;
  /** Ordered child IDs matching the reading order strategy. */
  readingOrder: string[];
}

/**
 * Arc-shaped navigation bar.
 * Mapped from: navigation landmark, or inferred link-run.
 * Placement: curved arc at eye level, anchored to the left or bottom
 * of the comfort envelope.
 */
export interface XRNavigationBar extends XRPrimitiveBase {
  type: "XRNavigationBar";
  items: XRLink[];
}

/**
 * Full-width content panel — the primary spatial container.
 * Mapped from: main landmark.
 */
export interface XRContentPanel extends XRPrimitiveBase {
  type: "XRContentPanel";
  /** Preferred layout direction for child primitives. Always "column". */
  flowDirection: "column";
}

/**
 * Bounded region within a content panel.
 * Mapped from: region, article (top-level), heading-inferred section.
 */
export interface XRSection extends XRPrimitiveBase {
  type: "XRSection";
  /** Heading text used as the section title bar. */
  title: string | null;
  /** Heading level (1–6) of the section title, if available. */
  titleLevel: number | null;
  /**
   * Preferred layout direction for child primitives.
   * "column" = vertical stack (default for content sections).
   * "row"    = horizontal arrangement (e.g. card grids, nav bars).
   * "none"   = renderer decides.
   */
  flowDirection: "column" | "row" | "none";
}

/**
 * Prose article — long-form reading content.
 * Mapped from: article role, paragraph-run group.
 */
export interface XRArticle extends XRPrimitiveBase {
  type: "XRArticle";
  /** Preferred layout direction for child primitives. */
  flowDirection: "column" | "row" | "none";
}

/**
 * List of uniform items (cards).
 * Mapped from: list (when children are structurally uniform),
 * feed, or repeated-subtree inferred list.
 * Renamed from XRCardGrid to XRList to reflect its generic list semantics.
 */
export interface XRList extends XRPrimitiveBase {
  type: "XRList";
  listType: "ordered" | "unordered" | null;
  /** Preferred number of columns. Derived from child count and available width. */
  // columnCount is null — Layout resolves this from panel geometry
  //   columns: number;
}

/**
 * Individual list item (card) within an XRList or standalone.
 * Mapped from: listitem, article (when nested inside a list).
 * Renamed from XRCard to XRListItem.
 */
export interface XRListItem extends XRPrimitiveBase {
  type: "XRListItem";
}

export interface XRInlineRun {
  text: string; // the visible text of this run
  tag: string; // "text" | "a" | "strong" | "em" | "code" | "span" | etc.
  href?: string | null; // for <a>
  role?: string | null; // ARIA role if present
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
}
/** Heading text element. */
export interface XRHeading extends XRPrimitiveBase {
  type: "XRHeading";
  level: number;
}

/** Paragraph of prose text. */
export interface XRParagraph extends XRPrimitiveBase {
  type: "XRParagraph";
  /**
   * Approximate word count derived from the node's label/text content.
   * Used by the renderer to choose between inline text, panel, or paginated view.
   */
  wordCount: number;
  /**
   * Estimated reading time in seconds at 200 wpm (average adult reading speed).
   */
  estimatedReadingTimeSec: number;
  /**
   * Density score in range [0, 1].
   * 0 = very short (≤ 10 words), 1 = very long (≥ 200 words).
   * Renderer can use this to decide panel vs. page vs. carousel layout.
   */
  densityScore: number;
}

/**
 * Image primitive.
 * Mapped from: img, figure (when it contains only an image and optional caption).
 */
export interface XRImage extends XRPrimitiveBase {
  type: "XRImage";
  src: string | null;
  alt: string | null;
  intrinsicWidth: number | null;
  intrinsicHeight: number | null;
}

/**
 * Figure with optional caption.
 * Mapped from: figure (when it contains mixed content beyond a single image).
 */
export interface XRFigure extends XRPrimitiveBase {
  type: "XRFigure";
  captionId: string | null;
}

/**
 * XR-specific table layout strategy.
 * to be implemented by the layout engine based on IR analytics (table size, cell complexity) and panel geometry.
 *
 * "flat-2d"     — traditional 2-D floating table (≤4 columns, ≤8 rows).
 * "curved-2d"   — large table rendered on a curved surface for ergonomics.
 * "scrollable"  — table too large to show all at once; rendered in a scroll panel.
 * "cards"       — pivot: each row becomes a card (better for wide, few-column tables).
 */
export type TableLayoutStrategy =
  | "flat-2d"
  | "curved-2d"
  | "scrollable"
  | "cards";

/**
 * Data table.
 * Mapped from: table.
 */
export interface XRTable extends XRPrimitiveBase {
  type: "XRTable";
  columnCount: number;
  rowCount: number;
}

export interface XRTableRow extends XRPrimitiveBase {
  type: "XRTableRow";
  isHeader: boolean;
}

export interface XRTableCell extends XRPrimitiveBase {
  type: "XRTableCell";
  isHeader: boolean;
  colspan: number;
  rowspan: number;
  /** Zero-based row index within the table. */
  rowIndex: number;
  /** Zero-based column index within the table (accounts for preceding colspans). */
  columnIndex: number;
  /** IDs of header cells associated with this cell. */
  headers: string[];
}

/**
 * Form container.
 * Mapped from: form landmark, search landmark.
 */
export interface XRFormPanel extends XRPrimitiveBase {
  type: "XRFormPanel";
}

/**
 * Individual form field wrapper (label + control).
 * Mapped from: group (fieldset), or synthesised around a labelled input.
 */
export interface XRFormField extends XRPrimitiveBase {
  type: "XRFormField";
  controlType:
    | "textbox"
    | "searchbox"
    | "checkbox"
    | "radio"
    | "combobox"
    | "slider"
    | "spinbutton"
    | "switch"
    | "textarea"
    | "fieldset";
  state: XRInteractionState;
  placeholder: string | null;
  valueMin: number | null;
  valueMax: number | null;
  valueFraction: number | null;
  /**
   * Resolved label text from aria-labelledby references.
   * Populated when the IR node has labelledBy relations pointing to
   * nodes whose label text can be resolved. Null when unresolvable.
   */
  resolvedLabel: string | null;
}

/** Pressable button. */
export interface XRButton extends XRPrimitiveBase {
  type: "XRButton";
  state: XRInteractionState;
  hasPopup: string | null;
}

/** Navigation link. */
export interface XRLink extends XRPrimitiveBase {
  type: "XRLink";
  href: string | null;
  isCurrent: boolean;
}

/** Search input. */
export interface XRSearchBox extends XRPrimitiveBase {
  type: "XRSearchBox";
  state: XRInteractionState;
  placeholder: string | null;
}

/** Range slider. */
export interface XRSlider extends XRPrimitiveBase {
  type: "XRSlider";
  state: XRInteractionState;
  valueMin: number | null;
  valueMax: number | null;
  valueFraction: number | null;
}

/** Boolean toggle (checkbox or switch). */
export interface XRToggle extends XRPrimitiveBase {
  type: "XRToggle";
  toggleType: "checkbox" | "radio" | "switch";
  state: XRInteractionState;
}

/** Select / combobox. */
export interface XRComboBox extends XRPrimitiveBase {
  type: "XRComboBox";
  state: XRInteractionState;
}

/** Modal dialog overlay. */
export interface XRDialog extends XRPrimitiveBase {
  type: "XRDialog";
  isModal: boolean;
  state: XRInteractionState;
}

// TODO: need to implement xr-specific presentation hints in the layout engine and since we have removed here the layout to should handle it
/**
 * XR-specific presentation style for a live-region alert.
 *
 * "floating-notification" — ephemeral toast that appears in peripheral zone.
 * "audio-cue"             — audio-only announcement (no visual panel).
 * "inline-banner"         — rendered inline as a banner within the parent panel.
 */
export type AlertXRPresentation =
  | "floating-notification"
  | "audio-cue"
  | "inline-banner";

/** Live-region alert (assertive). */
export interface XRAlert extends XRPrimitiveBase {
  type: "XRAlert";
  /** Whether this is an assertive alert (role="alert") or polite status (role="status"). */
  liveRegion: "assertive" | "polite";
}

/**
 * XR-specific presentation style for a tooltip.
 *
 * "contextual-bubble" — floating bubble anchored near the trigger element.
 * "gaze-reveal"       — revealed on gaze dwell (eye-tracking hint).
 */
export type TooltipXRPresentation = "contextual-bubble" | "gaze-reveal";

/** Tooltip (shown on hover / focus). */
export interface XRTooltip extends XRPrimitiveBase {
  type: "XRTooltip";
}

/**
 * XR-specific media sizing strategy. to be implemented by the layout engine based on IR analytics and panel geometry.
 *
 * "large-panel"    — video rendered as a large (cinema-scale) curved panel.
 * "compact-widget" — audio or short video rendered as a small floating widget.
 * "ambient"        — background media, rendered outside the primary comfort zone.
 */
export type MediaSizingStrategy = "large-panel" | "compact-widget" | "ambient";

/** Video or audio player. */
export interface XRMediaPlayer extends XRPrimitiveBase {
  type: "XRMediaPlayer";
  mediaType: "video" | "audio";
  src: string | null;
  poster: string | null;
  captions: string[];
}

/** Syntax-highlighted code block. */
export interface XRCodeBlock extends XRPrimitiveBase {
  type: "XRCodeBlock";
}

/** Pull-quote or block quotation. */
export interface XRBlockQuote extends XRPrimitiveBase {
  type: "XRBlockQuote";
}

/** Horizontal rule / thematic break. */
export interface XRSeparator extends XRPrimitiveBase {
  type: "XRSeparator";
  orientation: "horizontal" | "vertical";
}

/** Progress bar or meter. */
export interface XRProgressBar extends XRPrimitiveBase {
  type: "XRProgressBar";
  valueFraction: number | null;
}

/** Tab group container. */
export interface XRTabGroup extends XRPrimitiveBase {
  type: "XRTabGroup";
  orientation: "horizontal" | "vertical";
}

export interface XRTab extends XRPrimitiveBase {
  type: "XRTab";
  state: XRInteractionState;
  panelId: string | null;
}

export interface XRTabPanel extends XRPrimitiveBase {
  type: "XRTabPanel";
}

export interface XRText extends XRPrimitiveBase {
  type: "XRText";
  /** The actual text content from the IR text node */
  text: string;
  /** Semantic type: "em", "strong", "span", etc. from componentType attribute */
  componentType: string | null;
  /** Always true for text nodes - they're prose runs */
  isProseRun: boolean;
  styleTags: string[];
}

/** Dropdown / context menu. */
export interface XRMenu extends XRPrimitiveBase {
  type: "XRMenu";
  menuType: "menu" | "menubar";
}

export interface XRMenuItem extends XRPrimitiveBase {
  type: "XRMenuItem";
  itemType: "menuitem" | "menuitemcheckbox" | "menuitemradio";
  state: XRInteractionState;
}

/** Hierarchical tree widget. */
export interface XRTree extends XRPrimitiveBase {
  type: "XRTree";
  multiselectable: boolean;
}

export interface XRTreeItem extends XRPrimitiveBase {
  type: "XRTreeItem";
  state: XRInteractionState;
}

/** Page header banner. */
export interface XRBanner extends XRPrimitiveBase {
  type: "XRBanner";
}

/** Page footer. */
export interface XRFooter extends XRPrimitiveBase {
  type: "XRFooter";
}

/** Sidebar / complementary content. */
export interface XRComplementary extends XRPrimitiveBase {
  type: "XRComplementary";
}

/** Fallback — unmapped roles. Always emitted so content is never dropped. */
export interface XRGenericPanel extends XRPrimitiveBase {
  type: "XRGenericPanel";
  /** Original IR role that produced this fallback. */
  irRole: IRRole;
}

/** Discriminated union of all XR primitives. */
export type XRPrimitive =
  | XRScene
  | XRNavigationBar
  | XRContentPanel
  | XRSection
  | XRArticle
  | XRList
  | XRListItem
  | XRHeading
  | XRParagraph
  | XRImage
  | XRFigure
  | XRTable
  | XRTableRow
  | XRTableCell
  | XRFormPanel
  | XRFormField
  | XRButton
  | XRLink
  | XRSearchBox
  | XRSlider
  | XRToggle
  | XRComboBox
  | XRDialog
  | XRAlert
  | XRText
  | XRTooltip
  | XRMediaPlayer
  | XRCodeBlock
  | XRBlockQuote
  | XRSeparator
  | XRProgressBar
  | XRTabGroup
  | XRTab
  | XRTabPanel
  | XRMenu
  | XRMenuItem
  | XRTree
  | XRTreeItem
  | XRBanner
  | XRFooter
  | XRComplementary
  | XRGenericPanel;

// ============================================================
// Scene output
// ============================================================

/**
 * The complete output of the mapper.
 * Consumed by the XR rendering layer.
 */
export interface SemanticScene {
  /** Root XRScene node containing the full primitive tree. */
  root: XRScene;
  /**
   * Flat registry of all primitives keyed by ID.
   * Mirrors the flat-dictionary pattern of PageIR.nodes for O(1) lookup.
   */
  primitives: Record<string, XRPrimitive>;
  /** Ordered primitive IDs matching the reading order strategy from the IR. */
  readingOrder: string[];
  /** Mapping diagnostics — useful for evaluation and debugging. */
  diagnostics: MappingDiagnostics;
  /**
   * Layout template selected from IR analytics.
   * Stored here so the layout engine can consume it without re-running
   * selectLayoutTemplate, and so the renderer can display it in diagnostics.
   *  to be done via the layout engine, not the mapper directly, since it may be overridden by runtime constraints
   */
  //   template: LayoutTemplate;
}

export interface MappingDiagnostics {
  /** Number of IR nodes that fell through to XRGenericPanel. */
  unmappedCount: number;
  /** IR roles that were not matched by any specific rule. */
  unmappedRoles: IRRole[];
  /** Number of IR nodes that were merged into a single XR primitive. */
  mergedCount: number;
  /** Number of IR nodes elided (role none/presentation). */
  elisionCount: number;
  /** Total IR nodes consumed. */
  totalIRNodes: number;
  /** Total XR primitives produced (elided nodes excluded). */
  totalPrimitives: number;
  /**
   * Transformation provenance keyed by primitive ID.
   * Captures the rule applied, derived confidence, contributing source nodes,
   * and any heuristic label — useful for thesis evaluation.
   */
  appliedRules: Record<string, TransformationRecord>;
}

/**
 * Rich provenance record for a single mapping transformation.
 * Replaces the previous bare MappingRule string so evaluators can trace
 * exactly how each XR primitive was derived from the IR.
 */
export interface TransformationRecord {
  /** The named mapping rule that produced this primitive. */
  rule: MappingRule;
  /**
   * Derived confidence for synthesised primitives (e.g. XRSection from
   * heading+siblings). For direct 1-to-1 mappings this equals node.confidence.
   * For merged/synthesised primitives this is computed from contributors.
   */
  confidence: number;
  /** IR node IDs that contributed to this primitive. */
  sourceNodeIds: string[];
  /**
   * Human-readable label for the heuristic that fired, if any.
   * Examples: "heading+siblings", "paragraph-run", "uniform-list".
   */
  heuristic: string | null;
}

export type MappingRule =
  | "landmark:main→XRContentPanel"
  | "landmark:navigation→XRNavigationBar"
  | "landmark:navigation→XRList"
  | "landmark:banner→XRBanner"
  | "landmark:contentinfo→XRFooter"
  | "landmark:complementary→XRComplementary"
  | "landmark:search→XRFormPanel"
  | "landmark:form→XRFormPanel"
  | "landmark:region→XRSection"
  | "heading+siblings→XRSection"
  | "paragraph-run→XRArticle"
  | "toc:inferred→XRNavigationBar"
  | "list:uniform→XRList"
  | "list:ordered→XRList"
  | "list:generic→XRList"
  | "listitem→XRListItem"
  | "heading→XRHeading"
  | "paragraph→XRParagraph"
  | "article→XRArticle"
  | "img→XRImage"
  | "figure:image-only→XRImage"
  | "figure:mixed→XRFigure"
  | "table→XRTable"
  | "row→XRTableRow"
  | "cell→XRTableCell"
  | "columnheader→XRTableCell"
  | "rowheader→XRTableCell"
  | "button→XRButton"
  | "link→XRLink"
  | "textbox→XRFormField"
  | "searchbox→XRSearchBox"
  | "checkbox→XRToggle"
  | "radio→XRToggle"
  | "switch→XRToggle"
  | "combobox→XRComboBox"
  | "slider→XRSlider"
  | "spinbutton→XRFormField"
  | "dialog→XRDialog"
  | "alert→XRAlert"
  | "status→XRAlert"
  | "tooltip→XRTooltip"
  | "video→XRMediaPlayer"
  | "audio→XRMediaPlayer"
  | "code→XRCodeBlock"
  | "blockquote→XRBlockQuote"
  | "separator→XRSeparator"
  | "progressbar→XRProgressBar"
  | "tablist→XRTabGroup"
  | "tab→XRTab"
  | "tabpanel→XRTabPanel"
  | "menu→XRMenu"
  | "menubar→XRMenu"
  | "menuitem→XRMenuItem"
  | "menuitemcheckbox→XRMenuItem"
  | "menuitemradio→XRMenuItem"
  | "tree→XRTree"
  | "treeitem→XRTreeItem"
  | "group:fieldset→XRFormField"
  | "group:generic→XRSection"
  | "feed→XRList"
  | "alert:assertive→XRAlert:floating-notification"
  | "alert:polite→XRAlert:inline-banner"
  | "tooltip→XRTooltip:contextual-bubble"
  | "video:default→XRMediaPlayer:large-panel"
  | "video:autoplay→XRMediaPlayer:ambient"
  | "audio→XRMediaPlayer:compact-widget"
  | "table:trivial→XRGenericPanel"
  | "table:flat-2d→XRTable"
  | "table:curved-2d→XRTable"
  | "table:scrollable→XRTable"
  | "table:cards→XRTable"
  | "generic→XRGenericPanel"
  | "none→(elided)"
  | "text→XRText"
  | "leaf-text-fallback→XRText"
  | "presentation→(elided)";

// ============================================================
// Mapper configuration
// ============================================================

export interface MapperConfig {
  /**
 
  /**
   * Minimum confidence score below which a primitive is flagged in diagnostics
   * but still emitted.  Does not suppress output.
   */
  lowConfidenceThreshold: number;

  /**
   * Whether to elide nodes with role "none" or "presentation" from the output.
   * Default true — these nodes carry no semantic content.
   */
  elidePresentation: boolean;

  /**
   * Minimum number of listitem children for a list to become an XRList.
   * Below this threshold the list is mapped as an XRSection instead.
   * Default 2.
   */
  minCardGridItems: number;

  /**
   * Maximum number of direct child primitives allowed in a single panel
   * before a diagnostics warning is recorded. Does not split panels —
   * splitting is a renderer concern. Default 50.
   */
  maxPanelChildren: number;
}

export interface MappingContext {
  ir: PageIR;
  config: MapperConfig;
  primitives: Record<string, XRPrimitive>;
  diagnostics: MappingDiagnostics;
}
