/**
 * scene/room-walk.tsx
 *
 * The locomotion half of the `rooms` view: one eased group wrapped around the
 * whole page field that carries the room — rigidly — until the reader is
 * standing square-on to the focused exhibit.
 *
 * Every other page view morphs the CELLS when focus changes; rooms morphs the
 * ROOM. That difference is the whole effect: because the pages hold still
 * relative to each other, the glide reads as walking (and turning) through a
 * corridor rather than as furniture rearranging itself around you. Moving the
 * world rather than the camera is what keeps this possible at all — the flat
 * preview's camera belongs to OrbitControls and the immersive one to the
 * headset, and the reader has to stay at the origin for the in-world chrome
 * and the XR recentre to keep meaning what they mean.
 *
 * The pose comes from `computeRoomWalk` in panel-anchor-relative metres, but
 * the field's children carry WORLD positions (`entry.position + offset`), so
 * the group brackets them: an outer group at `anchor + pose.position` turned
 * by `pose.yaw` — putting the pivot on the panel anchor rather than the world
 * origin — and an inner group at `−anchor` that hands the children back their
 * own coordinate system.
 */
import React from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { Text } from "@react-three/drei";
import * as THREE from "three";

import { MORPH_RATE, MORPH_EPS } from "./config";
import { useTheme } from "../theme";
import { FontContext } from "./contexts";
import { NavigateContext } from "../primitives/contexts";
import {
  roomPoseTransform,
  roomWalkStep,
  type ReaderPose,
  type ReadingSpot,
  type RoomWall,
  type RoomSlab,
} from "../page-placements";

export function RoomWalk({
  anchor,
  poseRef,
  panel,
  viewingDistance,
  children,
}: {
  /** The main panel's top-left anchor in world space — the pivot. */
  anchor: { x: number; y: number; z: number };
  /**
   * Where the reader is standing, in building space, as a ref rather than a
   * prop: walking updates it every frame, and re-rendering the whole page
   * field at 60 Hz to move the reader two centimetres would be absurd.
   */
  poseRef: React.MutableRefObject<ReaderPose>;
  panel: { width: number; height: number };
  viewingDistance: number;
  children: React.ReactNode;
}) {
  const ref = React.useRef<THREE.Group>(null);
  const inited = React.useRef(false);

  const target = React.useCallback(() => {
    const t = roomPoseTransform(poseRef.current, panel, viewingDistance);
    return {
      x: anchor.x + t.position.x,
      y: anchor.y + t.position.y,
      z: anchor.z + t.position.z,
      yaw: t.yaw,
    };
  }, [anchor.x, anchor.y, anchor.z, panel, viewingDistance, poseRef]);

  // The first room is entered, not walked into: land on the pose so the view
  // opens with the reader already at page 1 rather than gliding in from the
  // world origin.
  React.useLayoutEffect(() => {
    const g = ref.current;
    if (g && !inited.current) {
      const t = target();
      g.position.set(t.x, t.y, t.z);
      g.rotation.y = t.yaw;
      inited.current = true;
    }
  });

  useFrame((_, dt) => {
    const g = ref.current;
    if (!g || !inited.current) return;
    const t = target();
    const a = 1 - Math.exp(-MORPH_RATE * Math.min(dt, 0.1));

    const p = g.position;
    const dx = t.x - p.x;
    const dy = t.y - p.y;
    const dz = t.z - p.z;
    if (Math.abs(dx) + Math.abs(dy) + Math.abs(dz) < MORPH_EPS) {
      p.set(t.x, t.y, t.z);
    } else {
      p.x += dx * a;
      p.y += dy * a;
      p.z += dz * a;
    }

    // Turns take the short way round: a reader who steps through a doorway
    // and turns to the next wall must not spin the long way through 350°.
    let dyaw = t.yaw - g.rotation.y;
    while (dyaw > Math.PI) dyaw -= 2 * Math.PI;
    while (dyaw < -Math.PI) dyaw += 2 * Math.PI;
    if (Math.abs(dyaw) < MORPH_EPS) g.rotation.y = t.yaw;
    else g.rotation.y += dyaw * a;
  });

  return (
    <group ref={ref}>
      <group position={[-anchor.x, -anchor.y, -anchor.z]}>{children}</group>
    </group>
  );
}

