/**
 * engine.ts — XR Spatial Layout Engine (v2)
 *
 * Architecture position:
 *   HTML → Parser → IR → Mapper → SemanticScene
 *                                       ↓
 *                               Layout Engine (this file)
 *                                       ↓
 *                                  LayoutPlan
 *                                       ↓
 *                                XR Renderer
 *
 * Key design changes from v1
 * ──────────────────────────
 * • All font sizes, line heights, element heights and panel dimensions are
 *   supplied via a typed `RenderMetrics` object rather than being hardcoded
 *   constants. The engine never guesses metrics — if a value is absent the
 *   engine falls back to `RenderMetrics.fallbackElementHeight` and records
 *   a diagnostic warning.
 *
 * • Named `DeviceProfile` presets (Quest 3, Quest Pro, Ray-Ban Meta, etc.)
 *   ship ready to use. Calling code can override any field.
 *
 * • Template selection lives here (not in the mapper). `selectLayoutTemplate`
 *   inspects the SemanticScene and returns the best-fit template. Callers may
 *   override via the `template` parameter of `computeLayoutPlan`.
 *
 * • Paragraph overflow produces *continuation nodes* — synthetic XRParagraph
 *   entries that carry the word-offset at which rendering should resume. The
 *   renderer uses `continuationWordOffset` to skip already-shown words and
 *   resume text mid-paragraph across page boundaries.
 *
 * • XRTable layout strategy ("flat-2d" | "curved-2d" | "scrollable" | "cards")
 *   is decided here from column/row counts and available panel width.
 *
 * • XRList column count is resolved here from child count and panel width.
 *
 * Design principles (unchanged from v1)
 * ──────────────────────────────────────
 * 1. Pure function: (SemanticScene, LayoutConfig) → LayoutPlan. No side-effects.
 * 2. XRContentPanel is the sole owner of pagination.
 * 3. All measurements in metres (WebXR right-handed coordinate system).
 * 4. Every primitive receives a LayoutEntry regardless of depth.
 */

import type {
  Vec3,
  Rotation3,
  Size2,
  XRPrimitiveType,
  XRPrimitive,
  XRHeading,
  XRParagraph,
  XRTable,
  XRList,
  XRMediaPlayer,
  SemanticScene,
} from "../mapper/types";
import type {
  PrimitiveFontMetrics,
  FixedHeightMetrics,
  TextBearingMetrics,
  DeviceProfile,
  LayoutTemplate,
  RenderMetrics,
  LayoutEntry,
  PaginationMeta,
  LayoutDiagnostics,
  LayoutPlan,
} from "./types";

// ── Shared metric helpers ────────────────────────────────────

function paragraphMetrics(
  fontSize: number,
  lineHeightRatio = 1.55,
  verticalPadding = 0.036,
  charWidthRatio = 0.55,
  avgCharsPerWord = 5.5,
): PrimitiveFontMetrics {
  return {
    fontSize,
    lineHeightRatio,
    verticalPadding,
    charWidthRatio,
    avgCharsPerWord,
  };
}

function fixed(height: number): FixedHeightMetrics {
  return { height };
}

/**
 * Construct a TextBearingMetrics for interactive elements whose label may wrap.
 *
 * @param minHeight  Minimum height in metres (single-line + internal padding).
 * @param fontSize   Font size in metres for the label.
 * @param lineHeightRatio  Line height multiplier (default 1.3 — tighter than body).
 * @param charWidthRatio   Average char width as fraction of fontSize.
 * @param avgCharsPerWord  Avg chars per word incl. trailing space.
 */
function textBearing(
  minHeight: number,
  fontSize: number,
  lineHeightRatio = 1.3,
  charWidthRatio = 0.55,
  avgCharsPerWord = 6.0,
): TextBearingMetrics {
  return {
    minHeight,
    font: {
      fontSize,
      lineHeightRatio,
      verticalPadding: minHeight - fontSize * lineHeightRatio, // internal padding = minHeight minus one line
      charWidthRatio,
      avgCharsPerWord,
    },
  };
}

// ── Quest 3 ──────────────────────────────────────────────────

/**
 * Meta Quest 3 profile.
 *
 * Viewing distance 1.2 m. Wide 110° FOV. Standing user (eyeLevel 1.5 m).
 * Font sizes chosen so text subtends ~0.5° per line-cap-height at 1.2 m
 * (comfortable mixed-reality reading per XR UX guidelines).
 *
 * Renderer reference: XRParagraphMesh uses fontSize=0.026, lineHeight=1.55.
 */
export const QUEST_3_PROFILE: DeviceProfile = {
  name: "Meta Quest 3",
  layoutConfig: {
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
  },
  renderMetrics: {
    paragraph: paragraphMetrics(0.026),
    heading: {
      1: paragraphMetrics(0.048, 1.3, 0.024),
      2: paragraphMetrics(0.038, 1.35, 0.02),
      3: paragraphMetrics(0.03, 1.4, 0.018),
      4: paragraphMetrics(0.026, 1.4, 0.016),
      5: paragraphMetrics(0.024, 1.45, 0.014),
      6: paragraphMetrics(0.022, 1.45, 0.012),
    },
    codeBlock: paragraphMetrics(0.022, 1.5, 0.028, 0.6, 4.5),
    blockQuote: paragraphMetrics(0.025, 1.6, 0.032),
    button: textBearing(0.055, 0.022),
    toggle: fixed(0.05),
    slider: fixed(0.06),
    comboBox: fixed(0.055),
    searchBox: fixed(0.055),
    progressBar: fixed(0.04),
    link: textBearing(0.045, 0.022),
    separator: fixed(0.01),
    tab: textBearing(0.055, 0.022),
    tabGroup: fixed(0.065),
    menuItem: textBearing(0.045, 0.022),
    treeItem: textBearing(0.045, 0.022),
    alert: textBearing(0.08, 0.024),
    tooltip: textBearing(0.06, 0.022),
    listItem: textBearing(0.22, 0.024),
    figureCaption: paragraphMetrics(0.02, 1.4, 0.012),
    image: fixed(0.3),
    mediaPlayerCompact: fixed(0.1),
    mediaPlayerLarge: fixed(1.35),
    minCardWidth: 0.3,
    maxCardColumns: 4,
    tableRowHeight: 0.055,
    tableHeaderRowHeight: 0.065,
    tableMaxFlatColumns: 4,
    tableMaxFlatRows: 8,
    banner: fixed(0.16),
    footer: fixed(0.12),
    navigationBar: fixed(0.85),
    fallbackElementHeight: 0.04,
  },
};

/**
 * Meta Quest Pro profile.
 *
 * Same distance as Quest 3 but larger FOV (106°). Slightly tighter font
 * sizes because the higher-resolution pancake lenses read smaller text well.
 * Wider main panel (1.6 m vs 1.4 m) exploits the wider comfort envelope.
 */
export const QUEST_PRO_PROFILE: DeviceProfile = {
  name: "Meta Quest Pro",
  layoutConfig: {
    viewingDistance: 1.2,
    comfortHalfAngleDeg: 33,
    eyeLevel: 1.5,
    eyeLevelOffset: -0.1,
    panelCurveRadius: 1.2,
    childGapY: 0.018,
    panelPaddingTop: 0.04,
    panelPaddingX: 0.04,
    maxPanelViewportHeight: 0.95,
    pageZStep: 0.05,
  },
  renderMetrics: {
    ...QUEST_3_PROFILE.renderMetrics,
    paragraph: paragraphMetrics(0.024),
    heading: {
      1: paragraphMetrics(0.044, 1.3, 0.022),
      2: paragraphMetrics(0.034, 1.35, 0.018),
      3: paragraphMetrics(0.027, 1.4, 0.016),
      4: paragraphMetrics(0.024, 1.4, 0.014),
      5: paragraphMetrics(0.022, 1.45, 0.013),
      6: paragraphMetrics(0.02, 1.45, 0.012),
    },
    codeBlock: paragraphMetrics(0.02, 1.5, 0.026, 0.6, 4.5),
    listItem: textBearing(0.22, 0.024),
    maxCardColumns: 5,
    tableMaxFlatColumns: 5,
  },
};

