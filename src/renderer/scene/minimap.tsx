/**
 * scene/minimap.tsx — the travelled graph, in a corner of every view.
 *
 * Built BEFORE the four views, deliberately (docs/directional-links.md, Phase
 * 3): every one of them needs it, and building it once against the memory
 * model is what stops four bespoke versions appearing that each know a little
 * about geometry.
 *
 * It reads `NavState` and nothing else. It does not know about faces, floors,
 * tables or rings — a selection emits a history index, and the view animates
 * whatever moving to that index means in its own geometry.
 *
 * ── Why the minimap is the honest one ──
 *
 * The corridors a view draws are reader-relative and forget a turn: past the
 * first corner the ancestry is diagonal on the lattice and no direction
 * describes it (see `links/memory.ts`). The dice compounds this by
 * re-normalising after every move, so its faces deliberately do not remember
 * where the reader has been.
 *
 * That is the trade the design makes, and the minimap is the other half of it.
 * It plots `history` on the lattice — every node at its true coordinate, every
 * edge to the node it was reached from — so the thing the geometry gave up is
 * recoverable in one glance, and it is the ONLY surface that must stay true.
 *
 * ── Where it sits ──
 *
 * Head-anchored with a lazy follow rather than welded to the camera. Rigid
 * head-locking in a headset makes a panel impossible to look away from and
 * uncomfortable within seconds; a damped follow lets the reader turn to it,
 * read it, and turn back, and it drifts into the corner again on its own.
 *
 * The per-frame work is wrapped: one uncaught throw inside an XR frame ends
 * rendering permanently and the headset falls back to its loading environment
 * with nothing surfaced, so a corner overlay is not allowed to be the thing
 * that kills the session.
 */
import React from "react";
import { Line, Text } from "@react-three/drei";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";

import { useTheme } from "../theme";
import { FontContext } from "./contexts";
import type { NavNode, NavState } from "../../links/memory";

/**
 * Panel size in metres, at the distance below. Small: it is a corner, not a
 * view. 0.2 m at 0.85 m is about 13° across — big enough to pick a node out
 * of, small enough that it never competes with the document for the middle of
 * the frame.
 */
const W = 0.2;
const H = 0.16;
/** Distance from the eye. Close enough to read, far enough not to converge on. */
const DIST = 0.85;
/** Offset from the sight line, in metres at DIST — down and to the left. */
const OFF_X = -0.33;
const OFF_Y = -0.24;
/** Lazy follow: fraction of the remaining error closed per frame at 90 Hz. */
const FOLLOW = 0.06;
/**
 * Lattice pitch at full size. The drawing is laid out at this pitch and then
 * fitted to the panel as a whole (see `plot`), so this is the spacing a short
 * history gets rather than a spacing every history is forced into.
 */
const PITCH = 0.05;
const NODE_R = 0.009;
/**
 * Half the box a node needs to itself, at full size — the widest of the three
 * glyphs below, not the dot they used to be.
 *
 * This is the number the layout used to be missing. Pitch was fitted to the
 * panel from the lattice span alone, so six rooms in a line got a 9 mm pitch
 * while a room plan is 29 mm across: the glyphs were laid out edge to edge on
 * a grid three times too fine and stacked on top of each other. Whatever the
 * spacing ends up being, it is now spacing for THESE shapes.
 *
 * (deck's lifted card reaches 1.68u across and 1.68u down with its lip;
 * rooms' plan is 1.6u × 1.2u; wall's rim reaches 1.45u. u is NODE_R * 2.)
 */
const GLYPH_HALF = NODE_R * 2 * 0.9;
/** The band between the two captions — all the map is allowed to draw in. */
const PLOT_TOP = H / 2 - 0.026;
const PLOT_BOTTOM = -H / 2 + 0.038;
const PLOT_HALF_W = W / 2 - 0.012;
const PLOT_MID_Y = (PLOT_TOP + PLOT_BOTTOM) / 2;
/**
 * Floor on the fit. Past this a glyph is under half a degree wide and the
 * shape stops being readable as a shape, so a very long history is allowed to
 * run off the panel edge rather than shrink into an unreadable smudge — the
 * map stays true about WHERE, and the reader can still tell a room from a
 * card. Reached at about eleven documents in a straight line.
 */
const MIN_SCALE = 0.3;

