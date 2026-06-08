/**
 * mapper.ts — Semantic IR → XR Spatial Layout
 *
 * Consumes a `PageIR` produced by the parser and emits a `SpatialScene` —
 * a tree of typed XR primitives that the rendering layer (Three.js / WebXR)
 * can instantiate without knowing anything about HTML or ARIA.
 *
 * Architecture position:
 *   HTML → Parser → IR → **Mapper (this file)** → SpatialScene → XR Renderer
 *
 * Design principles
 * ─────────────────
 * 1. The mapper is a pure function: (PageIR, MapperConfig) → SpatialScene.
 *    No side-effects, no DOM access, no Three.js imports.
 *
 * 2. Every mapping rule is a named, exported function so rules can be
 *    tested and documented in isolation.
 *
 * 3. Spatial measurements are in metres (WebXR coordinate system).
 *    All defaults are derived from XR ergonomic literature:
 *    comfortable viewing distance 0.5 m – 2.0 m, FOV ±30° horizontal.
 *
 * 4. The mapper never silently drops nodes. Unmapped roles produce
 *    XRGenericPanel so content always appears, even if unoptimised.
 */

import type {
  PageIR,
  IRNode,
  IRRole,
  IRAnalytics,
  LandmarkTOCNode,
} from "../ir/parser";

// ============================================================
// XR Primitive vocabulary
// ============================================================

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
  | "XRCardGrid"
  | "XRCard"
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
  /** Source IR node ID(s). One-to-many when the mapper merges nodes. */
  sourceIds: string[];
  /** Semantic confidence inherited from the highest-confidence source node. */
  confidence: number;
  /** Semantic containment depth (from IRNode.readingDepth). */
  depth: number;
  placement: SpatialPlacement;
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
 * Grid of uniform cards.
 * Mapped from: list (when children are structurally uniform),
 * feed, or repeated-subtree inferred list.
 */
export interface XRCardGrid extends XRPrimitiveBase {
  type: "XRCardGrid";
  listType: "ordered" | "unordered" | null;
  /** Preferred number of columns. Derived from child count and available width. */
  columns: number;
}

/**
 * Individual card within a card grid or standalone.
 * Mapped from: listitem, article (when nested inside a list).
 */
export interface XRCard extends XRPrimitiveBase {
  type: "XRCard";
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
  /**
   * XR-specific layout strategy chosen by table heuristics.
   * The rendering layer uses this to pick the appropriate mesh strategy.
   */
  layoutStrategy: TableLayoutStrategy;
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
  /** XR-specific presentation hint for the rendering layer. */
  xrPresentation: AlertXRPresentation;
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
  /** XR-specific presentation hint. */
  xrPresentation: TooltipXRPresentation;
}

/**
 * XR-specific media sizing strategy.
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
  captions: string[];
  /** XR-specific sizing strategy chosen by media heuristics. */
  sizingStrategy: MediaSizingStrategy;
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
  | XRCardGrid
  | XRCard
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
export interface SpatialScene {
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
   */
  template: LayoutTemplate;
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
  | "landmark:banner→XRBanner"
  | "landmark:contentinfo→XRFooter"
  | "landmark:complementary→XRComplementary"
  | "landmark:search→XRFormPanel"
  | "landmark:form→XRFormPanel"
  | "landmark:region→XRSection"
  | "heading+siblings→XRSection"
  | "paragraph-run→XRArticle"
  | "toc:inferred→XRNavigationBar"
  | "list:uniform→XRCardGrid"
  | "list:ordered→XRCardGrid"
  | "list:generic→XRCardGrid"
  | "listitem→XRCard"
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
  | "feed→XRCardGrid"
  | "alert:assertive→XRAlert:floating-notification"
  | "alert:polite→XRAlert:inline-banner"
  | "tooltip→XRTooltip:contextual-bubble"
  | "video:default→XRMediaPlayer:large-panel"
  | "video:autoplay→XRMediaPlayer:ambient"
  | "audio→XRMediaPlayer:compact-widget"
  | "table:flat-2d→XRTable"
  | "table:curved-2d→XRTable"
  | "table:scrollable→XRTable"
  | "table:cards→XRTable"
  | "generic→XRGenericPanel"
  | "none→(elided)"
  | "presentation→(elided)";

// ============================================================
// Mapper configuration
// ============================================================

export interface MapperConfig {
  /**
   * Viewing distance from the user's head to the primary content panel (metres).
   * Ergonomic range: 0.5 m – 2.0 m.  Default 1.2 m.
   */
  viewingDistance: number;

  /**
   * Horizontal angular spread of the comfort envelope (degrees each side).
   * Beyond this angle content is clipped or placed in the peripheral zone.
   * Ergonomic default: ±30°.
   */
  comfortHalfAngleDeg: number;

  /**
   * Default curve radius for curved content panels (metres).
   * A panel at viewingDistance = 1.2 m with radius = 1.2 m keeps all
   * content within the ±30° comfort envelope at full panel width.
   * Set to 0 to disable curvature.
   */
  panelCurveRadius: number;

  /**
   * Vertical position of the centre of the comfort envelope relative to
   * the user's eye level (metres).  Negative = below eye level.
   * Ergonomic default: -0.1 m (slightly below eye centre).
   */
  eyeLevelOffset: number;

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
   * Minimum number of listitem children for a list to become an XRCardGrid.
   * Below this threshold the list is mapped as an XRSection instead.
   * Default 2.
   */
  minCardGridItems: number;

  /**
   * When true, a Table of Contents XRNavigationBar is synthesised from the
   * heading hierarchy of document-template pages. Only fires when the layout
   * template resolves to "document". Default false.
   */
  generateTOC: boolean;

  /**
   * Maximum number of direct child primitives allowed in a single panel
   * before a diagnostics warning is recorded. Does not split panels —
   * splitting is a renderer concern. Default 50.
   */
  maxPanelChildren: number;

  /**
   * Preferred width of a single card in a card grid (metres).
   * Used together with panelWidth to compute the optimal number of columns.
   * Default 0.36 m.
   */
  cardWidth: number;

  /**
   * Effective width of the primary content panel (metres).
   * Used for spatial card-grid column calculation and table heuristics.
   * Default 1.4 m.
   */
  panelWidth: number;

  /**
   * Hard cap on card-grid columns, overriding the spatial heuristic.
   * Set to 0 to use the spatial heuristic without a cap. Default 4.
   */
  maxCardColumns: number;

  /**
   * When true, the TOC XRNavigationBar is synthesised from heading hierarchy
   * for any layout template, not just "document".
   * Allows explicit opt-in regardless of auto-detected template.
   * Default false — the existing generateTOC flag still controls "document" mode.
   */
  generateTOCAlways: boolean;
}

export const DEFAULT_MAPPER_CONFIG: MapperConfig = {
  viewingDistance: 1.2,
  comfortHalfAngleDeg: 30,
  panelCurveRadius: 1.2,
  eyeLevelOffset: -0.1,
  lowConfidenceThreshold: 0.55,
  elidePresentation: true,
  minCardGridItems: 2,
  generateTOC: true, // always generate TOC navigation bar
  maxPanelChildren: 50,
  cardWidth: 0.36,
  panelWidth: 1.4,
  maxCardColumns: 4,
  generateTOCAlways: true, // fire regardless of layout template
};

// ============================================================
// Ergonomic placement helpers
// ============================================================

/**
 * Compute the default flat placement for the primary content panel.
 * Centred on the viewing axis at the configured distance.
 */
function primaryPanelPlacement(config: MapperConfig): SpatialPlacement {
  return {
    position: { x: 0, y: config.eyeLevelOffset, z: -config.viewingDistance },
    rotation: { x: 0, y: 0, z: 0 },
    preferredSize: { width: 1.6, height: 0.9 },
    curveRadius: config.panelCurveRadius,
    worldLocked: true,
  };
}

/**
 * Compute placement for the navigation arc.
 * Positioned to the left of the primary panel, rotated inward ~30° to
 * remain within the peripheral comfort zone.
 */
function navigationArcPlacement(config: MapperConfig): SpatialPlacement {
  const angleRad = (config.comfortHalfAngleDeg * Math.PI) / 180;
  return {
    position: {
      x: -config.viewingDistance * Math.sin(angleRad),
      y: config.eyeLevelOffset - 0.1,
      z: -config.viewingDistance * Math.cos(angleRad),
    },
    rotation: { x: 0, y: angleRad, z: 0 },
    preferredSize: { width: 0.4, height: 0.9 },
    curveRadius: config.viewingDistance,
    worldLocked: true,
  };
}

/**
 * Compute placement for a complementary (sidebar) panel.
 * Positioned to the right of the primary panel.
 */
function complementaryPlacement(config: MapperConfig): SpatialPlacement {
  const angleRad = (config.comfortHalfAngleDeg * Math.PI) / 180;
  return {
    position: {
      x: config.viewingDistance * Math.sin(angleRad),
      y: config.eyeLevelOffset,
      z: -config.viewingDistance * Math.cos(angleRad),
    },
    rotation: { x: 0, y: -angleRad, z: 0 },
    preferredSize: { width: 0.45, height: 0.8 },
    curveRadius: config.panelCurveRadius,
    worldLocked: true,
  };
}

/**
 * Compute placement for a banner (page header).
 * Positioned above the primary panel.
 */
function bannerPlacement(config: MapperConfig): SpatialPlacement {
  return {
    position: {
      x: 0,
      y: config.eyeLevelOffset + 0.55,
      z: -config.viewingDistance,
    },
    rotation: { x: 0, y: 0, z: 0 },
    preferredSize: { width: 1.6, height: 0.18 },
    curveRadius: config.panelCurveRadius,
    worldLocked: true,
  };
}

/**
 * Compute placement for a footer (contentinfo).
 * Positioned below the primary panel.
 */
function footerPlacement(config: MapperConfig): SpatialPlacement {
  return {
    position: {
      x: 0,
      y: config.eyeLevelOffset - 0.55,
      z: -config.viewingDistance,
    },
    rotation: { x: 0, y: 0, z: 0 },
    preferredSize: { width: 1.6, height: 0.14 },
    curveRadius: config.panelCurveRadius,
    worldLocked: true,
  };
}

/**
 * Compute placement for a dialog overlay.
 * Positioned slightly closer than the primary panel to appear in front.
 */
function dialogPlacement(config: MapperConfig): SpatialPlacement {
  return {
    position: {
      x: 0,
      y: config.eyeLevelOffset,
      z: -(config.viewingDistance - 0.2),
    },
    rotation: { x: 0, y: 0, z: 0 },
    preferredSize: { width: 0.8, height: 0.6 },
    curveRadius: 0,
    worldLocked: false, // dialogs are head-locked so they stay visible
  };
}

/**
 * Default inline placement for child nodes within a parent panel.
 * Position and size are resolved by the rendering layer from parent geometry.
 */
function inlinePlacement(): SpatialPlacement {
  return {
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0 },
    preferredSize: { width: 0, height: 0 }, // resolved by renderer
    curveRadius: 0,
    worldLocked: true,
  };
}

