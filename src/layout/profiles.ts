// ── Quest 3 ──────────────────────────────────────────────────

import type {
  DeviceProfile,
  FixedHeightMetrics,
  PrimitiveFontMetrics,
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
    childGapY: 0.022,
    panelPaddingTop: 0.056,
    panelPaddingX: 0.052,
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
    childGapY: 0.024,
    panelPaddingTop: 0.056,
    panelPaddingX: 0.052,
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
    childGapY: 0.018,
    panelPaddingTop: 0.032,
    panelPaddingX: 0.030,
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
