/**
 * layout-engine.ts — XR Spatial Layout Engine
 *
 * Consumes a `SpatialScene` (from mapper.ts) and a `LayoutTemplate` and
 * produces a `LayoutPlan` — a flat map of primitive ID → resolved position,
 * size, rotation, and pagination metadata.
 *
 * The renderer merges the LayoutPlan over the SpatialScene before
 * instantiating meshes. The mapper's placement hints are used as inputs
 * but may be overridden entirely by this engine.
 *
 * Architecture position:
 *   HTML → Parser → IR → Mapper → SpatialScene
 *                                      ↓
 *                              Layout Engine (this file)
 *                                      ↓
 *                                 LayoutPlan
 *                                      ↓
 *                               XR Renderer
 *
 * Design principles
 * ─────────────────
 * 1. Pure function: (SpatialScene, LayoutConfig) → LayoutPlan.
 *    No side-effects, no mutations of the input scene.
 *
 * 2. Template-driven top-level arrangement (document / dashboard / form /
 *    landing / generic) decides where landmark panels appear in world space.
 *
 * 3. Within each panel, children are stacked vertically. When the stacked
 *    height would exceed the panel's viewport height, the content is split
 *    into pages. Each page gets its own z-offset so the renderer can show
 *    one page at a time (e.g. swipe / gaze-scroll).
 *
 * 4. Every primitive in the scene receives a LayoutEntry regardless of
 *    depth. Child entries carry positions relative to their parent panel
 *    origin (local space). The renderer is responsible for world-space
 *    composition.
 *
 * 5. All measurements in metres (WebXR coordinate system).
 *    Ergonomic defaults derived from XR literature:
 *      viewing distance  1.2 m
 *      comfort FOV       ±30° horizontal, ±20° vertical
 *      eye level         ~1.5 m above floor (offset configurable)
 */

import type {
  SpatialScene,
  XRPrimitive,
  XRPrimitiveType,
  Vec3,
  Rotation3,
  Size2,
} from "../mapper/mapper";

import type { LayoutTemplate } from "../mapper/mapper";

// ─────────────────────────────────────────────────────────────
// Output types
// ─────────────────────────────────────────────────────────────

/**
 * Resolved spatial entry for a single primitive.
 * Positions are in the coordinate space of the primitive's parent panel
 * (local space) except for top-level landmark panels, which are in world space.
 */
export interface LayoutEntry {
  /** Primitive ID — matches XRPrimitive.id. */
  id: string;

  /**
   * Resolved position (metres).
   * Top-level panels: world space (relative to scene origin).
   * Children: local space (relative to parent panel top-left origin).
   */
  position: Vec3;

  /** Euler rotation (radians, XYZ). Inherited from mapper for landmarks. */
  rotation: Rotation3;

  /** Resolved panel/element size (metres). */
  size: Size2;

  /**
   * Curvature radius (metres). 0 = flat panel.
   * Passed through from mapper placement or overridden by template.
   */
  curveRadius: number;

  /** World-locked (true) vs head-locked (false). */
  worldLocked: boolean;

  /**
   * Pagination metadata. Present when this entry is a panel whose children
   * were split across multiple pages due to height overflow.
   * Absent for leaf nodes and panels whose children fit in a single page.
   */
  pagination?: PaginationMeta;

  /**
   * Page index this primitive belongs to within its parent paginating panel.
   *
   * Set by the layout engine on every descendant of a paginated XRContentPanel.
   * The renderer compares this value to the panel's current page to decide
   * whether to render the primitive.
   *
   * Absent (undefined) for primitives that are not under a paginated panel,
   * or for the XRContentPanel itself.
   *
   * For section children that overflow across page boundaries, each child
   * receives the specific page index it should appear on.
   */
  pageIndex?: number;
}

/**
 * Pagination metadata attached to a panel (e.g. XRContentPanel) whose
 * children were split across pages by the layout engine.
 *
 * The engine stamps a `pageIndex` on every LayoutEntry that belongs to a
 * paginated panel, including deeply nested children of sections that overflow.
 *
 * Child positions are stored as absolute local-space Y values (accumulated
 * downward from the panel top across all pages). To render a given page
 * without overflow, the renderer translates its content group by
 * `+pageYOffsets[currentPage]` along the local Y axis, which shifts that
 * page's content back to the top of the panel viewport.
 */
export interface PaginationMeta {
  /** Total number of pages. */
  pageCount: number;
  /**
   * Z-offset (metres) applied to each successive page panel.
   * The renderer stacks pages behind each other along the z-axis;
   * the active page is brought forward.
   */
  pageZStep: number;
  /**
   * Y scroll offset (metres) for each page, indexed by page number.
   * Length === pageCount.
   *
   * Child positions are accumulated downward across all pages in a single
   * continuous local-space coordinate system. To show page N without
   * content from other pages overflowing the panel viewport, the renderer
   * must translate its content group by `+pageYOffsets[N]` on the local
   * Y axis (positive = shift content upward into view).
   *
   * Page 0 is always 0 (no offset needed — content starts at panel top).
   * Subsequent pages have increasing positive values equal to the absolute
   * Y depth at which that page began.
   *
   * Example with maxPanelViewportHeight = 0.9 m:
   *   page 0 → yOffset = 0.0   (content at y = -0.04 … -0.94 fits in view)
   *   page 1 → yOffset = 0.94  (content at y = -0.98 … -1.88 shifted up by 0.94)
   *   page 2 → yOffset = 1.88  (and so on)
   */
  pageYOffsets: number[];
}

/**
 * The complete output of the layout engine.
 * A flat map of primitive ID → LayoutEntry covering every node in the scene.
 */
export interface LayoutPlan {
  /**
   * Flat registry of layout entries keyed by primitive ID.
   * Every ID in SpatialScene.primitives will have a corresponding entry.
   */
  entries: Record<string, LayoutEntry>;

  /** The layout template that was applied. */
  template: LayoutTemplate;

  /** Layout configuration snapshot used to produce this plan. */
  config: LayoutConfig;

  /**
   * Diagnostics produced during layout.
   * Useful for thesis evaluation — records pagination events, overflow
   * warnings, and any primitives that could not be placed.
   */
  diagnostics: LayoutDiagnostics;
}

export interface LayoutDiagnostics {
  /** Number of panels that were paginated. */
  paginatedPanelCount: number;
  /** IDs of panels that were paginated, with their page count. */
  paginatedPanels: Array<{ id: string; pageCount: number }>;
  /** IDs of primitives that could not be assigned a layout entry. */
  unplacedIds: string[];
  /** Total number of primitives laid out. */
  totalPlaced: number;
}

