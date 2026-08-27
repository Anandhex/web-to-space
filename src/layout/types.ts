import type {
  Vec3,
  Rotation3,
  Size2,
  XRPrimitive,
  XRPrimitiveType,
  SemanticScene,
} from "../mapper/types";

// ─────────────────────────────────────────────────────────────
// Output types (LayoutEntry, PaginationMeta, LayoutPlan)
// ─────────────────────────────────────────────────────────────

/**
 * Resolved spatial entry for a single primitive.
 *
 * Top-level landmark panels: world space (relative to scene origin).
 * All other primitives: local space (relative to their parent panel
 * top-left origin at (0, 0, 0)).
 */
export interface LayoutEntry {
  id: string;
  position: Vec3;
  rotation: Rotation3;
  size: Size2;
  curveRadius: number;
  worldLocked: boolean;

  /**
   * Pagination metadata. Present when this entry is an XRContentPanel
   * whose children were split across pages due to height overflow.
   */
  pagination?: PaginationMeta;

  /**
   * Page index within the nearest ancestor XRContentPanel.
   * Absent for primitives that are not under a paginated panel,
   * or for the XRContentPanel entry itself.
   */
  pageIndex?: number;

  /**
   * Inclusive end of a page *range* over which this entry stays visible.
   * Present only on section-scoped landmarks extracted to a fixed slot
   * (e.g. an <aside> nested inside a section, re-homed in the complementary
   * panel): the aside should remain visible for every page its parent
   * section spans, not just `pageIndex`. When set, the renderer gates on
   * `pageIndex <= currentPage <= pageEndIndex` instead of an exact match.
   * Absent for ordinary paginated primitives (single-page gating).
   */
  pageEndIndex?: number;

  /**
   * Pages *within* [pageIndex … pageEndIndex] on which this entry is hidden.
   * Used for mutual exclusion in the complementary slot: the persistent
   * interstitial aside spans the whole document but yields the slot to a
   * section-scoped aside while that section is on screen, so those pages are
   * excluded here. Each tuple is an inclusive `[start, end]` page range.
   * Absent for entries with no exclusions.
   */
  pageExcludeRanges?: Array<[number, number]>;

  /**
   * Resolved table layout strategy.
   * Present only on XRTable entries; tells the renderer which
   * display mode to use.
   */
  tableLayoutStrategy?: "flat-2d" | "curved-2d" | "scrollable" | "cards";

  /**
   * Resolved card grid column count.
   * Present only on XRList entries.
   */
  listColumns?: number;

  /**
   * Set to true when the engine called paginateContentPanel for this primitive,
   * even if the content fits on a single page. The renderer uses this to decide
   * whether to render children inside a positioned group (panel-absolute coords)
   * or as world-space siblings.
   */
  paginatedByEngine?: boolean;

  /**
   * Set to true when this entry belongs to a landmark the active content-only
   * page view suppresses (XRNavigationBar / TOC). The entry exists so the
   * "no nodes dropped" invariant holds, but the renderer skips it — in page
   * views the spatialised page set itself is the navigation.
   */
  suppressed?: boolean;

  /**
   * Set to true when this primitive's children were positioned by
   * stackChildrenSimple (parent-relative coordinates), as opposed to the
   * panel-absolute coordinates paginateContentPanel produces. This happens for
   * containers laid out inside a non-paginating landmark slot (e.g. an XRList
   * inside an XRComplementary). The renderer must wrap such a container's child
   * dispatch in its own <AtPos> group so the container's own offset composes —
   * otherwise the children render relative to the grandparent slot, dropping
   * the container's position (a list's items detach from the list, leaving a
   * gap where the list should be).
   */
  childrenParentRelative?: boolean;
}

/**
 * Pagination metadata attached to an XRContentPanel that was split.
 *
 * Child positions are stored in a single continuous local-space Y coordinate
 * system. To show page N, the renderer translates its content group by
 * +pageYOffsets[N] along the local Y axis, shifting that page's content
 * back to the top of the panel viewport.
 */
export interface PaginationMeta {
  pageCount: number;
  pageZStep: number;
  /** Length === pageCount. pageYOffsets[0] is always 0. */
  pageYOffsets: number[];
}