// ============================================================
// State extraction helpers
// ============================================================

function extractState(node: IRNode): XRInteractionState {
  const s = node.state;
  const parseNum = (v: string | null): number | null => {
    if (v === null) return null;
    const n = parseFloat(v);
    return isNaN(n) ? null : n;
  };
  const now = parseNum(s.valueNow);
  const min = parseNum(s.valueMin);
  const max = parseNum(s.valueMax);
  let valueFraction: number | null = null;
  if (now !== null && min !== null && max !== null && max !== min) {
    valueFraction = (now - min) / (max - min);
  }
  return {
    disabled: s.disabled === "true",
    expanded: s.expanded === null ? null : s.expanded === "true",
    checked:
      s.checked === null
        ? null
        : s.checked === "mixed"
          ? null
          : s.checked === "true",
    selected: s.selected === null ? null : s.selected === "true",
    pressed: s.pressed === null ? null : s.pressed === "true",
    required: s.required === "true",
    readonly: s.readonly === "true",
    invalid: s.invalid !== null && s.invalid !== "false",
    busy: s.busy === "true",
    valueFraction,
  };
}

// ============================================================
// Mapping context
// ============================================================

interface MappingContext {
  ir: PageIR;
  config: MapperConfig;
  primitives: Record<string, XRPrimitive>;
  diagnostics: MappingDiagnostics;
}

function registerPrimitive(
  ctx: MappingContext,
  primitive: XRPrimitive,
  rule: MappingRule,
  opts: {
    sourceNodeIds?: string[];
    confidence?: number;
    heuristic?: string | null;
  } = {},
): void {
  ctx.primitives[primitive.id] = primitive;
  ctx.diagnostics.appliedRules[primitive.id] = {
    rule,
    confidence: opts.confidence ?? primitive.confidence,
    sourceNodeIds: opts.sourceNodeIds ?? primitive.sourceIds,
    heuristic: opts.heuristic ?? null,
  };
  ctx.diagnostics.totalPrimitives += 1;
}

/**
 * Record an elided node in diagnostics without registering it as a primitive.
 * Fixes Bug 2: previously registerPrimitive was called for elided nodes,
 * inflating totalPrimitives and polluting appliedRules.
 */
function trackElision(ctx: MappingContext): void {
  ctx.diagnostics.elisionCount += 1;
}

function baseFrom(
  node: IRNode,
  type: XRPrimitiveType,
  placement: SpatialPlacement,
  ir: PageIR,
): XRPrimitiveBase {
  return {
    id: node.id,
    type,
    label: node.label,
    sourceIds: [node.id],
    confidence: node.confidence,
    depth: node.readingDepth,
    placement,
    children: [],
    relations: {
      controls: node.relations.controls,
      labelledBy: node.relations.labelledBy,
      describedBy: node.relations.describedBy,
      details: node.relations.details,
      errorMessage: node.relations.errorMessage,
    },
  };
}

/**
 * Compute content-density metadata for a paragraph node.
 * Word count is estimated from the node label (the IR text content).
 * densityScore is clamped to [0, 1]: 0 at ≤ 10 words, 1 at ≥ 200 words.
 */
function computeDensity(node: IRNode): {
  wordCount: number;
  estimatedReadingTimeSec: number;
  densityScore: number;
} {
  const text = node.label ?? "";
  const wordCount = text.trim() === "" ? 0 : text.trim().split(/\s+/).length;
  const estimatedReadingTimeSec = Math.round((wordCount / 200) * 60);
  const densityScore = Math.min(1, Math.max(0, (wordCount - 10) / (200 - 10)));
  return { wordCount, estimatedReadingTimeSec, densityScore };
}

/**
 * Derive a synthetic confidence score for a primitive produced by merging or
 * grouping multiple IR nodes. Uses the minimum of constituent confidences —
 * conservative: a synthesised section is only as confident as its weakest member.
 */
function deriveConfidence(nodes: IRNode[]): number {
  if (nodes.length === 0) return 0;
  return Math.min(...nodes.map((n) => n.confidence));
}

/**
 * Compute the optimal number of card-grid columns based on the number of cards,
 * the available panel width, and the configured card width.
 *
 * Algorithm:
 *   1. Compute the spatial maximum: floor(panelWidth / cardWidth).
 *   2. Scale by card count: 2 cards → 2 cols; 3 → 3 cols; 12 → 4 cols etc.
 *   3. Clamp to [1, maxCardColumns] (0 = no cap → use spatial max).
 *
 * This replaces the bare sqrt heuristic so layout responds to actual XR
 * panel geometry rather than arbitrary card-count thresholds.
 */
function computeCardGridColumns(
  cardCount: number,
  config: MapperConfig,
): number {
  // Spatial maximum: how many cards fit side-by-side at the configured card width
  const spatialMax = Math.max(
    1,
    Math.floor(config.panelWidth / config.cardWidth),
  );

  // Count-driven preferred columns: small grids stay compact
  let preferred: number;
  if (cardCount <= 2) preferred = cardCount;
  else if (cardCount <= 4) preferred = Math.min(cardCount, 3);
  else preferred = Math.min(cardCount, spatialMax);

  const cap = config.maxCardColumns > 0 ? config.maxCardColumns : spatialMax;
  return Math.min(preferred, cap, spatialMax);
}

/**
 * Choose an XR table layout strategy from row/column dimensions.
 *
 * Heuristics (informed by XR ergonomics literature):
 *   ≤4 cols AND ≤8 rows  → "flat-2d"      (comfortable 2-D panel)
 *   >4 cols OR  >8 rows  → "curved-2d"    (ergonomic curved surface)
 *   >8 cols OR  >20 rows → "scrollable"   (too large to show at once)
 *   wide but few rows    → "cards"        (pivot: each row as a card)
 *
 * The "cards" pivot is attractive when columnCount ≤ 3 AND rowCount > 6
 * — showing each record as a labelled card is easier to scan in XR.
 */
function selectTableLayoutStrategy(
  columnCount: number,
  rowCount: number,
): TableLayoutStrategy {
  if (columnCount > 8 || rowCount > 20) return "scrollable";
  if (columnCount <= 3 && rowCount > 6) return "cards";
  if (columnCount > 4 || rowCount > 8) return "curved-2d";
  return "flat-2d";
}

/**
 * Choose an XR media sizing strategy based on media type and node attributes.
 *
 * Rules:
 *   audio             → "compact-widget"  (audio never needs cinema scale)
 *   video (autoplay)  → "ambient"         (background video)
 *   video (default)   → "large-panel"     (primary viewing surface)
 */
function selectMediaSizingStrategy(node: IRNode): MediaSizingStrategy {
  if (node.role === "audio") return "compact-widget";
  // Detect autoplay via attributes — background/ambient media
  if (node.attributes.autoplay === "true" || node.attributes.autoplay === "") {
    return "ambient";
  }
  return "large-panel";
}

/**
 * Choose an XR presentation style for an alert/status node.
 *
 * Rules:
 *   assertive (role="alert")   → "floating-notification"  (demands attention)
 *   polite    (role="status")  → "inline-banner"          (non-intrusive)
 *
 * Future: could use node.attributes.live to distinguish further.
 */
function selectAlertXRPresentation(
  liveRegion: "assertive" | "polite",
): AlertXRPresentation {
  return liveRegion === "assertive" ? "floating-notification" : "inline-banner";
}

/**
 * Alert-specific placement: ephemeral floating notification in the upper
 * peripheral zone, slightly closer than the primary panel.
 */
function alertFloatingPlacement(config: MapperConfig): SpatialPlacement {
  return {
    position: {
      x: 0.4,
      y: config.eyeLevelOffset + 0.35,
      z: -(config.viewingDistance - 0.15),
    },
    rotation: { x: 0, y: -0.15, z: 0 },
    preferredSize: { width: 0.5, height: 0.12 },
    curveRadius: 0,
    worldLocked: false, // follows the user's head to remain visible
  };
}

/**
 * Tooltip-specific placement: small bubble, rendered close to the viewer.
 * The rendering layer is expected to anchor this near the trigger element.
 */
function tooltipPlacement(config: MapperConfig): SpatialPlacement {
  return {
    position: {
      x: 0,
      y: config.eyeLevelOffset + 0.15,
      z: -(config.viewingDistance - 0.25),
    },
    rotation: { x: 0, y: 0, z: 0 },
    preferredSize: { width: 0.3, height: 0.08 },
    curveRadius: 0,
    worldLocked: false,
  };
}

/**
 * Large video panel placement: cinema-scale curved surface on the forward axis.
 */
