/**
 * primitives.tsx
 *
 * Core XR primitive React Three Fiber components.
 *
 * Rendered primitives (Phase 4 scope — extend in Phase 5+):
 *   XRHeadingMesh     — floating text billboard, level-aware scale
 *   XRParagraphMesh   — multi-line text on a frosted panel
 *   XRSectionMesh     — translucent bounding volume + title bar
 *   XRNavigationMesh  — arc-curved strip of link chips
 *   XRMediaMesh       — video/audio player panel
 *
 * Design decisions
 * ────────────────
 * • All geometry is in metres (WebXR coordinate system).
 * • Text is rendered via @react-three/drei <Text> (troika-three-text),
 *   which handles word-wrap and GPU SDF text natively in WebGL/XR.
 * • Panels use <RoundedBox> from drei for soft-edged frosted glass
 *   aesthetics that read well in both inline preview and headset.
 * • Every primitive receives its resolved position/size from LayoutEntry
 *   (not from SpatialPlacement) — the renderer always applies the plan.
 * • Components are intentionally stateless. Interaction state (hover,
 *   focus, selected) is managed by the parent XRSceneRenderer via a
 *   shared context and passed down as props.
 *
 * Colour system
 * ─────────────
 * XR palette optimised for dark environments (headset passthrough off):
 *   panel bg    #0d1117  (deep navy — reduces eye strain)
 *   panel rim   #1e2d3d  (subtle border)
 *   heading     #e6f1ff  (near-white, high contrast)
 *   body        #a8b8cc  (muted blue-white)
 *   accent      #58a6ff  (GitHub-blue — navigation, interactive)
 *   media bg    #0a0e14  (nearly black behind video)
 *   nav bg      #111927  (darker than panel)
 */

import React, { useRef, useContext, createContext } from "react";
import { Text, RoundedBox, Html } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { useTexture } from "@react-three/drei";

// ─────────────────────────────────────────────────────────────
// Panel clipping context
// ─────────────────────────────────────────────────────────────

/**
 * Provides THREE.Plane clipping planes to all descendant mesh materials.
 *
 * Set by XRContentPanel (and XRSectionMesh when it acts as a viewport)
 * to clip child geometry that would overflow the panel boundary.
 *
 * The planes are in WORLD space — Three.js applies them after the model
 * matrix transform, so the panel's own world position must be factored in
 * by the provider (see XRSceneRenderer: buildPanelClipPlanes).
 *
 * An empty array means "no clipping active" (default).
 */
export const ClipPlanesContext = createContext<THREE.Plane[]>([]);

/** Convenience hook — returns the current clip planes (may be empty). */
export function useClipPlanes(): THREE.Plane[] {
  return useContext(ClipPlanesContext);
}

import type {
  XRHeading,
  XRParagraph,
  XRSection,
  XRNavigationBar,
  XRMediaPlayer,
  XRLink,
} from "../mapper/types";
import type { LayoutEntry } from "../layout/types";
import { CurrentPageContext, FontContext } from "./XRSceneRenderer";

// ─────────────────────────────────────────────────────────────
// Shared constants
// ─────────────────────────────────────────────────────────────

const PANEL_RADIUS = 0.012; // RoundedBox corner radius (m)
// PANEL_DEPTH must satisfy: PANEL_DEPTH > 2 * PANEL_RADIUS (drei constraint)
// 0.012 * 2 = 0.024, so 0.03 gives comfortable clearance.
const PANEL_DEPTH = 0.03;
const PANEL_BG = "#0d1117";
const PANEL_RIM = "#1e2d3d";
const HEADING_COL = "#e6f1ff";
const BODY_COL = "#a8b8cc";
const ACCENT_COL = "#58a6ff";
const NAV_BG = "#111927";
const MEDIA_BG = "#0a0e14";

// RIM is a thin decorative strip — use its own radius that fits within its depth.
const RIM_DEPTH = 0.004;
const RIM_RADIUS = 0.001; // must be < RIM_DEPTH / 2 = 0.002

// RoundedBox requires radius < min(w, h, depth) / 2 across ALL three dimensions.
// Use MIN_DIM as the floor for w/h, and safeRadius() to clamp any per-call radius.
const MIN_DIM = PANEL_RADIUS * 2 + 0.001; // 0.025 m — safe floor for w and h

/** Clamp a layout dimension to a safe minimum for RoundedBox. */
function safeDim(v: number): number {
  return Number.isFinite(v) && v > MIN_DIM ? v : MIN_DIM;
}

/**
 * Compute the largest radius that satisfies the drei RoundedBox constraint
 * radius < min(w, h, depth) / 2 for all three box dimensions.
 * Caps at the requested `desiredRadius` and floors at 0.001.
 */
function safeRadius(
  desiredRadius: number,
  w: number,
  h: number,
  depth: number,
): number {
  const maxAllowed = Math.min(w, h, depth) / 2 - 0.0001;
  return Math.max(0.001, Math.min(desiredRadius, maxAllowed));
}

// ─────────────────────────────────────────────────────────────
// Utility
// ─────────────────────────────────────────────────────────────

/**
 * Convert a LayoutEntry into a Three.js position and Euler rotation.
 * All values are already in metres from the layout engine.
 */
function entryTransform(entry: LayoutEntry) {
  const pos = new THREE.Vector3(
    entry.position.x,
    entry.position.y,
    entry.position.z,
  );
  const rot = new THREE.Euler(
    entry.rotation.x,
    entry.rotation.y,
    entry.rotation.z,
    "XYZ",
  );
  return { pos, rot };
}

/**
 * Heading-level to font size (metres).
 * Chosen so that each level is clearly distinguishable at 1.2 m.
 */
function headingFontSize(level: number): number {
  return [0, 0.068, 0.056, 0.046, 0.038, 0.032, 0.028][level] ?? 0.038;
}

/**
 * Heading-level to font weight string for troika-three-text.
 */
function headingWeight(level: number): string {
  return level <= 2 ? "700" : level <= 4 ? "600" : "500";
}

// ─────────────────────────────────────────────────────────────
// Shared hover hook — gentle scale pulse on pointer-over
// ─────────────────────────────────────────────────────────────

function useHoverScale(baseScale = 1.0, hoverScale = 1.015) {
  const ref = useRef<THREE.Group>(null);
  const hovering = useRef(false);
  const current = useRef(baseScale);

  useFrame((_, delta) => {
    if (!ref.current) return;
    const target = hovering.current ? hoverScale : baseScale;
    current.current = THREE.MathUtils.lerp(
      current.current,
      target,
      Math.min(1, delta * 8),
    );
    ref.current.scale.setScalar(current.current);
  });

  const handlers = {
    onPointerOver: () => {
      hovering.current = true;
    },
    onPointerOut: () => {
      hovering.current = false;
    },
  };

  return { ref, handlers };
}

