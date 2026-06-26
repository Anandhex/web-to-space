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
import { flattenInlineWrappers, isInlinePrimitive } from "../layout/utils";

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
  parserConfig?: Partial<ParserConfig>;
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

/**
 * Dispatches every child primitive as a sibling (panel-absolute coordinates).
 * Used by containers whose children already carry panel-absolute positions so
 * nesting them inside a parent group would double-translate them.
 */
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
      {primitives.map((child) => (
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
  }, [html, sceneIn, url, deviceProfile, stableConfig, stableParserConfig]);

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
      const isRichLink = linkPrimitive.children.some(
        (child) => child.type === "XRText",
      );
      if (isRichLink) {
        // Rich link: render with no chrome of its own at this position —
        // children (e.g. a synthesised XRText leaf) already carry their
        // own panel-absolute positions and must be dispatched as siblings,
        // exactly like XRTableCell/XRSection/XRGenericPanel. Wrapping them
        // inside XRLinkMesh's own <AtPos> here would stack two absolute
        // translations (this link's position AND its child's identical-
        // looking but independently absolute position), roughly doubling
        // the effective offset — see XRLinkMesh's removed rich-link branch.
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
    case "XRNavigationBar":
      return (
        <AtPos entry={entry}>
          <XRNavigationMesh
            primitive={primitive as XRNavigationBar}
            entry={zeroedEntry(entry)}
          />
        </AtPos>
      );
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
    case "XRFigure":
      return (
        <AtPos entry={entry}>
          <XRImageMesh
            primitive={primitive as XRImage}
            entry={zeroedEntry(entry)}
          />
        </AtPos>
      );
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
      if (
        primitive.type === "XRBanner" ||
        primitive.type === "XRFooter" ||
        primitive.type === "XRComplementary"
      ) {
        return null;
      }
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

    case "XRTable":
      return (
        <AtPos entry={entry}>
          <XRTableMesh
            primitive={primitive as XRTable}
            entry={zeroedEntry(entry)}
            renderChild={renderChild}
          />
        </AtPos>
      );

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
  parserConfig = {},
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
  }, parserConfig);

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
