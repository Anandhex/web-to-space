/**
 * primitives/meshes/media.tsx
 *
 * Media player + image meshes: video/audio panels and image/poster planes
 * (with a dev CORS-proxy for cross-origin sources).
 */
import React from "react";
import * as THREE from "three";

import type { XRMediaPlayer } from "../../../mapper/types";
import type { LayoutEntry } from "../../../layout/types";
import { useTheme } from "../../theme";
import {
  Z_LAYER_IMAGE,
  Z_LAYER_OVERLAY_TEXT,
  RENDER_ORDER_IMAGE,
  RENDER_ORDER_TEXT,
} from "../constants";
import { Surface, safeDim, entryTransform } from "../surface";
import { useClipPlanes } from "../contexts";
import { ClippedText } from "../inline";
import { proxyImageSrc } from "../../../proxy";

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
  const theme = useTheme();
  const w = safeDim(entry.size.width);
  const h = safeDim(entry.size.height);
  const isAudio = primitive.mediaType === "audio";
  // Icon geometry previously used a literal `1` (metre) base unit, completely
  // unscaled to the panel's actual (centimetre-scale) size — reading as an
  // oversized/clipped stub rather than an intentional placeholder. Scale to
  // a fraction of the panel's smaller dimension instead, clamped to a
  // sensible range.
  const ICON_SIZE = Math.min(0.08, Math.max(0.03, Math.min(w, h) * 0.3));

  // Poster/thumbnail background, loaded the same way XRImageMesh loads its
  // texture — makes the placeholder read as a real media widget rather than
  // a flat placeholder color, without wiring up actual playback.
  const proxiedPoster = primitive.poster ? proxyImageSrc(primitive.poster) : "";
  const [posterTexture, setPosterTexture] =
    React.useState<THREE.Texture | null>(null);

  React.useEffect(() => {
    setPosterTexture(null);
    if (!proxiedPoster) return;
    let cancelled = false;
    const loader = new THREE.TextureLoader();
    loader.load(
      proxiedPoster,
      (loaded) => {
        loaded.colorSpace = THREE.SRGBColorSpace;
        if (!cancelled) setPosterTexture(loaded);
      },
      undefined,
      () => {
        // Broken/unreachable poster — leave null so the plain backing
        // panel renders instead.
      },
    );
    return () => {
      cancelled = true;
    };
  }, [proxiedPoster]);

  return (
    <group position={pos} rotation={rot}>
      {/* Backing panel — flat Horizon card (kept dark behind media) */}
      <Surface width={w} height={h} color={theme.mediaBg} clips={clips} />

      {/* Poster thumbnail — sits between the backing panel and the icon
          overlay so the play/audio icon still reads on top of it. */}
      {posterTexture && (
        <mesh
          position={[w / 2, -h / 2, Z_LAYER_IMAGE]}
          renderOrder={RENDER_ORDER_IMAGE}
        >
          <planeGeometry args={[w, h]} />
          <meshBasicMaterial
            map={posterTexture}
            transparent
            clippingPlanes={clips}
          />
        </mesh>
      )}

      {/* Play / audio icon */}
      <group position={[w / 2, -h / 2, Z_LAYER_OVERLAY_TEXT]}>
        {isAudio ? (
          <>
            {[-0.012, 0, 0.012].map((xOff, i) => (
              <mesh
                key={i}
                position={[xOff, 0, 0]}
                renderOrder={RENDER_ORDER_TEXT}
              >
                <boxGeometry
                  args={[0.006, ICON_SIZE * (0.5 + i * 0.3), 0.002]}
                />
                <meshBasicMaterial
                  color={theme.accentCol}
                  transparent
                  opacity={0.85}
                  clippingPlanes={clips}
                />
              </mesh>
            ))}
          </>
        ) : (
          <mesh rotation={[0, 0, 0]} renderOrder={RENDER_ORDER_TEXT}>
            <coneGeometry args={[ICON_SIZE * 0.6, ICON_SIZE, 3, 1]} />
            <meshBasicMaterial
              color={theme.accentCol}
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
          position={[w / 2, -h + 0.03, Z_LAYER_OVERLAY_TEXT]}
          renderOrder={RENDER_ORDER_TEXT}
          fontSize={0.02}
          color={theme.bodyCol}
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
              background: theme.mediaBg,
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


export interface XRImageMeshProps {
  primitive: import("../../../mapper/types").XRImage;
  entry: LayoutEntry;
}


export function XRImageMesh({ primitive, entry }: XRImageMeshProps) {
  const { pos, rot } = entryTransform(entry);
  const clips = useClipPlanes();
  const theme = useTheme();
  const w = safeDim(entry.size.width);
  const h = safeDim(entry.size.height);
  const IMG_BG = theme.inputBg;

  // Proxy external URLs so Three.js can load them without CORS errors.
  const proxiedSrc = proxyImageSrc(primitive.src ?? "");

  function isRenderableImage(url: string) {
    // After proxying, external images become same-origin /api/proxy paths.
    if (!url) return false;
    if (
      url.startsWith("/") ||
      url.startsWith("data:") ||
      url.startsWith("blob:")
    )
      return true;
    try {
      return new URL(url).origin === window.location.origin;
    } catch {
      return false;
    }
  }
  const [texture, setTexture] = React.useState<THREE.Texture | null>(null);
  // Distinguishes "still loading" from "failed to load" — the alt/label text
  // below is a fallback for when the image can't be shown, not a permanent
  // caption. Without this, every successfully-rendered image (including ones
  // with no visible caption on the source page) got its alt text drawn under
  // it forever, e.g. showing literal alt strings like "altN=4-simplex" or a
  // bare filename such as "CDel_node.png" as if it were a real caption.
  const [loadFailed, setLoadFailed] = React.useState(false);

  React.useEffect(() => {
    setTexture(null);
    setLoadFailed(false);
    if (!isRenderableImage(proxiedSrc)) {
      setLoadFailed(true);
      return;
    }
    let cancelled = false;
    const loader = new THREE.TextureLoader();
    loader.load(
      proxiedSrc,
      (loaded) => {
        // useTexture (drei) sets this automatically; a bare TextureLoader
        // does not, which left images rendering blank/washed out under
        // three's color-managed pipeline.
        loaded.colorSpace = THREE.SRGBColorSpace;
        if (!cancelled) setTexture(loaded);
      },
      undefined,
      () => {
        // Broken/unreachable image — leave texture null so the plain
        // background box renders instead of crashing the canvas.
        if (!cancelled) setLoadFailed(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [proxiedSrc]);

  return (
    <group position={pos} rotation={rot}>
      <Surface width={w} height={h} color={IMG_BG} clips={clips} />

      {/* Mesh only mounts once the texture is ready: creating it earlier
          with map=undefined bakes a shader program compiled without the
          USE_MAP define, and later assigning material.map via prop update
          does not retroactively enable texture sampling — the plane just
          renders as meshBasicMaterial's plain white default forever. */}
      {texture && (
        <mesh
          position={[w / 2, -h / 2, Z_LAYER_IMAGE]}
          renderOrder={RENDER_ORDER_IMAGE}
        >
          <planeGeometry args={[w, h]} />
          <meshBasicMaterial map={texture} transparent clippingPlanes={clips} />
        </mesh>
      )}
      <mesh position={[w / 2, -h / 2, 0.002]} rotation={[0, 0, Math.PI / 2]}>
        <planeGeometry args={[h * 0.4, 0.002]} />
        <meshBasicMaterial
          color={theme.panelRim}
          transparent
          opacity={0.5}
          clippingPlanes={clips}
        />
      </mesh>

      {loadFailed && (primitive.alt ?? primitive.label) && (
        <ClippedText
          anchorX="center"
          anchorY="bottom"
          position={[w / 2, -h + 0.02, Z_LAYER_OVERLAY_TEXT]}
          renderOrder={RENDER_ORDER_TEXT}
          fontSize={0.016}
          color={theme.bodyCol}
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

