/**
 * XRSceneRenderer.tsx
 *
 * Positioning contract
 * ────────────────────
 * The layout engine outputs entry.position in two coordinate spaces:
 *
 *   Top-level landmark panels  → world space (e.g. x=0, y=1.4, z=-1.2)
 *   All children               → LOCAL space relative to their parent panel's
 *                                top-left origin (e.g. x=0.04, y=-0.04, z=0)
 *
 * Because Three.js group transforms compose automatically, the correct
 * rendering strategy is simply:
 *
 *   1. Every primitive gets a <group position={entry.position}> wrapper.
 *   2. Every mesh component receives zeroedEntry() so its internal
 *      entryTransform() group is at [0,0,0] — not double-applying position.
 *   3. Children are dispatched INSIDE the parent's <group>, inheriting
 *      the parent's world transform. Their local-space entry.position
 *      then resolves correctly via Three.js group composition.
 *
 * Pagination contract
 * ───────────────────
 * The layout engine stamps entry.pageIndex on every primitive that lives
 * under a paginating XRContentPanel. The renderer gates on this value:
 *
 *   • XRContentPanel sets CurrentPageContext to the user's current page.
 *   • Every PrimitiveDispatcher reads CurrentPageContext and returns null
 *     if entry.pageIndex is defined and !== currentPage.
 *   • No ID lists, no slice maps, no position re-basing needed — the
 *     engine assigns correct page-relative positions to every primitive.
 *
 * Clipping
 * ────────
 * XRContentPanel builds world-space THREE.Plane clip planes and provides
 * them via ClipPlanesContext so descendant materials can clip geometry
 * that would bleed outside the panel viewport.
 */

import React, {
  useState,
  useCallback,
  Suspense,
  useEffect,
  useMemo,
} from "react";
import { Canvas } from "@react-three/fiber";
import {
  OrbitControls,
  Environment,
  GizmoHelper,
  GizmoViewport,
  Text,
  RoundedBox,
} from "@react-three/drei";

import { parsePageToIR } from "../ir/parser";
import { mapIRToScene, DEFAULT_MAPPER_CONFIG } from "../mapper/mapper";
import { computeLayoutPlan, DEFAULT_LAYOUT_CONFIG } from "../layout/engine";
import type {
  SpatialScene,
  XRPrimitive,
  XRHeading,
  XRParagraph,
  XRSection,
  XRNavigationBar,
  XRMediaPlayer,
  XRCodeBlock,
  XRBlockQuote,
  XRSeparator,
  XRProgressBar,
  XRImage,
  XRCard,
  XRButton,
  XRAlert,
  XRTable,
  XRFormField,
  XRTabGroup,
} from "../mapper/mapper";
import type { LayoutPlan, LayoutEntry, LayoutConfig } from "../layout/engine";

import { useXRSession } from "./useXRSession";
import {
  XRHeadingMesh,
  XRParagraphMesh,
  XRSectionMesh,
  XRNavigationMesh,
  XRMediaMesh,
  XRCodeBlockMesh,
  XRBlockQuoteMesh,
  XRSeparatorMesh,
  XRProgressBarMesh,
  XRImageMesh,
  XRCardMesh,
  XRButtonMesh,
  XRAlertMesh,
  XRTableMesh,
  XRFormFieldMesh,
  XRTabGroupMesh,
  ClipPlanesContext,
  ClippedText,
} from "./primitives";
import * as THREE from "three";

// ─────────────────────────────────────────────────────────────
// Current-page context
// ─────────────────────────────────────────────────────────────

/**
 * Provides the current page index to all descendants of a paginating
 * XRContentPanel. PrimitiveDispatcher reads this to gate rendering on
 * entry.pageIndex — no prop drilling needed.
 *
 * Default -1 means "no pagination active" — all primitives render.
 */
const CurrentPageContext = React.createContext<number>(-1);

// ─────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────

export interface XRSceneRendererProps {
  html?: string;
  url?: string;
  scene?: SpatialScene;
  layoutConfig?: Partial<LayoutConfig>;
  width?: string | number;
  height?: string | number;
  background?: string;
  onPlanReady?: (plan: LayoutPlan) => void;
}

// PageState maps paginating panel IDs to the user's current page index.
type PageState = Record<string, number>;