/**
 * Ray-Ban Meta (glasses) profile.
 *
 * Very small display panel. Minimal comfort FOV (±15°). Closer viewing
 * distance (~0.6 m — near-eye display). Much larger font sizes needed
 * for legibility. Single-column only; no card grids or wide tables.
 */
export const RAY_BAN_META_PROFILE: DeviceProfile = {
  name: "Ray-Ban Meta",
  layoutConfig: {
    viewingDistance: 0.6,
    comfortHalfAngleDeg: 15,
    eyeLevel: 1.5,
    eyeLevelOffset: -0.05,
    panelCurveRadius: 0.6,
    childGapY: 0.015,
    panelPaddingTop: 0.025,
    panelPaddingX: 0.025,
    maxPanelViewportHeight: 0.4,
    pageZStep: 0.03,
  },
  renderMetrics: {
    paragraph: paragraphMetrics(0.018, 1.6, 0.022, 0.55, 5.5),
    heading: {
      1: paragraphMetrics(0.03, 1.3, 0.016),
      2: paragraphMetrics(0.025, 1.35, 0.014),
      3: paragraphMetrics(0.02, 1.4, 0.012),
      4: paragraphMetrics(0.018, 1.4, 0.01),
      5: paragraphMetrics(0.016, 1.45, 0.01),
      6: paragraphMetrics(0.015, 1.45, 0.01),
    },
    codeBlock: paragraphMetrics(0.015, 1.5, 0.018, 0.6, 4.5),
    blockQuote: paragraphMetrics(0.017, 1.6, 0.02),
    button: textBearing(0.035, 0.015),
    toggle: fixed(0.032),
    slider: fixed(0.038),
    comboBox: fixed(0.035),
    searchBox: fixed(0.035),
    progressBar: fixed(0.028),
    link: textBearing(0.03, 0.015),
    separator: fixed(0.006),
    tab: textBearing(0.032, 0.015),
    tabGroup: fixed(0.04),
    menuItem: textBearing(0.03, 0.015),
    treeItem: textBearing(0.03, 0.015),
    alert: textBearing(0.05, 0.016),
    tooltip: textBearing(0.04, 0.015),
    listItem: textBearing(0.12, 0.015),
    figureCaption: paragraphMetrics(0.013, 1.4, 0.008),
    image: fixed(0.16),
    mediaPlayerCompact: fixed(0.07),
    mediaPlayerLarge: fixed(0.38),
    minCardWidth: 0.18,
    maxCardColumns: 2,
    tableRowHeight: 0.032,
    tableHeaderRowHeight: 0.038,
    tableMaxFlatColumns: 2,
    tableMaxFlatRows: 5,
    banner: fixed(0.09),
    footer: fixed(0.07),
    navigationBar: fixed(0.4),
    fallbackElementHeight: 0.025,
  },
};

// ─────────────────────────────────────────────────────────────
// Layout configuration (spatial parameters, not render metrics)
// ─────────────────────────────────────────────────────────────

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
  /** Vertical gap between stacked child primitives (m). */
  childGapY: number;
  /** Top padding inside a panel before the first child (m). */
  panelPaddingTop: number;
  /** Left/right padding inside a panel (m). */
  panelPaddingX: number;
  /** Maximum panel viewport height before pagination fires (m). */
  maxPanelViewportHeight: number;
  /** Z-offset between successive pages of a paginated panel (m). */
  pageZStep: number;
}

// ─────────────────────────────────────────────────────────────
// Template selection
// ─────────────────────────────────────────────────────────────

/**
 * Inspect a SemanticScene and select the best-fit layout template.
 *
 * Decision logic:
 *  - "form"      — XRFormPanel present as a main-slot child, no long-form text
 *  - "dashboard" — XRList child count > threshold, or many XRTable nodes
 *  - "landing"   — XRBanner present, few sections, short total text
 *  - "document"  — default for long-form content (articles, docs, blogs)
 *  - "generic"   — fallback
 *
 * Callers may override by passing an explicit `template` to `computeLayoutPlan`.
 */
export function selectLayoutTemplate(scene: SemanticScene): LayoutTemplate {
  const children = scene.root.children;

  let hasForm = false;
  let hasBanner = false;
  let listCount = 0;
  let tableCount = 0;
  let sectionCount = 0;
  let totalWordCount = 0;

  function walk(primitives: XRPrimitive[]): void {
    for (const p of primitives) {
      if (p.type === "XRFormPanel") hasForm = true;
      if (p.type === "XRBanner") hasBanner = true;
      if (p.type === "XRList") listCount++;
      if (p.type === "XRTable") tableCount++;
      if (p.type === "XRSection" || p.type === "XRArticle") sectionCount++;
      if (p.type === "XRParagraph") {
        totalWordCount += (p as XRParagraph).wordCount ?? 0;
      }
      if (p.children.length > 0) walk(p.children);
    }
  }
  walk(children);

  if (hasForm && totalWordCount < 300) return "form";
  if (listCount >= 2 || tableCount >= 2) return "dashboard";
  if (hasBanner && sectionCount <= 3 && totalWordCount < 600) return "landing";
  if (totalWordCount > 200 || sectionCount >= 2) return "document";
  return "generic";
}

// ─────────────────────────────────────────────────────────────
// Metric-driven height estimation
// ─────────────────────────────────────────────────────────────

/**
 * Estimate the rendered height of a text-bearing interactive element
 * (button, link, menu item, tab, alert, tooltip, list item, card).
 *
 * If the element's label fits on one line the result is `tb.minHeight`.
 * If the label wraps to N lines the result grows: the extra lines are added
 * on top of `tb.minHeight` using the element's line height.
 *
 * @param label           The visible label text (may be empty / undefined).
 * @param panelUsableWidth Width of the containing panel minus padding (m).
 * @param tb              TextBearingMetrics for this element type.
 * @param fallback        Fallback height if tb metrics are degenerate.
 */
function estimateTextBearingHeight(
  label: string | undefined,
  panelUsableWidth: number,
  tb: TextBearingMetrics,
  fallback: number,
): number {
  const wordCount = countWords(label ?? "");
  if (wordCount === 0) return tb.minHeight;
  const lineH = tb.font.fontSize * tb.font.lineHeightRatio;
  if (lineH <= 0) return fallback;
  const wordsPerLine = computeWordsPerLine(panelUsableWidth, tb.font);
  const lineCount = Math.ceil(wordCount / wordsPerLine);
  if (lineCount <= 1) return tb.minHeight;
  // Extra lines beyond the first grow the element.
  return tb.minHeight + (lineCount - 1) * lineH;
}
/**
 * Estimate the rendered height of any primitive.
 *
 * Resolution order
 * ────────────────
 * 1. Type-specific formulas for primitives whose height cannot be derived from
 *    children or a label alone:
 *      XRHeading      — level-aware metrics + word-wrap
 *      XRParagraph    — word-count formula (drives pagination accuracy)
 *      XRCodeBlock    — newline count × line height
 *      XRBlockQuote   — word-count formula with blockQuote metrics
 *      XRMediaPlayer  — sizing-strategy resolution (large / compact / ambient)
 *      XRFigure       — fixed image height + caption word-wrap
 *      XRTable        — row/column formula
 *      XRList         — grid layout (columns × per-card height)
 *      text-bearing   — XRButton/XRLink/XRTab/… label wrap + children
 *
 * 2. Universal fallback (everything else — XRGenericPanel, XRSection, XRBanner,
 *    XRFooter, XRNavigationBar, XRContentPanel, and any future unknown type):
 *      Stage 1 — children present  → sum child heights recursively
 *                                    (with childGapY gaps + panelPaddingTop×2)
 *                                    floored by FIXED_HEIGHT_LOOKUP if defined
 *      Stage 2 — no children, label present → paragraph-metric word-wrap
 *                                    floored by FIXED_HEIGHT_LOOKUP if defined
 *      Stage 3 — no children, no label     → FIXED_HEIGHT_LOOKUP ?? fallback
 *
 * This means a new primitive type is automatically handled correctly without
 * any change here — as long as it has children, a label, or a fixed metric.
 *
 * @param primitive        The primitive to measure.
 * @param panelUsableWidth Width of the containing panel minus left/right padding (m).
 * @param metrics          Render metrics for the target device.
 * @param config           Layout config (needed for gap and padding values).
 * @param visited          Cycle guard; pass `new Set()` at the call site.
 * @param scene            Optional scene reference for context-aware decisions
 *                         (e.g. XRMediaPlayer parent lookup).
 * @returns                Estimated height in metres.
 */