function largeMediaPanelPlacement(config: MapperConfig): SpatialPlacement {
  return {
    position: {
      x: 0,
      y: config.eyeLevelOffset,
      z: -(config.viewingDistance + 0.3),
    },
    rotation: { x: 0, y: 0, z: 0 },
    preferredSize: { width: 2.4, height: 1.35 },
    curveRadius: config.viewingDistance + 0.3,
    worldLocked: true,
  };
}

/**
 * Compact audio/short-video widget placement: lower-right peripheral zone.
 */
function compactMediaWidgetPlacement(config: MapperConfig): SpatialPlacement {
  return {
    position: {
      x: 0.55,
      y: config.eyeLevelOffset - 0.35,
      z: -config.viewingDistance,
    },
    rotation: { x: 0, y: -0.2, z: 0 },
    preferredSize: { width: 0.35, height: 0.1 },
    curveRadius: 0,
    worldLocked: true,
  };
}

/**
 * Resolve the human-readable label text for a node by following its
 * labelledBy relation IDs through the IR node dictionary.
 * Returns the concatenated label texts of referenced nodes, or null if
 * no labelledBy relations exist or none can be resolved.
 */
function resolveLabel(node: IRNode, ir: PageIR): string | null {
  if (node.relations.labelledBy.length === 0) return null;
  const parts: string[] = [];
  for (const refId of node.relations.labelledBy) {
    const refNode = ir.nodes[refId];
    if (refNode?.label) parts.push(refNode.label);
  }
  return parts.length > 0 ? parts.join(" ") : null;
}

/**
 * Resolve the description text for a node by following its describedBy
 * relation IDs. Returns concatenated description texts, or null.
 */
function resolveDescription(node: IRNode, ir: PageIR): string | null {
  if (node.relations.describedBy.length === 0) return null;
  const parts: string[] = [];
  for (const refId of node.relations.describedBy) {
    const refNode = ir.nodes[refId];
    if (refNode?.label) parts.push(refNode.label);
  }
  return parts.length > 0 ? parts.join(" ") : null;
}

/**
 * Resolve a controls relation: given a node that aria-controls another,
 * return the label of the controlled element. Used for form field label
 * synthesis and button-label enrichment.
 */
function resolveControlledLabel(node: IRNode, ir: PageIR): string | null {
  if (node.relations.controls.length === 0) return null;
  const refNode = ir.nodes[node.relations.controls[0]];
  return refNode?.label ?? null;
}
/**
 * Each mapped child is reparented with inlinePlacement so that the
 * rendering layer positions it relative to its parent panel.
 */
function resolveChildren(node: IRNode, ctx: MappingContext): XRPrimitive[] {
  const children: XRPrimitive[] = [];
  for (const childId of node.children) {
    const childNode = ctx.ir.nodes[childId];
    if (!childNode) continue;
    const child = mapNode(childNode, ctx);
    if (child) {
      // Reparent to this primitive
      (ctx.primitives[child.id] as XRPrimitiveBase).placement =
        inlinePlacement();
      children.push(child);
    }
  }
  return children;
}

// ============================================================
// Mapping rules
// ============================================================

/**
 * Rule: main landmark → XRContentPanel
 *
 * The main landmark becomes the primary content surface in the XR scene.
 * It is placed on the forward viewing axis at the configured viewing distance.
 *
 * mapMain uses resolveChildren (not inferSectionGroups) because main's direct
 * children are already-structured landmark nodes (toc, section-0, nav, aside…).
 * Heading-based section grouping runs inside mapSection, where the raw content
 * siblings actually live.
 */
function mapMain(node: IRNode, ctx: MappingContext): XRContentPanel {
  const children = resolveChildren(node, ctx);
  warnPanelOverflow(node.id, children, ctx);
  const primitive: XRContentPanel = {
    ...baseFrom(
      node,
      "XRContentPanel",
      primaryPanelPlacement(ctx.config),
      ctx.ir,
    ),
    type: "XRContentPanel",
    flowDirection: "column",
    children,
  };
  registerPrimitive(ctx, primitive, "landmark:main→XRContentPanel");
  return primitive;
}

/**
 * Rule: navigation landmark / inferred link-run → XRNavigationBar
 *
 * Navigation landmarks become an arc-shaped navigation bar anchored to the
 * left of the comfort envelope. Link children become XRLink items.
 */
function mapNavigation(
  node: IRNode,
  ctx: MappingContext,
): XRNavigationBar | null {
  const linkChildren = node.children
    .map((id) => ctx.ir.nodes[id])
    .filter((n): n is IRNode => !!n && n.role === "link")
    .map((n) => mapLink(n, ctx));

  // Don't emit an empty navigation bar — the structural "toc" shell node
  // has no link children and would waste a child slot in XRContentPanel.
  // The synthesised TOC (from synthesiseTOC) handles heading navigation.
  if (linkChildren.length === 0) return null;

  const primitive: XRNavigationBar = {
    ...baseFrom(
      node,
      "XRNavigationBar",
      navigationArcPlacement(ctx.config),
      ctx.ir,
    ),
    type: "XRNavigationBar",
    items: linkChildren,
    children: linkChildren,
  };
  registerPrimitive(ctx, primitive, "landmark:navigation→XRNavigationBar");
  return primitive;
}

/**
 * Rule: banner landmark → XRBanner
 *
 * The page header is placed above the primary content panel.
 */
function mapBanner(node: IRNode, ctx: MappingContext): XRBanner {
  const primitive: XRBanner = {
    ...baseFrom(node, "XRBanner", bannerPlacement(ctx.config), ctx.ir),
    type: "XRBanner",
    children: resolveChildren(node, ctx),
  };
  registerPrimitive(ctx, primitive, "landmark:banner→XRBanner");
  return primitive;
}

/**
 * Rule: contentinfo landmark → XRFooter
 */
function mapFooter(node: IRNode, ctx: MappingContext): XRFooter {
  const primitive: XRFooter = {
    ...baseFrom(node, "XRFooter", footerPlacement(ctx.config), ctx.ir),
    type: "XRFooter",
    children: resolveChildren(node, ctx),
  };
  registerPrimitive(ctx, primitive, "landmark:contentinfo→XRFooter");
  return primitive;
}

/**
 * Rule: complementary landmark → XRComplementary
 *
 * Sidebar content is placed to the right of the primary panel.
 */
function mapComplementary(node: IRNode, ctx: MappingContext): XRComplementary {
  const primitive: XRComplementary = {
    ...baseFrom(
      node,
      "XRComplementary",
      complementaryPlacement(ctx.config),
      ctx.ir,
    ),
    type: "XRComplementary",
    children: resolveChildren(node, ctx),
  };
  registerPrimitive(ctx, primitive, "landmark:complementary→XRComplementary");
  return primitive;
}

/**
 * Rule: form / search landmark → XRFormPanel
 *
 * Form landmarks produce a self-contained form panel. Input children are
 * resolved as XRFormField or XRSearchBox primitives.
 */
function mapFormPanel(
  node: IRNode,
  ctx: MappingContext,
  rule: MappingRule = "landmark:form→XRFormPanel",
): XRFormPanel {
  const primitive: XRFormPanel = {
    ...baseFrom(node, "XRFormPanel", inlinePlacement(), ctx.ir),
    type: "XRFormPanel",
    children: resolveChildren(node, ctx),
  };
  registerPrimitive(ctx, primitive, rule);
  return primitive;
}

/**
 * Rule: region / heading-inferred section → XRSection
 *
 * A section is a bounded region within a content panel. When the first
 * child is a heading, its text is used as the section title.
 *
 * Uses inferSectionGroups so that flat heading+sibling sequences inside
 * section-0 (the parser's root content container) are grouped into nested
 * XRSections. This is the correct site for the pre-pass because section-0's
 * children are the raw content nodes (headings, paragraphs, etc.).
 */
function mapSection(
  node: IRNode,
  ctx: MappingContext,
  rule: MappingRule = "landmark:region→XRSection",
): XRSection {
  // Extract heading title from first child if it is a heading.
  // Do NOT use node.label as a title if it looks like an auto-generated ID
  // (contains hyphens followed by digits, e.g. "section-0", "root-section-2").
  const looksLikeId = (s: string | null): boolean =>
    !s || /^[\w]+-\d+$/.test(s.trim()) || s.trim().length === 0;
  let title: string | null = looksLikeId(node.label) ? null : node.label;
  let titleLevel: number | null = null;
  const firstChildId = node.children[0];
  if (firstChildId) {
    const firstChild = ctx.ir.nodes[firstChildId];
    if (firstChild?.role === "heading") {
      title = firstChild.label ?? title;
      titleLevel = firstChild.level;
    }
  }

  const children = inferSectionGroups(node, ctx);
  warnPanelOverflow(node.id, children, ctx);
  const primitive: XRSection = {
    ...baseFrom(node, "XRSection", inlinePlacement(), ctx.ir),
    type: "XRSection",
    title,
    titleLevel,
    flowDirection: "column",
    children,
  };
  registerPrimitive(ctx, primitive, rule);
  return primitive;
}

/**
 * Rule: article / paragraph-run group → XRArticle
 */
function mapArticle(node: IRNode, ctx: MappingContext): XRArticle {
  const primitive: XRArticle = {
    ...baseFrom(node, "XRArticle", inlinePlacement(), ctx.ir),
    type: "XRArticle",
    flowDirection: "column",
    children: resolveChildren(node, ctx),
  };
  registerPrimitive(ctx, primitive, "article→XRArticle");
  return primitive;
}

/**
 * Rule: list / feed → XRCardGrid
 *
 * A list becomes XRCardGrid only when:
 *   1. It has at least minCardGridItems children.
 *   2. Its listitems are structurally uniform (same set of child roles in each item).
 *
 * Uniformity check prevents nav-link lists and heterogeneous lists from
 * becoming XRCardGrid. When either condition fails, falls back to XRSection.
 *
 * Columns derived from child count via sqrt heuristic, capped at 4.
 */
