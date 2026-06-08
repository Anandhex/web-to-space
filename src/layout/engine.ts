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
}

/**
 * Pagination split for a panel whose children exceed its viewport height.
 * Each page contains an ordered list of child primitive IDs.
 * The renderer shows one page at a time and provides a swipe/scroll affordance.
 */
export interface PaginationMeta {
  /** Total number of pages. */
  pageCount: number;
  /**
   * Ordered list of pages. Each page is an ordered list of child IDs
   * that fit within one viewport height of the panel.
   */
  pages: string[][];
  /**
   * Z-offset (metres) applied to each successive page panel.
   * The renderer stacks pages behind each other along the z-axis;
   * the active page is brought forward.
   */
  pageZStep: number;
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

  // ── Paragraph: density-aware ─────────────────────────────
  if (primitive.type === "XRParagraph") {
    const density =
      (primitive as { densityScore?: number }).densityScore ?? 0.2;
    // Low density (short) → 0.07 m; high density (long) → 0.28 m
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
}

/**
 * Stack `children` vertically within a panel of `panelWidth` metres wide.
 * Each child gets a local-space position: x = panelPaddingX, y decreasing
 * downward from panelPaddingTop, z = 0.
 *
 * Pagination only fires for top-level landmark panels (depth === 0).
 * Nested panels always render their full content — inner pagination breaks
 * the layout by duplicating controls and overflowing the parent container.
 *
 * Returns StackResult with child entries in local space and optional
 * PaginationMeta (only when depth === 0 and content overflows).
 */
function stackChildren(
  children: XRPrimitive[],
  panelWidth: number,
  scene: SpatialScene,
  config: LayoutConfig,
  depth: number = 0,
): StackResult {
  if (children.length === 0) {
    return { childEntries: [], pagination: null, totalHeight: 0 };
  }

  const childWidth = Math.max(0.025, panelWidth - config.panelPaddingX * 2);
  const heights = children.map((c) =>
    estimateHeight(c, scene, config, 0, new Set()),
  );

  const childEntries: LayoutEntry[] = [];
  const pages: string[][] = [];
  let currentPage: string[] = [];
  let currentPageHeight = 0;
  let cursorY = -config.panelPaddingTop;

  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    const h = heights[i];
    const entryGap = currentPage.length === 0 ? 0 : config.childGapY;

    // Enforcement: ONLY paginate if we are at the top-level landmark panel (depth === 0).
    // Nested panels just stack naturally so their total intrinsic height is computed.
    const wouldOverflow =
      depth === 0 &&
      currentPageHeight + entryGap + h > config.maxPanelViewportHeight &&
      currentPage.length > 0;

    if (wouldOverflow) {
      pages.push(currentPage);
      currentPage = [];
      currentPageHeight = 0;
      cursorY = -config.panelPaddingTop;
    }

    const gap = currentPage.length === 0 ? 0 : config.childGapY;

    const entry: LayoutEntry = {
      id: child.id,
      position: { x: config.panelPaddingX, y: cursorY - gap, z: 0 },
      rotation: zeroRotation(),
      size: { width: childWidth, height: h },
      curveRadius: 0,
      worldLocked: true,
    };

    childEntries.push(entry);
    currentPage.push(child.id);
    currentPageHeight += gap + h;
    cursorY -= gap + h;
  }

  if (currentPage.length > 0) pages.push(currentPage);

  const totalHeight =
    config.panelPaddingTop +
    heights.reduce((s, h) => s + h, 0) +
    config.childGapY * Math.max(0, children.length - 1) +
    config.panelPaddingTop;

  const pagination: PaginationMeta | null =
    pages.length > 1
      ? { pageCount: pages.length, pages, pageZStep: config.pageZStep }
      : null;

  return { childEntries, pagination, totalHeight };
}

// ─────────────────────────────────────────────────────────────
// Recursive layout walker
// ─────────────────────────────────────────────────────────────

/**
 * Walk a primitive and all its descendants, producing a LayoutEntry for each.
 * Top-level entries use `worldPlacement`; all children are stacked in local space.
 * `depth` tracks nesting level — pagination is only allowed at depth 0.
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
): void {
  // Create the entry for this primitive
  const entry: LayoutEntry = {
    id: primitive.id,
    position: worldPosition,
    rotation: worldRotation,
    size: worldSize,
    curveRadius,
    worldLocked,
  };

  // Stack children in local space
  if (primitive.children.length > 0) {
    const {
      childEntries,
      pagination,
      totalHeight: _totalHeight,
    } = stackChildren(
      primitive.children,
      worldSize.width,
      scene,
      config,
      depth,
    );

    if (pagination) {
      entry.pagination = pagination;
      diag.paginatedPanelCount += 1;
      diag.paginatedPanels.push({
        id: primitive.id,
        pageCount: pagination.pageCount,
      });
    }

    // Register child entries and recurse
    for (let i = 0; i < primitive.children.length; i++) {
      const child = primitive.children[i];
      const childLayoutEntry = childEntries[i];
      if (!childLayoutEntry) continue;

      layoutPrimitive(
        child,
        childLayoutEntry.position,
        childLayoutEntry.rotation,
        childLayoutEntry.size,
        0, // children are flat within their parent
        worldLocked,
        scene,
        config,
        entries,
        diag,
        depth + 1, // increment depth so nested panels never paginate
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
  | "form"
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
      // Forms are flat (curveRadius: 0) — curved panels make input targets harder to hit
      position: { x: 0, y: eyeY, z: -d },
      rotation: zeroRotation(),
      size: { width: 1.1, height: 1.1 },
      curveRadius: 0,
      worldLocked: true,
    },
    form: {
      // Explicit form slot — same position as main (form landmark inside main)
      position: { x: 0, y: eyeY, z: -d },
      rotation: zeroRotation(),
      size: { width: 1.0, height: 1.0 },
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
      return "form";
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
