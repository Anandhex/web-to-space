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
  useSyncExternalStore,
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

import { getArrangement } from "../layout/placement";
import { sectionRangesFor } from "./scene/page-ghosts";
import { QUEST_3_PROFILE } from "../layout/profiles";
import type { SemanticScene } from "../mapper/types";
import type { LayoutPlan, LayoutConfig } from "../layout/types";
import type { ParserConfig, ParserBackend } from "../ir/types";
import type { ViewMode, Tab } from "../components/viewTypes";
import type { Axis, NavState } from "../links/memory";
import { deckLookAt, DECK_STAGE_LIFT } from "./page-placements";
import { XRFrameProbe } from "./scene/frame-probe";
import {
  formatXRDiagnostics,
  getXRDiagnostics,
  subscribeXRDiagnostics,
} from "./xr-diagnostics";
import { DARK_THEME, ThemeContext, type XRTheme } from "./theme";
import { RenderMetricsContext } from "./primitives";
import { useXRSession } from "./useXRSession";

// Scene package — the renderer was split out of this (formerly ~3400-line)
// file into ./scene/* for readability. This file is now just the top-level
// <XRSceneRenderer> component wiring those pieces together.
import { EMPTY_CONFIG } from "./scene/config";
import { FontContext, type PageState } from "./scene/contexts";
import { usePipeline } from "./scene/use-pipeline";
import type { AIProviderSettings } from "../ir/ai";
import { XRViewerAnchor, PreviewFieldOfView, AxisLook } from "./scene/camera";
import { ReferenceFrameGroup, XRSceneGraph } from "./scene/scene-graph";
import { Minimap } from "./scene/minimap";
import { TransitionMark } from "./scene/transition";
import { ROOM_EYE_HEIGHT } from "./page-placements";
import { SR_ONLY } from "../components/a11y";
import { VRButton, styles } from "./scene/chrome";

export { FontContext } from "./scene/contexts";

export type XRDeviceType = "QUEST_3";

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
/**
 * `wall` hangs its link strips off the edges of the open page
 * (docs/directional-links.md, Phase 5), which is 90° of arc once the page is
 * at full size. In a headset the reader glances up or sideways and the doors
 * are there; in the flat preview there is no head to turn, so a 60° lens crops
 * away exactly the thing the strips exist to show and the wall looks like it
 * has no links at all. A wide lens here is the preview standing in for a neck,
 * which is the same job ROOMS_PREVIEW_FOV already does.
 */