/** Metres per second on foot, and radians per second turning on the spot. */
const WALK_SPEED = 2.4;
const TURN_SPEED = 2.0;
/**
 * Going through a link door has to be deliberate: the reader must be pressed
 * up against the leaf, FACING it, and stay there. A corridor is only 1.15 m
 * from its centre to a wall, so anything more generous fires as soon as
 * somebody leaves a room off-centre and walks past the first door — which is
 * exactly what happened with a 0.55 m reach.
 */
const DOOR_REACH = 0.38;
/** Seconds pressed against a door before it opens. */
const DOOR_DWELL = 0.45;
/** Close enough to a page's spot to be standing on it. */
const SPOT_REACH = 0.55;
/**
 * Squaring the reader up to a page is for arriving at it, not for crossing
 * it: they have to come to a stop for this long, and be this close to the
 * middle of the mark. Firing on "no key held this frame" caught every gap
 * between key repeats, so walking THROUGH a room span the view at each spot
 * on the way — which is not a stop by any reading of the word.
 */
const SQUARE_AFTER = 0.3;
const SQUARE_RADIUS = 0.32;
/** How far the reader must move before the field re-judges what is nearby. */
const PROXIMITY_STEP = 0.6;
/** Radius of a reading spot on the floor. */
const SPOT_RADIUS = 0.42;
/** Scratch vector for the camera heading — one, not one per frame. */
const look = new THREE.Vector3();
/** How far above the panel's centre the preview's eye sits. */
const READING_EYE_LIFT = 0.55;

/**
 * Walking: W/A/S/D or the arrow keys move the reader through the building —
 * forward, back and strafing with W/S/A/D, turning with ←/→ (and Q/E). The
 * walls are solid (`roomWalkStep` slides the step along them), so a doorway
 * is the only way from the corridor into a room, which is what makes the
 * doors mean anything.
 *
 * The pose lives in a ref and is written straight from the frame loop; only
 * the ROOM the reader is in is state, and only because mounting a room's
 * pages depends on it.
 */