function mapList(
  node: IRNode,
  ctx: MappingContext,
  rule: MappingRule = "list:generic→XRCardGrid",
): XRCardGrid | XRSection {
  const childNodes = node.children
    .map((id) => ctx.ir.nodes[id])
    .filter((n): n is IRNode => !!n);

  if (childNodes.length < ctx.config.minCardGridItems) {
    return mapSection(node, ctx, "landmark:region→XRSection");
  }

  // Structural uniformity: compute a "shape signature" for each listitem
  // (sorted child-role fingerprint). All items must share the same signature.
  const itemNodes = childNodes.filter(
    (n) => n.role === "listitem" && Array.isArray(n.children),
  );
  const isUniform =
    itemNodes.length >= ctx.config.minCardGridItems &&
    (() => {
      const sig = (n: IRNode): string =>
        (n.children ?? [])
          .map((id) => ctx.ir.nodes[id]?.role ?? "")
          .sort()
          .join("|");
      const first = itemNodes[0] ? sig(itemNodes[0]) : "";
      return first !== "" && itemNodes.every((n) => sig(n) === first);
    })();

  if (!isUniform) {
    // Heterogeneous list — treat as a section, not a card grid
    return mapSection(node, ctx, "landmark:region→XRSection");
  }

  const columns = computeCardGridColumns(childNodes.length, ctx.config);

  const effectiveRule: MappingRule =
    node.attributes.listType === "ordered"
      ? "list:ordered→XRCardGrid"
      : "list:uniform→XRCardGrid";

  const primitive: XRCardGrid = {
    ...baseFrom(node, "XRCardGrid", inlinePlacement(), ctx.ir),
    type: "XRCardGrid",
    listType: node.attributes.listType ?? null,
    columns,
    children: resolveChildren(node, ctx),
  };
  registerPrimitive(ctx, primitive, effectiveRule, {
    heuristic: "uniform-list",
  });
  return primitive;
}

/**
 * Rule: listitem → XRCard
 */
function mapListItem(node: IRNode, ctx: MappingContext): XRCard {
  const primitive: XRCard = {
    ...baseFrom(node, "XRCard", inlinePlacement(), ctx.ir),
    type: "XRCard",
    children: resolveChildren(node, ctx),
  };
  registerPrimitive(ctx, primitive, "listitem→XRCard");
  return primitive;
}

/**
 * Rule: heading → XRHeading
 */
function mapHeading(node: IRNode, ctx: MappingContext): XRHeading {
  const primitive: XRHeading = {
    ...baseFrom(node, "XRHeading", inlinePlacement(), ctx.ir),
    type: "XRHeading",
    level: node.level ?? 2,
    children: [],
  };
  registerPrimitive(ctx, primitive, "heading→XRHeading");
  return primitive;
}

/**
 * Rule: paragraph → XRParagraph
 */
function mapParagraph(node: IRNode, ctx: MappingContext): XRParagraph {
  const { wordCount, estimatedReadingTimeSec, densityScore } =
    computeDensity(node);
  const primitive: XRParagraph = {
    ...baseFrom(node, "XRParagraph", inlinePlacement(), ctx.ir),
    type: "XRParagraph",
    wordCount,
    estimatedReadingTimeSec,
    densityScore,
    children: [],
  };
  registerPrimitive(ctx, primitive, "paragraph→XRParagraph");
  return primitive;
}

/**
 * Rule: img → XRImage
 */
function mapImg(node: IRNode, ctx: MappingContext): XRImage {
  const primitive: XRImage = {
    ...baseFrom(node, "XRImage", inlinePlacement(), ctx.ir),
    type: "XRImage",
    src: node.attributes.src,
    alt: node.attributes.alt ?? node.label,
    children: [],
  };
  registerPrimitive(ctx, primitive, "img→XRImage");
  return primitive;
}

/**
 * Rule: figure → XRImage (image-only) or XRFigure (mixed content)
 *
 * A figure that contains exactly one img child and an optional caption
 * is simplified to XRImage (the caption text becomes the alt).
 * A figure with richer children (code, table, etc.) becomes XRFigure.
 */
function mapFigure(node: IRNode, ctx: MappingContext): XRImage | XRFigure {
  const childNodes = node.children
    .map((id) => ctx.ir.nodes[id])
    .filter((n): n is IRNode => !!n);
  const imgChildren = childNodes.filter((n) => n.role === "img");
  const captionChildren = childNodes.filter((n) => n.role === "caption");
  const otherChildren = childNodes.filter(
    (n) => n.role !== "img" && n.role !== "caption",
  );

  if (imgChildren.length === 1 && otherChildren.length === 0) {
    const imgNode = imgChildren[0];
    const captionText = captionChildren[0]?.label ?? null;
    const primitive: XRImage = {
      ...baseFrom(node, "XRImage", inlinePlacement(), ctx.ir),
      id: node.id,
      type: "XRImage",
      label: captionText ?? node.label,
      sourceIds: [node.id, imgNode.id],
      src: imgNode.attributes.src,
      alt: imgNode.attributes.alt ?? captionText ?? node.label,
      children: [],
    };
    registerPrimitive(ctx, primitive, "figure:image-only→XRImage");
    ctx.diagnostics.mergedCount += 1;
    return primitive;
  }

  const captionId = captionChildren[0]?.id ?? null;
  const primitive: XRFigure = {
    ...baseFrom(node, "XRFigure", inlinePlacement(), ctx.ir),
    type: "XRFigure",
    captionId,
    children: resolveChildren(node, ctx),
  };
  registerPrimitive(ctx, primitive, "figure:mixed→XRFigure");
  return primitive;
}

/**
 * Rule: table → XRTable
 *
 * Walks the row/group structure to compute rowCount and columnCount, and
 * threads zero-based rowIndex / columnIndex into every XRTableCell so that
 * XR renderers can position cells without re-walking the tree.
 * columnIndex accounts for preceding colspan values in the same row.
 */
function mapTable(node: IRNode, ctx: MappingContext): XRTable {
  const rowNodes = node.children
    .map((id) => ctx.ir.nodes[id])
    .filter(
      (n): n is IRNode => !!n && (n.role === "row" || n.role === "group"),
    );

  // Flatten all row IRNodes in document order (unwrap thead/tbody/tfoot groups)
  const flatRows: IRNode[] = [];
  for (const rowNode of rowNodes) {
    if (rowNode.role === "row") {
      flatRows.push(rowNode);
    } else {
      for (const subId of rowNode.children) {
        const sub = ctx.ir.nodes[subId];
        if (sub?.role === "row") flatRows.push(sub);
      }
    }
  }

  const rowCount = flatRows.length;
  let columnCount = 0;
  for (const r of flatRows) {
    columnCount = Math.max(columnCount, r.children.length);
  }

  // Map children — but override cell mapping to inject coordinates.
  // We map each row node manually so we can pass the rowIndex.
  const children: XRPrimitive[] = [];
  let rowIndex = 0;
  for (const childId of node.children) {
    const childNode = ctx.ir.nodes[childId];
    if (!childNode) continue;
    if (childNode.role === "row") {
      const row = mapTableRowIndexed(childNode, rowIndex, ctx);
      if (row) {
        children.push(row);
        rowIndex += 1;
      }
    } else if (childNode.role === "group") {
      // thead/tbody/tfoot group — map the group but index rows within it
      const groupChildren: XRPrimitive[] = [];
      for (const subId of childNode.children) {
        const sub = ctx.ir.nodes[subId];
        if (!sub) continue;
        if (sub.role === "row") {
          const row = mapTableRowIndexed(sub, rowIndex, ctx);
          if (row) {
            groupChildren.push(row);
            rowIndex += 1;
          }
        } else {
          const p = mapNode(sub, ctx);
          if (p) groupChildren.push(p);
        }
      }
      // Emit the group as a generic section wrapper
      const groupPrimitive: XRSection = {
        ...baseFrom(childNode, "XRSection", inlinePlacement(), ctx.ir),
        type: "XRSection",
        title: null,
        titleLevel: null,
        flowDirection: "column",
        children: groupChildren,
      };
      registerPrimitive(ctx, groupPrimitive, "group:generic→XRSection");
      children.push(groupPrimitive);
    } else {
      const p = mapNode(childNode, ctx);
      if (p) children.push(p);
    }
  }

  const primitive: XRTable = {
    ...baseFrom(node, "XRTable", inlinePlacement(), ctx.ir),
    type: "XRTable",
    columnCount,
    rowCount,
    layoutStrategy: selectTableLayoutStrategy(columnCount, rowCount),
    children,
  };
  registerPrimitive(ctx, primitive, "table→XRTable");
  return primitive;
}

function mapTableRowIndexed(
  node: IRNode,
  rowIndex: number,
  ctx: MappingContext,
): XRTableRow {
  const isHeader = node.children.some((id) => {
    const child = ctx.ir.nodes[id];
    return child?.role === "columnheader" || child?.role === "rowheader";
  });

  // Map cells with column-index tracking (accounts for colspan)
  const cellChildren: XRPrimitive[] = [];
  let colIndex = 0;
  for (const cellId of node.children) {
    const cellNode = ctx.ir.nodes[cellId];
    if (!cellNode) continue;
    if (
      cellNode.role === "cell" ||
      cellNode.role === "columnheader" ||
      cellNode.role === "rowheader"
    ) {
      const cell = mapTableCellIndexed(cellNode, rowIndex, colIndex, ctx);
      cellChildren.push(cell);
      colIndex += cell.colspan; // advance by colspan to get next column position
    } else {
      const p = mapNode(cellNode, ctx);
      if (p) {
        cellChildren.push(p);
        colIndex += 1;
      }
    }
  }

  const primitive: XRTableRow = {
    ...baseFrom(node, "XRTableRow", inlinePlacement(), ctx.ir),
    type: "XRTableRow",
    isHeader,
    children: cellChildren,
  };
  registerPrimitive(ctx, primitive, "row→XRTableRow");
  return primitive;
}