// ─────────────────────────────────────────────────────────────
// ClippedText — troika Text with clipping plane support
// ─────────────────────────────────────────────────────────────

/**
 * Drop-in wrapper around drei <Text> that applies the current ClipPlanesContext
 * to the troika mesh material via onSync.
 *
 * Troika manages its own MeshStandardMaterial internally, so passing
 * clippingPlanes as a JSX prop to a <meshStandardMaterial> child has no effect.
 * The onSync callback fires after troika has built/updated the text mesh and
 * its material, giving us a stable hook to inject clippingPlanes imperatively.
 *
 * All props are forwarded to <Text> transparently.
 */
type TextProps = React.ComponentPropsWithoutRef<typeof Text>;

export function ClippedText(props: TextProps) {
  // const clips = useClipPlanes();

  const fontType = useContext(FontContext);

  const handleSync = React.useCallback(
    (mesh: THREE.Mesh) => {
      if (!mesh) return;
      const mat = mesh.material as THREE.Material & {
        clippingPlanes?: THREE.Plane[] | null;
      };
      if (mat) {
        // mat.clippingPlanes = clips.length > 0 ? clips : null;
        mat.clippingPlanes = null;
        mat.needsUpdate = true;
      }
      // Also propagate to the onSync the caller may have passed
      if (typeof props.onSync === "function") {
        props.onSync(mesh);
      }
    },
    // clips array reference changes when planes change; stringify for comparison
    // eslint-disable-next-line react-hooks/exhaustive-deps
    // [clips, props.onSync],
    [props.onSync],
  );

  return <Text {...props} font={fontType} onSync={handleSync} />;
}

// ─────────────────────────────────────────────────────────────
// 1. XRHeadingMesh
// ─────────────────────────────────────────────────────────────

export interface XRHeadingMeshProps {
  primitive: XRHeading;
  entry: LayoutEntry;
  renderChild: (primitiveId: string) => React.ReactNode;
}

/**
 * Floating text billboard for headings.
 *
 * Renders the heading as a world-space troika Text node with no backing panel
 * for H1–H2 (they stand alone as large anchors) and a subtle underline
 * accent bar for H3–H6.
 *
 * The text is anchored top-left so vertical stacking from the layout engine
 * is consistent: position.y is the top edge of the text.
 */
export function XRHeadingMesh({
  primitive,
  entry,
  renderChild,
}: XRHeadingMeshProps) {
  const { pos, rot } = entryTransform(entry);
  const clips = useClipPlanes();
  const fontSize = headingFontSize(primitive.level);
  const showAccent = primitive.level >= 3;

  const hasTextChildren = primitive.children.some(
    (child) =>
      child.type === "XRText" ||
      child.type === "XRLink" ||
      child.type === "XRButton",
  );
  if (hasTextChildren)
    return (
      <group position={pos} rotation={rot}>
        <group position={[0, 0, 0]}>
          {primitive.children.map((child) => renderChild(child.id))}
        </group>
      </group>
    );

  return (
    <group position={pos} rotation={rot}>
      <ClippedText
        anchorX="left"
        anchorY="top"
        position={[0, 0, 0.001]}
        fontSize={fontSize}
        color={HEADING_COL}
        font={undefined} // uses troika default (Roboto) — swap in Phase 5
        fontWeight={headingWeight(primitive.level)}
        maxWidth={entry.size.width}
        lineHeight={1.2}
        letterSpacing={-0.01}
        outlineWidth={0}
      >
        {primitive.content ?? primitive.label ?? ""}
      </ClippedText>

      {/* Accent underline for H3+ */}
      {showAccent && (
        <mesh position={[entry.size.width * 0.5, -fontSize * 1.35, 0]}>
          <planeGeometry args={[entry.size.width, 0.002]} />
          <meshBasicMaterial
            color={ACCENT_COL}
            transparent
            opacity={0.5}
            clippingPlanes={clips}
          />
        </mesh>
      )}
      {primitive.children.map((child) => renderChild(child.id))}
    </group>
  );
}

// ─────────────────────────────────────────────────────────────
// 2. XRParagraphMesh
// ─────────────────────────────────────────────────────────────

export interface XRParagraphMeshProps {
  primitive: XRParagraph;
  entry: LayoutEntry;
  renderChild: (primitiveId: string) => React.ReactNode;
}

/**
 * Multi-line body text rendered on a frosted-glass panel.
 *
 * Dense paragraphs (densityScore > 0.6) receive a slightly larger panel
 * with a faint top-edge glow to signal long-form reading mode.
 * Short snippets (≤ 10 words) skip the backing panel entirely.
 */
export function XRParagraphMesh({
  primitive,
  entry,
  renderChild,
}: XRParagraphMeshProps) {
  const { pos, rot } = entryTransform(entry);
  const clips = useClipPlanes();
  const dense = primitive.densityScore > 0.6;
  const w = safeDim(entry.size.width);
  const h = safeDim(entry.size.height);

  const hasTextChildren = primitive.children.some(
    (child) =>
      child.type === "XRText" ||
      child.type === "XRLink" ||
      child.type === "XRButton",
  );

  // If it has text children, render them inline without a backing panel
  // The children themselves are the content
  if (hasTextChildren) {
    return (
      <group position={pos} rotation={rot}>
        {/* No backing panel - children render inline */}
        <group position={[0, 0, 0]}>
          {primitive.children.map((child) => renderChild(child.id))}
        </group>
      </group>
    );
  }

  const skipPanel = primitive.wordCount <= 10;

  return (
    <group position={pos} rotation={rot}>
      {/* Backing panel */}
      {!skipPanel && (
        <RoundedBox
          args={[w, h, PANEL_DEPTH]}
          radius={PANEL_RADIUS}
          position={[w / 2, -h / 2, -PANEL_DEPTH / 2]}
        >
          <meshStandardMaterial
            color={PANEL_BG}
            transparent
            opacity={dense ? 0.82 : 0.68}
            roughness={0.9}
            metalness={0.05}
            clippingPlanes={clips}
          />
        </RoundedBox>
      )}

      {/* Dense glow strip */}
      {dense && (
        <mesh position={[w / 2, -0.001, 0]}>
          <planeGeometry args={[w, 0.003]} />
          <meshBasicMaterial
            color={ACCENT_COL}
            transparent
            opacity={0.3}
            clippingPlanes={clips}
          />
        </mesh>
      )}

      {/* Body text - only render content directly if no text children */}
      <ClippedText
        anchorX="left"
        anchorY="top"
        position={[0.02, -0.018, PANEL_DEPTH * 0.6]}
        fontSize={0.026}
        color={BODY_COL}
        maxWidth={w - 0.04}
        lineHeight={1.55}
        letterSpacing={0.005}
      >
        {primitive.content ?? primitive.label ?? ""}
      </ClippedText>

      {/* Any non-text children (images, lists, etc.) */}
      {primitive.children.map((child) => renderChild(child.id))}
    </group>
  );
}