export function useRoomWalking({
  enabled,
  poseRef,
  walls,
  floorY,
  onRoomChange,
  onEnterDoor,
  spots,
  onReachSpot,
}: {
  enabled: boolean;
  poseRef: React.MutableRefObject<ReaderPose>;
  walls: RoomWall[];
  floorY: number;
  /** Called (from the frame loop) when the reader walks into or out of a room. */
  onRoomChange: (pose: ReaderPose) => void;
  /** Called when the reader walks up to a link door — they go through it. */
  onEnterDoor: (href: string) => void;
  /** The reading spots of the room the reader is in. */
  spots: ReadingSpot[];
  /**
   * Called when the reader walks onto a page's spot — that page becomes the
   * one being read — and, less often, as they move, so the field can re-judge
   * which pages are close enough to render for real.
   */
  onReachSpot: (pageIndex: number | null, pose: ReaderPose) => void;
}) {
  const held = React.useRef(new Set<string>());
  /** The door being leaned on, and for how long — so it opens once, not per frame. */
  const atDoor = React.useRef<string | null>(null);
  const dwell = React.useRef(0);
  /** The spot last reported, and where the reader was when we last reported. */
  const atSpot = React.useRef<number | null>(null);
  const reportedAt = React.useRef({ x: Infinity, z: Infinity });
  /** Whether we have already squared the reader up on the spot they stopped on. */
  const squared = React.useRef(true);
  /** How long they have been standing still — a stop, not a gap between keys. */
  const still = React.useRef(0);

  React.useEffect(() => {
    if (!enabled) return;
    const editing = (t: EventTarget | null) => {
      const el = t as HTMLElement | null;
      return (
        !!el &&
        (el.isContentEditable ||
          el.tagName === "INPUT" ||
          el.tagName === "TEXTAREA" ||
          el.tagName === "SELECT")
      );
    };
    const KEYS = new Set([
      "w",
      "a",
      "s",
      "d",
      "q",
      "e",
      "arrowup",
      "arrowdown",
      "arrowleft",
      "arrowright",
    ]);
    const down = (ev: KeyboardEvent) => {
      const k = ev.key.toLowerCase();
      if (!KEYS.has(k) || editing(ev.target)) return;
      ev.preventDefault();
      held.current.add(k);
    };
    const up = (ev: KeyboardEvent) => held.current.delete(ev.key.toLowerCase());
    const blur = () => held.current.clear();
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", blur);
      held.current.clear();
    };
  }, [enabled]);

  useFrame((state, dt) => {
    if (!enabled) return;
    const pose0 = poseRef.current;
    if (held.current.size === 0) {
      // Come to a stop ON a page's mark and the reader turns to it, the way
      // you stop in front of a painting and square up. Once only — someone
      // who then looks elsewhere stays looking elsewhere — and the position
      // is never touched, so it can never shove anybody through a wall.
      still.current += Math.min(dt, 0.1);
      if (
        !squared.current &&
        atSpot.current !== null &&
        still.current >= SQUARE_AFTER
      ) {
        const s = spots.find((sp) => sp.pageIndex === atSpot.current);
        if (
          s &&
          Math.hypot(pose0.x - s.centre.x, pose0.z - s.centre.z) <= SQUARE_RADIUS
        )
          pose0.yaw = s.yaw;
        // Either way, do not keep trying: standing off the mark is a place a
        // reader is allowed to stand.
        squared.current = true;
      }
      return;
    }
    still.current = 0;
    squared.current = false;
    const k = held.current;
    const step = WALK_SPEED * Math.min(dt, 0.1);
    const turn = TURN_SPEED * Math.min(dt, 0.1);
    const pose = poseRef.current;

    if (k.has("arrowleft") || k.has("q")) pose.yaw += turn;
    if (k.has("arrowright") || k.has("e")) pose.yaw -= turn;
    // Turning is unbounded; the bearing is not.
    if (pose.yaw > Math.PI) pose.yaw -= 2 * Math.PI;
    else if (pose.yaw < -Math.PI) pose.yaw += 2 * Math.PI;

    // Forward is WHERE THE CAMERA LOOKS, not where the station faces. The
    // building is carried so the reader's bearing lands down −z, so on an
    // untouched preview camera the two are the same thing — but orbit or pan
    // it and they diverge, and keys that move you relative to a station you
    // are no longer looking from feel reversed. Taking the camera's own
    // heading and rotating it back into building space covers both, and in
    // XR it is simply "walk where you are looking".
    state.camera.getWorldDirection(look);
    let fx: number;
    let fz: number;
    const flat = Math.hypot(look.x, look.z);
    if (flat > 1e-3) {
      // world → building: undo the group's turn, which is −pose.yaw.
      const cy = Math.cos(pose.yaw);
      const sy = Math.sin(pose.yaw);
      const wx = look.x / flat;
      const wz = look.z / flat;
      fx = wx * cy + wz * sy;
      fz = -wx * sy + wz * cy;
    } else {
      // Looking straight up or down: fall back to the reader's own bearing.
      fx = -Math.sin(pose.yaw);
      fz = -Math.cos(pose.yaw);
    }
    let dx = 0;
    let dz = 0;
    if (k.has("w") || k.has("arrowup")) {
      dx += fx * step;
      dz += fz * step;
    }
    if (k.has("s") || k.has("arrowdown")) {
      dx -= fx * step;
      dz -= fz * step;
    }
    // Strafing is forward turned a quarter to the left/right.
    if (k.has("a")) {
      dx += fz * step;
      dz -= fx * step;
    }
    if (k.has("d")) {
      dx -= fz * step;
      dz += fx * step;
    }
    if (dx !== 0 || dz !== 0) {
      const moved = roomWalkStep(pose, dx, dz, walls, floorY);
      // Walking into a link door is how you go through it: the leaf is solid,
      // so the reader stops against it rather than stepping into the void,
      // and leaning on it for a moment is the door opening. Facing matters —
      // brushing past one down the corridor is not going through it.
      let doorHref: string | null = null;
      for (const w of walls) {
        if (!w.portal) continue;
        const ax = Math.cos(w.yaw);
        const az = -Math.sin(w.yaw);
        const half = w.size.width / 2;
        const t = Math.max(
          -half,
          Math.min(half, (moved.x - w.centre.x) * ax + (moved.z - w.centre.z) * az),
        );
        const d = Math.hypot(
          moved.x - (w.centre.x + ax * t),
          moved.z - (w.centre.z + az * t),
        );
        if (d >= DOOR_REACH) continue;
        // The leaf's face points into the corridor; the reader has to be
        // walking against it, not along it.
        const nx = Math.sin(w.yaw);
        const nz = Math.cos(w.yaw);
        if (dx * nx + dz * nz > -0.2 * Math.hypot(dx, dz)) continue;
        doorHref = w.portal.href;
        break;
      }
      if (doorHref !== atDoor.current) {
        atDoor.current = doorHref;
        dwell.current = 0;
      } else if (doorHref) {
        dwell.current += Math.min(dt, 0.1);
        if (dwell.current >= DOOR_DWELL) {
          dwell.current = -Infinity; // opened; do not fire again on this door
          onEnterDoor(doorHref);
        }
      }
      const changed = moved.x !== pose.x || moved.z !== pose.z;
      pose.x = moved.x;
      pose.z = moved.z;
      if (!changed) return;
      onRoomChange(pose);

      // Standing on a page's spot is reading that page. Reported only on a
      // change, and otherwise only once the reader has covered enough ground
      // to be worth re-judging what is close enough to render — the pose
      // itself lives in a ref precisely so walking does not re-render.
      let on: number | null = null;
      for (const s of spots)
        if (Math.hypot(pose.x - s.centre.x, pose.z - s.centre.z) < SPOT_REACH) {
          on = s.pageIndex;
          break;
        }
      const far =
        Math.hypot(pose.x - reportedAt.current.x, pose.z - reportedAt.current.z) >
        PROXIMITY_STEP;
      if (on !== atSpot.current) squared.current = false;
      if (on !== atSpot.current || far) {
        atSpot.current = on;
        reportedAt.current = { x: pose.x, z: pose.z };
        onReachSpot(on, pose);
      }
    }
  });
}