function mapTableCellIndexed(
  node: IRNode,
  rowIndex: number,
  columnIndex: number,
  ctx: MappingContext,
): XRTableCell {
  const isHeader = node.role === "columnheader" || node.role === "rowheader";
  const rule: MappingRule =
    node.role === "columnheader"
      ? "columnheader→XRTableCell"
      : node.role === "rowheader"
        ? "rowheader→XRTableCell"
        : "cell→XRTableCell";
  const colspan = parseInt(node.attributes.colspan ?? "1", 10) || 1;
  const rowspan = parseInt(node.attributes.rowspan ?? "1", 10) || 1;
  const primitive: XRTableCell = {
    ...baseFrom(node, "XRTableCell", inlinePlacement(), ctx.ir),
    type: "XRTableCell",
    isHeader,
    colspan,
    rowspan,
    rowIndex,
    columnIndex,
    headers: node.relations.headers,
    children: resolveChildren(node, ctx),
  };
  registerPrimitive(ctx, primitive, rule);
  return primitive;
}

function mapTableRow(node: IRNode, ctx: MappingContext): XRTableRow {
  // Fallback: when mapTableRow is called outside mapTable (e.g. via mapNode
  // dispatch for orphaned rows), use 0 for both indices.
  return mapTableRowIndexed(node, 0, ctx);
}

function mapTableCell(node: IRNode, ctx: MappingContext): XRTableCell {
  return mapTableCellIndexed(node, 0, 0, ctx);
}

/**
 * Rule: button → XRButton
 *
 * Resolves aria-labelledby for buttons whose visible label differs from their
 * accessible name. Also checks aria-controls so the XR layer can link the
 * button to the panel it controls (e.g. expand/collapse).
 */
function mapButton(node: IRNode, ctx: MappingContext): XRButton {
  const resolvedLabel = resolveLabel(node, ctx.ir) ?? node.label;
  const primitive: XRButton = {
    ...baseFrom(node, "XRButton", inlinePlacement(), ctx.ir),
    type: "XRButton",
    label: resolvedLabel,
    state: extractState(node),
    hasPopup: node.attributes.haspopup,
    children: [],
  };
  registerPrimitive(ctx, primitive, "button→XRButton");
  return primitive;
}

/**
 * Rule: link → XRLink
 */
function mapLink(node: IRNode, ctx: MappingContext): XRLink {
  const primitive: XRLink = {
    ...baseFrom(node, "XRLink", inlinePlacement(), ctx.ir),
    type: "XRLink",
    href: node.attributes.href,
    isCurrent: node.state.current !== null && node.state.current !== "false",
    children: [],
  };
  registerPrimitive(ctx, primitive, "link→XRLink");
  return primitive;
}

/**
 * Rule: textbox / spinbutton → XRFormField
 *
 * Resolves both labelledBy and describedBy ARIA relations so the XR rendering
 * layer can display a fully-labelled field without re-walking the IR.
 */
function mapTextbox(node: IRNode, ctx: MappingContext): XRFormField {
  const rule: MappingRule =
    node.role === "spinbutton"
      ? "spinbutton→XRFormField"
      : "textbox→XRFormField";
  const state = extractState(node);
  // Prefer resolvedLabel from aria-labelledby; fall back to node.label
  const resolvedLabel = resolveLabel(node, ctx.ir) ?? node.label;
  const primitive: XRFormField = {
    ...baseFrom(node, "XRFormField", inlinePlacement(), ctx.ir),
    type: "XRFormField",
    label: resolvedLabel,
    controlType: node.role === "spinbutton" ? "spinbutton" : "textbox",
    state,
    placeholder: node.attributes.placeholder,
    valueMin: parseFloat(node.attributes.valueMin ?? "") || null,
    valueMax: parseFloat(node.attributes.valueMax ?? "") || null,
    valueFraction: state.valueFraction,
    resolvedLabel,
    children: [],
  };
  registerPrimitive(ctx, primitive, rule);
  return primitive;
}

/**
 * Rule: searchbox → XRSearchBox
 *
 * Resolves aria-labelledby so the XR rendering layer has a usable label
 * without traversing the IR. Falls back to node.label if unresolvable.
 */
function mapSearchBox(node: IRNode, ctx: MappingContext): XRSearchBox {
  const resolvedLabel = resolveLabel(node, ctx.ir) ?? node.label;
  const primitive: XRSearchBox = {
    ...baseFrom(node, "XRSearchBox", inlinePlacement(), ctx.ir),
    type: "XRSearchBox",
    label: resolvedLabel,
    state: extractState(node),
    placeholder: node.attributes.placeholder,
    children: [],
  };
  registerPrimitive(ctx, primitive, "searchbox→XRSearchBox");
  return primitive;
}

/**
 * Rule: checkbox / radio / switch → XRToggle
 */
function mapToggle(node: IRNode, ctx: MappingContext): XRToggle {
  const toggleType =
    node.role === "switch"
      ? "switch"
      : node.role === "radio"
        ? "radio"
        : "checkbox";
  const rule: MappingRule =
    node.role === "switch"
      ? "switch→XRToggle"
      : node.role === "radio"
        ? "radio→XRToggle"
        : "checkbox→XRToggle";
  const primitive: XRToggle = {
    ...baseFrom(node, "XRToggle", inlinePlacement(), ctx.ir),
    type: "XRToggle",
    toggleType,
    state: extractState(node),
    children: [],
  };
  registerPrimitive(ctx, primitive, rule);
  return primitive;
}

/**
 * Rule: combobox → XRComboBox
 */
function mapComboBox(node: IRNode, ctx: MappingContext): XRComboBox {
  const primitive: XRComboBox = {
    ...baseFrom(node, "XRComboBox", inlinePlacement(), ctx.ir),
    type: "XRComboBox",
    state: extractState(node),
    children: resolveChildren(node, ctx),
  };
  registerPrimitive(ctx, primitive, "combobox→XRComboBox");
  return primitive;
}

/**
 * Rule: slider → XRSlider
 */
function mapSlider(node: IRNode, ctx: MappingContext): XRSlider {
  const state = extractState(node);
  const primitive: XRSlider = {
    ...baseFrom(node, "XRSlider", inlinePlacement(), ctx.ir),
    type: "XRSlider",
    state,
    valueMin: parseFloat(node.attributes.valueMin ?? "") || null,
    valueMax: parseFloat(node.attributes.valueMax ?? "") || null,
    valueFraction: state.valueFraction,
    children: [],
  };
  registerPrimitive(ctx, primitive, "slider→XRSlider");
  return primitive;
}

/**
 * Rule: dialog → XRDialog
 *
 * Modal dialogs are head-locked (worldLocked: false in dialogPlacement) so they
 * remain visible regardless of where the user turns their head. The rendering
 * layer should dim the world background and restrict interaction to the dialog.
 */
function mapDialog(node: IRNode, ctx: MappingContext): XRDialog {
  // Enrich dialog label from aria-labelledby if available
  const resolvedLabel = resolveLabel(node, ctx.ir) ?? node.label;
  const primitive: XRDialog = {
    ...baseFrom(node, "XRDialog", dialogPlacement(ctx.config), ctx.ir),
    type: "XRDialog",
    label: resolvedLabel,
    isModal: node.state.modal === "true",
    state: extractState(node),
    children: resolveChildren(node, ctx),
  };
  registerPrimitive(ctx, primitive, "dialog→XRDialog");
  return primitive;
}

/**
 * Rule: alert / status → XRAlert
 *
 * alert (assertive) → floating-notification (head-locked, peripheral zone)
 * status (polite)   → inline-banner (world-locked, within content flow)
 *
 * The live property and xrPresentation distinguish them for the rendering layer.
 */
function mapAlert(
  node: IRNode,
  ctx: MappingContext,
  rule: MappingRule = "alert→XRAlert",
): XRAlert {
  const liveRegion: "assertive" | "polite" =
    node.role === "alert" ? "assertive" : "polite";
  const xrPresentation = selectAlertXRPresentation(liveRegion);
  // Assertive alerts float in the peripheral zone; polite ones stay inline
  const placement =
    xrPresentation === "floating-notification"
      ? alertFloatingPlacement(ctx.config)
      : inlinePlacement();
  const primitive: XRAlert = {
    ...baseFrom(node, "XRAlert", placement, ctx.ir),
    type: "XRAlert",
    liveRegion,
    xrPresentation,
    children: resolveChildren(node, ctx),
  };
  registerPrimitive(ctx, primitive, rule);
  return primitive;
}

/**
 * Rule: tooltip → XRTooltip
 *
 * Tooltips are rendered as contextual bubbles anchored near their trigger.
 * Head-locked so they remain visible when the user gazes at the trigger element.
 */
function mapTooltip(node: IRNode, ctx: MappingContext): XRTooltip {
  // Enrich label from describedBy if the tooltip's own label is empty
  const resolvedDesc = resolveDescription(node, ctx.ir);
  const label = node.label ?? resolvedDesc;
  const primitive: XRTooltip = {
    ...baseFrom(node, "XRTooltip", tooltipPlacement(ctx.config), ctx.ir),
    type: "XRTooltip",
    label,
    xrPresentation: "contextual-bubble",
    children: [],
  };
  registerPrimitive(ctx, primitive, "tooltip→XRTooltip");
  return primitive;
}

/**
 * Rule: video / audio → XRMediaPlayer
 *
 * Sizing strategy:
 *   video (default)  → "large-panel"    (cinema-scale curved surface)
 *   video (autoplay) → "ambient"        (background media, outside comfort zone)
 *   audio            → "compact-widget" (lower-right peripheral widget)
 */