// ─────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────

export interface LayoutConfig {
  /**
   * Distance from the user's head origin to the primary content panel (m).
   * Ergonomic range: 0.5–2.0 m. Default 1.2 m.
   */
  viewingDistance: number;

  /**
   * Half-angle of the horizontal comfort envelope (degrees).
   * Content beyond this angle is placed in the peripheral zone.
   * Default ±30°.
   */
  comfortHalfAngleDeg: number;

  /**
   * Vertical position of the centre of the comfort envelope relative
   * to the scene origin (metres). Represents approximate eye level.
   * Default 1.5 m (standing user).
   */
  eyeLevel: number;

  /**
   * Slight downward tilt of the primary panel from eye level (metres).
   * Ergonomic research suggests content centred 5–10° below eye level
   * reduces neck strain. Default -0.1 m.
   */
  eyeLevelOffset: number;

  /**
   * Default curve radius for primary content panels (metres).
   * A panel at viewingDistance 1.2 m with radius 1.2 m keeps all content
   * within ±30° horizontal FOV at full panel width. Default 1.2 m.
   */
  panelCurveRadius: number;

  /**
   * Vertical gap between stacked child primitives within a panel (metres).
   * Default 0.02 m (20 mm — comfortable reading gap at 1.2 m distance).
   */
  childGapY: number;

  /**
   * Top padding inside a panel before the first child (metres). Default 0.04 m.
   */
  panelPaddingTop: number;

  /**
   * Left/right padding inside a panel (metres). Default 0.04 m.
   * Children are inset by this amount on both sides.
   */
  panelPaddingX: number;

  /**
   * Maximum panel viewport height before pagination fires (metres).
   * Content taller than this is split into pages. Default 0.9 m.
   */
  maxPanelViewportHeight: number;

  /**
   * Z-offset between successive pages of a paginated panel (metres).
   * Pages stack behind the primary panel along -z. Default 0.05 m.
   */
  pageZStep: number;

  /**
   * Minimum height allocated to a primitive that has no intrinsic size (m).
   * Used as the floor for unknown/generic element heights. Default 0.04 m.
   */
  minElementHeight: number;
}

export const DEFAULT_LAYOUT_CONFIG: LayoutConfig = {
  viewingDistance: 1.2,
  comfortHalfAngleDeg: 30,
  eyeLevel: 1.5,
  eyeLevelOffset: -0.1,
  panelCurveRadius: 1.2,
  childGapY: 0.02,
  panelPaddingTop: 0.04,
  panelPaddingX: 0.04,
  maxPanelViewportHeight: 0.9,
  pageZStep: 0.05,
  minElementHeight: 0.04,
};

// ─────────────────────────────────────────────────────────────
// Intrinsic height estimation
// ─────────────────────────────────────────────────────────────

/**
 * Height budget table (metres) for each XR primitive type.
 *
 * These are ergonomically derived estimates for a panel at 1.2 m viewing
 * distance with the default comfort FOV. The rendering layer may override
 * them at runtime based on actual text metrics or media aspect ratios.
 *
 * Values are the *intrinsic* height of the element itself, not including
 * the childGapY spacing applied between siblings.
 */
const INTRINSIC_HEIGHT: Partial<Record<XRPrimitiveType, number>> = {
  XRHeading: 0.055, // H1: 0.07, H2: 0.06, H3–H6: 0.05 — averaged
  XRParagraph: 0.12, // ~4 lines of body text at comfortable scale
  XRImage: 0.3, // typical inline image
  XRFigure: 0.35, // image + caption
  XRSeparator: 0.01,
  XRButton: 0.055,
  XRToggle: 0.05,
  XRSlider: 0.06,
  XRComboBox: 0.055,
  XRSearchBox: 0.055,
  XRProgressBar: 0.04,
  XRLink: 0.045,
  XRCodeBlock: 0.18,
  XRBlockQuote: 0.1,
  XRAlert: 0.08,
  XRTooltip: 0.06,
  XRMediaPlayer: 0.55, // compact-widget; large-panel overrides in layout
  XRNavigationBar: 0.9, // full-height arc — placed as a landmark
  XRBanner: 0.18,
  XRFooter: 0.14,
  XRTab: 0.055,
  XRTabGroup: 0.065,
  XRMenuItem: 0.045,
  XRTreeItem: 0.045,
};

/**
 * Estimate the height (metres) a primitive will occupy when rendered.
 *
 * For container types (XRSection, XRArticle, XRCardGrid, XRTable, XRFormPanel,
 * XRFormField, XRContentPanel, XRTabPanel) height is computed by summing
 * child heights — but containers at the top-level landmark layer use their
 * mapper-provided preferredSize.height instead (already set by applyLayoutTemplate).
 *
 * For XRHeading the heading level narrows the estimate.
 * For XRParagraph the densityScore widens it.
 * For XRMediaPlayer the sizingStrategy widens it for large-panel video.
 * For XRCardGrid the row count is derived from columns.
 */
