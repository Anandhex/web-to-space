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
import { XR } from "@react-three/xr";
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
import type { SemanticScene } from "../mapper/types";
import type {
  LayoutPlan,
  LayoutConfig,
  SlotName,
  SlotMap,
  LandmarkSlot,
} from "../layout/types";
import type { ParserConfig, ParserBackend } from "../ir/types";
import type { ViewMode, Tab } from "../components/viewTypes";
import { deckLookAt, DECK_STAGE_LIFT } from "./page-placements";
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
import { XRViewerAnchor, PreviewFieldOfView, AxisLook } from "./scene/camera";
import { ReferenceFrameGroup, XRSceneGraph } from "./scene/scene-graph";
import { DeskDecor } from "./scene/desk-decor";
import { sectionRangesFor } from "./scene/page-ghosts";
import { SR_ONLY } from "../components/a11y";
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

/**
 * Flat-preview lens. 60° frames a panel you sit in front of; `rooms` puts the
 * reader inside a building, where a wider lens is what lets the walls, the
 * neighbouring pages and the floor spots read at all — the alternative,
 * standing further back, would take the reader off the reading mark and
 * shrink the text with it.
 */
const DEFAULT_PREVIEW_FOV = 60;
const ROOMS_PREVIEW_FOV = 82;
/**
 * `deck` is two surfaces at once — the page being read, and the table of
 * cards below and in front of it. They span some 70° of vertical angle
 * together, so a 60° lens aimed between them cuts the near rows of the table
 * off the bottom of the frame.
 */
