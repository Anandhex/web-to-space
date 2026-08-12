/**
 * primitives/scroll-viewport.tsx
 *
 * A fixed-size window onto taller content, with the same two gestures the TOC
 * rail uses: drag the surface (mouse in the flat preview, controller ray in XR
 * — both arrive as R3F pointer events) and the wheel as a convenience.
 *
 * Landmark slots are a fixed rectangle and `stackChildrenSimple` cannot
 * paginate, so anything taller than the slot used to be clipped away with no
 * way to reach it — a news front's aside is routinely 15–25% taller than the
 * 0.9 m rail it lands in. This gives that content somewhere to go.
 *
 * The caller owns the clip planes. They are world-space and static for a
 * landmark panel (the slot does not move), so scrolling is a pure translation
 * of the content group inside them — nothing here needs to touch clipping.
 */
import React from "react";
import * as THREE from "three";
import { useThree } from "@react-three/fiber";

import { useTheme } from "../theme";
import { usePanelCurve, curvePoint } from "./curve";
import { Z_LAYER_ACCENT, Z_LAYER_BODY_TEXT } from "./constants";

/**
 * Set for the rest of the gesture once a drag actually moves, so a link under
 * the pointer can suppress its own click on release. Dragging a panel by its
 * text must scroll it, not navigate away.
 */
export const ScrollDragContext =
  React.createContext<React.MutableRefObject<boolean> | null>(null);

/** True when the current click is really the tail of a drag — and clears it. */
export function useConsumeScrollDrag(): () => boolean {
  const dragRef = React.useContext(ScrollDragContext);
  return React.useCallback(() => {
    if (!dragRef?.current) return false;
    dragRef.current = false;
    return true;
  }, [dragRef]);
}

export interface ScrollViewportProps {
  /** Panel width, metres — the scroll capture surface and bar span it. */
  width: number;
  /** Visible height, metres. Content taller than this scrolls. */
  height: number;
  /** Full height of the content, metres. <= height means no scrolling. */
  contentHeight: number;
  /** Local Y of the viewport's top edge. Panels are top-left anchored, so 0. */
  topY?: number;
  children: React.ReactNode;
}

export function ScrollViewport({
  width,
  height,
  contentHeight,
  topY = 0,
  children,
}: ScrollViewportProps) {
  const theme = useTheme();
  const { gl } = useThree();

  const maxScroll = Math.max(0, contentHeight - height);
  const scrollable = maxScroll > 1e-6;

  const [scroll, setScroll] = React.useState(0);
  // Re-clamp if the content or the viewport changes out from under us (a page
  // turn swaps the aside's contents without unmounting this).
  React.useEffect(() => {
    setScroll((s) => THREE.MathUtils.clamp(s, 0, maxScroll));
  }, [maxScroll]);

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

  // Grab-style drag: content follows the pointer (drag down → earlier content).
  // Screen-Y based, so the factor is approximate and tuned for a panel at
  // reading distance — same constants as the TOC rail so both rails feel alike.
  const dragging = React.useRef(false);
  const lastPointerY = React.useRef(0);
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

  // The panel bends onto the reading cylinder, so anything drawn at a fixed
  // panel-local x must be tangent-placed on that arc. The scrollbar sits at the
  // FAR RIGHT edge, where the chord deviates from the arc most — left flat it
  // hangs off the panel in depth and reads as content spilling outside it.
  const curve = usePanelCurve();
  const place = (
    x: number,
    y: number,
    z: number,
  ): {
    position: [number, number, number];
    rotation: [number, number, number];
  } => {
    if (!curve) return { position: [x, y, z], rotation: [0, 0, 0] };
    const p = curvePoint(x, y, z, curve.radius, curve.centerX);
    return { position: p.position, rotation: [0, p.yaw, 0] };
  };

  // Scrollbar geometry — a hairline track with a proportional thumb.
  const trackX = width - 0.006;
  const thumbH = Math.max(
    0.02,
    height * (height / Math.max(contentHeight, height)),
  );
  const thumbTravel = height - thumbH;
  const thumbTop =
    topY - (maxScroll > 0 ? (scroll / maxScroll) * thumbTravel : 0);

  return (
    <>
      {/* Transparent capture surface. In front of the panel backing but behind
          the content, so a click on a link still reaches the link while wheel
          and drag — which content meshes do not handle — fall through here. */}
      <mesh
        {...place(width / 2, topY - height / 2, Z_LAYER_ACCENT)}
        onWheel={handleWheel as any}
        onPointerDown={handleDragStart}
        onPointerMove={handleDragMove}
        onPointerUp={handleDragEnd}
        onPointerLeave={handleDragEnd}
      >
        <planeGeometry args={[width, height]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} />
      </mesh>

      <ScrollDragContext.Provider value={didDrag}>
        <group position={[0, scroll, 0]}>{children}</group>
      </ScrollDragContext.Provider>

      {scrollable && (
        <group>
          <mesh {...place(trackX, topY - height / 2, Z_LAYER_ACCENT)}>
            <planeGeometry args={[0.004, height]} />
            <meshBasicMaterial
              color={theme.panelRim}
              transparent
              opacity={0.4}
            />
          </mesh>
          <mesh
            {...place(trackX, thumbTop - thumbH / 2, Z_LAYER_BODY_TEXT)}
          >
            <planeGeometry args={[0.004, thumbH]} />
            <meshBasicMaterial
              color={theme.mutedTextCol}
              transparent
              opacity={0.9}
            />
          </mesh>
        </group>
      )}
    </>
  );
}
