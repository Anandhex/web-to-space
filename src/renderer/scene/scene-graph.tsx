/**
 * scene/scene-graph.tsx
 *
 * <XRSceneGraph> — builds the primitive lookup map and reference frame, then
 * dispatches every top-level primitive; includes the reference-frame group and
 * carousel neighbour wiring.
 */
import React, { useCallback, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { Line, Text } from "@react-three/drei";
import * as THREE from "three";

import type { SemanticScene, XRPrimitive } from "../../mapper/types";
import type {
  LandmarkSlot,
  LayoutEntry,
  LayoutPlan,
  SlotMap,
} from "../../layout/types";
import type { ViewMode } from "../../components/viewTypes";
import {
  flattenInlineWrappers,
  isInlinePrimitive,
} from "../../layout/utils";
import { carouselGhostPlacement } from "../../layout/placement";
import { NavigateContext } from "../primitives";
import {
  CurrentPageContext,
  PageRangeContext,
  type PageState,
} from "./contexts";
import { hasDescendant } from "./dispatch-children";
import { PrimitiveDispatcher } from "./dispatcher";
import { CarouselGhostPanel } from "./panels";

export function buildPrimitiveMap(
  root: XRPrimitive,
  out: Map<string, XRPrimitive> = new Map(),
): Map<string, XRPrimitive> {
  out.set(root.id, root);
  for (const child of root.children) buildPrimitiveMap(child, out);
  return out;
}

// ─────────────────────────────────────────────────────────────
// Slot tethers (EXPLODED / CONSTELLATION)
// ─────────────────────────────────────────────────────────────

/** Panel centre from a top-left-origin slot (y grows downward). */
function slotCentre(slot: LandmarkSlot): [number, number, number] {
  return [
    slot.position.x + slot.size.width / 2,
    slot.position.y - slot.size.height / 2,
    slot.position.z,
  ];
}

/**
 * Draws relationship lines from the primary (`main`) panel to every other
 * landmark panel. EXPLODED reads them as the connective spine of a disassembled
 * page; CONSTELLATION reads them as the spokes of a node-link mind-map. The
 * endpoints come straight from the resolved SlotMap, so the tethers always track
 * whatever the active distribution placed — no separate geometry to keep in sync.
 */
function SlotTethers({ slots }: { slots: SlotMap }) {
  const main = slots.main;
  if (!main) return null;
  const hub = slotCentre(main);
  const roles: (keyof SlotMap)[] = [
    "navigation",
    "complementary",
    "toc",
    "banner",
    "footer",
  ];
  return (
    <>
      {roles.map((role) => {
        const slot = slots[role];
        if (!slot) return null;
        return (
          <Line
            key={role}
            points={[hub, slotCentre(slot)]}
            color="#58a6ff"
            lineWidth={1.5}
            transparent
            opacity={0.4}
            dashed
            dashSize={0.06}
            gapSize={0.04}
          />
        );
      })}
    </>
  );
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
   * Pick the grip space for the off-hand (left for a right-handed user) so the
   * palm/tablet sits on the non-dominant hand and the dominant hand is free to
   * point. Falls back to grip 0. Returns null when no grip has a live pose.
   */
  function offHandGrip(gl: THREE.WebGLRenderer): THREE.Object3D | null {
    const session = gl.xr.getSession();
    let index = 0;
    if (session) {
      const sources = Array.from(session.inputSources);
      const left = sources.findIndex((s) => s.handedness === "left");
      if (left >= 0) index = left;
    }
    const grip = gl.xr.getControllerGrip(index);
    // three toggles grip.visible based on whether the input source has a pose.
    if (!grip || grip.visible === false) return null;
    return grip;
  }

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
      const grip = offHandGrip(state.gl);
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

/** Absolute placement override for a carousel ghost panel (from the tuning HUD). */
export interface GhostPose {
  x: number;
  y: number;
  z: number;
  rotX: number;
  rotY: number;
  rotZ: number;
}

export function XRSceneGraph({
  scene,
  plan,
  pageState,
  setPage,
  viewMode,
  onExternalNavigate,
  sourceUrl,
  ghostOverride,
}: {
  scene: SemanticScene;
  plan: LayoutPlan;
  pageState: PageState;
  setPage: (id: string, page: number) => void;
  viewMode?: ViewMode;
  onExternalNavigate?: (href: string) => void;
  sourceUrl?: string;
  /** Live ghost overrides keyed "ghost-prev"/"ghost-next" (tuning HUD). */
  ghostOverride?: Record<string, GhostPose>;
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

  // ── Carousel: find the main XRContentPanel for 3× rendering ─────
  const mainContentPanel = React.useMemo(() => {
    if (viewMode !== "carousel") return null;
    return (
      scene.root.children.find(
        (p) =>
          p.type === "XRContentPanel" && plan.entries[p.id]?.paginatedByEngine,
      ) ?? null
    );
  }, [viewMode, scene.root.children, plan.entries]);

  const navigate = useCallback(
    (href: string) => {
      if (href.startsWith("#")) {
        const fragment = decodeURIComponent(href.slice(1));
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
          // Drill down: clamp paging to the target's section, jump to its start.
          const range = sectionRangeForTarget(targetId, primitiveMap, plan);
          setFocusedRange(range);
          for (const [, p] of primitiveMap) {
            if (p.type === "XRContentPanel" && hasDescendant(p, targetId)) {
              setPage(p.id, range ? range[0] : targetEntry.pageIndex);
              return;
            }
          }
        }
        // anchor not found in plan — nothing to navigate to; do not open a URL.
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
    [plan, primitiveMap, setPage, onExternalNavigate, sourceUrl, setFocusedRange],
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

  return (
    <NavigateContext.Provider value={navigate}>
      <PageRangeContext.Provider value={focusedRange}>
      {scene.root.children.map((primitive) => {
        // In carousel mode, the main content panel is rendered via CarouselPanelGroup
        if (viewMode === "carousel" && primitive === mainContentPanel) {
          const entry = plan.entries[primitive.id];
          if (!entry) return null;
          // Ghost panels: default placement from the shared helper (so the
          // tuning HUD seeds from the same values), overridable live per ghost.
          const ghost = carouselGhostPlacement(entry.position, entry.size);
          const poseEntry = (
            base: { position: { x: number; y: number; z: number }; rotation: LayoutEntry["rotation"] },
            ov: GhostPose | undefined,
          ): LayoutEntry => ({
            ...entry,
            position: ov ? { x: ov.x, y: ov.y, z: ov.z } : base.position,
            rotation: ov ? { x: ov.rotX, y: ov.rotY, z: ov.rotZ } : base.rotation,
          });
          const prevEntry = poseEntry(ghost.prev, ghostOverride?.["ghost-prev"]);
          const nextEntry = poseEntry(ghost.next, ghostOverride?.["ghost-next"]);

          const currentPage = pageState[primitive.id] ?? 0;
          const pageCount = entry.pagination?.pageCount ?? 1;
          const prevPage = Math.max(0, currentPage - 1);
          const nextPage = Math.min(pageCount - 1, currentPage + 1);

          return (
            <React.Fragment key={primitive.id}>
              {currentPage > 0 && (
                <CarouselGhostPanel
                  primitive={primitive}
                  plan={plan}
                  entry={prevEntry}
                  targetPage={prevPage}
                  primitiveMap={primitiveMap}
                  opacity={0.45}
                />
              )}
              <PrimitiveDispatcher
                primitive={primitive}
                plan={plan}
                pageState={pageState}
                setPage={setPage}
                primitiveMap={primitiveMap}
              />
              {currentPage < pageCount - 1 && (
                <CarouselGhostPanel
                  primitive={primitive}
                  plan={plan}
                  entry={nextEntry}
                  targetPage={nextPage}
                  primitiveMap={primitiveMap}
                  opacity={0.45}
                />
              )}
            </React.Fragment>
          );
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
      {(viewMode === "exploded" || viewMode === "constellation") && (
        <SlotTethers slots={plan.slots} />
      )}
      </PageRangeContext.Provider>
    </NavigateContext.Provider>
  );
}

// ─────────────────────────────────────────────────────────────
// VR button
// ─────────────────────────────────────────────────────────────