function mapMedia(node: IRNode, ctx: MappingContext): XRMediaPlayer {
  const mediaType = node.role === "audio" ? "audio" : "video";
  const rule: MappingRule =
    mediaType === "audio" ? "audio→XRMediaPlayer" : "video→XRMediaPlayer";
  const sizingStrategy = selectMediaSizingStrategy(node);
  const placement =
    sizingStrategy === "large-panel"
      ? largeMediaPanelPlacement(ctx.config)
      : sizingStrategy === "compact-widget"
        ? compactMediaWidgetPlacement(ctx.config)
        : inlinePlacement(); // ambient — renderer positions it
  const primitive: XRMediaPlayer = {
    ...baseFrom(node, "XRMediaPlayer", placement, ctx.ir),
    type: "XRMediaPlayer",
    mediaType,
    src: node.attributes.src,
    captions: node.attributes.captions,
    sizingStrategy,
    children: [],
  };
  registerPrimitive(ctx, primitive, rule);
  return primitive;
}

/** Rule: code / blockquote / separator / progressbar */
function mapCodeBlock(node: IRNode, ctx: MappingContext): XRCodeBlock {
  const primitive: XRCodeBlock = {
    ...baseFrom(node, "XRCodeBlock", inlinePlacement(), ctx.ir),
    type: "XRCodeBlock",
    children: [],
  };
  registerPrimitive(ctx, primitive, "code→XRCodeBlock");
  return primitive;
}

function mapBlockQuote(node: IRNode, ctx: MappingContext): XRBlockQuote {
  const primitive: XRBlockQuote = {
    ...baseFrom(node, "XRBlockQuote", inlinePlacement(), ctx.ir),
    type: "XRBlockQuote",
    children: resolveChildren(node, ctx),
  };
  registerPrimitive(ctx, primitive, "blockquote→XRBlockQuote");
  return primitive;
}

function mapSeparator(node: IRNode, ctx: MappingContext): XRSeparator {
  const primitive: XRSeparator = {
    ...baseFrom(node, "XRSeparator", inlinePlacement(), ctx.ir),
    type: "XRSeparator",
    orientation:
      node.attributes.orientation === "vertical" ? "vertical" : "horizontal",
    children: [],
  };
  registerPrimitive(ctx, primitive, "separator→XRSeparator");
  return primitive;
}

function mapProgressBar(node: IRNode, ctx: MappingContext): XRProgressBar {
  const state = extractState(node);
  const primitive: XRProgressBar = {
    ...baseFrom(node, "XRProgressBar", inlinePlacement(), ctx.ir),
    type: "XRProgressBar",
    valueFraction: state.valueFraction,
    children: [],
  };
  registerPrimitive(ctx, primitive, "progressbar→XRProgressBar");
  return primitive;
}

/** Rule: tablist → XRTabGroup */
function mapTabGroup(node: IRNode, ctx: MappingContext): XRTabGroup {
  const primitive: XRTabGroup = {
    ...baseFrom(node, "XRTabGroup", inlinePlacement(), ctx.ir),
    type: "XRTabGroup",
    orientation:
      node.attributes.orientation === "vertical" ? "vertical" : "horizontal",
    children: resolveChildren(node, ctx),
  };
  registerPrimitive(ctx, primitive, "tablist→XRTabGroup");
  return primitive;
}

function mapTab(node: IRNode, ctx: MappingContext): XRTab {
  // Resolve the tab's controlled panel via aria-controls
  const panelId = node.relations.controls[0] ?? null;
  const primitive: XRTab = {
    ...baseFrom(node, "XRTab", inlinePlacement(), ctx.ir),
    type: "XRTab",
    state: extractState(node),
    panelId,
    children: [],
  };
  registerPrimitive(ctx, primitive, "tab→XRTab");
  return primitive;
}

function mapTabPanel(node: IRNode, ctx: MappingContext): XRTabPanel {
  const primitive: XRTabPanel = {
    ...baseFrom(node, "XRTabPanel", inlinePlacement(), ctx.ir),
    type: "XRTabPanel",
    children: resolveChildren(node, ctx),
  };
  registerPrimitive(ctx, primitive, "tabpanel→XRTabPanel");
  return primitive;
}

function mapMenu(node: IRNode, ctx: MappingContext): XRMenu {
  const rule: MappingRule =
    node.role === "menubar" ? "menubar→XRMenu" : "menu→XRMenu";
  const primitive: XRMenu = {
    ...baseFrom(node, "XRMenu", inlinePlacement(), ctx.ir),
    type: "XRMenu",
    menuType: node.role === "menubar" ? "menubar" : "menu",
    children: resolveChildren(node, ctx),
  };
  registerPrimitive(ctx, primitive, rule);
  return primitive;
}

function mapMenuItem(node: IRNode, ctx: MappingContext): XRMenuItem {
  const rule: MappingRule =
    node.role === "menuitemcheckbox"
      ? "menuitemcheckbox→XRMenuItem"
      : node.role === "menuitemradio"
        ? "menuitemradio→XRMenuItem"
        : "menuitem→XRMenuItem";
  const primitive: XRMenuItem = {
    ...baseFrom(node, "XRMenuItem", inlinePlacement(), ctx.ir),
    type: "XRMenuItem",
    itemType:
      node.role === "menuitemcheckbox"
        ? "menuitemcheckbox"
        : node.role === "menuitemradio"
          ? "menuitemradio"
          : "menuitem",
    state: extractState(node),
    children: [],
  };
  registerPrimitive(ctx, primitive, rule);
  return primitive;
}

function mapTree(node: IRNode, ctx: MappingContext): XRTree {
  const primitive: XRTree = {
    ...baseFrom(node, "XRTree", inlinePlacement(), ctx.ir),
    type: "XRTree",
    multiselectable: node.state.multiselectable === "true",
    children: resolveChildren(node, ctx),
  };
  registerPrimitive(ctx, primitive, "tree→XRTree");
  return primitive;
}

function mapTreeItem(node: IRNode, ctx: MappingContext): XRTreeItem {
  const primitive: XRTreeItem = {
    ...baseFrom(node, "XRTreeItem", inlinePlacement(), ctx.ir),
    type: "XRTreeItem",
    state: extractState(node),
    children: resolveChildren(node, ctx),
  };
  registerPrimitive(ctx, primitive, "treeitem→XRTreeItem");
  return primitive;
}

/** Rule: group → XRFormField (fieldset) or XRSection (generic group) */
function mapGroup(node: IRNode, ctx: MappingContext): XRFormField | XRSection {
  // A group that contains form controls is a fieldset-equivalent → XRFormField
  const formControlRoles = [
    "textbox",
    "searchbox",
    "checkbox",
    "radio",
    "combobox",
    "slider",
    "spinbutton",
    "switch",
  ] as const;
  type FormControlRole = (typeof formControlRoles)[number];

  const firstControlRole = node.children
    .map((id) => ctx.ir.nodes[id])
    .filter((n): n is IRNode => !!n)
    .find((n) => formControlRoles.includes(n.role as FormControlRole))?.role as
    | FormControlRole
    | undefined;

  if (firstControlRole !== undefined) {
    // Map the dominant control role to an XRFormField controlType.
    // Fieldsets wrapping radio buttons get "radio"; checkboxes get "checkbox";
    // everything else defaults to "fieldset" to signal the grouping nature.
    const controlType: XRFormField["controlType"] =
      firstControlRole === "radio"
        ? "radio"
        : firstControlRole === "checkbox"
          ? "checkbox"
          : firstControlRole === "switch"
            ? "switch"
            : "fieldset";

    const primitive: XRFormField = {
      ...baseFrom(node, "XRFormField", inlinePlacement(), ctx.ir),
      type: "XRFormField",
      label: resolveLabel(node, ctx.ir) ?? node.label,
      controlType,
      state: extractState(node),
      placeholder: null,
      valueMin: null,
      valueMax: null,
      valueFraction: null,
      resolvedLabel: resolveLabel(node, ctx.ir),
      children: resolveChildren(node, ctx),
    };
    registerPrimitive(ctx, primitive, "group:fieldset→XRFormField");
    return primitive;
  }

  return mapSection(node, ctx, "group:generic→XRSection");
}

/**
 * Fallback rule: any unmapped role → XRGenericPanel
 *
 * Content is never silently dropped. The rendering layer may choose to
 * display generic panels as plain text panels.
 */
function mapGeneric(node: IRNode, ctx: MappingContext): XRGenericPanel {
  const primitive: XRGenericPanel = {
    ...baseFrom(node, "XRGenericPanel", inlinePlacement(), ctx.ir),
    type: "XRGenericPanel",
    irRole: node.role,
    children: resolveChildren(node, ctx),
  };

  if (!ctx.diagnostics.unmappedRoles.includes(node.role)) {
    ctx.diagnostics.unmappedRoles.push(node.role);
  }
  ctx.diagnostics.unmappedCount += 1;

  registerPrimitive(ctx, primitive, "generic→XRGenericPanel");
  return primitive;
}

// ============================================================
// Sibling pre-passes: section inference, paragraph-run merging, TOC
// ============================================================

/**
 * Walk the direct children of `node` and group them into heading-based
 * XRSections before individual node mapping.
 *
 * Algorithm (single pass):
 *   - When a heading node is encountered, flush the current accumulator as an
 *     XRSection (or start a new section with this heading).
 *   - Non-heading siblings are accumulated under the current section.
 *   - Content before the first heading (preamble) is emitted directly.
 *   - If no headings exist at all, all children are emitted directly
 *     (same result as resolveChildren, but without a second traversal).
 *
 * This implements the "heading+siblings → XRSection" rule.
 * After grouping, paragraph-run merging is applied within each section.
 *
 * Called from mapSection (not mapMain). mapMain's children are already-
 * structured landmark nodes; the raw content siblings that need grouping
 * live inside section-0, which is mapped via mapSection.
 */
