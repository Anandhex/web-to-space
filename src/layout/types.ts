import type { Vec3, Rotation3, Size2 } from "../mapper/types";
import type { LayoutConfig } from "./engine";

// ─────────────────────────────────────────────────────────────
// Re-exported template type (was previously in mapper.ts)
// ─────────────────────────────────────────────────────────────

/**
 * High-level scene archetype that controls landmark slot placement.
 *
 * Moved from mapper.ts to engine.ts: template selection requires layout
 * geometry knowledge (panel sizes, child counts) that the mapper must not
 * know about.
 */
export type LayoutTemplate =
  | "document" // Long-form article / blog / docs
  | "dashboard" // Data-heavy, card grids, metrics
  | "form" // Single-purpose input page
  | "landing" // Hero + feature sections, marketing
  | "generic"; // Safe fallback

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
   * Continuation metadata for XRParagraph entries that were split across
   * page boundaries by the layout engine.
   *
   * When a paragraph is too tall to fit in the remaining page budget the
   * engine emits the original entry (covering words 0 … splitWordOffset-1)
   * and inserts a synthetic continuation entry for the next page. The
   * continuation entry has `continuationWordOffset` set to the first word
   * that should appear on that page. The renderer slices the paragraph text
   * at this offset instead of rendering the full label.
   *
   * Absent on entries that fit in a single page.
   */
  continuationWordOffset?: number;
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
  template: LayoutTemplate;
  config: LayoutConfig;
  diagnostics: LayoutDiagnostics;
}

export interface LayoutDiagnostics {
  paginatedPanelCount: number;
  paginatedPanels: Array<{ id: string; pageCount: number }>;
  unplacedIds: string[];
  totalPlaced: number;
  /** Primitives whose height was estimated via the fallback floor. */
  fallbackHeightIds: string[];
  /** Continuation paragraph entries injected by the paginator. */
  paragraphContinuations: Array<{
    originalId: string;
    pageIndex: number;
    wordOffset: number;
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