function estimateHeight(
  primitive: XRPrimitive,
  scene: SpatialScene,
  config: LayoutConfig,
  depth: number = 0,
  visited: Set<string> = new Set(),
): number {
  // Cycle guard — corrupt trees should not cause infinite recursion
  if (visited.has(primitive.id)) return config.minElementHeight;
  visited.add(primitive.id);
  // ── Heading: level-aware ──────────────────────────────────
  if (primitive.type === "XRHeading") {
    const level = (primitive as { level?: number }).level ?? 2;
    return level === 1 ? 0.07 : level === 2 ? 0.062 : 0.052;
  }

  // ── Paragraph: word-count-aware ──────────────────────────
  //
  // densityScore alone caps at 0.28 m regardless of word count, which means
  // a 500-word paragraph and a 20-word paragraph get nearly the same budget.
  // Long paragraphs then massively overflow the viewport, preventing correct
  // pagination because the engine thinks they fit.
  //
  // Instead: estimate line count from wordCount and the panel's usable width,
  // then derive height from the rendered font metrics.
  //
  //   Renderer font size : 0.026 m  (XRParagraphMesh)
  //   Line height ratio  : 1.55     (XRParagraphMesh)
  //   Line height (m)    : 0.026 × 1.55 = 0.0403 m
  //   Panel usable width : config.maxPanelViewportHeight × 1.4/0.9 ≈ not right;
  //                        use a fixed approximation: 1.32 m (1.4 m panel - 2×0.04 padding)
  //   Avg chars/word     : 5.5 chars including trailing space
  //   Char width (m)     : fontSize × 0.55 ≈ 0.0143 m (proportional font estimate)
  //   Words per line     : floor(panelUsableWidth / (fontSize × 0.55 × avgCharsPerWord))
  //                        = floor(1.32 / (0.026 × 0.55 × 5.5)) = floor(1.32 / 0.0787) ≈ 16
  //
  // Add vertical padding (top + bottom) = 2 × 0.018 m.
  // Floor at 0.052 m (1 line + padding) for single-sentence paragraphs.
  if (primitive.type === "XRParagraph") {
    const wordCount = (primitive as { wordCount?: number }).wordCount ?? 0;
    const density =
      (primitive as { densityScore?: number }).densityScore ?? 0.2;

    if (wordCount > 0) {
      const FONT_SIZE = 0.026; // metres — matches XRParagraphMesh
      const LINE_HEIGHT = FONT_SIZE * 1.55; // = 0.0403 m
      const PANEL_USABLE_W = 1.32; // metres (1.4 m slot - 2×panelPaddingX)
      const CHAR_WIDTH = FONT_SIZE * 0.55; // average proportional char width
      const AVG_CHARS_PER_WORD = 5.5; // chars + space
      const wordsPerLine = Math.max(
        1,
        Math.floor(PANEL_USABLE_W / (CHAR_WIDTH * AVG_CHARS_PER_WORD)),
      );
      const lineCount = Math.ceil(wordCount / wordsPerLine);
      const textHeight = lineCount * LINE_HEIGHT;
      const vertPadding = 0.036; // 0.018 m top + 0.018 m bottom
      return Math.max(0.052, textHeight + vertPadding);
    }

    // Fallback when wordCount is absent: density-based estimate (original formula)
    return 0.07 + density * 0.21;
  }

  // ── Media: strategy-aware ─────────────────────────────────
  if (primitive.type === "XRMediaPlayer") {
    const strategy = (primitive as { sizingStrategy?: string }).sizingStrategy;
    if (strategy === "large-panel") return 1.35; // 16:9 at 2.4 m width
    if (strategy === "ambient") return 0; // renderer places it
    return 0.1; // compact-widget
  }

  // ── Card grid: row-count derived ──────────────────────────
  if (primitive.type === "XRCardGrid") {
    const columns = (primitive as { columns?: number }).columns ?? 2;
    const childCount = primitive.children.length;
    const rows = Math.ceil(childCount / columns);
    // Estimate card height from first child's children, or use a default
    const cardHeight = 0.22;
    return rows * cardHeight + (rows - 1) * config.childGapY;
  }

  // ── Table: row-count derived ─────────────────────────────
  if (primitive.type === "XRTable") {
    const rowCount = (primitive as { rowCount?: number }).rowCount ?? 3;
    const rowHeight = 0.055;
    return rowCount * rowHeight + (rowCount - 1) * config.childGapY;
  }

  // ── Containers: sum children ─────────────────────────────
  const isContainer =
    primitive.type === "XRSection" ||
    primitive.type === "XRArticle" ||
    primitive.type === "XRFormPanel" ||
    primitive.type === "XRFormField" ||
    primitive.type === "XRTabPanel" ||
    primitive.type === "XRContentPanel";

  if (isContainer && primitive.children.length > 0) {
    const childHeights = primitive.children.map((child) =>
      estimateHeight(child, scene, config, depth + 1, visited),
    );
    const total = childHeights.reduce((s, h) => s + h, 0);
    const gaps = config.childGapY * Math.max(0, primitive.children.length - 1);
    const computed =
      config.panelPaddingTop + total + gaps + config.panelPaddingTop;
    return Math.max(computed, config.minElementHeight);
  }

  // ── Lookup table fallback ─────────────────────────────────
  return INTRINSIC_HEIGHT[primitive.type] ?? config.minElementHeight;
}

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

function deg2rad(deg: number): number {
  return (deg * Math.PI) / 180;
}

function zeroRotation(): Rotation3 {
  return { x: 0, y: 0, z: 0 };
}

function zeroVec(): Vec3 {
  return { x: 0, y: 0, z: 0 };
}

/**
 * Compute the x,z position of a panel placed at `angleDeg` from the
 * forward axis (y-up, right-handed) at `distance` metres from origin.
 * angleDeg > 0 → right side; < 0 → left side.
 */
function angularPosition(
  distance: number,
  angleDeg: number,
  eyeY: number,
): Vec3 {
  const rad = deg2rad(angleDeg);
  return {
    x: distance * Math.sin(rad),
    y: eyeY,
    z: -distance * Math.cos(rad),
  };
}

/**
 * Compute the inward-facing rotation for a panel placed at `angleDeg`
 * from the forward axis. Positive angle → panel rotates left (facing user).
 */
function angularRotation(angleDeg: number): Rotation3 {
  return { x: 0, y: -deg2rad(angleDeg), z: 0 };
}

// ─────────────────────────────────────────────────────────────
// Vertical stacker with pagination
// ─────────────────────────────────────────────────────────────

interface StackResult {
  /** LayoutEntry for each direct child (local space). */
  childEntries: LayoutEntry[];
  /**
   * Pagination metadata if the children overflowed the viewport height.
   * Null when everything fits in one page.
   */
  pagination: PaginationMeta | null;
  /** Total stacked height (metres), including top padding. */
  totalHeight: number;
  /**
   * Flat map of primitive ID → page index. Populated by the section-aware
   * paginating path (depth === 0) for every direct child of the panel AND
   * every grandchild that lives inside a section that overflows.
   *
   * The recursive layoutPrimitive walker stamps these values onto the
   * corresponding LayoutEntries so the renderer can filter by pageIndex alone.
   *
   * Empty map when no pagination occurred.
   */
  pageIndexMap: Record<string, number>;
}

/**
 * Stack `children` vertically within a panel of `panelWidth` metres wide.
 *
 * NON-PAGINATING PATH (depth > 0 — any container other than XRContentPanel):
 *   Simple vertical stack. All children placed in sequence. No pageIndexMap.
 *   pageIndex is propagated via inheritedPageIndex in layoutPrimitive.
 *
 * PAGINATING PATH (depth === 0 — called exclusively from XRContentPanel):
 *   Section-aware pagination with pageIndex stamping.
 *
 *   XRContentPanel is the universal container: it holds all page content
 *   (XRSection, XRArticle, XRFormPanel, XRFormField, loose headings, etc.)
 *   and is the sole owner of pagination across all templates.
 *
 *   Rules:
 *   1. Every section-like child (XRSection, XRArticle, XRFormPanel, XRFormField)
 *      always starts on a new page.
 *   2. If a section's children exceed one page height they spill across
 *      consecutive pages — each section child receives its own pageIndex.
 *      The section itself receives the pageIndex of its first child's page.
 *   3. Non-section direct children fill pages with standard overflow splitting.
 *
 *   Output — pageIndexMap: flat { primitiveId → pageIndex } for every direct
 *   child AND every section grandchild. layoutPrimitive stamps these onto
 *   LayoutEntries so the renderer can filter by pageIndex alone.
 *
 * IMPORTANT: the inner section-child overflow loop must NOT call nextPage()
 * because that resets the outer panel-level cursors. It advances pageIdx
 * directly and resets only its own scoped budget variables.
 */