function estimateHeight(
  primitive: XRPrimitive,
  panelUsableWidth: number,
  metrics: RenderMetrics,
  config: LayoutConfig,
  visited: Set<string> = new Set(),
  scene?: SemanticScene,
): number {
  if (visited.has(primitive.id)) return metrics.fallbackElementHeight;
  visited.add(primitive.id);

  // ── Heading ────────────────────────────────────────────────────────────────
  if (primitive.type === "XRHeading") {
    const level = ((primitive as XRHeading).level ?? 2) as
      | 1
      | 2
      | 3
      | 4
      | 5
      | 6;
    const m = metrics.heading[level] ?? metrics.heading[2] ?? metrics.paragraph;
    const lineH = m.fontSize * m.lineHeightRatio;
    const wordCount = countWords(primitive.label ?? "");
    if (wordCount <= 1) {
      // Single word or empty — always one line.
      return lineH + m.verticalPadding;
    }
    // Headings can wrap on narrow panels (e.g. Ray-Ban, sidebar slots).
    const wordsPerLine = computeWordsPerLine(panelUsableWidth, m);
    const lineCount = Math.ceil(wordCount / wordsPerLine);
    return lineCount * lineH + m.verticalPadding;
  }

  // ── Paragraph (word-count based) ──────────────────────────────────────────
  if (primitive.type === "XRParagraph") {
    return estimateParagraphHeight(
      primitive as XRParagraph,
      panelUsableWidth,
      metrics,
    );
  }

  // ── Code block (line-count based, same formula as paragraph) ──────────────
  if (primitive.type === "XRCodeBlock") {
    // Code blocks store their text in `label`; estimate lines from that.
    const text = primitive.label ?? "";
    const lineCount = Math.max(1, text.split("\n").length);
    const m = metrics.codeBlock;
    const lineH = m.fontSize * m.lineHeightRatio;
    return Math.max(
      metrics.fallbackElementHeight,
      lineCount * lineH + m.verticalPadding,
    );
  }

  // ── Block quote ────────────────────────────────────────────────────────────
  if (primitive.type === "XRBlockQuote") {
    const wordCount = countWords(primitive.label ?? "");
    if (wordCount > 0) {
      const m = metrics.blockQuote;
      const lineH = m.fontSize * m.lineHeightRatio;
      const wordsPerLine = computeWordsPerLine(panelUsableWidth, m);
      const lineCount = Math.ceil(wordCount / wordsPerLine);
      return lineCount * lineH + m.verticalPadding;
    }
    return (
      metrics.blockQuote.fontSize * metrics.blockQuote.lineHeightRatio +
      metrics.blockQuote.verticalPadding
    );
  }

  // ── Media player ────────────────────────────────────────────────────────────
  // Sizing strategy is resolved here from structural cues, not delegated to the mapper.
  //
  // Rules (in priority order):
  //   1. If the mapper already stamped a strategy, honour it (backward compat).
  //   2. A player that is the *only* child of an XRContentPanel (top-level) and
  //      has no sibling text → "large-panel" (immersive cinema mode).
  //   3. A player whose parent has ≥ 3 other children → "compact" (inline/embedded).
  //   4. A player tagged as background/ambient (mediaRole === "ambient") → "ambient".
  //   5. Default → "compact".
  if (primitive.type === "XRMediaPlayer") {
    const player = primitive as XRMediaPlayer & {
      sizingStrategy?: string;
      mediaRole?: string;
    };

    // 1. Mapper-stamped strategy takes precedence.
    if (player.sizingStrategy === "large-panel")
      return metrics.mediaPlayerLarge.height;
    if (player.sizingStrategy === "ambient") return 0;
    if (player.sizingStrategy === "compact")
      return metrics.mediaPlayerCompact.height;

    // 2. Ambient role → invisible in panel.
    if (player.mediaRole === "ambient") return 0;

    // 3. Resolve from parent context via scene lookup.
    const parentId = (player as unknown as { parentId?: string }).parentId;
    if (parentId) {
      const parentPrimitive = (
        scene as SemanticScene & { primitives: Record<string, XRPrimitive> }
      ).primitives[parentId];
      if (parentPrimitive) {
        const siblings = parentPrimitive.children;
        const isOnlyMediaChild =
          siblings.length === 1 ||
          siblings.every(
            (s: XRPrimitive) =>
              s.id === player.id || s.type === "XRMediaPlayer",
          );
        const isTopLevelPanel = parentPrimitive.type === "XRContentPanel";
        if (isTopLevelPanel && isOnlyMediaChild) {
          return metrics.mediaPlayerLarge.height;
        }
        if (siblings.length >= 4) {
          return metrics.mediaPlayerCompact.height;
        }
      }
    }

    // 4. Default → compact.
    return metrics.mediaPlayerCompact.height;
  }

  // ── Text-bearing interactive elements ─────────────────────────────────────
  // These elements have labels that may wrap across lines when the panel is
  // narrow. We compute actual wrap height instead of using a fixed floor.
  // Children (e.g. nested icons, badges, sub-labels) are summed on top of the
  // label height so the element never clips its own content.
  {
    type TextBearingKey =
      | "XRButton"
      | "XRLink"
      | "XRTab"
      | "XRMenuItem"
      | "XRTreeItem"
      | "XRAlert"
      | "XRTooltip"
      | "XRListItem";
    const TEXT_BEARING_MAP: Partial<
      Record<TextBearingKey, TextBearingMetrics>
    > = {
      XRButton: metrics.button,
      XRLink: metrics.link,
      XRTab: metrics.tab,
      XRMenuItem: metrics.menuItem,
      XRTreeItem: metrics.treeItem,
      XRAlert: metrics.alert,
      XRTooltip: metrics.tooltip,
      XRListItem: metrics.listItem,
    };
    const tb = TEXT_BEARING_MAP[primitive.type as TextBearingKey];
    if (tb !== undefined) {
      // Label-based height floor.
      const labelHeight = estimateTextBearingHeight(
        primitive.label ?? "",
        panelUsableWidth,
        tb,
        metrics.fallbackElementHeight,
      );

      // Add child content height if present (e.g. XRAlert with body paragraphs,
      // XRTreeItem with nested items, XRListItem with rich content).
      if (primitive.children.length > 0) {
        const childrenHeight = primitive.children.reduce(
          (sum: number, child: XRPrimitive, idx: number) => {
            const gap = idx === 0 ? 0 : config.childGapY;
            return (
              sum +
              gap +
              estimateHeight(child, panelUsableWidth, metrics, config, visited)
            );
          },
          0,
        );
        return Math.max(labelHeight, tb.minHeight + childrenHeight);
      }

      return labelHeight;
    }
  }

  // ── Figure: image height + variable-length caption ────────────────────────
  if (primitive.type === "XRFigure") {
    const imageH = metrics.image.height;
    const captionLabel = primitive.label ?? "";
    if (captionLabel.trim() === "") return imageH;
    const captionH = (() => {
      const m = metrics.figureCaption;
      const wordCount = countWords(captionLabel);
      if (wordCount === 0) return 0;
      const lineH = m.fontSize * m.lineHeightRatio;
      const wordsPerLine = computeWordsPerLine(panelUsableWidth, m);
      const lineCount = Math.ceil(wordCount / wordsPerLine);
      return lineCount * lineH + m.verticalPadding;
    })();
    return imageH + captionH;
  }

  // ── Card grid: per-card height is text-bearing ──────────────────────────
  // Override: each XRListItem label can wrap.
  if (primitive.type === "XRList") {
    const columns = resolveListColumns(
      primitive as XRList,
      panelUsableWidth,
      metrics,
    );
    const cardUsableWidth = Math.max(
      0.025,
      panelUsableWidth / Math.max(1, columns),
    );
    // Measure each card's actual height (wrapping its own label + any child content).
    const cardHeights =
      primitive.children.length > 0
        ? primitive.children.map((item: XRPrimitive) => {
            const labelH = estimateTextBearingHeight(
              item.label ?? "",
              cardUsableWidth,
              metrics.listItem,
              metrics.fallbackElementHeight,
            );
            if (item.children.length > 0) {
              const childrenH = item.children.reduce(
                (sum: number, child: XRPrimitive, idx: number) => {
                  const gap = idx === 0 ? 0 : config.childGapY;
                  return (
                    sum +
                    gap +
                    estimateHeight(
                      child,
                      cardUsableWidth,
                      metrics,
                      config,
                      visited,
                    )
                  );
                },
                0,
              );
              return Math.max(labelH, metrics.listItem.minHeight + childrenH);
            }
            return labelH;
          })
        : [metrics.listItem.minHeight];
    // Group cards into rows and sum per-row max height.
    const rowCount = Math.ceil(
      primitive.children.length / Math.max(1, columns),
    );
    let totalCardH = 0;
    for (let row = 0; row < rowCount; row++) {
      const start = row * columns;
      const end = Math.min(start + columns, cardHeights.length);
      const rowH = Math.max(...cardHeights.slice(start, end));
      totalCardH += rowH;
    }
    const gaps = config.childGapY * Math.max(0, rowCount - 1);
    return totalCardH + gaps;
  }

  if (primitive.type === "XRTable") {
    const { rowCount } = primitive as XRTable;
    return (
      metrics.tableHeaderRowHeight +
      Math.max(0, rowCount - 1) * metrics.tableRowHeight +
      rowCount * config.childGapY
    );
  }

  // ── Universal fallback: children → label → fixed lookup → fallback ──────────
  //
  // All remaining types (named containers, XRGenericPanel, and any future
  // unknown primitive) go through a single three-stage resolution rather than
  // an ever-growing list of named type checks:
  //
  //   Stage 1 — Children present
  //     Sum child heights recursively (with childGapY between them and
  //     panelPaddingTop on both ends).  For primitives that have a fixed-height
  //     floor in RenderMetrics (XRBanner, XRFooter, XRNavigationBar) the
  //     children-derived height is taken as a *minimum* so the element never
  //     shrinks below its designed baseline.
  //
  //   Stage 2 — No children, but label present
  //     Estimate from the label as a single-line or wrapping text block using
  //     the paragraph metrics (best available generic metric for unknown types).
  //     If the fixed-height lookup has an entry it serves as a floor here too,
  //     so e.g. an XRToggle with a label never becomes taller than its knob.
  //
  //   Stage 3 — No children, no label
  //     Return the fixed-height lookup value if one exists, otherwise
  //     fallbackElementHeight.
  //
  // This means XRGenericPanel, future XRCustomCard, or any mapper-introduced
  // type automatically gets correct height estimation without a code change here.

  // Fixed-height floor for this type, if any (used in stages 1 and 2).
  const fixedFloor = FIXED_HEIGHT_LOOKUP(metrics)[primitive.type];

  // Stage 1: has children — sum them recursively.
  if (primitive.children.length > 0) {
    const childHeights = primitive.children.map((c: XRPrimitive) =>
      estimateHeight(c, panelUsableWidth, metrics, config, visited, scene),
    );
    const total = childHeights.reduce((s: number, h: number) => s + h, 0);
    const gaps = config.childGapY * Math.max(0, primitive.children.length - 1);
    const fromChildren =
      config.panelPaddingTop + total + gaps + config.panelPaddingTop;
    // Honour any fixed floor (e.g. XRBanner must be at least metrics.banner.height).
    return fixedFloor !== undefined
      ? Math.max(fixedFloor, fromChildren)
      : Math.max(metrics.fallbackElementHeight, fromChildren);
  }

  // Stage 2: no children, label available — estimate as wrapping text.
  const labelText = primitive.label ?? "";
  if (labelText.trim() !== "") {
    const wordCount = countWords(labelText);
    const m = metrics.paragraph; // best generic metric for unknown types
    const lineH = m.fontSize * m.lineHeightRatio;
    const wordsPerLine = computeWordsPerLine(panelUsableWidth, m);
    const lineCount = Math.max(1, Math.ceil(wordCount / wordsPerLine));
    const fromLabel = lineCount * lineH + m.verticalPadding;
    return fixedFloor !== undefined
      ? Math.max(fixedFloor, fromLabel)
      : fromLabel;
  }

  // Stage 3: no children, no label — fixed lookup or fallback.
  return fixedFloor ?? metrics.fallbackElementHeight;
}

