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
