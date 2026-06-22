/**
 * XRSceneRenderer.tsx
 *
 * Positioning contract
 * ────────────────────
 * The layout engine outputs entry.position in two coordinate spaces:
 *
 * Top-level landmark panels  → world space (e.g. x=0, y=1.4, z=-1.2)
 * All children               → LOCAL space relative to their parent panel's
 * top-left origin (e.g. x=0.04, y=-0.04, z=0)
 *
 * Because Three.js group transforms compose automatically, the correct
 * rendering strategy is simply:
 *
 * 1. Every primitive gets a <group position={entry.position}> wrapper.
 * 2. Every mesh component receives zeroedEntry() so its internal
 * entryTransform() group is at [0,0,0] — not double-applying position.
 * 3. Children are dispatched INSIDE the parent's <group>, inheriting
 * the parent's world transform. Their local-space entry.position
 * then resolves correctly via Three.js group composition.
 *
 * Pagination contract
 * ───────────────────
 * The layout engine stamps entry.pageIndex on every primitive that lives
 * under a paginating XRContentPanel. The renderer gates on this value:
 *
 * • XRContentPanel sets CurrentPageContext to the user's current page.
 * • Every PrimitiveDispatcher reads CurrentPageContext and returns null
 * if entry.pageIndex is defined and !== currentPage.
 * • No ID lists, no slice maps, no position re-basing needed — the
 * engine assigns correct page-relative positions to every primitive.
 *
 * Clipping
 * ────────
 * XRContentPanel builds world-space THREE.Plane clip planes and provides
 * them via ClipPlanesContext so descendant materials can clip geometry
 * that would bleed outside the panel viewport.
 */

const DEFAULT_ROBOTO_FONT =
  "https://fonts.gstatic.com/s/roboto/v18/KFOmCnqEu92Fr1Mu4mxKKTU1Kg.woff";

const EMPTY_CONFIG: Partial<LayoutConfig> = {};

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
import { computeLayoutPlan } from "../layout/engine";

import { useXRSession } from "./useXRSession";
import {
  XRHeadingMesh,
  XRParagraphMesh,
  XRSectionMesh,
  XRNavigationMesh,
  XRMediaMesh,
  XRCodeBlockMesh,
  XRTextMesh,
  XRLinkMesh,
  XRBlockQuoteMesh,
  XRSeparatorMesh,
  XRProgressBarMesh,
  XRImageMesh,
  XRListItemMesh,
  XRButtonMesh,
  XRAlertMesh,
  XRTableMesh,
  XRFormFieldMesh,
  XRTabGroupMesh,
  ClipPlanesContext,
  ClippedText,
  RenderMetricsContext,
} from "./primitives";
import * as THREE from "three";
import type {
  SemanticScene,
  XRPrimitive,
  XRHeading,
  XRParagraph,
  XRNavigationBar,
  XRMediaPlayer,
  XRCodeBlock,
  XRBlockQuote,
  XRSeparator,
  XRProgressBar,
  XRImage,
  XRButton,
  XRAlert,
  XRFormField,
  XRSection,
  XRListItem,
  XRTable,
  XRTabGroup,
} from "../mapper/types";
import type {
  LayoutPlan,
  LayoutEntry,
  DeviceProfile,
  LayoutConfig,
} from "../layout/types";
import {
  QUEST_PRO_PROFILE,
  RAY_BAN_META_PROFILE,
  QUEST_3_PROFILE,
} from "../layout/profiles";

// ─────────────────────────────────────────────────────────────
// Contexts
// ─────────────────────────────────────────────────────────────

export const CurrentPageContext = React.createContext<number>(-1);
export const FontContext = React.createContext<string | undefined>(undefined);

// ─────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────

export type XRDeviceType = "QUEST_3" | "QUEST_PRO" | "RAY_BAN_META";