// ─────────────────────────────────────────────────────────────
// 3. XRSectionMesh
// ─────────────────────────────────────────────────────────────

export interface XRSectionMeshProps {
  primitive: XRSection;
  entry: LayoutEntry;
  /**
   * Resolved child entries for the children visible on the current page.
   * The renderer passes only entries whose pageIndex matches the current page
   * (or all entries when the section fits on one page). Used solely to compute
   * the correct backing panel height — the section must not be taller than
   * its visible content.
   */
  childEntries: LayoutEntry[];
  /** Renderer for child primitives — injected by XRSceneRenderer. */
  renderChild: (primitiveId: string) => React.ReactNode;
  /**
   * True when this section is a mid-section continuation (its first child is
   * on a later page index than the section itself). Drives the top-edge
   * "continued from" accent stripe.
   */
  isContinuation?: boolean;
  /**
   * True when this section overflows onto a subsequent page. Drives the
   * bottom-edge "continues on" accent stripe.
   */
  hasMore?: boolean;
}

/**
 * Translucent bounding panel for a section.
 *
 * Purely a spatial container: draws a frosted backing panel sized to the
 * visible child content and delegates all child rendering to the injected
 * renderChild. Child positions are resolved by the layout engine; this
 * component does not re-layout them.
 *
 * Panel height is derived from childEntries (the current page's visible
 * children) rather than entry.size.height, because entry.size.height is
 * the full section height across all pages. The renderer passes only the
 * entries whose pageIndex matches the current page.
 *
 * Continuation indicators (thin accent stripes) are shown at the top/bottom
 * edges when the section spans multiple pages, driven by the isContinuation
 * and hasMore props computed by the renderer.
 */
export function XRSectionMesh({
  primitive,
  entry,
  childEntries,
  renderChild,
  isContinuation,
  hasMore,
}: XRSectionMeshProps) {
  const { pos, rot } = entryTransform(entry);
  const clips = useClipPlanes();
  const w = safeDim(entry.size.width);

  // Panel height = sum of visible child heights + gaps + top/bottom padding.
  // We sum rather than using position.y so this is correct regardless of how
  // the engine positions children within the section.
  const PAD = 0.04; // panelPaddingTop — matches DEFAULT_LAYOUT_CONFIG
  const GAP = 0.02; // childGapY
  const visibleHeight =
    childEntries.length > 0
      ? PAD +
        childEntries.reduce((sum, ce) => sum + ce.size.height, 0) +
        GAP * Math.max(0, childEntries.length - 1) +
        PAD
      : entry.size.height;

  const h = safeDim(visibleHeight);

  return (
    <group position={pos} rotation={rot}>
      {/* Section backing panel — sized to the visible slice */}
      <RoundedBox
        args={[w, h, PANEL_DEPTH]}
        radius={PANEL_RADIUS}
        position={[w / 2, -h / 2, -PANEL_DEPTH]}
      >
        <meshStandardMaterial
          color={PANEL_BG}
          transparent
          opacity={0.55}
          roughness={0.95}
          clippingPlanes={clips}
        />
      </RoundedBox>

      {/* Rim border */}
      <RoundedBox
        args={[w, h, RIM_DEPTH]}
        radius={RIM_RADIUS}
        position={[w / 2, -h / 2, -PANEL_DEPTH - RIM_DEPTH / 2]}
      >
        <meshBasicMaterial
          color={PANEL_RIM}
          transparent
          opacity={0.7}
          clippingPlanes={clips}
        />
      </RoundedBox>

      {/* "Continued from previous page" top edge indicator */}
      {isContinuation && (
        <mesh position={[w / 2, -0.001, 0.001]}>
          <planeGeometry args={[w * 0.4, 0.003]} />
          <meshBasicMaterial
            color={ACCENT_COL}
            transparent
            opacity={0.45}
            clippingPlanes={clips}
          />
        </mesh>
      )}

      {primitive.children.map((child) => renderChild(child.id))}
    </group>
  );
}

// ─────────────────────────────────────────────────────────────
// 4. XRNavigationMesh
// ─────────────────────────────────────────────────────────────

export interface XRNavigationMeshProps {
  primitive: XRNavigationBar;
  entry: LayoutEntry;
}

/**
 * Arc-curved navigation strip or vertical TOC panel.
 *
 * Layout mode is selected by aspect ratio:
 *   tall + narrow (height > width)  → vertical TOC list with depth indentation
 *   wide + short  (width >= height) → horizontal arc chip strip (site nav)
 *
 * TOC items use item.depth for left-indent so h1/h2 are flush and h3+
 * are progressively indented — matching the dummy-layout TOC behaviour.
 */