/**
 * The building's walls: the flat surfaces the pages hang on and the corridor
 * runs between. A section's pages are what makes its room — but pages alone
 * floated in the dark, so every wall is a plane standing on the floor and
 * carrying on a head above the page band, with the DOORWAYS left as gaps in
 * it (see `wallRun` — each opening becomes two flanking pieces and a lintel).
 *
 * Double-sided on purpose: a room has to be a solid box with two doors, or
 * the rooms beyond it show through and the enclosure is gone. `navBg` is the
 * theme's recessed surface, so the walls sit behind the pages in the same way
 * a nav panel sits behind content.
 *
 * Raycast-inert: a wall is scenery, and must never eat a click meant for the
 * page in front of it.
 */
export function RoomShell({
  walls,
  anchor,
}: {
  walls: RoomWall[];
  /** The main panel's top-left anchor in world space — walls are relative to it. */
  anchor: { x: number; y: number; z: number };
}) {
  const theme = useTheme();
  return (
    <group raycast={() => null}>
      {walls.map((w, i) => (
        <mesh
          key={`room-wall-${i}`}
          position={[
            anchor.x + w.centre.x,
            anchor.y + w.centre.y,
            anchor.z + w.centre.z,
          ]}
          rotation={[0, w.yaw, 0]}
        >
          <planeGeometry args={[w.size.width, w.size.height]} />
          {/* The lintel over a doorway in the trim colour: an opening you can
              see from down the corridor beats one you find by bumping into
              the wall beside it. */}
          <meshStandardMaterial
            color={w.lintel ? theme.panelRim : theme.navBg}
            side={THREE.DoubleSide}
            roughness={1}
            metalness={0}
          />
        </mesh>
      ))}
    </group>
  );
}

/**
 * The floor and the ceiling. A room is not a room without them — four walls
 * in a void give a reader nothing to stand on and no way to tell up from
 * down — and they close the building off so a corridor reads as an interior.
 * Raycast-inert, like the walls: scenery never eats a click.
 */
