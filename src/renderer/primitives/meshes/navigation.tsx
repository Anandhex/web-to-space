/**
 * primitives/meshes/navigation.tsx
 *
 * Navigation bar + table-of-contents panel: an arc/strip of link chips with
 * hover and click-to-navigate behaviour.
 */
import React from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";

import type {
  XRNavigationBar,
  XRLink,
} from "../../../mapper/types";
import type { LayoutEntry } from "../../../layout/types";
import { useTheme } from "../../theme";
import {
  Z_LAYER_ACCENT,
  Z_LAYER_INLINE_TEXT,
  Z_LAYER_BODY_TEXT,
  PANEL_DEPTH,
} from "../constants";
import { Surface, safeDim, cornerRadius, entryTransform } from "../surface";
import { ClipPlanesContext, useClipPlanes } from "../contexts";
import {
  PanelCurveContext,
  resolveCurveRadius,
  curvePoint,
  type PanelCurve,
} from "../curve";
import { ClippedText } from "../inline";

export interface XRNavigationMeshProps {
  primitive: XRNavigationBar;
  entry: LayoutEntry;
  onNavigate?: (href: string) => void;
}

interface TOCPanelProps {
  items: XRLink[];
  w: number;
  h: number;
  pos: THREE.Vector3;
  rot: THREE.Euler;
  label: string;
  clips: THREE.Plane[];
  curveRadius: number;
  onNavigate?: (href: string) => void;
}

/**
 * Scrollable vertical table-of-contents panel.
 *
 * The item list can exceed the panel height, so items live in a group whose Y
 * is driven by a `scroll` offset and are clipped to a fixed viewport region
 * below the header via world-space horizontal clip planes. Scrolling is driven
 * by wheel input in the inline preview; the same setScroll is where an XR
 * controller thumbstick would hook in. A thin scrollbar on the right edge
 * signals position and only appears when the content actually overflows.
 *
 * The clip planes are world-space horizontal (normal along Y). This stays
 * correct while the panel is only yawed to face the user (a Y-axis rotation
 * leaves world-Y aligned with the panel's vertical axis); a pitched/rolled
 * panel would need panel-local planes instead.
 */
