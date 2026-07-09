/**
 * scene/config.ts
 *
 * Tunable scene-renderer constants: view-morph easing, nesting-depth Z stagger,
 * and the section-cards ("zoom out to a grid of cards") layout. Grouped here so
 * the feel of transitions and the cards view can be adjusted in one place.
 * All positions/distances are in metres (WebXR coordinate system).
 */
import type { LayoutConfig } from "../../layout/types";

/** Shared empty layout-config override (stable identity to avoid re-renders). */
export const EMPTY_CONFIG: Partial<LayoutConfig> = {};

// ── Nesting-depth Z stagger ──────────────────────────────────────────────────
/** Per-nesting-level forward Z step (metres). */
export const Z_STACK_STEP = 0.003;
/** Cap so pathologically deep DOM can't push content metres toward the viewer. */
export const MAX_STACK_DEPTH = 8;

// ── View-transition morph ────────────────────────────────────────────────────
/**
 * Exponential-smoothing rate for view-transition morphs (per second). Higher =
 * snappier. ~10 gives a ~250–400 ms settle that reads as the page reforming
 * around the user when switching arrangements.
 */
export const MORPH_RATE = 10;
/** Below this (metres / radians) a value is snapped to target and considered settled. */
export const MORPH_EPS = 1e-4;

// ── Section-cards view ───────────────────────────────────────────────────────
export const CARDS_LOOK_TARGET: [number, number, number] = [0, 1.4, -1.2];
export const CARDS_READ_POS: [number, number, number] = [0, 1.5, 0.0];
export const CARDS_READ_LOOK: [number, number, number] = [0, 0.95, -1.2];

export const CARD_W = 0.4;
export const CARD_H = 0.24;
export const CARD_GAP_X = 0.06;
export const CARD_GAP_Y = 0.05;
export const CARD_COLS = 4;
export const CARD_Z = -1.2;
export const CARD_EYE_Y = 1.5;
