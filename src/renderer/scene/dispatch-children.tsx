/**
 * scene/dispatch-children.tsx
 *
 * Helpers for dispatching a container's children as world-/panel-absolute
 * SIBLINGS rather than nested descendants (the renderer's coordinate contract),
 * plus complementary-aside extraction and the WithSiblingChildren wrapper.
 */
import React from "react";
import type { XRPrimitive } from "../../mapper/types";
import type { LayoutEntry, LayoutPlan } from "../../layout/types";
import { AtPos } from "./AtPos";
import { StackDepthContext, type PageState } from "./contexts";
import { PrimitiveDispatcher } from "./dispatcher";

export function hasDescendant(node: XRPrimitive, targetId: string): boolean {
  for (const child of node.children) {
    if (child.id === targetId || hasDescendant(child, targetId)) return true;
  }
  return false;
}

/**
 * Dispatches every child primitive as a sibling (panel-absolute coordinates).
 * Used by containers whose children already carry panel-absolute positions so
 * nesting them inside a parent group would double-translate them.
 */
/**
 * Returns true for an XRComplementary that the engine has extracted to a
 * world-space slot (it carries a pageIndex even though it's not inside the
 * content panel group). These must be dispatched from XRContentPanelRenderer
 * outside the panel's <group>, NOT via the normal sibling dispatch chain.
 */
export function isExtractedComplementary(p: XRPrimitive, plan: LayoutPlan): boolean {
  return (
    p.type === "XRComplementary" && plan.entries[p.id]?.pageIndex !== undefined
  );
}

/**
 * Walk the primitive subtree and collect every XRComplementary that has been
 * extracted to a world-space slot (identified by having a pageIndex).
 * Does NOT recurse into XRComplementary itself.
 */
export function collectExtractedComplementaries(
  root: XRPrimitive,
  plan: LayoutPlan,
): XRPrimitive[] {
  const result: XRPrimitive[] = [];
  function walk(p: XRPrimitive) {
    for (const child of p.children) {
      if (isExtractedComplementary(child, plan)) {
        result.push(child);
      } else {
        walk(child);
      }
    }
  }
  walk(root);
  return result;
}

export function DispatchChildren({
  primitives,
  plan,
  pageState,
  setPage,
  primitiveMap,
}: {
  primitives: XRPrimitive[];
  plan: LayoutPlan;
  pageState: PageState;
  setPage: (id: string, page: number) => void;
  primitiveMap: Map<string, XRPrimitive>;
}) {
  // These children live one nesting level deeper than the container that
  // dispatched them — bump the stagger so their backings clear the container's.
  const depth = React.useContext(StackDepthContext);
  return (
    <StackDepthContext.Provider value={depth + 1}>
      {primitives
        .filter((child) => !isExtractedComplementary(child, plan))
        .map((child) => (
          <PrimitiveDispatcher
            key={child.id}
            primitive={child}
            plan={plan}
            pageState={pageState}
            setPage={setPage}
            primitiveMap={primitiveMap}
          />
        ))}
    </StackDepthContext.Provider>
  );
}

/**
 * Renders a container's own visual (backing/mesh) at its panel-absolute
 * position, then dispatches its children as siblings so their own
 * panel-absolute positions aren't compounded with the parent's offset.
 *
 * This is the standard pattern for XRSection, XRListItem (block-only),
 * XRArticle, XRFormPanel, and unknown container types.
 */
export function WithSiblingChildren({
  entry,
  backing,
  primitives,
  plan,
  pageState,
  setPage,
  primitiveMap,
}: {
  entry: LayoutEntry;
  backing: React.ReactNode;
  primitives: XRPrimitive[];
  plan: LayoutPlan;
  pageState: PageState;
  setPage: (id: string, page: number) => void;
  primitiveMap: Map<string, XRPrimitive>;
}) {
  return (
    <>
      <AtPos entry={entry}>{backing}</AtPos>
      <DispatchChildren
        primitives={primitives}
        plan={plan}
        pageState={pageState}
        setPage={setPage}
        primitiveMap={primitiveMap}
      />
    </>
  );
}

// ─────────────────────────────────────────────────────────────
// Pipeline hook
// ─────────────────────────────────────────────────────────────