function stackChildren(
  children: XRPrimitive[],
  panelWidth: number,
  scene: SpatialScene,
  config: LayoutConfig,
  depth: number = 0,
): StackResult {
  if (children.length === 0) {
    return {
      childEntries: [],
      pagination: null,
      totalHeight: 0,
      pageIndexMap: {},
    };
  }

  const childWidth = Math.max(0.025, panelWidth - config.panelPaddingX * 2);
  const heights = children.map((c) =>
    estimateHeight(c, scene, config, 0, new Set()),
  );

  const childEntries: LayoutEntry[] = [];

  // ── Non-paginating path ──────────────────────────────────────────────────
  if (depth > 0) {
    let cursorY = -config.panelPaddingTop;
    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      const h = heights[i];
      const gap = i === 0 ? 0 : config.childGapY;
      childEntries.push({
        id: child.id,
        position: { x: config.panelPaddingX, y: cursorY - gap, z: 0 },
        rotation: zeroRotation(),
        size: { width: childWidth, height: h },
        curveRadius: 0,
        worldLocked: true,
      });
      cursorY -= gap + h;
    }

    const totalHeight =
      config.panelPaddingTop +
      heights.reduce((s, h) => s + h, 0) +
      config.childGapY * Math.max(0, children.length - 1) +
      config.panelPaddingTop;

    return { childEntries, pagination: null, totalHeight, pageIndexMap: {} };
  }

  // ── Section-aware paginating path (depth === 0) ──────────────────────────

  const VIEWPORT = config.maxPanelViewportHeight;

  function isSectionLike(p: XRPrimitive): boolean {
    // Container types that group children and always start a fresh page.
    // XRBanner / XRComplementary / XRFooter are top-level landmarks and are
    // never children of XRContentPanel, so they are intentionally excluded.
    return (
      p.type === "XRSection" ||
      p.type === "XRArticle" ||
      p.type === "XRFormPanel" ||
      p.type === "XRFormField"
    );
  }

  /**
   * Recursively stamp every node in a subtree with the given pageIndex.
   * Used so that all descendants of a section — at any depth — are registered
   * in pageIndexMap. layoutPrimitive uses the map for XRContentPanel's direct
   * children and then propagates via inheritedPageIndex; having the full subtree
   * in the map means no node is ever missed regardless of tree depth.
   */
  function stampSubtree(node: XRPrimitive, page: number): void {
    pageIndexMap[node.id] = page;
    for (const child of node.children) {
      stampSubtree(child, page);
    }
  }

  // Flat map of primitive ID → page index.
  // Covers XRContentPanel's direct children and every descendant at any depth.
  const pageIndexMap: Record<string, number> = {};

  // y-position for each direct child (index-aligned with children[])
  const childPositions: Array<{ x: number; y: number; z: number }> = [];

  let pageIdx = 0;
  let pageHeight = config.panelPaddingTop;
  let itemsOnPage = 0;
  let cursorY = -config.panelPaddingTop;

  // pageYOffsets[i] = the positive Y amount the renderer must translate the
  // content group by to bring page i's content to the top of the viewport.
  // Page 0 is always 0. Each page break records Math.abs(cursorY) at that moment
  // as the offset for the new page.
  const pageYOffsets: number[] = [0];

  function nextPage() {
    // Capture the absolute Y depth at the bottom of the current page —
    // this becomes the scroll offset the renderer applies to show the next page.
    pageStartAbsY = Math.abs(cursorY);
    pageYOffsets.push(pageStartAbsY);
    pageIdx += 1;
    pageHeight = config.panelPaddingTop;
    itemsOnPage = 0;
    cursorY = -config.panelPaddingTop;
  }

  // Track the absolute Y depth (positive, in metres) at the start of each page.
  // Updated whenever a page break happens, before cursorY is reset.
  let pageStartAbsY = 0; // page 0 starts at depth 0

  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    const h = heights[i];

    if (isSectionLike(child)) {
      // Sections always start a fresh page
      if (itemsOnPage > 0) nextPage();

      pageIndexMap[child.id] = pageIdx;

      if (child.children.length === 0) {
        childPositions[i] = { x: config.panelPaddingX, y: cursorY, z: 0 };
        pageHeight += h;
        itemsOnPage += 1;
        cursorY -= h;
        continue;
      }

      // Assign pageIndex to every node in each section child's subtree,
      // splitting on overflow.
      // IMPORTANT: do NOT call nextPage() here — that resets the outer
      // panel-level cursors (pageHeight, itemsOnPage, cursorY) which would
      // corrupt overflow detection for siblings that come after this section.
      // We only advance the shared pageIdx counter and reset the inner
      // section-scoped budget trackers.
      const scHeights = child.children.map((sc) =>
        estimateHeight(sc, scene, config, 1, new Set()),
      );

      // The section always starts at the top of a fresh page. pageStartAbsY
      // holds the absolute Y depth at which this page began (set by nextPage()
      // or 0 for page 0). Use it as the base for sub-page offset calculations
      // within this section — not Math.abs(cursorY), which is always just
      // panelPaddingTop immediately after a nextPage() reset.
      const sectionStartAbsY = pageStartAbsY;

      let scPageHeight = config.panelPaddingTop;
      let scItemsOnPage = 0;

      for (let j = 0; j < child.children.length; j++) {
        const sc = child.children[j];
        const sch = scHeights[j];
        const scGap = scItemsOnPage > 0 ? config.childGapY : 0;

        if (scPageHeight + scGap + sch > VIEWPORT && scItemsOnPage > 0) {
          // Section child overflows — advance page index only; outer cursors
          // are NOT touched here to avoid corrupting sibling placement.
          // Capture the Y offset for this new page: section start depth plus
          // however far into the section we've consumed.
          const sectionSubPageAbsY = sectionStartAbsY + scPageHeight;
          pageYOffsets.push(sectionSubPageAbsY);
          pageStartAbsY = sectionSubPageAbsY;
          pageIdx += 1;
          scPageHeight = config.panelPaddingTop;
          scItemsOnPage = 0;
        }

        const g = scItemsOnPage > 0 ? config.childGapY : 0;
        // Stamp sc AND all of sc's descendants with the current page so that
        // inheritedPageIndex propagation in layoutPrimitive reaches every node
        // regardless of how deep the tree goes.
        stampSubtree(sc, pageIdx);
        scPageHeight += g + sch;
        scItemsOnPage += 1;
      }

      // Section's direct entry: always placed at the top of the page it opened.
      // Since sections always force a fresh page, cursorY was reset to
      // -panelPaddingTop at that point.
      childPositions[i] = {
        x: config.panelPaddingX,
        y: -config.panelPaddingTop,
        z: 0,
      };

      // Sync outer page state to the page this section ended on, so the next
      // top-level sibling (if any) starts its overflow check from the right page.
      pageHeight = scPageHeight;
      itemsOnPage = scItemsOnPage;
      cursorY = -(config.panelPaddingTop + scPageHeight);
    } else {
      // Non-section: standard overflow binning.
      // Use stampSubtree so any children of this node (e.g. a loose XRCardGrid
      // or XRTabGroup directly in the panel) also get registered in pageIndexMap.
      const gap = itemsOnPage === 0 ? 0 : config.childGapY;
      if (pageHeight + gap + h > VIEWPORT && itemsOnPage > 0) {
        nextPage();
      }
      const g = itemsOnPage === 0 ? 0 : config.childGapY;
      stampSubtree(child, pageIdx);
      childPositions[i] = { x: config.panelPaddingX, y: cursorY - g, z: 0 };
      pageHeight += g + h;
      itemsOnPage += 1;
      cursorY -= g + h;
    }
  }

  const totalPages = pageIdx + 1;

  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    const h = heights[i];
    const pos = childPositions[i] ?? {
      x: config.panelPaddingX,
      y: -config.panelPaddingTop,
      z: 0,
    };
    childEntries.push({
      id: child.id,
      position: pos,
      rotation: zeroRotation(),
      size: { width: childWidth, height: h },
      curveRadius: 0,
      worldLocked: true,
    });
  }

  const totalHeight =
    config.panelPaddingTop +
    heights.reduce((s, h) => s + h, 0) +
    config.childGapY * Math.max(0, children.length - 1) +
    config.panelPaddingTop;

  const pagination: PaginationMeta | null =
    totalPages > 1
      ? { pageCount: totalPages, pageZStep: config.pageZStep, pageYOffsets }
      : null;

  return { childEntries, pagination, totalHeight, pageIndexMap };
}