export interface LayoutPlan {
  /** Flat registry: primitive ID → LayoutEntry. Covers every node. */
  entries: Record<string, LayoutEntry>;
  config: LayoutConfig;
  /**
   * The resolved landmark slot map (post-override) that drove placement. The
   * tuning HUD reads this to enumerate tunable slots and seed its sliders.
   */
  slots: SlotMap;
  /**
   * The slots a landmark was actually placed into, in the order they were
   * claimed. `slots` is the roster the desk offers; this is the subset the
   * document filled. A page with no `<nav>` still gets a navigation slot, and
   * anything drawn from the roster alone (a mount, a backing) would appear as
   * an empty panel hanging in the workspace.
   */
  occupiedSlots?: SlotName[];
  diagnostics: LayoutDiagnostics;
  /**
   * Reference frame the landmark positions are authored in. The renderer wraps
   * the scene graph in a matching transform. Absent/"world" for the legacy
   * (non-arrangement) path.
   */
  referenceFrame?: ReferenceFrame;

  /**
   * True when the plan was computed in content-only mode (a page view with a
   * non-"flip" pageDistribution): the roster is [main], asides paginate
   * in-flow (never extracted to a slot — the renderer must NOT route them
   * through the extracted-complementary path), and nav/TOC entries carry
   * `suppressed`.
   */
  contentOnly?: boolean;

  /** The active page presentation, stamped from the arrangement. */
  pageDistribution?: PageDistribution;

  /**
   * The document's section outline with the pages each section occupies, in
   * reading order. Only pagination knows which page a primitive landed on,
   * so this belongs to the engine — the renderer would otherwise re-walk the
   * whole subtree and re-derive it, once per page view, on every focus
   * change. Present whenever the panel paginated.
   */
  sections?: SectionSpan[];
}

/**
 * One section of the document and the pages it occupies — the unit the page
 * views group by (a wall tile, a deck pile, a room).
 * Ranges are the section's own SUBTREE span, so a parent's range still
 * covers its children's; turning that into disjoint groups is a
 * presentation decision and stays with the renderer.
 */
export interface SectionSpan {
  /** Heading text; "" when the section has no heading and so no name. */
  label: string;
  /** Nesting depth among sections — 0 is a top-level section of the panel. */
  depth: number;
  startPage: number;
  endPage: number;
}

export interface LayoutDiagnostics {
  paginatedPanelCount: number;
  paginatedPanels: Array<{ id: string; pageCount: number }>;
  unplacedIds: string[];
  totalPlaced: number;
  /** Primitives whose height was estimated via the fallback floor. */
  fallbackHeightIds: string[];

  missingHeightMapEntries?: number;
  slotOverflows?: Array<{
    id: string;
    type: XRPrimitiveType;
    declaredHeight: number;
    actualHeight: number;
    overflowBy: number;
  }>;
}

// ─────────────────────────────────────────────────────────────
// Render metrics — the single source of dimensional truth
// ─────────────────────────────────────────────────────────────

/**
 * Per-primitive font and sizing metrics as they will actually be rendered.
 *
 * The renderer (e.g. XRSceneRenderer / troika-three-text) must use these
 * exact values. When they diverge from the renderer's actual settings,
 * pagination calculations will be wrong.
 *
 * All sizes in metres.
 */
export interface PrimitiveFontMetrics {
  /** Rendered font size in metres. */
  fontSize: number;
  /** Line height as a multiplier of fontSize. */
  lineHeightRatio: number;
  /** Top + bottom padding inside the element box in metres. */
  verticalPadding: number;
  /** Average character width as a fraction of fontSize (proportional font estimate). */
  charWidthRatio: number;
  /** Average characters per word including trailing space. */
  avgCharsPerWord: number;
}

/**
 * Fixed-height elements that have no text content to measure.
 * Returned by the renderer's CSS/style system; recorded here so
 * the engine can perform accurate height budgeting.
 */
export interface FixedHeightMetrics {
  height: number;
}

/**
 * Metrics for interactive elements whose label text can wrap across multiple
 * lines (buttons, links, menu items, tabs, alerts, tooltips, tree items).
 *
 * `minHeight` is the floor (single-line with padding). If the rendered label
 * wraps beyond one line the engine grows the element by adding extra line
 * heights on top of `minHeight`.
 */
export interface TextBearingMetrics {
  /** Minimum height when the label fits on one line (m). */
  minHeight: number;
  /** Font metrics used to estimate label wrap. */
  font: PrimitiveFontMetrics;
}