export function XRNavigationMesh({ primitive, entry }: XRNavigationMeshProps) {
  const { pos, rot } = entryTransform(entry);
  const clips = useClipPlanes();
  const items: XRLink[] = primitive.items ?? [];
  const w = safeDim(entry.size.width);
  const h = safeDim(entry.size.height);

  const isTOC = h > w;

  // ── Vertical TOC layout ──────────────────────────────────────────────────
  if (isTOC) {
    const ITEM_H = 0.052;
    const ITEM_GAP = 0.006;
    const INDENT_STEP = 0.018; // metres per depth level
    const PADDING = 0.014;

    return (
      <group position={pos} rotation={rot}>
        {/* Panel backing */}
        <RoundedBox
          args={[w, h, PANEL_DEPTH]}
          radius={PANEL_RADIUS}
          position={[w / 2, -h / 2, -PANEL_DEPTH]}
        >
          <meshStandardMaterial
            color={NAV_BG}
            transparent
            opacity={0.88}
            roughness={0.85}
            clippingPlanes={clips}
          />
        </RoundedBox>

        {/* Panel label */}
        <ClippedText
          anchorX="left"
          anchorY="top"
          position={[PADDING, -PADDING, PANEL_DEPTH]}
          fontSize={0.014}
          color="#4a5568"
          fontWeight="700"
          letterSpacing={0.08}
        >
          {(primitive.label ?? "Contents").toUpperCase()}
        </ClippedText>

        {/* TOC items — vertical stack */}
        {items.map((item, i) => {
          const itemY = -(PADDING * 3 + i * (ITEM_H + ITEM_GAP));
          const indent = PADDING + (item.depth ?? 0) * INDENT_STEP;
          const isCurrent = item.isCurrent;
          const itemW = w - indent - PADDING;

          return (
            <group
              key={item.id}
              position={[indent, itemY, PANEL_DEPTH * 0.5]}
              onClick={() => {
                if (item.href && typeof window !== "undefined") {
                  try {
                    const target = document.querySelector(item.href);
                    if (target) target.scrollIntoView({ behavior: "smooth" });
                  } catch (_) {}
                }
              }}
            >
              {/* Hit-area plane for easier pointing */}
              <mesh position={[itemW / 2, -ITEM_H / 2, -0.001]}>
                <planeGeometry args={[itemW, ITEM_H]} />
                <meshBasicMaterial
                  transparent
                  opacity={0}
                  clippingPlanes={clips}
                />
              </mesh>

              {/* Active accent bar */}
              {isCurrent && (
                <mesh position={[-0.006, -ITEM_H / 2, 0.001]}>
                  <planeGeometry args={[0.003, ITEM_H * 0.7]} />
                  <meshBasicMaterial
                    color={ACCENT_COL}
                    clippingPlanes={clips}
                  />
                </mesh>
              )}
              <ClippedText
                anchorX="left"
                anchorY="top"
                position={[0, 0, 0.002]}
                fontSize={item.depth === 0 ? 0.022 : 0.018}
                color={
                  isCurrent
                    ? ACCENT_COL
                    : item.depth === 0
                      ? "#c9d8ec"
                      : BODY_COL
                }
                fontWeight={item.depth === 0 ? "600" : "400"}
                maxWidth={itemW}
                lineHeight={1.3}
              >
                {item.label ?? ""}
              </ClippedText>
            </group>
          );
        })}
      </group>
    );
  }

  // ── Horizontal arc chip layout (site nav) ────────────────────────────────
  const CHIP_H = 0.048;
  const CHIP_GAP = 0.012;
  const chipW = Math.max(
    0.025,
    items.length > 0
      ? Math.min(0.28, (w - CHIP_GAP * (items.length + 1)) / items.length)
      : 0.24,
  );

  const arcTotal =
    entry.curveRadius > 0
      ? 2 * Math.asin(Math.min(1, w / (2 * entry.curveRadius)))
      : 0;
  const arcStep = items.length > 1 ? arcTotal / (items.length - 1) : 0;
  const arcStart = -arcTotal / 2;

  return (
    <group position={pos} rotation={rot}>
      {/* Nav panel backing */}
      <RoundedBox
        args={[w, h, PANEL_DEPTH]}
        radius={PANEL_RADIUS}
        position={[w / 2, -h / 2, -PANEL_DEPTH]}
      >
        <meshStandardMaterial
          color={NAV_BG}
          transparent
          opacity={0.88}
          roughness={0.85}
          clippingPlanes={clips}
        />
      </RoundedBox>

      {/* Nav chips */}
      {items.map((item, i) => {
        const chipAngle = arcStart + i * arcStep;
        const chipX =
          entry.curveRadius > 0
            ? entry.curveRadius * Math.sin(chipAngle)
            : CHIP_GAP + i * (chipW + CHIP_GAP);
        const chipZ =
          entry.curveRadius > 0
            ? entry.curveRadius * (1 - Math.cos(chipAngle))
            : 0;
        const isCurrent = item.isCurrent;

        return (
          <group
            key={item.id}
            position={[chipX, -h / 2, chipZ + PANEL_DEPTH * 0.5]}
            rotation={[0, -chipAngle, 0]}
          >
            <RoundedBox
              args={[chipW, CHIP_H, 0.008]}
              radius={safeRadius(CHIP_H / 2, chipW, CHIP_H, 0.008)}
            >
              <meshStandardMaterial
                color={isCurrent ? ACCENT_COL : "#1a2840"}
                transparent
                opacity={isCurrent ? 0.92 : 0.78}
                roughness={0.7}
                clippingPlanes={clips}
              />
            </RoundedBox>

            <ClippedText
              anchorX="center"
              anchorY="middle"
              position={[0, 0, 0.006]}
              fontSize={0.018}
              color={isCurrent ? "#ffffff" : BODY_COL}
              maxWidth={chipW - 0.016}
              fontWeight={isCurrent ? "600" : "400"}
            >
              {item.label ?? item.href ?? ""}
            </ClippedText>
          </group>
        );
      })}
    </group>
  );
}

// ─────────────────────────────────────────────────────────────
// 5. XRMediaMesh
// ─────────────────────────────────────────────────────────────

export interface XRMediaMeshProps {
  primitive: XRMediaPlayer;
  entry: LayoutEntry;
}

/**
 * Video / audio player panel.
 *
 * sizingStrategy drives the visual treatment:
 *   "large-panel"    — cinema-scale curved panel with a play icon overlay
 *   "compact-widget" — small audio widget with waveform placeholder
 *   "ambient"        — minimal placeholder (renderer positions it off-axis)
 *
 * For Phase 4 we render a placeholder panel with a play/audio icon and
 * the media label. Actual HTMLVideoElement → VideoTexture wiring is
 * deferred to Phase 5 (requires document.createElement in XR context).
 */