function inferSectionGroups(node: IRNode, ctx: MappingContext): XRPrimitive[] {
  const childIds = node.children;
  const output: XRPrimitive[] = [];

  // Preamble: nodes before the first heading are mapped directly
  let preambleMode = true;

  interface SectionAccumulator {
    headingNode: IRNode;
    siblingIds: string[];
  }
  let current: SectionAccumulator | null = null;

  const flushSection = (acc: SectionAccumulator): void => {
    const allIds = [acc.headingNode.id, ...acc.siblingIds];
    const allNodes = allIds
      .map((id) => ctx.ir.nodes[id])
      .filter((n): n is IRNode => !!n);

    // Synthesise an XRSection from heading + sibling nodes
    const sectionId = `${node.id}__section__${acc.headingNode.id}`;
    const confidence = deriveConfidence(allNodes);

    // Map the heading for the section title
    const headingPrimitive = mapHeading(acc.headingNode, ctx);

    // Map siblings, applying paragraph-run merging within the section
    const siblingPrimitives = mergeParagraphRuns(acc.siblingIds, ctx);

    const sectionChildren = [headingPrimitive, ...siblingPrimitives];
    warnPanelOverflow(sectionId, sectionChildren, ctx);

    const section: XRSection = {
      id: sectionId,
      type: "XRSection",
      label: acc.headingNode.label,
      sourceIds: allIds,
      confidence,
      depth: acc.headingNode.readingDepth,
      placement: inlinePlacement(),
      children: sectionChildren,
      relations: {
        controls: [],
        labelledBy: [],
        describedBy: [],
        details: [],
        errorMessage: [],
      },
      title: acc.headingNode.label,
      titleLevel: acc.headingNode.level ?? null,
      flowDirection: "column",
    };

    registerPrimitive(ctx, section, "heading+siblings→XRSection", {
      sourceNodeIds: allIds,
      confidence,
      heuristic: "heading+siblings",
    });
    ctx.diagnostics.mergedCount += allIds.length - 1;
    output.push(section);
  };

  for (const childId of childIds) {
    const childNode = ctx.ir.nodes[childId];
    if (!childNode) continue;

    if (childNode.role === "heading") {
      preambleMode = false;
      // Flush previous section before starting a new one
      if (current) flushSection(current);
      current = { headingNode: childNode, siblingIds: [] };
    } else if (preambleMode) {
      // Before the first heading — emit directly via mapNode.
      // NOTE: we do NOT call resolveChildren at the end if preambleMode stays
      // true, because these nodes are already being emitted here one-by-one.
      const p = mapNode(childNode, ctx);
      if (p) output.push(p);
    } else if (current) {
      current.siblingIds.push(childId);
    } else {
      const p = mapNode(childNode, ctx);
      if (p) output.push(p);
    }
  }

  if (current) flushSection(current);

  // preambleMode === true means no headings were found; children were already
  // individually mapped in the loop above — return them directly.
  // Do NOT call resolveChildren here: that would double-map every child.
  return output;
}

/**
 * Given a list of sibling node IDs, merge consecutive paragraph (and caption)
 * nodes into a single XRArticle, then map the remainder normally.
 *
 * This collapses:
 *   XRParagraph, XRParagraph, XRParagraph
 * into:
 *   XRArticle { children: [XRParagraph, XRParagraph, XRParagraph] }
 *
 * A run must contain at least 2 paragraphs to be merged. Single paragraphs
 * are emitted directly.
 */
function mergeParagraphRuns(
  siblingIds: string[],
  ctx: MappingContext,
): XRPrimitive[] {
  const output: XRPrimitive[] = [];
  let run: IRNode[] = [];

  const flushRun = (): void => {
    if (run.length === 0) return;
    if (run.length === 1) {
      const p = mapNode(run[0], ctx);
      if (p) output.push(p);
      run = [];
      return;
    }
    // Merge into XRArticle
    const articleId = `para_run__${run[0].id}`;
    const confidence = deriveConfidence(run);
    const paragraphChildren = run.map((n) => mapParagraph(n, ctx));
    const article: XRArticle = {
      id: articleId,
      type: "XRArticle",
      label: null,
      sourceIds: run.map((n) => n.id),
      confidence,
      depth: run[0].readingDepth,
      placement: inlinePlacement(),
      children: paragraphChildren,
      relations: {
        controls: [],
        labelledBy: [],
        describedBy: [],
        details: [],
        errorMessage: [],
      },
      flowDirection: "column",
    };
    registerPrimitive(ctx, article, "paragraph-run→XRArticle", {
      sourceNodeIds: run.map((n) => n.id),
      confidence,
      heuristic: "paragraph-run",
    });
    ctx.diagnostics.mergedCount += run.length - 1;
    output.push(article);
    run = [];
  };

  for (const id of siblingIds) {
    const n = ctx.ir.nodes[id];
    if (!n) continue;
    if (n.role === "paragraph" || n.role === "caption") {
      run.push(n);
    } else {
      flushRun();
      const p = mapNode(n, ctx);
      if (p) output.push(p);
    }
  }
  flushRun();
  return output;
}

/**
 * Synthesise an XRNavigationBar from the heading hierarchy of the IR.
 * Only fires when config.generateTOC is true and the layout template
 * resolves to "document".
 *
 * Each heading in reading order becomes an XRLink item in the nav bar,
 * with the heading text as the label and a fragment href derived from the
 * heading's IR node ID.
 */
function synthesiseTOC(
  ir: PageIR,
  ctx: MappingContext,
): XRNavigationBar | null {
  const headingNodes = ir.readingOrder
    .map((id) => ir.nodes[id])
    .filter(
      (n): n is IRNode =>
        !!n &&
        n.role === "heading" &&
        typeof n.label === "string" &&
        n.label.trim().length > 0,
    );

  if (headingNodes.length === 0) return null;

  const items: XRLink[] = headingNodes.map((n) => {
    const link: XRLink = {
      id: `toc__${n.id}`,
      type: "XRLink",
      label: n.label,
      sourceIds: [n.id],
      confidence: n.confidence,
      // Use heading level (1–6) as the depth so the navigation bar can
      // render h1/h2 flush and h3+ indented, matching a real TOC hierarchy.
      depth: (n.level ?? 2) - 1,
      placement: inlinePlacement(),
      children: [],
      relations: {
        controls: [],
        labelledBy: [],
        describedBy: [],
        details: [],
        errorMessage: [],
      },
      href: `#${n.id}`,
      isCurrent: false,
    };
    registerPrimitive(ctx, link, "link→XRLink", {
      sourceNodeIds: [n.id],
      heuristic: "toc-generated",
    });
    return link;
  });

  const tocId = "toc__nav";
  const tocNode: XRNavigationBar = {
    id: tocId,
    type: "XRNavigationBar",
    label: "Table of Contents",
    sourceIds: headingNodes.map((n) => n.id),
    confidence: deriveConfidence(headingNodes),
    depth: 0,
    placement: navigationArcPlacement(ctx.config),
    children: items,
    relations: {
      controls: [],
      labelledBy: [],
      describedBy: [],
      details: [],
      errorMessage: [],
    },
    items,
  };
  registerPrimitive(ctx, tocNode, "toc:inferred→XRNavigationBar", {
    sourceNodeIds: headingNodes.map((n) => n.id),
    heuristic: "toc-from-headings",
  });
  return tocNode;
}

/**
 * Emit a diagnostics warning when a panel's direct child count exceeds
 * config.maxPanelChildren. Does not split the panel — splitting is a
 * renderer concern.
 */
function warnPanelOverflow(
  panelId: string,
  children: XRPrimitive[],
  ctx: MappingContext,
): void {
  if (children.length > ctx.config.maxPanelChildren) {
    ctx.diagnostics.unmappedRoles.push(
      `[overflow:${panelId}:${children.length}>${ctx.config.maxPanelChildren}]` as IRRole,
    );
  }
}

// ============================================================
// Layout template application
// ============================================================

/**
 * Adjust top-level spatial placements of scene children based on the
 * selected layout template. Called after all children are mapped so that
 * the template has the full set of primitives to reposition.
 *
 * Templates:
 *   "document"  — tighter curve radius, single forward panel
 *   "dashboard" — wider spread, complementary pulled further right
 *   "form"      — primary panel is taller, nav is suppressed
 *   "landing"   — wider primary panel, shallower curve
 *   "generic"   — no changes (defaults apply)
 */
function applyLayoutTemplate(
  template: LayoutTemplate,
  children: XRPrimitive[],
  config: MapperConfig,
): void {
  for (const child of children) {
    switch (child.type) {
      case "XRContentPanel": {
        if (template === "document") {
          child.placement.preferredSize = { width: 1.4, height: 1.0 };
          child.placement.curveRadius = config.viewingDistance * 0.8;
        } else if (template === "form") {
          child.placement.preferredSize = { width: 1.2, height: 1.1 };
          child.placement.curveRadius = 0; // flat for form readability
        } else if (template === "landing") {
          child.placement.preferredSize = { width: 1.8, height: 0.9 };
          child.placement.curveRadius = config.viewingDistance * 1.4;
        } else if (template === "dashboard") {
          child.placement.preferredSize = { width: 1.4, height: 0.85 };
        }
        break;
      }
      case "XRComplementary": {
        if (template === "dashboard") {
          // Pull sidebar further out for dashboard — more equal split
          const angleRad = ((config.comfortHalfAngleDeg + 5) * Math.PI) / 180;
          child.placement.position = {
            x: config.viewingDistance * Math.sin(angleRad),
            y: config.eyeLevelOffset,
            z: -config.viewingDistance * Math.cos(angleRad),
          };
          child.placement.preferredSize = { width: 0.55, height: 0.85 };
        } else if (template === "document") {
          // Complementary is less prominent in document mode
          child.placement.preferredSize = { width: 0.35, height: 0.7 };
        }
        break;
      }
      case "XRNavigationBar": {
        if (template === "form") {
          // Nav bar is hidden-by-default in form template — move behind primary
          child.placement.position.z = -(config.viewingDistance + 0.5);
        }
        break;
      }
      default:
        break;
    }
  }
}

