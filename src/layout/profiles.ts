// ── Quest 3 ──────────────────────────────────────────────────

import type {
  BlockRhythm,
  DeviceProfile,
  FixedHeightMetrics,
  PrimitiveFontMetrics,
  SpacingScale,
  TextBearingMetrics,
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
// ── Spacing derivations ──────────────────────────────────────
//
// Both ladders below are derived, not tuned by eye, so they can be restated
// for a different viewing distance or body size without guesswork. See
// SpacingScale / BlockRhythm in types.ts for the reasoning.

/** Metres subtended by one degree of visual angle at distance `d`. */
function degreeAt(d: number): number {
  return 2 * d * Math.tan((0.5 * Math.PI) / 180);
}

/** Interior padding ladder: quarter-degree steps at the reading distance. */
function spacingScale(viewingDistance: number): SpacingScale {
  const deg = degreeAt(viewingDistance); // ≈ 0.0209 m at 1.2 m
  const round = (v: number) => Math.round(v * 10000) / 10000;
  return {
    hairline: round(deg * 0.2),     // ≈ 0.0042
    tight: round(deg * 0.5),        // ≈ 0.0105
    snug: round(deg * 0.75),        // ≈ 0.0157
    comfortable: round(deg * 1.0),  // ≈ 0.0209
    generous: round(deg * 1.5),     // ≈ 0.0314
  };
}

/**
 * Vertical rhythm quantised to the body line box L = fontSize × lineHeight.
 * The heading gaps are asymmetric on purpose — that asymmetry is what makes a
 * heading read as belonging to the content below it rather than floating
 * between two groups.
 */
function blockRhythm(bodyLineHeight: number): BlockRhythm {
  const L = bodyLineHeight;
  const round = (v: number) => Math.round(v * 10000) / 10000;
  return {
    afterHeading: round(L * 0.25),  // ≈ 0.0085
    betweenBlocks: round(L * 0.5),  // ≈ 0.0169
    aroundRule: round(L * 0.75),    // ≈ 0.0254
    aroundBlock: round(L * 0.75),   // ≈ 0.0254
    beforeHeading: round(L * 1.0),  // ≈ 0.0338
  };
}

// The three numbers the profile and both spacing ladders are derived from.
// Declared once so the scales can never drift from the distance and body size
// they were derived for.
const QUEST_3_VIEWING_DISTANCE = 1.2;
const QUEST_3_BODY_FONT_SIZE = 0.026;
const QUEST_3_BODY_LINE_RATIO = 1.3;
const QUEST_3_SPACING = spacingScale(QUEST_3_VIEWING_DISTANCE);

/**
 * Meta Quest 3 profile.
 *
 * Viewing distance 1.2 m. Wide 110° FOV. Standing user (eyeLevel 1.5 m).
 * Font sizes chosen so text subtends ~0.5° per line-cap-height at 1.2 m
 * (comfortable mixed-reality reading per XR UX guidelines).
 *
 * Renderer reference: XRParagraphMesh uses metrics.paragraph — fontSize 0.026,
 * lineHeight 1.3 — and every interior inset comes from metrics.spacing.
 */
export const QUEST_3_PROFILE: DeviceProfile = {
  name: "Meta Quest 3",
  layoutConfig: {
    viewingDistance: QUEST_3_VIEWING_DISTANCE,
    comfortHalfAngleDeg: 30,
    eyeLevel: 1.5,
    eyeLevelOffset: -0.1,
    panelCurveRadius: 1.2,
    childGapY: 0.01,
    panelPaddingTop: 0.056,
    panelPaddingX: 0.052,
    maxPanelViewportHeight: 0.9,
    pageZStep: 0.05,
  },
  renderMetrics: {
    paragraph: paragraphMetrics(
      QUEST_3_BODY_FONT_SIZE,
      QUEST_3_BODY_LINE_RATIO,
      0.0001,
    ),
    heading: {
      1: paragraphMetrics(0.048, 1.3, 0.015),
      2: paragraphMetrics(0.038, 1.35, 0.015),
      3: paragraphMetrics(0.03, 1.4, 0.01),
      4: paragraphMetrics(0.026, 1.4, 0.01),
      5: paragraphMetrics(0.024, 1.45, 0.01),
      6: paragraphMetrics(0.022, 1.45, 0.01),
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
    listItem: textBearing(0.055, 0.024),
    // A card's interior padding comes off the shared ladder, like every other
    // surface's. Both were 10 mm — half a degree at the reading distance —
    // which put a tile's first line almost on its own top edge and made a
    // column of tiles read as one striped slab.
    listItemContentPad: QUEST_3_SPACING.snug,
    listItemProseInset: QUEST_3_SPACING.snug,
    listItemMinPad: 0.005,
    listItemWrapCushion: 0.008,
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
    spacing: QUEST_3_SPACING,
    rhythm: blockRhythm(QUEST_3_BODY_FONT_SIZE * QUEST_3_BODY_LINE_RATIO),
    banner: fixed(0.16),
    footer: fixed(0.12),
    navigationBar: fixed(0.85),
    fallbackElementHeight: 0.04,
  },
};