/**
 * Interior padding scale for primitive surfaces — the distance between a
 * surface's own edge and the content drawn on it.
 *
 * Derivation. Padding is only legible if it survives at the reading distance,
 * so each step is a visual angle rather than a raw metre value. At the Quest 3
 * profile's viewing distance d = 1.2 m, one degree subtends
 *   2 · d · tan(0.5°) ≈ 0.0209 m,
 * so ~21 mm is "one degree of padding". The scale is that unit stepped down in
 * quarters, which keeps every inset in the codebase on one ladder instead of
 * the per-mesh 4/14/18/20/26 mm literals this replaces.
 *
 * A view that changes reading distance must rescale these together with the
 * font sizes, for the same reason (see the legibility note in profiles.ts).
 */
export interface SpacingScale {
  /** ~0.2° — element to its own hairline accent bar or rule. */
  hairline: number;
  /** ~0.5° — interior of a compact chip, tag or inline pill. */
  tight: number;
  /** ~0.75° — interior of a control: button, input, combo box, tab. */
  snug: number;
  /** ~1° — interior of a card: list tile, blockquote, code block, figure. */
  comfortable: number;
  /** ~1.5° — interior of a section or landmark surface. */
  generous: number;
}

/**
 * Vertical rhythm — the gap between two stacked blocks, chosen by what the
 * pair is rather than by one flat constant.
 *
 * Derivation. Proximity is read as grouping whether or not it was intended, so
 * the gaps have to encode the document's grouping: a heading binds to the
 * content beneath it, and the space that opens a new group must be visibly
 * larger than the space inside one. Every step is a fraction of the body line
 * box L = paragraph.fontSize × paragraph.lineHeightRatio (≈ 34 mm on the Quest
 * 3 profile), the same way a CSS baseline grid quantises to the line height:
 *
 *   afterHeading   0.25·L   heading → its own content, deliberately tight
 *   betweenBlocks  0.50·L   paragraph → paragraph, the default
 *   aroundRule     0.75·L   either side of a separator
 *   aroundBlock    0.75·L   either side of a figure, table, quote or code block
 *   beforeHeading  1.00·L   a heading opens a new group, deliberately loose
 *
 * The 4:1 ratio between beforeHeading and afterHeading is the whole point: it
 * is what makes a section boundary readable at the far end of the working band,
 * where a 10 mm difference would not survive.
 */
export interface BlockRhythm {
  /** Gap after a heading, before the content it introduces. */
  afterHeading: number;
  /** Gap before a heading that opens a new group. */
  beforeHeading: number;
  /** Gap between two ordinary stacked blocks (the default). */
  betweenBlocks: number;
  /** Gap either side of a separator rule. */
  aroundRule: number;
  /** Gap either side of a block object — figure, image, table, quote, code. */
  aroundBlock: number;
}

/**
 * The complete set of render metrics the engine needs.
 *
 * Provided externally — typically one `RenderMetrics` object per DeviceProfile
 * plus per-scene overrides. The engine never hard-codes any of these values.
 */
export interface RenderMetrics {
  // ── Text primitives ──────────────────────────────────────
  /** Font metrics for body text paragraphs. */
  paragraph: PrimitiveFontMetrics;

  /**
   * Heading metrics per level (1–6).
   * Only levels present in this map are used; missing levels fall back to
   * the nearest coarser entry or to `fallbackElementHeight`.
   */
  heading: Partial<Record<1 | 2 | 3 | 4 | 5 | 6, PrimitiveFontMetrics>>;

  /** Font metrics for code blocks. */
  codeBlock: PrimitiveFontMetrics;

  /** Font metrics for blockquotes (prose, same metrics as paragraph usually). */
  blockQuote: PrimitiveFontMetrics;

  // ── Text-bearing interactive elements ────────────────────
  // These have a label that may wrap when the panel is narrow or the label
  // is long. The engine uses TextBearingMetrics to grow their height
  // beyond `minHeight` when wrapping is detected.
  button: TextBearingMetrics;
  link: TextBearingMetrics;
  tab: TextBearingMetrics;
  menuItem: TextBearingMetrics;
  treeItem: TextBearingMetrics;
  alert: TextBearingMetrics;
  tooltip: TextBearingMetrics;

  // ── Truly fixed-height interactive elements ───────────────
  // These have no free-form label text (or their label is always single-line
  // by design) so a fixed height is appropriate.
  toggle: FixedHeightMetrics;
  slider: FixedHeightMetrics;
  comboBox: FixedHeightMetrics;
  searchBox: FixedHeightMetrics;
  progressBar: FixedHeightMetrics;
  separator: FixedHeightMetrics;
  tabGroup: FixedHeightMetrics;

