/**
 * Web2VRScene — React Three Fiber component that renders a page's CSS layout
 * directly in 3D space using the Web2VR approach (kikoano/web2vr).
 *
 * Coordinate mapping (SCALE = 600, 1 CSS px = 1/600 world units):
 *   x = (domX + w/2) / SCALE  - PAGE_W_M/2         (centered at x=0)
 *   y = -((domY + h/2) / SCALE) + SCENE_Y + PAGE_H_M/2  (y-inverted, eye-height)
 *   z = SCENE_Z - depth * LAYER_STEP               (depth → z layering)
 *
 * A 1200×900 px viewport maps to a 2.0×1.5 m panel at [-1,1]×[0.65,2.15]×[-1.2].
 */

import React, { useState, useEffect } from "react";
import { Text } from "@react-three/drei";
import {
  extractWeb2VRLayout,
  type Web2VRElementData,
  SCALE,
} from "../ir/web2vr";

// ── Scene constants ────────────────────────────────────────────────────────────

const LAYER_STEP = 0.003;       // metres of z-offset per nesting depth level
const SCENE_Z = -1.2;           // base z position (same as content panel)
const SCENE_Y = 1.4;            // eye height (vertical centre of virtual screen)
const PAGE_W_M = 1200 / SCALE;  // 2.0 m  — horizontal extent of virtual screen
const PAGE_H_M = 900 / SCALE;   // 1.5 m  — vertical extent of virtual screen

// ── Helpers ───────────────────────────────────────────────────────────────────

function Web2VRMesh({ el }: { el: Web2VRElementData }) {
  // Map DOM pixel centre to 3D world position
  const x = (el.domX + el.domWidth / 2) / SCALE - PAGE_W_M / 2;
  const y = -((el.domY + el.domHeight / 2) / SCALE) + SCENE_Y + PAGE_H_M / 2;
  const z = SCENE_Z - el.depth * LAYER_STEP;
  const w = Math.max(el.domWidth / SCALE, 0.002);
  const h = Math.max(el.domHeight / SCALE, 0.002);

  // Discard elements that map fully outside the virtual screen
  if (
    x + w / 2 < -PAGE_W_M / 2 - 0.05 ||
    x - w / 2 > PAGE_W_M / 2 + 0.05 ||
    y + h / 2 < SCENE_Y - PAGE_H_M / 2 - 0.05 ||
    y - h / 2 > SCENE_Y + PAGE_H_M / 2 + 0.05
  ) {
    return null;
  }

  const showBg = el.bgColor !== null && el.bgAlpha > 0.04;
  const showBorder = el.borderColor !== null && el.borderWidth >= 1;
  const showText = el.text.length > 0 && h > 0.014;
  const fontSize = Math.max(0.006, (el.fontSize / SCALE) * 0.88);

  return (
    <group position={[x, y, z]}>
      {/* Background plane */}
      {showBg && (
        <mesh>
          <planeGeometry args={[w, h]} />
          <meshStandardMaterial
            color={el.bgColor!}
            transparent
            opacity={Math.min(1, el.bgAlpha)}
            depthWrite={false}
          />
        </mesh>
      )}

      {/* Border: thin frame rendered as a slightly-larger darker backing */}
      {showBorder && !showBg && (
        <mesh position={[0, 0, -0.0003]}>
          <planeGeometry args={[w + el.borderWidth / SCALE * 2, h + el.borderWidth / SCALE * 2]} />
          <meshStandardMaterial
            color={el.borderColor!}
            transparent
            opacity={0.6}
            depthWrite={false}
          />
        </mesh>
      )}

      {/* Text content */}
      {showText && (
        <Text
          position={[0, 0, 0.001]}
          fontSize={fontSize}
          color={el.textColor}
          anchorX="center"
          anchorY="middle"
          maxWidth={w - 0.004}
          overflowWrap="break-word"
          textAlign="left"
        >
          {el.text.slice(0, 160)}
        </Text>
      )}
    </group>
  );
}

// ── Main scene component ───────────────────────────────────────────────────────

export function Web2VRScene({ html }: { html: string }) {
  const [elements, setElements] = useState<Web2VRElementData[]>([]);
  const [loading, setLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErrorMsg(null);
    setElements([]);

    extractWeb2VRLayout(html)
      .then((els) => {
        if (!cancelled) {
          setElements(els);
          setLoading(false);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setErrorMsg(err instanceof Error ? err.message : "Extraction failed");
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [html]);

  if (loading) {
    return (
      <Text
        position={[0, SCENE_Y, SCENE_Z]}
        fontSize={0.038}
        color="#58a6ff"
        anchorX="center"
        anchorY="middle"
      >
        Computing CSS layout…
      </Text>
    );
  }

  if (errorMsg) {
    return (
      <Text
        position={[0, SCENE_Y, SCENE_Z]}
        fontSize={0.032}
        color="#f6a623"
        anchorX="center"
        anchorY="middle"
      >
        {errorMsg}
      </Text>
    );
  }

  if (elements.length === 0) {
    return (
      <Text
        position={[0, SCENE_Y, SCENE_Z]}
        fontSize={0.032}
        color="#4a6080"
        anchorX="center"
        anchorY="middle"
      >
        No visible elements extracted.
      </Text>
    );
  }

  return (
    <>
      {/* Virtual screen backing */}
      <mesh position={[0, SCENE_Y, SCENE_Z - 0.01]}>
        <planeGeometry args={[PAGE_W_M, PAGE_H_M]} />
        <meshStandardMaterial color="#080c14" transparent opacity={0.55} />
      </mesh>

      {/* Rendered elements */}
      {elements.map((el) => (
        <Web2VRMesh key={el.id} el={el} />
      ))}

      {/* Attribution label */}
      <Text
        position={[0, SCENE_Y - PAGE_H_M / 2 - 0.07, SCENE_Z]}
        fontSize={0.016}
        color="#253a50"
        anchorX="center"
        anchorY="top"
        letterSpacing={0.05}
      >
        {`WEB2VR  ·  ${elements.length} elements  ·  CSS layout → 3D`}
      </Text>
    </>
  );
}
