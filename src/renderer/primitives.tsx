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

import React, { useRef } from "react";
import { Text, RoundedBox, Html } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";

import type { LayoutEntry } from "../layout/engine";
import type {
  XRHeading,
  XRParagraph,
  XRSection,
  XRNavigationBar,
  XRMediaPlayer,
  XRLink,
} from "../mapper/mapper";

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
// 1. XRHeadingMesh
// ─────────────────────────────────────────────────────────────

export interface XRHeadingMeshProps {
  primitive: XRHeading;
  entry: LayoutEntry;
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
export function XRHeadingMesh({ primitive, entry }: XRHeadingMeshProps) {
  const { pos, rot } = entryTransform(entry);
  const fontSize = headingFontSize(primitive.level);
  const showAccent = primitive.level >= 3;

  return (
    <group position={pos} rotation={rot}>
      <Text
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
        {primitive.label ?? ""}
      </Text>

      {/* Accent underline for H3+ */}
      {showAccent && (
        <mesh position={[entry.size.width * 0.5, -fontSize * 1.35, 0]}>
          <planeGeometry args={[entry.size.width, 0.002]} />
          <meshBasicMaterial color={ACCENT_COL} transparent opacity={0.5} />
        </mesh>
      )}
    </group>
  );
}

// ─────────────────────────────────────────────────────────────
// 2. XRParagraphMesh
// ─────────────────────────────────────────────────────────────

export interface XRParagraphMeshProps {
  primitive: XRParagraph;
  entry: LayoutEntry;
}

/**
 * Multi-line body text rendered on a frosted-glass panel.
 *
 * Dense paragraphs (densityScore > 0.6) receive a slightly larger panel
 * with a faint top-edge glow to signal long-form reading mode.
 * Short snippets (≤ 10 words) skip the backing panel entirely.
 */
export function XRParagraphMesh({ primitive, entry }: XRParagraphMeshProps) {
  const { pos, rot } = entryTransform(entry);
  const dense = primitive.densityScore > 0.6;
  const w = safeDim(entry.size.width);
  const h = safeDim(entry.size.height);
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
          />
        </RoundedBox>
      )}

      {/* Dense glow strip */}
      {dense && (
        <mesh position={[w / 2, -0.001, 0]}>
          <planeGeometry args={[w, 0.003]} />
          <meshBasicMaterial color={ACCENT_COL} transparent opacity={0.3} />
        </mesh>
      )}

      {/* Body text */}
      <Text
        anchorX="left"
        anchorY="top"
        position={[0.02, -0.018, PANEL_DEPTH * 0.6]}
        fontSize={0.026}
        color={BODY_COL}
        maxWidth={w - 0.04}
        lineHeight={1.55}
        letterSpacing={0.005}
      >
        {primitive.label ?? ""}
      </Text>
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
   * Resolved child entries from the LayoutPlan — keyed by primitive ID.
   * The section renders its children using their local-space entries.
   */
  childEntries: LayoutEntry[];
  /** Renderer for child primitives — injected by XRSceneRenderer. */
  renderChild: (primitiveId: string) => React.ReactNode;
  /**
   * IDs of children to render on the current page.
   * When provided, only these children are rendered (pagination support).
   * When omitted, all children are rendered.
   */
  visibleChildIds?: Set<string>;
  /** Pagination metadata — when present, renders prev/next controls inside the section. */
  pagination?: {
    pageCount: number;
    currentPage: number;
    onPageChange: (p: number) => void;
  };
}

/**
 * Translucent bounding panel with an optional title bar.
 *
 * The section is purely a spatial container — it renders a frosted panel
 * behind its children but does not re-layout them. Child positions are
 * already resolved by the layout engine in local space.
 *
 * The title bar (if present) occupies the top 0.055 m of the panel
 * with a slightly stronger opacity to visually group it as a header.
 */
