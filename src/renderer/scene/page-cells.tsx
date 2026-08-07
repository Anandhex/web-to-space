/**
 * scene/page-cells.tsx
 *
 * The building blocks every spatial page view draws a cell out of: a live
 * ghost (the panel's real subtree pinned to one page), a cheap imposter card
 * for pages too far away to be worth mounting, the invisible hit plane that
 * makes a whole cell one click target, and the two easing helpers.
 *
 * They live here rather than in page-ghosts.tsx because the wall
 * (scene/wall-field.tsx) is a different field over the same cells, and a
 * shared module is how both get them without importing each other.
 */
import React from "react";
import { Text } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";

import type { XRPrimitive } from "../../mapper/types";
import type { LayoutEntry, LayoutPlan } from "../../layout/types";
import { useTheme } from "../theme";
import { MORPH_RATE, MORPH_EPS } from "./config";
import {
  CurrentPageContext,
  FontContext,
  StackDepthContext,
  zeroedEntry,
} from "./contexts";
import { PrimitiveDispatcher } from "./dispatcher";
import {
  PanelBacking,
  PaginationControls,
  buildPanelClipPlanes,
} from "./panels";
import { ClipPlanesContext, PanelOriginYContext } from "../primitives";
import { isExtractedComplementary } from "./dispatch-children";

const _noop = () => {};

// ── Imposter heading lookup ──────────────────────────────────

/** First heading on each page — the one line an imposter card can show. */
export function usePageHeadings(
  primitiveMap: Map<string, XRPrimitive>,
  plan: LayoutPlan,
): Map<number, string> {
  return React.useMemo(() => {
    const map = new Map<number, string>();
    for (const [, p] of primitiveMap) {
      if (p.type !== "XRHeading") continue;
      const e = plan.entries[p.id];
      if (!e || e.suppressed || e.pageIndex === undefined) continue;
      const text = p.content ?? p.label;
      if (text && !map.has(e.pageIndex)) map.set(e.pageIndex, text);
    }
    return map;
  }, [primitiveMap, plan]);
}

// ── Building blocks ──────────────────────────────────────────

/** Invisible full-cell hit target: one click = focus/open this cell. */
export function PageHitPlane({
  width,
  height,
  onSelect,
  onOver,
  onOut,
}: {
  width: number;
  height: number;
  onSelect: () => void;
  onOver?: () => void;
  onOut?: () => void;
}) {
  return (
    <mesh
      position={[width / 2, -height / 2, 0.045]}
      onClick={(e) => {
        e.stopPropagation();
        onSelect();
      }}
      onPointerOver={
        onOver &&
        ((e) => {
          e.stopPropagation();
          onOver();
        })
      }
      onPointerOut={onOut && (() => onOut())}
    >
      <planeGeometry args={[width, height]} />
      <meshBasicMaterial transparent opacity={0} depthWrite={false} />
    </mesh>
  );
}

/**
 * Eases a change of cell scale without touching how any size is computed:
 * the children are already built at the NEW scale, so the group starts at
 * the old/new ratio and relaxes back to 1. A cell whose scale never changes
 * sits at 1 and costs nothing, so the other page views are unaffected.
 */
export function EasedScale({
  target,
  children,
}: {
  target: number;
  children: React.ReactNode;
}) {
  const ref = React.useRef<THREE.Group>(null);
  const prevTarget = React.useRef(target);
  const factor = React.useRef(1);
  const settled = React.useRef(true);

  if (prevTarget.current !== target) {
    factor.current = (factor.current * prevTarget.current) / target;
    prevTarget.current = target;
    settled.current = false;
  }

  useFrame((_, dt) => {
    const g = ref.current;
    if (!g || settled.current) return;
    const d = 1 - factor.current;
    if (Math.abs(d) < MORPH_EPS) {
      factor.current = 1;
      settled.current = true;
    } else {
      factor.current += d * (1 - Math.exp(-MORPH_RATE * Math.min(dt, 0.1)));
    }
    g.scale.setScalar(factor.current);
  });

  return (
    <group ref={ref} scale={factor.current}>
      {children}
    </group>
  );
}