// ─────────────────────────────────────────────────────────────
// zeroedEntry
// ─────────────────────────────────────────────────────────────

/**
 * Strip position and rotation from an entry before passing to a mesh component.
 *
 * Every mesh component calls entryTransform(entry) internally and renders
 * <group position={pos} rotation={rot}>. The dispatcher's outer <group>
 * already owns the translation, so we zero the entry to prevent a
 * second application.
 */
function zeroedEntry(entry: LayoutEntry): LayoutEntry {
  return {
    ...entry,
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0 },
  };
}

// ─────────────────────────────────────────────────────────────
// Pipeline hook
// ─────────────────────────────────────────────────────────────

function usePipeline(
  html: string | undefined,
  sceneIn: SpatialScene | undefined,
  url: string | undefined,
  layoutConfig: Partial<LayoutConfig>,
) {
  const [result, setResult] = useState({
    scene: null as SpatialScene | null,
    plan: null as LayoutPlan | null,
    error: null as string | null,
  });

  useEffect(() => {
    let cancelled = false;

    async function run() {
      try {
        let scene: SpatialScene;
        if (sceneIn) {
          scene = sceneIn;
        } else if (html) {
          const ir = await parsePageToIR(html, url!);
          scene = mapIRToScene(ir, DEFAULT_MAPPER_CONFIG);
        } else {
          if (!cancelled)
            setResult({
              scene: null,
              plan: null,
              error: "No html or scene provided.",
            });
          return;
        }
        const config = { ...DEFAULT_LAYOUT_CONFIG, ...layoutConfig };
        const plan = computeLayoutPlan(scene, scene.template, config);
        if (!cancelled) setResult({ scene, plan, error: null });
      } catch (err) {
        if (!cancelled)
          setResult({
            scene: null,
            plan: null,
            error: err instanceof Error ? err.message : "Pipeline error.",
          });
      }
    }

    run();
    return () => {
      cancelled = true;
    };
  }, [html, sceneIn, url]);

  return result;
}

// ─────────────────────────────────────────────────────────────
// Primitive dispatcher
// ─────────────────────────────────────────────────────────────

/**
 * Dedicated component for XRContentPanel so hooks (useMemo) are called
 * unconditionally at the top of the function — not inside a switch case.
 *
 * This component owns pagination state for the panel. It:
 *   1. Sets CurrentPageContext so every descendant PrimitiveDispatcher
 *      can gate itself against entry.pageIndex.
 *   2. Renders ALL direct children — the pageIndex gate in PrimitiveDispatcher
 *      handles visibility; no filtering happens here.
 *   3. Shows pagination controls when pageCount > 1.
 */
function XRContentPanelRenderer({
  primitive,
  plan,
  pageState,
  setPage,
  primitiveMap,
  entry,
}: DispatcherProps & { entry: LayoutEntry }) {
  const currentPage = pageState[primitive.id] ?? 0;
  const pagination = entry.pagination;

  const ex = entry.position.x;
  const ey = entry.position.y;
  const ez = entry.position.z;
  const rot: [number, number, number] = [
    entry.rotation.x,
    entry.rotation.y,
    entry.rotation.z,
  ];

  const panelClipPlanes = useMemo(
    () => buildPanelClipPlanes(ey, entry.size.height),
    [ey, entry.size.height],
  );

  return (
    <CurrentPageContext.Provider value={currentPage}>
      <group key={primitive.id} position={[ex, ey, ez]} rotation={rot}>
        <PanelBacking entry={zeroedEntry(entry)} opacity={0.35} />
        <ClipPlanesContext.Provider value={panelClipPlanes}>
          {primitive.children.map((child) => (
            <PrimitiveDispatcher
              key={child.id}
              primitive={child}
              plan={plan}
              pageState={pageState}
              setPage={setPage}
              primitiveMap={primitiveMap}
            />
          ))}
        </ClipPlanesContext.Provider>
        {pagination && pagination.pageCount > 1 && (
          <PaginationControls
            primitiveId={primitive.id}
            pagination={pagination}
            currentPage={currentPage}
            entry={zeroedEntry(entry)}
            onPageChange={(p) => setPage(primitive.id, p)}
          />
        )}
      </group>
    </CurrentPageContext.Provider>
  );
}