export function RoomSlabs({
  slabs,
  anchor,
}: {
  slabs: RoomSlab[];
  anchor: { x: number; y: number; z: number };
}) {
  const theme = useTheme();
  return (
    <group raycast={() => null}>
      {slabs.map((s, i) => (
        <mesh
          key={`room-slab-${i}`}
          position={[
            anchor.x + s.centre.x,
            anchor.y + s.centre.y,
            anchor.z + s.centre.z,
          ]}
          // A plane faces +z; a quarter turn back lays it flat facing up, a
          // quarter turn forward lays it flat facing down.
          rotation={[s.facing === "up" ? -Math.PI / 2 : Math.PI / 2, 0, 0]}
        >
          <planeGeometry args={[s.size.width, s.size.depth]} />
          {/* The floor a shade lighter than the walls so it reads as lit and
              the reader can tell where the ground is; the ceiling the same
              material as the walls, so it closes the space without drawing
              the eye up. */}
          <meshStandardMaterial
            color={s.facing === "up" ? theme.inputBg : theme.navBg}
            roughness={1}
            metalness={0}
          />
        </mesh>
      ))}
    </group>
  );
}

/**
 * A link door: the leaf filling one of the openings in a links corridor,
 * carrying the link's own text over where it goes. Clicking it follows the
 * link through NavigateContext — the same route an inline link inside a page
 * takes — and so does walking into it (see `useRoomWalking`), which is what
 * makes an external link a door to another gallery rather than a note on a
 * wall.
 */
function LinkDoorLeaf({
  wall,
  anchor,
}: {
  wall: RoomWall;
  anchor: { x: number; y: number; z: number };
}) {
  const theme = useTheme();
  const fontType = React.useContext(FontContext);
  const navigate = React.useContext(NavigateContext);
  const [hot, setHot] = React.useState(false);
  const portal = wall.portal!;
  const { width: w, height: h } = wall.size;
  const target = React.useMemo(() => {
    if (portal.href.startsWith("#"))
      return `↳ ${decodeURIComponent(portal.href.slice(1))}`;
    try {
      return new URL(portal.href, "https://x.invalid").hostname.replace(
        /^www\./,
        "",
      );
    } catch {
      return portal.href;
    }
  }, [portal.href]);

  return (
    <group
      position={[
        anchor.x + wall.centre.x,
        anchor.y + wall.centre.y,
        anchor.z + wall.centre.z,
      ]}
      rotation={[0, wall.yaw, 0]}
    >
      <mesh
        onClick={(e) => {
          e.stopPropagation();
          navigate?.(portal.href);
        }}
        onPointerOver={(e) => {
          e.stopPropagation();
          setHot(true);
        }}
        onPointerOut={() => setHot(false)}
      >
        <planeGeometry args={[w, h]} />
        <meshStandardMaterial
          color={hot ? theme.listItemBg : theme.panelBg}
          roughness={0.85}
          metalness={0}
        />
      </mesh>
      {/* The door's own sign, at head height on the leaf. */}
      <Text
        font={fontType}
        anchorX="center"
        anchorY="bottom"
        position={[0, h * 0.12, 0.02]}
        fontSize={0.075}
        color={hot ? theme.rimHighlight : theme.accentCol}
        maxWidth={w * 0.84}
        textAlign="center"
      >
        {portal.label.slice(0, 70)}
      </Text>
      <Text
        font={fontType}
        anchorX="center"
        anchorY="top"
        position={[0, h * 0.04, 0.02]}
        fontSize={0.05}
        color={theme.mutedTextCol}
        maxWidth={w * 0.84}
      >
        {target}
      </Text>
    </group>
  );
}

export function LinkDoors({
  walls,
  anchor,
}: {
  walls: RoomWall[];
  anchor: { x: number; y: number; z: number };
}) {
  return (
    <>
      {walls
        .filter((w) => w.portal)
        .map((w, i) => (
          <LinkDoorLeaf key={`link-door-${i}`} wall={w} anchor={anchor} />
        ))}
    </>
  );
}

/**
 * The blue spot on the floor in front of every page in the room: where you
 * stand to read it. This is how `rooms` navigates. A pagination widget
 * belongs to a panel you sit in front of; in a building you walk, and the
 * spots are what tell you where the reading positions are — walk onto one and
 * that page is the one you are reading, or click one to be taken there.
 *
 * The spot you are on is filled and ringed; the rest are quiet outlines with
 * their page number, so a room reads as a set of places to stand.
 */
