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
import type { NavState } from "../../links/memory";
import type { Side } from "./minimap-layout";
import { W, H, U, NODE_R, Z_EDGE, corridor, plot } from "./minimap-layout";

/** Distance from the eye. Close enough to read, far enough not to converge on. */
const DIST = 0.85;
/** Offset from the sight line, in metres at DIST — down and to the left. */
const OFF_X = -0.33;
const OFF_Y = -0.24;
/** Lazy follow: fraction of the remaining error closed per frame at 90 Hz. */
const FOLLOW = 0.06;

/**
 * A visited document, drawn as the thing the reader's own view is made of.
 *
 * A generic dot is a correct graph and a useless map: the reader has spent the
 * whole session learning that a document is a FACE of a dice, or a TABLE, or a
 * ROOM, and a corner overlay that throws that away and hands them five
 * identical circles makes them translate between two vocabularies to read
 * their own history. So each view's map is drawn in that view's own material.
 *
 * Colour still carries nothing — the whole design has given it up. What
 * separates "visited" from "here" is WEIGHT and an outline, and what separates
 * the three views is SHAPE.
 *
 *   wall   a square face, as one side of the dice
 *   deck   a card on a table, with the lip the table has
 *   rooms  a room in plan, walls drawn and a doorway per corridor
 */
function NodeGlyph({
  view,
  here,
  hover,
  doors,
}: {
  view: string;
  here: boolean;
  hover: boolean;
  /** rooms only: the walls a corridor meets, which are left open. */
  doors?: readonly Side[];
}) {
  const theme = useTheme();
  const ink = here || hover ? theme.headingCol : theme.bodyCol;
  const strength = here ? 1 : hover ? 0.9 : 0.62;
  const u = U;

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
      // A room in plan: four walls, with a gap left in every wall a corridor
      // meets, because a room you cannot get into is a box and a corridor that
      // stops at a solid wall is a wire. A room with no corridor at all — one
      // document, which the map does not draw anyway — keeps the near door.
      const w = u * 1.6;
      const h = u * 1.2;
      const t = u * 0.16;
      const open: readonly Side[] = doors && doors.length ? doors : ["s"];
      const wall = (side: Side) => {
        const horizontal = side === "n" || side === "s";
        const len = horizontal ? w : h;
        const x = side === "e" ? w / 2 : side === "w" ? -w / 2 : 0;
        const y = side === "n" ? h / 2 : side === "s" ? -h / 2 : 0;
        if (!open.includes(side)) {
          return horizontal
            ? bar(side, len, t, x, y)
            : bar(side, t, len, x, y);
        }
        // Two jambs with the doorway between them.
        const jamb = (len - Math.min(u * 0.5, len * 0.5)) / 2;
        const off = (len - jamb) / 2;
        return (
          <React.Fragment key={side}>
            {horizontal
              ? bar(`${side}-a`, jamb, t, x - off, y)
              : bar(`${side}-a`, t, jamb, x, y - off)}
            {horizontal
              ? bar(`${side}-b`, jamb, t, x + off, y)
              : bar(`${side}-b`, t, jamb, x, y + off)}
          </React.Fragment>
        );
      };
      return (
        <group>
          {here && bar("floor", w, h, 0, 0, 0.3)}
          {(["n", "s", "e", "w"] as Side[]).map(wall)}
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

  const { points: nodes, scale, gx, gy, cell } = React.useMemo(
    () => plot(nav.history, viewMode),
    [nav.history, viewMode],
  );
  const byIndex = React.useMemo(() => new Map(nodes.map((p) => [p.historyIndex, p])), [nodes]);

  // Edges, and — in rooms — the walls each corridor asks to be let through.
  const { edges, doors } = React.useMemo(() => {
    const edges: { key: string; pts: [number, number, number][] }[] = [];
    const doors = new Map<number, Side[]>();
    const openDoor = (index: number, side: Side) => {
      const sides = doors.get(index) ?? [];
      if (!sides.includes(side)) sides.push(side);
      doors.set(index, sides);
    };
    for (const p of nodes) {
      const from = p.node.from >= 0 ? byIndex.get(p.node.from) : undefined;
      if (!from) continue;
      const key = `edge-${p.historyIndex}`;
      if (viewMode !== "rooms") {
        edges.push({
          key,
          pts: [
            [from.x, from.y, Z_EDGE],
            [p.x, p.y, Z_EDGE],
          ],
        });
        continue;
      }
      const run = corridor(from, p, gx, gy, cell, nodes);
      edges.push({
        key,
        pts: run.pts.map(([x, y]) => [x, y, Z_EDGE] as [number, number, number]),
      });
      openDoor(from.historyIndex, run.fromSide);
      openDoor(p.historyIndex, run.toSide);
    }
    return { edges, doors };
  }, [nodes, byIndex, viewMode, gx, gy, cell]);

  const here = nav.at;
  const shown = hovered ?? here;
  const shownNode = byIndex.get(shown)?.node;
  const noun = NODE_NOUN[viewMode] ?? "pages";

  // One hit target per node: at least the glyph, never wider than the spacing.
  // Sized to be reachable rather than to the shape — a room plan is mostly
  // empty and a ray through its middle would otherwise hit nothing — but
  // capped at the pitch, because a target that outgrows the spacing answers
  // for its neighbour.
  const hitW = Math.min(cell * 0.95, Math.max(gx * 2, NODE_R * 4.6));
  const hitH = Math.min(cell * 0.95, Math.max(gy * 2, NODE_R * 3.4));

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
      {edges.map((e) => (
        <Line
          key={e.key}
          points={e.pts}
          color={theme.mutedTextCol}
          // Rooms joins its nodes with corridors rather than wires, so its
          // connectors are drawn heavier — the same thing the reader walks.
          lineWidth={viewMode === "rooms" ? 3.2 : 1.4}
          transparent
          opacity={viewMode === "rooms" ? 0.5 : 0.7}
        />
      ))}

      {/* Nodes, in the view's own material. */}
      {nodes.map((p) => (
        <group key={`node-${p.historyIndex}`} position={[p.x, p.y, 0.003]}>
          <group scale={scale}>
            <NodeGlyph
              view={viewMode}
              here={p.historyIndex === here}
              hover={p.historyIndex === hovered}
              doors={doors.get(p.historyIndex)}
            />
          </group>
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
            <planeGeometry args={[hitW, hitH]} />
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