interface DispatcherProps {
  primitive: XRPrimitive;
  plan: LayoutPlan;
  pageState: PageState;
  setPage: (id: string, page: number) => void;
  primitiveMap: Map<string, XRPrimitive>;
}

/**
 * Renders a primitive and recursively its children.
 *
 * Pattern for every case:
 *   <group position={[ex, ey, ez]}>   ← entry.position, used as-is (local or world)
 *     <XRFooMesh entry={zeroedEntry(entry)} .../>   ← mesh at origin of group
 *   </group>
 *
 * For containers, children are dispatched INSIDE the group so they inherit
 * the parent's transform. Each child's entry.position is already a local
 * offset from the engine, so Three.js group composition handles the rest.
 */
function PrimitiveDispatcher({
  primitive,
  plan,
  pageState,
  setPage,
  primitiveMap,
}: DispatcherProps) {
  const entry = plan.entries[primitive.id];
  const currentPage = React.useContext(CurrentPageContext);

  const renderChild = useCallback(
    (childId: string) => {
      const childPrim = primitiveMap.get(childId);
      if (!childPrim || !plan.entries[childId]) return null;
      return (
        <PrimitiveDispatcher
          key={childId}
          primitive={childPrim}
          plan={plan}
          pageState={pageState}
          setPage={setPage}
          primitiveMap={primitiveMap}
        />
      );
    },
    [primitiveMap, plan, pageState, setPage],
  );

  if (!entry) return null;

  // Gate on pageIndex: if the engine assigned this primitive to a specific
  // page and it doesn't match the panel's current page, skip rendering.
  // currentPage === -1 means no pagination is active (render everything).
  if (
    entry.pageIndex !== undefined &&
    currentPage !== -1 &&
    entry.pageIndex !== currentPage
  ) {
    return null;
  }

  const ex = entry.position.x;
  const ey = entry.position.y;
  const ez = entry.position.z;
  const rot: [number, number, number] = [
    entry.rotation.x,
    entry.rotation.y,
    entry.rotation.z,
  ];

  switch (primitive.type) {
    // ── Leaf primitives ───────────────────────────────────────────────────
    // Group positions the primitive; zeroedEntry prevents double-application
    // inside the mesh's own entryTransform() call.

    case "XRHeading":
      return (
        <group key={primitive.id} position={[ex, ey, ez]} rotation={rot}>
          <XRHeadingMesh
            primitive={primitive as XRHeading}
            entry={zeroedEntry(entry)}
          />
        </group>
      );

    case "XRParagraph":
      return (
        <group key={primitive.id} position={[ex, ey, ez]} rotation={rot}>
          <XRParagraphMesh
            primitive={primitive as XRParagraph}
            entry={zeroedEntry(entry)}
          />
        </group>
      );

    case "XRNavigationBar":
      return (
        <group key={primitive.id} position={[ex, ey, ez]} rotation={rot}>
          <XRNavigationMesh
            primitive={primitive as XRNavigationBar}
            entry={zeroedEntry(entry)}
          />
        </group>
      );

    case "XRMediaPlayer":
      return (
        <group key={primitive.id} position={[ex, ey, ez]} rotation={rot}>
          <XRMediaMesh
            primitive={primitive as XRMediaPlayer}
            entry={zeroedEntry(entry)}
          />
        </group>
      );

    case "XRCodeBlock":
      return (
        <group key={primitive.id} position={[ex, ey, ez]} rotation={rot}>
          <XRCodeBlockMesh
            primitive={primitive as XRCodeBlock}
            entry={zeroedEntry(entry)}
          />
        </group>
      );

    case "XRBlockQuote":
      return (
        <group key={primitive.id} position={[ex, ey, ez]} rotation={rot}>
          <XRBlockQuoteMesh
            primitive={primitive as XRBlockQuote}
            entry={zeroedEntry(entry)}
          />
        </group>
      );

    case "XRSeparator":
      return (
        <group key={primitive.id} position={[ex, ey, ez]} rotation={rot}>
          <XRSeparatorMesh
            primitive={primitive as XRSeparator}
            entry={zeroedEntry(entry)}
          />
        </group>
      );

    case "XRProgressBar":
      return (
        <group key={primitive.id} position={[ex, ey, ez]} rotation={rot}>
          <XRProgressBarMesh
            primitive={primitive as XRProgressBar}
            entry={zeroedEntry(entry)}
          />
        </group>
      );

    case "XRImage":
    case "XRFigure":
      return (
        <group key={primitive.id} position={[ex, ey, ez]} rotation={rot}>
          <XRImageMesh
            primitive={primitive as XRImage}
            entry={zeroedEntry(entry)}
          />
        </group>
      );

    case "XRButton":
      return (
        <group key={primitive.id} position={[ex, ey, ez]} rotation={rot}>
          <XRButtonMesh
            primitive={primitive as XRButton}
            entry={zeroedEntry(entry)}
          />
        </group>
      );

    case "XRAlert":
      return (
        <group key={primitive.id} position={[ex, ey, ez]} rotation={rot}>
          <XRAlertMesh
            primitive={primitive as XRAlert}
            entry={zeroedEntry(entry)}
          />
        </group>
      );

    case "XRFormField":
      return (
        <group key={primitive.id} position={[ex, ey, ez]} rotation={rot}>
          <XRFormFieldMesh
            primitive={primitive as XRFormField}
            entry={zeroedEntry(entry)}
          />
        </group>
      );

    // ── XRSection ─────────────────────────────────────────────────────────
    // Renders all children — the pageIndex gate in PrimitiveDispatcher already
    // hides children that don't belong to the current page.
    //
    // Passes childEntries (filtered to current page) to XRSectionMesh so it
    // can size its backing panel correctly. Also computes isContinuation /
    // hasMore for the edge-indicator stripes.

    case "XRSection": {
      // Children whose pageIndex matches the current page (or all if no pagination).
      const visibleChildren = primitive.children.filter((child) => {
        const ce = plan.entries[child.id];
        if (!ce) return false;
        if (ce.pageIndex === undefined || currentPage === -1) return true;
        return ce.pageIndex === currentPage;
      });

      const visibleChildEntries = visibleChildren
        .map((c) => plan.entries[c.id])
        .filter((ce): ce is LayoutEntry => ce !== undefined);

      // Continuation indicators: compare the section's own pageIndex to its
      // first / last child's pageIndex.
      const sectionPage = entry.pageIndex;
      const firstChildPage = plan.entries[primitive.children[0]?.id]?.pageIndex;
      const lastChildPage =
        plan.entries[primitive.children[primitive.children.length - 1]?.id]
          ?.pageIndex;

      const isContinuation =
        sectionPage !== undefined &&
        firstChildPage !== undefined &&
        firstChildPage !== sectionPage &&
        currentPage !== sectionPage;

      const hasMore =
        lastChildPage !== undefined &&
        currentPage !== -1 &&
        lastChildPage > currentPage;

      return (
        <group key={primitive.id} position={[ex, ey, ez]} rotation={rot}>
          <XRSectionMesh
            primitive={primitive as XRSection}
            entry={zeroedEntry(entry)}
            childEntries={visibleChildEntries}
            renderChild={renderChild}
            isContinuation={isContinuation}
            hasMore={hasMore}
          />
        </group>
      );
    }

    // ── XRContentPanel ────────────────────────────────────────────────────
    // Delegated to XRContentPanelRenderer (dedicated component for hooks).
    // Sets CurrentPageContext so all descendants can gate on entry.pageIndex.

    case "XRContentPanel":
      // Delegated to a dedicated component so useMemo is called unconditionally
      // at the top of that function (React hooks rules).
      return (
        <XRContentPanelRenderer
          key={primitive.id}
          primitive={primitive}
          plan={plan}
          pageState={pageState}
          setPage={setPage}
          primitiveMap={primitiveMap}
          entry={entry}
        />
      );

    // ── Non-paginating containers ─────────────────────────────────────────
    // Group at entry.position; children dispatched inside, inheriting transform.

    case "XRArticle":
    case "XRFormPanel":
    case "XRBanner":
    case "XRFooter":
    case "XRComplementary": {
      return (
        <group key={primitive.id} position={[ex, ey, ez]} rotation={rot}>
          <PanelBacking entry={zeroedEntry(entry)} opacity={0.2} />
          {primitive.children.map((child) => (
            <PrimitiveDispatcher
              key={child.id}
              primitive={child}
              plan={plan}
              pageState={pageState}
              setPage={setPage}
              primitiveMap={primitiveMap}
            />
          ))}
        </group>
      );
    }

    // ── XRCard ────────────────────────────────────────────────────────────
    // Card mesh renders its own chrome; children via renderChild.
    // renderChild is called from inside XRCardMesh's own group (zeroed),
    // so child local positions resolve correctly.

    case "XRCard": {
      return (
        <group key={primitive.id} position={[ex, ey, ez]} rotation={rot}>
          <XRCardMesh
            primitive={primitive as XRCard}
            entry={zeroedEntry(entry)}
            renderChild={renderChild}
          />
        </group>
      );
    }

    // ── XRCardGrid ────────────────────────────────────────────────────────

    case "XRCardGrid": {
      return (
        <group key={primitive.id} position={[ex, ey, ez]} rotation={rot}>
          {primitive.children.map((child) => (
            <PrimitiveDispatcher
              key={child.id}
              primitive={child}
              plan={plan}
              pageState={pageState}
              setPage={setPage}
              primitiveMap={primitiveMap}
            />
          ))}
        </group>
      );
    }

    // ── XRTable ───────────────────────────────────────────────────────────

    case "XRTable": {
      return (
        <group key={primitive.id} position={[ex, ey, ez]} rotation={rot}>
          <XRTableMesh
            primitive={primitive as XRTable}
            entry={zeroedEntry(entry)}
            renderChild={renderChild}
          />
        </group>
      );
    }

    // ── XRTableRow / XRTableCell ──────────────────────────────────────────

    case "XRTableRow":
    case "XRTableCell": {
      return (
        <group key={primitive.id} position={[ex, ey, ez]} rotation={rot}>
          {primitive.children.map((child) => (
            <PrimitiveDispatcher
              key={child.id}
              primitive={child}
              plan={plan}
              pageState={pageState}
              setPage={setPage}
              primitiveMap={primitiveMap}
            />
          ))}
        </group>
      );
    }

    // ── XRTabGroup ────────────────────────────────────────────────────────

    case "XRTabGroup": {
      return (
        <group key={primitive.id} position={[ex, ey, ez]} rotation={rot}>
          <XRTabGroupMesh
            primitive={primitive as XRTabGroup}
            entry={zeroedEntry(entry)}
            renderChild={renderChild}
          />
        </group>
      );
    }

    // ── Inline interactive elements ───────────────────────────────────────

    case "XRTab":
    case "XRTabPanel":
    case "XRMenu":
    case "XRMenuItem":
    case "XRTree":
    case "XRTreeItem":
    case "XRDialog":
    case "XRTooltip":
    case "XRSearchBox":
    case "XRSlider":
    case "XRToggle":
    case "XRComboBox":
    case "XRLink": {
      const w = Math.max(entry.size.width, 0.025);
      return (
        <group key={primitive.id} position={[ex, ey, ez]}>
          <ClippedText
            anchorX="left"
            anchorY="top"
            position={[0.008, -0.008, 0.004]}
            fontSize={0.018}
            color="#7aa2cc"
            maxWidth={w - 0.016}
          >
            {primitive.label ?? primitive.type}
          </ClippedText>
        </group>
      );
    }

    // ── Generic fallback ──────────────────────────────────────────────────

    default: {
      return (
        <group key={primitive.id} position={[ex, ey, ez]} rotation={rot}>
          <GenericPanelMesh primitive={primitive} entry={zeroedEntry(entry)} />
          {primitive.children.map((child) => (
            <PrimitiveDispatcher
              key={child.id}
              primitive={child}
              plan={plan}
              pageState={pageState}
              setPage={setPage}
              primitiveMap={primitiveMap}
            />
          ))}
        </group>
      );
    }
  }
}