export function XRMediaMesh({ primitive, entry }: XRMediaMeshProps) {
  const { pos, rot } = entryTransform(entry);
  const clips = useClipPlanes();
  const w = safeDim(entry.size.width);
  const h = safeDim(entry.size.height);
  // const isLarge = primitive.sizingStrategy === "large-panel";
  const isAudio = primitive.mediaType === "audio";
  // const ICON_SIZE = isLarge ? 0.08 : 0.04;

  return (
    <group position={pos} rotation={rot}>
      {/* Backing panel */}
      <RoundedBox
        args={[w, h, PANEL_DEPTH]}
        radius={PANEL_RADIUS}
        position={[w / 2, -h / 2, -PANEL_DEPTH / 2]}
      >
        <meshStandardMaterial
          color={MEDIA_BG}
          transparent
          opacity={0.93}
          roughness={0.6}
          metalness={0.15}
          clippingPlanes={clips}
        />
      </RoundedBox>

      {/* Rim */}
      <RoundedBox
        args={[w, h, RIM_DEPTH]}
        radius={PANEL_RADIUS}
        position={[w / 2, -h / 2, -PANEL_DEPTH - RIM_DEPTH / 2]}
      >
        <meshBasicMaterial
          color={PANEL_RIM}
          transparent
          opacity={0.5}
          clippingPlanes={clips}
        />
      </RoundedBox>

      {/* Play / audio icon */}
      <group position={[w / 2, -h / 2, PANEL_DEPTH]}>
        {isAudio ? (
          <>
            {[-0.012, 0, 0.012].map((xOff, i) => (
              <mesh key={i} position={[xOff, 0, 0]}>
                <boxGeometry args={[0.006, 1 * (0.5 + i * 0.3), 0.002]} />
                <meshBasicMaterial
                  color={ACCENT_COL}
                  transparent
                  opacity={0.85}
                  clippingPlanes={clips}
                />
              </mesh>
            ))}
          </>
        ) : (
          <mesh rotation={[0, 0, 0]}>
            <coneGeometry args={[1 * 0.6, 1, 3, 1]} />
            <meshBasicMaterial
              color={ACCENT_COL}
              transparent
              opacity={0.9}
              clippingPlanes={clips}
            />
          </mesh>
        )}
      </group>

      {/* Label */}
      {primitive.label && (
        <ClippedText
          anchorX="center"
          anchorY="top"
          position={[w / 2, -h + 0.03, PANEL_DEPTH * 2]}
          fontSize={0.02}
          color={BODY_COL}
          maxWidth={w - 0.06}
        >
          {primitive.label}
        </ClippedText>
      )}

      {/* Native video embed for large-panel when src is available */}
      {/* {isLarge && primitive.src && (
        <Html
          transform
          position={[w / 2, -h / 2, PANEL_DEPTH * 2]}
          style={{
            width: `${w * 300}px`,
            height: `${h * 300}px`,
            pointerEvents: "auto",
          }}
          distanceFactor={3}
          occlude
        >
          <video
            src={primitive.src}
            controls
            style={{
              width: "100%",
              height: "100%",
              objectFit: "contain",
              background: MEDIA_BG,
            }}
          />
        </Html>
      )} */}
    </group>
  );
}

// ─────────────────────────────────────────────────────────────
// 6. XRCodeBlockMesh
// ─────────────────────────────────────────────────────────────

export interface XRCodeBlockMeshProps {
  primitive: import("../mapper/types").XRCodeBlock;
  entry: LayoutEntry;
}

export function XRCodeBlockMesh({ primitive, entry }: XRCodeBlockMeshProps) {
  const { pos, rot } = entryTransform(entry);
  const clips = useClipPlanes();
  const w = safeDim(entry.size.width);
  const h = safeDim(entry.size.height);
  const CODE_BG = "#0a0e14";
  const CODE_COL = "#7ee787";

  return (
    <group position={pos} rotation={rot}>
      <RoundedBox
        args={[w, h, PANEL_DEPTH]}
        radius={safeRadius(PANEL_RADIUS, w, h, PANEL_DEPTH)}
        position={[w / 2, -h / 2, -PANEL_DEPTH / 2]}
      >
        <meshStandardMaterial
          color={CODE_BG}
          transparent
          opacity={0.95}
          roughness={0.8}
          clippingPlanes={clips}
        />
      </RoundedBox>

      <mesh position={[0.004, -h / 2, 0.002]}>
        <planeGeometry args={[0.006, h * 0.85]} />
        <meshBasicMaterial
          color={CODE_COL}
          transparent
          opacity={0.7}
          clippingPlanes={clips}
        />
      </mesh>

      <ClippedText
        anchorX="left"
        anchorY="top"
        position={[0.018, -0.014, PANEL_DEPTH * 0.6]}
        fontSize={0.02}
        color={CODE_COL}
        maxWidth={w - 0.03}
        lineHeight={1.6}
        letterSpacing={0.02}
      >
        {primitive.label ?? ""}
      </ClippedText>
    </group>
  );
}

// ─────────────────────────────────────────────────────────────
// 7. XRBlockQuoteMesh
// ─────────────────────────────────────────────────────────────

export interface XRBlockQuoteMeshProps {
  primitive: import("../mapper/types").XRBlockQuote;
  entry: LayoutEntry;
}

export function XRBlockQuoteMesh({ primitive, entry }: XRBlockQuoteMeshProps) {
  const { pos, rot } = entryTransform(entry);
  const clips = useClipPlanes();
  const w = safeDim(entry.size.width);
  const h = safeDim(entry.size.height);
  const QUOTE_ACCENT = "#d2a679";

  return (
    <group position={pos} rotation={rot}>
      <RoundedBox
        args={[w, h, PANEL_DEPTH]}
        radius={safeRadius(PANEL_RADIUS, w, h, PANEL_DEPTH)}
        position={[w / 2, -h / 2, -PANEL_DEPTH / 2]}
      >
        <meshStandardMaterial
          color={PANEL_BG}
          transparent
          opacity={0.7}
          roughness={0.9}
          clippingPlanes={clips}
        />
      </RoundedBox>

      <mesh position={[0.006, -h / 2, 0.003]}>
        <planeGeometry args={[0.01, h * 0.8]} />
        <meshBasicMaterial
          color={QUOTE_ACCENT}
          transparent
          opacity={0.85}
          clippingPlanes={clips}
        />
      </mesh>

      <ClippedText
        anchorX="left"
        anchorY="top"
        position={[0.026, -0.018, PANEL_DEPTH * 0.6]}
        fontSize={0.024}
        color="#d4c5a9"
        maxWidth={w - 0.04}
        lineHeight={1.5}
        letterSpacing={0.003}
      >
        {primitive.label ?? ""}
      </ClippedText>
    </group>
  );
}

// ─────────────────────────────────────────────────────────────
// 8. XRSeparatorMesh
// ─────────────────────────────────────────────────────────────

export interface XRSeparatorMeshProps {
  primitive: import("../mapper/types").XRSeparator;
  entry: LayoutEntry;
}

export function XRSeparatorMesh({ primitive, entry }: XRSeparatorMeshProps) {
  const { pos, rot } = entryTransform(entry);
  const clips = useClipPlanes();
  const w = safeDim(entry.size.width);
  const h = safeDim(entry.size.height);
  const isHoriz = primitive.orientation !== "vertical";

  return (
    <group position={pos} rotation={rot}>
      <mesh position={[w / 2, -h / 2, 0]}>
        <planeGeometry args={[isHoriz ? w : 0.002, isHoriz ? 0.002 : h]} />
        <meshBasicMaterial
          color={PANEL_RIM}
          transparent
          opacity={0.6}
          clippingPlanes={clips}
        />
      </mesh>
    </group>
  );
}

