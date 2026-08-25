/**
 * scene/transition.tsx — "you are moving."
 *
 * A directional move takes as long as a fetch takes, and for that whole time
 * the reader is looking at the document they are LEAVING while their view
 * turns, slides or walks. That is the right thing to show them — the move is
 * the feedback — but it leaves one question unanswered: is this still going,
 * or did it not take?
 *
 * This answers that, and nothing else. It is not a loading screen: it does not
 * cover the document, it does not stop anything, and it disappears the instant
 * the move lands or fails.
 *
 * ── Why it is shared ──
 *
 * The four views animate a move in four different ways, and none of those
 * animations can say "still fetching" — a board that has finished turning
 * looks exactly like a board that turned and arrived. So the one thing that
 * IS the same everywhere gets drawn once, in the same head-anchored corner as
 * the minimap, and every view inherits it.
 *
 * ── What it says ──
 *
 *  · the direction, as the same glyph the anchor's mark and the door carried
 *  · where it is going, by name
 *  · that it is still going, by moving
 *
 * The movement is a mark sliding along a short track in the direction of
 * travel and repeating — a progress bar would be a lie, since a fetch through
 * the proxy reports no progress, and a spinner says "wait" where this needs to
 * say "you are going that way".
 */
import React from "react";
import { Text } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";

import { useTheme } from "../theme";
import { useHeadAnchor } from "./head-anchor";
import { FontContext } from "./contexts";
import { markForAxis } from "./link-doors";
import type { Axis } from "../../links/memory";

/** Panel size, metres. Smaller than the minimap: it is a status, not a map. */
const W = 0.26;
const H = 0.05;
/**
 * Directly above the minimap, which sits at (−0.33, −0.24). The distance and
 * the follow are the minimap's too — the two panels are one corner as far as
 * the reader is concerned, so they obey one rule: see scene/head-anchor.ts.
 */
const OFF_X = -0.33;
const OFF_Y = -0.12;
/** Seconds for the travelling mark to cross its track once. */
const SWEEP_S = 1.1;

function label(url: string): string {
  try {
    const u = new URL(url);
    const last = u.pathname.split("/").filter(Boolean).pop();
    const name = last ? decodeURIComponent(last).replace(/[-_]+/g, " ") : u.hostname;
    return name.length > 28 ? `${name.slice(0, 26)}…` : name;
  } catch {
    return url.length > 28 ? `${url.slice(0, 26)}…` : url;
  }
}

/** The moving mark. Its own group so only this re-renders per frame. */
function Sweep({ axis, width }: { axis: Axis | null; width: number }) {
  const theme = useTheme();
  const ref = React.useRef<THREE.Group>(null);
  const t = React.useRef(0);

  // Which way along the track the mark travels. A move with no axis — a
  // minimap jump — still sweeps, rightward, because something IS happening;
  // it just is not happening in a direction.
  const sign = axis === "left" || axis === "down" ? -1 : 1;

  useFrame((_, dt) => {
    const g = ref.current;
    if (!g) return;
    try {
      t.current = (t.current + Math.min(dt, 0.1) / SWEEP_S) % 1;
      // Ease so the mark leaves and arrives softly rather than jumping the
      // gap at the wrap.
      const e = t.current < 0.5 ? 2 * t.current * t.current : 1 - 2 * (1 - t.current) ** 2;
      g.position.x = sign * (e - 0.5) * width;
      g.scale.setScalar(0.6 + 0.4 * Math.sin(Math.PI * t.current));
    } catch {
      // A frozen mark is a cosmetic fault; a throw inside an XR frame ends
      // rendering for the whole session.
    }
  });

  return (
    <group ref={ref}>
      <mesh>
        <circleGeometry args={[0.0055, 12]} />
        <meshBasicMaterial
          color={theme.headingCol}
          transparent
          opacity={0.95}
          depthWrite={false}
        />
      </mesh>
    </group>
  );
}

export function TransitionMark({
  pending,
}: {
  pending?: { url: string; axis: Axis | null } | null;
}) {
  const theme = useTheme();
  const fontType = React.useContext(FontContext);
  const group = React.useRef<THREE.Group>(null);
  const visible = Boolean(pending);
  // The same follow the minimap uses, guard included. It did NOT used to
  // include the guard: this mark is on screen for the whole of a move, so a
  // teleport or the one-shot recentre landing mid-fetch used to drag it
  // through the world instead of putting it back.
  useHeadAnchor(group, OFF_X, OFF_Y, visible);

  if (!pending) return null;

  const glyph = pending.axis ? markForAxis(pending.axis) : "◦";
  const trackW = W - 0.05;

  return (
    <group ref={group} renderOrder={21}>
      <mesh>
        <planeGeometry args={[W, H]} />
        <meshBasicMaterial
          color={theme.navBg}
          transparent
          opacity={0.9}
          depthWrite={false}
        />
      </mesh>
      <mesh position={[0, 0, -0.001]}>
        <planeGeometry args={[W + 0.005, H + 0.005]} />
        <meshBasicMaterial
          color={theme.panelRim}
          transparent
          opacity={0.6}
          depthWrite={false}
        />
      </mesh>

      {/* The direction, in the legend's own glyph. */}
      <Text
        font={fontType}
        anchorX="left"
        anchorY="middle"
        position={[-W / 2 + 0.012, H * 0.16, 0.002]}
        fontSize={0.018}
        color={theme.headingCol}
      >
        {glyph}
      </Text>
      <Text
        font={fontType}
        anchorX="left"
        anchorY="middle"
        position={[-W / 2 + 0.032, H * 0.16, 0.002]}
        fontSize={0.015}
        color={theme.bodyCol}
        maxWidth={W - 0.046}
      >
        {label(pending.url)}
      </Text>

      {/* The track, and the mark travelling along it. */}
      <group position={[0, -H * 0.26, 0.002]}>
        <mesh>
          <planeGeometry args={[trackW, 0.0016]} />
          <meshBasicMaterial
            color={theme.mutedTextCol}
            transparent
            opacity={0.45}
            depthWrite={false}
          />
        </mesh>
        <Sweep axis={pending.axis} width={trackW} />
      </group>
    </group>
  );
}