export function XRSectionMesh({
  primitive,
  entry,
  childEntries: _childEntries,
  renderChild,
  visibleChildIds,
  pagination,
}: XRSectionMeshProps) {
  const { pos, rot } = entryTransform(entry);
  const w = safeDim(entry.size.width);
  const h = safeDim(entry.size.height);
  const hasTitle = !!primitive.title;
  const TITLE_H = 0.055;

  // Which children to render — all unless pagination filter is active
  const childrenToRender = primitive.children.filter(
    (c) => !visibleChildIds || visibleChildIds.has(c.id),
  );

  // Pagination button constants
  const BTN_W = 0.1;
  const BTN_H = 0.034;
  const BTN_DEPTH = 0.012;
  const BTN_RADIUS = Math.min(BTN_H / 2, BTN_DEPTH / 2 - 0.0001);

  return (
    <group position={pos} rotation={rot}>
      {/* Section body panel */}
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
        />
      </RoundedBox>

      {/* Rim border */}
      <RoundedBox
        args={[w, h, RIM_DEPTH]}
        radius={PANEL_RADIUS}
        position={[w / 2, -h / 2, -PANEL_DEPTH - RIM_DEPTH / 2]}
      >
        <meshBasicMaterial color={PANEL_RIM} transparent opacity={0.7} />
      </RoundedBox>

      {/* Title bar */}
      {hasTitle &&
        /*(
        <>
          <RoundedBox
            args={[w, TITLE_H, PANEL_DEPTH * 1.5]}
            radius={PANEL_RADIUS}
            position={[w / 2, -TITLE_H / 2, -PANEL_DEPTH * 0.5]}
          >
            <meshStandardMaterial
              color="#131e2e"
              transparent
              opacity={0.9}
              roughness={0.8}
            />
          </RoundedBox>

          <Text
            anchorX="left"
            anchorY="middle"
            position={[0.016, -TITLE_H / 2, PANEL_DEPTH]}
            fontSize={0.024}
            color={HEADING_COL}
            fontWeight="600"
            maxWidth={w - 0.032}
          >
            {primitive.title}
          </Text>

          <mesh position={[0.003, -TITLE_H / 2, PANEL_DEPTH * 0.8]}>
            <planeGeometry args={[0.004, TITLE_H * 0.65]} />
            <meshBasicMaterial color={ACCENT_COL} />
          </mesh>
          
          </>
          */
        ""}

      {/* Children (injected by parent renderer, filtered for pagination) */}
      {childrenToRender.map((child) => renderChild(child.id))}

      {/* In-section pagination controls — rendered below the panel in local space */}
      {pagination && pagination.pageCount > 1 && (
        <group position={[0, -(h + BTN_H / 2 + 0.02), 0.005]}>
          {/* Prev button */}
          <group
            position={[BTN_W / 2, 0, 0]}
            onClick={() =>
              pagination.onPageChange(Math.max(0, pagination.currentPage - 1))
            }
          >
            <RoundedBox args={[BTN_W, BTN_H, BTN_DEPTH]} radius={BTN_RADIUS}>
              <meshStandardMaterial
                color={pagination.currentPage === 0 ? "#12182a" : "#1a2840"}
                transparent
                opacity={pagination.currentPage === 0 ? 0.5 : 0.88}
                roughness={0.6}
              />
            </RoundedBox>
            <Text
              anchorX="center"
              anchorY="middle"
              position={[0, 0, BTN_DEPTH + 0.001]}
              fontSize={0.016}
              color={pagination.currentPage === 0 ? "#4a5568" : "#ffffff"}
            >
              ← Prev
            </Text>
          </group>

          {/* Page indicator */}
          <Text
            anchorX="center"
            anchorY="middle"
            position={[w / 2, 0, 0]}
            fontSize={0.015}
            color="#7aa2cc"
          >
            {`${pagination.currentPage + 1} / ${pagination.pageCount}`}
          </Text>

          {/* Next button */}
          <group
            position={[w - BTN_W / 2, 0, 0]}
            onClick={() =>
              pagination.onPageChange(
                Math.min(pagination.pageCount - 1, pagination.currentPage + 1),
              )
            }
          >
            <RoundedBox args={[BTN_W, BTN_H, BTN_DEPTH]} radius={BTN_RADIUS}>
              <meshStandardMaterial
                color={
                  pagination.currentPage === pagination.pageCount - 1
                    ? "#12182a"
                    : "#1a2840"
                }
                transparent
                opacity={
                  pagination.currentPage === pagination.pageCount - 1
                    ? 0.5
                    : 0.88
                }
                roughness={0.6}
              />
            </RoundedBox>
            <Text
              anchorX="center"
              anchorY="middle"
              position={[0, 0, BTN_DEPTH + 0.001]}
              fontSize={0.016}
              color={
                pagination.currentPage === pagination.pageCount - 1
                  ? "#4a5568"
                  : "#ffffff"
              }
            >
              Next →
            </Text>
          </group>
        </group>
      )}
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
          />
        </RoundedBox>

        {/* Panel label */}
        <Text
          anchorX="left"
          anchorY="top"
          position={[PADDING, -PADDING, PANEL_DEPTH]}
          fontSize={0.014}
          color="#4a5568"
          fontWeight="700"
          letterSpacing={0.08}
        >
          {(primitive.label ?? "Contents").toUpperCase()}
        </Text>

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
                // Navigate to the anchor if in browser context
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
                <meshBasicMaterial transparent opacity={0} />
              </mesh>

              {/* Active accent bar */}
              {isCurrent && (
                <mesh position={[-0.006, -ITEM_H / 2, 0.001]}>
                  <planeGeometry args={[0.003, ITEM_H * 0.7]} />
                  <meshBasicMaterial color={ACCENT_COL} />
                </mesh>
              )}
              <Text
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
              </Text>
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
    0.025, // never below RoundedBox safe minimum
    items.length > 0
      ? Math.min(0.28, (w - CHIP_GAP * (items.length + 1)) / items.length)
      : 0.24,
  );

  // Arc angle per chip (radians). 0 if flat.
  // Clamp the asin argument to [-1, 1] — if panel width exceeds the chord
  // of the curve (w > 2r) the raw ratio would be >1 and produce NaN.
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
        />
      </RoundedBox>

      {/* Nav chips */}
      {items.map((item, i) => {
        // Horizontal position along the strip
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
              />
            </RoundedBox>

            <Text
              anchorX="center"
              anchorY="middle"
              position={[0, 0, 0.006]}
              fontSize={0.018}
              color={isCurrent ? "#ffffff" : BODY_COL}
              maxWidth={chipW - 0.016}
              fontWeight={isCurrent ? "600" : "400"}
            >
              {item.label ?? item.href ?? ""}
            </Text>
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
 *
 * The panel uses Html from drei to embed a native <video> element when
 * sizingStrategy === "large-panel" and a src is available, because the
 * VideoTexture path requires additional lifecycle management.
 */
export function XRMediaMesh({ primitive, entry }: XRMediaMeshProps) {
  const { pos, rot } = entryTransform(entry);
  const w = safeDim(entry.size.width);
  const h = safeDim(entry.size.height);
  const isLarge = primitive.sizingStrategy === "large-panel";
  const isAudio = primitive.mediaType === "audio";
  const ICON_SIZE = isLarge ? 0.08 : 0.04;

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
        />
      </RoundedBox>

      {/* Rim */}
      <RoundedBox
        args={[w, h, RIM_DEPTH]}
        radius={PANEL_RADIUS}
        position={[w / 2, -h / 2, -PANEL_DEPTH - RIM_DEPTH / 2]}
      >
        <meshBasicMaterial color={PANEL_RIM} transparent opacity={0.5} />
      </RoundedBox>

      {/* Play / audio icon — simple geometric placeholder */}
      <group position={[w / 2, -h / 2, PANEL_DEPTH]}>
        {isAudio ? (
          // Audio: three vertical bars (waveform symbol)
          <>
            {[-0.012, 0, 0.012].map((xOff, i) => (
              <mesh key={i} position={[xOff, 0, 0]}>
                <boxGeometry
                  args={[0.006, ICON_SIZE * (0.5 + i * 0.3), 0.002]}
                />
                <meshBasicMaterial
                  color={ACCENT_COL}
                  transparent
                  opacity={0.85}
                />
              </mesh>
            ))}
          </>
        ) : (
          // Video: triangle play button
          <mesh rotation={[0, 0, 0]}>
            <coneGeometry args={[ICON_SIZE * 0.6, ICON_SIZE, 3, 1]} />
            <meshBasicMaterial color={ACCENT_COL} transparent opacity={0.9} />
          </mesh>
        )}
      </group>

      {/* Label */}
      {primitive.label && (
        <Text
          anchorX="center"
          anchorY="top"
          position={[w / 2, -h + 0.03, PANEL_DEPTH * 2]}
          fontSize={0.02}
          color={BODY_COL}
          maxWidth={w - 0.06}
        >
          {primitive.label}
        </Text>
      )}

      {/* Native video embed for large-panel when src is available */}
      {isLarge && primitive.src && (
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
      )}
    </group>
  );
}

// ─────────────────────────────────────────────────────────────
// 6. XRCodeBlockMesh
// ─────────────────────────────────────────────────────────────

export interface XRCodeBlockMeshProps {
  primitive: import("../mapper/mapper").XRCodeBlock;
  entry: LayoutEntry;
}

/**
 * Syntax-highlighted code block on a dark terminal-style panel.
 *
 * Renders the code label in a monospace-style text block with a
 * distinctive dark green accent and a subtle left-edge bar.
 */
export function XRCodeBlockMesh({ primitive, entry }: XRCodeBlockMeshProps) {
  const { pos, rot } = entryTransform(entry);
  const w = safeDim(entry.size.width);
  const h = safeDim(entry.size.height);
  const CODE_BG = "#0a0e14";
  const CODE_COL = "#7ee787"; // GitHub green for code

  return (
    <group position={pos} rotation={rot}>
      {/* Dark code panel */}
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
        />
      </RoundedBox>

      {/* Left accent bar */}
      <mesh position={[0.004, -h / 2, 0.002]}>
        <planeGeometry args={[0.006, h * 0.85]} />
        <meshBasicMaterial color={CODE_COL} transparent opacity={0.7} />
      </mesh>

      {/* Code label */}
      <Text
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
      </Text>
    </group>
  );
}

// ─────────────────────────────────────────────────────────────
// 7. XRBlockQuoteMesh
// ─────────────────────────────────────────────────────────────

export interface XRBlockQuoteMeshProps {
  primitive: import("../mapper/mapper").XRBlockQuote;
  entry: LayoutEntry;
}

/**
 * Pull-quote panel with a prominent left accent stripe and italic text.
 */
export function XRBlockQuoteMesh({ primitive, entry }: XRBlockQuoteMeshProps) {
  const { pos, rot } = entryTransform(entry);
  const w = safeDim(entry.size.width);
  const h = safeDim(entry.size.height);
  const QUOTE_ACCENT = "#d2a679"; // warm amber

  return (
    <group position={pos} rotation={rot}>
      {/* Panel */}
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
        />
      </RoundedBox>

      {/* Thick left quote bar */}
      <mesh position={[0.006, -h / 2, 0.003]}>
        <planeGeometry args={[0.01, h * 0.8]} />
        <meshBasicMaterial color={QUOTE_ACCENT} transparent opacity={0.85} />
      </mesh>

      {/* Quote text */}
      <Text
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
      </Text>
    </group>
  );
}

// ─────────────────────────────────────────────────────────────
// 8. XRSeparatorMesh
// ─────────────────────────────────────────────────────────────

export interface XRSeparatorMeshProps {
  primitive: import("../mapper/mapper").XRSeparator;
  entry: LayoutEntry;
}

/**
 * Horizontal or vertical thematic separator line.
 */
export function XRSeparatorMesh({ primitive, entry }: XRSeparatorMeshProps) {
  const { pos, rot } = entryTransform(entry);
  const w = safeDim(entry.size.width);
  const h = safeDim(entry.size.height);
  const isHoriz = primitive.orientation !== "vertical";

  return (
    <group position={pos} rotation={rot}>
      <mesh position={[w / 2, -h / 2, 0]}>
        <planeGeometry args={[isHoriz ? w : 0.002, isHoriz ? 0.002 : h]} />
        <meshBasicMaterial color={PANEL_RIM} transparent opacity={0.6} />
      </mesh>
    </group>
  );
}

// ─────────────────────────────────────────────────────────────
// 9. XRProgressBarMesh
// ─────────────────────────────────────────────────────────────

export interface XRProgressBarMeshProps {
  primitive: import("../mapper/mapper").XRProgressBar;
  entry: LayoutEntry;
}

/**
 * Progress bar / meter — filled track with accent fill.
 */
export function XRProgressBarMesh({
  primitive,
  entry,
}: XRProgressBarMeshProps) {
  const { pos, rot } = entryTransform(entry);
  const w = safeDim(entry.size.width);
  const h = safeDim(entry.size.height);
  const fraction = Math.max(0, Math.min(1, primitive.valueFraction ?? 0));
  const fillW = Math.max(0.001, w * fraction);
  const TRACK_H = Math.min(0.018, h);

  return (
    <group position={pos} rotation={rot}>
      {/* Track */}
      <mesh position={[w / 2, -h / 2, 0]}>
        <planeGeometry args={[w, TRACK_H]} />
        <meshBasicMaterial color={PANEL_RIM} transparent opacity={0.5} />
      </mesh>

      {/* Fill */}
      <mesh position={[fillW / 2, -h / 2, 0.001]}>
        <planeGeometry args={[fillW, TRACK_H]} />
        <meshBasicMaterial color={ACCENT_COL} transparent opacity={0.85} />
      </mesh>

      {/* Label */}
      {primitive.label && (
        <Text
          anchorX="left"
          anchorY="bottom"
          position={[0, -h / 2 + TRACK_H / 2 + 0.006, 0.002]}
          fontSize={0.018}
          color={BODY_COL}
          maxWidth={w}
        >
          {primitive.label}
        </Text>
      )}
    </group>
  );
}

// ─────────────────────────────────────────────────────────────
// 10. XRImageMesh
// ─────────────────────────────────────────────────────────────

export interface XRImageMeshProps {
  primitive: import("../mapper/mapper").XRImage;
  entry: LayoutEntry;
}

/**
 * Image placeholder panel.
 *
 * In Phase 5 this will load the actual src as a texture.
 * For now it renders a framed placeholder with the alt text.
 */
export function XRImageMesh({ primitive, entry }: XRImageMeshProps) {
  const { pos, rot } = entryTransform(entry);
  const w = safeDim(entry.size.width);
  const h = safeDim(entry.size.height);
  const IMG_BG = "#111622";

  return (
    <group position={pos} rotation={rot}>
      {/* Frame */}
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
        />
      </RoundedBox>

      {/* Image icon — simple cross-lines placeholder */}
      <mesh position={[w / 2, -h / 2, 0.002]}>
        <planeGeometry args={[w * 0.4, 0.002]} />
        <meshBasicMaterial color={PANEL_RIM} transparent opacity={0.5} />
      </mesh>
      <mesh position={[w / 2, -h / 2, 0.002]} rotation={[0, 0, Math.PI / 2]}>
        <planeGeometry args={[h * 0.4, 0.002]} />
        <meshBasicMaterial color={PANEL_RIM} transparent opacity={0.5} />
      </mesh>

      {/* Alt text */}
      {(primitive.alt ?? primitive.label) && (
        <Text
          anchorX="center"
          anchorY="bottom"
          position={[w / 2, -h + 0.02, PANEL_DEPTH]}
          fontSize={0.016}
          color={BODY_COL}
          maxWidth={w - 0.04}
        >
          {primitive.alt ?? primitive.label ?? ""}
        </Text>
      )}
    </group>
  );
}

// ─────────────────────────────────────────────────────────────
// 11. XRCardMesh
// ─────────────────────────────────────────────────────────────

export interface XRCardMeshProps {
  primitive: import("../mapper/mapper").XRCard;
  entry: LayoutEntry;
  renderChild: (primitiveId: string) => React.ReactNode;
}

/**
 * Individual card in a card grid.
 * Renders a raised frosted panel with a subtle top accent stripe.
 */
export function XRCardMesh({ primitive, entry, renderChild }: XRCardMeshProps) {
  const { pos, rot } = entryTransform(entry);
  const w = safeDim(entry.size.width);
  const h = safeDim(entry.size.height);
  const ACCENT_H = 0.005;

  return (
    <group position={pos} rotation={rot}>
      {/* Card panel */}
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
        />
      </RoundedBox>

      {/* Top accent stripe */}
      <mesh position={[w / 2, -ACCENT_H / 2, 0.001]}>
        <planeGeometry args={[w, ACCENT_H]} />
        <meshBasicMaterial color={ACCENT_COL} transparent opacity={0.6} />
      </mesh>

      {/* Title */}
      {primitive.label && (
        <Text
          anchorX="left"
          anchorY="top"
          position={[0.014, -0.018, PANEL_DEPTH]}
          fontSize={0.022}
          color={HEADING_COL}
          fontWeight="600"
          maxWidth={w - 0.028}
        >
          {primitive.label}
        </Text>
      )}

      {primitive.children.map((child) => renderChild(child.id))}
    </group>
  );
}

// ─────────────────────────────────────────────────────────────
// 12. XRButtonMesh
// ─────────────────────────────────────────────────────────────

export interface XRButtonMeshProps {
  primitive: import("../mapper/mapper").XRButton;
  entry: LayoutEntry;
}

/**
 * Pressable button rendered as a pill-shaped XR affordance.
 */
export function XRButtonMesh({ primitive, entry }: XRButtonMeshProps) {
  const { ref, handlers } = useHoverScale(1.0, 1.04);
  const { pos, rot } = entryTransform(entry);
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
        />
      </RoundedBox>

      <Text
        anchorX="center"
        anchorY="middle"
        position={[w / 2, -h / 2, BTN_DEPTH + 0.001]}
        fontSize={0.02}
        color={isDisabled ? "#4a5568" : "#ffffff"}
        fontWeight="600"
        maxWidth={w - 0.02}
      >
        {primitive.label ?? ""}
      </Text>
    </group>
  );
}

// ─────────────────────────────────────────────────────────────
// 13. XRAlertMesh
// ─────────────────────────────────────────────────────────────

export interface XRAlertMeshProps {
  primitive: import("../mapper/mapper").XRAlert;
  entry: LayoutEntry;
}

/**
 * Alert / status notification panel.
 *
 * assertive alerts → red-tinted urgent panel
 * polite status   → muted blue-tinted panel
 */
export function XRAlertMesh({ primitive, entry }: XRAlertMeshProps) {
  const { pos, rot } = entryTransform(entry);
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
        />
      </RoundedBox>

      {/* Left alert stripe */}
      <mesh position={[0.004, -h / 2, 0.002]}>
        <planeGeometry args={[0.007, h * 0.8]} />
        <meshBasicMaterial color={alertColor} transparent opacity={0.9} />
      </mesh>

      <Text
        anchorX="left"
        anchorY="top"
        position={[0.02, -0.014, PANEL_DEPTH * 0.6]}
        fontSize={0.022}
        color={isAssertive ? "#ff9999" : BODY_COL}
        maxWidth={w - 0.032}
        lineHeight={1.4}
      >
        {primitive.label ?? ""}
      </Text>
    </group>
  );
}

// ─────────────────────────────────────────────────────────────
// 14. XRTableMesh
// ─────────────────────────────────────────────────────────────

export interface XRTableMeshProps {
  primitive: import("../mapper/mapper").XRTable;
  entry: LayoutEntry;
  renderChild: (primitiveId: string) => React.ReactNode;
}

/**
 * Data table rendered as a frosted grid panel.
 *
 * For Phase 4 we render the table label and a grid placeholder with
 * column/row count metadata. Row-level rendering is delegated to children.
 */
export function XRTableMesh({
  primitive,
  entry,
  renderChild,
}: XRTableMeshProps) {
  const { pos, rot } = entryTransform(entry);
  const w = safeDim(entry.size.width);
  const h = safeDim(entry.size.height);
  const HEADER_H = 0.04;

  return (
    <group position={pos} rotation={rot}>
      {/* Table panel */}
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
        />
      </RoundedBox>

      {/* Header bar */}
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
        />
      </RoundedBox>

      <Text
        anchorX="left"
        anchorY="middle"
        position={[0.014, -HEADER_H / 2, PANEL_DEPTH]}
        fontSize={0.018}
        color={HEADING_COL}
        fontWeight="600"
        maxWidth={w - 0.12}
      >
        {primitive.label ?? "Table"}
      </Text>

      {/* Column/row metadata */}
      <Text
        anchorX="right"
        anchorY="middle"
        position={[w - 0.01, -HEADER_H / 2, PANEL_DEPTH]}
        fontSize={0.014}
        color="#4a5568"
        maxWidth={0.1}
      >
        {`${primitive.columnCount}×${primitive.rowCount}`}
      </Text>

      {/* Children (rows) */}
      {primitive.children.map((child) => renderChild(child.id))}
    </group>
  );
}

// ─────────────────────────────────────────────────────────────
// 15. XRFormFieldMesh
// ─────────────────────────────────────────────────────────────

export interface XRFormFieldMeshProps {
  primitive: import("../mapper/mapper").XRFormField;
  entry: LayoutEntry;
}

/**
 * Individual form field — label + control placeholder.
 *
 * Renders a frosted input field with a label above and a
 * control-type indicator icon. Actual interaction is Phase 5.
 */
export function XRFormFieldMesh({ primitive, entry }: XRFormFieldMeshProps) {
  const { pos, rot } = entryTransform(entry);
  const w = safeDim(entry.size.width);
  const h = safeDim(entry.size.height);
  const INPUT_H = Math.min(0.038, h * 0.6);
  const INPUT_BG = "#0f1928";
  const label = primitive.resolvedLabel ?? primitive.label ?? "";

  return (
    <group position={pos} rotation={rot}>
      {/* Label text */}
      {label && (
        <Text
          anchorX="left"
          anchorY="bottom"
          position={[0, -(h - INPUT_H) + 0.002, 0.002]}
          fontSize={0.016}
          color={BODY_COL}
          maxWidth={w}
        >
          {label}
        </Text>
      )}

      {/* Input field backing */}
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
        />
      </RoundedBox>

      {/* Placeholder text */}
      {primitive.placeholder && (
        <Text
          anchorX="left"
          anchorY="middle"
          position={[0.01, -h + INPUT_H / 2, PANEL_DEPTH + 0.001]}
          fontSize={0.016}
          color="#4a5568"
          maxWidth={w - 0.02}
        >
          {primitive.placeholder}
        </Text>
      )}
    </group>
  );
}

// ─────────────────────────────────────────────────────────────
// 16. XRTabGroupMesh
// ─────────────────────────────────────────────────────────────

export interface XRTabGroupMeshProps {
  primitive: import("../mapper/mapper").XRTabGroup;
  entry: LayoutEntry;
  renderChild: (primitiveId: string) => React.ReactNode;
}

/**
 * Tab group — renders a tab strip above the active panel.
 */
export function XRTabGroupMesh({
  primitive,
  entry,
  renderChild,
}: XRTabGroupMeshProps) {
  const { pos, rot } = entryTransform(entry);
  const w = safeDim(entry.size.width);
  const h = safeDim(entry.size.height);
  const TAB_H = 0.042;
  const isHoriz = primitive.orientation !== "vertical";

  return (
    <group position={pos} rotation={rot}>
      {/* Tab strip backing */}
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
        />
      </RoundedBox>

      {/* Content area */}
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
        />
      </RoundedBox>

      {primitive.children.map((child) => renderChild(child.id))}
    </group>
  );
}