  // ── List items ────────────────────────────────────────────
  /**
   * Metrics for XRListItem — covers both rich card-style list items (XRList
   * children) and simple interactive list items. `minHeight` is the per-row
   * floor for card layouts; the engine grows items when their label wraps.
   */
  listItem: TextBearingMetrics;

  /**
   * Vertical padding (m) inside a list-item card: the distance from the card's
   * top edge to its first line of content, and a matching pad below. Both the
   * height estimate (layout) and the card mesh (renderer) read this so the
   * space reserved matches what is drawn.
   */
  listItemContentPad: number;
  /**
   * Horizontal inset (m) applied to each side of a list-item card's content.
   */
  listItemProseInset: number;
  /**
   * Extra height (m) added to a list-item card's one-line minimum floor, so a
   * card is never shorter than `oneLine + listItemMinPad`.
   */
  listItemMinPad: number;
  /**
   * Anti-clip cushion (m) added to a multi-line list-item card's height. The
   * height estimate predicts wrapping from average character width; the renderer
   * wraps from real glyph widths. This buffer covers the case where the actual
   * wrap comes out slightly taller so the last line is never clipped by the
   * card's bottom edge. Larger = safer against clipping, looser cards.
   */
  listItemWrapCushion: number;

  /**
   * Font metrics for figure captions (the text line beneath an XRFigure).
   * Used to grow XRFigure height when a caption wraps to multiple lines.
   */
  figureCaption: PrimitiveFontMetrics;
  /** Intrinsic height of an inline image. */
  image: FixedHeightMetrics;
  /** Compact media-player widget height (audio / short clip). */
  mediaPlayerCompact: FixedHeightMetrics;
  /** Large media-panel height (cinema-scale video). */
  mediaPlayerLarge: FixedHeightMetrics;

  // ── Card grid ─────────────────────────────────────────────
  /**
   * Minimum card width in metres.
   * Used to derive column count: floor(panelUsableWidth / minCardWidth).
   */
  minCardWidth: number;
  /**
   * Maximum columns regardless of panel width.
   * Prevents cards from becoming too narrow on very wide panels.
   */
  maxCardColumns: number;

  // ── Table ─────────────────────────────────────────────────
  /** Height of a single data row (excluding header). */
  tableRowHeight: number;
  /** Height of the header row. */
  tableHeaderRowHeight: number;
  /**
   * Maximum columns that fit in "flat-2d" mode before the engine
   * switches to "curved-2d" or "scrollable".
   */
  tableMaxFlatColumns: number;
  /**
   * Maximum rows that fit in "flat-2d" mode before "scrollable" kicks in.
   */
  tableMaxFlatRows: number;

  // ── Layout primitives ─────────────────────────────────────
  /**
   * Landmark-level heights (used by slot factory for non-main panels).
   * These are the sizes injected into SlotMap; callers that want to
   * override banner/nav/footer heights do so here, not in LayoutConfig.
   */
  banner: FixedHeightMetrics;
  footer: FixedHeightMetrics;
  navigationBar: FixedHeightMetrics;

  // ── Spacing ───────────────────────────────────────────────
  /** Interior padding ladder shared by every primitive surface. */
  spacing: SpacingScale;
  /** Pair-aware vertical gaps between stacked blocks. */
  rhythm: BlockRhythm;

  // ── Fallback ──────────────────────────────────────────────
  /**
   * Height floor used for any primitive type not covered above.
   * Also the minimum size for zero-content containers.
   */
  fallbackElementHeight: number;
}

// ─────────────────────────────────────────────────────────────
// Device profiles
// ─────────────────────────────────────────────────────────────

/**
 * A device profile bundles a `RenderMetrics` object with spatial defaults
 * appropriate for that device's optics, FOV, and typical use distance.
 *
 * Calling code selects a profile and optionally merges overrides.
 */
export interface DeviceProfile {
  /** Human-readable name for diagnostics and logging. */
  name: string;
  /** Spatial layout defaults appropriate for this device. */
  layoutConfig: LayoutConfig;
  /** Render metrics that match this device's renderer settings. */
  renderMetrics: RenderMetrics;
}

/**
 * Spatial layout parameters for the engine.
 *
 * These control where panels are placed in world space and how children
 * are stacked within panels. They are independent of render metrics and
 * can be overridden at runtime (e.g. seated vs standing, room-scale vs
 * stationary).
 */