const DECK_PREVIEW_FOV = 76;

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
  /**
   * Spatial arrangement to present the page in. Selected on the Home screen
   * (see HomeSettings.viewMode) — the viewer itself offers no switcher.
   */
  viewMode?: ViewMode;
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
    | undefined => {
    switch (viewMode) {
      case "carousel":
        return "carousel";
      default:
        return undefined; // "standard" / arrangement views → auto content template
    }
  }, [viewMode]);

  // Two-axis arrangement views (focus/stack/orbital/palm/gallery) route through
  // the arrangement path: the spatial distribution composes over whatever
  // content template the scene auto-selects. Legacy views → undefined.
  const arrangement = useMemo(() => getArrangement(viewMode), [viewMode]);

  // Live panel tuning (DOM HUD). Per-slot overrides feed the layout engine and
  // re-run the pipeline on change; ghost overrides feed the carousel renderer
  // directly (ghosts aren't slots). Empty = nothing overridden.
  const [slotTune, setSlotTune] = useState<
    Partial<Record<SlotName, TuneState>>
  >({});
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
    store: xrStore,
    sessionState,
    capabilities,
    enterVR,
    exitVR,
    error: xrError,
  } = useXRSession();

  // Camera look target for the flat (non-immersive) preview. Panels are
  // top-left anchored, so a panel whose top sits at eyeY hangs *below* the eye
  // line — aiming at eyeY frames the panel in the bottom of the viewport. Aim
  // at the panel's vertical centre instead so content reads head-on. Derived
  // from the active profile so it adapts across devices (Quest vs Ray-Ban).
  const readingLook = useMemo((): [number, number, number] => {
    const cfg = deviceProfile.layoutConfig;
    // Read the placed slot rather than re-deriving it: `deskSlots` centres the
    // reading band on the resting gaze instead of hanging it from eye level,
    // so `eyeY - height/2` is no longer where the panel is.
    const m = plan?.slots?.main;
    if (m) {
      return [
        m.position.x + m.size.width / 2,
        m.position.y - m.size.height / 2,
        m.position.z,
      ];
    }
    const eyeY = cfg.eyeLevel + cfg.eyeLevelOffset;
    return [0, eyeY - cfg.maxPanelViewportHeight / 2, -cfg.viewingDistance];
  }, [deviceProfile, plan]);

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
  const onTuneChange = useCallback((id: string, next: TuneState | null) => {
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
  }, []);

  // Centre of the main content panel, in world space. This is what the headset
  // should be levelled with in XR — the immersive counterpart of `readingLook`,
  // which aims the flat preview's OrbitControls at the same point. Panels are
  // top-left anchored, so the centre is half a viewport below the panel's top.
  /**
   * What the desk's sign plate reports. `standard` and `carousel` both read a
   * paginated panel, and neither told the reader which page of how many they
   * were on or which section it belonged to — see scene/desk-decor.tsx.
   */
  const deskReading = useMemo(() => {
    if (viewMode !== undefined && viewMode !== "standard" && viewMode !== "carousel")
      return null;
    if (!plan || !mainPanelId) return null;
    const e = plan.entries[mainPanelId];
    if (!e) return null;
    const pageCount = e.pagination?.pageCount ?? 1;
    return {
      pageCount,
      page: Math.min(pageState[mainPanelId] ?? 0, Math.max(0, pageCount - 1)),
      sectionRanges: sectionRangesFor(plan, pageCount),
      occupied: new Set(plan.occupiedSlots ?? []),
    };
  }, [viewMode, plan, mainPanelId, pageState]);

  /** Accessible name for the scene region, and its live description. */
  const sceneLabel = useMemo(() => {
    const where = url ? ` of ${url}` : "";
    return `3D spatial view${where}, ${viewMode ?? "standard"} arrangement`;
  }, [url, viewMode]);

  const sceneDescription = useMemo(() => {
    if (!deskReading) return "";
    const { pageCount, page, sectionRanges } = deskReading;
    const i = sectionRanges.findIndex((r) => page >= r.start && page <= r.end);
    const section = i >= 0 ? sectionRanges[i].label : null;
    return [
      section ? `Section: ${section}.` : null,
      pageCount > 1 ? `Page ${page + 1} of ${pageCount}.` : null,
    ]
      .filter(Boolean)
      .join(" ");
  }, [deskReading]);

  const panelCentre = useMemo((): [number, number, number] | null => {
    const cfg = deviceProfile.layoutConfig;
    const e = mainPanelId ? plan?.entries[mainPanelId] : null;
    if (!e) return null;
    const viewportH = Math.min(e.size.height, cfg.maxPanelViewportHeight);
    return [
      e.position.x + e.size.width / 2,
      e.position.y - viewportH / 2,
      e.position.z,
    ];
  }, [deviceProfile, mainPanelId, plan]);

  /**
   * The elevator's ring AXIS in world space — where the reader stands.
   *
   * The view builds a cylinder of pages around this point (see
   * renderer/page-placements.ts: the ring centre is the panel slot pushed one
   * viewing distance forward, so the axis runs through the reader), and every
   * bearing on the ring is measured from it. Standing anywhere else is
   * standing outside your own building, so this — not the panel's centre — is
   * what both the headset and the flat preview are put on.
   */
  const elevatorAxis = useMemo((): [number, number, number] | null => {
    if (viewMode !== "elevator") return null;
    const e = mainPanelId ? plan?.entries[mainPanelId] : null;
    if (!e || !plan) return null;
    return [
      e.position.x + e.size.width / 2,
      e.position.y - e.size.height / 2,
      e.position.z + plan.config.viewingDistance,
    ];
  }, [viewMode, mainPanelId, plan]);

  /**
   * `deck` composes a reading page with a card table under it, and the page
   * itself is lifted clear of that table (DECK_STAGE_LIFT) — so neither the
   * flat preview's pivot nor the headset recentre can use the panel's usual
   * slot. The pivot sits between the two surfaces; the recentre levels the
   * eye with the page where this view actually puts it.
   */
  const deckLook = useMemo((): [number, number, number] | null => {
    if (viewMode !== "deck") return null;
    const e = mainPanelId ? plan?.entries[mainPanelId] : null;
    if (!e) return null;
    const p = deckLookAt(e.size);
    return [e.position.x + p.x, e.position.y + p.y, e.position.z + p.z];
  }, [viewMode, mainPanelId, plan]);

  const xrLevel = useMemo((): [number, number, number] | null => {
    if (!panelCentre) return null;
    return viewMode === "deck"
      ? [panelCentre[0], panelCentre[1] + DECK_STAGE_LIFT, panelCentre[2]]
      : panelCentre;
  }, [panelCentre, viewMode]);

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

      {/* ── Text alternative for the scene ──────────────────────
          The document is drawn on a WebGL canvas, which carries no name, no
          role and no keyboard focus — to assistive technology the whole
          reader was a blank element. This is the same "where am I" the sign
          plate gives a sighted reader (scene/desk-decor.tsx), in the
          accessibility tree, and it is announced politely as the page turns
          rather than interrupting. It is a description of the view, not a
          replacement for it: the links and controls inside the scene are
          still canvas-drawn and remain out of reach, which is a larger piece
          of work than a label. */}
      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        style={SR_ONLY}
      >
        {sceneDescription}
      </div>

      <div
        style={{ width, height, position: "relative" }}
        role="region"
        aria-label={sceneLabel}
      >
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
          camera={{
            position: [0, 1.5, 0],
            fov: DEFAULT_PREVIEW_FOV,
            near: 0.01,
            far: 100,
          }}
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
            {/* <XR> binds the session to the renderer and mounts the
                controllers/hands whose pointers drive the same onClick /
                onPointerOver handlers the mouse uses in the flat preview. */}
            <XR store={xrStore}>
              {/* Level the headset with the content panel's centre. Only for the
                  "world" frame: body/head/hand frames already carry the scene
                  with the viewer, and their entries aren't world-space, so
                  there'd be nothing static to recentre against. */}
              <XRViewerAnchor
                target={
                  (plan?.referenceFrame ?? "world") === "world"
                    ? (elevatorAxis ?? xrLevel)
                    : null
                }
              />
              {/* Even, mostly-neutral lighting so panels read as one flat
                  material regardless of how far each is tilted toward the user.
                  A strong directional + saturated blue point light previously
                  shaded angled panels (e.g. the TOC) noticeably lighter/bluer
                  than the head-on content panel. */}
              {/* `rooms` is a place you stand in, not a panel you sit at:
                  give the preview a wider lens there so the room reads. */}
              <PreviewFieldOfView
                fov={
                  viewMode === "rooms"
                    ? ROOMS_PREVIEW_FOV
                    : viewMode === "deck"
                      ? DECK_PREVIEW_FOV
                      : DEFAULT_PREVIEW_FOV
                }
              />
              {viewMode === "elevator" ? (
                /* The atrium lights itself: a cove over every storey (see
                   scene/elevator-decor.tsx) throwing a warm wash down that
                   floor's ring, and a dimmer one over the floors above and
                   below. So the global light here is only the bounce off the
                   shaft — enough to keep the architecture readable, low
                   enough that the coves still do the modelling. As in rooms,
                   no environment map: a city HDR flattens the coves, and
                   offline it never loads at all. */
                <>
                  <ambientLight intensity={0.34} color="#EDE9E2" />
                  <hemisphereLight
                    intensity={0.3}
                    color="#FFEBD2"
                    groundColor="#4A4C55"
                  />
                </>
              ) : viewMode === "rooms" ? (
                /* A gallery is a BRIGHT room. The fittings in the building
                   (see scene/room-decor.tsx) give it pools and direction;
                   this is the light bouncing round a white box, and it has
                   to be generous — cut too far back, the rooms read as a
                   basement corridor at night rather than somewhere you would
                   want to stand and read. Warm from above, floor-bounce from
                   below. No environment map: a city HDR both flattens the
                   fittings' pools and, offline, never loads at all. */
                <>
                  <ambientLight intensity={0.62} color="#F1EEE8" />
                  <hemisphereLight
                    intensity={0.55}
                    color="#FFF3E2"
                    groundColor="#BFB7A8"
                  />
                </>
              ) : (
                <>
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
                </>
              )}

              <RenderMetricsContext.Provider
                value={deviceProfile.renderMetrics}
              >
                <ThemeContext.Provider value={theme}>
                  <FontContext.Provider value={fontType}>
                    {/* Web2VR backend: CSS layout extracted from hidden iframe → 3D */}
                    {parserBackend === "web2vr" && html && (
                      <Web2VRScene html={html} />
                    )}

                    {parserBackend !== "web2vr" && scene && plan && (
                      <ReferenceFrameGroup
                        frame={plan.referenceFrame ?? "world"}
                      >
                        {/* The desk the front-facing views stand in. Derived
                            wholly from the plan's slots, so it follows
                            whatever `deskSlots` decided for this profile. */}
                        {deskReading && plan.slots && (
                          <DeskDecor
                            slots={plan.slots}
                            occupied={deskReading.occupied}
                            pageCount={deskReading.pageCount}
                            page={deskReading.page}
                            sectionRanges={deskReading.sectionRanges}
                          />
                        )}
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
                      Tab switcher, horizontally centred on the content panel
                      and pulled forward of it (parallax separation). The view
                      picker is not here: the arrangement is chosen on the Home
                      screen and is fixed for the loaded page.

                      `rooms` is suppressed entirely — there the reader walks a
                      building rather than sitting at a panel, so a bar welded
                      under the main page would follow them into every room and
                      float loose in the middle of the space. */}
                    {viewMode !== "rooms" &&
                      tabs &&
                      activeTabId &&
                      onSwitchTab &&
                      onCloseTab &&
                      onNewTab &&
                      null
                      // <XR3DTabBar
                      //   tabs={tabs}
                      //   activeTabId={activeTabId}
                      //   onSwitch={onSwitchTab}
                      //   onClose={onCloseTab}
                      //   onNewTab={onNewTab}
                      //   position={[
                      //     chromeAnchor.cx,
                      //     chromeAnchor.bottomY - 0.3,
                      //     chromeAnchor.z,
                      //   ]}
                      //   tiltX={0.34}
                      // />
                    }

                    {sessionState !== "immersive" && (
                      <>
                        <OrbitControls
                          // makeDefault so the scene can find these controls
                          // (useThree(s => s.controls)) — the rooms view puts
                          // the camera back on the reading line when the reader
                          // clicks a spot, and the elevator stands the reader
                          // on the ring axis, neither of which it can do
                          // without them.
                          makeDefault
                          // In the elevator AxisLook owns the pivot — it sits
                          // a centimetre ahead of the eye, not on the axis
                          // itself, and two effects writing the same target
                          // would race.
                          target={
                            elevatorAxis ? undefined : (deckLook ?? readingLook)
                          }
                          // In the elevator the reader is INSIDE the scene:
                          // dragging turns the head (AxisLook parks the pivot
                          // a centimetre ahead of the eye) and there is
                          // nowhere to pan or dolly to — the whole view is
                          // built around one standing point.
                          enablePan={!elevatorAxis}
                          enableZoom={!elevatorAxis}
                          minDistance={elevatorAxis ? 0.01 : 0}
                          maxDistance={elevatorAxis ? 0.01 : Infinity}
                          enableDamping
                          dampingFactor={0.08}
                        />
                        <AxisLook axis={elevatorAxis} />
                      </>
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
            </XR>
          </Suspense>
        </Canvas>
      </div>
    </div>
  );
}
