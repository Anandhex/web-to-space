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

import React, {
  useState,
  useCallback,
  useEffect,
  useMemo,
  Suspense,
} from "react";
import { Canvas } from "@react-three/fiber";
import {
  Environment,
  GizmoHelper,
  GizmoViewport,
  OrbitControls,
} from "@react-three/drei";

import { getArrangement, carouselGhostPlacement } from "../layout/placement";
import {
  QUEST_PRO_PROFILE,
  RAY_BAN_META_PROFILE,
  QUEST_3_PROFILE,
} from "../layout/profiles";
import type {
  SemanticScene,
} from "../mapper/types";
import type {
  LayoutPlan,
  LayoutConfig,
  SlotName,
  SlotMap,
  LandmarkSlot,
} from "../layout/types";
import type { ParserConfig, ParserBackend } from "../ir/types";
import type { ViewMode, Tab } from "../components/viewTypes";
import { XR3DTabBar, XR3DViewToggle } from "../components/XR3DChrome";
import { ThemeContext, LIGHT_THEME, type XRTheme } from "./theme";
import { RenderMetricsContext } from "./primitives";
import { useXRSession } from "./useXRSession";
import { Web2VRScene } from "./Web2VRScene";

// Scene package — the renderer was split out of this (formerly ~3400-line)
// file into ./scene/* for readability. This file is now just the top-level
// <XRSceneRenderer> component wiring those pieces together.
import { EMPTY_CONFIG } from "./scene/config";
import { FontContext, type PageState } from "./scene/contexts";
import { usePipeline } from "./scene/use-pipeline";
import { XRSessionBinder } from "./scene/camera";
import { ReferenceFrameGroup, XRSceneGraph } from "./scene/scene-graph";
import { VRButton, styles } from "./scene/chrome";
import {
  PanelTuner,
  type TuneState,
  type TunerTarget,
} from "./scene/PanelTuner";

// Re-export the renderer contexts so existing consumers
// (`import { FontContext } from "./XRSceneRenderer"`, HomeScreen's XRDeviceType)
// keep working unchanged.
export {
  FontContext,
  CurrentPageContext,
  PageRangeContext,
} from "./scene/contexts";

export type XRDeviceType = "QUEST_3" | "QUEST_PRO" | "RAY_BAN_META";

// Reading-priority order for the panel-tuner target picker.
const TUNER_SLOT_ORDER: SlotName[] = [
  "main",
  "complementary",
  "toc",
  "navigation",
  "banner",
  "footer",
];

/** Flatten a landmark slot into the tuner's editable value shape. */
function slotToTune(s: LandmarkSlot): TuneState {
  return {
    x: s.position.x,
    y: s.position.y,
    z: s.position.z,
    rotX: s.rotation.x,
    rotY: s.rotation.y,
    rotZ: s.rotation.z,
    curveRadius: s.curveRadius,
  };
}