// ─────────────────────────────────────────────────────────────
// Sub-components
// ─────────────────────────────────────────────────────────────

/**
 * Translucent backing plane for container panels.
 * Always rendered at group origin (entry.position must be zeroed by caller).
 */
function PanelBacking({
  entry,
  opacity,
}: {
  entry: LayoutEntry;
  opacity: number;
}) {
  const w = entry.size.width;
  const h = entry.size.height;
  return (
    <mesh position={[w / 2, -h / 2, -0.002]}>
      <planeGeometry args={[w, h]} />
      <meshStandardMaterial color="#0d1117" transparent opacity={opacity} />
    </mesh>
  );
}

/**
 * Debug overlay for unrecognised primitive types.
 * Rendered at origin — outer group handles placement.
 */
function GenericPanelMesh({
  primitive,
  entry,
}: {
  primitive: XRPrimitive;
  entry: LayoutEntry;
}) {
  const w = Math.max(entry.size.width, 0.025);
  const h = Math.max(entry.size.height, 0.032);
  return (
    <>
      <mesh position={[w / 2, -h / 2, -0.003]}>
        <planeGeometry args={[w, h]} />
        <meshStandardMaterial color="#0d1117" transparent opacity={0.28} />
      </mesh>
      <Text
        anchorX="left"
        anchorY="top"
        position={[0.006, -0.005, 0.001]}
        fontSize={0.011}
        color="#3a5068"
        maxWidth={w - 0.012}
      >
        {`${primitive.type}${primitive.label ? ` · ${primitive.label.slice(0, 32)}` : ""}`}
      </Text>
    </>
  );
}