export interface LayoutConfig {
  /** Distance from user head to primary content panel (m). */
  viewingDistance: number;
  /** Half-angle of horizontal comfort envelope (degrees). */
  comfortHalfAngleDeg: number;
  /** Vertical position of the centre of the comfort envelope (m). Eye level. */
  eyeLevel: number;
  /** Downward tilt offset from eye level for the primary panel (m). */
  eyeLevelOffset: number;
  /** Default curve radius for primary content panels (m). */
  panelCurveRadius: number;
  /**
   * Residual gap used only INSIDE one prose node — between an inline run and a
   * block child of the same paragraph, where there is no meaningful pair of
   * blocks to measure. Stacking between siblings goes through `blockGap()`
   * (layout/utils) and `metrics.rhythm` instead; a single flat gap cannot
   * express grouping. Do not reach for this in new stacking code.
   */
  childGapY: number;
  /** Top padding inside a panel before the first child (m). */
  panelPaddingTop: number;
  /** Left/right padding inside a panel (m). */
  panelPaddingX: number;
  /** Maximum panel viewport height before pagination fires (m). */
  maxPanelViewportHeight: number;
  /** Z-offset between successive pages of a paginated panel (m). */
  pageZStep: number;
  /**
   * When false (default), each isSectionLike child (XRSection, XRArticle,
   * XRFormPanel, XRFormField) starts on a fresh page.
   * When true, sections flow inline — they still go through splitSection()
   * for their children, but no forced page break is injected before them.
   */
  sectionStartsOnNewPage?: boolean; // default: true
  /**
   * Set by computeLayoutPlan (not a device profile knob): true when the active
   * desk exposes a complementary slot, so every XRComplementary flowed
   * inside a content panel will be extracted to that slot at layout time. When
   * true, paginateContentPanel treats those asides as zero-space floats — they
   * still receive a pageIndex (so the extraction pass can find them) but never
   * consume vertical space or force a page break, otherwise a section-nested
   * aside that overflows onto a fresh page leaves that page blank once its
   * content is re-homed in the slot.
   */
  complementaryExtractedToSlot?: boolean;
  /**
   * Live per-slot overrides, applied after slot resolution. Set by the DOM
   * tuning HUD; omitted in normal rendering. See SlotOverride.
   */
  slotOverrides?: Partial<Record<SlotName, SlotOverride>>;
}

export interface LandmarkSlot {
  position: Vec3;
  rotation: Rotation3;
  size: Size2;
  curveRadius: number;
  worldLocked: boolean;
}

/**
 * Live tuning override for a single landmark slot.
 *
 * When present in LayoutConfig.slotOverrides (set by the DOM tuning HUD), these
 * values are stamped onto the resolved slot AFTER the desk/arrangement
 * produces it — so you can dial in a panel's placement in the running scene and
 * export the numbers into a slot definition. Every field is optional; only the
 * fields that are set are applied, leaving the rest at the desk's value.
 *
 * Angles are in radians (WebXR). Distances/radii are in metres. `x` is the
 * panel's LEFT edge (top-left anchor), matching LandmarkSlot.position.
 */
export interface SlotOverride {
  x?: number;
  y?: number;
  z?: number;
  rotX?: number;
  rotY?: number;
  rotZ?: number;
  curveRadius?: number;
}

export type SlotName =
  | "main"
  | "navigation"
  | "complementary"
  | "banner"
  | "footer"
  | "toc"
  | "dialog"
  | "alert";

export type SlotMap = Partial<Record<SlotName, LandmarkSlot>>;

// ─────────────────────────────────────────────────────────────
// Two-axis view system: reference frames + arrangements
// ─────────────────────────────────────────────────────────────

/**
 * The spatial reference frame a view's panels live in. `LayoutEntry` positions
 * are authored relative to this frame; the renderer applies the frame transform
 * exactly once at the scene-graph root (see ReferenceFrameGroup).
 *
 *  - "world" — fixed in the room (identity transform).
 *  - "body"  — follows the camera's yaw only (turn-to-navigate workspaces).
 *  - "head"  — follows the full head pose (near-eye HUDs).
 *  - "hand"  — follows a controller's grip pose (handheld/palm views).
 */
export type ReferenceFrame = "world" | "body" | "head" | "hand";