function TOCPanel({
  items,
  w,
  h,
  pos,
  rot,
  label,
  clips,
  curveRadius,
  onNavigate,
}: TOCPanelProps) {
  const theme = useTheme();

  // Bend the panel onto the shared cylinder (centred on its own width). The
  // scroll clip planes are horizontal (normal along Y) and the bend is around
  // the vertical axis, so Y — and thus the scroll culling — is unaffected.
  const navRadius = resolveCurveRadius(curveRadius);
  const navCurve: PanelCurve | null = navRadius
    ? { radius: navRadius, centerX: w / 2 }
    : null;
  // Tangent-place a panel-local point on the cylinder (identity when flat).
  const place = (
    x: number,
    y: number,
    z: number,
  ): { position: [number, number, number]; rotation: [number, number, number] } =>
    navCurve
      ? (() => {
          const p = curvePoint(x, y, z, navCurve.radius, navCurve.centerX);
          return { position: p.position, rotation: [0, p.yaw, 0] };
        })()
      : { position: [x, y, z], rotation: [0, 0, 0] };

  const ITEM_H = 0.052;
  const ITEM_GAP = 0.006;
  const INDENT_STEP = 0.018; // metres per depth level
  const PADDING = 0.014;
  const HEADER_H = PADDING * 3; // label band above the scroll viewport
  const BOTTOM_PAD = PADDING;

  const step = ITEM_H + ITEM_GAP;
  const contentTop = -HEADER_H; // local Y of the scroll viewport's top edge
  const visibleH = Math.max(step, h - HEADER_H - BOTTOM_PAD);
  const totalH = items.length * step;
  const maxScroll = Math.max(0, totalH - visibleH);
  const scrollable = maxScroll > 1e-6;

  const [scroll, setScroll] = React.useState(0);
  // Re-clamp if the content or viewport size changes out from under us.
  React.useEffect(() => {
    setScroll((s) => THREE.MathUtils.clamp(s, 0, maxScroll));
  }, [maxScroll]);

  // Clip planes bounding the scroll viewport (header bottom → panel bottom).
  //
  // They MUST be derived from the panel's real world transform, which is NOT
  // available as `pos` here: this mesh receives a zeroedEntry() (pos = rot = 0)
  // while an outer <AtPos> applies the true world position/rotation. So instead
  // of hardcoding a world Y, we keep two stable Plane instances, define them in
  // the panel's LOCAL frame, and re-project them through the group's
  // matrixWorld every frame (mutated in place — troika/standard materials
  // already hold these instances, so they pick up the update with no
  // re-render). This is also correct under arbitrary yaw/pitch.
  const groupRef = React.useRef<THREE.Group>(null);
  const clipPlanes = React.useMemo(
    () => [
      new THREE.Plane(new THREE.Vector3(0, -1, 0), 0), // keep y ≤ viewport top
      new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), // keep y ≥ viewport bottom
    ],
    [],
  );
  const itemClips = React.useMemo(
    () => [...clips, ...clipPlanes],
    [clips, clipPlanes],
  );
  // Local-frame viewport bounds (fixed; items scroll within this band).
  const topLocalY = contentTop;
  const bottomLocalY = -(h - BOTTOM_PAD);
  useFrame(() => {
    const g = groupRef.current;
    if (!g) return;
    // Force the world matrix current regardless of where useFrame sits relative
    // to the renderer's own matrix update (matters in the XR animation loop and
    // on the very first frame).
    g.updateWorldMatrix(true, false);
    const m = g.matrixWorld;
    clipPlanes[0].set(new THREE.Vector3(0, -1, 0), topLocalY);
    clipPlanes[0].applyMatrix4(m);
    clipPlanes[1].set(new THREE.Vector3(0, 1, 0), -bottomLocalY);
    clipPlanes[1].applyMatrix4(m);
  });

  const handleWheel = React.useCallback(
    (e: { deltaY: number; stopPropagation: () => void }) => {
      if (!scrollable) return;
      e.stopPropagation();
      setScroll((s) =>
        THREE.MathUtils.clamp(s + e.deltaY * 0.0002, 0, maxScroll),
      );
    },
    [scrollable, maxScroll],
  );

  // Drag-to-scroll: press and drag the panel up/down. Works with a mouse in
  // the flat preview AND an XR controller ray (both surface as R3F pointer
  // events), so it's the primary, discoverable scroll gesture — the wheel is a
  // convenience on top. Grab-style: content follows the pointer (drag down →
  // earlier items). Screen-Y based, so the factor is approximate and tuned for
  // a panel at typical reading distance.
  const { gl } = useThree();
  const dragging = React.useRef(false);
  const lastPointerY = React.useRef(0);
  // Set once a drag actually moves, so the item under the pointer can suppress
  // its click on release (drag-to-scroll must not also navigate).
  const didDrag = React.useRef(false);

  const handleDragStart = React.useCallback(
    (e: any) => {
      if (!scrollable) return;
      e.stopPropagation();
      dragging.current = true;
      didDrag.current = false;
      lastPointerY.current = e.clientY ?? e.nativeEvent?.clientY ?? 0;
      gl.domElement.setPointerCapture?.(e.pointerId);
    },
    [scrollable, gl],
  );
  const handleDragMove = React.useCallback(
    (e: any) => {
      if (!dragging.current) return;
      const y = e.clientY ?? e.nativeEvent?.clientY ?? 0;
      const dy = y - lastPointerY.current;
      if (Math.abs(dy) > 1) didDrag.current = true;
      lastPointerY.current = y;
      setScroll((s) => THREE.MathUtils.clamp(s - dy * 0.0016, 0, maxScroll));
    },
    [maxScroll],
  );
  const handleDragEnd = React.useCallback(
    (e: any) => {
      dragging.current = false;
      gl.domElement.releasePointerCapture?.(e.pointerId);
    },
    [gl],
  );

  // Scrollbar geometry.
  const trackX = w - PADDING * 0.45;
  const thumbH = Math.max(
    0.02,
    visibleH * (visibleH / Math.max(totalH, visibleH)),
  );
  const thumbTravel = visibleH - thumbH;
  const thumbTop =
    contentTop - (maxScroll > 0 ? (scroll / maxScroll) * thumbTravel : 0);

  const headerPlace = place(PADDING, -PADDING, Z_LAYER_BODY_TEXT);

  return (
    <group ref={groupRef} position={pos} rotation={rot}>
      <PanelCurveContext.Provider value={navCurve}>
      {/* Panel backing — uses panelBg (identical to the XRContentPanel) so the
          TOC/nav reads as the same panel material as the main content, not a
          distinct surface. navBg is reserved for the small item chips. Bends
          with the item rows when curved (explicit curve — the backing isn't
          tangent-placed by an outer group). */}
      <Surface
        width={w}
        height={h}
        color={theme.panelBg}
        clips={clips}
        curve={navCurve}
      />

      {/* Panel label (fixed header, not scrolled) */}
      <group position={headerPlace.position} rotation={headerPlace.rotation}>
        <ClippedText
          anchorX="left"
          anchorY="top"
          position={[0, 0, 0]}
          fontSize={0.014}
          color={theme.bodyCol}
          fontWeight="700"
          letterSpacing={0.08}
        >
          {label.toUpperCase()}
        </ClippedText>
      </group>

      {/* Transparent scroll-capture surface over the viewport. Sits in front
          of the backing but behind the item rows, so item clicks still win for
          navigation while wheel + drag events (which the rows don't handle)
          fall through to here. */}
      <mesh
        position={[w / 2, contentTop - visibleH / 2, Z_LAYER_ACCENT]}
        onWheel={handleWheel as any}
        onPointerDown={handleDragStart}
        onPointerMove={handleDragMove}
        onPointerUp={handleDragEnd}
        onPointerLeave={handleDragEnd}
      >
        <planeGeometry args={[w, visibleH]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} />
      </mesh>

      {/* Scrolling item rows, clipped to the viewport */}
      <ClipPlanesContext.Provider value={itemClips}>
        <group position={[0, scroll, 0]}>
          {items.map((item, i) => {
            const itemY = contentTop - i * step;
            const indent = PADDING + (item.depth ?? 0) * INDENT_STEP;
            const isCurrent = item.isCurrent;
            const itemW = w - indent - PADDING;
            const itemPlace = place(indent, itemY, Z_LAYER_INLINE_TEXT);

            return (
              <group
                key={item.id}
                position={itemPlace.position}
                rotation={itemPlace.rotation}
                onClick={() => {
                  // Suppress navigation if this "click" was the end of a drag.
                  if (didDrag.current) {
                    didDrag.current = false;
                    return;
                  }
                  if (item.href) onNavigate?.(item.href);
                }}
              >
                {/* Hit-area plane for easier pointing */}
                <mesh position={[itemW / 2, -ITEM_H / 2, 0.0005]}>
                  <planeGeometry args={[itemW, ITEM_H]} />
                  <meshBasicMaterial
                    transparent
                    opacity={0}
                    depthWrite={false}
                    clippingPlanes={itemClips}
                  />
                </mesh>

                {/* Selected-row highlight — solid, high-contrast rounded pill. */}
                {isCurrent && (
                  <Surface
                    width={itemW + PADDING * 0.6}
                    height={ITEM_H * 0.92}
                    radius={cornerRadius(
                      itemW + PADDING * 0.6,
                      ITEM_H * 0.92,
                      (ITEM_H * 0.92) / 2,
                    )}
                    color={theme.emphasisCol}
                    origin={[itemW / 2 - PADDING * 0.3, -ITEM_H / 2]}
                    clips={itemClips}
                  />
                )}
                <ClippedText
                  anchorX="left"
                  anchorY="top"
                  position={[0, 0, 0.002]}
                  fontSize={item.depth === 0 ? 0.022 : 0.018}
                  color={
                    isCurrent
                      ? theme.panelBg
                      : item.depth === 0
                        ? theme.headingCol
                        : theme.bodyCol
                  }
                  fontWeight={
                    isCurrent ? "700" : item.depth === 0 ? "600" : "400"
                  }
                  maxWidth={itemW}
                  lineHeight={1.3}
                >
                  {item.label ?? ""}
                </ClippedText>
              </group>
            );
          })}
        </group>
      </ClipPlanesContext.Provider>

      {/* Scrollbar (only when content overflows) */}
      {scrollable && (
        <group>
          <mesh position={[trackX, contentTop - visibleH / 2, Z_LAYER_ACCENT]}>
            <planeGeometry args={[0.004, visibleH]} />
            <meshBasicMaterial
              color={theme.panelRim}
              transparent
              opacity={0.4}
            />
          </mesh>
          <mesh position={[trackX, thumbTop - thumbH / 2, Z_LAYER_BODY_TEXT]}>
            <planeGeometry args={[0.004, thumbH]} />
            <meshBasicMaterial
              color={theme.mutedTextCol}
              transparent
              opacity={0.9}
            />
          </mesh>
        </group>
      )}
      </PanelCurveContext.Provider>
    </group>
  );
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
export function XRNavigationMesh({
  primitive,
  entry,
  onNavigate,
}: XRNavigationMeshProps) {
  const { pos, rot } = entryTransform(entry);
  const clips = useClipPlanes();
  const theme = useTheme();
  const items: XRLink[] = primitive.items ?? [];
  const w = safeDim(entry.size.width);
  const h = safeDim(entry.size.height);

  const isTOC = h > w;

  // ── Vertical TOC layout — scrollable container ────────────────────────────
  if (isTOC) {
    return (
      <TOCPanel
        items={items}
        w={w}
        h={h}
        pos={pos}
        rot={rot}
        label={primitive.label ?? "Contents"}
        clips={clips}
        curveRadius={entry.curveRadius}
        onNavigate={onNavigate}
      />
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

  // Bend the whole strip onto one cylinder centred on the panel (centerX = w/2)
  // so the backing, chip pills, and labels all share it. The effective radius
  // folds in the global curve knob; a null result (knob off / no radius) keeps
  // the classic flat left-to-right strip untouched.
  const navRadius = resolveCurveRadius(entry.curveRadius);
  const centerX = w / 2;
  const navCurve: PanelCurve | null = navRadius
    ? { radius: navRadius, centerX }
    : null;

  const arcTotal = navRadius
    ? 2 * Math.asin(Math.min(1, w / (2 * navRadius)))
    : 0;
  const arcStep = items.length > 1 ? arcTotal / (items.length - 1) : 0;
  const arcStart = -arcTotal / 2;

  return (
    <PanelCurveContext.Provider value={navCurve}>
      <group position={pos} rotation={rot}>
        {/* Nav panel backing — uses panelBg so it matches the XRContentPanel
            material (navBg stays for the item chips). Bends with the chips when
            curved (explicit curve since the backing isn't wrapped in <AtPos>). */}
        <Surface
          width={w}
          height={h}
          color={theme.panelBg}
          clips={clips}
          curve={navCurve}
        />

        {/* Nav chips */}
        {items.map((item, i) => {
          const chipAngle = arcStart + i * arcStep;
          // Curved: place the chip on the cylinder centred at w/2 (matches the
          // backing). Flat: the classic left-to-right strip.
          const chipX = navRadius
            ? centerX + navRadius * Math.sin(chipAngle)
            : CHIP_GAP + i * (chipW + CHIP_GAP);
          const chipZ = navRadius ? navRadius * (1 - Math.cos(chipAngle)) : 0;
          const isCurrent = item.isCurrent;

          return (
          <group
            key={item.id}
            position={[chipX, -h / 2, chipZ + PANEL_DEPTH * 0.5]}
            rotation={[0, -chipAngle, 0]}
          >
            {/* Chip body — flat pill. Current/active chip uses the same
                monochrome "Primary Button" treatment as XRButtonMesh (solid
                emphasisCol fill, panelBg text) — the Horizon UI Set reserves
                colour (blue/red) for links and destructive actions, not
                general primary controls. Inactive chips get a hairline rim. */}
            <Surface
              width={chipW}
              height={CHIP_H}
              radius={cornerRadius(chipW, CHIP_H, CHIP_H / 2)}
              color={isCurrent ? theme.emphasisCol : theme.navBg}
              gradient={!isCurrent}
              opacity={isCurrent ? 1 : 0.96}
              roughness={isCurrent ? 0.4 : 0.7}
              rimColor={!isCurrent ? theme.panelRim : undefined}
              rimOpacity={0.8}
              origin={[0, 0]}
              clips={clips}
            />

            <ClippedText
              anchorX="center"
              anchorY="middle"
              position={[0, 0, Z_LAYER_BODY_TEXT]}
              fontSize={0.018}
              color={isCurrent ? theme.panelBg : theme.bodyCol}
              maxWidth={chipW - 0.016}
              fontWeight={isCurrent ? "600" : "400"}
            >
              {item.label ?? item.href ?? ""}
            </ClippedText>
          </group>
        );
      })}
      </group>
    </PanelCurveContext.Provider>
  );
}

// ─────────────────────────────────────────────────────────────
// 5. XRMediaMesh
// ─────────────────────────────────────────────────────────────