interface Plotted {
  node: NavNode;
  historyIndex: number;
  /** Panel-local position, metres. */
  x: number;
  y: number;
}

interface Plot {
  points: Plotted[];
  /** Uniform scale the drawing was fitted by — glyphs wear it too. */
  scale: number;
}

/**
 * Lay the history out on its lattice, then fit the whole drawing to the panel.
 *
 * Two steps rather than one, and the order is the point. Laying out first at a
 * fixed pitch and fitting after means the thing being fitted is the drawing
 * the reader actually sees — glyph extents and collision nudges included —
 * instead of a set of bare centres that the glyphs then overflow. The glyphs
 * are scaled by the same factor, so a node can never grow into its neighbour:
 * pitch and mark shrink together or not at all.
 *
 * Coordinates can collide — going east then west then east again returns to a
 * coordinate already occupied by a different document — so a collided node is
 * nudged rather than drawn on top of its predecessor. Nudging is honest here
 * in a way that dropping would not be: the reader visited both.
 */
function plot(history: NavNode[]): Plot {
  if (history.length === 0) return { points: [], scale: 1 };
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const n of history) {
    minX = Math.min(minX, n.coord.x);
    maxX = Math.max(maxX, n.coord.x);
    minY = Math.min(minY, n.coord.y);
    maxY = Math.max(maxY, n.coord.y);
  }
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;

  const used = new Map<string, number>();
  const raw = history.map((node, historyIndex) => {
    const key = `${node.coord.x},${node.coord.y}`;
    const collisions = used.get(key) ?? 0;
    used.set(key, collisions + 1);
    // A spiral nudge, so a third visit to one coordinate does not land on the
    // second. Sized off the glyph, not off a dot radius, so it keeps reading
    // as a stack rather than a merge whatever shape the view draws: enough
    // offset to see two outlines, little enough to read "the same place".
    const nudge = collisions * GLYPH_HALF * 0.9;
    return {
      node,
      historyIndex,
      x: (node.coord.x - cx) * PITCH + nudge,
      y: (node.coord.y - cy) * PITCH + nudge,
    };
  });

  // The box the drawing occupies, glyphs and all.
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const p of raw) {
    x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x);
    y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y);
  }
  const drawW = x1 - x0 + GLYPH_HALF * 2;
  const drawH = y1 - y0 + GLYPH_HALF * 2;
  const scale = Math.max(
    MIN_SCALE,
    Math.min(1, (PLOT_HALF_W * 2) / drawW, (PLOT_TOP - PLOT_BOTTOM) / drawH),
  );

  // Recentre on the plot band rather than on the panel: the captions own the
  // top and bottom of it, and a map centred on the panel drifts under them.
  const midX = (x0 + x1) / 2;
  const midY = (y0 + y1) / 2;
  const points = raw.map((p) => ({
    ...p,
    x: (p.x - midX) * scale,
    y: (p.y - midY) * scale + PLOT_MID_Y,
  }));
  return { points, scale };
}

/**
 * A visited document, drawn as the thing the reader's own view is made of.
 *
 * A generic dot is a correct graph and a useless map: the reader has spent the
 * whole session learning that a document is a FACE of a dice, or a TABLE, or a
 * ROOM, or a STOREY, and a corner overlay that throws that away and hands them
 * five identical circles makes them translate between two vocabularies to read
 * their own history. So each view's map is drawn in that view's own material.
 *
 * Colour still carries nothing — the whole design has given it up. What
 * separates "visited" from "here" is WEIGHT and an outline, and what separates
 * the three views is SHAPE.
 *
 *   wall   a square face, as one side of the dice
 *   deck   a card on a table, with the lip the table has
 *   rooms  a room in plan, walls drawn and a doorway left open
 */
