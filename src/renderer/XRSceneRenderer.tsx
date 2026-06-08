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
 * NO manual parentPosition subtraction is needed or correct — the engine
 * already expresses child positions as local offsets.
 *
 * renderChild passes NO parentPosition. Children rendered through
 * renderChild (inside mesh components) are rendered relative to the mesh's
 * own group, which is already at origin thanks to zeroedEntry — so their
 * local entry.position is used directly and resolves correctly.
 */

import React, { useState, useCallback, Suspense, useEffect } from "react";
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
} from "./primitives";

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

  // renderChild: dispatches a child primitive. Because it is called from
  // INSIDE a container's <group>, the child's entry.position (local space)
  // resolves correctly via Three.js group composition — no extra arithmetic.
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
    // Non-paginated: group at entry.position, XRSectionMesh at origin,
    // children dispatched inside via renderChild (inherits group transform).
    //
    // Paginated (root section-0 acting as content panel): show only current
    // page's children with pagination controls.

    case "XRSection": {
      // if (entry.pagination && entry.pagination.pageCount > 1) {
      //   const paginatedChildren = getPaginatedChildren(
      //     primitive,
      //     entry,
      //     pageState,
      //   );
      //   const currentPage = pageState[primitive.id] ?? 0;
      //   return (
      //     <group key={primitive.id} position={[ex, ey, ez]} rotation={rot}>
      //       <PanelBacking entry={zeroedEntry(entry)} opacity={0.35} />
      //       {paginatedChildren.map((child) => (
      //         <PrimitiveDispatcher
      //           key={child.id}
      //           primitive={child}
      //           plan={plan}
      //           pageState={pageState}
      //           setPage={setPage}
      //           primitiveMap={primitiveMap}
      //         />
      //       ))}
      //       <PaginationControls
      //         primitiveId={primitive.id}
      //         pagination={entry.pagination}
      //         currentPage={currentPage}
      //         entry={zeroedEntry(entry)}
      //         onPageChange={(p) => setPage(primitive.id, p)}
      //       />
      //     </group>
      //   );
      // }

      return (
        <group key={primitive.id} position={[ex, ey, ez]} rotation={rot}>
          <XRSectionMesh
            primitive={primitive as XRSection}
            entry={zeroedEntry(entry)}
            childEntries={
              primitive.children
                .map((c) => plan.entries[c.id])
                .filter(Boolean) as LayoutEntry[]
            }
            renderChild={renderChild}
            visibleChildIds={undefined}
            pagination={undefined}
          />
        </group>
      );
    }

    // ── XRContentPanel ────────────────────────────────────────────────────
    // Top-level main panel. Paginates its direct section children.
    // Children dispatched inside the group — local positions resolve correctly.

    case "XRContentPanel": {
      const paginatedChildren = getPaginatedChildren(
        primitive,
        entry,
        pageState,
      );
      const currentPage = pageState[primitive.id] ?? 0;
      console.log("ContentPanel pagination", entry.pagination);
      console.log("currentPage", currentPage);
      console.log("children", primitive.children.length);
      return (
        <group key={primitive.id} position={[ex, ey, ez]} rotation={rot}>
          <PanelBacking entry={zeroedEntry(entry)} opacity={0.35} />
          {paginatedChildren.map((child) => (
            <PrimitiveDispatcher
              key={child.id}
              primitive={child}
              plan={plan}
              pageState={pageState}
              setPage={setPage}
              primitiveMap={primitiveMap}
            />
          ))}
          {entry.pagination && entry.pagination.pageCount > 1 && (
            <PaginationControls
              primitiveId={primitive.id}
              pagination={entry.pagination}
              currentPage={currentPage}
              entry={zeroedEntry(entry)}
              onPageChange={(p) => setPage(primitive.id, p)}
            />
          )}
        </group>
      );
    }

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
          <Text
            anchorX="left"
            anchorY="top"
            position={[0.008, -0.008, 0.004]}
            fontSize={0.018}
            color="#7aa2cc"
            maxWidth={w - 0.016}
          >
            {primitive.label ?? primitive.type}
          </Text>
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
  pagination: { pageCount: number; pages: string[][] };
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

function buildPrimitiveMap(
  root: XRPrimitive,
  out: Map<string, XRPrimitive> = new Map(),
): Map<string, XRPrimitive> {
  out.set(root.id, root);
  for (const child of root.children) buildPrimitiveMap(child, out);
  return out;
}

function getPaginatedChildren(
  primitive: XRPrimitive,
  entry: LayoutEntry,
  pageState: PageState,
): XRPrimitive[] {
  if (!entry.pagination) return primitive.children;
  const currentPage = pageState[primitive.id] ?? 0;
  const pageIds = entry.pagination.pages[currentPage] ?? [];
  const idSet = new Set(pageIds);
  return primitive.children.filter((c) => idSet.has(c.id));
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