/**
 * How a paginated content panel's PAGES are presented spatially. "flip"
 * (default) is the legacy behaviour: one page visible, prev/next controls.
 * Every other value renders the full page set as spatial ghosts around the
 * focused reading panel — the placement math itself is renderer-side
 * (src/renderer/page-placements.ts); this type is pure data so an
 * Arrangement can declare which presentation it wants.
 *
 * Any non-"flip" value also puts the layout engine in CONTENT-ONLY mode:
 * the slot roster collapses to [main], asides/banner/footer fold into the
 * content flow (they paginate inline), and nav/TOC entries are suppressed.
 */
export type PageDistribution = "flip" | "wall" | "deck" | "rooms";

/** Device capability class, used to gate which views a profile may offer. */
export type DeviceClass = "headset-6dof" | "headset-roomscale" | "glasses";

/**
 * A declarative view: a reference frame plus the page presentation it chooses.
 * Adding a view is data, not a new SlotMap function.
 */
export interface Arrangement {
  /** Stable id — matches the ViewMode string in the UI. */
  id: string;
  frame: ReferenceFrame;
  /** Device classes this view is usable on. */
  deviceFit: DeviceClass[];
  /**
   * Spatial presentation of the content panel's page set. Absent/"flip" =
   * legacy single-page behaviour. Non-"flip" collapses the roster to [main]
   * (content-only mode) — see PageDistribution.
   */
  pageDistribution?: PageDistribution;
}

export interface SimpleStackResult {
  /** One entry per child, with page-relative y-positions. */
  childEntries: LayoutEntry[];
  /** Sum of all child heights + gaps + padding (used by estimateHeight callers). */
  totalHeight: number;
}

export interface PaginateResult {
  pagination: PaginationMeta | null;
  /** primitiveId → pageIndex, covers every descendant of the panel. */
  pageIndexMap: Record<string, number>;
  /**
   * primitiveId → page-relative Vec3, covers every descendant placed by
   * splitSection. layoutPrimitive uses these directly — no position
   * recomputation anywhere in the subtree.
   */
  placedPositionMap: Map<string, Vec3>;

  /**
   * primitiveId → final placed height after pagination, covers every descendant.
   */
  placedHeightMap: Map<string, number>;

  /**
   * primitiveId → override width, for descendants whose width diverges from
   * the container's standard column/content width. Currently only populated
   * by placeListGrid for a list item too tall to fit its normal grid column
   * even on an empty page — it gets promoted to a full-width row so its text
   * wraps into far fewer lines instead of clipping past the viewport. Absent
   * entries fall back to the caller's own width computation.
   */
  placedWidthMap: Map<string, number>;

  /**
   * Synthetic XRParagraph continuation nodes created during paragraph splitting.
   * Each carries the remaining text of an overflowed paragraph and is placed at
   * the top of its overflow page. layoutPrimitive injects these into
   * scene.primitives and the panel's children so the renderer dispatches them.
   */
  syntheticPrimitives: XRPrimitive[];
}

// ─────────────────────────────────────────────────────────────
// Primitive configuration registry
// ─────────────────────────────────────────────────────────────

type HeightStrategy = "mixed" | "text" | "children" | "fixed" | "custom";
type PaginateBehavior = "split" | "recursive" | "atomic";

export interface PrimitiveConfig {
  heightStrategy: HeightStrategy;
  // For "mixed": font metrics resolver (null → metrics.paragraph)
  fontMetrics?: (
    primitive: XRPrimitive,
    metrics: RenderMetrics,
  ) => PrimitiveFontMetrics;
  // For "mixed": additional width inset for the inline flow pass only
  flowWidthInset?: number;
  // For "mixed"/"text": minimum height floor
  minHeight?: (metrics: RenderMetrics) => number;
  // For "text": text-bearing metrics resolver
  textBearing?: (
    metrics: RenderMetrics,
  ) => import("./types").TextBearingMetrics;
  // For "fixed": fixed height
  fixedHeight?: (metrics: RenderMetrics) => number;
  // For "custom": full handler
  customHandler?: (
    primitive: XRPrimitive,
    panelUsableWidth: number,
    metrics: RenderMetrics,
    config: LayoutConfig,
    ancestors: Set<string>,
    scene?: SemanticScene,
  ) => number;
  paginate: PaginateBehavior;
  forceNewPage?: boolean;
  ownsXPadding: boolean;
  ownsTopPadding: boolean;
  slot: import("./types").SlotName;
  // Override slot based on primitive state (e.g. XRNavigationBar toc vs navigation)
  slotFn?: (primitive: XRPrimitive) => import("./types").SlotName;
}