// ─────────────────────────────────────────────────────────────
// Recursive layout walker
// ─────────────────────────────────────────────────────────────

/**
 * Walk a primitive and all its descendants, producing a LayoutEntry for each.
 * Top-level entries use the world-space slot placement; all children are
 * stacked in local space by stackChildren.
 *
 * Pagination fires ONLY when the current primitive is an XRContentPanel —
 * it is the universal container and the sole owner of pagination regardless
 * of where it appears in the scene tree. All other container types (XRSection,
 * XRFormPanel, XRFormField, …) are laid out with the non-paginating path and
 * receive their pageIndex via inheritedPageIndex propagation.
 *
 * `inheritedPageIndex` carries a pageIndex value down the recursion tree.
 * When XRContentPanel assigns pageIndex values via pageIndexMap, those values
 * are propagated into every descendant subtree so the renderer can filter
 * visible children by pageIndex alone.
 */
function layoutPrimitive(
  primitive: XRPrimitive,
  worldPosition: Vec3,
  worldRotation: Rotation3,
  worldSize: Size2,
  curveRadius: number,
  worldLocked: boolean,
  scene: SpatialScene,
  config: LayoutConfig,
  entries: Record<string, LayoutEntry>,
  diag: LayoutDiagnostics,
  depth: number = 0,
  inheritedPageIndex?: number,
): void {
  const entry: LayoutEntry = {
    id: primitive.id,
    position: worldPosition,
    rotation: worldRotation,
    size: worldSize,
    curveRadius,
    worldLocked,
  };

  // Stamp the inherited pageIndex if one was passed down
  if (inheritedPageIndex !== undefined) {
    entry.pageIndex = inheritedPageIndex;
  }

  if (primitive.children.length > 0) {
    // Pagination only fires on XRContentPanel — the universal container.
    // Everything else uses the non-paginating stacking path (stackDepth > 0).
    const isContentPanel = primitive.type === "XRContentPanel";
    const stackDepth = isContentPanel ? 0 : 1;

    const { childEntries, pagination, pageIndexMap } = stackChildren(
      primitive.children,
      worldSize.width,
      scene,
      config,
      stackDepth,
    );

    if (pagination) {
      entry.pagination = pagination;
      diag.paginatedPanelCount += 1;
      diag.paginatedPanels.push({
        id: primitive.id,
        pageCount: pagination.pageCount,
      });
    }

    for (let i = 0; i < primitive.children.length; i++) {
      const child = primitive.children[i];
      const childLayoutEntry = childEntries[i];
      if (!childLayoutEntry) continue;

      // pageIndexMap is populated by XRContentPanel's stackChildren call and
      // covers every descendant at every depth via stampSubtree.
      // For XRContentPanel's direct children look up the map (which also covers
      // their subtrees, so inheritedPageIndex will carry the right value all the
      // way down). For every other node, inheritedPageIndex was already set by an
      // ancestor XRContentPanel lookup — propagate it unchanged.
      const childPageIndex = isContentPanel
        ? pageIndexMap[child.id] // direct child of XRContentPanel: use map
        : inheritedPageIndex; // all other nodes: propagate ancestor value

      layoutPrimitive(
        child,
        childLayoutEntry.position,
        childLayoutEntry.rotation,
        childLayoutEntry.size,
        0,
        worldLocked,
        scene,
        config,
        entries,
        diag,
        depth + 1,
        childPageIndex,
      );
    }
  }

  entries[primitive.id] = entry;
  diag.totalPlaced += 1;
}

// ─────────────────────────────────────────────────────────────
// Template slot descriptors
// ─────────────────────────────────────────────────────────────

/**
 * A slot is a named region in the XR scene where a class of landmark
 * panel is placed. Each template defines its own slot set.
 */
interface LandmarkSlot {
  /** World-space position of the panel centre. */
  position: Vec3;
  /** World-space rotation of the panel (radians). */
  rotation: Rotation3;
  /** Preferred size of the panel (metres). */
  size: Size2;
  /** Curvature radius (metres). 0 = flat. */
  curveRadius: number;
  /** World-locked vs head-locked. */
  worldLocked: boolean;
}

