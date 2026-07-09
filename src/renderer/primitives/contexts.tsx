/**
 * primitives/contexts.tsx
 *
 * React contexts shared across all XR primitive meshes: clipping planes, panel
 * origin, render metrics, inline text-style propagation, and the navigate
 * handler. Split out of primitives.tsx so meshes can depend on the contexts
 * without pulling in the whole primitive library.
 */

import { createContext, useContext } from "react";
import * as THREE from "three";

import type { RenderMetrics } from "../../layout/types";

// ─────────────────────────────────────────────────────────────
// Panel clipping context
// ─────────────────────────────────────────────────────────────

/**
 * Provides THREE.Plane clipping planes to all descendant mesh materials.
 *
 * Set by XRContentPanel (and XRSectionMesh when it acts as a viewport)
 * to clip child geometry that would overflow the panel boundary.
 *
 * The planes are in WORLD space — Three.js applies them after the model
 * matrix transform, so the panel's own world position must be factored in
 * by the provider (see XRSceneRenderer: buildPanelClipPlanes).
 *
 * An empty array means "no clipping active" (default).
 */
export const ClipPlanesContext = createContext<THREE.Plane[]>([]);

/** Convenience hook — returns the current clip planes (may be empty). */
export function useClipPlanes(): THREE.Plane[] {
  return useContext(ClipPlanesContext);
}

/**
 * World-space Y of the enclosing XRContentPanel's own top edge (its
 * entry.position.y). Clipping planes are always evaluated in world space,
 * but descendant entries (list items, paragraphs, ...) carry panel-relative
 * ("panel-absolute") positions — this lets a descendant reconstruct its own
 * world-space Y bounds (panelOriginY + entry.position.y) without needing to
 * decode it back out of an upstream Plane's constant.
 */
export const PanelOriginYContext = createContext<number>(0);

/**
 * Whether XRListItem cards may add their own world-space self-clip planes
 * (see XRListItemMesh.cardClips). That optimisation assumes the card carries a
 * panel-absolute Y so `panelOriginY + panelRelativeY` reconstructs its true
 * world Y. Inside a non-paginating landmark panel (e.g. XRComplementary) items
 * carry PARENT-relative Y instead, so that sum is wrong and the self-clip would
 * cull the card entirely. Such panels set this false; the card then relies on
 * the panel's own ClipPlanesContext bounds alone.
 */
export const CardSelfClipContext = createContext<boolean>(true);

// ─────────────────────────────────────────────────────────────
// Render metrics context
// ─────────────────────────────────────────────────────────────

/**
 * Provides the SAME RenderMetrics object the layout engine used to compute
 * estimateHeight() for this scene.
 *
 * Why this exists: components used to keep their own hardcoded font-size /
 * line-height constants that were meant to "match" RenderMetrics but lived as a
 * separate, hand-maintained table. The two tables drifted, so the layout engine
 * would reserve space for a 1-line heading while the renderer actually drew text
 * ~40% larger — causing the heading to wrap to extra lines that were never
 * budgeted for, overlapping whatever was stacked below it.
 *
 * Mounted once near the Canvas root in XRSceneRenderer using the resolved
 * deviceProfile's renderMetrics — the exact object passed into
 * computeLayoutPlan. Components MUST read fontSize/lineHeightRatio from here
 * rather than redeclaring their own constants, or this class of bug reappears.
 */
export const RenderMetricsContext = createContext<RenderMetrics | null>(null);

/**
 * Convenience hook — returns the active RenderMetrics.
 *
 * Throws if no provider is mounted rather than silently falling back to a
 * guessed default, since a silent fallback is exactly the kind of drift
 * this context exists to prevent.
 */
export function useRenderMetrics(): RenderMetrics {
  const metrics = useContext(RenderMetricsContext);
  if (!metrics) {
    throw new Error(
      "useRenderMetrics() called with no RenderMetricsContext.Provider mounted. " +
        "Wrap the scene tree in <RenderMetricsContext.Provider value={deviceProfile.renderMetrics}>.",
    );
  }
  return metrics;
}

// ─────────────────────────────────────────────────────────────
// Text style context (parent-font-metric propagation)
// ─────────────────────────────────────────────────────────────

/**
 * Lets a text-bearing container (currently: XRHeadingMesh) tell its inline
 * descendants (XRTextMesh, XRLinkMesh, XRButtonMesh when used inline) which
 * PrimitiveFontMetrics to render with.
 *
 * Without this, XRText always rendered at metrics.paragraph regardless of
 * its parent — so a heading with mixed inline content would render its text
 * children at small body-text size while estimateHeight() measured those same
 * children using the heading's larger metric.
 *
 * `null` means "no override — use the type's own default metric". Set by a
 * container right before rendering its children; do not set it for containers
 * whose children should keep their own default sizing.
 */
export const TextStyleContext = createContext<
  RenderMetrics["paragraph"] | null
>(null);

/**
 * Provides the navigate handler to any descendant that needs to handle link
 * clicks — both standalone XRLinkMesh and inline link spans in InlineProseRows.
 * XRSceneGraph provides this; components consume it via useContext.
 */
export const NavigateContext = createContext<((href: string) => void) | null>(
  null,
);