function NodeGlyph({
  view,
  here,
  hover,
}: {
  view: string;
  here: boolean;
  hover: boolean;
}) {
  const theme = useTheme();
  const ink = here || hover ? theme.headingCol : theme.bodyCol;
  const strength = here ? 1 : hover ? 0.9 : 0.62;
  const u = NODE_R * 2;

  /** A filled bar — the one part every glyph below is built from. */
  const bar = (
    key: string,
    w: number,
    h: number,
    x = 0,
    y = 0,
    o = strength,
  ) => (
    <mesh key={key} position={[x, y, 0.001]}>
      <planeGeometry args={[w, h]} />
      <meshBasicMaterial color={ink} transparent opacity={o} depthWrite={false} />
    </mesh>
  );

  switch (view) {
    case "deck": {
      // A card with the table's lip under it. The current one is lifted: its
      // lip sits a little lower, which is what a raised card looks like from
      // the front and needs no second colour to say so.
      const w = u * 1.5;
      const h = u * 1.0;
      return (
        <group>
          {bar("card", w, h, 0, 0, here ? 0.95 : strength * 0.55)}
          {bar("lip", w, u * 0.16, 0, -h / 2 - (here ? u * 0.26 : u * 0.14))}
          {here && bar("edge", w + u * 0.18, h + u * 0.18, 0, 0, 0.25)}
        </group>
      );
    }
    case "rooms": {
      // A room in plan: four walls with a gap left in the near one, because a
      // room you cannot get into is a box.
      const w = u * 1.6;
      const h = u * 1.2;
      const t = u * 0.16;
      const jamb = (w - u * 0.5) / 2;
      return (
        <group>
          {here && bar("floor", w, h, 0, 0, 0.3)}
          {bar("far", w, t, 0, h / 2)}
          {bar("left", t, h, -w / 2, 0)}
          {bar("right", t, h, w / 2, 0)}
          {bar("near-a", jamb, t, -(w - jamb) / 2, -h / 2)}
          {bar("near-b", jamb, t, (w - jamb) / 2, -h / 2)}
        </group>
      );
    }
    default: {
      // wall — a face of the dice. Square, because that is what a face is, and
      // the current one is drawn as a face turned to the front: filled, with
      // the rim a face standing proud of the board would catch.
      const w = u * 1.25;
      return (
        <group>
          {bar("face", w, w, 0, 0, here ? 0.95 : strength * 0.5)}
          {here && bar("rim-t", w + u * 0.2, u * 0.14, 0, w / 2 + u * 0.1)}
          {here && bar("rim-b", w + u * 0.2, u * 0.14, 0, -w / 2 - u * 0.1)}
          {here && bar("rim-l", u * 0.14, w + u * 0.2, -w / 2 - u * 0.1, 0)}
          {here && bar("rim-r", u * 0.14, w + u * 0.2, w / 2 + u * 0.1, 0)}
        </group>
      );
    }
  }
}

/** What the map calls the things on it, in the view's own words. */
const NODE_NOUN: Record<string, string> = {
  wall: "faces",
  deck: "tables",
  rooms: "rooms",
};