type SlotName =
  | "main"
  | "navigation"
  | "complementary"
  | "banner"
  | "footer"
  | "toc"
  | "dialog"
  | "alert";

type SlotMap = Partial<Record<SlotName, LandmarkSlot>>;

// ─────────────────────────────────────────────────────────────
// Template slot factories
// ─────────────────────────────────────────────────────────────

/**
 * DOCUMENT template
 *
 * ```
 * User
 *   ←Nav arc   [  Main content panel  ]
 *              Section 1
 *              Section 2   (paginated if tall)
 *              Section 3
 * ```
 *
 * - Narrow TOC arc on the left at ±30°.
 * - Single wide primary panel straight ahead.
 * - No complementary — full width given to content.
 * - Tighter curve radius for dense reading comfort.
 */
function documentSlots(cfg: LayoutConfig): SlotMap {
  const eyeY = cfg.eyeLevel + cfg.eyeLevelOffset;
  const d = cfg.viewingDistance;
  const halfAngle = cfg.comfortHalfAngleDeg;

  return {
    banner: {
      position: { x: 0, y: eyeY + 0.52, z: -d },
      rotation: zeroRotation(),
      size: { width: 1.4, height: 0.16 },
      curveRadius: d * 0.8,
      worldLocked: true,
    },
    toc: {
      // Left arc at -halfAngle°, slightly closer than main
      position: angularPosition(d * 0.95, -halfAngle, eyeY - 0.05),
      rotation: angularRotation(-halfAngle),
      size: { width: 0.36, height: 0.85 },
      curveRadius: d,
      worldLocked: true,
    },
    navigation: {
      // Also left arc but at -(halfAngle - 8)° — sits between toc and main
      position: angularPosition(d, -(halfAngle - 8), eyeY - 0.05),
      rotation: angularRotation(-(halfAngle - 8)),
      size: { width: 0.32, height: 0.85 },
      curveRadius: d,
      worldLocked: true,
    },
    main: {
      position: { x: 0, y: eyeY, z: -d },
      rotation: zeroRotation(),
      size: { width: 1.4, height: cfg.maxPanelViewportHeight },
      curveRadius: d * 0.8,
      worldLocked: true,
    },
    footer: {
      position: { x: 0, y: eyeY - 0.54, z: -d },
      rotation: zeroRotation(),
      size: { width: 1.4, height: 0.12 },
      curveRadius: d * 0.8,
      worldLocked: true,
    },
    alert: {
      position: { x: 0.4, y: eyeY + 0.35, z: -(d - 0.15) },
      rotation: { x: 0, y: -0.15, z: 0 },
      size: { width: 0.5, height: 0.12 },
      curveRadius: 0,
      worldLocked: false,
    },
    dialog: {
      position: { x: 0, y: eyeY, z: -(d - 0.2) },
      rotation: zeroRotation(),
      size: { width: 0.8, height: 0.6 },
      curveRadius: 0,
      worldLocked: false,
    },
  };
}

/**
 * DASHBOARD template
 *
 * ```
 * User
 *  ←Nav    [ Main / Cards ]   [ Sidebar ]→
 *
 *  Card Card Card
 *  Card Card Card
 * ```
 *
 * - Navigation arc on the far left.
 * - Wide primary panel centred for card grids.
 * - Complementary sidebar on the right at +35°.
 * - Shallow curve for wide-angle content legibility.
 */
function dashboardSlots(cfg: LayoutConfig): SlotMap {
  const eyeY = cfg.eyeLevel + cfg.eyeLevelOffset;
  const d = cfg.viewingDistance;
  const halfAngle = cfg.comfortHalfAngleDeg;

  return {
    banner: {
      position: { x: 0, y: eyeY + 0.5, z: -d },
      rotation: zeroRotation(),
      size: { width: 1.6, height: 0.15 },
      curveRadius: d * 1.2,
      worldLocked: true,
    },
    toc: {
      position: angularPosition(d * 0.95, -halfAngle, eyeY - 0.05),
      rotation: angularRotation(-halfAngle),
      size: { width: 0.36, height: 0.85 },
      curveRadius: d,
      worldLocked: true,
    },
    navigation: {
      position: angularPosition(d, -(halfAngle - 8), eyeY),
      rotation: angularRotation(-(halfAngle - 8)),
      size: { width: 0.32, height: 0.85 },
      curveRadius: d,
      worldLocked: true,
    },
    main: {
      position: { x: 0, y: eyeY, z: -d },
      rotation: zeroRotation(),
      size: { width: 1.4, height: cfg.maxPanelViewportHeight },
      curveRadius: d * 1.2,
      worldLocked: true,
    },
    complementary: {
      // Sidebar pulled to +35° (slightly wider than halfAngle)
      position: angularPosition(d, halfAngle + 5, eyeY),
      rotation: angularRotation(halfAngle + 5),
      size: { width: 0.5, height: 0.85 },
      curveRadius: d,
      worldLocked: true,
    },
    footer: {
      position: { x: 0, y: eyeY - 0.52, z: -d },
      rotation: zeroRotation(),
      size: { width: 1.6, height: 0.1 },
      curveRadius: d * 1.2,
      worldLocked: true,
    },
    alert: {
      position: { x: 0.5, y: eyeY + 0.4, z: -(d - 0.15) },
      rotation: { x: 0, y: -0.18, z: 0 },
      size: { width: 0.5, height: 0.12 },
      curveRadius: 0,
      worldLocked: false,
    },
    dialog: {
      position: { x: 0, y: eyeY, z: -(d - 0.2) },
      rotation: zeroRotation(),
      size: { width: 0.85, height: 0.65 },
      curveRadius: 0,
      worldLocked: false,
    },
  };
}

/**
 * FORM template
 *
 * ```
 * User
 *       [  Form Panel  ]
 *        Field
 *        Field
 *        Field   (paginated into steps if tall)
 *        [ Submit ]
 * ```
 *
 * - Single narrow flat panel dead-centre (no curve — aids input precision).
 * - Navigation hidden behind the panel (z pushed back).
 * - Tall viewport — forms often need many fields without distraction.
 */