export function ReadingSpots({
  spots,
  anchor,
  focus,
  standingOn,
  here,
  onSelect,
}: {
  spots: ReadingSpot[];
  anchor: { x: number; y: number; z: number };
  focus: number;
  /** The spot the reader is standing on, if any. */
  standingOn: number | null;
  /** Pages of the room the reader is in — the rest are the next room's. */
  here: { start: number; end: number } | null;
  onSelect: (pageIndex: number) => void;
}) {
  const theme = useTheme();
  const fontType = React.useContext(FontContext);
  return (
    <>
      {spots.map((s) => {
        const on = s.pageIndex === standingOn || s.pageIndex === focus;
        // A spot in the room ahead reads fainter: it is a place to go, not a
        // place you are.
        const ahead =
          !!here && (s.pageIndex < here.start || s.pageIndex > here.end);
        const dim = ahead ? 0.45 : 1;
        return (
          <group
            key={`reading-spot-${s.pageIndex}`}
            position={[
              anchor.x + s.centre.x,
              // A hair above the floor: coplanar with it they would z-fight.
              anchor.y + s.centre.y + 0.012,
              anchor.z + s.centre.z,
            ]}
            rotation={[-Math.PI / 2, 0, 0]}
          >
            <mesh
              onClick={(e) => {
                e.stopPropagation();
                onSelect(s.pageIndex);
              }}
            >
              <circleGeometry args={[SPOT_RADIUS, 32]} />
              <meshBasicMaterial
                color={theme.accentCol}
                transparent
                opacity={(on ? 0.55 : 0.22) * dim}
                depthWrite={false}
              />
            </mesh>
            <mesh position={[0, 0, 0.002]} raycast={() => null}>
              <ringGeometry args={[SPOT_RADIUS * 0.86, SPOT_RADIUS, 32]} />
              <meshBasicMaterial
                color={on ? theme.rimHighlight : theme.accentCol}
                transparent
                opacity={(on ? 0.95 : 0.5) * dim}
                depthWrite={false}
              />
            </mesh>
            <Text
              font={fontType}
              anchorX="center"
              anchorY="middle"
              position={[0, 0, 0.004]}
              // Laid on the floor with its head away from the reader, so the
              // number is upright to whoever is standing on the spot.
              rotation={[0, 0, s.yaw]}
              fontSize={0.16}
              color={on ? theme.rimHighlight : theme.accentCol}
              fillOpacity={(on ? 1 : 0.75) * dim}
            >
              {String(s.pageIndex + 1)}
            </Text>
          </group>
        );
      })}
    </>
  );
}

/**
 * Putting the preview camera back on the reading line.
 *
 * The building is carried so the reader's pose lands at the panel slot — that
 * is what "standing in front of a page" means here — but the preview's camera
 * is OrbitControls', and orbiting swings the eye around that slot. Come at a
 * page from 90° round and it lands edge-on: correctly placed, uselessly
 * viewed. So clicking a spot restores the reading view as well as the pose,
 * which is what "take me to this page" has to mean when the camera is free.
 *
 * The restored view is the preview's own default: one reading distance in
 * front of the panel centre, a little above it. Dragging the camera away
 * again is always one gesture away, and in an immersive session there are no
 * controls to restore — the headset is the camera — so this no-ops.
 */
export function useReadingView(
  panelCentre: { x: number; y: number; z: number } | null,
  viewingDistance: number,
) {
  const camera = useThree((s) => s.camera);
  const gl = useThree((s) => s.gl);
  const controls = useThree((s) => s.controls) as {
    target?: THREE.Vector3;
    update?: () => void;
  } | null;
  return React.useCallback(() => {
    if (!panelCentre || gl.xr.isPresenting) return;
    const t = controls?.target;
    if (!t) return;
    t.set(panelCentre.x, panelCentre.y, panelCentre.z);
    camera.position.set(
      panelCentre.x,
      panelCentre.y + READING_EYE_LIFT,
      panelCentre.z + viewingDistance,
    );
    camera.lookAt(t);
    controls?.update?.();
  }, [panelCentre, viewingDistance, camera, controls, gl]);
}