// ─────────────────────────────────────────────────────────────
// 9. XRProgressBarMesh
// ─────────────────────────────────────────────────────────────

export interface XRProgressBarMeshProps {
  primitive: import("../mapper/types").XRProgressBar;
  entry: LayoutEntry;
}

export function XRProgressBarMesh({
  primitive,
  entry,
}: XRProgressBarMeshProps) {
  const { pos, rot } = entryTransform(entry);
  const clips = useClipPlanes();
  const w = safeDim(entry.size.width);
  const h = safeDim(entry.size.height);
  const fraction = Math.max(0, Math.min(1, primitive.valueFraction ?? 0));
  const fillW = Math.max(0.001, w * fraction);
  const TRACK_H = Math.min(0.018, h);

  return (
    <group position={pos} rotation={rot}>
      <mesh position={[w / 2, -h / 2, 0]}>
        <planeGeometry args={[w, TRACK_H]} />
        <meshBasicMaterial
          color={PANEL_RIM}
          transparent
          opacity={0.5}
          clippingPlanes={clips}
        />
      </mesh>

      <mesh position={[fillW / 2, -h / 2, 0.001]}>
        <planeGeometry args={[fillW, TRACK_H]} />
        <meshBasicMaterial
          color={ACCENT_COL}
          transparent
          opacity={0.85}
          clippingPlanes={clips}
        />
      </mesh>

      {primitive.label && (
        <ClippedText
          anchorX="left"
          anchorY="bottom"
          position={[0, -h / 2 + TRACK_H / 2 + 0.006, 0.002]}
          fontSize={0.018}
          color={BODY_COL}
          maxWidth={w}
        >
          {primitive.label}
        </ClippedText>
      )}
    </group>
  );
}

// ─────────────────────────────────────────────────────────────
// 10. XRImageMesh
// ─────────────────────────────────────────────────────────────

export interface XRImageMeshProps {
  primitive: import("../mapper/types").XRImage;
  entry: LayoutEntry;
}

export function XRImageMesh({ primitive, entry }: XRImageMeshProps) {
  const { pos, rot } = entryTransform(entry);
  const clips = useClipPlanes();
  const w = safeDim(entry.size.width);
  const h = safeDim(entry.size.height);
  const IMG_BG = "#111622";

  function isRenderableImage(url: string) {
    try {
      const u = new URL(url);
      return (
        u.origin === window.location.origin ||
        url.startsWith("data:") ||
        url.startsWith("blob:")
      );
    } catch {
      return false;
    }
  }
  const texture =
    isRenderableImage(primitive.src ?? "") && useTexture(primitive.src!);

  return (
    <group position={pos} rotation={rot}>
      <RoundedBox
        args={[w, h, PANEL_DEPTH]}
        radius={safeRadius(PANEL_RADIUS, w, h, PANEL_DEPTH)}
        position={[w / 2, -h / 2, -PANEL_DEPTH / 2]}
      >
        <meshStandardMaterial
          color={IMG_BG}
          transparent
          opacity={0.9}
          roughness={0.6}
          metalness={0.1}
          clippingPlanes={clips}
        />
      </RoundedBox>

      {primitive.src && isRenderableImage(primitive.src) ? (
        <mesh>
          <planeGeometry args={[w, h]} />
          <meshBasicMaterial map={texture} />
        </mesh>
      ) : (
        <Html position={[w / 2, -h / 2, 0]}>
          <img
            src={primitive.src ?? ""}
            style={{ width: w * 100, height: h * 100 }}
          />
        </Html>
      )}
      <mesh position={[w / 2, -h / 2, 0.002]} rotation={[0, 0, Math.PI / 2]}>
        <planeGeometry args={[h * 0.4, 0.002]} />
        <meshBasicMaterial
          color={PANEL_RIM}
          transparent
          opacity={0.5}
          clippingPlanes={clips}
        />
      </mesh>

      {(primitive.alt ?? primitive.label) && (
        <ClippedText
          anchorX="center"
          anchorY="bottom"
          position={[w / 2, -h + 0.02, PANEL_DEPTH]}
          fontSize={0.016}
          color={BODY_COL}
          maxWidth={w - 0.04}
        >
          {primitive.alt ?? primitive.label ?? ""}
        </ClippedText>
      )}
    </group>
  );
}

// ─────────────────────────────────────────────────────────────
// 11. XRListItemMesh
// ─────────────────────────────────────────────────────────────

export interface XRListItemMeshProps {
  primitive: import("../mapper/types").XRListItem;
  entry: LayoutEntry;
  renderChild: (primitiveId: string) => React.ReactNode;
}

export function XRListItemMesh({
  primitive,
  entry,
  renderChild,
}: XRListItemMeshProps) {
  const { pos, rot } = entryTransform(entry);
  const clips = useClipPlanes();
  const w = safeDim(entry.size.width);
  const h = safeDim(entry.size.height);
  const ACCENT_H = 0.005;

  return (
    <group position={pos} rotation={rot}>
      <RoundedBox
        args={[w, h, PANEL_DEPTH * 1.5]}
        radius={safeRadius(PANEL_RADIUS, w, h, PANEL_DEPTH * 1.5)}
        position={[w / 2, -h / 2, -PANEL_DEPTH]}
      >
        <meshStandardMaterial
          color="#111827"
          transparent
          opacity={0.85}
          roughness={0.85}
          metalness={0.05}
          clippingPlanes={clips}
        />
      </RoundedBox>

      <mesh position={[w / 2, -ACCENT_H / 2, 0.001]}>
        <planeGeometry args={[w, ACCENT_H]} />
        <meshBasicMaterial
          color={ACCENT_COL}
          transparent
          opacity={0.6}
          clippingPlanes={clips}
        />
      </mesh>

      {primitive.label && (
        <ClippedText
          anchorX="left"
          anchorY="top"
          position={[0.014, -0.018, PANEL_DEPTH]}
          fontSize={0.022}
          color={HEADING_COL}
          fontWeight="600"
          maxWidth={w - 0.028}
        >
          {primitive.label}
        </ClippedText>
      )}

      {primitive.children.map((child) => renderChild(child.id))}
    </group>
  );
}

// ─────────────────────────────────────────────────────────────
// 12. XRButtonMesh
// ─────────────────────────────────────────────────────────────

