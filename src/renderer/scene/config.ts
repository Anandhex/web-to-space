/**
 * scene/config.ts
 *
 * Tunable scene-renderer constants: view-morph easing and nesting-depth Z
 * stagger. Grouped here so the feel of transitions can be adjusted in one place.
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