// ── Drop shadow ──────────────────────────────────────────────

/**
 * The soft drop a cell casts on the surface behind it. One texture for every
 * view that uses it — a rounded-rect falloff written per pixel rather than
 * through canvas `filter`, so it is deterministic and needs no blur support.
 */
let SHADOW_TEX: THREE.Texture | null = null;

function shadowTexture(): THREE.Texture {
  if (SHADOW_TEX) return SHADOW_TEX;
  const N = 96;
  const c = document.createElement("canvas");
  c.width = N;
  c.height = N;
  const g = c.getContext("2d")!;
  const img = g.createImageData(N, N);
  const half = N / 2 - 0.5;
  const box = N * 0.28; // half-extent of the solid core
  const feather = N * 0.2;
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const dx = Math.max(Math.abs(x - half) - box, 0);
      const dy = Math.max(Math.abs(y - half) - box, 0);
      const t = Math.max(0, 1 - Math.hypot(dx, dy) / feather);
      const i = (y * N + x) * 4;
      img.data[i] = 0;
      img.data[i + 1] = 0;
      img.data[i + 2] = 0;
      img.data[i + 3] = Math.round(255 * t * t);
    }
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  SHADOW_TEX = t;
  return t;
}

/**
 * A cell's shadow, drawn `z` behind it (the caller owns how far, since that
 * is a property of the surface the cell hangs on, not of the cell).
 */
export function CellShadow({
  width,
  height,
  z,
  opacity = 0.45,
  grow = 1.34,
}: {
  width: number;
  height: number;
  z: number;
  opacity?: number;
  grow?: number;
}) {
  const map = React.useMemo(() => shadowTexture(), []);
  return (
    <mesh
      position={[width / 2, -height / 2, z]}
      raycast={() => null}
      renderOrder={-1}
    >
      <planeGeometry args={[width * grow, height * grow]} />
      <meshBasicMaterial
        map={map}
        transparent
        opacity={opacity}
        depthWrite={false}
        toneMapped={false}
      />
    </mesh>
  );
}

/** "You are here" frame at the focused page's board/pile cell. */
export function FocusCellFrame({
  width,
  height,
}: {
  width: number;
  height: number;
}) {
  const theme = useTheme();
  const fontType = React.useContext(FontContext);
  return (
    <>
      <mesh position={[width / 2, -height / 2, 0]}>
        <planeGeometry args={[width, height]} />
        <meshBasicMaterial
          color={theme.emphasisCol}
          transparent
          opacity={0.16}
          depthWrite={false}
        />
      </mesh>
      <Text
        font={fontType}
        anchorX="center"
        anchorY="middle"
        position={[width / 2, -height / 2, 0.004]}
        fontSize={Math.min(0.09, height * 0.16)}
        color={theme.emphasisCol}
      >
        ● reading
      </Text>
    </>
  );
}

/** Cheap far-page stand-in: dimmed card + page number + first heading. */
export function PageImposter({
  width,
  height,
  pageIndex,
  heading,
  recession,
}: {
  width: number;
  height: number;
  pageIndex: number;
  heading?: string;
  recession: number;
}) {
  const theme = useTheme();
  const fontType = React.useContext(FontContext);
  const opacity = 1 - 0.55 * recession;
  return (
    <>
      <mesh position={[width / 2, -height / 2, 0]}>
        <planeGeometry args={[width, height]} />
        <meshStandardMaterial
          color={theme.panelBg}
          transparent
          opacity={opacity}
          roughness={0.85}
          metalness={0}
        />
      </mesh>
      <Text
        font={fontType}
        anchorX="left"
        anchorY="top"
        position={[width * 0.07, -height * 0.09, 0.003]}
        fontSize={Math.min(0.11, height * 0.14)}
        color={theme.bodyCol}
        fillOpacity={opacity}
        maxWidth={width * 0.86}
      >
        {heading ? heading.slice(0, 80) : `Page ${pageIndex + 1}`}
      </Text>
      <Text
        font={fontType}
        anchorX="right"
        anchorY="bottom"
        position={[width * 0.93, -height * 0.92, 0.003]}
        fontSize={Math.min(0.08, height * 0.1)}
        color={theme.mutedTextCol}
        fillOpacity={opacity}
      >
        {`${pageIndex + 1}`}
      </Text>
    </>
  );
}