/**
 * Fixed-height floors for primitives whose minimum height is dictated by
 * RenderMetrics regardless of content.
 *
 * These values are consumed by the universal fallback in `estimateHeight` as a
 * *floor*: if a primitive also has children or a label, the derived height is
 * taken as max(fixedFloor, derivedHeight), so the element never shrinks below
 * its designed baseline but can grow to fit its actual content.
 *
 * XRBanner, XRFooter, XRNavigationBar are included here as floors. They no
 * longer need a separate early-return branch — the universal fallback handles
 * them correctly via the floor mechanism.
 */
function FIXED_HEIGHT_LOOKUP(
  m: RenderMetrics,
): Partial<Record<XRPrimitiveType, number>> {
  return {
    // Interactive — truly fixed (no meaningful label or children in practice)
    XRToggle: m.toggle.height,
    XRSlider: m.slider.height,
    XRComboBox: m.comboBox.height,
    XRSearchBox: m.searchBox.height,
    XRProgressBar: m.progressBar.height,
    XRSeparator: m.separator.height,
    XRTabGroup: m.tabGroup.height,
    // Media (XRFigure is handled above with caption awareness)
    XRImage: m.image.height,
    // Landmark containers — floors only; children/label can push them taller.
    XRBanner: m.banner.height,
    XRFooter: m.footer.height,
    XRNavigationBar: m.navigationBar.height,
  };
}

/** Compute words-per-line for a given panel width and font metrics. */
function computeWordsPerLine(
  panelUsableWidth: number,
  m: PrimitiveFontMetrics,
): number {
  const charWidth = m.fontSize * m.charWidthRatio;
  return Math.max(
    1,
    Math.floor(panelUsableWidth / (charWidth * m.avgCharsPerWord)),
  );
}

/** Count words in a string. */
function countWords(text: string): number {
  return text.trim() === "" ? 0 : text.trim().split(/\s+/).length;
}

/**
 * Estimate the rendered height of a paragraph primitive.
 * Exported so paragraph continuation helpers can call it directly.
 */
function estimateParagraphHeight(
  p: XRParagraph,
  panelUsableWidth: number,
  metrics: RenderMetrics,
): number {
  const wordCount = p.wordCount ?? countWords(p.label ?? "");
  if (wordCount === 0) {
    return (
      metrics.paragraph.fontSize * metrics.paragraph.lineHeightRatio +
      metrics.paragraph.verticalPadding
    );
  }
  const m = metrics.paragraph;
  const wordsPerLine = computeWordsPerLine(panelUsableWidth, m);
  const lineCount = Math.ceil(wordCount / wordsPerLine);
  const lineH = m.fontSize * m.lineHeightRatio;
  return Math.max(
    m.fontSize * m.lineHeightRatio + m.verticalPadding, // floor = 1 line
    lineCount * lineH + m.verticalPadding,
  );
}