/** XR-native prev/next page buttons. entry must be zeroed by caller. */
function PaginationControls({
  primitiveId: _id,
  pagination,
  currentPage,
  entry,
  onPageChange,
}: {
  primitiveId: string;
  pagination: { pageCount: number };
  currentPage: number;
  entry: LayoutEntry;
  onPageChange: (page: number) => void;
}) {
  const w = entry.size.width;
  const h = entry.size.height;
  const BTN_W = 0.1;
  const BTN_H = 0.038;
  const barY = -(h + BTN_H / 2 + 0.016);

  return (
    <group position={[0, barY, 0.005]}>
      <group
        position={[BTN_W / 2, 0, 0]}
        onClick={() => onPageChange(Math.max(0, currentPage - 1))}
      >
        <RoundedBox
          args={[BTN_W, BTN_H, 0.006]}
          radius={Math.min(BTN_H / 2, 0.0029)}
        >
          <meshStandardMaterial
            color={currentPage === 0 ? "#1a1f2e" : "#1a2840"}
            transparent
            opacity={0.8}
          />
        </RoundedBox>
        <Text
          anchorX="center"
          anchorY="middle"
          position={[0, 0, 0.005]}
          fontSize={0.018}
          color="#fff"
        >
          ← Prev
        </Text>
      </group>

      <Text
        anchorX="center"
        anchorY="middle"
        position={[w / 2, 0, 0]}
        fontSize={0.016}
        color="#fff"
      >
        {`${currentPage + 1} / ${pagination.pageCount}`}
      </Text>

      <group
        position={[w - BTN_W / 2, 0, 0]}
        onClick={() =>
          onPageChange(Math.min(pagination.pageCount - 1, currentPage + 1))
        }
      >
        <RoundedBox
          args={[BTN_W, BTN_H, 0.006]}
          radius={Math.min(BTN_H / 2, 0.0029)}
        >
          <meshStandardMaterial
            color={
              currentPage === pagination.pageCount - 1 ? "#1a1f2e" : "#1a2840"
            }
            transparent
            opacity={0.8}
          />
        </RoundedBox>
        <Text
          anchorX="center"
          anchorY="middle"
          position={[0, 0, 0.005]}
          fontSize={0.018}
          color="#fff"
        >
          Next →
        </Text>
      </group>
    </group>
  );
}

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