const WALL_PREVIEW_FOV = 100;

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
   * Layer 3 (AI fallback) provider config, chosen on the Home screen. Omitted
   * or unconfigured means the parser keeps its stub provider — the pipeline
   * runs exactly as it does today and nothing leaves the browser.
   */
  aiSettings?: AIProviderSettings | null;
  /**
   * Spatial arrangement to present the page in. Selected on the Home screen
   * (see HomeSettings.viewMode) — the viewer itself offers no switcher.
   */
  viewMode?: ViewMode;
  onPlanReady?: (plan: LayoutPlan) => void;
  /** Called when a non-anchor link is clicked; defaults to window.open if omitted. */
  onExternalNavigate?: (href: string) => void;
  /**
   * Directional-link navigation (docs/directional-links.md). A door, stair,
   * strip or path hands back the destination AND the axis it was taken in, so
   * navigation memory can reserve the way back. Navigates IN PLACE — a
   * corridor is one reading session, so a tab per door would leave every
   * document with a fresh memory and no corridor to walk back down.
   */
  onTraverse?: (url: string, axis: Axis, label?: string) => void;
  /** The reserved back door every floor, face and table carries. */
  onTraverseBack?: () => void;
  /** A minimap selection: move the world to a node the reader has visited. */
  onTraverseJump?: (historyIndex: number) => void;
  /** Where this tab's reader has been. Null before the first document loads. */
  nav?: NavState | null;
  /**
   * A directional move in flight. The document on screen stays on screen; this
   * is what lets every view say that a move is under way rather than handing
   * the reader a blank canvas and a spinner.
   */
  pending?: { url: string; axis: Axis | null } | null;
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
  fontType = undefined,
  parserConfig = {},
  parserBackend = "custom",
  aiSettings = null,
  viewMode,
  onPlanReady,
  onExternalNavigate,
  onTraverse,
  onTraverseBack,
  onTraverseJump,
  nav = null,
  pending = null,
  theme = DARK_THEME,
  tabs,
  activeTabId,
  onSwitchTab,
  onCloseTab,
  onNewTab,
}: XRSceneRendererProps) {
  // 1. Resolve Device Profile locally
  const deviceProfile = QUEST_3_PROFILE;

  // Every view routes through the arrangement path: the spatial distribution
  // composes over whatever content template the scene auto-selects, so there
  // is no per-view template override left to make.
  const arrangement = useMemo(() => getArrangement(viewMode), [viewMode]);

  const {
    scene,
    plan,
    error: pipelineError,
    backendLabel,
    aiReport,
  } = usePipeline(
    html,
    sceneIn,
    url,
    deviceProfile,
    {
      ...layoutConfig,
      // sectionStartsOnNewPage: false,
    },
    parserConfig,
    parserBackend,
    arrangement,
    aiSettings ?? null,
  );

  const {
    store: xrStore,
    sessionState,
    capabilities,
    enterVR,
    exitVR,
    error: xrError,
  } = useXRSession();

  // What happened the last time the reader pressed Enter VR. Nothing until they
  // do; after that it stays on screen through the session and past its end,
  // which is the only moment a headset reader can read it.
  const xrDiag = useSyncExternalStore(
    subscribeXRDiagnostics,
    getXRDiagnostics,
    getXRDiagnostics,
  );
  const xrDiagLine = formatXRDiagnostics(xrDiag);

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

  // Centre of the main content panel, in world space. This is what the headset
  // should be levelled with in XR — the immersive counterpart of `readingLook`,
  // which aims the flat preview's OrbitControls at the same point. Panels are
  // top-left anchored, so the centre is half a viewport below the panel's top.
  /**
   * Where in the document the reader is, for the screen-reader description.
   *
   * Every view spatialises the same paginated panel, so this is the one fact
   * that is true in all of them: which page of how many is focused, and which
   * section it belongs to.
   */
  const reading = useMemo(() => {
    if (!plan || !mainPanelId) return null;
    const e = plan.entries[mainPanelId];
    if (!e) return null;
    const pageCount = e.pagination?.pageCount ?? 1;
    const page = Math.min(
      pageState[mainPanelId] ?? 0,
      Math.max(0, pageCount - 1),
    );
    return { pageCount, page, sectionRanges: sectionRangesFor(plan, pageCount) };
  }, [plan, mainPanelId, pageState]);

  /** Accessible name for the scene region, and its live description. */
  const sceneLabel = useMemo(() => {
    const where = url ? ` of ${url}` : "";
    return `3D spatial view${where}, ${viewMode ?? "rooms"} arrangement`;
  }, [url, viewMode]);

  const sceneDescription = useMemo(() => {
    if (!reading) return "";
    const { pageCount, page, sectionRanges } = reading;
    const i = sectionRanges.findIndex((r) => page >= r.start && page <= r.end);
    const section = i >= 0 ? sectionRanges[i].label : null;
    return [
      section ? `Section: ${section}.` : null,
      pageCount > 1 ? `Page ${page + 1} of ${pageCount}.` : null,
    ]
      .filter(Boolean)
      .join(" ");
  }, [reading]);

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
   * The rooms view's standing point in world space — where the reader stands.
   *
   * `rooms` carries the whole building so the reader's pose lands here, and
   * turning (Q/E) spins the building about the vertical line through it. The
   * default preview rig orbits the camera around the main panel's CENTRE —
   * one reading distance in front of this — so the first drag took the eye
   * off the line the building turns about. From there, every turn swung the
   * camera on a circle around a point it was no longer standing on, straight
   * out through the walls: the reader had not moved, but the view had.
   *
   * Fixing the ease in RoomWalk (which had the same shape of bug, in the
   * carrier rather than the camera) was necessary and not sufficient. This is
   * the other half.
   *
   * This — not the panel's centre — is what both the headset and the flat
   * preview are put on: standing anywhere else is standing outside your own
   * building.
   */
  const roomsAxis = useMemo((): [number, number, number] | null => {
    if (viewMode !== "rooms") return null;
    const e = mainPanelId ? plan?.entries[mainPanelId] : null;
    if (!e || !plan) return null;
    return [
      e.position.x + e.size.width / 2,
      // Standing eye height, measured from the FLOOR (which this view puts at
      // world y = 0) rather than offset from the panel slot. The pages hang
      // to a gallery centre line now, not to that slot, so the eye belongs on
      // the same absolute line they do — see ROOM_HANG_CENTRE.
      ROOM_EYE_HEIGHT,
      e.position.z + plan.config.viewingDistance,
    ];
  }, [viewMode, mainPanelId, plan]);

  /**
   * The view where the reader stands INSIDE what they are reading, and the
   * camera therefore rotates in place instead of orbiting something.
   */
  const standingAxis = roomsAxis;

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

  return (
    <div style={{ ...styles.root, width, height: "auto" }}>
      {/* A failed parse is reported over the scene, not instead of it. This
          used to be an early return, which unmounted the <Canvas> below and
          took its WebGL context with it — while any immersive XRSession, owned
          by the browser rather than by React, kept requesting frames against
          the dead context. Everything downstream of the plan already handles
          plan === null, so the canvas can stay up and hold the session. */}
      {pipelineError && (
        <div
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            right: 0,
            zIndex: 10000,
            color: "#ff6b6b",
            background: "rgba(8, 14, 24, 0.92)",
            padding: "0.75rem 1rem",
            fontFamily: "monospace",
            fontSize: 12,
          }}
        >
          Pipeline error: {pipelineError}
        </div>
      )}
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
          </>
        )}
        {/* Layer 3 only ever runs when the reader configured a provider, and
            when it does they are spending their own quota on it — so what it
            asked for, what came back, and what failed is reported rather than
            left to the console. */}
        {aiReport && aiReport.requested > 0 && (
          <>
            <span style={{ opacity: 0.4 }}> · </span>
            <span
              style={{
                color: aiReport.errors.length > 0 ? "#f6a623" : "#8b949e",
              }}
              title={
                aiReport.errors.length > 0
                  ? aiReport.errors.join("\n")
                  : `${aiReport.chunks} request${aiReport.chunks === 1 ? "" : "s"}`
              }
            >
              AI {aiReport.answered}/{aiReport.requested} in {aiReport.chunks}{" "}
              call
              {aiReport.chunks === 1 ? "" : "s"} ·{" "}
              {(aiReport.elapsedMs / 1000).toFixed(1)}s
              {aiReport.errors.length > 0 ? " · failed" : ""}
            </span>
          </>
        )}
        {xrDiagLine && (
          <>
            <span style={{ opacity: 0.4 }}> · </span>
            <span
              style={{ color: xrDiag.errorCount > 0 ? "#f6a623" : "#8b949e" }}
              title="Frames the WebXR runtime asked for vs frames we drew. 0 drawn means the headset is holding a session it is never shown anything through."
            >
              {xrDiagLine}
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
          reader was a blank element. This is the same "where am I" a sighted
          reader gets from the field itself, in the accessibility tree, and it
          is announced politely as the page turns
          rather than interrupting. It is a description of the view, not a
          replacement for it: the links and controls inside the scene are
          still canvas-drawn and remain out of reach, which is a larger piece
          of work than a label. */}
      <div role="status" aria-live="polite" aria-atomic="true" style={SR_ONLY}>
        {sceneDescription}
      </div>

      <div
        style={{ width, height, position: "relative" }}
        role="region"
        aria-label={sceneLabel}
      >
        {/* ── Live panel tuning HUD (flat preview only) ───────────── */}

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
            // The frustum has to hold a BUILDING, not a panel. `rooms` lays
            // one room per section down a single enfilade, so a long document
            // is a long corridor — a hundred-page one runs to about 175 m —
            // and at the old far plane of 100 the end of it was simply cut off
            // and painted the clear colour. Down a straight corridor that
            // reads as the world stopping in mid-air.
            //
            // The near plane pays for it. 0.01 m spent depth precision on
            // nothing (the closest thing a reader ever gets to is a controller
            // in their own hand), and near/far is what depth precision is
            // mostly made of: 0.05/250 is a tighter ratio than 0.01/100 was, so
            // the longer view costs no z-fighting.
            near: 0.05,
            far: 250,
          }}
          gl={{
            antialias: true,
            alpha: false,
          }}
          onCreated={({ gl }) => {
            gl.localClippingEnabled = true;
            gl.xr.enabled = true;
            // A lost context is silent: three logs one line, every draw after it
            // is a no-op, and an immersive session goes on requesting frames
            // that can never be filled — which the headset shows as its own
            // loading environment, indistinguishable from a hang. Seen on a
            // Quest 3 with a second WebGL page open in another tab; the browser
            // reclaims contexts and the background one loses. Record it and get
            // the reader out rather than leaving them in a grey room.
            gl.domElement.addEventListener("webglcontextlost", () => {
              console.error(
                "[xr] WebGL context lost — nothing can be drawn until it is " +
                  "restored. Another WebGL page in a second tab is the usual cause.",
              );
              gl.xr
                .getSession()
                ?.end()
                .catch(() => {});
            });
          }}
        >
          {/* <XR> binds the session to the renderer and mounts the
              controllers/hands whose pointers drive the same onClick /
              onPointerOver handlers the mouse uses in the flat preview.

              It sits ABOVE the scene's Suspense boundary, not inside it. <XR>
              hands three's WebXRManager to the store during its own render, and
              that binding is what a session is entered through — so with the
              boundary on the outside, anything in the scene that suspends (the
              environment map, a texture) took the session binding and the whole
              render loop down with it. A reader who pressed Enter VR in that
              window got a session the app then never drew a single frame for,
              which is precisely the state the headset's loading environment
              stays up for. Suspense now wraps only the content, so the session,
              the controllers and the frame loop survive an asset that is slow
              or never arrives. */}
          <XR store={xrStore}>
            {/* Outside the boundary below: counts frames we really rendered,
                even while the content is suspended. */}
            <XRFrameProbe />
            <Suspense fallback={null}>
              {/* Level the headset with the content panel's centre. Only for the
                  "world" frame: body/head/hand frames already carry the scene
                  with the viewer, and their entries aren't world-space, so
                  there'd be nothing static to recentre against. */}
              {/* Rooms recentres on its own standing point: the reader is in
                  a building with a floor, and levelling the headset with the
                  panel slot would stand them 0.95 m tall in it. */}
              <XRViewerAnchor
                target={
                  (plan?.referenceFrame ?? "world") === "world"
                    ? (standingAxis ?? xrLevel)
                    : null
                }
                // The standing view places the eye in all three axes: its
                // geometry is built about one point and means nothing anywhere
                // else. See XRViewerAnchor — leaving z alone there is what put
                // readers inside the gallery's walls.
                standing={!!standingAxis}
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
                      : viewMode === "wall"
                        ? WALL_PREVIEW_FOV
                        : DEFAULT_PREVIEW_FOV
                }
              />
              {viewMode === "rooms" ? (
                /* A gallery is a BRIGHT room. The fittings in the building
                   (see scene/room-decor.tsx) give it pools and direction;
                   this is the light bouncing round a white box, and it has
                   to be generous — cut too far back, the rooms read as a
                   basement corridor at night rather than somewhere you would
                   want to stand and read. Warm from above, floor-bounce from
                   below. No environment map: a city HDR both flattens the
                   fittings' pools and, offline, never loads at all. */
                <>
                  <ambientLight intensity={0.78} color="#F6F3ED" />
                  <hemisphereLight
                    intensity={0.66}
                    color="#FFF6E9"
                    // The bounce off the floor, which is now pale oak rather
                    // than khaki stone — a cool-grey ground term under a warm
                    // wood floor is what tips the whole room sallow.
                    groundColor="#D8C4A6"
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
                  {/* Its own boundary: <Environment preset> suspends on an
                      HDR fetched from a third-party CDN
                      (raw.githack.com, via drei's useEnvironment), and on a
                      headset that is a link the app cannot assume. Isolated
                      here, a slow or dead CDN costs the reflections and
                      nothing else; shared with the scene, it cost the scene. */}
                  <Suspense fallback={null}>
                    <Environment preset="city" />
                  </Suspense>
                </>
              )}

              <RenderMetricsContext.Provider
                value={deviceProfile.renderMetrics}
              >
                <ThemeContext.Provider value={theme}>
                  <FontContext.Provider value={fontType}>
                    {/* Web2VR backend: CSS layout extracted from hidden iframe → 3D */}

                    {parserBackend !== "web2vr" && scene && plan && (
                      <ReferenceFrameGroup
                        frame={plan.referenceFrame ?? "world"}
                      >
                        <XRSceneGraph
                          scene={scene}
                          plan={plan}
                          pageState={pageState}
                          setPage={setPage}
                          onExternalNavigate={onExternalNavigate}
                          onTraverse={onTraverse}
                          onTraverseBack={onTraverseBack}
                          onTraverseJump={onTraverseJump}
                          nav={nav}
                          pending={pending}
                          sourceUrl={url}
                        />
                      </ReferenceFrameGroup>
                    )}

                    {/* The travelled graph, in a corner of every view.
                        Mounted HERE and not inside <ReferenceFrameGroup>: it
                        anchors to the head in world space, and a reference
                        frame that translates or rotates the scene would carry
                        the panel off with it — the one surface that must stay
                        true would be the one drawn in the wrong place. */}
                    <Minimap
                      nav={nav}
                      viewMode={viewMode}
                      onJump={onTraverseJump}
                    />

                    {/* "You are moving." Head-anchored beside the minimap and
                        mounted OUTSIDE <ReferenceFrameGroup> for the same
                        reason: it must not travel with the world it is
                        reporting on. Every view gets it for free, on top of
                        whatever its own geometry is doing. */}
                    <TransitionMark pending={pending} />

                    {/* ── In-world browser chrome (replaces HTML overlays) ────
                      Tab switcher, horizontally centred on the content panel
                      and pulled forward of it (parallax separation). The view
                      picker is not here: the arrangement is chosen on the Home
                      screen and is fixed for the loaded page.

                      `rooms` is suppressed entirely — there the reader walks a
                      building rather than sitting at a panel, so a bar welded
                      under the main page would follow them into every room and
                      float loose in the middle of the space. */}
                    {
                      viewMode !== "rooms" &&
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
                          // clicks a spot, which it cannot do without them.
                          makeDefault
                          // In rooms AxisLook owns the pivot — it sits a
                          // centimetre ahead of the eye, not on the axis
                          // itself, and two effects writing the same target
                          // would race.
                          target={
                            standingAxis ? undefined : (deckLook ?? readingLook)
                          }
                          // In rooms the reader is INSIDE the scene: dragging
                          // turns the head (AxisLook parks the pivot a
                          // centimetre ahead of the eye) and there is nowhere
                          // to pan or dolly to — the view is built around one
                          // standing point, and the reader moves off it by
                          // WALKING, not by dragging.
                          enablePan={!standingAxis}
                          enableZoom={!standingAxis}
                          minDistance={standingAxis ? 0.01 : 0}
                          maxDistance={standingAxis ? 0.01 : Infinity}
                          // Rooms only: a reader on their feet in a building
                          // has a neck, not a gimbal. With the pivot at the
                          // eye, a drag that runs past straight up carries
                          // the view over the top and lands it upside down in
                          // the floor, with no horizon left to recover by.
                          minPolarAngle={roomsAxis ? 0.35 : 0}
                          maxPolarAngle={roomsAxis ? Math.PI - 0.35 : Math.PI}
                          enableDamping
                          dampingFactor={0.08}
                        />
                        <AxisLook axis={standingAxis} />
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
            </Suspense>
          </XR>
        </Canvas>
      </div>
    </div>
  );
}