function formSlots(cfg: LayoutConfig): SlotMap {
  const eyeY = cfg.eyeLevel + cfg.eyeLevelOffset;
  const d = cfg.viewingDistance;
  const halfAngle = cfg.comfortHalfAngleDeg;

  return {
    banner: {
      position: { x: 0, y: eyeY + 0.58, z: -d },
      rotation: zeroRotation(),
      size: { width: 1.1, height: 0.14 },
      curveRadius: 0,
      worldLocked: true,
    },
    toc: {
      position: angularPosition(d * 0.95, -halfAngle, eyeY - 0.05),
      rotation: angularRotation(-halfAngle),
      size: { width: 0.36, height: 0.85 },
      curveRadius: d,
      worldLocked: true,
    },
    navigation: {
      // Pushed back so it's accessible but not distracting during form entry
      position: { x: -0.65, y: eyeY, z: -(d + 0.4) },
      rotation: angularRotation(-20),
      size: { width: 0.32, height: 0.8 },
      curveRadius: 0,
      worldLocked: true,
    },
    main: {
      // XRContentPanel is the universal container — it holds the XRFormPanel
      // (and all other typed children) and owns pagination.
      // Flat panel (curveRadius: 0) — curved panels make input targets harder to hit.
      position: { x: 0, y: eyeY, z: -d },
      rotation: zeroRotation(),
      size: { width: 1.1, height: cfg.maxPanelViewportHeight },
      curveRadius: 0,
      worldLocked: true,
    },
    alert: {
      // Inline below the form panel
      position: { x: 0, y: eyeY - 0.62, z: -(d - 0.1) },
      rotation: zeroRotation(),
      size: { width: 1.0, height: 0.1 },
      curveRadius: 0,
      worldLocked: true,
    },
    dialog: {
      position: { x: 0, y: eyeY, z: -(d - 0.2) },
      rotation: zeroRotation(),
      size: { width: 0.75, height: 0.6 },
      curveRadius: 0,
      worldLocked: false,
    },
  };
}

/**
 * LANDING template
 *
 * ```
 * User
 *     [       Hero / Main        ]
 *     [ Feature ] [ Feature ] [ Feature ]
 *     ←Nav (bottom arc)
 * ```
 *
 * - Wide primary panel with a larger curve radius (panoramic feel).
 * - Navigation placed below and slightly in front (bottom bar style).
 * - No sidebar — landing pages are one-column.
 */
function landingSlots(cfg: LayoutConfig): SlotMap {
  const eyeY = cfg.eyeLevel + cfg.eyeLevelOffset;
  const d = cfg.viewingDistance;
  const halfAngle = cfg.comfortHalfAngleDeg;

  return {
    banner: {
      position: { x: 0, y: eyeY + 0.54, z: -d },
      rotation: zeroRotation(),
      size: { width: 1.8, height: 0.18 },
      curveRadius: d * 1.4,
      worldLocked: true,
    },
    toc: {
      position: angularPosition(d * 0.95, -halfAngle, eyeY - 0.05),
      rotation: angularRotation(-halfAngle),
      size: { width: 0.36, height: 0.85 },
      curveRadius: d,
      worldLocked: true,
    },
    navigation: {
      // Bottom arc — horizontal nav bar centred below the primary panel
      position: { x: 0, y: eyeY - 0.62, z: -(d - 0.1) },
      rotation: { x: 0.15, y: 0, z: 0 }, // tilt up slightly to face user
      size: { width: 1.6, height: 0.1 },
      curveRadius: d * 1.4,
      worldLocked: true,
    },
    main: {
      position: { x: 0, y: eyeY, z: -d },
      rotation: zeroRotation(),
      size: { width: 1.8, height: cfg.maxPanelViewportHeight },
      curveRadius: d * 1.4,
      worldLocked: true,
    },
    complementary: {
      position: angularPosition(d, halfAngle, eyeY),
      rotation: angularRotation(halfAngle),
      size: { width: 0.42, height: 0.75 },
      curveRadius: d,
      worldLocked: true,
    },
    footer: {
      position: { x: 0, y: eyeY - 0.56, z: -d },
      rotation: zeroRotation(),
      size: { width: 1.8, height: 0.12 },
      curveRadius: d * 1.4,
      worldLocked: true,
    },
    alert: {
      position: { x: 0, y: eyeY + 0.45, z: -(d - 0.15) },
      rotation: zeroRotation(),
      size: { width: 0.6, height: 0.1 },
      curveRadius: 0,
      worldLocked: false,
    },
    dialog: {
      position: { x: 0, y: eyeY, z: -(d - 0.2) },
      rotation: zeroRotation(),
      size: { width: 0.85, height: 0.65 },
      curveRadius: 0,
      worldLocked: false,
    },
  };
}

/**
 * GENERIC template
 *
 * Minimal layout: main panel centred, nav arc on the left, no sidebar.
 * Used as a safe fallback when the page does not match any known template.
 */
function genericSlots(cfg: LayoutConfig): SlotMap {
  const eyeY = cfg.eyeLevel + cfg.eyeLevelOffset;
  const d = cfg.viewingDistance;
  const halfAngle = cfg.comfortHalfAngleDeg;

  return {
    banner: {
      position: { x: 0, y: eyeY + 0.52, z: -d },
      rotation: zeroRotation(),
      size: { width: 1.6, height: 0.16 },
      curveRadius: d,
      worldLocked: true,
    },
    toc: {
      position: angularPosition(d * 0.95, -halfAngle, eyeY - 0.05),
      rotation: angularRotation(-halfAngle),
      size: { width: 0.36, height: 0.85 },
      curveRadius: d,
      worldLocked: true,
    },
    navigation: {
      position: angularPosition(d, -(halfAngle - 8), eyeY - 0.05),
      rotation: angularRotation(-(halfAngle - 8)),
      size: { width: 0.32, height: 0.85 },
      curveRadius: d,
      worldLocked: true,
    },
    main: {
      position: { x: 0, y: eyeY, z: -d },
      rotation: zeroRotation(),
      size: { width: 1.6, height: cfg.maxPanelViewportHeight },
      curveRadius: d,
      worldLocked: true,
    },
    complementary: {
      position: angularPosition(d, halfAngle, eyeY),
      rotation: angularRotation(halfAngle),
      size: { width: 0.42, height: 0.8 },
      curveRadius: d,
      worldLocked: true,
    },
    footer: {
      position: { x: 0, y: eyeY - 0.54, z: -d },
      rotation: zeroRotation(),
      size: { width: 1.6, height: 0.14 },
      curveRadius: d,
      worldLocked: true,
    },
    alert: {
      position: { x: 0.4, y: eyeY + 0.35, z: -(d - 0.15) },
      rotation: { x: 0, y: -0.15, z: 0 },
      size: { width: 0.5, height: 0.12 },
      curveRadius: 0,
      worldLocked: false,
    },
    dialog: {
      position: { x: 0, y: eyeY, z: -(d - 0.2) },
      rotation: zeroRotation(),
      size: { width: 0.8, height: 0.6 },
      curveRadius: 0,
      worldLocked: false,
    },
  };
}