/**
 * Build world-space THREE.Plane clipping planes for an XRContentPanel.
 *
 * The panel occupies [worldY, worldY - panelHeight] in world Y.
 * We clip anything above the top edge and below the bottom edge.
 *
 * Two planes are returned:
 *   • top    — clips geometry above the panel top       (normal: 0, -1, 0)
 *   • bottom — clips geometry below the panel bottom    (normal: 0, +1, 0)
 *
 * Because Three.js clipping planes are in WORLD space and `localClippingEnabled`
 * is true, these planes correctly clip all descendant geometry regardless of
 * nesting depth or local transforms.
 *
 * @param worldY      Y coordinate of the panel's top-left origin (metres).
 * @param panelHeight Height of the panel viewport (metres).
 */
function buildPanelClipPlanes(
  worldY: number,
  panelHeight: number,
): THREE.Plane[] {
  // Top clip: discard points where y > worldY  → normal (0,-1,0), constant = worldY
  const topPlane = new THREE.Plane(new THREE.Vector3(0, -1, 0), worldY);
  // Bottom clip: discard points where y < worldY - panelHeight → normal (0,1,0), constant = -(worldY - panelHeight)
  const bottomPlane = new THREE.Plane(
    new THREE.Vector3(0, 1, 0),
    -(worldY - panelHeight),
  );
  return [topPlane, bottomPlane];
}