// ============================================================
// Central dispatch
// ============================================================

/**
 * Map a single IRNode to an XR primitive.
 * Returns null only for presentation/none nodes when elidePresentation is on.
 */
function mapNode(node: IRNode, ctx: MappingContext): XRPrimitive | null {
  ctx.diagnostics.totalIRNodes += 1;

  // Skip accessibility-hidden nodes — already filtered by the parser when
  // excludeHiddenContent is true, but guard here for safety.
  if (node.state.hidden === "true") return null;

  // Elide purely presentational nodes
  if (
    ctx.config.elidePresentation &&
    (node.role === "none" || node.role === "presentation")
  ) {
    trackElision(ctx);
    return null;
  }

  switch (node.role) {
    // ── Landmarks ────────────────────────────────────────────
    case "main":
      // The top-level structural "main" node (id === "main") is the scene
      // root content panel. Any other node with role "main" is a real <main>
      // element parsed from the page HTML and is nested inside section-0.
      // Treat nested mains as sections so inferSectionGroups can group their
      // content, rather than wrapping them in another XRContentPanel.
      return node.id === "main"
        ? mapMain(node, ctx)
        : mapSection(node, ctx, "landmark:region→XRSection");
    case "navigation":
      return mapNavigation(node, ctx);
    case "banner":
      return mapBanner(node, ctx);
    case "contentinfo":
      return mapFooter(node, ctx);
    case "complementary":
      return mapComplementary(node, ctx);
    case "form":
      return mapFormPanel(node, ctx, "landmark:form→XRFormPanel");
    case "search":
      return mapFormPanel(node, ctx, "landmark:search→XRFormPanel");
    case "region":
      return mapSection(node, ctx, "landmark:region→XRSection");

    // ── Content structure ─────────────────────────────────────
    case "heading":
      return mapHeading(node, ctx);
    case "paragraph":
      return mapParagraph(node, ctx);
    case "article":
      return mapArticle(node, ctx);
    case "group":
      return mapGroup(node, ctx);

    // ── Lists ─────────────────────────────────────────────────
    case "list":
      return mapList(node, ctx, "list:generic→XRCardGrid");
    case "listitem":
      return mapListItem(node, ctx);
    case "feed":
      return mapList(node, ctx, "feed→XRCardGrid");

    // ── Media ─────────────────────────────────────────────────
    case "img":
      return mapImg(node, ctx);
    case "figure":
      return mapFigure(node, ctx);
    case "caption":
      return mapParagraph(node, ctx); // captions render as paragraphs

    // ── Tables ────────────────────────────────────────────────
    case "table":
      return mapTable(node, ctx);
    case "row":
      return mapTableRow(node, ctx);
    case "cell":
    case "columnheader":
    case "rowheader":
      return mapTableCell(node, ctx);

    // ── Interactive ───────────────────────────────────────────
    case "button":
      return mapButton(node, ctx);
    case "link":
      return mapLink(node, ctx);
    case "textbox":
      return mapTextbox(node, ctx);
    case "spinbutton":
      return mapTextbox(node, ctx);
    case "searchbox":
      return mapSearchBox(node, ctx);
    case "checkbox":
    case "radio":
    case "switch":
      return mapToggle(node, ctx);
    case "combobox":
      return mapComboBox(node, ctx);
    case "slider":
      return mapSlider(node, ctx);

    // ── Overlays ─────────────────────────────────────────────
    case "dialog":
      return mapDialog(node, ctx);
    case "alert":
      return mapAlert(node, ctx, "alert→XRAlert");
    case "status":
      return mapAlert(node, ctx, "status→XRAlert");
    case "tooltip":
      return mapTooltip(node, ctx);

    // ── Rich widgets ─────────────────────────────────────────
    case "tablist":
      return mapTabGroup(node, ctx);
    case "tab":
      return mapTab(node, ctx);
    case "tabpanel":
      return mapTabPanel(node, ctx);
    case "menu":
    case "menubar":
      return mapMenu(node, ctx);
    case "menuitem":
    case "menuitemcheckbox":
    case "menuitemradio":
      return mapMenuItem(node, ctx);
    case "tree":
      return mapTree(node, ctx);
    case "treeitem":
      return mapTreeItem(node, ctx);

    // ── Media / AV ───────────────────────────────────────────
    case "video":
    case "audio":
      return mapMedia(node, ctx);

    // ── Typography / decoration ───────────────────────────────
    case "code":
      return mapCodeBlock(node, ctx);
    case "blockquote":
      return mapBlockQuote(node, ctx);
    case "separator":
      return mapSeparator(node, ctx);
    case "progressbar":
      return mapProgressBar(node, ctx);

    // ── Other ARIA roles → generic section ───────────────────
    case "grid":
      return mapSection(node, ctx, "landmark:region→XRSection");
    case "toolbar":
      return mapSection(node, ctx, "landmark:region→XRSection");
    case "application":
      return mapSection(node, ctx, "landmark:region→XRSection");
    case "document":
      return mapSection(node, ctx, "landmark:region→XRSection");
    case "log":
      return mapAlert(node, ctx, "alert→XRAlert");
    case "timer":
      return mapParagraph(node, ctx);
    case "marquee":
      return mapParagraph(node, ctx);
    case "note":
      return mapBlockQuote(node, ctx);

    // ── Options ──────────────────────────────────────────────
    case "option":
      return mapListItem(node, ctx);

    // ── Fallback ─────────────────────────────────────────────
    case "generic":
    default:
      return mapGeneric(node, ctx);
  }
}

// ============================================================
// Page-level template selection
// ============================================================

/**
 * Analyse the IR analytics to select a layout template.
 * This drives the top-level spatial arrangement of landmark panels.
 */
export type LayoutTemplate =
  | "document" // High heading count, low control count — article / blog
  | "dashboard" // High landmark count, mixed content — app / portal
  | "form" // High control count — settings / checkout
  | "landing" // Low heading count, low control count — marketing page
  | "generic"; // Default

export function selectLayoutTemplate(analytics: IRAnalytics): LayoutTemplate {
  const { headingCount, landmarkCount, controlCount, sectionCount } = analytics;

  if (controlCount > 8 && controlCount > headingCount * 2) return "form";
  if (landmarkCount > 4 && sectionCount > 2) return "dashboard";
  if (headingCount > 4 && controlCount < 3) return "document";
  if (headingCount < 2 && landmarkCount < 3) return "landing";
  return "generic";
}

// ============================================================
// Entry point
// ============================================================

/**
 * Map a parsed IR to a spatial scene.
 *
 * @param ir      The PageIR produced by `parsePageToIR`.
 * @param config  Spatial layout configuration (optional, defaults to DEFAULT_MAPPER_CONFIG).
 * @returns       A SpatialScene ready for the XR rendering layer.
 */
export function mapIRToScene(
  ir: PageIR,
  config: MapperConfig = DEFAULT_MAPPER_CONFIG,
): SpatialScene {
  const ctx: MappingContext = {
    ir,
    config,
    primitives: {},
    diagnostics: {
      unmappedCount: 0,
      unmappedRoles: [],
      mergedCount: 0,
      elisionCount: 0,
      totalIRNodes: 0,
      totalPrimitives: 0,
      appliedRules: {},
    },
  };

  // Select the layout template from IR analytics
  const template = selectLayoutTemplate(ir.analytics);

  // Map the root body node and all its descendants.
  // Walk root.children directly rather than filtering readingOrder — the
  // readingOrder list contains every node in the tree, and the parent-guard
  // is fragile. root.children is the authoritative list of top-level nodes.
  const rootIRNode = ir.nodes[ir.root];
  if (!rootIRNode) {
    throw new Error(`IR root node "${ir.root}" not found in nodes dictionary.`);
  }

  const sceneChildren: XRPrimitive[] = [];
  for (const childId of rootIRNode.children) {
    const node = ir.nodes[childId];
    if (!node) continue;
    const primitive = mapNode(node, ctx);
    if (primitive) sceneChildren.push(primitive);
  }

  // Apply layout template — adjusts spatial placements of top-level panels
  // based on page type. Fixes Bug 3: template was computed but never used.
  applyLayoutTemplate(template, sceneChildren, config);

  // Optionally synthesise a Table of Contents navigation bar.
  // Fires when: (a) generateTOC is true and template === "document", or
  //             (b) generateTOCAlways is true regardless of template.
  if (
    (config.generateTOC && template === "document") ||
    config.generateTOCAlways
  ) {
    const toc = synthesiseTOC(ir, ctx);
    if (toc) sceneChildren.unshift(toc);
  }

  // Build the root XRScene
  const rootScene: XRScene = {
    id: "scene",
    type: "XRScene",
    label: ir.meta.title,
    sourceIds: [ir.root],
    confidence: 1.0,
    depth: 0,
    placement: {
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0 },
      preferredSize: { width: 0, height: 0 },
      curveRadius: 0,
      worldLocked: true,
    },
    children: sceneChildren,
    relations: {
      controls: [],
      labelledBy: [],
      describedBy: [],
      details: [],
      errorMessage: [],
    },
    pageTitle: ir.meta.title,
    readingOrder: ir.readingOrder,
  };

  ctx.primitives["scene"] = rootScene;

  return {
    root: rootScene,
    primitives: ctx.primitives,
    readingOrder: ir.readingOrder,
    diagnostics: ctx.diagnostics,
    template,
  };
}
