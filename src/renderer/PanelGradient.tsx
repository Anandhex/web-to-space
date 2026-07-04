/**
 * PanelGradient.tsx
 *
 * Subtle vertical gradient overlay for main panel backings — Meta Horizon
 * panels are not a perfectly flat fill; they read as a soft top-to-bottom
 * gradient (lighter at the top edge, darker toward the bottom). Rather than
 * a UV-mapped gradient texture (distorts on RoundedBox's rounded corners),
 * this renders a single flat quad with per-vertex colour just in front of
 * the panel's front face — cheap, distortion-free, and independently
 * themeable via XRTheme.panelGradientTop / panelGradientBottom.
 */

import React, { useMemo } from "react";
import * as THREE from "three";

/**
 * Builds a 1x1-segment PlaneGeometry with vertex colours going from
 * bottomHex (bottom edge) to topHex (top edge).
 *
 * Three.js's PlaneGeometry emits vertices row-by-row starting at the
 * bottom (y = -height/2) and ending at the top (y = +height/2), so the
 * vertex order for a 1x1 grid is [bottom-left, bottom-right, top-left,
 * top-right].
 */
function useVerticalGradientGeometry(
  width: number,
  height: number,
  topHex: string,
  bottomHex: string,
): THREE.PlaneGeometry {
  return useMemo(() => {
    const geo = new THREE.PlaneGeometry(
      Math.max(width, 0.001),
      Math.max(height, 0.001),
      1,
      1,
    );
    const top = new THREE.Color(topHex);
    const bottom = new THREE.Color(bottomHex);
    const colors = new Float32Array([
      bottom.r, bottom.g, bottom.b,
      bottom.r, bottom.g, bottom.b,
      top.r, top.g, top.b,
      top.r, top.g, top.b,
    ]);
    geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    return geo;
  }, [width, height, topHex, bottomHex]);
}

export interface PanelGradientOverlayProps {
  /** Panel width/height in metres (same as the RoundedBox it sits in front of). */
  width: number;
  height: number;
  /** Centre position — pass the same (x, y) as the panel with z just in front of its front face. */
  position: [number, number, number];
  topColor: string;
  bottomColor: string;
  opacity?: number;
  clippingPlanes?: THREE.Plane[];
}

export function PanelGradientOverlay({
  width,
  height,
  position,
  topColor,
  bottomColor,
  opacity = 1,
  clippingPlanes,
}: PanelGradientOverlayProps) {
  const geometry = useVerticalGradientGeometry(width, height, topColor, bottomColor);
  return (
    <mesh geometry={geometry} position={position}>
      <meshBasicMaterial
        vertexColors
        transparent
        opacity={opacity}
        clippingPlanes={clippingPlanes}
        depthWrite={false}
      />
    </mesh>
  );
}
