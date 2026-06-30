/**
 * XRSceneRenderer.tsx
 *
 * Positioning contract
 * ────────────────────
 * The layout engine outputs entry.position in ONE coordinate system for
 * every primitive, at every depth:
 *
 *   • Top-level landmarks   → world space  (e.g. x=0, y=1.4, z=-1.2)
 *   • Inside XRContentPanel → panel-absolute space relative to the panel's
 *                             top-left origin (e.g. x=0.04, y=-0.04, z=0)
 *
 * paginateContentPanel's stampDescendants pass ensures that EVERY descendant
 * inside a paginated panel — regardless of nesting depth — has its
 * panel-absolute position written into placedPositionMap before layoutPrimitive
 * reads it. There is no parent-relative coordinate system to handle.
 *
 * The renderer contract is therefore simple and uniform:
 *   1. Every primitive gets <group position={[ex, ey, ez]}> for its OWN visual.
 *   2. Every mesh receives zeroedEntry() so it doesn't double-apply position.
 *   3. Children are dispatched as SIBLINGS of their parent's group (NOT nested
 *      inside it), because their positions are already panel-absolute.
 *      Exception: primitives that use renderChild() (XRSectionMesh,
 *      XRListItemMesh, XRParagraphMesh) handle child positioning internally.
 *
 * Pagination contract
 * ───────────────────
 * The layout engine stamps entry.pageIndex on every primitive that lives
 * under a paginating XRContentPanel. The renderer gates on this value:
 *
 * • XRContentPanel sets CurrentPageContext to the user's current page.
 * • Every PrimitiveDispatcher reads CurrentPageContext and returns null
 *   if entry.pageIndex is defined and !== currentPage.
 * • No ID lists, no slice maps, no position re-basing needed.
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
import { Canvas, useThree, useFrame } from "@react-three/fiber";
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
import { DEFAULT_CONFIG } from "../ir/defaults";
import type { ParserConfig } from "../ir/types";

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
import {
  flattenInlineWrappers,
  isInlinePrimitive,
  angularRotation,
} from "../layout/utils";
import {
  CAROUSEL_GHOST_PREV_ANGLE_DEG,
  CAROUSEL_GHOST_NEXT_ANGLE_DEG,
  CAROUSEL_GHOST_GAP,
  CAROUSEL_Z_STEP,
} from "../layout/slots";
import type { ViewMode } from "../components/viewTypes";

// ─────────────────────────────────────────────────────────────
// Contexts
// ─────────────────────────────────────────────────────────────

export const CurrentPageContext = React.createContext<number>(-1);
export const FontContext = React.createContext<string | undefined>(undefined);

/**
 * Active page range [startPage, endPage] (both inclusive, absolute panel page
 * indices) for the currently focused section in cards reading view.
 * null = no restriction (show all pages / full document pagination).
 */
const PageRangeContext = React.createContext<[number, number] | null>(null);

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
  parserConfig?: Partial<ParserConfig>;
  viewMode?: ViewMode;
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
// Renderer helpers
// ─────────────────────────────────────────────────────────────

/**
 * Wraps a mesh in a positioned group using the entry's panel-absolute
 * coordinates. Every leaf primitive uses this — the mesh itself receives
 * zeroedEntry() so it never double-applies the translation.
 */
function AtPos({
  entry,
  children,
}: {
  entry: LayoutEntry;
  children: React.ReactNode;
}) {
  const { x, y, z } = entry.position;
  const rot: [number, number, number] = [
    entry.rotation.x,
    entry.rotation.y,
    entry.rotation.z,
  ];
  return (
    <group position={[x, y, z]} rotation={rot}>
      {children}
    </group>
  );
}