/** Select the slot map for a given layout template. */
function selectSlots(template: LayoutTemplate, cfg: LayoutConfig): SlotMap {
  switch (template) {
    case "document":
      return documentSlots(cfg);
    case "dashboard":
      return dashboardSlots(cfg);
    case "form":
      return formSlots(cfg);
    case "landing":
      return landingSlots(cfg);
    default:
      return genericSlots(cfg);
  }
}

// ─────────────────────────────────────────────────────────────
// Primitive → slot classifier
// ─────────────────────────────────────────────────────────────

/**
 * Classify a top-level XRPrimitive into a SlotName so we know which
 * template slot to assign it to.
 *
 * Only landmark-level primitives (direct children of XRScene) are classified
 * here. Everything else is laid out as children of their parent panel.
 *
 * XRNavigationBar is disambiguated: the synthesised TOC bar (id starts with
 * "toc") goes into the "toc" slot; all other nav bars go to "navigation".
 */
function classifyLandmark(primitive: XRPrimitive): SlotName {
  switch (primitive.type) {
    case "XRContentPanel":
      return "main";
    case "XRNavigationBar":
      // TOC is synthesised with id "toc__nav"; site nav uses the landmark id.
      return primitive.id.startsWith("toc") ? "toc" : "navigation";
    case "XRBanner":
      return "banner";
    case "XRFooter":
      return "footer";
    case "XRComplementary":
      return "complementary";
    case "XRFormPanel":
      // XRFormPanel is a typed child of XRContentPanel, not a sibling landmark.
      // Route to "main" so it is placed inside the universal container and
      // participates in XRContentPanel's pagination rather than owning its own.
      return "main";
    case "XRDialog":
      return "dialog";
    case "XRAlert":
      return "alert";
    default:
      return "main"; // unknown top-level → main slot
  }
}

// ─────────────────────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────────────────────

/**
 * Compute a LayoutPlan for a SpatialScene.
 *
 * Steps:
 *   1. Select the slot map for the given layout template.
 *   2. For each direct child of XRScene, classify it to a slot and assign
 *      the slot's world-space position/size/rotation.
 *   3. Recursively stack and paginate the primitive's children in local space.
 *   4. Collect all entries into the LayoutPlan.
 *
 * The renderer merges each LayoutEntry over its corresponding XRPrimitive
 * by ID, overriding the mapper's placement hints.
 *
 * @param scene     The SpatialScene produced by mapIRToScene.
 * @param template  The layout template (from selectLayoutTemplate or overridden).
 * @param config    Layout configuration. Defaults to DEFAULT_LAYOUT_CONFIG.
 * @returns         A LayoutPlan ready for the XR rendering layer.
 */
export function computeLayoutPlan(
  scene: SpatialScene,
  template: LayoutTemplate,
  config: LayoutConfig = DEFAULT_LAYOUT_CONFIG,
): LayoutPlan {
  const entries: Record<string, LayoutEntry> = {};
  const diag: LayoutDiagnostics = {
    paginatedPanelCount: 0,
    paginatedPanels: [],
    unplacedIds: [],
    totalPlaced: 0,
  };

  const slots = selectSlots(template, config);
  const topLevelPrimitives = scene.root.children;

  // ── 1. Lay out each top-level landmark into its slot ─────
  //
  // Track which slots have been filled. If a template defines a slot that
  // has no corresponding primitive (e.g. no navigation landmark on the page),
  // the slot is simply unused — no entry is emitted for it.
  //
  // If the same slot type appears more than once (e.g. two navigation bars),
  // the second one is placed in the main slot as a fallback.
  const usedSlots = new Set<SlotName>();

  for (const primitive of topLevelPrimitives) {
    let slotName = classifyLandmark(primitive);

    // Fallback: if the slot is already used, place into main
    if (usedSlots.has(slotName) && slotName !== "main") {
      slotName = "main";
    }
    usedSlots.add(slotName);

    const slot = slots[slotName] ?? slots.main;

    if (!slot) {
      // No slot available at all — mark as unplaced and continue
      diag.unplacedIds.push(primitive.id);
      continue;
    }

    // Lay out this primitive and all its descendants
    layoutPrimitive(
      primitive,
      slot.position,
      slot.rotation,
      slot.size,
      slot.curveRadius,
      slot.worldLocked,
      scene,
      config,
      entries,
      diag,
    );
  }

  // ── 2. Emit the XRScene root entry ───────────────────────
  entries[scene.root.id] = {
    id: scene.root.id,
    position: zeroVec(),
    rotation: zeroRotation(),
    size: { width: 0, height: 0 },
    curveRadius: 0,
    worldLocked: true,
  };

  // ── 3. Catch any primitives in scene.primitives that were
  //       not reachable via the scene tree (orphans) ────────
  for (const id of Object.keys(scene.primitives)) {
    if (!entries[id]) {
      diag.unplacedIds.push(id);
    }
  }

  return {
    entries,
    template,
    config,
    diagnostics: diag,
  };
}

// ─────────────────────────────────────────────────────────────
// Convenience re-export: merge LayoutPlan into SpatialScene
// ─────────────────────────────────────────────────────────────

/**
 * Merge a LayoutPlan back into a SpatialScene by overwriting each
 * primitive's `placement` field with the corresponding LayoutEntry.
 *
 * Returns a **new** SpatialScene (does not mutate the input).
 * The renderer can use either the merged scene or the LayoutPlan directly.
 *
 * @param scene  Original SpatialScene from mapIRToScene.
 * @param plan   LayoutPlan from computeLayoutPlan.
 * @returns      A new SpatialScene with resolved placements.
 */
export function mergeLayoutPlan(
  scene: SpatialScene,
  plan: LayoutPlan,
): SpatialScene {
  // Shallow-clone primitive registry; update placement on primitives that
  // have a LayoutEntry, leave the rest untouched.
  const newPrimitives: Record<string, XRPrimitive> = {};
  for (const [id, primitive] of Object.entries(scene.primitives)) {
    const entry = plan.entries[id];
    if (!entry) {
      newPrimitives[id] = primitive;
      continue;
    }

    newPrimitives[id] = {
      ...primitive,
      placement: {
        position: entry.position,
        rotation: entry.rotation,
        preferredSize: entry.size,
        curveRadius: entry.curveRadius,
        worldLocked: entry.worldLocked,
      },
    };
  }

  return {
    ...scene,
    primitives: newPrimitives,
    // Root node rebuilt with updated children (renderer walks newPrimitives)
    root: (newPrimitives[scene.root.id] as typeof scene.root) ?? scene.root,
  };
}