export interface XRButtonMeshProps {
  primitive: import("../mapper/types").XRButton;
  entry: LayoutEntry;
}

export function XRButtonMesh({ primitive, entry }: XRButtonMeshProps) {
  const { ref, handlers } = useHoverScale(1.0, 1.04);
  const { pos, rot } = entryTransform(entry);
  const clips = useClipPlanes();
  const w = safeDim(entry.size.width);
  const h = safeDim(entry.size.height);
  const BTN_DEPTH = 0.016;
  const isDisabled = primitive.state?.disabled;

  return (
    <group ref={ref} position={pos} rotation={rot} {...handlers}>
      <RoundedBox
        args={[w, h, BTN_DEPTH]}
        radius={safeRadius(Math.min(h / 2, 0.022), w, h, BTN_DEPTH)}
        position={[w / 2, -h / 2, 0]}
      >
        <meshStandardMaterial
          color={isDisabled ? "#1a1f2e" : ACCENT_COL}
          transparent
          opacity={isDisabled ? 0.4 : 0.9}
          roughness={0.55}
          metalness={0.1}
          clippingPlanes={clips}
        />
      </RoundedBox>

      <ClippedText
        anchorX="center"
        anchorY="middle"
        position={[w / 2, -h / 2, BTN_DEPTH + 0.001]}
        fontSize={0.02}
        color={isDisabled ? "#4a5568" : "#ffffff"}
        fontWeight="600"
        maxWidth={w - 0.02}
      >
        {primitive.label ?? ""}
      </ClippedText>
    </group>
  );
}

// ─────────────────────────────────────────────────────────────
// 13. XRAlertMesh
// ─────────────────────────────────────────────────────────────

export interface XRAlertMeshProps {
  primitive: import("../mapper/types").XRAlert;
  entry: LayoutEntry;
}

export function XRAlertMesh({ primitive, entry }: XRAlertMeshProps) {
  const { pos, rot } = entryTransform(entry);
  const clips = useClipPlanes();
  const w = safeDim(entry.size.width);
  const h = safeDim(entry.size.height);
  const isAssertive = primitive.liveRegion === "assertive";
  const alertColor = isAssertive ? "#ff4444" : ACCENT_COL;
  const alertBg = isAssertive ? "#1a0a0a" : "#0a1020";

  return (
    <group position={pos} rotation={rot}>
      <RoundedBox
        args={[w, h, PANEL_DEPTH]}
        radius={safeRadius(PANEL_RADIUS, w, h, PANEL_DEPTH)}
        position={[w / 2, -h / 2, -PANEL_DEPTH / 2]}
      >
        <meshStandardMaterial
          color={alertBg}
          transparent
          opacity={0.9}
          roughness={0.8}
          clippingPlanes={clips}
        />
      </RoundedBox>

      <mesh position={[0.004, -h / 2, 0.002]}>
        <planeGeometry args={[0.007, h * 0.8]} />
        <meshBasicMaterial
          color={alertColor}
          transparent
          opacity={0.9}
          clippingPlanes={clips}
        />
      </mesh>

      <ClippedText
        anchorX="left"
        anchorY="top"
        position={[0.02, -0.014, PANEL_DEPTH * 0.6]}
        fontSize={0.022}
        color={isAssertive ? "#ff9999" : BODY_COL}
        maxWidth={w - 0.032}
        lineHeight={1.4}
      >
        {primitive.label ?? ""}
      </ClippedText>
    </group>
  );
}

// ─────────────────────────────────────────────────────────────
// 14. XRTableMesh
// ─────────────────────────────────────────────────────────────

export interface XRTableMeshProps {
  primitive: import("../mapper/types").XRTable;
  entry: LayoutEntry;
  renderChild: (primitiveId: string) => React.ReactNode;
}

export function XRTableMesh({
  primitive,
  entry,
  renderChild,
}: XRTableMeshProps) {
  const { pos, rot } = entryTransform(entry);
  const clips = useClipPlanes();
  const w = safeDim(entry.size.width);
  const h = safeDim(entry.size.height);
  const HEADER_H = 0.04;

  return (
    <group position={pos} rotation={rot}>
      <RoundedBox
        args={[w, h, PANEL_DEPTH]}
        radius={safeRadius(PANEL_RADIUS, w, h, PANEL_DEPTH)}
        position={[w / 2, -h / 2, -PANEL_DEPTH / 2]}
      >
        <meshStandardMaterial
          color={PANEL_BG}
          transparent
          opacity={0.75}
          roughness={0.9}
          clippingPlanes={clips}
        />
      </RoundedBox>

      <RoundedBox
        args={[w, HEADER_H, PANEL_DEPTH * 1.2]}
        radius={safeRadius(PANEL_RADIUS, w, HEADER_H, PANEL_DEPTH * 1.2)}
        position={[w / 2, -HEADER_H / 2, -PANEL_DEPTH * 0.4]}
      >
        <meshStandardMaterial
          color="#131e2e"
          transparent
          opacity={0.9}
          roughness={0.8}
          clippingPlanes={clips}
        />
      </RoundedBox>

      <ClippedText
        anchorX="left"
        anchorY="middle"
        position={[0.014, -HEADER_H / 2, PANEL_DEPTH]}
        fontSize={0.018}
        color={HEADING_COL}
        fontWeight="600"
        maxWidth={w - 0.12}
      >
        {primitive.label ?? "Table"}
      </ClippedText>

      <ClippedText
        anchorX="right"
        anchorY="middle"
        position={[w - 0.01, -HEADER_H / 2, PANEL_DEPTH]}
        fontSize={0.014}
        color="#4a5568"
        maxWidth={0.1}
      >
        {`${primitive.columnCount}×${primitive.rowCount}`}
      </ClippedText>

      {primitive.children.map((child) => renderChild(child.id))}
    </group>
  );
}

// ─────────────────────────────────────────────────────────────
// 15. XRFormFieldMesh
// ─────────────────────────────────────────────────────────────

export interface XRFormFieldMeshProps {
  primitive: import("../mapper/types").XRFormField;
  entry: LayoutEntry;
}