function buildPrimitiveMap(
  root: XRPrimitive,
  out: Map<string, XRPrimitive> = new Map(),
): Map<string, XRPrimitive> {
  out.set(root.id, root);
  for (const child of root.children) buildPrimitiveMap(child, out);
  return out;
}

// ─────────────────────────────────────────────────────────────
// Scene graph
// ─────────────────────────────────────────────────────────────

function XRSceneGraph({
  scene,
  plan,
  pageState,
  setPage,
}: {
  scene: SpatialScene;
  plan: LayoutPlan;
  pageState: PageState;
  setPage: (id: string, page: number) => void;
}) {
  const primitiveMap = React.useMemo(
    () => buildPrimitiveMap(scene.root),
    [scene.root],
  );

  console.log("Rendering XRSceneGraph with scene", scene, "and plan", plan);

  return (
    <>
      {scene.root.children.map((primitive) => (
        <PrimitiveDispatcher
          key={primitive.id}
          primitive={primitive}
          plan={plan}
          pageState={pageState}
          setPage={setPage}
          primitiveMap={primitiveMap}
        />
      ))}
    </>
  );
}

// ─────────────────────────────────────────────────────────────
// VR button
// ─────────────────────────────────────────────────────────────

function VRButton({
  supported,
  sessionState,
  error,
  onEnter,
  onExit,
}: {
  supported: boolean;
  sessionState: "idle" | "immersive";
  error: string | null;
  onEnter: () => void;
  onExit: () => void;
}) {
  return (
    <div style={styles.vrButtonRow}>
      {!supported && (
        <span style={styles.unsupported}>
          WebXR not available — inline preview only
        </span>
      )}
      {supported && sessionState === "idle" && (
        <button style={styles.vrBtn} onClick={onEnter}>
          <span style={styles.vrBtnIcon}>◎</span> Enter VR
        </button>
      )}
      {supported && sessionState === "immersive" && (
        <button
          style={{ ...styles.vrBtn, ...styles.vrBtnExit }}
          onClick={onExit}
        >
          <span style={styles.vrBtnIcon}>✕</span> Exit VR
        </button>
      )}
      {error && <span style={styles.error}>{error}</span>}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Main component
// ─────────────────────────────────────────────────────────────

export function XRSceneRenderer({
  html,
  url,
  scene: sceneIn,
  layoutConfig = {},
  width = "100%",
  height = "600px",
  background = "#050a10",
  onPlanReady,
}: XRSceneRendererProps) {
  const {
    scene,
    plan,
    error: pipelineError,
  } = usePipeline(html, sceneIn, url, layoutConfig);
  const {
    sessionState,
    capabilities,
    session,
    enterVR,
    exitVR,
    error: xrError,
  } = useXRSession();
  const [pageState, setPageStateMap] = useState<PageState>({});

  const setPage = useCallback((id: string, page: number) => {
    setPageStateMap((prev) => ({ ...prev, [id]: page }));
  }, []);

  useEffect(() => {
    if (plan && onPlanReady) onPlanReady(plan);
  }, [plan, onPlanReady]);

  if (pipelineError) {
    return (
      <div style={{ ...styles.root, color: "#ff6b6b", padding: "1rem" }}>
        Pipeline error: {pipelineError}
      </div>
    );
  }

  return (
    <div style={{ ...styles.root, width, height: "auto" }}>
      <VRButton
        supported={capabilities.immersiveVR}
        sessionState={sessionState}
        error={xrError}
        onEnter={enterVR}
        onExit={exitVR}
      />

      {plan && (
        <div style={styles.diag}>
          <span>{plan.diagnostics.totalPlaced} primitives</span>
          {plan.diagnostics.paginatedPanelCount > 0 && (
            <span> · {plan.diagnostics.paginatedPanelCount} paginated</span>
          )}
          {plan.diagnostics.unplacedIds.length > 0 && (
            <span style={{ color: "#f6a623" }}>
              {" "}
              · {plan.diagnostics.unplacedIds.length} unplaced
            </span>
          )}
          <span style={{ marginLeft: "auto", opacity: 0.5 }}>
            {plan.template} layout
          </span>
        </div>
      )}

      <div style={{ width, height }}>
        <Canvas
          style={{ background }}
          camera={{ position: [0, 1.5, 0], fov: 60, near: 0.01, far: 100 }}
          gl={{
            antialias: true,
            alpha: false,
            ...(session ? { xr: { enabled: true } } : {}),
          }}
          onCreated={({ gl }) => {
            // Required for THREE.Plane clipping planes on child materials
            gl.localClippingEnabled = true;
            if (session) {
              gl.xr.enabled = true;
              gl.xr.setSession(session as unknown as any);
            }
          }}
        >
          <Suspense fallback={null}>
            <ambientLight intensity={0.4} />
            <directionalLight
              position={[0, 3, 2]}
              intensity={0.8}
              castShadow={false}
            />
            <pointLight
              position={[0, 1.5, -1.2]}
              intensity={0.6}
              color="#58a6ff"
              distance={4}
            />
            <Environment preset="city" />

            {scene && plan && (
              <XRSceneGraph
                scene={scene}
                plan={plan}
                pageState={pageState}
                setPage={setPage}
              />
            )}

            {sessionState !== "immersive" && (
              <>
                <OrbitControls
                  target={[0, 1.4, -1.2]}
                  enablePan
                  enableDamping
                  dampingFactor={0.08}
                />
                <GizmoHelper alignment="bottom-right" margin={[80, 80]}>
                  <GizmoViewport
                    axisColors={["#ff4444", "#44ff44", "#4488ff"]}
                    labelColor="white"
                  />
                </GizmoHelper>
                <gridHelper
                  args={[10, 40, "#1e2d3d", "#111927"]}
                  position={[0, 0, 0]}
                />
                <mesh position={[0, 1.5, 0]} rotation={[Math.PI / 2, 0, 0]}>
                  <planeGeometry args={[0.05, 0.05]} />
                  <meshBasicMaterial
                    color="#58a6ff"
                    transparent
                    opacity={0.6}
                  />
                </mesh>
              </>
            )}
          </Suspense>
        </Canvas>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Styles
// ─────────────────────────────────────────────────────────────

const styles: Record<string, React.CSSProperties> = {
  root: {
    display: "flex",
    flexDirection: "column",
    fontFamily: "'IBM Plex Mono', 'Fira Code', monospace",
    background: "#fff",
    borderRadius: "8px",
    overflow: "hidden",
    border: "1px solid #1e2d3d",
    marginTop: "4rem",
  },
  vrButtonRow: {
    display: "flex",
    alignItems: "center",
    gap: "0.75rem",
    padding: "0.6rem 1rem",
    background: "#0a0e17",
    borderBottom: "1px solid #1e2d3d",
  },
  vrBtn: {
    display: "flex",
    alignItems: "center",
    gap: "0.4rem",
    padding: "0.4rem 1.1rem",
    background: "linear-gradient(135deg, #1a2840 0%, #0f1e33 100%)",
    border: "1px solid #58a6ff",
    borderRadius: "6px",
    color: "#58a6ff",
    fontSize: "0.82rem",
    fontWeight: 600,
    cursor: "pointer",
    fontFamily: "inherit",
    letterSpacing: "0.04em",
    transition: "background 0.15s, box-shadow 0.15s",
  },
  vrBtnExit: {
    borderColor: "#ff6b6b",
    color: "#ff6b6b",
    background: "linear-gradient(135deg, #2a1010 0%, #1a0a0a 100%)",
  },
  vrBtnIcon: { fontSize: "1rem", lineHeight: 1 },
  unsupported: { fontSize: "0.75rem", color: "#4a5568", fontStyle: "italic" },
  error: { fontSize: "0.75rem", color: "#ff6b6b" },
  diag: {
    display: "flex",
    alignItems: "center",
    gap: "0",
    padding: "0.3rem 1rem",
    background: "#080c14",
    borderBottom: "1px solid #111927",
    fontSize: "0.72rem",
    color: "#4a5568",
    fontFamily: "inherit",
    letterSpacing: "0.02em",
  },
};