export interface XRSceneRendererProps {
  html?: string;
  url?: string;
  scene?: SemanticScene;
  layoutConfig?: Partial<LayoutConfig>;
  width?: string | number;
  height?: string | number;
  background?: string;
  deviceType?: XRDeviceType;
  fontType?: string;
  onPlanReady?: (plan: LayoutPlan) => void;
}

type PageState = Record<string, number>;

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
  sceneIn: SemanticScene | undefined,
  url: string | undefined,
  deviceProfile: DeviceProfile,
  layoutConfig: Partial<LayoutConfig>,
) {
  const [result, setResult] = useState({
    scene: null as SemanticScene | null,
    plan: null as LayoutPlan | null,
    error: null as string | null,
  });

  const configHash = JSON.stringify(layoutConfig);
  const stableConfig = useMemo(() => layoutConfig, [configHash]);

  useEffect(() => {
    let cancelled = false;

    async function run() {
      try {
        let scene: SemanticScene;
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

        const plan = computeLayoutPlan(
          scene,
          deviceProfile,
          undefined,
          stableConfig, // <-- Use the stableConfig here
        );

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
  }, [html, sceneIn, url, deviceProfile, stableConfig]); // <-- Depend on stableConfig

  return result;
}

// ─────────────────────────────────────────────────────────────
// Primitive dispatcher
// ─────────────────────────────────────────────────────────────

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
          {/* ✅ Just render children normally - they'll filter themselves via pageIndex */}
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

function PrimitiveDispatcher({
  primitive,
  plan,
  pageState,
  setPage,
  primitiveMap,
}: DispatcherProps) {
  const entry = plan.entries[primitive.id];
  const currentPage = React.useContext(CurrentPageContext);
  const fontType = React.useContext(FontContext);

  if (!entry) return null;

  // ✅ Define hasVisibleDescendant FIRST before using it
  const hasVisibleDescendant = (node: XRPrimitive): boolean => {
    // FIRST: Check all children recursively (any depth)
    for (const child of node.children) {
      if (hasVisibleDescendant(child)) return true;
    }

    // SECOND: If no children are visible, check if this node itself is visible
    const nodeEntry = plan.entries[node.id];
    if (nodeEntry?.pageIndex !== undefined && currentPage !== -1) {
      return nodeEntry.pageIndex === currentPage;
    }

    // Node has no pageIndex (not in paginated panel) and no visible children
    return false;
  };

  // ✅ If entry has NO pageIndex, it's not in a paginated panel
  // Render it (it's a top-level landmark or the content panel itself)
  if (entry.pageIndex === undefined) {
    // We still need to render children, but they'll filter themselves
    // Fall through to the switch statement
  } else {
    // ✅ Entry HAS a pageIndex - it's in a paginated panel
    const isContainer = primitive.children.length > 0;

    if (isContainer) {
      // For containers: check if they have visible descendants
      const hasVisible = hasVisibleDescendant(primitive);
      if (!hasVisible) {
        return null;
      }
    } else {
      // For leaf nodes: filter by page
      if (entry.pageIndex !== currentPage && currentPage !== -1) {
        return null;
      }
    }
  }
  // // In PrimitiveDispatcher, after getting entry:
  // console.log(
  //   `[POS] ${primitive.id} (${primitive.type}) position:`,
  //   entry.position,
  // );

  // ✅ If we get here, render this node
  // console.log(primitive.type, primitive, "on page", entry.pageIndex ?? "N/A");

  const renderChild = useCallback(
    (childId: string) => {
      const childPrim = primitiveMap.get(childId);
      if (!childPrim || !plan.entries[childId]) {
        console.warn(`[RENDER] Child ${childId} not found in map or entries`);
        return null;
      }
      // console.log(
      //   `[RENDER] Rendering child ${childId} from parent ${primitive.id}`,
      // );
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

  const ex = entry.position.x;
  const ey = entry.position.y;
  const ez = entry.position.z;
  const rot: [number, number, number] = [
    entry.rotation.x,
    entry.rotation.y,
    entry.rotation.z,
  ];

  switch (primitive.type) {
    case "XRHeading":
      return (
        <group key={primitive.id} position={[ex, ey, ez]} rotation={rot}>
          <XRHeadingMesh
            primitive={primitive as XRHeading}
            entry={zeroedEntry(entry)}
            renderChild={renderChild}
          />
        </group>
      );
    case "XRParagraph":
      return (
        <group key={primitive.id} position={[ex, ey, ez]} rotation={rot}>
          <XRParagraphMesh
            primitive={primitive as XRParagraph}
            entry={zeroedEntry(entry)}
            renderChild={renderChild}
            getChildEntry={(childId: string) => plan.entries[childId] ?? null}
          />
        </group>
      );
    case "XRText":
      return (
        <group key={primitive.id} position={[ex, ey, ez]} rotation={rot}>
          <XRTextMesh
            primitive={primitive as import("../mapper/types").XRText}
            entry={zeroedEntry(entry)}
          />
        </group>
      );

    case "XRLink":
      return (
        <group key={primitive.id} position={[ex, ey, ez]} rotation={rot}>
          <XRLinkMesh
            primitive={primitive as import("../mapper/types").XRLink}
            entry={zeroedEntry(entry)}
            renderChild={renderChild}
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

    case "XRSection": {
      return (
        <group key={primitive.id} position={[0, 0, 0]} rotation={rot}>
          <XRSectionMesh
            primitive={primitive as XRSection}
            entry={zeroedEntry(entry)}
            childEntries={[]}
            renderChild={renderChild}
            isContinuation={false}
            hasMore={false}
          />
        </group>
      );
    }

    case "XRContentPanel":
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

    case "XRArticle":
    case "XRFormPanel":
    case "XRBanner":
    case "XRFooter":
    case "XRComplementary": {
      // XRArticle and XRFormPanel are spanning wrappers — their children carry
      // panel-local positions, so this group must be at [0,0,0].
      // XRBanner/XRFooter/XRComplementary are top-level landmarks placed in
      // world space by the engine, so they use their own entry position.
      const isLandmark =
        primitive.type === "XRBanner" ||
        primitive.type === "XRFooter" ||
        primitive.type === "XRComplementary";
      const wrapperPos: [number, number, number] = isLandmark
        ? [ex, ey, ez]
        : [0, 0, 0];
      const wrapperRot: [number, number, number] = isLandmark ? rot : [0, 0, 0];
      if (isLandmark) {
        return null;
      }
      return (
        <group key={primitive.id} position={wrapperPos} rotation={wrapperRot}>
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

    case "XRListItem": {
      return (
        <group key={primitive.id} position={[ex, ey, ez]} rotation={rot}>
          <XRListItemMesh
            primitive={primitive as XRListItem}
            entry={zeroedEntry(entry)}
            renderChild={renderChild}
          />
        </group>
      );
    }

    case "XRList":
    case "XRTableRow":
    case "XRTableCell": {
      // XRList children have list-local positions from stackChildrenSimple.
      // The list group is at [ex,ey,ez]; each XRListItem is offset from the
      // list's own origin. Three.js group composition resolves this correctly.
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
            font={fontType}
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

    default: {
      // XRGenericPanel and any other unrecognised wrapper.
      //
      // FIX: this must render at the primitive's own layout-plan position
      // ([ex,ey,ez]), not unconditionally at [0,0,0]. A generic panel that
      // sits at the TOP of its parent's stack (y≈0) happened to look correct
      // either way, which is why this went unnoticed — but a generic panel
      // placed further down the stack (e.g. a <span> wrapper appearing
      // mid-paragraph, like the "saingeom" run in a list item) has a real,
      // nonzero position from stackChildrenSimple. Rendering it at [0,0,0]
      // discards that offset and collapses it back onto the top of its
      // parent, visually overlapping whatever else is already there.
      //
      // Three.js group composition handles this exactly like every other
      // non-landmark case above (XRHeading, XRParagraph, etc.) — the child's
      // own children continue to use THEIR layout-plan positions, which are
      // already relative to this panel's origin, so nothing needs to change
      // on the renderChild side.
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

function GenericPanelMesh({
  primitive,
  entry,
}: {
  primitive: XRPrimitive;
  entry: LayoutEntry;
}) {
  const w = Math.max(entry.size.width, 0.025);
  const h = Math.max(entry.size.height, 0.032);
  const fontType = React.useContext(FontContext);
  return (
    <>
      <mesh position={[w / 2, -h / 2, -0.003]}>
        <planeGeometry args={[w, h]} />
        <meshStandardMaterial color="#0d1117" transparent opacity={0.28} />
      </mesh>
      <Text
        font={fontType}
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
  const fontType = React.useContext(FontContext);

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
          font={fontType}
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
        font={fontType}
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
          font={fontType}
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

function buildPanelClipPlanes(
  worldY: number,
  panelHeight: number,
): THREE.Plane[] {
  const topPlane = new THREE.Plane(new THREE.Vector3(0, -1, 0), worldY);
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
  scene: SemanticScene;
  plan: LayoutPlan;
  pageState: PageState;
  setPage: (id: string, page: number) => void;
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

  React.useEffect(() => {
    const withPage = Object.values(plan.entries).filter(
      (e) => e.pageIndex !== undefined,
    );
    const withoutPage = Object.values(plan.entries).filter(
      (e) => e.pageIndex === undefined,
    );

    // console.log(`[SCENE] Total entries: ${Object.keys(plan.entries).length}`);
    // console.log(
    //   `[SCENE] With page index: ${withPage.length}`,
    //   withPage.map((e) => `${e.id} (page ${e.pageIndex})`),
    // );
    // console.log(
    //   `[SCENE] Without page index: ${withoutPage.length}`,
    //   withoutPage.map((e) => e.id),
    // );

    // Check which primitives in the scene have no entry
    const allPrimitiveIds = new Set<string>();
    const collectIds = (node: XRPrimitive) => {
      allPrimitiveIds.add(node.id);
      node.children.forEach(collectIds);
    };
    collectIds(scene.root);

    const missingEntries = Array.from(allPrimitiveIds).filter(
      (id) => !plan.entries[id],
    );
    if (missingEntries.length > 0) {
      console.warn(`[SCENE] Primitives missing from plan:`, missingEntries);
    }
  }, [plan, scene]);

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
  layoutConfig = EMPTY_CONFIG,
  width = "100%",
  height = "600px",
  background = "#050a10",
  deviceType = "QUEST_3",
  fontType = undefined,
  onPlanReady,
}: XRSceneRendererProps) {
  // 1. Resolve Device Profile locally
  const deviceProfile = useMemo(() => {
    switch (deviceType) {
      case "QUEST_PRO":
        return QUEST_PRO_PROFILE;
      case "RAY_BAN_META":
        return RAY_BAN_META_PROFILE;
      case "QUEST_3":
      default:
        return QUEST_3_PROFILE;
    }
  }, [deviceType]);

  const {
    scene,
    plan,
    error: pipelineError,
  } = usePipeline(html, sceneIn, url, deviceProfile, {
    ...layoutConfig,
    // sectionStartsOnNewPage: false,
  });

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

            {/* Provide the same RenderMetrics the layout engine used, so
                renderer components (XRHeadingMesh, XRTextMesh, etc.) can
                never drift from estimateHeight()'s assumptions. */}
            <RenderMetricsContext.Provider value={deviceProfile.renderMetrics}>
              {/* Provide the Font Context to the entire rendered tree */}
              <FontContext.Provider value={fontType}>
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
              </FontContext.Provider>
            </RenderMetricsContext.Provider>
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