function hasDescendant(node: XRPrimitive, targetId: string): boolean {
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
function isExtractedComplementary(p: XRPrimitive, plan: LayoutPlan): boolean {
  return (
    p.type === "XRComplementary" &&
    plan.entries[p.id]?.pageIndex !== undefined
  );
}

/**
 * Walk the primitive subtree and collect every XRComplementary that has been
 * extracted to a world-space slot (identified by having a pageIndex).
 * Does NOT recurse into XRComplementary itself.
 */
function collectExtractedComplementaries(
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

function DispatchChildren({
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
  return (
    <>
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
    </>
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
function WithSiblingChildren({
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

function usePipeline(
  html: string | undefined,
  sceneIn: SemanticScene | undefined,
  url: string | undefined,
  deviceProfile: DeviceProfile,
  layoutConfig: Partial<LayoutConfig>,
  parserConfig: Partial<ParserConfig>,
  templateOverride: import("../layout/types").LayoutTemplate | undefined,
) {
  const [result, setResult] = useState({
    scene: null as SemanticScene | null,
    plan: null as LayoutPlan | null,
    error: null as string | null,
  });

  const configHash = JSON.stringify(layoutConfig);
  const stableConfig = useMemo(() => layoutConfig, [configHash]);
  const parserConfigHash = JSON.stringify(parserConfig);
  const stableParserConfig = useMemo(() => parserConfig, [parserConfigHash]);

  useEffect(() => {
    let cancelled = false;

    async function run() {
      try {
        let scene: SemanticScene;
        if (sceneIn) {
          scene = sceneIn;
        } else if (html) {
          const resolvedParserConfig = { ...DEFAULT_CONFIG, ...stableParserConfig };
          const ir = await parsePageToIR(html, url!, undefined, resolvedParserConfig);
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
          templateOverride,
          stableConfig,
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
  }, [html, sceneIn, url, deviceProfile, stableConfig, stableParserConfig, templateOverride]);

  return result;
}

// ─────────────────────────────────────────────────────────────
// Primitive dispatcher
// ─────────────────────────────────────────────────────────────

/**
 * Renders any primitive that was paginated by the engine (entry.paginatedByEngine).
 *
 * Handles XRContentPanel (the original paginating type) and any other container
 * type that paginateContentPanel was called on — XRSection, XRArticle,
 * XRFormPanel, XRGenericPanel. All of these receive panel-absolute child
 * positions from the engine, so children must render INSIDE the container's
 * positioned group rather than as world-space siblings.
 */
function PaginatingPanelRenderer({
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

  // XRComplementary nodes extracted to the world-space slot by the engine.
  // Only ever present inside XRContentPanel; other container types never have
  // them. They render OUTSIDE the panel group so their world-space slot
  // positions apply directly, but inside CurrentPageContext so gating works.
  const extractedComps = useMemo(
    () =>
      primitive.type === "XRContentPanel"
        ? collectExtractedComplementaries(primitive, plan)
        : [],
    [primitive, plan],
  );

  // XRContentPanel uses a more opaque backing (it IS the main content surface).
  // All other containers use a lighter backing so nesting levels remain legible.
  const backingOpacity = primitive.type === "XRContentPanel" ? 0.35 : 0.2;

  // Apply the section page range only for the top-level content panel — not
  // for nested sections/articles which have their own per-child pagination.
  const pageRange = React.useContext(PageRangeContext);
  const effectiveRange =
    primitive.type === "XRContentPanel" ? pageRange : null;

  return (
    <CurrentPageContext.Provider value={currentPage}>
      {extractedComps.map((comp) => (
        <PrimitiveDispatcher
          key={comp.id}
          primitive={comp}
          plan={plan}
          pageState={pageState}
          setPage={setPage}
          primitiveMap={primitiveMap}
        />
      ))}
      <group key={primitive.id} position={[ex, ey, ez]} rotation={rot}>
        <PanelBacking entry={zeroedEntry(entry)} opacity={backingOpacity} />
        <ClipPlanesContext.Provider value={panelClipPlanes}>
          {primitive.children
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
        </ClipPlanesContext.Provider>
        {pagination && pagination.pageCount > 1 && (
          <PaginationControls
            primitiveId={primitive.id}
            pagination={pagination}
            currentPage={currentPage}
            entry={zeroedEntry(entry)}
            onPageChange={(p) => setPage(primitive.id, p)}
            pageRange={effectiveRange}
          />
        )}
      </group>
    </CurrentPageContext.Provider>
  );
}

// ─────────────────────────────────────────────────────────────
// Carousel ghost panel
// ─────────────────────────────────────────────────────────────

/**
 * Renders one "ghost" copy of a paginated panel at an overridden world position.
 * Used by carousel mode to show the prev/next page panels beside the current one.
 * Non-interactive: no pagination controls, raycast disabled.
 */
function CarouselGhostPanel({
  primitive,
  plan,
  entry,
  targetPage,
  primitiveMap,
  opacity,
}: {
  primitive: XRPrimitive;
  plan: LayoutPlan;
  entry: LayoutEntry;
  targetPage: number;
  primitiveMap: Map<string, XRPrimitive>;
  opacity: number;
}) {
  const ex = entry.position.x;
  const ey = entry.position.y;
  const ez = entry.position.z;
  const rot: [number, number, number] = [entry.rotation.x, entry.rotation.y, entry.rotation.z];

  const panelClipPlanes = React.useMemo(
    () => buildPanelClipPlanes(ey, entry.size.height),
    [ey, entry.size.height],
  );

  // Ghost pageState: only this panel's page is overridden
  const ghostPageState = React.useMemo(
    () => ({ [primitive.id]: targetPage }),
    [primitive.id, targetPage],
  );

  const ghostExtractedComps = React.useMemo(
    () =>
      primitive.type === "XRContentPanel"
        ? collectExtractedComplementaries(primitive, plan)
        : [],
    [primitive, plan],
  );

  return (
    <CurrentPageContext.Provider value={targetPage}>
      {ghostExtractedComps.map((comp) => {
        const compEntry = plan.entries[comp.id];
        if (!compEntry) return null;
        return (
          <group key={comp.id} position={[compEntry.position.x, compEntry.position.y, compEntry.position.z]} rotation={[0, 0, 0]}>
            {/* extracted comps dimmed alongside parent */}
          </group>
        );
      })}
      <group position={[ex, ey, ez]} rotation={rot} raycast={() => null}>
        <PanelBacking entry={zeroedEntry(entry)} opacity={opacity * 0.35} />
        <ClipPlanesContext.Provider value={panelClipPlanes}>
          {primitive.children
            .filter((child) => !isExtractedComplementary(child, plan))
            .map((child) => (
              <PrimitiveDispatcher
                key={child.id}
                primitive={child}
                plan={plan}
                pageState={ghostPageState}
                setPage={_noop}
                primitiveMap={primitiveMap}
              />
            ))}
        </ClipPlanesContext.Provider>
      </group>
    </CurrentPageContext.Provider>
  );
}

const _noop = () => {};

// ─────────────────────────────────────────────────────────────
// Cards zoom system
// ─────────────────────────────────────────────────────────────

type CardsZoomLevel = 0 | 1;

interface SectionCardInfo {
  id: string;
  label: string;
  pageIndex: number; // absolute start page in the content panel
  endPage: number;   // absolute end page (inclusive); equals startPage when unknown
  hasSubSections: boolean;
}

const CARDS_LOOK_TARGET: [number, number, number] = [0, 1.4, -1.2];

function getSectionCards(
  scene: SemanticScene,
  plan: LayoutPlan,
  parentId: string | null,
): SectionCardInfo[] {
  // Sub-sections: always enumerate from the parent section's children directly
  if (parentId) {
    const parent = scene.primitives[parentId];
    if (!parent) return [];
    const children = parent.children.filter(
      (c) => c.type === "XRSection" || c.type === "XRArticle",
    );
    const endPages = computeEndPages(children, plan, Infinity);
    return children.map((child, i) => {
      const heading = child.children.find((c) => c.type === "XRHeading");
      const label = heading?.label ?? child.label ?? "";
      const pageIndex = plan.entries[child.id]?.pageIndex ?? 0;
      const hasSubSections = child.children.some(
        (c) => c.type === "XRSection" || c.type === "XRArticle",
      );
      return { id: child.id, label, pageIndex, endPage: endPages[i], hasSubSections };
    });
  }

  // Top-level: prefer TOC nodes for labels so cards match the page's own navigation
  const mainPanel = scene.root.children.find(
    (p) => p.type === "XRContentPanel",
  );
  if (!mainPanel) return [];

  const totalPages =
    (plan.entries[mainPanel.id]?.pagination?.pageCount ?? 1) - 1; // max page index

  const sections = mainPanel.children.filter(
    (c) => c.type === "XRSection" || c.type === "XRArticle",
  );

  // Build a sorted end-page map for all sections by document order
  const sectionEndPageMap = buildSectionEndPageMap(sections, plan, totalPages);

  // Build label → section primitive so we can look up pageIndex and sub-sections
  const sectionByLabel = new Map<string, XRPrimitive>();
  for (const sec of sections) {
    const heading = sec.children.find((c) => c.type === "XRHeading");
    const key = (heading?.label ?? sec.label ?? "").toLowerCase().trim();
    if (key) sectionByLabel.set(key, sec);
  }

  const tocNav = scene.root.children.find((p) => p.type === "XRNavigationBar");
  if (tocNav && tocNav.children.length > 0) {
    const result: SectionCardInfo[] = [];
    for (const link of tocNav.children) {
      const label = link.label ?? "";
      if (!label) continue;
      const matched = sectionByLabel.get(label.toLowerCase().trim());
      const id = matched?.id ?? link.id;
      const pageIndex = matched ? (plan.entries[matched.id]?.pageIndex ?? 0) : 0;
      const endPage = matched
        ? (sectionEndPageMap.get(matched.id) ?? totalPages)
        : totalPages;
      const hasSubSections = matched
        ? matched.children.some(
            (c) => c.type === "XRSection" || c.type === "XRArticle",
          )
        : false;
      result.push({ id, label, pageIndex, endPage, hasSubSections });
    }
    if (result.length > 0) return result;
  }

  // Fallback: enumerate sections directly
  const endPages = computeEndPages(sections, plan, totalPages);
  return sections.map((child, i) => {
    const heading = child.children.find((c) => c.type === "XRHeading");
    const label = heading?.label ?? child.label ?? "";
    const pageIndex = plan.entries[child.id]?.pageIndex ?? 0;
    const hasSubSections = child.children.some(
      (c) => c.type === "XRSection" || c.type === "XRArticle",
    );
    return { id: child.id, label, pageIndex, endPage: endPages[i], hasSubSections };
  });
}

/**
 * Given a list of sibling sections (in document order), compute the end page
 * for each using next-section-boundary: endPage[i] = startPage[i+1] - 1.
 * The last section extends to `maxPage`.
 */
function buildSectionEndPageMap(
  sections: XRPrimitive[],
  plan: LayoutPlan,
  maxPage: number,
): Map<string, number> {
  const sorted = sections
    .map((s) => ({ id: s.id, startPage: plan.entries[s.id]?.pageIndex ?? 0 }))
    .sort((a, b) => a.startPage - b.startPage);

  const result = new Map<string, number>();
  for (let i = 0; i < sorted.length; i++) {
    const nextStart = sorted[i + 1]?.startPage;
    // Guard: endPage must be >= startPage even when adjacent sections share a page.
    const endPage =
      nextStart !== undefined
        ? Math.max(sorted[i].startPage, nextStart - 1)
        : maxPage;
    result.set(sorted[i].id, endPage);
  }
  return result;
}

/** Compute end pages for a list of siblings ordered by their position in `children`. */
function computeEndPages(
  sections: XRPrimitive[],
  plan: LayoutPlan,
  maxPage: number,
): number[] {
  const map = buildSectionEndPageMap(sections, plan, maxPage);
  return sections.map((s) => map.get(s.id) ?? maxPage);
}

function CameraRig({
  targetPos,
  targetLook,
}: {
  targetPos: [number, number, number];
  targetLook: [number, number, number];
}) {
  const { camera } = useThree();
  const tp = React.useRef(
    new THREE.Vector3(targetPos[0], targetPos[1], targetPos[2]),
  );
  const tl = React.useRef(
    new THREE.Vector3(targetLook[0], targetLook[1], targetLook[2]),
  );

  React.useEffect(() => {
    tp.current.set(targetPos[0], targetPos[1], targetPos[2]);
    tl.current.set(targetLook[0], targetLook[1], targetLook[2]);
  }, [targetPos[0], targetPos[1], targetPos[2], targetLook[0], targetLook[1], targetLook[2]]); // eslint-disable-line react-hooks/exhaustive-deps

  useFrame(() => {
    camera.position.lerp(tp.current, 0.08);
    camera.lookAt(tl.current);
  });

  return null;
}

/** Instantly snap camera position+orientation once on mount, then yield to OrbitControls. */
function CameraSnapTo({
  position,
  lookAt,
}: {
  position: [number, number, number];
  lookAt: [number, number, number];
}) {
  const { camera } = useThree();
  React.useLayoutEffect(() => {
    camera.position.set(position[0], position[1], position[2]);
    camera.lookAt(lookAt[0], lookAt[1], lookAt[2]);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}

// Reading-view camera constants: camera 1.2 m in front of the panel, looking
// at the panel's vertical centre so content fills the viewport comfortably.
const CARDS_READ_POS: [number, number, number] = [0, 1.5, 0.0];
const CARDS_READ_LOOK: [number, number, number] = [0, 0.95, -1.2];

const CARD_W = 0.40;
const CARD_H = 0.24;
const CARD_GAP_X = 0.06;
const CARD_GAP_Y = 0.05;
const CARD_COLS = 4;
const CARD_Z = -1.2;
const CARD_EYE_Y = 1.5;

function SectionCardTile({
  cx,
  cy,
  label,
  isActive,
  onClick,
}: {
  cx: number;
  cy: number;
  label: string;
  isActive: boolean;
  onClick: () => void;
}) {
  const [hovered, setHovered] = React.useState(false);
  const fontType = React.useContext(FontContext);
  const w = CARD_W;
  const h = CARD_H;

  return (
    <group
      position={[cx, cy, CARD_Z]}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      onPointerOver={(e) => {
        e.stopPropagation();
        setHovered(true);
      }}
      onPointerOut={() => setHovered(false)}
    >
      <RoundedBox args={[w, h, 0.008]} radius={0.012}>
        <meshStandardMaterial
          color={isActive ? "#112840" : hovered ? "#0d1e30" : "#070e18"}
          transparent
          opacity={0.95}
        />
      </RoundedBox>
      {/* top accent bar */}
      <mesh position={[0, h / 2 - 0.002, 0.006]}>
        <planeGeometry args={[w * 0.65, 0.003]} />
        <meshBasicMaterial
          color={isActive ? "#58a6ff" : hovered ? "#2a5a8f" : "#162840"}
        />
      </mesh>
      <Text
        font={fontType}
        position={[0, 0, 0.007]}
        fontSize={0.016}
        color={isActive ? "#90c8ff" : hovered ? "#8ab4d8" : "#5a8ab0"}
        anchorX="center"
        anchorY="middle"
        maxWidth={w - 0.04}
        textAlign="center"
      >
        {label.length > 48 ? label.slice(0, 46) + "…" : label}
      </Text>
    </group>
  );
}

function CardsGridMesh({
  cards,
  focusedId,
  onCardClick,
  headerLabel,
}: {
  cards: SectionCardInfo[];
  focusedId: string | null;
  onCardClick: (id: string, pageIndex: number, hasSubSections: boolean) => void;
  headerLabel?: string;
}) {
  const fontType = React.useContext(FontContext);
  const cols = CARD_COLS;
  const cw = CARD_W;
  const ch = CARD_H;
  const gx = CARD_GAP_X;
  const gy = CARD_GAP_Y;
  const rows = Math.ceil(cards.length / cols);
  const gridW = cols * cw + (cols - 1) * gx;
  const gridH = rows * ch + (rows - 1) * gy;
  const startX = -gridW / 2 + cw / 2;
  const startY = CARD_EYE_Y + gridH / 2 - ch / 2;

  return (
    <>
      {headerLabel && (
        <Text
          font={fontType}
          position={[0, startY + ch / 2 + 0.055, CARD_Z]}
          fontSize={0.014}
          color="#2a4a6a"
          anchorX="center"
          anchorY="bottom"
          letterSpacing={0.08}
        >
          {headerLabel.toUpperCase()}
        </Text>
      )}
      {cards.map(({ id, label, pageIndex, hasSubSections }, i) => {
        const col = i % cols;
        const row = Math.floor(i / cols);
        const cx = startX + col * (cw + gx);
        const cy = startY - row * (ch + gy);
        return (
          <SectionCardTile
            key={id}
            cx={cx}
            cy={cy}
            label={label}
            isActive={focusedId === id}
            onClick={() => onCardClick(id, pageIndex, hasSubSections)}
          />
        );
      })}
    </>
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

  // Any container the engine paginated (XRContentPanel, XRSection, XRArticle,
  // XRFormPanel, XRGenericPanel at the top level) has panel-absolute child
  // positions and must render children inside its own positioned group.
  if (entry.paginatedByEngine) {
    return (
      <PaginatingPanelRenderer
        primitive={primitive}
        plan={plan}
        pageState={pageState}
        setPage={setPage}
        primitiveMap={primitiveMap}
        entry={entry}
      />
    );
  }

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

  switch (primitive.type) {
    case "XRHeading":
      return (
        <AtPos entry={entry}>
          <XRHeadingMesh
            primitive={primitive as XRHeading}
            entry={zeroedEntry(entry)}
            renderChild={renderChild}
          />
        </AtPos>
      );
    case "XRParagraph":
      return (
        <AtPos entry={entry}>
          <XRParagraphMesh
            primitive={primitive as XRParagraph}
            entry={zeroedEntry(entry)}
            renderChild={renderChild}
            getChildEntry={(childId: string) => plan.entries[childId] ?? null}
          />
        </AtPos>
      );
    case "XRText":
      return (
        <AtPos entry={entry}>
          <XRTextMesh
            primitive={primitive as import("../mapper/types").XRText}
            entry={zeroedEntry(entry)}
          />
        </AtPos>
      );
    case "XRLink": {
      const linkPrimitive = primitive as import("../mapper/types").XRLink;
      return (
        <AtPos entry={entry}>
          <XRLinkMesh
            primitive={linkPrimitive}
            entry={zeroedEntry(entry)}
            renderChild={renderChild}
          />
        </AtPos>
      );
    }
    case "XRNavigationBar": {
      const onNavigate = (href: string) => {
        const sectionId = href.startsWith("#") ? href.slice(1) : href;
        const sectionEntry = plan.entries[sectionId];
        if (!sectionEntry || sectionEntry.pageIndex === undefined) return;
        for (const [, p] of primitiveMap) {
          if (p.type === "XRContentPanel" && hasDescendant(p, sectionId)) {
            setPage(p.id, sectionEntry.pageIndex);
            return;
          }
        }
      };
      return (
        <AtPos entry={entry}>
          <XRNavigationMesh
            primitive={primitive as XRNavigationBar}
            entry={zeroedEntry(entry)}
            onNavigate={onNavigate}
          />
        </AtPos>
      );
    }
    case "XRMediaPlayer":
      return (
        <AtPos entry={entry}>
          <XRMediaMesh
            primitive={primitive as XRMediaPlayer}
            entry={zeroedEntry(entry)}
          />
        </AtPos>
      );
    case "XRCodeBlock":
      return (
        <AtPos entry={entry}>
          <XRCodeBlockMesh
            primitive={primitive as XRCodeBlock}
            entry={zeroedEntry(entry)}
          />
        </AtPos>
      );
    case "XRBlockQuote":
      return (
        <AtPos entry={entry}>
          <XRBlockQuoteMesh
            primitive={primitive as XRBlockQuote}
            entry={zeroedEntry(entry)}
            renderChild={renderChild}
          />
        </AtPos>
      );
    case "XRSeparator":
      return (
        <AtPos entry={entry}>
          <XRSeparatorMesh
            primitive={primitive as XRSeparator}
            entry={zeroedEntry(entry)}
          />
        </AtPos>
      );
    case "XRProgressBar":
      return (
        <AtPos entry={entry}>
          <XRProgressBarMesh
            primitive={primitive as XRProgressBar}
            entry={zeroedEntry(entry)}
          />
        </AtPos>
      );
    case "XRImage":
      return (
        <AtPos entry={entry}>
          <XRImageMesh
            primitive={primitive as XRImage}
            entry={zeroedEntry(entry)}
          />
        </AtPos>
      );
    case "XRFigure": {
      return (
        <WithSiblingChildren
          entry={entry}
          backing={<PanelBacking entry={zeroedEntry(entry)} opacity={0.15} />}
          primitives={primitive.children}
          plan={plan}
          pageState={pageState}
          setPage={setPage}
          primitiveMap={primitiveMap}
        />
      );
    }
    case "XRButton":
      return (
        <AtPos entry={entry}>
          <XRButtonMesh
            primitive={primitive as XRButton}
            entry={zeroedEntry(entry)}
          />
        </AtPos>
      );
    case "XRAlert":
      return (
        <AtPos entry={entry}>
          <XRAlertMesh
            primitive={primitive as XRAlert}
            entry={zeroedEntry(entry)}
            renderChild={renderChild}
          />
        </AtPos>
      );
    case "XRFormField":
      return (
        <AtPos entry={entry}>
          <XRFormFieldMesh
            primitive={primitive as XRFormField}
            entry={zeroedEntry(entry)}
          />
        </AtPos>
      );

    case "XRSection": {
      const sectionChildEntries = primitive.children
        .map((c) => plan.entries[c.id])
        .filter(
          (e): e is LayoutEntry =>
            !!e && (e.pageIndex === undefined || e.pageIndex === currentPage),
        );
      return (
        <WithSiblingChildren
          entry={entry}
          backing={
            <XRSectionMesh
              primitive={primitive as XRSection}
              entry={zeroedEntry(entry)}
              childEntries={sectionChildEntries}
              renderChild={() => null}
              isContinuation={false}
              hasMore={false}
            />
          }
          primitives={primitive.children}
          plan={plan}
          pageState={pageState}
          setPage={setPage}
          primitiveMap={primitiveMap}
        />
      );
    }

    case "XRBanner":
    case "XRFooter":
      // Intentionally hidden from the XR view — header/footer chrome is
      // not useful in an immersive spatial context.
      return null;

    case "XRArticle":
    case "XRFormPanel": {
      // Children have panel-absolute positions — render own backing then
      // dispatch children as siblings to avoid double-translating offsets.
      return (
        <WithSiblingChildren
          entry={entry}
          backing={<PanelBacking entry={zeroedEntry(entry)} opacity={0.2} />}
          primitives={primitive.children}
          plan={plan}
          pageState={pageState}
          setPage={setPage}
          primitiveMap={primitiveMap}
        />
      );
    }

    case "XRComplementary": {
      // Both hoisted (no pageIndex) and extracted (pageIndex set) complementaries
      // share the same rendering: backing + children wrapped in <AtPos> at the
      // slot's world position. Children carry LOCAL positions from stackChildrenSimple
      // relative to the complementary slot's top-left, so they must render INSIDE
      // this group — not as world-space siblings — for the slot offset to compose.
      return (
        <AtPos entry={entry}>
          <PanelBacking entry={zeroedEntry(entry)} opacity={0.2} />
          <DispatchChildren
            primitives={primitive.children}
            plan={plan}
            pageState={pageState}
            setPage={setPage}
            primitiveMap={primitiveMap}
          />
        </AtPos>
      );
    }

    case "XRListItem": {
      // FIX: flatten transparent XRGenericPanel wrappers (e.g. a <span> or
      // <cite> node wrapping <a>…</a>) before deciding whether this item
      // has only block children.  Without flattening, a list item whose
      // entire prose run is wrapped in one XRGenericPanel (e.g. Wikipedia
      // citation items: listitem → generic → [XRLink, XRText, …]) reports
      // hasOnlyBlockChildren=true and goes to the WithSiblingChildren path,
      // which dispatches the XRGenericPanel via PrimitiveDispatcher.  That
      // dispatcher renders XRGenericPanel as a transparent container and
      // dispatches its children at their plan-absolute positions — producing
      // the overlapping / cascading text seen in the screenshot.
      //
      // After flattening, the wrapper is unwrapped and its inline children
      // surface here, so hasOnlyBlockChildren=false and the item takes the
      // correct "mesh owns child rendering" path.
      const flatEffectiveChildren = flattenInlineWrappers(
        primitive.children as any[],
      );
      const hasOnlyBlockChildren =
        flatEffectiveChildren.length > 0 &&
        flatEffectiveChildren.every((c: any) => !isInlinePrimitive(c.type));

      // Used by the mixed inline+block branch below: the non-inline subset
      // of this item's flattened children (e.g. the <div>/<section> wrapper
      // sitting alongside an inline icon link) — these must be dispatched
      // as true positioned siblings, never rendered through XRListItemMesh,
      // to avoid double-applying their already-absolute positions.
      const blockChildrenForDispatch = flatEffectiveChildren.filter(
        (c: any) => !isInlinePrimitive(c.type),
      );

      if (hasOnlyBlockChildren) {
        // Block-only card: backing at card position, children as siblings.
        return (
          <WithSiblingChildren
            entry={entry}
            backing={
              <XRListItemMesh
                primitive={primitive as XRListItem}
                entry={zeroedEntry(entry)}
                renderChild={() => null}
              />
            }
            primitives={primitive.children}
            plan={plan}
            pageState={pageState}
            setPage={setPage}
            primitiveMap={primitiveMap}
          />
        );
      }

      // Inline-children case (e.g. a card whose direct children mix an
      // inline icon/link with a block wrapper — image+HTML/CSS/JS cards):
      // mesh draws its own backing/accent/label/inline-prose-row, but block
      // children must NOT be rendered through it.
      //
      // FIX: XRListItemMesh's <group position={pos}> sits at this item's
      // real absolute coordinates (needed so the backing panel lands in the
      // right spot). Previously blockChildren were rendered via
      // renderChild(child.id) called FROM INSIDE that same positioned group
      // — but renderChild resolves through PrimitiveDispatcher, which wraps
      // each block child in its OWN <AtPos> using that child's already-
      // absolute panel-space position. Nesting an absolutely-positioned
      // child inside an already-absolutely-positioned group double-applies
      // the translation (this is the same double-translation bug fixed for
      // XRSection/hasOnlyBlockChildren above, just one level deeper here).
      // The extra drift was each item's own absolute X added a second time,
      // so item 2's content landed in item 3's column, item 3's landed off
      // the grid entirely — reading as a "shift" rather than "exponential"
      // because the comparison point (each item's OWN slot) moves too.
      //
      // Fix mirrors the XRSection/block-only-XRListItem pattern exactly:
      // XRListItemMesh renders at a ZEROED entry (so it only draws its own
      // backing/accent/label/inline-icon-row, never anything carrying an
      // absolute child position), wrapped in a single outer <AtPos> for
      // the real position, and block children are dispatched as true
      // siblings via WithSiblingChildren — never nested inside the mesh's
      // own positioned group.
      return (
        <WithSiblingChildren
          entry={entry}
          backing={
            <XRListItemMesh
              primitive={primitive as XRListItem}
              entry={zeroedEntry(entry)}
              renderChild={() => null}
            />
          }
          primitives={blockChildrenForDispatch}
          plan={plan}
          pageState={pageState}
          setPage={setPage}
          primitiveMap={primitiveMap}
        />
      );
    }

    case "XRList":
    case "XRTableRow":
    case "XRTableCell":
      // Children have panel-absolute positions — dispatch as siblings only.
      return (
        <DispatchChildren
          primitives={primitive.children}
          plan={plan}
          pageState={pageState}
          setPage={setPage}
          primitiveMap={primitiveMap}
        />
      );

    case "XRTable": {
      return (
        <WithSiblingChildren
          entry={entry}
          backing={
            <XRTableMesh
              primitive={primitive as XRTable}
              entry={zeroedEntry(entry)}
              renderChild={() => null}
            />
          }
          primitives={primitive.children}
          plan={plan}
          pageState={pageState}
          setPage={setPage}
          primitiveMap={primitiveMap}
        />
      );
    }

    case "XRTabGroup":
      return (
        <AtPos entry={entry}>
          <XRTabGroupMesh
            primitive={primitive as XRTabGroup}
            entry={zeroedEntry(entry)}
            renderChild={renderChild}
          />
        </AtPos>
      );

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
    case "XRComboBox": {
      const w = Math.max(entry.size.width, 0.025);
      return (
        <AtPos entry={entry}>
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
        </AtPos>
      );
    }

    default: {
      // XRGenericPanel is a transparent wrapper — no visual of its own.
      // Children already carry panel-absolute positions, so dispatch directly.
      if (primitive.type === "XRGenericPanel") {
        return (
          <DispatchChildren
            primitives={primitive.children}
            plan={plan}
            pageState={pageState}
            setPage={setPage}
            primitiveMap={primitiveMap}
          />
        );
      }

      // Unknown container: render a debug backing, children as siblings.
      return (
        <WithSiblingChildren
          entry={entry}
          backing={
            <GenericPanelMesh
              primitive={primitive}
              entry={zeroedEntry(entry)}
            />
          }
          primitives={primitive.children}
          plan={plan}
          pageState={pageState}
          setPage={setPage}
          primitiveMap={primitiveMap}
        />
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
  pageRange,
}: {
  primitiveId: string;
  pagination: { pageCount: number };
  currentPage: number;
  entry: LayoutEntry;
  onPageChange: (page: number) => void;
  pageRange?: [number, number] | null;
}) {
  const w = entry.size.width;
  const h = entry.size.height;
  const BTN_W = 0.1;
  const BTN_H = 0.038;
  const barY = -(h + BTN_H / 2 + 0.016);
  const SPREAD = Math.min(w / 2 - BTN_W * 0.6, 0.22);
  const fontType = React.useContext(FontContext);

  // When a section range is active, clamp navigation and show relative page numbers.
  const firstPage = pageRange?.[0] ?? 0;
  const lastPage = pageRange?.[1] ?? (pagination.pageCount - 1);
  const sectionPageCount = lastPage - firstPage + 1;
  const relPage = currentPage - firstPage; // 0-based within section

  return (
    <group position={[w / 2, barY, 0.005]}>
      <group
        position={[-SPREAD, 0, 0]}
        onClick={() => onPageChange(Math.max(firstPage, currentPage - 1))}
      >
        <RoundedBox
          args={[BTN_W, BTN_H, 0.006]}
          radius={Math.min(BTN_H / 2, 0.0029)}
        >
          <meshStandardMaterial
            color={currentPage <= firstPage ? "#1a1f2e" : "#1a2840"}
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
        position={[0, 0, 0]}
        fontSize={0.016}
        color="#fff"
      >
        {`${relPage + 1} / ${sectionPageCount}`}
      </Text>

      <group
        position={[SPREAD, 0, 0]}
        onClick={() =>
          onPageChange(Math.min(lastPage, currentPage + 1))
        }
      >
        <RoundedBox
          args={[BTN_W, BTN_H, 0.006]}
          radius={Math.min(BTN_H / 2, 0.0029)}
        >
          <meshStandardMaterial
            color={
              currentPage >= lastPage ? "#1a1f2e" : "#1a2840"
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
  viewMode,
}: {
  scene: SemanticScene;
  plan: LayoutPlan;
  pageState: PageState;
  setPage: (id: string, page: number) => void;
  viewMode?: ViewMode;
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
    return scene.root.children.find(
      (p) => p.type === "XRContentPanel" && plan.entries[p.id]?.paginatedByEngine,
    ) ?? null;
  }, [viewMode, scene.root.children, plan.entries]);

  return (
    <>
      {scene.root.children.map((primitive) => {
        // In carousel mode, the main content panel is rendered via CarouselPanelGroup
        if (viewMode === "carousel" && primitive === mainContentPanel) {
          const entry = plan.entries[primitive.id];
          if (!entry) return null;
          // Ghost panels: flat x-offset from main (no overlap), z pulled
          // toward the viewer by one step (tier 1 = -d + Z_STEP).
          const prevEntry: LayoutEntry = {
            ...entry,
            position: {
              x: entry.position.x - CAROUSEL_GHOST_GAP - entry.size.width,
              y: entry.position.y,
              z: entry.position.z + CAROUSEL_Z_STEP,
            },
            rotation: angularRotation(CAROUSEL_GHOST_PREV_ANGLE_DEG),
          };
          const nextEntry: LayoutEntry = {
            ...entry,
            position: {
              x: entry.position.x + entry.size.width + CAROUSEL_GHOST_GAP,
              y: entry.position.y,
              z: entry.position.z + CAROUSEL_Z_STEP,
            },
            rotation: angularRotation(CAROUSEL_GHOST_NEXT_ANGLE_DEG),
          };

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

        return (
          <PrimitiveDispatcher
            key={primitive.id}
            primitive={primitive}
            plan={plan}
            pageState={pageState}
            setPage={setPage}
            primitiveMap={primitiveMap}
          />
        );
      })}
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
  parserConfig = {},
  viewMode,
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

  // Map view mode → explicit layout template override
  const templateOverride = useMemo((): "document"|"dashboard"|"form"|"landing"|"generic"|"carousel"|"cards"|"door"|"theatre"|undefined => {
    switch (viewMode) {
      case "carousel": return "carousel";
      case "cards":    return "cards";
      case "door":     return "door";
      case "theatre":  return "theatre";
      default:         return undefined; // "standard" → auto-select
    }
  }, [viewMode]);

  const {
    scene,
    plan,
    error: pipelineError,
  } = usePipeline(html, sceneIn, url, deviceProfile, {
    ...layoutConfig,
    // sectionStartsOnNewPage: false,
  }, parserConfig, templateOverride);

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

  // ── View-mode interaction state ─────────────────────────────
  const [expandedSectionId, setExpandedSectionId] = useState<string | null>(null);
  const [cardsZoom, setCardsZoom] = useState<CardsZoomLevel>(0);
  const [cardsFocusedId, setCardsFocusedId] = useState<string | null>(null);

  // Reset interaction state when viewMode or content changes
  useEffect(() => {
    setExpandedSectionId(null);
    setPageStateMap({});
    setCardsZoom(0);
    setCardsFocusedId(null);
  }, [viewMode, html, scene]);

  // ── Cards zoom derived state ─────────────────────────────────
  const mainPanelId = useMemo(
    () =>
      scene?.root.children.find((p) => p.type === "XRContentPanel")?.id ??
      null,
    [scene],
  );

  const topLevelCards = useMemo(
    () => (scene && plan ? getSectionCards(scene, plan, null) : []),
    [scene, plan],
  );

  const focusedCard = useMemo(
    () =>
      cardsFocusedId
        ? (topLevelCards.find((c) => c.id === cardsFocusedId) ?? null)
        : null,
    [topLevelCards, cardsFocusedId],
  );

  // Section-scoped page range for the reading view: clamps Prev/Next to this
  // section's pages only. null when not in cards reading mode.
  const cardsSectionRange = useMemo(
    (): [number, number] | null =>
      viewMode === "cards" && cardsZoom === 1 && focusedCard
        ? [focusedCard.pageIndex, focusedCard.endPage]
        : null,
    [viewMode, cardsZoom, focusedCard],
  );

  const handleCardsZoomOut = useCallback(() => {
    setCardsZoom(0);
    setCardsFocusedId(null);
  }, []);

  const handlePointerMissed = useCallback(() => {
    if (viewMode === "cards" && cardsZoom > 0) handleCardsZoomOut();
  }, [viewMode, cardsZoom, handleCardsZoomOut]);

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
          onPointerMissed={handlePointerMissed}
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

            <RenderMetricsContext.Provider value={deviceProfile.renderMetrics}>
              <FontContext.Provider value={fontType}>
                {/* Level 0 (overview): locked fly-out position, no orbit */}
                {viewMode === "cards" && cardsZoom === 0 && (
                  <CameraRig
                    targetPos={[0, 1.5, 1.8]}
                    targetLook={CARDS_LOOK_TARGET}
                  />
                )}
                {/* Level 1 (reading): snap camera to reading position, then
                    hand off to OrbitControls so the user can look around */}
                {viewMode === "cards" && cardsZoom === 1 && (
                  <CameraSnapTo
                    position={CARDS_READ_POS}
                    lookAt={CARDS_READ_LOOK}
                  />
                )}

                {scene && plan && (
                  viewMode === "cards" && cardsZoom === 0 ? (
                    /* Level 0: overview grid of all top-level section cards */
                    <CardsGridMesh
                      cards={topLevelCards}
                      focusedId={cardsFocusedId}
                      onCardClick={(id, pageIndex) => {
                        setCardsFocusedId(id);
                        setCardsZoom(1);
                        if (mainPanelId) setPage(mainPanelId, pageIndex);
                      }}
                    />
                  ) : (
                    /* Level 1: reading view — pagination scoped to the focused section */
                    <PageRangeContext.Provider value={cardsSectionRange}>
                      <XRSceneGraph
                        scene={scene}
                        plan={plan}
                        pageState={pageState}
                        setPage={setPage}
                        viewMode={viewMode}
                      />
                    </PageRangeContext.Provider>
                  )
                )}

                {/* OrbitControls: disabled only during cards overview (level 0) */}
                {sessionState !== "immersive" &&
                  (viewMode !== "cards" || cardsZoom === 1) && (
                    <OrbitControls
                      target={
                        viewMode === "cards"
                          ? CARDS_READ_LOOK
                          : [0, 1.4, -1.2]
                      }
                      enablePan
                      enableDamping
                      dampingFactor={0.08}
                    />
                  )}

                {/* Debug helpers: grid/gizmo hidden in cards mode entirely */}
                {sessionState !== "immersive" && viewMode !== "cards" && (
                  <>
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

        {/* ── Cards mode breadcrumb ───────────────────────────── */}
        {viewMode === "cards" && cardsZoom > 0 && (
          <div style={styles.cardsBreadcrumb}>
            <button
              onClick={handleCardsZoomOut}
              style={styles.cardsBreadcrumbBack}
            >
              ← All sections
            </button>
            {focusedCard && (
              <span style={styles.cardsBreadcrumbLabel}>
                {focusedCard.label}
              </span>
            )}
          </div>
        )}

        {/* ── Door mode TOC navigation overlay ───────────────── */}
        {viewMode === "door" && scene && plan && (
          <DoorTOCNav
            scene={scene}
            plan={plan}
            expandedSectionId={expandedSectionId}
            setExpandedSectionId={setExpandedSectionId}
            setPage={setPage}
          />
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Door TOC navigation overlay
// ─────────────────────────────────────────────────────────────

/**
 * Always-visible sidebar navigation for door mode.
 * Shows TOC items; clicking one jumps the main content panel to that section.
 * The active item is highlighted so the user knows where they are.
 */
function DoorTOCNav({
  scene,
  plan,
  expandedSectionId,
  setExpandedSectionId,
  setPage,
}: {
  scene: SemanticScene;
  plan: LayoutPlan;
  expandedSectionId: string | null;
  setExpandedSectionId: (id: string | null) => void;
  setPage: (id: string, page: number) => void;
}) {
  const mainPanelId = React.useMemo(
    () => scene.root.children.find((p) => p.type === "XRContentPanel")?.id,
    [scene.root.children],
  );

  // Build the same TOC-item list as CardsOverlay.
  const items = React.useMemo(() => {
    const result: { id: string; label: string; pageIndex: number }[] = [];

    const mainPanel = scene.root.children.find(
      (p) => p.type === "XRContentPanel",
    );
    const sectionPageByLabel = new Map<string, number>();
    if (mainPanel) {
      for (const child of mainPanel.children) {
        const heading = child.children.find((c) => c.type === "XRHeading");
        const label = (heading?.label ?? child.label ?? "").toLowerCase().trim();
        const pageIndex = plan.entries[child.id]?.pageIndex ?? 0;
        if (label) sectionPageByLabel.set(label, pageIndex);
      }
    }

    const tocNav = scene.root.children.find(
      (p) => p.type === "XRNavigationBar",
    );
    if (!tocNav) {
      if (mainPanel) {
        for (const child of mainPanel.children) {
          if (child.type !== "XRSection" && child.type !== "XRArticle") continue;
          const heading = child.children.find((c) => c.type === "XRHeading");
          const label = heading?.label ?? child.label ?? child.id;
          const pageIndex = plan.entries[child.id]?.pageIndex ?? 0;
          result.push({ id: child.id, label, pageIndex });
        }
      }
      return result;
    }

    for (const link of tocNav.children) {
      const label = link.label ?? link.content ?? "";
      if (!label) continue;
      const pageIndex =
        sectionPageByLabel.get(label.toLowerCase().trim()) ?? 0;
      result.push({ id: link.id, label, pageIndex });
    }
    return result;
  }, [scene.root.children, plan.entries]);

  if (items.length === 0) return null;

  return (
    <div
      style={{
        position: "absolute",
        top: 50,
        left: 14,
        bottom: 60,
        width: 200,
        display: "flex",
        flexDirection: "column",
        gap: 3,
        padding: "10px 8px",
        background: "rgba(6, 10, 20, 0.92)",
        border: "1px solid rgba(88, 166, 255, 0.18)",
        borderRadius: 12,
        backdropFilter: "blur(16px)",
        WebkitBackdropFilter: "blur(16px)",
        zIndex: 200,
        fontFamily: "system-ui, -apple-system, sans-serif",
        overflowY: "auto",
      }}
    >
      <div style={{ fontSize: 10, color: "#3a5870", marginBottom: 4, paddingLeft: 4, letterSpacing: "0.08em", textTransform: "uppercase" }}>
        Sections
      </div>
      {items.map(({ id, label, pageIndex }) => {
        const isActive = expandedSectionId === id;
        return (
          <button
            key={id}
            onClick={() => {
              setExpandedSectionId(id);
              if (mainPanelId) setPage(mainPanelId, pageIndex);
            }}
            style={{
              padding: "5px 8px",
              textAlign: "left",
              background: isActive ? "rgba(88, 166, 255, 0.15)" : "transparent",
              border: `1px solid ${isActive ? "rgba(88, 166, 255, 0.4)" : "transparent"}`,
              borderRadius: 6,
              color: isActive ? "#58a6ff" : "#7a9abf",
              fontSize: 11,
              cursor: "pointer",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
              transition: "all 0.12s",
            }}
            title={label}
          >
            {isActive ? "▶ " : "  "}{label}
          </button>
        );
      })}
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
  cardsBreadcrumb: {
    position: "absolute",
    top: 50,
    left: "50%",
    transform: "translateX(-50%)",
    display: "flex",
    alignItems: "center",
    gap: 10,
    padding: "6px 14px",
    background: "rgba(6, 10, 20, 0.88)",
    border: "1px solid rgba(88, 166, 255, 0.18)",
    borderRadius: 24,
    backdropFilter: "blur(16px)",
    WebkitBackdropFilter: "blur(16px)",
    zIndex: 200,
    fontFamily: "system-ui, -apple-system, sans-serif",
    pointerEvents: "auto" as const,
  },
  cardsBreadcrumbBack: {
    padding: "4px 12px",
    background: "rgba(88, 166, 255, 0.1)",
    border: "1px solid rgba(88, 166, 255, 0.3)",
    borderRadius: 16,
    color: "#58a6ff",
    fontSize: 11,
    cursor: "pointer",
    fontFamily: "inherit",
  },
  cardsBreadcrumbLabel: {
    fontSize: 11,
    color: "#7a9abf",
    maxWidth: 260,
    overflow: "hidden" as const,
    textOverflow: "ellipsis",
    whiteSpace: "nowrap" as const,
  },
};
