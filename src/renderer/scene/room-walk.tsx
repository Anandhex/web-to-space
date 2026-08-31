/**
 * scene/room-walk.tsx
 *
 * The locomotion half of the `rooms` view — walking, doors and reading spots.
 * What the building is MADE of (walls, floor, ceiling, light fittings) is the
 * other half, next door in `room-decor.tsx`.
 *
 * Locomotion is one eased group wrapped around the whole page field that
 * carries the room — rigidly — until the reader is standing square-on to the
 * focused exhibit.
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
import { LOOK_PIVOT } from "./camera";
import { GALLERY_DOOR, GALLERY_SIGN } from "./room-decor";
import { useTheme } from "../theme";
import { FontContext } from "./contexts";
import { NavigateContext } from "../primitives/contexts";
import { useTraversal } from "./contexts";
import { markForAxis } from "./link-doors";
import {
  roomPoseTransform,
  ROOM_EYE_HEIGHT,
  ROOM_STOREY_H,
  walkSurfaceAt,
  type RoomStair,
  roomFloorContains,
  roomTeleportPath,
  roomWalkStep,
  type ReaderPose,
  type ReadingSpot,
  type RoomSlab,
  type RoomWall,
} from "../page-placements";
import { useXRThumbsticks } from "./xr-locomotion";

export function RoomWalk({
  anchor,
  poseRef,
  jumpRef,
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
  /**
   * A counter the reader bumps when they JUMPED rather than walked — a
   * teleport, or a reading spot clicked from across the room.
   *
   * The ease below is what makes walking read as walking, and it is exactly
   * what must not happen to a jump. Gliding a reader ten metres across a
   * gallery in a quarter of a second is the strongest vection cue this app can
   * produce, and in a headset it is the difference between a view somebody can
   * use and one they take off. On a change, the carrier lands on the new pose
   * in one frame.
   */
  jumpRef?: React.MutableRefObject<number>;
  panel: { width: number; height: number };
  viewingDistance: number;
  children: React.ReactNode;
}) {
  const ref = React.useRef<THREE.Group>(null);
  const inited = React.useRef(false);
  /**
   * THE EASE LIVES IN POSE SPACE, NOT IN TRANSFORM SPACE.
   *
   * This used to hold an eased copy of the GROUP's position and rotation, one
   * lerped toward the other's target independently — and those two are not
   * independent. `roomPoseTransform` sets position to `station − Ry(yaw)·pose`,
   * so the position that puts the reader at the station depends on the yaw,
   * nonlinearly. Ease them apart and, part-way through, they describe a
   * transform that puts the reader somewhere else entirely: they swing on an
   * arc whose radius is their distance from the panel anchor.
   *
   * That radius is the whole building — tens of metres by the last section —
   * so a turn on the spot deep in the enfilade slid the reader most of a
   * metre sideways and straight through a corridor wall, growing worse the
   * further in they had walked. Turning was moving.
   *
   * Easing the pose itself and deriving the transform from it each frame
   * makes that unrepresentable: whatever the ease is doing, the transform is
   * always one that puts the reader exactly at their station.
   */
  const eased = React.useRef<ReaderPose>({ ...poseRef.current });
  /** The last jump we landed, so one bump lands once. */
  const landed = React.useRef(jumpRef?.current ?? 0);

  const apply = React.useCallback(
    (pose: ReaderPose) => {
      const g = ref.current;
      if (!g) return;
      const t = roomPoseTransform(pose, panel, viewingDistance);
      g.position.set(
        anchor.x + t.position.x,
        anchor.y + t.position.y,
        anchor.z + t.position.z,
      );
      g.rotation.y = t.yaw;
    },
    [anchor.x, anchor.y, anchor.z, panel, viewingDistance],
  );

  // The first room is entered, not walked into: land on the pose so the view
  // opens with the reader already at page 1 rather than gliding in from the
  // world origin.
  React.useLayoutEffect(() => {
    if (ref.current && !inited.current) {
      eased.current = { ...poseRef.current };
      apply(eased.current);
      inited.current = true;
    }
  });

  useFrame((_, dt) => {
    if (!ref.current || !inited.current) return;
    const t = poseRef.current;
    const e = eased.current;

    // A jump is not a very fast walk: cut to it, whole.
    if (jumpRef && jumpRef.current !== landed.current) {
      landed.current = jumpRef.current;
      e.x = t.x;
      e.z = t.z;
      e.yaw = t.yaw;
      e.rise = t.rise;
      apply(e);
      return;
    }

    const a = 1 - Math.exp(-MORPH_RATE * Math.min(dt, 0.1));

    const dx = t.x - e.x;
    const dz = t.z - e.z;
    if (Math.abs(dx) + Math.abs(dz) < MORPH_EPS) {
      e.x = t.x;
      e.z = t.z;
    } else {
      e.x += dx * a;
      e.z += dz * a;
    }

    // Turns take the short way round: a reader who steps through a doorway
    // and turns to the next wall must not spin the long way through 350°.
    let dyaw = t.yaw - e.yaw;
    while (dyaw > Math.PI) dyaw -= 2 * Math.PI;
    while (dyaw < -Math.PI) dyaw += 2 * Math.PI;
    if (Math.abs(dyaw) < MORPH_EPS) e.yaw = t.yaw;
    else e.yaw += dyaw * a;

    // ── The climb ──
    //
    // `rise` has to be eased along with x and z or the reader never actually
    // goes up: the walk was writing a new height onto the target pose every
    // step and this loop was easing everything EXCEPT that, so the transform
    // kept using a rise of zero and the flight was a ramp the reader walked
    // through rather than up.
    //
    // Eased faster than the plane movement. A stair is a discrete thing under
    // the foot, and lagging the height behind the position by the same amount
    // as a turn makes the reader sink into the treads on the way up.
    const dr = (t.rise ?? 0) - (e.rise ?? 0);
    if (Math.abs(dr) < MORPH_EPS) e.rise = t.rise;
    else e.rise = (e.rise ?? 0) + dr * Math.min(1, a * 2.2);

    apply(e);
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
 * How far one push of the turn stick swings the reader, in radians, and the
 * detent that keeps one push to one swing.
 *
 * SNAP, not smooth. Smooth yaw from a thumbstick is the single most reliable
 * way to make somebody sick in a headset: the inner ear reports no rotation
 * while the whole world turns, and unlike forward motion there is no way to
 * brace for it. A discrete step is over before the conflict registers. Thirty
 * degrees is the usual choice — coarse enough to be a step, fine enough that
 * four of them face you back down a corridor.
 *
 * The keyboard keeps its smooth turn: at a desk the world is a window, not a
 * room, and Q/E turning in steps would be unusable.
 */
const SNAP_TURN = Math.PI / 6;
const SNAP_HOLD = 0.6;
const SNAP_REPEAT = 0.28;
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
export const SPOT_REACH = 0.55;
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

/**
 * Walking: W/A/S/D or the arrow keys move the reader through the building —
 * forward, back and strafing with W/S/A/D, turning with ←/→ (and Q/E) — and,
 * in a headset, the left thumbstick walks and the right one snap-turns. The
 * walls are solid (`roomWalkStep` slides the step along them), so a doorway
 * is the only way from the corridor into a room, which is what makes the
 * doors mean anything.
 *
 * Both inputs feed ONE intent (see the frame loop), so there is exactly one
 * set of walking rules; the headset's third way in, teleporting, is
 * {@link RoomTeleport} and goes through the same wall geometry.
 *
 * The pose lives in a ref and is written straight from the frame loop; only
 * the ROOM the reader is in is state, and only because mounting a room's
 * pages depends on it.
 */
export function useRoomWalking({
  enabled,
  poseRef,
  jumpRef,
  walls,
  stairs,
  floorY,
  onRoomChange,
  onEnterDoor,
  spots,
  onReachSpot,
}: {
  enabled: boolean;
  poseRef: React.MutableRefObject<ReaderPose>;
  /**
   * Bumped on a SNAP TURN, so the carrier lands on the new bearing instead of
   * easing to it. Easing a snap turn is a smooth turn taking 250 ms, which is
   * the precise thing snapping exists to avoid — see SNAP_TURN and RoomWalk.
   */
  jumpRef?: React.MutableRefObject<number>;
  walls: RoomWall[];
  /** The flights, so walking onto one raises the reader tread by tread. */
  stairs: RoomStair[];
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
  /**
   * The headset's half of the same walk. A reader in VR has no keys, so the
   * left stick is W/A/S/D and the right one is Q/E — fed into the SAME frame
   * loop below, which is what keeps doors, reading spots and wall collision
   * behaving identically however the reader is driving.
   */
  const sticks = useXRThumbsticks();
  /** Snap-turn detent: the direction currently latched, and its repeat clock. */
  const snapped = React.useRef(0);
  const snapHeld = React.useRef(0);

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
    const k = held.current;
    const presenting = state.gl.xr.isPresenting;
    const stick = presenting
      ? sticks()
      : { left: { x: 0, y: 0 }, right: { x: 0, y: 0 } };

    // ONE INTENT, TWO INPUTS. Everything below — collision, doors, spots,
    // squaring up — reads these three numbers and never asks where they came
    // from, so the headset cannot drift into a second, subtly different set of
    // walking rules the way it would if it had its own loop.
    let fwd = 0;
    let strafe = 0;
    let spin = 0;
    if (k.has("w") || k.has("arrowup")) fwd += 1;
    if (k.has("s") || k.has("arrowdown")) fwd -= 1;
    if (k.has("d")) strafe += 1;
    if (k.has("a")) strafe -= 1;
    if (k.has("arrowleft") || k.has("q")) spin += 1;
    if (k.has("arrowright") || k.has("e")) spin -= 1;
    fwd += stick.left.y;
    strafe += stick.left.x;
    // Diagonals are not faster than straight lines. Keys used to add two
    // full-speed steps at right angles, so a reader holding W and D crossed
    // the room 41% faster and cleared gaps their straight-on self could not.
    const mag = Math.hypot(fwd, strafe);
    if (mag > 1) {
      fwd /= mag;
      strafe /= mag;
    }

    // The turn stick is detented into 30° steps (see SNAP_TURN); the keys stay
    // smooth. `snap` is a whole swing to apply this frame, not a rate.
    let snap = 0;
    const tx = stick.right.x;
    const dir = tx >= 0.65 ? 1 : tx <= -0.65 ? -1 : 0;
    if (snapped.current !== 0 && Math.abs(tx) < 0.35) snapped.current = 0;
    else if (dir !== 0) {
      if (dir !== snapped.current) {
        snapped.current = dir;
        snapHeld.current = -SNAP_HOLD;
        snap = -dir * SNAP_TURN;
      } else {
        snapHeld.current += Math.min(dt, 0.1);
        if (snapHeld.current >= SNAP_REPEAT) {
          snapHeld.current -= SNAP_REPEAT;
          snap = -dir * SNAP_TURN;
        }
      }
    }

    if (fwd === 0 && strafe === 0 && spin === 0 && snap === 0) {
      // Come to a stop ON a page's mark and the reader turns to it, the way
      // you stop in front of a painting and square up. Once only — someone
      // who then looks elsewhere stays looking elsewhere — and the position
      // is never touched, so it can never shove anybody through a wall.
      still.current += Math.min(dt, 0.1);
      if (
        !squared.current &&
        atSpot.current !== null &&
        still.current >= SQUARE_AFTER &&
        // Not in a headset. Squaring up turns the BUILDING, and a reader
        // wearing one has a neck that did not turn with it: the world swinging
        // by itself under a still head is the exact vestibular conflict that
        // makes people take a headset off. At a desk it is a nicety; in VR the
        // reader's own head is already the aim, so there is nothing to correct.
        !presenting
      ) {
        const s = spots.find((sp) => sp.pageIndex === atSpot.current);
        if (
          s &&
          Math.hypot(pose0.x - s.centre.x, pose0.z - s.centre.z) <=
            SQUARE_RADIUS
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
    const step = WALK_SPEED * Math.min(dt, 0.1);
    const turn = TURN_SPEED * Math.min(dt, 0.1);
    const pose = poseRef.current;

    pose.yaw += spin * turn + snap;
    if (snap !== 0 && jumpRef) jumpRef.current += 1;
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
    // Strafing is forward turned a quarter to the right.
    const dx = (fx * fwd - fz * strafe) * step;
    const dz = (fz * fwd + fx * strafe) * step;
    if (dx !== 0 || dz !== 0) {
      // Collision is worked on the storey the reader is STANDING on. The
      // building's `floorY` is the reading floor; a reader on a landing is one
      // storey up or down from it, and the walls that bound them are that
      // storey's.
      // Collision is worked on the NEAREST STOREY, not on the reader's exact
      // height.
      //
      // A wall is solid to a reader whose floor it spans. Using the raw rise
      // meant that part-way up a flight the reader was in the band between the
      // ceiling below and the floor above, where NO wall spans — so mid-climb
      // they were bounded by nothing and walked straight out through the end
      // wall of the stairwell. Snapping to the nearest storey keeps them inside
      // one storey's walls for the whole climb, which is what a stairwell is.
      const storeyY =
        floorY + Math.round((pose.rise ?? 0) / ROOM_STOREY_H) * ROOM_STOREY_H;
      const moved = roomWalkStep(pose, dx, dz, walls, storeyY);
      // The floor under the new position. Sampling it every step is what makes
      // a flight something the reader CLIMBS: they rise with the treads as
      // they walk onto it and are set down on the landing at the top, rather
      // than being put there.
      pose.rise =
        walkSurfaceAt(stairs, moved.x, moved.z, floorY, pose.rise ?? 0) -
        floorY;
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
          Math.min(
            half,
            (moved.x - w.centre.x) * ax + (moved.z - w.centre.z) * az,
          ),
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
        Math.hypot(
          pose.x - reportedAt.current.x,
          pose.z - reportedAt.current.z,
        ) > PROXIMITY_STEP;
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
 * A link door: the leaf filling one of the openings in a links corridor,
 * carrying the link's own text over where it goes. Clicking it follows the
 * link through NavigateContext — the same route an inline link inside a page
 * takes — and so does walking into it (see `useRoomWalking`), which is what
 * makes an external link a door to another gallery rather than a note on a
 * wall.
 *
 * It is BUILT like a door — stiles and rails, two recessed panels, a brass
 * lever at hand height — rather than drawn as a rectangle with a label on it.
 * That is not decoration for its own sake: a plain slab reads as a hole in
 * the wall, and the reader's only cue that they may walk into it was the
 * writing, which is unreadable from the far end of a corridor. The panel
 * shadows and the lever read as "door" at any distance, and the sign then
 * only has to say WHICH door.
 *
 * Every proportion below is a fraction of the leaf, so retuning LINK_DOOR_W /
 * LINK_DOOR_H in page-placements.ts cannot leave a rail hanging in mid-air.
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
  const traversal = useTraversal();
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

  /**
   * Opening the door.
   *
   * Routed through TRAVERSAL when the door knows which way it goes, so the
   * move is recorded and the reader gets a way back on the far side. A door
   * with no axis — a same-page fragment, or a corridor built before the link
   * layer was wired — falls back to plain navigation, which is what it always
   * did.
   */
  const open = React.useCallback(() => {
    if (portal.axis && traversal)
      traversal.traverse(portal.href, portal.axis, portal.label);
    else navigate?.(portal.href);
  }, [portal.axis, portal.href, portal.label, traversal, navigate]);

  // Joinery, all in the leaf's own frame: y runs from −h/2 at the threshold
  // to +h/2 at the head.
  const stile = w * 0.11;
  const panelW = w - 2 * stile;
  const lockY = -h * 0.03;
  const lockH = h * 0.07;
  const upper = { top: h / 2 - h * 0.05, bottom: lockY + lockH / 2 };
  const lower = { top: lockY - lockH / 2, bottom: -h / 2 + h * 0.09 };
  const panel = (p: { top: number; bottom: number }, key: string) => (
    <mesh
      key={key}
      position={[0, (p.top + p.bottom) / 2, 0.006]}
      raycast={() => null}
    >
      <planeGeometry args={[panelW, p.top - p.bottom]} />
      <meshStandardMaterial
        color={GALLERY_DOOR.panel}
        roughness={0.72}
        metalness={0}
      />
    </mesh>
  );
  /**
   * The sign plate, on the upper panel where a room's name would be. It takes
   * most of the panel: the leaf is sized off the pages now (see
   * `linkDoorSize`) and is narrower than it was, so a link title runs to three
   * lines where it used to run to two.
   */
  const plateH = Math.min((upper.top - upper.bottom) * 0.72, 0.38);

  return (
    <group
      position={[
        anchor.x + wall.centre.x,
        anchor.y + wall.centre.y,
        anchor.z + wall.centre.z,
      ]}
      rotation={[0, wall.yaw, 0]}
    >
      {/* What is BEHIND the leaf.
          A link door opens onto another document, so there is no room behind
          it — and the leaf is a single-sided plane, so from any angle that
          sees past its edge (down a corridor, or from the landing above,
          across the well) the opening was a black rectangle. A shallow dark
          reveal, a little larger than the leaf and double-sided, closes it:
          what you see past a door edge is the inside of a doorway, which is
          what a doorway looks like. */}
      <mesh position={[0, 0, -0.05]} raycast={() => null}>
        <planeGeometry args={[w + 0.12, h + 0.12]} />
        <meshStandardMaterial
          color="#3B352D"
          roughness={0.95}
          metalness={0}
          side={THREE.DoubleSide}
        />
      </mesh>
      {/* The leaf. This one mesh takes the click and the hover for the whole
          door — everything mounted on it is raycast-inert, so pointing at the
          lever or the sign is still pointing at the door. */}
      <mesh
        onClick={(e) => {
          e.stopPropagation();
          open();
        }}
        onPointerOver={(e) => {
          e.stopPropagation();
          setHot(true);
        }}
        onPointerOut={() => setHot(false)}
      >
        <planeGeometry args={[w, h]} />
        <meshStandardMaterial
          color={hot ? GALLERY_DOOR.leafHot : GALLERY_DOOR.leaf}
          roughness={0.68}
          metalness={0}
        />
      </mesh>
      {/* Stiles and rails: a frame standing a few millimetres proud, with the
          two panels set back inside it. Boxes rather than planes so the
          gallery light above rakes across their edges — which is the entire
          reason a panelled door reads as one. */}
      <group raycast={() => null}>
        {[-1, 1].map((s) => (
          <mesh key={`stile-${s}`} position={[(s * (w - stile)) / 2, 0, 0.012]}>
            <boxGeometry args={[stile, h, 0.024]} />
            <meshStandardMaterial
              color={GALLERY_DOOR.frame}
              roughness={0.66}
              metalness={0}
            />
          </mesh>
        ))}
        {[
          { y: h / 2 - (h * 0.05) / 2, t: h * 0.05 },
          { y: lockY, t: lockH },
          { y: -h / 2 + (h * 0.09) / 2, t: h * 0.09 },
        ].map((r, i) => (
          <mesh key={`rail-${i}`} position={[0, r.y, 0.012]}>
            <boxGeometry args={[panelW, r.t, 0.024]} />
            <meshStandardMaterial
              color={GALLERY_DOOR.frame}
              roughness={0.66}
              metalness={0}
            />
          </mesh>
        ))}
        {[panel(upper, "panel-upper"), panel(lower, "panel-lower")]}
        {/* The lever, on the lock rail at hand height. A door with a handle
            is a door you may open; without one it is a panel in a wall. */}
        <mesh position={[w * 0.3, lockY, 0.036]}>
          <cylinderGeometry args={[0.03, 0.03, 0.014, 16]} />
          <meshStandardMaterial
            color={GALLERY_DOOR.brass}
            roughness={0.34}
            metalness={0.7}
          />
        </mesh>
        <mesh position={[w * 0.24, lockY, 0.044]}>
          <boxGeometry args={[0.13, 0.022, 0.022]} />
          <meshStandardMaterial
            color={GALLERY_DOOR.brass}
            roughness={0.34}
            metalness={0.7}
          />
        </mesh>
      </group>
      {/* No steps in front of the leaf.
          A door that led up or down used to get three treads drawn rising
          into it, from the version of this view that had ONE storey: the
          treads were how "up" was said at all, because the door was not
          actually up anything. It is now — parents hang on the landing above
          and externals on the one below, reached by a real flight at the end
          of the corridor — so the same three treads are a second, false stair
          under every door, floating on the landing floor a storey away from
          anything they could lead to. Anand, 2026-08-18: "why are there
          stairs below the door". */}
      {/* The door's sign: a pale plate with the name cut dark into it, the
          same plate a room's doorway carries (GALLERY_SIGN). Unlit, so it is
          as readable from the dark end of a corridor as from under a lamp —
          which is the whole job, since this is what tells the reader where
          the door goes before they are close enough to touch it. */}
      <group raycast={() => null}>
        <mesh position={[0, (upper.top + upper.bottom) / 2, 0.014]}>
          <planeGeometry args={[panelW * 0.9, plateH]} />
          <meshBasicMaterial color={GALLERY_SIGN.plate} toneMapped={false} />
        </mesh>
        {/* The name, with the direction's own glyph in front of it — the
            same mark the reader met at the anchor. The legend is one legend:
            a door reached from a ▴ anchor says ▴ on its sign. */}
        <Text
          font={fontType}
          anchorX="center"
          anchorY="bottom"
          position={[0, (upper.top + upper.bottom) / 2 + plateH * 0.04, 0.016]}
          fontSize={0.045}
          color={hot ? theme.accentCol : GALLERY_SIGN.text}
          maxWidth={panelW * 0.8}
          textAlign="center"
          overflowWrap="break-word"
        >
          {(portal.axis ? `${markForAxis(portal.axis)} ` : "") +
            (portal.isReturn ? "back to " : "") +
            portal.label.slice(0, 60)}
        </Text>
        <Text
          font={fontType}
          anchorX="center"
          anchorY="top"
          position={[0, (upper.top + upper.bottom) / 2 - plateH * 0.06, 0.016]}
          fontSize={0.034}
          color={GALLERY_SIGN.edge}
          maxWidth={panelW * 0.8}
        >
          {target}
        </Text>
      </group>
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

/** Radius of the teleport reticle — read as a place to stand, so: a spot. */
const RETICLE_RADIUS = 0.34;
/** Scratch, module scope: this runs on every ray-cast and every frame. */
const aimLocal = new THREE.Vector3();

/**
 * How long a press may be held and still read as a tap rather than a drag.
 *
 * In a headset this is nearly a formality — a trigger pull is a click and
 * @pmndrs/pointer-events has already thresholded it. In the flat preview it is
 * load-bearing: the floor is also the thing the reader drags across to orbit
 * the building, and a released orbit is a `click` on whatever the pointer
 * happened to finish over.
 */
const TAP_MS = 400;
/**
 * …and how far the aim may have travelled across the floor between press and
 * release. An orbit drag sweeps it metres; a tap does not move it at all.
 */
const TAP_SLIP = 0.9;

/**
 * The plan extent of every up-facing slab — the floor as the building laid it,
 * flattened, which is the patch the catcher below has to cover.
 */
function floorPlanBounds(
  slabs: RoomSlab[],
): { cx: number; cz: number; width: number; depth: number } | null {
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const s of slabs) {
    if (s.facing !== "up") continue;
    const hw = s.size.width / 2;
    const hd = Math.abs(s.size.depth) / 2;
    minX = Math.min(minX, s.centre.x - hw);
    maxX = Math.max(maxX, s.centre.x + hw);
    minZ = Math.min(minZ, s.centre.z - hd);
    maxZ = Math.max(maxZ, s.centre.z + hd);
  }
  if (!Number.isFinite(minX)) return null;
  return {
    cx: (minX + maxX) / 2,
    cz: (minZ + maxZ) / 2,
    width: maxX - minX,
    depth: maxZ - minZ,
  };
}

/**
 * POINT AT THE FLOOR AND PULL — the headset's teleport.
 *
 * The reader's other two ways of moving both need a device they may not be
 * holding: the keys need a keyboard, the stick needs controllers. Hand tracking
 * has neither, and this view is the one where being unable to move means being
 * unable to read past the first wall.
 *
 * ── Why it is not the gesture it used to be ──
 *
 * It was: look more than fifteen degrees below the horizon, then `select`
 * TWICE inside 450 ms. That worked, and it was miserable to use, because both
 * halves of it were built to dodge a collision rather than to be aimed.
 *
 * The head is the thing the reader READS with. Making it the thing they AIM
 * with means the two cannot happen at once: to put the mark on a doorway at
 * the far end of the enfilade you had to point your face at the floor, which
 * is the one direction from which you cannot see where you are going. And the
 * pitch gate that kept a glance at a page from arming the gesture also made
 * every short hop a deliberate stoop — the reader's complaint, and correct.
 *
 * The double tap was there because a single `select` is the app's click, and a
 * teleport that fired on one would fire on every link, pager and reading spot
 * in the room. But the ambiguity was never in the tap COUNT. It was in where
 * the tap was AIMED, and the head has no ray to answer that with.
 *
 * The hand does. Both of them already carry a drawn, visible ray (see
 * `RAY_POINTER` in `useXRSession.tsx`), and it is the same ray the reader
 * points at links with. So this is now built on the pointer instead of on the
 * head, and the gesture is the one every headset already taught its owner:
 *
 *  - **Point at the floor.** The mark appears where you would land. Your head
 *    stays where it was, which means you can watch where you are going.
 *  - **Pull the trigger** — or pinch, or, in the flat preview, click. Once.
 *
 * Nothing about it is head-relative and nothing about it is timed, so it costs
 * the reader neither a stoop nor a rhythm. And it needs no new discrimination
 * rule: a ray resting on the floor is a ray that is not on a link, and the
 * floor catcher this hangs on sits BELOW everything a click could otherwise
 * have meant — the pages hang above it, and the reading spots (`ReadingSpots`,
 * which are their own, better teleport when the destination is a page) sit a
 * few millimetres proud of it, so the nearer hit wins and this never steals
 * one.
 *
 * ── What has NOT changed ──
 *
 * The journey. The destination still has to be floor the building actually
 * laid (`roomFloorContains`), and the straight line to it still has to clear
 * the walls (`roomTeleportPath`), so a reader still enters a room through its
 * doorway and still cannot stand inside a wall. What they are spared is the
 * walking, and now also the stooping.
 *
 * It also still happens on the reader's OWN storey: the catcher rides at
 * `floorY + pose.rise`, the walls consulted are the ones that span that level,
 * and `walkSurfaceAt` — the same function the walk samples every step — is
 * what decides the height they arrive at. So a teleport onto a flight lands on
 * the tread their feet would have reached, and a whole storey still has to be
 * climbed rather than jumped. (The catcher is a single plane at that level and
 * its reject is worked in plan, which is the same one-storey model the gaze
 * version had: it can occlude a ray aimed at something directly below it. Only
 * the reader's own room is mounted, so there is nothing down there to hit.)
 *
 * Rendered INSIDE the carrier (`RoomWalk`), which is why it can turn a world
 * hit point into building coordinates at all: the carrier's inverse is exactly
 * that conversion, and reading it off the live group means the ease in flight
 * cannot desynchronise the mark from the floor it is lying on.
 */
export function RoomTeleport({
  enabled,
  poseRef,
  jumpRef,
  walls,
  stairs,
  slabs,
  anchor,
  floorY,
  onArrive,
}: {
  enabled: boolean;
  poseRef: React.MutableRefObject<ReaderPose>;
  /** Bumped on arrival so the carrier lands rather than glides — see RoomWalk. */
  jumpRef: React.MutableRefObject<number>;
  walls: RoomWall[];
  /** The flights, so a teleport lands on the walking surface the walk would. */
  stairs: RoomStair[];
  /** The up-facing slabs: the floor the building actually laid. */
  slabs: RoomSlab[];
  anchor: { x: number; y: number; z: number };
  /** The floor, panel-anchor-relative. */
  floorY: number;
  /** Called with the landing pose, so the field can re-judge room and page. */
  onArrive: (pose: ReaderPose) => void;
}) {
  const theme = useTheme();
  const group = React.useRef<THREE.Group>(null);
  const catcher = React.useRef<THREE.Mesh>(null);
  const marker = React.useRef<THREE.Group>(null);
  const ring = React.useRef<THREE.MeshBasicMaterial>(null);
  const disc = React.useRef<THREE.MeshBasicMaterial>(null);

  const bounds = React.useMemo(() => floorPlanBounds(slabs), [slabs]);

  /**
   * Where the reader's ray last crossed the floor, in BUILDING coordinates, or
   * null when they are pointing at something else. A ref, not state: the
   * pointer moves every frame a hand does and re-rendering the building to
   * move a ring is not on.
   */
  const aim = React.useRef<{ x: number; z: number } | null>(null);
  /** The press a release has to match to count as a tap: when, and aimed where. */
  const press = React.useRef<{ at: number; x: number; z: number } | null>(null);
  /** The landing solved this frame, or null when there is nowhere to go. */
  const landing = React.useRef<{
    x: number;
    z: number;
    rise: number;
    blocked: boolean;
  } | null>(null);

  /**
   * A world point in the carrier's frame, as building coordinates.
   *
   * The carrier's children are laid out at `anchor + buildingOffset`; the pose
   * and the walls speak the offset alone.
   */
  const toBuilding = (p: THREE.Vector3): { x: number; z: number } | null => {
    const g = group.current;
    if (!g) return null;
    g.worldToLocal(aimLocal.copy(p));
    return { x: aimLocal.x - anchor.x, z: aimLocal.z - anchor.z };
  };

  useFrame(() => {
    const m = marker.current;
    if (!m) return;
    const rise = poseRef.current.rise ?? 0;
    // The catcher rides at the floor UNDER THE READER, not the reading floor:
    // on a landing the two are a storey apart, and a plane at the wrong one is
    // a plane the reader's ray reaches past or stops short of.
    const c = catcher.current;
    if (c) c.position.y = anchor.y + floorY + rise + 0.004;

    // Where they are pointing has to be floor the building actually LAID —
    // the catcher is one rectangle over the union of the slabs, so a corridor
    // that narrows leaves plenty of plane hanging over the void either side.
    // Inset by the reader's own radius as well: a landing half in the wall is
    // not a landing.
    const at = enabled ? aim.current : null;
    if (!at || !roomFloorContains(slabs, at.x, at.z, -0.3)) {
      landing.current = null;
      m.visible = false;
      return;
    }
    // The walls of the reader's own storey, and the walking surface carried
    // along the sweep — so the landing is on the tread their feet would have
    // reached, and no tap crosses a storey they have not climbed.
    const path = roomTeleportPath(
      poseRef.current,
      at,
      walls,
      floorY,
      stairs,
    );
    // ── Where the mark stands, and how loud it is ──
    //
    // Normally at the point a tap would actually reach. But a journey can make
    // NO progress — a wall between the reader and everything they are aiming
    // at, which the spine between the two flights is for anyone standing on
    // the hall's centre line — and then the reachable point is the reader's
    // own feet. Neither of the two obvious things to do with that is any use:
    // a mark on your own boots reads as "tap here" and does nothing, and going
    // out altogether reads as "the teleport is broken", which is what it looked
    // like from inside the stair hall.
    //
    // So it falls back to where they are AIMING, dimmed: "there, but not from
    // where you are standing" — which is a sentence the reader can act on, by
    // aiming a stride to one side of the wall in front of them.
    const reached =
      Math.hypot(
        path.x - poseRef.current.x,
        path.z - poseRef.current.z,
      ) > 0.05;
    // Only a reachable landing is something a tap may take.
    landing.current = reached ? path : null;
    const markRise = reached
      ? path.rise
      : walkSurfaceAt(stairs, at.x, at.z, floorY, rise) - floorY;
    m.visible = true;
    m.position.set(
      anchor.x + (reached ? path.x : at.x),
      anchor.y + floorY + markRise + 0.014,
      anchor.z + (reached ? path.z : at.z),
    );
    const quiet = path.blocked || !reached;
    if (ring.current) ring.current.opacity = quiet ? 0.3 : 0.95;
    if (disc.current) disc.current.opacity = quiet ? 0.1 : 0.34;
  });

  if (!enabled || !bounds) return null;

  return (
    <group ref={group}>
      {/*
        THE FLOOR CATCHER: the one hit surface in a building whose scenery is
        deliberately raycast-inert (see room-decor). It draws nothing — no
        colour, no depth — and exists only so the reader's ray has a floor to
        land on and report.

        Its own raycast rejects any hit that is not over floor the building
        actually laid, so pointing past the end of the enfilade puts the mark
        nowhere rather than out in the void, and a click out there stays a
        click on the room behind it rather than being swallowed by a plane.
      */}
      <mesh
        ref={catcher}
        rotation={[-Math.PI / 2, 0, 0]}
        position={[anchor.x + bounds.cx, anchor.y + floorY, anchor.z + bounds.cz]}
        onPointerMove={(e) => {
          aim.current = toBuilding(e.point);
        }}
        onPointerOut={() => {
          aim.current = null;
          press.current = null;
        }}
        onPointerDown={(e) => {
          const p = toBuilding(e.point);
          press.current = p ? { at: performance.now(), x: p.x, z: p.z } : null;
        }}
        onClick={(e) => {
          e.stopPropagation();
          const held = press.current;
          const to = landing.current;
          press.current = null;
          if (!to || !held) return;
          if (performance.now() - held.at > TAP_MS) return;
          const end = toBuilding(e.point);
          if (!end) return;
          if (Math.hypot(end.x - held.x, end.z - held.z) > TAP_SLIP) return;
          const pose = poseRef.current;
          // The yaw is left exactly as it was. The reader's head did not turn,
          // and turning the building under it because they moved would be a
          // rotation nobody asked for — see the square-up in `useRoomWalking`.
          pose.x = to.x;
          pose.z = to.z;
          // Arriving at ground level, not at the height they left from: without
          // this a teleport across a landing set the reader down at the old
          // rise over the new floor, and one onto a flight left them walking
          // through the treads.
          pose.rise = to.rise;
          jumpRef.current += 1;
          onArrive(pose);
          // Consume the aim: the building has just moved under the ray, so the
          // point it was resting on means somewhere else now. The next move
          // event re-solves it, and until then the mark is honestly absent.
          aim.current = null;
          landing.current = null;
        }}
      >
        <planeGeometry args={[bounds.width, bounds.depth]} />
        <meshBasicMaterial
          transparent
          opacity={0}
          depthWrite={false}
          colorWrite={false}
        />
      </mesh>
      <group ref={marker} visible={false} rotation={[-Math.PI / 2, 0, 0]}>
        <mesh raycast={() => null}>
          <circleGeometry args={[RETICLE_RADIUS, 32]} />
          <meshBasicMaterial
            ref={disc}
            color={theme.accentCol}
            transparent
            opacity={0.34}
            depthWrite={false}
          />
        </mesh>
        <mesh position={[0, 0, 0.002]} raycast={() => null}>
          <ringGeometry args={[RETICLE_RADIUS * 0.84, RETICLE_RADIUS, 32]} />
          <meshBasicMaterial
            ref={ring}
            color={theme.rimHighlight}
            transparent
            opacity={0.95}
            depthWrite={false}
          />
        </mesh>
      </group>
    </group>
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
 * Aiming the preview camera back down the reading line.
 *
 * The building is carried so the reader's pose lands at the panel slot — that
 * is what "standing in front of a page" means here — but the preview's camera
 * is OrbitControls'. Come at a page having dragged 90° round and it lands
 * edge-on: correctly placed, uselessly viewed. So clicking a spot restores
 * the reading VIEW as well as the pose.
 *
 * It restores the direction only. The eye is pinned to the standing point by
 * `AxisLook` (see `roomsAxis` in XRSceneRenderer) and the orbit radius is
 * clamped to a centimetre, so there is no position left to restore — and
 * setting one here would fight that rig, which is exactly what this function
 * used to do when it parked the camera a whole reading distance off the pivot.
 *
 * In an immersive session there are no controls and the headset is the
 * camera, so this no-ops.
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
    // The standing point: on the panel slot's line, one reading distance back
    // from it, at standing eye height above the floor. The same point
    // `roomsAxis` pins the camera to — this only turns the head back toward
    // the page.
    const eye = {
      x: panelCentre.x,
      y: ROOM_EYE_HEIGHT,
      z: panelCentre.z + viewingDistance,
    };
    camera.position.set(eye.x, eye.y, eye.z);
    t.set(eye.x, eye.y, eye.z - LOOK_PIVOT);
    camera.lookAt(t);
    controls?.update?.();
  }, [panelCentre, viewingDistance, camera, controls, gl]);
}

// ─────────────────────────────────────────────────────────────
// Stairs
// ─────────────────────────────────────────────────────────────

/**
 * The flights at the end of a page's corridor
 * (docs/directional-links.md, Anand's floor plan of 2026-08-16).
 *
 * Siblings are the same level and stay on the reading floor. Parents are UP
 * and externals are DOWN, and in a building that means a stair — so the end of
 * every links corridor has one or two flights, and the landing at the top and
 * bottom of them is a corridor of that direction's doors.
 *
 * This replaced the previous approximation, which was a door at floor level
 * with three treads drawn in front of it. That said "up" without being up: the
 * doors were all on one storey and the reader never changed height, so the
 * legend's strongest claim — that a parent is ABOVE you — was the one thing
 * the geometry did not make.
 *
 * ── Taking one ──
 *
 * Selecting a flight moves the reader to its head. The climb itself is not
 * walked: the walk model puts the reader on a floor PLANE and moving between
 * planes on foot needs a step-height model the view does not have, so a flight
 * is a place you take rather than a slope you climb. It is drawn as real
 * treads because the reader has to be able to see that it goes up.
 */
export function RoomStairs({
  stairs,
  anchor,
}: {
  stairs: RoomStair[];
  anchor: { x: number; y: number; z: number };
}) {
  return (
    <>
      {stairs.map((s, i) => (
        <StairFlight
          key={`stair-${s.page}-${s.dir}-${i}`}
          stair={s}
          anchor={anchor}
        />
      ))}
    </>
  );
}

/**
 * The overhead sign at the foot of a flight.
 *
 * `SIGN_FONT` is the building's own signage size — a link door's name is
 * 0.045 m and is read from a couple of metres, this is read from the length of
 * a corridor, so it is half again as large and no more. At 0.07 m it subtends
 * about a degree at 4 m, comfortably over the angular floor, and it is small
 * enough that the plate never becomes the subject of the view.
 *
 * The HEIGHT is not ours: `stair.signY` comes from the plan, which is the only
 * place that knows how much clear height this document's corridors have (see
 * `RoomStair.signY`). A sign hung at a height chosen in here sat inside the
 * ceiling — the corridors of a short page are 2.35 m from floor to soffit.
 */
const SIGN_FONT = 0.07;
const SIGN_PLATE_H = 0.15;
const SIGN_PAD = 0.06;
/** Far enough in front of the foot to sit clear of the first riser. */
const SIGN_SET_BACK = 0.3;

function StairFlight({
  stair,
  anchor,
}: {
  stair: RoomStair;
  anchor: { x: number; y: number; z: number };
}) {
  const fontType = React.useContext(FontContext);

  const rise = ROOM_STOREY_H / stair.steps;
  const up = stair.dir === 1;
  // The flight's own axis, in the floor plane. `yaw` is the bearing it is
  // CLIMBED in, so the treads march along (sin, cos) and their width lies
  // across it. Working in world components rather than in a rotated group is
  // deliberate: the group version drew every tread edge-on — a plank stuck to
  // the wall — and put the sign on back to front.
  const ax = Math.sin(stair.yaw);
  const az = Math.cos(stair.yaw);

  // The plate is fitted to the WORDS, not to the flight. Sized to the letters
  // it holds (troika's advance for this face is about half the em) plus a
  // margin, it is never wider than what it says — which is what stops a sign
  // over a one-metre stair from being a hoarding.
  const label = up ? "▴  the level above" : "▾  other sites";
  const plateW = Math.min(
    stair.width * 0.9,
    label.length * SIGN_FONT * 0.55 + SIGN_PAD * 2,
  );

  return (
    <group>
      {Array.from({ length: stair.steps }, (_, i) => {
        const d = (i + 0.5) * stair.going;
        // ── One block per tread, from its own nosing down to the well ──
        //
        // The top of tread `i` is where `walkSurfaceAt` puts the reader at the
        // middle of it, so a climbing reader's feet are on the tread they are
        // standing on rather than a riser under it.
        //
        // Below that it is solid to the bottom of the flight: a riser under
        // the floor for a climb, the foot of the well for a descent. The
        // descending case used to run the other way — every block topped out
        // at the floor line, which buried all thirteen risers and left one
        // smooth brown wedge dropping into the corridor (Anand, 2026-08-18,
        // of the flight down: "bottom stairs"). A stair that reads as a ramp
        // is not saying "down" any more than the flat door it replaced.
        const top = (up ? i + 0.5 : -(i + 0.5)) * rise;
        const base = up ? -rise : -(stair.steps + 0.5) * rise;
        const h = top - base;
        const yMid = (top + base) / 2;
        return (
          <mesh
            key={`t-${i}`}
            position={[
              anchor.x + stair.foot.x + ax * d,
              anchor.y + stair.foot.y + yMid,
              anchor.z + stair.foot.z + az * d,
            ]}
            rotation={[0, stair.yaw, 0]}
          >
            <boxGeometry args={[stair.width, h, stair.going]} />
            <meshStandardMaterial
              color={GALLERY_DOOR.frame}
              roughness={0.8}
              metalness={0}
            />
          </mesh>
        );
      })}

      {/* ── Where it goes, on an overhead sign ──

          Hung ABOVE the flight at its foot, facing back down the corridor, at
          the scale the rest of the building's signage is drawn at — a door
          leaf carries its name at 0.045 m and a room its own at not much more.

          It used to be a 1.6 × 0.3 m plate with 0.1 m letters standing at eye
          height across the mouth of the flight: from anywhere in the corridor
          it was the largest object in the view and it hid the treads behind
          it, so the one thing the geometry exists to say — that this goes UP —
          was the thing the label covered up (Anand, 2026-08-18: "no need of
          showing such huge label"). A sign belongs over the opening, out of
          the line you walk and the line you look along. */}
      <group
        position={[
          anchor.x + stair.foot.x - ax * SIGN_SET_BACK,
          anchor.y + stair.signY,
          anchor.z + stair.foot.z - az * SIGN_SET_BACK,
        ]}
        rotation={[0, stair.yaw + Math.PI, 0]}
        raycast={() => null}
      >
        <mesh>
          <planeGeometry args={[plateW, SIGN_PLATE_H]} />
          <meshBasicMaterial color={GALLERY_SIGN.plate} toneMapped={false} />
        </mesh>
        {/* The dark rule around it, as on every other plate in the building:
            at the far end of a corridor the letters are a few pixels tall and
            the shape of the plate is the whole of what says "sign". */}
        <mesh position={[0, 0, -0.002]}>
          <planeGeometry args={[plateW + 0.026, SIGN_PLATE_H + 0.026]} />
          <meshBasicMaterial color={GALLERY_SIGN.edge} toneMapped={false} />
        </mesh>
        <Text
          font={fontType}
          anchorX="center"
          anchorY="middle"
          position={[0, 0, 0.004]}
          fontSize={SIGN_FONT}
          color={GALLERY_SIGN.text}
          maxWidth={plateW * 0.94}
          textAlign="center"
        >
          {label}
          {/* Front face only. The plate behind it is one-sided already, so a
              reader on the landing above looked down through the well at
              nothing but this sign's text, back to front and floating. A sign
              is only a sign from the side it faces. */}
          <meshBasicMaterial
            attach="material"
            color={GALLERY_SIGN.text}
            side={THREE.FrontSide}
            toneMapped={false}
          />
        </Text>
      </group>
    </group>
  );
}