/** Ghost prev/next seed values (position + facing) from the resolved main slot. */
function ghostSeeds(slots: SlotMap): Record<string, TuneState> {
  const main = slots.main;
  if (!main) return {};
  const { prev, next } = carouselGhostPlacement(main.position, main.size);
  const toState = (p: {
    position: { x: number; y: number; z: number };
    rotation: { x: number; y: number; z: number };
  }): TuneState => ({
    x: p.position.x,
    y: p.position.y,
    z: p.position.z,
    rotX: p.rotation.x,
    rotY: p.rotation.y,
    rotZ: p.rotation.z,
    curveRadius: main.curveRadius,
  });
  return { "ghost-prev": toState(prev), "ghost-next": toState(next) };
}

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
  /**
   * Selects the HTML processing strategy applied before the XR pipeline.
   * "flat" skips the pipeline entirely and renders raw HTML in a browser iframe.
   */
  parserBackend?: ParserBackend;
  viewMode?: ViewMode;
  /** Called when the in-world view-mode toggle changes the layout mode. */
  onViewModeChange?: (m: ViewMode) => void;
  onPlanReady?: (plan: LayoutPlan) => void;
  /** Called when a non-anchor link is clicked; defaults to window.open if omitted. */
  onExternalNavigate?: (href: string) => void;
  /** XR primitive colour palette. Defaults to LIGHT_THEME (Meta Horizon UI Set). */
  theme?: XRTheme;
  /** In-world tab switcher wiring. When provided, a 3D tab bar is rendered. */
  tabs?: Tab[];
  activeTabId?: string;
  onSwitchTab?: (id: string) => void;
  onCloseTab?: (id: string) => void;
  onNewTab?: () => void;
}

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
  parserBackend = "custom",
  viewMode,
  onViewModeChange,
  onPlanReady,
  onExternalNavigate,
  theme = LIGHT_THEME,
  tabs,
  activeTabId,
  onSwitchTab,
  onCloseTab,
  onNewTab,
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
  const templateOverride = useMemo(():
    | "document"
    | "landing"
    | "generic"
    | "carousel"
    | "theatre"
    | undefined => {
    switch (viewMode) {
      case "carousel":
        return "carousel";
      case "theatre":
        return "theatre";
      default:
        return undefined; // "standard" / arrangement views → auto content template
    }
  }, [viewMode]);

  // Two-axis arrangement views (focus/stack/orbital/palm/gallery) route through
  // the arrangement path: the spatial distribution composes over whatever
  // content template the scene auto-selects. Legacy views → undefined.
  const arrangement = useMemo(() => getArrangement(viewMode), [viewMode]);

  // Camera look target for the flat (non-immersive) preview. Panels are
  // top-left anchored, so a panel whose top sits at eyeY hangs *below* the eye
  // line — aiming at eyeY frames the panel in the bottom of the viewport. Aim
  // at the panel's vertical centre instead so content reads head-on. Derived
  // from the active profile so it adapts across devices (Quest vs Ray-Ban).
  const readingLook = useMemo((): [number, number, number] => {
    const cfg = deviceProfile.layoutConfig;
    const eyeY = cfg.eyeLevel + cfg.eyeLevelOffset;
    const centerY = eyeY - cfg.maxPanelViewportHeight / 2;
    return [0, centerY, -cfg.viewingDistance];
  }, [deviceProfile]);

  // Live panel tuning (DOM HUD). Per-slot overrides feed the layout engine and
  // re-run the pipeline on change; ghost overrides feed the carousel renderer
  // directly (ghosts aren't slots). Empty = nothing overridden.
  const [slotTune, setSlotTune] = useState<Partial<Record<SlotName, TuneState>>>(
    {},
  );
  const [ghostTune, setGhostTune] = useState<Record<string, TuneState>>({});

  const {
    scene,
    plan,
    error: pipelineError,
    backendLabel,
  } = usePipeline(
    html,
    sceneIn,
    url,
    deviceProfile,
    {
      ...layoutConfig,
      slotOverrides: slotTune,
      // sectionStartsOnNewPage: false,
    },
    parserConfig,
    parserBackend,
    templateOverride,
    arrangement,
  );

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

  // Reset paging state when viewMode or content changes
  useEffect(() => {
    setPageStateMap({});
  }, [viewMode, html, scene]);

  const mainPanelId = useMemo(
    () =>
      scene?.root.children.find((p) => p.type === "XRContentPanel")?.id ?? null,
    [scene],
  );

  // ── Panel tuner data ────────────────────────────────────────
  // Targets = landmark slots present in the plan, plus the two carousel ghosts.
  const tunerTargets = useMemo((): TunerTarget[] => {
    const slots = plan?.slots;
    if (!slots) return [];
    const list: TunerTarget[] = TUNER_SLOT_ORDER.filter(
      (name) => slots[name],
    ).map((name) => ({ id: name, label: name, kind: "slot" as const }));
    if (viewMode === "carousel" && slots.main) {
      list.push(
        { id: "ghost-prev", label: "ghost · prev", kind: "ghost" },
        { id: "ghost-next", label: "ghost · next", kind: "ghost" },
      );
    }
    return list;
  }, [plan, viewMode]);

  // Merge slot + ghost overrides for the tuner's per-target state map.
  const tunerOverrides = useMemo(
    (): Record<string, TuneState> => ({ ...slotTune, ...ghostTune }),
    [slotTune, ghostTune],
  );

  // Seed values (pre-override slot geometry / computed ghost placement).
  const ghostSeedMap = useMemo(
    () => (plan?.slots ? ghostSeeds(plan.slots) : {}),
    [plan],
  );
  const seedFor = useCallback(
    (id: string): TuneState | null => {
      if (id.startsWith("ghost-")) return ghostSeedMap[id] ?? null;
      const s = plan?.slots?.[id as SlotName];
      return s ? slotToTune(s) : null;
    },
    [plan, ghostSeedMap],
  );
  const sizeFor = useCallback(
    (id: string): { width: number; height: number } | null => {
      const src = id.startsWith("ghost-") ? "main" : id;
      return plan?.slots?.[src as SlotName]?.size ?? null;
    },
    [plan],
  );
  const anchorFor = useCallback(
    (id: string): { x: number; y: number; z: number } | null => {
      if (!id.startsWith("ghost-")) return null;
      return plan?.slots?.main?.position ?? null;
    },
    [plan],
  );
  const onTuneChange = useCallback(
    (id: string, next: TuneState | null) => {
      if (id.startsWith("ghost-")) {
        setGhostTune((prev) => {
          const copy = { ...prev };
          if (next) copy[id] = next;
          else delete copy[id];
          return copy;
        });
      } else {
        setSlotTune((prev) => {
          const copy = { ...prev };
          if (next) copy[id as SlotName] = next;
          else delete copy[id as SlotName];
          return copy;
        });
      }
    },
    [],
  );

  // Anchor for the in-world chrome stack (layout switcher + tab switcher):
  // horizontally centred on the main content panel and pulled forward of it,
  // so the two controls sit centred under the panel as a vertical stack rather
  // than pinned to the world origin. Falls back to the world centre when there
  // is no content panel (e.g. landing/form layouts).
  const chromeAnchor = useMemo(() => {
    const cfg = deviceProfile.layoutConfig;
    const eyeY = cfg.eyeLevel + cfg.eyeLevelOffset;
    const fallback = {
      cx: 0,
      z: -cfg.viewingDistance,
      bottomY: eyeY - cfg.maxPanelViewportHeight,
    };
    const e = mainPanelId ? plan?.entries[mainPanelId] : null;
    if (!e) return fallback;
    const viewportH = Math.min(e.size.height, cfg.maxPanelViewportHeight);
    return {
      cx: e.position.x + e.size.width / 2,
      z: e.position.z,
      bottomY: e.position.y - viewportH,
    };
  }, [deviceProfile, mainPanelId, plan]);

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

      <div style={styles.diag}>
        <span style={{ color: "#58a6ff", opacity: 0.8 }}>{backendLabel}</span>
        {plan && (
          <>
            <span style={{ opacity: 0.4 }}> · </span>
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
          </>
        )}
        {parserBackend === "flat" && (
          <span style={{ marginLeft: "auto", opacity: 0.5 }}>
            browser iframe
          </span>
        )}
        {parserBackend === "web2vr" && (
          <span style={{ marginLeft: "auto", opacity: 0.5 }}>
            CSS layout → 3D
          </span>
        )}
      </div>

      <div style={{ width, height, position: "relative" }}>
        {/* ── Live panel tuning HUD (flat preview only) ───────────── */}
        {sessionState !== "immersive" &&
          parserBackend !== "flat" &&
          tunerTargets.length > 0 && (
            <PanelTuner
              targets={tunerTargets}
              overrides={tunerOverrides}
              seedFor={seedFor}
              sizeFor={sizeFor}
              anchorFor={anchorFor}
              deviceType={deviceType}
              template={plan?.template}
              viewMode={viewMode}
              onChange={onTuneChange}
            />
          )}
        {/* ── Flat backend: raw HTML in a floating browser panel ───── */}
        {parserBackend === "flat" && html && (
          <div style={styles.flatOverlay}>
            <div style={styles.flatPanel}>
              <div style={styles.flatChrome}>
                <span style={{ opacity: 0.6 }}>◉</span>
                <span>Browser Panel</span>
                <span
                  style={{ marginLeft: "auto", opacity: 0.4, fontSize: 10 }}
                >
                  No semantic processing · raw HTML
                </span>
              </div>
              <iframe
                srcDoc={html}
                style={{ flex: 1, border: "none", width: "100%" }}
                sandbox="allow-scripts allow-forms"
                title="Flat browser panel — no XR processing"
              />
            </div>
          </div>
        )}
        <Canvas
          style={{ background }}
          camera={{ position: [0, 1.5, 0], fov: 60, near: 0.01, far: 100 }}
          gl={{
            antialias: true,
            alpha: false,
          }}
          onCreated={({ gl }) => {
            gl.localClippingEnabled = true;
            gl.xr.enabled = true;
          }}
        >
          <Suspense fallback={null}>
            <XRSessionBinder session={session} />
            {/* Even, mostly-neutral lighting so panels read as one flat
                material regardless of how far each is tilted toward the user.
                A strong directional + saturated blue point light previously
                shaded angled panels (e.g. the TOC) noticeably lighter/bluer
                than the head-on content panel. */}
            <ambientLight intensity={0.72} />
            <directionalLight
              position={[0, 3, 2]}
              intensity={0.42}
              castShadow={false}
            />
            <pointLight
              position={[0, 1.5, -1.2]}
              intensity={0.28}
              color="#9ec5ff"
              distance={4}
            />
            <Environment preset="city" />

            <RenderMetricsContext.Provider value={deviceProfile.renderMetrics}>
              <ThemeContext.Provider value={theme}>
                <FontContext.Provider value={fontType}>
                  {/* Web2VR backend: CSS layout extracted from hidden iframe → 3D */}
                  {parserBackend === "web2vr" && html && (
                    <Web2VRScene html={html} />
                  )}

                  {parserBackend !== "web2vr" && scene && plan && (
                    <ReferenceFrameGroup frame={plan.referenceFrame ?? "world"}>
                      <XRSceneGraph
                        scene={scene}
                        plan={plan}
                        pageState={pageState}
                        setPage={setPage}
                        viewMode={viewMode}
                        onExternalNavigate={onExternalNavigate}
                        sourceUrl={url}
                        ghostOverride={ghostTune}
                      />
                    </ReferenceFrameGroup>
                  )}

                  {/* ── In-world browser chrome (replaces HTML overlays) ────
                    Layout switcher (top) and tab switcher (bottom) form a
                    vertical stack, horizontally centred on the content panel
                    and pulled forward of it (parallax separation), with a
                    breathable gap between the two rows. */}
                  {viewMode && onViewModeChange && (
                    <XR3DViewToggle
                      mode={viewMode}
                      onChange={onViewModeChange}
                      deviceType={deviceType}
                      position={[
                        chromeAnchor.cx,
                        chromeAnchor.bottomY + 1.1,
                        chromeAnchor.z,
                      ]}
                      tiltX={0.34}
                    />
                  )}
                  {tabs &&
                    activeTabId &&
                    onSwitchTab &&
                    onCloseTab &&
                    onNewTab && (
                      <XR3DTabBar
                        tabs={tabs}
                        activeTabId={activeTabId}
                        onSwitch={onSwitchTab}
                        onClose={onCloseTab}
                        onNewTab={onNewTab}
                        position={[
                          chromeAnchor.cx,
                          chromeAnchor.bottomY - 0.3,
                          chromeAnchor.z,
                        ]}
                        tiltX={0.34}
                      />
                    )}

                  {sessionState !== "immersive" && (
                    <OrbitControls
                      target={readingLook}
                      enablePan
                      enableDamping
                      dampingFactor={0.08}
                    />
                  )}

                  {/* Debug helpers */}
                  {sessionState !== "immersive" && (
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
                      <mesh
                        position={[0, 1.5, 0]}
                        rotation={[Math.PI / 2, 0, 0]}
                      >
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
              </ThemeContext.Provider>
            </RenderMetricsContext.Provider>
          </Suspense>
        </Canvas>
      </div>
    </div>
  );
}