/**
 * Compute how many words of a paragraph fit within a given height budget.
 *
 * Used by the paginator to split a paragraph that straddles a page boundary.
 *
 * @returns number of words that fit (could be 0 if budget < 1 line).
 */
function paragraphWordsThatFit(
  budget: number,
  panelUsableWidth: number,
  metrics: RenderMetrics,
): number {
  const m = metrics.paragraph;
  const lineH = m.fontSize * m.lineHeightRatio;
  const availableForText = budget - m.verticalPadding;
  if (availableForText <= 0) return 0;
  const lines = Math.floor(availableForText / lineH);
  const wordsPerLine = computeWordsPerLine(panelUsableWidth, m);
  return lines * wordsPerLine;
}

// ─────────────────────────────────────────────────────────────
// Resolved strategy helpers
// ─────────────────────────────────────────────────────────────

/**
 * Decide the column count for an XRList given the available panel width.
 *
 * floor(panelUsableWidth / minCardWidth), clamped to [1, maxCardColumns].
 */
function resolveListColumns(
  grid: XRList,
  panelUsableWidth: number,
  metrics: RenderMetrics,
): number {
  const fromWidth = Math.floor(panelUsableWidth / metrics.minCardWidth);
  return Math.max(1, Math.min(fromWidth, metrics.maxCardColumns));
}

/**
 * Decide the rendering strategy for an XRTable.
 *
 * Rules:
 *   columns > tableMaxFlatColumns → "scrollable" (too wide to show flat)
 *   rows    > tableMaxFlatRows    → "scrollable" (too tall to paginate row by row)
 *   columns > 2 && rows > 4      → "curved-2d"  (ergonomic at wide angles)
 *   rows    < columns (wide/flat) → "cards"      (each row becomes a card)
 *   default                      → "flat-2d"
 */
function resolveTableStrategy(
  table: XRTable,
  metrics: RenderMetrics,
): "flat-2d" | "curved-2d" | "scrollable" | "cards" {
  const { columnCount, rowCount } = table;
  if (columnCount > metrics.tableMaxFlatColumns) return "scrollable";
  if (rowCount > metrics.tableMaxFlatRows) return "scrollable";
  if (columnCount > 2 && rowCount > 4) return "curved-2d";
  if (rowCount < columnCount) return "cards";
  return "flat-2d";
}

// ─────────────────────────────────────────────────────────────
// Helpers (geometry, rotation)
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

function angularPosition(
  distance: number,
  angleDeg: number,
  eyeY: number,
): Vec3 {
  const rad = deg2rad(angleDeg);
  return { x: distance * Math.sin(rad), y: eyeY, z: -distance * Math.cos(rad) };
}

function angularRotation(angleDeg: number): Rotation3 {
  return { x: 0, y: -deg2rad(angleDeg), z: 0 };
}

// ─────────────────────────────────────────────────────────────
// Template slot descriptors
// ─────────────────────────────────────────────────────────────