function MinimapPanel({
  nav,
  viewMode,
  onJump,
}: {
  nav: NavState;
  viewMode: string;
  onJump: (historyIndex: number) => void;
}) {
  const theme = useTheme();
  const fontType = React.useContext(FontContext);
  const [hovered, setHovered] = React.useState<number | null>(null);

  const { points: nodes, scale } = React.useMemo(() => plot(nav.history), [nav.history]);
  const byIndex = React.useMemo(() => new Map(nodes.map((p) => [p.historyIndex, p])), [nodes]);

  const here = nav.at;
  const shown = hovered ?? here;
  const shownNode = byIndex.get(shown)?.node;
  const noun = NODE_NOUN[viewMode] ?? "pages";

  return (
    <group>
      {/* Ground and rim */}
      <mesh>
        <planeGeometry args={[W, H]} />
        <meshBasicMaterial color={theme.navBg} transparent opacity={0.92} depthWrite={false} />
      </mesh>
      <mesh position={[0, 0, -0.001]}>
        <planeGeometry args={[W + 0.006, H + 0.006]} />
        <meshBasicMaterial color={theme.panelRim} transparent opacity={0.6} depthWrite={false} />
      </mesh>

      {/* What the map is of, so the shapes below are read as shapes and not as
          decoration: "4 rooms" tells the reader what they are looking at in
          three characters. */}
      <Text
        font={fontType}
        anchorX="left"
        anchorY="top"
        position={[-W / 2 + 0.012, H / 2 - 0.009, 0.004]}
        fontSize={0.012}
        color={theme.mutedTextCol}
      >
        {`${nav.history.length} ${noun}`}
      </Text>

      {/* Edges: each node back to the one it was reached from. Drawn under the
          glyphs so a face is never cut by its own connector. */}
      {nodes.map((p) => {
        const from = p.node.from >= 0 ? byIndex.get(p.node.from) : undefined;
        if (!from) return null;
        return (
          <Line
            key={`edge-${p.historyIndex}`}
            points={[
              [from.x, from.y, 0.0005],
              [p.x, p.y, 0.0005],
            ]}
            color={theme.mutedTextCol}
            // Rooms joins its nodes with corridors rather than wires, so its
            // connectors are drawn heavier — the same thing the reader walks.
            lineWidth={viewMode === "rooms" ? 3.2 : 1.4}
            transparent
            opacity={viewMode === "rooms" ? 0.5 : 0.7}
          />
        );
      })}

      {/* Nodes, in the view's own material. */}
      {nodes.map((p) => (
        <group key={`node-${p.historyIndex}`} position={[p.x, p.y, 0.003]}>
          <group scale={scale}>
            <NodeGlyph
              view={viewMode}
              here={p.historyIndex === here}
              hover={p.historyIndex === hovered}
            />
          </group>
          {/* One hit target per node, sized to be reachable rather than to the
              glyph — a room plan is mostly empty and a ray through its middle
              would otherwise hit nothing. Capped at the fitted pitch, because
              a target that outgrows the spacing answers for its neighbour. */}
          <mesh
            position={[0, 0, 0.004]}
            onPointerOver={(e) => {
              e.stopPropagation();
              setHovered(p.historyIndex);
            }}
            onPointerOut={() => setHovered((v) => (v === p.historyIndex ? null : v))}
            onClick={(e) => {
              e.stopPropagation();
              if (p.historyIndex !== here) onJump(p.historyIndex);
            }}
          >
            <planeGeometry
              args={[
                Math.min(NODE_R * 4.6, PITCH * scale * 0.95),
                Math.min(NODE_R * 3.4, PITCH * scale * 0.95),
              ]}
            />
            <meshBasicMaterial transparent opacity={0} depthWrite={false} />
          </mesh>
        </group>
      ))}

      {/* The name of whatever the reader is pointing at, or of where they are. */}
      <Text
        font={fontType}
        anchorX="left"
        anchorY="bottom"
        position={[-W / 2 + 0.012, -H / 2 + 0.01, 0.004]}
        fontSize={0.015}
        color={theme.bodyCol}
        maxWidth={W - 0.024}
        clipRect={[-W / 2, -H / 2, W / 2, -H / 2 + 0.032]}
      >
        {shownNode?.label ?? ""}
      </Text>
    </group>
  );
}

/**
 * Mount once per scene. Follows the head lazily and renders nothing until the
 * reader has actually travelled — a map of one document is a dot, and a dot
 * parked in the corner of every view is just clutter.
 */
export function Minimap({
  nav,
  viewMode,
  onJump,
}: {
  nav?: NavState | null;
  /** Which view's material the map is drawn in — see NodeGlyph. */
  viewMode?: string;
  onJump?: (historyIndex: number) => void;
}) {
  const camera = useThree((s) => s.camera);
  const group = React.useRef<THREE.Group>(null);
  const target = React.useRef(new THREE.Vector3());
  const quat = React.useRef(new THREE.Quaternion());
  const settled = React.useRef(false);

  const visible = Boolean(nav && nav.history.length > 1 && onJump);

  useFrame(() => {
    const g = group.current;
    if (!g || !visible) return;
    try {
      // Where the panel wants to be: DIST ahead of the eye, offset down-left,
      // in the eye's own frame so it stays in the corner as the head turns.
      target.current.set(OFF_X, OFF_Y, -DIST).applyQuaternion(camera.quaternion);
      target.current.add(camera.position);
      quat.current.copy(camera.quaternion);

      if (!settled.current) {
        g.position.copy(target.current);
        g.quaternion.copy(quat.current);
        settled.current = true;
        return;
      }
      g.position.lerp(target.current, FOLLOW);
      g.quaternion.slerp(quat.current, FOLLOW);
    } catch {
      // A minimap must never be the reason a session stops rendering. Losing
      // the follow leaves the panel wherever it last was, which is legible;
      // throwing out of an XR frame ends the session with no error surfaced.
    }
  });

  React.useEffect(() => {
    if (!visible) settled.current = false;
  }, [visible]);

  if (!visible) return null;
  return (
    <group ref={group} renderOrder={20}>
      <MinimapPanel nav={nav!} viewMode={viewMode ?? "wall"} onJump={onJump!} />
    </group>
  );
}