/**
 * A full live ghost: the panel's whole primitive subtree pinned to
 * `targetPage`, rendered at the placement transform (the CarouselGhostPanel
 * mechanism, generalized with scale). Non-interactive and dimmed when it's a
 * field ghost; fully interactive (links live, pagination controls) when it's
 * the STAGE — the focused page that morphed forward to reading position.
 */
export function LivePageGhost({
  panel,
  plan,
  primitiveMap,
  entry,
  targetPage,
  scale,
  recession,
  clip,
  stage = false,
  controls = true,
  setPage = _noop,
}: {
  panel: XRPrimitive;
  plan: LayoutPlan;
  primitiveMap: Map<string, XRPrimitive>;
  entry: LayoutEntry;
  targetPage: number;
  scale: number;
  recession: number;
  clip: boolean;
  stage?: boolean;
  /** Pagination arrows under the live page. The elevator navigates by
   *  keyboard and by pointing, so it passes false. */
  controls?: boolean;
  setPage?: (id: string, page: number) => void;
}) {
  const depth = React.useContext(StackDepthContext);
  const opacity = 1 - 0.55 * recession;
  const ghostPageState = React.useMemo(
    () => ({ [panel.id]: targetPage }),
    [panel.id, targetPage],
  );
  // Content lives inside a group scaled by `scale`, so its world-space
  // vertical extent is height·scale below the (eased) anchor. Horizontal
  // yaw doesn't change the y-span, so the flat top/bottom planes stay
  // valid on the arced wall; a pitched tilt would break them, so a pitched
  // cell passes clip=false (pagination already sizes content to the page —
  // clipping is a safety net, not a correctness requirement).
  const planes = React.useMemo(
    () =>
      clip
        ? buildPanelClipPlanes(entry.position.y, entry.size.height * scale)
        : null,
    [clip, entry.position.y, entry.size.height, scale],
  );

  const pagination = plan.entries[panel.id]?.pagination;
  const inner = (
    <>
      <PanelBacking
        entry={zeroedEntry(entry)}
        ghostOpacity={stage ? undefined : opacity}
      />
      <PanelOriginYContext.Provider value={entry.position.y}>
        <StackDepthContext.Provider value={depth + 1}>
          {panel.children
            .filter((child) => !isExtractedComplementary(child, plan))
            .map((child) => (
              <PrimitiveDispatcher
                key={child.id}
                primitive={child}
                plan={plan}
                pageState={ghostPageState}
                setPage={stage ? setPage : _noop}
                primitiveMap={primitiveMap}
              />
            ))}
        </StackDepthContext.Provider>
      </PanelOriginYContext.Provider>
      {stage && controls && pagination && pagination.pageCount > 1 && (
        <PaginationControls
          primitiveId={panel.id}
          pagination={pagination}
          currentPage={targetPage}
          entry={zeroedEntry(entry)}
          onPageChange={(p) => setPage(panel.id, p)}
        />
      )}
    </>
  );
  const body = stage ? (
    <group>{inner}</group>
  ) : (
    <group raycast={() => null}>{inner}</group>
  );

  return (
    <CurrentPageContext.Provider value={targetPage}>
      <group scale={[scale, scale, scale]}>
        {planes ? (
          <ClipPlanesContext.Provider value={planes}>
            {body}
          </ClipPlanesContext.Provider>
        ) : (
          body
        )}
      </group>
    </CurrentPageContext.Provider>
  );
}