export function XRFormFieldMesh({ primitive, entry }: XRFormFieldMeshProps) {
  const { pos, rot } = entryTransform(entry);
  const clips = useClipPlanes();
  const w = safeDim(entry.size.width);
  const h = safeDim(entry.size.height);
  const INPUT_H = Math.min(0.038, h * 0.6);
  const INPUT_BG = "#0f1928";
  const label = primitive.resolvedLabel ?? primitive.label ?? "";

  return (
    <group position={pos} rotation={rot}>
      {label && (
        <ClippedText
          anchorX="left"
          anchorY="bottom"
          position={[0, -(h - INPUT_H) + 0.002, 0.002]}
          fontSize={0.016}
          color={BODY_COL}
          maxWidth={w}
        >
          {label}
        </ClippedText>
      )}

      <RoundedBox
        args={[w, INPUT_H, PANEL_DEPTH]}
        radius={safeRadius(0.008, w, INPUT_H, PANEL_DEPTH)}
        position={[w / 2, -h + INPUT_H / 2, 0]}
      >
        <meshStandardMaterial
          color={INPUT_BG}
          transparent
          opacity={primitive.state?.disabled ? 0.3 : 0.85}
          roughness={0.7}
          clippingPlanes={clips}
        />
      </RoundedBox>

      {primitive.placeholder && (
        <ClippedText
          anchorX="left"
          anchorY="middle"
          position={[0.01, -h + INPUT_H / 2, PANEL_DEPTH + 0.001]}
          fontSize={0.016}
          color="#4a5568"
          maxWidth={w - 0.02}
        >
          {primitive.placeholder}
        </ClippedText>
      )}
    </group>
  );
}

// ─────────────────────────────────────────────────────────────
// 16. XRTabGroupMesh
// ─────────────────────────────────────────────────────────────

export interface XRTabGroupMeshProps {
  primitive: import("../mapper/types").XRTabGroup;
  entry: LayoutEntry;
  renderChild: (primitiveId: string) => React.ReactNode;
}

export function XRTabGroupMesh({
  primitive,
  entry,
  renderChild,
}: XRTabGroupMeshProps) {
  const { pos, rot } = entryTransform(entry);
  const clips = useClipPlanes();
  const w = safeDim(entry.size.width);
  const h = safeDim(entry.size.height);
  const TAB_H = 0.042;

  return (
    <group position={pos} rotation={rot}>
      <RoundedBox
        args={[w, TAB_H, PANEL_DEPTH]}
        radius={safeRadius(PANEL_RADIUS, w, TAB_H, PANEL_DEPTH)}
        position={[w / 2, -TAB_H / 2, -PANEL_DEPTH / 2]}
      >
        <meshStandardMaterial
          color={NAV_BG}
          transparent
          opacity={0.9}
          roughness={0.85}
          clippingPlanes={clips}
        />
      </RoundedBox>

      <RoundedBox
        args={[w, h - TAB_H, PANEL_DEPTH]}
        radius={safeRadius(PANEL_RADIUS, w, h - TAB_H, PANEL_DEPTH)}
        position={[w / 2, -(TAB_H + (h - TAB_H) / 2), -PANEL_DEPTH / 2]}
      >
        <meshStandardMaterial
          color={PANEL_BG}
          transparent
          opacity={0.7}
          roughness={0.9}
          clippingPlanes={clips}
        />
      </RoundedBox>

      {primitive.children.map((child) => renderChild(child.id))}
    </group>
  );
}

// primitives.tsx - Add XRTextMesh for rendering text nodes

export interface XRTextMeshProps {
  primitive: import("../mapper/types").XRText;
  entry: LayoutEntry;
}

/**
 * XRTextMesh renders a single text node.
 *
 * Text nodes are atomic - they represent a single text run with optional
 * semantic formatting (em, strong, code, etc.).
 *
 * The componentType determines the visual styling:
 * - "strong" / "b": bold
 * - "em" / "i": italic
 * - "code": monospace
 * - "span": plain text (default)
 * - "text": plain text (default)
 */
export function XRTextMesh({ primitive, entry }: XRTextMeshProps) {
  const { pos, rot } = entryTransform(entry);
  const clips = useClipPlanes();
  const w = safeDim(entry.size.width);
  const h = safeDim(entry.size.height);

  // Determine styling based on component type
  const componentType = primitive.componentType || "text";
  let fontWeight: string | number = "400";
  let fontStyle: "normal" | "italic" = "normal";
  let color = BODY_COL;

  switch (componentType) {
    case "strong":
    case "b":
      fontWeight = "700";
      color = HEADING_COL;
      break;
    case "em":
    case "i":
      fontStyle = "italic";
      color = HEADING_COL;
      break;
    case "code":
      fontWeight = "500";
      color = "#7ee787";
      break;
    case "link":
      color = ACCENT_COL;
      fontWeight = "500";
      break;
    default:
      // 'text' or 'span' or unknown
      color = BODY_COL;
      break;
  }

  return (
    <group position={pos} rotation={rot}>
      <ClippedText
        anchorX="left"
        anchorY="top"
        position={[0, 0, 0.002]}
        fontSize={0.026}
        color={color}
        fontWeight={fontWeight}
        fontStyle={fontStyle}
        maxWidth={w}
        lineHeight={1.55}
        letterSpacing={0.005}
      >
        {primitive.text}
      </ClippedText>
    </group>
  );
}

// primitives.tsx - Add XRLinkMesh

export interface XRLinkMeshProps {
  primitive: import("../mapper/types").XRLink;
  entry: LayoutEntry;
  renderChild: (primitiveId: string) => React.ReactNode;
}

/**
 * XRLinkMesh renders a link with optional rich content.
 *
 * If the link has text children, they are rendered inline.
 * If not, the label is rendered as text.
 */
export function XRLinkMesh({ primitive, entry, renderChild }: XRLinkMeshProps) {
  const { pos, rot } = entryTransform(entry);
  const clips = useClipPlanes();
  const w = safeDim(entry.size.width);
  const h = safeDim(entry.size.height);

  // Check if link has text children (rich link)
  const hasTextChildren = primitive.children.some(
    (child) => child.type === "XRText",
  );

  // Hover effect
  const { ref, handlers } = useHoverScale(1.0, 1.02);

  return (
    <group ref={ref} position={pos} rotation={rot} {...handlers}>
      {hasTextChildren ? (
        // Rich link - render children inline with link styling
        <group position={[0, 0, 0]}>
          {primitive.children.map((child) => renderChild(child.id))}
        </group>
      ) : (
        // Simple link - render label as text
        <ClippedText
          anchorX="left"
          anchorY="top"
          position={[0, 0, 0.002]}
          fontSize={0.026}
          color={primitive.isCurrent ? "#ffffff" : ACCENT_COL}
          fontWeight={primitive.isCurrent ? "700" : "500"}
          maxWidth={w}
          lineHeight={1.55}
        >
          {primitive.label ?? primitive.href ?? ""}
        </ClippedText>
      )}
    </group>
  );
}
