/**
 * scene/contexts.tsx
 *
 * Renderer-side React contexts and the small pure helpers that operate on
 * LayoutEntry page/position data: page gating (entryOnPage), the current-page /
 * page-range / font / stack-depth contexts, and the zeroedEntry + stackZ
 * transforms. Kept dependency-light so any scene module can import them.
 */
import React from "react";
import type { LayoutEntry } from "../../layout/types";
import { Z_STACK_STEP, MAX_STACK_DEPTH } from "./config";
import type { Axis, NavState } from "../../links/memory";
import type { LinkDirection } from "../../links/direction";
import type { SpatialLink } from "../../links/types";

export type PageState = Record<string, number>;

export const CurrentPageContext = React.createContext<number>(-1);
export const FontContext = React.createContext<string | undefined>(undefined);

/**
 * Active page range [startPage, endPage] (both inclusive, absolute panel page
 * indices) for the currently focused section in cards reading view.
 * null = no restriction (show all pages / full document pagination).
 */
export const PageRangeContext = React.createContext<[number, number] | null>(
  null,
);

/**
 * How deeply nested (in spatial containers) the current primitive is. The root
 * scene and every top-level landmark render at depth 0; each container bumps
 * this by one for the children it dispatches. See CLAUDE.md's coordinate
 * contract — the engine flattens panel-absolute primitives onto z=0, so this
 * stagger keeps a child's backing in front of its container's instead of
 * coplanar (which z-fights).
 */
export const StackDepthContext = React.createContext<number>(0);

/**
 * Page-gating predicate. An entry with no `pageIndex` isn't inside a paginated
 * panel and is always visible. Otherwise it's visible when `currentPage` falls
 * within the entry's page range — either the single page `pageIndex`, or the
 * inclusive range `[pageIndex … pageEndIndex]` when `pageEndIndex` is set.
 * `currentPage === -1` means "not in a paginated context", so everything renders.
 */
export function entryOnPage(
  entry:
    | {
        pageIndex?: number;
        pageEndIndex?: number;
        pageExcludeRanges?: Array<[number, number]>;
      }
    | null
    | undefined,
  currentPage: number,
): boolean {
  if (!entry) return false;
  if (entry.pageIndex === undefined) return true;
  if (currentPage === -1) return true;
  const end = entry.pageEndIndex ?? entry.pageIndex;
  if (currentPage < entry.pageIndex || currentPage > end) return false;
  // Mutual-exclusion holes: hidden on pages a higher-priority slot aside owns.
  if (entry.pageExcludeRanges) {
    for (const [s, e] of entry.pageExcludeRanges) {
      if (currentPage >= s && currentPage <= e) return false;
    }
  }
  return true;
}

/** Strip a LayoutEntry's position/rotation so a mesh never double-applies it. */
export function zeroedEntry(entry: LayoutEntry): LayoutEntry {
  return {
    ...entry,
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0 },
  };
}

/** Forward Z offset for a given nesting depth. */
export function stackZ(depth: number): number {
  return Math.min(depth, MAX_STACK_DEPTH) * Z_STACK_STEP;
}

// ─────────────────────────────────────────────────────────────
// Directional links
// ─────────────────────────────────────────────────────────────

/**
 * Everything a door, stair, strip or path needs to move the reader
 * (docs/directional-links.md). Provided once by the scene graph and read by
 * whichever view is mounted, rather than drilled through four view components
 * that each pass it on unchanged.
 *
 * `nav` is the tab's navigation memory. It is null before the first document
 * loads, and a view must render its geometry anyway: a page has parent,
 * sibling and external links of its own from the moment it is parsed, and
 * memory only says which slots the TRAVELLED path has already claimed.
 */
export interface TraversalApi {
  /** Follow a link in a direction; the axis is what reserves the way back. */
  traverse: (url: string, axis: Axis, label?: string) => void;
  /** The reserved back door every floor, face and table carries. */
  back: () => void;
  /** Move to any node the reader has visited. Emitted by the minimap. */
  jump: (historyIndex: number) => void;
  nav: NavState | null;
  /**
   * A move the reader has committed to whose document has not arrived yet.
   *
   * Views read this to keep their transition running — the turn, the slide,
   * the walk — for as long as the fetch takes, and to stop it the moment the
   * move lands or fails. The document they are on stays rendered throughout.
   */
  pending: { url: string; axis: Axis | null } | null;
}

export const TraversalContext = React.createContext<TraversalApi | null>(null);

export function useTraversal(): TraversalApi | null {
  return React.useContext(TraversalContext);
}

/**
 * The gaze binding between an inline mark and the door it belongs to.
 *
 * Direction tells the reader the KIND of a link but not WHICH link a given
 * door came from, and the census says alignment cannot close that gap either:
 * 49.8% of anchors share a block with another anchor. So lighting is the
 * binding channel — and it is the ONLY one, since the design has given up
 * colour. Lighting either end lights both.
 *
 * Keyed by the primitive id of the anchor, which `links/collect.ts` already
 * uses as a `SpatialLink`'s identity, so a mark and its door agree on the key
 * without either of them inventing one.
 */
export interface LinkBindingApi {
  /** The anchor currently lit, or null. */
  lit: string | null;
  /** Light an anchor and its door together. Pass null to clear. */
  setLit: (linkId: string | null) => void;
}

export const LinkBindingContext = React.createContext<LinkBindingApi>({
  lit: null,
  setLit: () => {},
});

export function useLinkBinding(): LinkBindingApi {
  return React.useContext(LinkBindingContext);
}

/**
 * Every reference on the page, classified and projected onto a direction.
 *
 * Computed ONCE per scene by the scene graph (`links/collect.ts` walks the
 * primitive tree in reading order) and read by two very different consumers
 * that must not disagree: the inline mark beside an anchor, and the door,
 * stair, strip or path that anchor's link opens. If each classified
 * independently they could differ, and the reader would see a mark pointing up
 * beside a link whose door is off to the side — which would break the one
 * legend the whole design asks them to learn.
 *
 * Keyed by primitive id, which is what `SpatialLink.id` already is.
 */
export interface PageLinksApi {
  /** Reading order, every occurrence — not deduplicated. */
  links: SpatialLink[];
  byId: ReadonlyMap<string, SpatialLink>;
  /** The direction an anchor's mark and door share, or null if unknown. */
  directionOf: (linkId: string) => LinkDirection | null;
}

export const PageLinksContext = React.createContext<PageLinksApi | null>(null);

export function usePageLinks(): PageLinksApi | null {
  return React.useContext(PageLinksContext);
}