interface LandmarkSlot {
  position: Vec3;
  rotation: Rotation3;
  size: Size2;
  curveRadius: number;
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

// ── Slot factory helpers ─────────────────────────────────────

/**
 * DOCUMENT template
 * ```
 *  ←TOC arc   ←Nav   [ Main content panel (1.4 m wide) ]
 * ```
 */
function documentSlots(cfg: LayoutConfig, metrics: RenderMetrics): SlotMap {
  const eyeY = cfg.eyeLevel + cfg.eyeLevelOffset;
  const d = cfg.viewingDistance;
  const ha = cfg.comfortHalfAngleDeg;
  return {
    banner: {
      position: { x: 0, y: eyeY + 0.52, z: -d },
      rotation: zeroRotation(),
      size: { width: 1.4, height: metrics.banner.height },
      curveRadius: d * 0.8,
      worldLocked: true,
    },
    toc: {
      position: angularPosition(d * 0.95, -ha, eyeY - 0.05),
      rotation: angularRotation(-ha),
      size: { width: 0.36, height: metrics.navigationBar.height },
      curveRadius: d,
      worldLocked: true,
    },
    navigation: {
      position: angularPosition(d, -(ha - 8), eyeY - 0.05),
      rotation: angularRotation(-(ha - 8)),
      size: { width: 0.32, height: metrics.navigationBar.height },
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
      position: { x: 0, y: eyeY - cfg.maxPanelViewportHeight * 0.6, z: -d },
      rotation: zeroRotation(),
      size: { width: 1.4, height: metrics.footer.height },
      curveRadius: d * 0.8,
      worldLocked: true,
    },
    alert: {
      position: { x: 0.4, y: eyeY + 0.35, z: -(d - 0.15) },
      rotation: { x: 0, y: -0.15, z: 0 },
      size: { width: 0.5, height: metrics.alert.minHeight },
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
 * ```
 * ←Nav   [ Main / Cards (1.4 m wide) ]   Sidebar →
 * ```
 */
function dashboardSlots(cfg: LayoutConfig, metrics: RenderMetrics): SlotMap {
  const eyeY = cfg.eyeLevel + cfg.eyeLevelOffset;
  const d = cfg.viewingDistance;
  const ha = cfg.comfortHalfAngleDeg;
  return {
    banner: {
      position: { x: 0, y: eyeY + 0.5, z: -d },
      rotation: zeroRotation(),
      size: { width: 1.6, height: metrics.banner.height },
      curveRadius: d * 1.2,
      worldLocked: true,
    },
    toc: {
      position: angularPosition(d * 0.95, -ha, eyeY - 0.05),
      rotation: angularRotation(-ha),
      size: { width: 0.36, height: metrics.navigationBar.height },
      curveRadius: d,
      worldLocked: true,
    },
    navigation: {
      position: angularPosition(d, -(ha - 8), eyeY),
      rotation: angularRotation(-(ha - 8)),
      size: { width: 0.32, height: metrics.navigationBar.height },
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
      position: angularPosition(d, ha + 5, eyeY),
      rotation: angularRotation(ha + 5),
      size: { width: 0.5, height: metrics.navigationBar.height },
      curveRadius: d,
      worldLocked: true,
    },
    footer: {
      position: { x: 0, y: eyeY - cfg.maxPanelViewportHeight * 0.6, z: -d },
      rotation: zeroRotation(),
      size: { width: 1.6, height: metrics.footer.height },
      curveRadius: d * 1.2,
      worldLocked: true,
    },
    alert: {
      position: { x: 0.5, y: eyeY + 0.4, z: -(d - 0.15) },
      rotation: { x: 0, y: -0.18, z: 0 },
      size: { width: 0.5, height: metrics.alert.minHeight },
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
 * ```
 *       [ Form (1.1 m wide, flat) ]
 * ```
 * Flat panel — curved panels make input targets harder to hit precisely.
 */
function formSlots(cfg: LayoutConfig, metrics: RenderMetrics): SlotMap {
  const eyeY = cfg.eyeLevel + cfg.eyeLevelOffset;
  const d = cfg.viewingDistance;
  const ha = cfg.comfortHalfAngleDeg;
  return {
    banner: {
      position: { x: 0, y: eyeY + 0.58, z: -d },
      rotation: zeroRotation(),
      size: { width: 1.1, height: metrics.banner.height },
      curveRadius: 0,
      worldLocked: true,
    },
    toc: {
      position: angularPosition(d * 0.95, -ha, eyeY - 0.05),
      rotation: angularRotation(-ha),
      size: { width: 0.36, height: metrics.navigationBar.height },
      curveRadius: d,
      worldLocked: true,
    },
    navigation: {
      position: { x: -0.65, y: eyeY, z: -(d + 0.4) },
      rotation: angularRotation(-20),
      size: { width: 0.32, height: 0.8 },
      curveRadius: 0,
      worldLocked: true,
    },
    main: {
      position: { x: 0, y: eyeY, z: -d },
      rotation: zeroRotation(),
      size: { width: 1.1, height: cfg.maxPanelViewportHeight },
      curveRadius: 0,
      worldLocked: true,
    },
    alert: {
      position: { x: 0, y: eyeY - 0.62, z: -(d - 0.1) },
      rotation: zeroRotation(),
      size: { width: 1.0, height: metrics.alert.minHeight },
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
 * ```
 * [       Hero / Main (1.8 m wide, panoramic)       ]
 *         ←Nav (bottom arc)
 * ```
 */
function landingSlots(cfg: LayoutConfig, metrics: RenderMetrics): SlotMap {
  const eyeY = cfg.eyeLevel + cfg.eyeLevelOffset;
  const d = cfg.viewingDistance;
  const ha = cfg.comfortHalfAngleDeg;
  return {
    banner: {
      position: { x: 0, y: eyeY + 0.54, z: -d },
      rotation: zeroRotation(),
      size: { width: 1.8, height: metrics.banner.height },
      curveRadius: d * 1.4,
      worldLocked: true,
    },
    toc: {
      position: angularPosition(d * 0.95, -ha, eyeY - 0.05),
      rotation: angularRotation(-ha),
      size: { width: 0.36, height: metrics.navigationBar.height },
      curveRadius: d,
      worldLocked: true,
    },
    navigation: {
      position: { x: 0, y: eyeY - 0.62, z: -(d - 0.1) },
      rotation: { x: 0.15, y: 0, z: 0 },
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
      position: angularPosition(d, ha, eyeY),
      rotation: angularRotation(ha),
      size: { width: 0.42, height: 0.75 },
      curveRadius: d,
      worldLocked: true,
    },
    footer: {
      position: { x: 0, y: eyeY - cfg.maxPanelViewportHeight * 0.6, z: -d },
      rotation: zeroRotation(),
      size: { width: 1.8, height: metrics.footer.height },
      curveRadius: d * 1.4,
      worldLocked: true,
    },
    alert: {
      position: { x: 0, y: eyeY + 0.45, z: -(d - 0.15) },
      rotation: zeroRotation(),
      size: { width: 0.6, height: metrics.alert.minHeight },
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
 * GENERIC template — safe fallback.
 */
function genericSlots(cfg: LayoutConfig, metrics: RenderMetrics): SlotMap {
  const eyeY = cfg.eyeLevel + cfg.eyeLevelOffset;
  const d = cfg.viewingDistance;
  const ha = cfg.comfortHalfAngleDeg;
  return {
    banner: {
      position: { x: 0, y: eyeY + 0.52, z: -d },
      rotation: zeroRotation(),
      size: { width: 1.6, height: metrics.banner.height },
      curveRadius: d,
      worldLocked: true,
    },
    toc: {
      position: angularPosition(d * 0.95, -ha, eyeY - 0.05),
      rotation: angularRotation(-ha),
      size: { width: 0.36, height: metrics.navigationBar.height },
      curveRadius: d,
      worldLocked: true,
    },
    navigation: {
      position: angularPosition(d, -(ha - 8), eyeY - 0.05),
      rotation: angularRotation(-(ha - 8)),
      size: { width: 0.32, height: metrics.navigationBar.height },
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
      position: angularPosition(d, ha, eyeY),
      rotation: angularRotation(ha),
      size: { width: 0.42, height: 0.8 },
      curveRadius: d,
      worldLocked: true,
    },
    footer: {
      position: { x: 0, y: eyeY - cfg.maxPanelViewportHeight * 0.6, z: -d },
      rotation: zeroRotation(),
      size: { width: 1.6, height: metrics.footer.height },
      curveRadius: d,
      worldLocked: true,
    },
    alert: {
      position: { x: 0.4, y: eyeY + 0.35, z: -(d - 0.15) },
      rotation: { x: 0, y: -0.15, z: 0 },
      size: { width: 0.5, height: metrics.alert.minHeight },
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

function selectSlots(
  template: LayoutTemplate,
  cfg: LayoutConfig,
  metrics: RenderMetrics,
): SlotMap {
  switch (template) {
    case "document":
      return documentSlots(cfg, metrics);
    case "dashboard":
      return dashboardSlots(cfg, metrics);
    case "form":
      return formSlots(cfg, metrics);
    case "landing":
      return landingSlots(cfg, metrics);
    default:
      return genericSlots(cfg, metrics);
  }
}

// ─────────────────────────────────────────────────────────────
// Landmark classifier
// ─────────────────────────────────────────────────────────────

function classifyLandmark(primitive: XRPrimitive): SlotName {
  switch (primitive.type) {
    case "XRContentPanel":
      return "main";
    case "XRNavigationBar":
      return primitive.id.startsWith("toc") ? "toc" : "navigation";
    case "XRBanner":
      return "banner";
    case "XRFooter":
      return "footer";
    case "XRComplementary":
      return "complementary";
    case "XRFormPanel":
      return "main"; // contained inside XRContentPanel
    case "XRDialog":
      return "dialog";
    case "XRAlert":
      return "alert";
    default:
      return "main";
  }
}

// ─────────────────────────────────────────────────────────────
// Vertical stacker with metric-driven pagination
// ─────────────────────────────────────────────────────────────

interface StackResult {
  childEntries: LayoutEntry[];
  pagination: PaginationMeta | null;
  totalHeight: number;
  /** flat map: primitiveId → pageIndex, covering every descendant */
  pageIndexMap: Record<string, number>;
  /** synthetic continuation entries that need to be injected into `entries` */
  continuationEntries: LayoutEntry[];
}

/**
 * Stack `children` vertically within a panel.
 *
 * NON-PAGINATING PATH (depth > 0):
 *   Simple vertical stack; no page breaks; no continuations.
 *
 * PAGINATING PATH (depth === 0, XRContentPanel only):
 *   Section-aware with paragraph-level split support.
 *
 *   Rules (same as v1, plus paragraph continuation):
 *   1. Every section-like child (XRSection, XRArticle, XRFormPanel, XRFormField)
 *      starts on a new page.
 *   2. If a section's children exceed one page they spill across pages.
 *   3. Non-section direct children use standard overflow binning.
 *   4. XRParagraph that straddles a page boundary is split: the visible part
 *      stays on the current page and a continuation LayoutEntry (with
 *      `continuationWordOffset`) is inserted at the start of the next page.
 */
function stackChildren(
  children: XRPrimitive[],
  panelWidth: number,
  scene: SemanticScene,
  config: LayoutConfig,
  metrics: RenderMetrics,
  diag: LayoutDiagnostics,
  depth: number = 0,
): StackResult {
  if (children.length === 0) {
    return {
      childEntries: [],
      pagination: null,
      totalHeight: 0,
      pageIndexMap: {},
      continuationEntries: [],
    };
  }

  const childWidth = Math.max(0.025, panelWidth - config.panelPaddingX * 2);
  const panelUsableWidth = childWidth;

  const heights = children.map((c) =>
    estimateHeight(c, panelUsableWidth, metrics, config, new Set(), scene),
  );

  const childEntries: LayoutEntry[] = [];
  const continuationEntries: LayoutEntry[] = [];

  // ── Non-paginating path ─────────────────────────────────────────────────
  if (depth > 0) {
    let cursorY = -config.panelPaddingTop;
    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      const h = heights[i];
      const gap = i === 0 ? 0 : config.childGapY;
      const entry: LayoutEntry = {
        id: child.id,
        position: { x: config.panelPaddingX, y: cursorY - gap, z: 0 },
        rotation: zeroRotation(),
        size: { width: childWidth, height: h },
        curveRadius: 0,
        worldLocked: true,
      };
      attachResolvedStrategies(entry, child, panelUsableWidth, metrics);
      childEntries.push(entry);
      cursorY -= gap + h;
    }
    const totalHeight =
      config.panelPaddingTop +
      heights.reduce((s, h) => s + h, 0) +
      config.childGapY * Math.max(0, children.length - 1) +
      config.panelPaddingTop;
    return {
      childEntries,
      pagination: null,
      totalHeight,
      pageIndexMap: {},
      continuationEntries,
    };
  }

  // ── Section-aware paginating path (XRContentPanel, depth === 0) ─────────

  const VIEWPORT = config.maxPanelViewportHeight;
  const pageIndexMap: Record<string, number> = {};
  const childPositions: Array<{ x: number; y: number; z: number }> = [];

  let pageIdx = 0;
  let pageHeight = config.panelPaddingTop;
  let itemsOnPage = 0;
  let cursorY = -config.panelPaddingTop;
  const pageYOffsets: number[] = [0];
  let pageStartAbsY = 0;

  function isSectionLike(p: XRPrimitive): boolean {
    return (
      p.type === "XRSection" ||
      p.type === "XRArticle" ||
      p.type === "XRFormPanel" ||
      p.type === "XRFormField"
    );
  }

  function stampSubtree(node: XRPrimitive, page: number): void {
    pageIndexMap[node.id] = page;
    for (const child of node.children) stampSubtree(child, page);
  }

  function nextPage(): void {
    pageStartAbsY = Math.abs(cursorY);
    pageYOffsets.push(pageStartAbsY);
    pageIdx += 1;
    pageHeight = config.panelPaddingTop;
    itemsOnPage = 0;
    cursorY = -config.panelPaddingTop;
  }

  // ── Paragraph split helper ─────────────────────────────────────────────
  //
  // When an XRParagraph cannot fully fit in the remaining page budget we:
  //   1. Record the current entry with a reduced height (words that fit).
  //   2. Advance to the next page.
  //   3. Inject a continuation LayoutEntry with `continuationWordOffset` set.
  //
  // The continuation entry gets the same `id` with a `__cont_<pageIdx>` suffix
  // so the renderer can look it up independently. Diagnostics record the split.
  //
  function maybeSplitParagraph(
    p: XRPrimitive,
    fullHeight: number,
    budget: number,
  ): { splitHeight: number; didSplit: boolean } {
    if (p.type !== "XRParagraph")
      return { splitHeight: fullHeight, didSplit: false };
    if (budget <= 0) return { splitHeight: fullHeight, didSplit: false };

    const wordsThatFit = paragraphWordsThatFit(
      budget,
      panelUsableWidth,
      metrics,
    );
    const totalWords =
      (p as XRParagraph).wordCount ?? countWords(p.label ?? "");

    if (wordsThatFit <= 0 || wordsThatFit >= totalWords) {
      return { splitHeight: fullHeight, didSplit: false };
    }

    const para = p as XRParagraph;
    const m = metrics.paragraph;
    const wordsPerLine = computeWordsPerLine(panelUsableWidth, m);
    const lineH = m.fontSize * m.lineHeightRatio;
    const splitLines = Math.ceil(wordsThatFit / wordsPerLine);
    const splitHeight = splitLines * lineH + m.verticalPadding;

    // Inject continuation entry for the words that overflow.
    const contWordOffset = wordsThatFit;
    const remainingWords = totalWords - wordsThatFit;
    const contLines = Math.ceil(remainingWords / wordsPerLine);
    const contHeight = contLines * lineH + m.verticalPadding;

    const contId = `${p.id}__cont_${pageIdx + 1}`;
    const contEntry: LayoutEntry = {
      id: contId,
      // Position will be resolved on the next page — set to top of panel.
      position: { x: config.panelPaddingX, y: -config.panelPaddingTop, z: 0 },
      rotation: zeroRotation(),
      size: { width: childWidth, height: contHeight },
      curveRadius: 0,
      worldLocked: true,
      continuationWordOffset: contWordOffset,
    };
    continuationEntries.push(contEntry);

    diag.paragraphContinuations.push({
      originalId: p.id,
      pageIndex: pageIdx + 1,
      wordOffset: contWordOffset,
    });

    return { splitHeight, didSplit: true };
  }

  // ── Section splitter ─────────────────────────────────────────────────────
  //
  // Sections (XRSection, XRArticle, XRFormPanel, XRFormField) always begin on
  // a fresh page. Their children are then laid out one by one; whenever the
  // accumulated sub-page height would exceed VIEWPORT the section splitter
  // opens a new page and continues from there.
  //
  // Key correctness detail: `pageStartAbsY` must advance to the START of the
  // *current* sub-page after each split, not to the start of the whole section.
  // That way each subsequent sub-page offset is relative to the running cursor,
  // not anchored to an increasingly stale section origin.
  //
  // Paragraph continuation works identically inside sections: a paragraph that
  // straddles a sub-page boundary is split at the line boundary, and a
  // continuation LayoutEntry carrying `continuationWordOffset` is injected onto
  // the next page.
  //
  function splitSection(
    section: XRPrimitive,
    sectionChildHeights: number[],
  ): void {
    let scPageHeight = config.panelPaddingTop;
    let scItemsOnPage = 0;

    for (let j = 0; j < section.children.length; j++) {
      const sc = section.children[j];
      const sch = sectionChildHeights[j];
      const scGap = scItemsOnPage > 0 ? config.childGapY : 0;
      const remaining = VIEWPORT - scPageHeight - scGap;

      if (scPageHeight + scGap + sch > VIEWPORT && scItemsOnPage > 0) {
        // Try paragraph split before opening a new sub-page.
        const { splitHeight, didSplit } = maybeSplitParagraph(
          sc,
          sch,
          remaining,
        );
        if (didSplit) {
          stampSubtree(sc, pageIdx);
          scPageHeight += scGap + splitHeight;
          scItemsOnPage += 1;
        }

        // Advance to next sub-page.  pageStartAbsY must advance from *current*
        // position, not from the section's original start, so subsequent
        // sub-page offsets are correct.
        const nextSubPageAbsY = pageStartAbsY + scPageHeight;
        pageYOffsets.push(nextSubPageAbsY);
        pageStartAbsY = nextSubPageAbsY;
        pageIdx += 1;
        scPageHeight = config.panelPaddingTop;
        scItemsOnPage = 0;

        if (didSplit) continue; // continuation entry already queued for new page
      }

      const g = scItemsOnPage > 0 ? config.childGapY : 0;
      stampSubtree(sc, pageIdx);
      scPageHeight += g + sch;
      scItemsOnPage += 1;
    }

    // Synchronise outer cursor state so subsequent siblings are placed correctly.
    pageHeight = scPageHeight;
    itemsOnPage = scItemsOnPage;
    cursorY = -(config.panelPaddingTop + scPageHeight);
  }

  // ── Main pagination loop ──────────────────────────────────────────────────

  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    const h = heights[i];

    if (isSectionLike(child)) {
      // Sections always start on a fresh page.
      if (itemsOnPage > 0) nextPage();
      pageIndexMap[child.id] = pageIdx;

      childPositions[i] = {
        x: config.panelPaddingX,
        y: -config.panelPaddingTop,
        z: 0,
      };

      if (child.children.length === 0) {
        // Childless section: treat as a single opaque block.
        // If its height alone exceeds the viewport (e.g. a very tall XRFormPanel
        // placeholder) it still occupies a full page — we don't attempt to split
        // it further since there are no sub-children to redistribute.
        pageHeight += h;
        itemsOnPage += 1;
        cursorY -= h;
        continue;
      }

      // Lay out section children via the section splitter.
      const scHeights = child.children.map((sc: XRPrimitive) =>
        estimateHeight(sc, panelUsableWidth, metrics, config, new Set()),
      );
      splitSection(child, scHeights);
    } else {
      // Non-section direct children.
      const gap = itemsOnPage === 0 ? 0 : config.childGapY;
      const remaining = VIEWPORT - pageHeight - gap;

      if (pageHeight + gap + h > VIEWPORT && itemsOnPage > 0) {
        const { splitHeight, didSplit } = maybeSplitParagraph(
          child,
          h,
          remaining,
        );
        if (didSplit) {
          stampSubtree(child, pageIdx);
          childPositions[i] = {
            x: config.panelPaddingX,
            y: cursorY - gap,
            z: 0,
          };
          pageHeight += gap + splitHeight;
          itemsOnPage += 1;
          cursorY -= gap + splitHeight;
          nextPage();
          // Continuation will be placed on the new page — skip re-placing child.
          continue;
        }
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
    const entry: LayoutEntry = {
      id: child.id,
      position: pos,
      rotation: zeroRotation(),
      size: { width: childWidth, height: h },
      curveRadius: 0,
      worldLocked: true,
    };
    attachResolvedStrategies(entry, child, panelUsableWidth, metrics);
    childEntries.push(entry);
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

  return {
    childEntries,
    pagination,
    totalHeight,
    pageIndexMap,
    continuationEntries,
  };
}

/**
 * Attach resolved table strategy or card grid column count to a LayoutEntry
 * if the primitive requires it.
 */
function attachResolvedStrategies(
  entry: LayoutEntry,
  primitive: XRPrimitive,
  panelUsableWidth: number,
  metrics: RenderMetrics,
): void {
  if (primitive.type === "XRTable") {
    entry.tableLayoutStrategy = resolveTableStrategy(
      primitive as XRTable,
      metrics,
    );
  }
  if (primitive.type === "XRList") {
    entry.listColumns = resolveListColumns(
      primitive as XRList,
      panelUsableWidth,
      metrics,
    );
  }
}

// ─────────────────────────────────────────────────────────────
// Recursive layout walker
// ─────────────────────────────────────────────────────────────

/**
 * Walk a primitive and all its descendants, producing a LayoutEntry for each.
 *
 * Pagination fires ONLY on XRContentPanel (stackDepth = 0).
 * All other containers use the non-paginating stacking path (stackDepth = 1).
 * pageIndex is propagated from XRContentPanel down via inheritedPageIndex.
 */
function layoutPrimitive(
  primitive: XRPrimitive,
  worldPosition: Vec3,
  worldRotation: Rotation3,
  worldSize: Size2,
  curveRadius: number,
  worldLocked: boolean,
  scene: SemanticScene,
  config: LayoutConfig,
  metrics: RenderMetrics,
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

  if (inheritedPageIndex !== undefined) {
    entry.pageIndex = inheritedPageIndex;
  }

  // Attach strategy resolution for this primitive.
  attachResolvedStrategies(
    entry,
    primitive,
    Math.max(0.025, worldSize.width - config.panelPaddingX * 2),
    metrics,
  );

  if (primitive.children.length > 0) {
    const isContentPanel = primitive.type === "XRContentPanel";
    const stackDepth = isContentPanel ? 0 : 1;

    const { childEntries, pagination, pageIndexMap, continuationEntries } =
      stackChildren(
        primitive.children,
        worldSize.width,
        scene,
        config,
        metrics,
        diag,
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

    // Register continuation entries directly into the flat entries map.
    for (const cont of continuationEntries) {
      entries[cont.id] = cont;
      diag.totalPlaced += 1;
    }

    for (let i = 0; i < primitive.children.length; i++) {
      const child = primitive.children[i];
      const childLayoutEntry = childEntries[i];
      if (!childLayoutEntry) continue;

      const childPageIndex = isContentPanel
        ? pageIndexMap[child.id]
        : inheritedPageIndex;

      layoutPrimitive(
        child,
        childLayoutEntry.position,
        childLayoutEntry.rotation,
        childLayoutEntry.size,
        0,
        worldLocked,
        scene,
        config,
        metrics,
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
// Entry point
// ─────────────────────────────────────────────────────────────

/**
 * Compute a LayoutPlan for a SemanticScene.
 *
 * Steps:
 *   1. Select (or accept) the layout template.
 *   2. Build the slot map for that template from config + metrics.
 *   3. For each top-level primitive, classify to a slot and assign world-space
 *      placement from that slot.
 *   4. Recursively stack and paginate all children in local space.
 *   5. Collect all LayoutEntries and return the LayoutPlan.
 *
 * @param scene    SemanticScene from mapIRToScene.
 * @param profile  Device profile supplying both LayoutConfig and RenderMetrics.
 *                 Use one of QUEST_3_PROFILE, QUEST_PRO_PROFILE, RAY_BAN_META_PROFILE,
 *                 or a custom profile.
 * @param template Explicit template override. When omitted, selectLayoutTemplate is called.
 * @param configOverrides Optional partial LayoutConfig to merge over profile.layoutConfig.
 * @param metricsOverrides Optional partial RenderMetrics to merge over profile.renderMetrics.
 */
export function computeLayoutPlan(
  scene: SemanticScene,
  profile: DeviceProfile,
  template?: LayoutTemplate,
  configOverrides?: Partial<LayoutConfig>,
  metricsOverrides?: Partial<RenderMetrics>,
): LayoutPlan {
  const config: LayoutConfig = { ...profile.layoutConfig, ...configOverrides };
  const metrics: RenderMetrics = {
    ...profile.renderMetrics,
    ...metricsOverrides,
  };

  const resolvedTemplate = template ?? selectLayoutTemplate(scene);

  const entries: Record<string, LayoutEntry> = {};
  const diag: LayoutDiagnostics = {
    paginatedPanelCount: 0,
    paginatedPanels: [],
    unplacedIds: [],
    totalPlaced: 0,
    fallbackHeightIds: [],
    paragraphContinuations: [],
  };

  const slots = selectSlots(resolvedTemplate, config, metrics);
  const topLevelPrimitives = scene.root.children;
  const usedSlots = new Set<SlotName>();

  for (const primitive of topLevelPrimitives) {
    let slotName = classifyLandmark(primitive);

    if (usedSlots.has(slotName) && slotName !== "main") {
      slotName = "main";
    }
    usedSlots.add(slotName);

    const slot = slots[slotName] ?? slots.main;
    if (!slot) {
      diag.unplacedIds.push(primitive.id);
      continue;
    }

    layoutPrimitive(
      primitive,
      slot.position,
      slot.rotation,
      slot.size,
      slot.curveRadius,
      slot.worldLocked,
      scene,
      config,
      metrics,
      entries,
      diag,
    );
  }

  // XRScene root entry.
  entries[scene.root.id] = {
    id: scene.root.id,
    position: zeroVec(),
    rotation: zeroRotation(),
    size: { width: 0, height: 0 },
    curveRadius: 0,
    worldLocked: true,
  };

  // Catch orphans.
  for (const id of Object.keys(scene.primitives)) {
    if (!entries[id]) {
      diag.unplacedIds.push(id);
    }
  }

  return {
    entries,
    template: resolvedTemplate,
    config,
    diagnostics: diag,
  };
}

// ─────────────────────────────────────────────────────────────
// Convenience: merge LayoutPlan back into SemanticScene
// ─────────────────────────────────────────────────────────────

/**
 * Merge a LayoutPlan into a SemanticScene, overwriting each primitive's
 * `placement` field with the corresponding LayoutEntry.
 *
 * Returns a new SemanticScene (does not mutate the input).
 */
export function mergeLayoutPlan(
  scene: SemanticScene,
  plan: LayoutPlan,
): SemanticScene {
  const newPrimitives: Record<string, XRPrimitive> = {};
  for (const [id, primitive] of Object.entries(scene.primitives)) {
    const entry = plan.entries[id];
    if (!entry) {
      newPrimitives[id] = primitive;
      continue;
    }
    newPrimitives[id] = {
      ...(primitive as object),
      placement: {
        position: entry.position,
        rotation: entry.rotation,
        preferredSize: entry.size,
        curveRadius: entry.curveRadius,
        worldLocked: entry.worldLocked,
      },
    } as XRPrimitive;
  }
  return {
    ...scene,
    primitives: newPrimitives,
    root: (newPrimitives[scene.root.id] as typeof scene.root) ?? scene.root,
  };
}
