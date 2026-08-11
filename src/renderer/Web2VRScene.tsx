/**
 * Web2VRScene — React Three Fiber component that renders a page's CSS layout
 * directly in 3D space using the Web2VR approach (kikoano/web2vr).
 *
 * Coordinate mapping (SCALE = 600, 1 CSS px = 1/600 world units):
 *   x = (domX + w/2) / SCALE - PAGE_W_M/2   (centred at x=0)
 *   y = topY - (domY + h/2) / SCALE         (y-inverted, counts down from topY)
 *   z = baseZ + depth * LAYER_STEP          (depth → z layering)
 *
 * `topY`/`baseZ` come from the active device profile — see `screenAnchor`. On
 * Quest a 1200×900 px viewport maps to a 2.0×1.5 m screen spanning
 * [-1,1] × [-0.1,1.4] × [-1.2].
 *
 * Depth moves each nesting level *toward* the viewer, which is what reproduces
 * CSS paint order: a child paints over its parent's background. Staggering the
 * other way buries the page — `<body>` is depth 0 with an opaque full-page
 * background, so pushing its descendants further away leaves nothing but that
 * one plane visible, and the scene reads as empty even though every element is
 * present and correctly placed.
 */

import React, { useState, useEffect } from "react";
import { Text } from "@react-three/drei";
import {
  extractWeb2VRLayout,
  type Web2VRElementData,
  SCALE,
  VIEWPORT_W,
  VIEWPORT_H,
} from "../ir/web2vr";
import type { RenderFrameDiagnostics } from "../ir/render-frame";
import type { LayoutConfig } from "../layout/types";

// ── Scene constants ────────────────────────────────────────────────────────────

const LAYER_STEP = 0.003;          // metres of z-offset per nesting depth level
const PAGE_W_M = VIEWPORT_W / SCALE; // 2.0 m — horizontal extent of virtual screen
const PAGE_H_M = VIEWPORT_H / SCALE; // 1.5 m — vertical extent of virtual screen

/**
 * Where the virtual screen hangs, derived from the active device profile.
 *
 * This used to be two hardcoded constants (`SCENE_Y = 1.4`, `SCENE_Z = -1.2`)
 * that put the screen's *centre* at 1.4 m — so its top edge sat at 2.15 m. The
 * preview camera stands at 1.5 m and aims at 0.95 m (`readingLook`), and with a
 * 60° lens its frustum only reaches y ≈ 1.61 m on the screen plane. Everything
 * above that was off-camera, and since a page is laid out from the TOP of the
 * screen downwards, any page shorter than ~half a viewport rendered entirely
 * into the invisible strip: correct geometry, correct colours, nothing on
 * screen.
 *
 * So anchor it the way every other panel in the app is anchored — top edge at
 * eye level, growing downwards — and take the standing-off distance from the
 * profile too, so this tracks Quest vs Ray-Ban instead of assuming Quest.
 */
function screenAnchor(cfg: LayoutConfig): { topY: number; z: number } {
  return {
    topY: cfg.eyeLevel + cfg.eyeLevelOffset,
    z: -cfg.viewingDistance,
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function Web2VRMesh({
  el,
  topY,
  baseZ,
}: {
  el: Web2VRElementData;
  topY: number;
  baseZ: number;
}) {
  // Map DOM pixel centre to 3D world position. The page's top-left is the
  // screen's top-left, so y counts DOWN from `topY`.
  const x = (el.domX + el.domWidth / 2) / SCALE - PAGE_W_M / 2;
  const y = topY - (el.domY + el.domHeight / 2) / SCALE;
  // Toward the camera with depth — CSS paint order. See the module docblock.
  const z = baseZ + el.depth * LAYER_STEP;
  const w = Math.max(el.domWidth / SCALE, 0.002);
  const h = Math.max(el.domHeight / SCALE, 0.002);

  // Discard elements that map fully outside the virtual screen
  if (
    x + w / 2 < -PAGE_W_M / 2 - 0.05 ||
    x - w / 2 > PAGE_W_M / 2 + 0.05 ||
    y + h / 2 < topY - PAGE_H_M - 0.05 ||
    y - h / 2 > topY + 0.05
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

/**
 * Why the scene is empty, in the reader's words.
 *
 * "No visible elements" and "the frame never rendered" look identical on screen
 * but mean opposite things, and conflating them is what let a permanently
 * broken extraction pass for a page that simply had nothing to show. The render
 * diagnostics distinguish them, so say which one happened.
 */
function emptyReason(render: RenderFrameDiagnostics): string {
  switch (render.status) {
    case "no-layout-engine":
      return "No CSS layout engine available in this environment.";
    case "frame-inaccessible":
      return "Render frame was unreadable — could not measure CSS layout.";
    case "timeout":
      return `Render timed out after ${(render.elapsedMs / 1000).toFixed(1)}s.`;
    case "error":
      return "Render failed while preparing the page.";
    case "rendered":
      return "Page rendered, but no visible elements were extracted.";
  }
}

export function Web2VRScene({
  html,
  url,
  layoutConfig,
}: {
  html: string;
  url?: string | null;
  /** Active device profile's layout config — places the virtual screen. */
  layoutConfig: LayoutConfig;
}) {
  const { topY, z: baseZ } = screenAnchor(layoutConfig);
  /** Centre of the virtual screen — where status text and the backing sit. */
  const centreY = topY - PAGE_H_M / 2;
  const [elements, setElements] = useState<Web2VRElementData[]>([]);
  const [background, setBackground] = useState("#ffffff");
  const [render, setRender] = useState<RenderFrameDiagnostics | null>(null);
  const [loading, setLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErrorMsg(null);
    setElements([]);
    setRender(null);

    extractWeb2VRLayout(html, url)
      .then((result) => {
        if (!cancelled) {
          setElements(result.elements);
          setBackground(result.background);
          setRender(result.render);
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
  }, [html, url]);

  if (loading) {
    return (
      <Text
        position={[0, centreY, baseZ]}
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
        position={[0, centreY, baseZ]}
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
        position={[0, centreY, baseZ]}
        fontSize={0.032}
        color="#4a6080"
        anchorX="center"
        anchorY="middle"
        maxWidth={PAGE_W_M}
        textAlign="center"
      >
        {render ? emptyReason(render) : "No visible elements extracted."}
      </Text>
    );
  }

  return (
    <>
      {/* Virtual screen backing — the document's own canvas colour, opaque, so
          an unstyled page reads as the browser's black-on-white rather than as
          black text lost against the scene's dark backdrop. */}
      <mesh position={[0, centreY, baseZ - 0.01]}>
        <planeGeometry args={[PAGE_W_M, PAGE_H_M]} />
        <meshStandardMaterial color={background} />
      </mesh>

      {/* Rendered elements */}
      {elements.map((el) => (
        <Web2VRMesh key={el.id} el={el} topY={topY} baseZ={baseZ} />
      ))}

      {/* Attribution label. Reports how much CSS actually applied: a frame that
          rendered with zero rules is geometrically valid but visually a
          default-styled document, and it should not read as "CSS layout → 3D". */}
      <Text
        position={[0, topY - PAGE_H_M - 0.07, baseZ]}
        fontSize={0.016}
        color="#253a50"
        anchorX="center"
        anchorY="top"
        letterSpacing={0.05}
      >
        {`WEB2VR  ·  ${elements.length} elements  ·  ${
          render && render.cssRulesApplied > 0
            ? `${render.cssRulesApplied} CSS rules → 3D`
            : "no CSS applied — default styles"
        }`}
      </Text>
    </>
  );
}
