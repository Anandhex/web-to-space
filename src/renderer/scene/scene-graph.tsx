/**
 * scene/scene-graph.tsx
 *
 * <XRSceneGraph> — builds the primitive lookup map and reference frame, then
 * dispatches every top-level primitive; includes the reference-frame group.
 */
import React, { useCallback, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { Text } from "@react-three/drei";
import { useXRInputSourceState } from "@react-three/xr";
import * as THREE from "three";

import type { SemanticScene, XRPrimitive } from "../../mapper/types";
import type { LayoutPlan, SlotMap } from "../../layout/types";
import { flattenInlineWrappers, isInlinePrimitive } from "../../layout/utils";
import { NavigateContext } from "../primitives";
import {
  CurrentPageContext,
  LinkBindingContext,
  PageLinksContext,
  PageRangeContext,
  TraversalContext,
  type PageLinksApi,
  type PageState,
  type TraversalApi,
} from "./contexts";
import { collectSpatialLinks } from "../../links/collect";
import { sameDocumentFragment } from "../../links/classify";
import { directionOf } from "../../links/direction";
import type { LateralSide } from "../../links/direction";
import type { SpatialLink } from "../../links/types";
import { hasDescendant } from "./dispatch-children";
import { PrimitiveDispatcher } from "./dispatcher";
import { PageGhostField } from "./page-ghosts";
import { MIN_PAGES_FOR_PAGE_VIEWS } from "../page-placements";
import type { Axis, NavState } from "../../links/memory";

function buildPrimitiveMap(
  root: XRPrimitive,
  out: Map<string, XRPrimitive> = new Map(),
): Map<string, XRPrimitive> {
  out.set(root.id, root);
  for (const child of root.children) buildPrimitiveMap(child, out);
  return out;
}

// ─────────────────────────────────────────────────────────────
// Section drill-down (click a section → read only its pages)
// ─────────────────────────────────────────────────────────────

function collectSubtreeIds(node: XRPrimitive, out: Set<string>): Set<string> {
  out.add(node.id);
  for (const child of node.children) collectSubtreeIds(child, out);
  return out;
}

/**
 * The page span [firstPage, lastPage] of the section that owns `targetId`.
 *
 * A TOC entry links to a heading (`#domId`); that heading begins an XRSection.
 * We find the *deepest* (smallest) XRSection containing the target, then take
 * the min/max `pageIndex` across its descendants that the engine paginated. The
 * pager (PageRangeContext) clamps prev/next to this span, so focusing a section
 * lets the reader page through only that section's pages. Returns null when the
 * target isn't inside a section or the panel isn't paginated.
 */
function sectionRangeForTarget(
  targetId: string,
  primitiveMap: Map<string, XRPrimitive>,
  plan: LayoutPlan,
): [number, number] | null {
  let ownerIds: Set<string> | null = null;
  for (const [, p] of primitiveMap) {
    if (p.type !== "XRSection") continue;
    if (p.id !== targetId && !hasDescendant(p, targetId)) continue;
    const ids = collectSubtreeIds(p, new Set());
    if (!ownerIds || ids.size < ownerIds.size) ownerIds = ids; // deepest wins
  }
  if (!ownerIds) return null;
  let min = Infinity;
  let max = -Infinity;
  for (const id of ownerIds) {
    const page = plan.entries[id]?.pageIndex;
    if (page !== undefined) {
      min = Math.min(min, page);
      max = Math.max(max, page);
    }
  }
  return min === Infinity ? null : [min, max];
}

/**
 * A small "← All sections" chip floated just above the content panel while a
 * section is focused. Clicking it clears the focus and restores full-document
 * paging. Positioned from the resolved `main` slot so it tracks whichever view
 * is active.
 */
function SectionResetChip({
  slots,
  onClear,
}: {
  slots: SlotMap;
  onClear: () => void;
}) {
  const main = slots.main;
  const [hover, setHover] = React.useState(false);
  if (!main) return null;
  const cx = main.position.x + main.size.width / 2;
  const topY = main.position.y + 0.1;
  const z = main.position.z + 0.03;
  return (
    <group position={[cx, topY, z]}>
      <mesh
        onClick={(e) => {
          e.stopPropagation();
          onClear();
        }}
        onPointerOver={() => setHover(true)}
        onPointerOut={() => setHover(false)}
      >
        <planeGeometry args={[0.36, 0.062]} />
        <meshBasicMaterial
          color={hover ? "#1f6feb" : "#0d1b2e"}
          transparent
          opacity={0.94}
        />
      </mesh>
      <Text
        position={[0, 0, 0.002]}
        fontSize={0.024}
        color="#cfe6ff"
        anchorX="center"
        anchorY="middle"
      >
        ← All sections
      </Text>
    </group>
  );
}

// ─────────────────────────────────────────────────────────────
// Reference frame
// ─────────────────────────────────────────────────────────────

/**
 * Applies a view's spatial reference frame to the whole scene graph exactly
 * once. `LayoutEntry` positions are authored relative to this frame; wrapping
 * here keeps the per-primitive "one group, siblings" contract intact.
 *
 *  - "world" — identity (fixed in the room).
 *  - "body"  — follows head yaw + horizontal position (turn-to-navigate).
 *  - "head"  — follows the full head pose (near-eye).
 *  - "hand"  — follows the off-hand controller's grip pose (handheld/palm). If
 *    no controller is tracked (e.g. hand-tracking off, or the grip has no pose),
 *    it falls back to a head-anchored, yaw-following frame so the view is still
 *    usable.
 *
 * The frame transform is only applied inside an immersive session; in the flat
 * preview it stays identity so every arrangement is explorable as authored.
 */
export function ReferenceFrameGroup({
  frame,
  children,
}: {
  frame: import("../../layout/types").ReferenceFrame;
  children: React.ReactNode;
}) {
  const ref = useRef<THREE.Group>(null);
  const euler = useRef(new THREE.Euler(0, 0, 0, "YXZ"));
  const gripPos = useRef(new THREE.Vector3());
  const gripQuat = useRef(new THREE.Quaternion());
  const gripScale = useRef(new THREE.Vector3());

  /**
   * The off-hand (left) controller, so the palm/tablet sits on the non-dominant
   * hand and the dominant hand stays free to point.
   *
   * Read from the XR store rather than gl.xr.getControllerGrip(): three only
   * populates the objects it hands out if they are added to the scene, and this
   * component doesn't own that. @react-three/xr mounts the controller itself and
   * exposes it here, so `object` is a live, scene-attached transform.
   * `undefined` while the controller has no pose.
   */
  const offHand = useXRInputSourceState("controller", "left");

  useFrame((state) => {
    const g = ref.current;
    if (!g) return;
    const presenting = state.gl.xr.isPresenting;
    if (!presenting) {
      if (frame === "hand") {
        // No headset: park the hand-local layout at a comfortable static anchor
        // (down-and-right, tilted toward the eye) so the palm view is still
        // explorable with the mouse in the flat preview.
        g.position.set(0.18, 1.15, -0.32);
        g.rotation.set(0.42, -0.32, 0);
        return;
      }
      g.position.set(0, 0, 0);
      g.rotation.set(0, 0, 0);
      return;
    }
    if (frame === "world") {
      g.position.set(0, 0, 0);
      g.rotation.set(0, 0, 0);
      return;
    }
    const cam = state.camera;
    if (frame === "head") {
      g.position.copy(cam.position);
      g.quaternion.copy(cam.quaternion);
      return;
    }
    if (frame === "hand") {
      const grip = offHand?.object;
      if (grip) {
        // Anchor the whole arrangement to the controller's grip pose. The grip
        // and this group are both scene-root children, so matrixWorld is the
        // local transform we want to mirror.
        grip.matrixWorld.decompose(
          gripPos.current,
          gripQuat.current,
          gripScale.current,
        );
        g.position.copy(gripPos.current);
        g.quaternion.copy(gripQuat.current);
        return;
      }
      // Fall through to the head-anchored fallback when no grip is tracked.
    }
    // body & hand-fallback: follow yaw + horizontal position, keep panels upright.
    euler.current.setFromQuaternion(cam.quaternion);
    g.position.set(cam.position.x, 0, cam.position.z);
    g.quaternion.identity();
    g.rotation.set(0, euler.current.y, 0);
  });

  return <group ref={ref}>{children}</group>;
}

// ─────────────────────────────────────────────────────────────
// Scene graph
// ─────────────────────────────────────────────────────────────

export function XRSceneGraph({
  scene,
  plan,
  pageState,
  setPage,
  onExternalNavigate,
  onTraverse,
  onTraverseBack,
  onTraverseJump,
  nav,
  pending,
  sourceUrl,
}: {
  scene: SemanticScene;
  plan: LayoutPlan;
  pageState: PageState;
  setPage: (id: string, page: number) => void;
  onExternalNavigate?: (href: string) => void;
  /** Directional traversal — see XRSceneRendererProps.onTraverse. */
  onTraverse?: (url: string, axis: Axis, label?: string) => void;
  onTraverseBack?: () => void;
  onTraverseJump?: (historyIndex: number) => void;
  nav?: NavState | null;
  /** A directional move in flight — see XRSceneRendererProps.pending. */
  pending?: { url: string; axis: Axis | null } | null;
  sourceUrl?: string;
}) {
  const primitiveMap = React.useMemo(() => {
    // Start with the tree walk so ordering is preserved for normal nodes,
    // then overlay scene.primitives which includes synthetic continuation
    // primitives injected by the engine after pagination.
    const map = buildPrimitiveMap(scene.root);
    for (const [id, prim] of Object.entries(scene.primitives)) {
      if (!map.has(id)) map.set(id, prim);
    }
    return map;
  }, [scene.root, scene.primitives]);

  // Section drill-down: when set, the pager (PageRangeContext) clamps to this
  // section's page span so the reader sees only that section. Cleared whenever
  // the page/tab content changes out from under us.
  //
  // FLIP ONLY. `PageRangeContext` has exactly one consumer — the flip panel's
  // pager in `panels.tsx` — because rooms, wall and deck do not page at all:
  // every page is already drawn at its own placement and the reader walks,
  // turns or drags to it. Clamping a pager they do not have changes nothing,
  // so setting the range in a page view left the reset chip standing over the
  // gallery offering to undo something that had never happened, positioned at
  // the FLIP layout's `slots.main` — a world point that in rooms is not where
  // the page hangs at all, which is why it floated in front of a wall.
  const pageView =
    plan.pageDistribution !== undefined && plan.pageDistribution !== "flip";
  const [focusedRange, setFocusedRange] = React.useState<
    [number, number] | null
  >(null);
  React.useEffect(() => {
    setFocusedRange(null);
  }, [scene.root.id]);

  React.useEffect(() => {
    // Inline children of inline-owning types (XRParagraph, XRHeading,
    // XRListItem, XRBlockQuote) are rendered as text runs by the mesh
    // component and intentionally have no plan entry. Exclude them from
    // the missing-entries check so the warning stays actionable.
    const INLINE_OWNING = new Set([
      "XRParagraph",
      "XRHeading",
      "XRListItem",
      "XRBlockQuote",
    ]);
    const INLINE_TYPES = new Set(["XRText", "XRLink", "XRButton"]);
    const intentionallyAbsent = new Set<string>();
    const markInlineChildren = (node: XRPrimitive) => {
      // Standard inline-owning types: their XRText/XRLink/XRButton children
      // are rendered as prose runs and intentionally have no plan entries.
      // Also mark XRGenericPanel wrappers whose effective leaf content is
      // all-inline: the mesh (XRListItemMesh, XRParagraphMesh) uses
      // flattenInlineWrappers to see through them and renders them as prose,
      // so neither the wrapper nor its descendants need plan entries.
      if (INLINE_OWNING.has(node.type)) {
        const flatEffective = flattenInlineWrappers(node.children as any[]);
        const effectivelyAllInline =
          flatEffective.length > 0 &&
          flatEffective.every((c: any) => isInlinePrimitive(c.type));
        if (effectivelyAllInline) {
          // Mark the direct children and all their descendants as absent
          const markAllAbsent = (n: XRPrimitive) => {
            intentionallyAbsent.add(n.id);
            n.children.forEach(markAllAbsent);
          };
          node.children.forEach(markAllAbsent);
        } else {
          // Mixed content: only mark direct inline children as absent
          for (const child of node.children) {
            if (INLINE_TYPES.has(child.type)) {
              intentionallyAbsent.add(child.id);
            }
          }
        }
      }
      // XRGenericPanel acting as a transparent inline wrapper: when ALL its
      // effective children (after flattening nested transparent panels) are
      // inline, the parent renders them as a prose flow via
      // flattenInlineWrappers — so the children have no plan entries and the
      // XRGenericPanel itself may or may not have one.
      //
      // FIX: use flattenInlineWrappers to check transitive inline-ness.
      // Without this, an XRGenericPanel whose children include another
      // XRGenericPanel (e.g. <span><a>…</a></span>) is NOT recognized as an
      // inline wrapper even though its effective leaf content is all-inline.
      if (node.type === "XRGenericPanel" && node.children.length > 0) {
        const flatChildren = flattenInlineWrappers(node.children as any[]);
        const allInline =
          flatChildren.length > 0 &&
          flatChildren.every((c: any) => isInlinePrimitive(c.type));
        if (allInline) {
          intentionallyAbsent.add(node.id);
          // Mark the transitive inline descendants as intentionally absent
          const markAllAbsent = (n: XRPrimitive) => {
            intentionallyAbsent.add(n.id);
            n.children.forEach(markAllAbsent);
          };
          node.children.forEach(markAllAbsent);
        }
      }
      node.children.forEach(markInlineChildren);
    };
    markInlineChildren(scene.root);

    // Check which primitives in the scene have no entry
    const allPrimitiveIds = new Set<string>();
    const collectIds = (node: XRPrimitive) => {
      allPrimitiveIds.add(node.id);
      node.children.forEach(collectIds);
    };
    collectIds(scene.root);

    const missingEntries = Array.from(allPrimitiveIds).filter(
      (id) => !plan.entries[id] && !intentionallyAbsent.has(id),
    );
    if (missingEntries.length > 0) {
      console.warn(`[SCENE] Primitives missing from plan:`, missingEntries);
    }
  }, [plan, scene]);

  const navigate = useCallback(
    (href: string) => {
      // Is this href a fragment of THE DOCUMENT THE READER IS STANDING IN?
      //
      // Not `href.startsWith("#")`, which is only the barest of the three
      // forms a same-document reference takes. `?q=1#x` against this same
      // path, and the fully-qualified form of this page's own URL, are both
      // the same jump — and the second is exactly what a server-rendered
      // table of contents emits. Testing the bare form alone sent those two
      // down the external branch below, which opened a NEW TAB on the
      // document already in front of the reader and started it with fresh
      // navigation memory: the corridor they had walked, and the way back it
      // held, both gone. The classifier had them right all along (they are
      // `arrangement`/`same-document`), so this asks the classifier's own
      // question rather than a weaker one of its own.
      const fragment = sameDocumentFragment(href, sourceUrl ?? null);
      if (fragment !== null) {
        // The fragment is an HTML `id` (e.g. "headings-title"), not a primitive
        // id. Resolve it to the primitive that carried that id (threaded through
        // as `domId`), then page the containing content panel to its page. Fall
        // back to a direct primitive-id match for anchors that already use one.
        let targetId: string | null = plan.entries[fragment] ? fragment : null;
        if (!targetId) {
          for (const [, p] of primitiveMap) {
            if (p.domId === fragment) {
              targetId = p.id;
              break;
            }
          }
        }
        const targetEntry = targetId ? plan.entries[targetId] : undefined;
        if (targetId && targetEntry?.pageIndex !== undefined) {
          // Drill down: clamp paging to the target's section, jump to its
          // start. Only a flip panel has a pager to clamp — see `pageView`.
          const range = pageView
            ? null
            : sectionRangeForTarget(targetId, primitiveMap, plan);
          setFocusedRange(range);
          for (const [, p] of primitiveMap) {
            if (p.type === "XRContentPanel" && hasDescendant(p, targetId)) {
              setPage(p.id, range ? range[0] : targetEntry.pageIndex);
              return;
            }
          }
        }
        // The anchor names nothing this document drew. Still do NOT open a
        // URL: it is a same-document reference either way, and re-fetching the
        // page the reader is on to land at an id that is not there costs them
        // their corridor and gains them nothing.
        return;
      }

      // Resolve relative URLs against the source page URL
      let resolved = href;
      if (sourceUrl && !/^https?:\/\//i.test(href) && !href.startsWith("#")) {
        try {
          resolved = new URL(href, sourceUrl).href;
        } catch {
          resolved = href;
        }
      }

      if (onExternalNavigate) {
        onExternalNavigate(resolved);
      } else {
        window.open(resolved, "_blank", "noopener,noreferrer");
      }
    },
    [
      plan,
      primitiveMap,
      setPage,
      onExternalNavigate,
      sourceUrl,
      setFocusedRange,
      pageView,
    ],
  );

  // The page-paginated content panel drives the current page for gating the
  // persistent complementary aside, which lives at the top level (a sibling of
  // the panel, not a child) and so isn't inside the panel's CurrentPageContext.
  // We re-provide that page around it below so its mutual-exclusion gating —
  // hiding it on pages a section-scoped aside owns — actually takes effect.
  const paginatedPanel = React.useMemo(
    () =>
      scene.root.children.find(
        (p) =>
          p.type === "XRContentPanel" && plan.entries[p.id]?.paginatedByEngine,
      ) ?? null,
    [scene.root.children, plan.entries],
  );
  const paginatedPanelPage = paginatedPanel
    ? (pageState[paginatedPanel.id] ?? 0)
    : -1;

  // Which hand each sibling's door took, as published by the view that placed
  // it. See `PageLinksApi.sideOf` — the classifier cannot answer this, because
  // the side falls out of the door budget, not out of the href.
  const [lateralSides, setLateralSides] = React.useState<
    ReadonlyMap<string, LateralSide>
  >(() => new Map());
  const publishLateralSides = React.useCallback(
    (next: ReadonlyMap<string, LateralSide>) => {
      setLateralSides((prev) => {
        if (prev.size === next.size) {
          let same = true;
          for (const [k, v] of next)
            if (prev.get(k) !== v) {
              same = false;
              break;
            }
          if (same) return prev;
        }
        return next;
      });
    },
    [],
  );
  // A new document's doors have not been placed yet, and last document's sides
  // would mark this one's anchors.
  React.useEffect(() => setLateralSides(new Map()), [scene.root.id]);

  // Every reference on the page, classified once. Both the inline marks and
  // the doors read this, so a mark and its door cannot disagree about which
  // way the link goes — which is the one thing that would break the legend.
  //
  // `dedupe: false`: the collector's default folds repeat destinations into
  // one, which is right for a door budget and wrong here — every OCCURRENCE of
  // an anchor needs its own mark, and two mentions of the same page in one
  // paragraph are two anchors the reader can look at.
  const pageLinks = React.useMemo<PageLinksApi>(() => {
    let links: SpatialLink[] = [];
    try {
      links = collectSpatialLinks(scene, plan, {
        pageUrl: sourceUrl ?? null,
        dedupe: false,
      });
    } catch (err) {
      // A classification failure must not take the document down with it: the
      // page still reads, it simply reads without marks.
      console.error("[links] classification failed", err);
    }
    const byId = new Map(links.map((l) => [l.id, l]));
    return {
      links,
      byId,
      directionOf: (id) => {
        const l = byId.get(id);
        return l ? directionOf(l) : null;
      },
      sideOf: (id) => lateralSides.get(id) ?? null,
      publishSides: publishLateralSides,
    };
    // `lateralSides` is deliberately NOT a dependency: it is written by the
    // view AFTER this memo has been read, and re-running the collector on
    // every publish would re-classify the whole document to learn which hand a
    // door took. The two closures below read the ref/setter, which are stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scene, plan, sourceUrl, lateralSides, publishLateralSides]);

  // Directional-link plumbing, provided once for whichever view is mounted.
  // A view reaches it through `useTraversal()` rather than through four
  // components that each take the props and pass them on unchanged.
  const traversal = React.useMemo<TraversalApi | null>(
    () =>
      onTraverse || onTraverseBack || onTraverseJump
        ? {
            traverse: onTraverse ?? (() => {}),
            back: onTraverseBack ?? (() => {}),
            jump: onTraverseJump ?? (() => {}),
            nav: nav ?? null,
            pending: pending ?? null,
          }
        : null,
    [onTraverse, onTraverseBack, onTraverseJump, nav, pending],
  );

  // The gaze binding between an inline mark and its door — the only channel
  // left now that colour is gone.
  const [litLink, setLitLink] = React.useState<string | null>(null);
  const linkBinding = React.useMemo(
    () => ({ lit: litLink, setLit: setLitLink }),
    [litLink],
  );
  // A new document has no lit anchor; leaving one set would light a door that
  // belongs to a page the reader has walked away from.
  React.useEffect(() => setLitLink(null), [scene.root.id]);

  return (
    <NavigateContext.Provider value={navigate}>
      <PageLinksContext.Provider value={pageLinks}>
        <TraversalContext.Provider value={traversal}>
          <LinkBindingContext.Provider value={linkBinding}>
            <PageRangeContext.Provider value={focusedRange}>
              {scene.root.children.map((primitive) => {
                // Page views (wall/deck/rooms): the ghost field REPLACES the
                // panel — every page renders at its spatial placement. In
                // deck/wall the focused page's ghost morphs forward to the
                // stage (flat, full size, interactive); in rooms nothing moves
                // but the reader, who is walked to the page. Falls back to the
                // normal flip panel when there are too few pages for a spatial
                // field to mean anything.
                if (
                  plan.pageDistribution &&
                  plan.pageDistribution !== "flip" &&
                  primitive === paginatedPanel
                ) {
                  const pageCount =
                    plan.entries[primitive.id]?.pagination?.pageCount ?? 1;
                  if (pageCount >= MIN_PAGES_FOR_PAGE_VIEWS) {
                    return (
                      <PageGhostField
                        key={primitive.id}
                        panel={primitive}
                        plan={plan}
                        pageState={pageState}
                        setPage={setPage}
                        primitiveMap={primitiveMap}
                      />
                    );
                  }
                  // fall through to the normal dispatcher below
                }

                // A top-level complementary aside that the engine gated to a page
                // range (pageIndex set) needs the paginated panel's current page in
                // context so entryOnPage can hide it on excluded pages. Without this
                // wrapper it renders under the default CurrentPageContext (-1) and is
                // always visible, overlapping whichever section aside owns the slot.
                const dispatcher = (
                  <PrimitiveDispatcher
                    key={primitive.id}
                    primitive={primitive}
                    plan={plan}
                    pageState={pageState}
                    setPage={setPage}
                    primitiveMap={primitiveMap}
                  />
                );
                if (
                  primitive.type === "XRComplementary" &&
                  plan.entries[primitive.id]?.pageIndex !== undefined &&
                  paginatedPanelPage !== -1
                ) {
                  return (
                    <CurrentPageContext.Provider
                      key={primitive.id}
                      value={paginatedPanelPage}
                    >
                      {dispatcher}
                    </CurrentPageContext.Provider>
                  );
                }
                return dispatcher;
              })}
              {focusedRange && (
                <SectionResetChip
                  slots={plan.slots}
                  onClear={() => setFocusedRange(null)}
                />
              )}
            </PageRangeContext.Provider>
          </LinkBindingContext.Provider>
        </TraversalContext.Provider>
      </PageLinksContext.Provider>
    </NavigateContext.Provider>
  );
}
