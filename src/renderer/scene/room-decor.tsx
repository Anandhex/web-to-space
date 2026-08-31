/**
 * scene/room-decor.tsx
 *
 * The fabric of the `rooms` building: what the walls, floor and ceiling are
 * MADE of, and the light that falls on them. The locomotion half — walking,
 * doors, reading spots — lives next door in `room-walk.tsx`; this file never
 * decides where anything is, only how it reads.
 *
 * The rule that shapes everything here: a room lit by one flat global lamp
 * reads as a diagram of a room. What makes an interior is local light and
 * surfaces that vary — a pool on the floor under each luminaire, a page
 * brighter than the wall it hangs on, a skirting board that tells you where
 * the wall meets the floor, a corridor that dims between one doorway and the
 * next. So the building carries its own fittings (`computeRoomFixtures`) and
 * the reader drags a small, FIXED set of real lights around with them.
 *
 * Fixed is the operative word. Mounting a light per fitting would rebuild
 * every material in the scene each time the reader crossed a threshold —
 * three compiles the light count into the shader — so `RoomLights` always
 * renders the same number of lights and simply moves them to the nearest
 * fittings, parking the spares at zero intensity. The GLOW of every fitting
 * is unlit geometry, which is why the corridor still reads as lit all the
 * way down while only the near end of it is actually lighting anything.
 *
 * Everything in here is raycast-inert: scenery must never eat a click meant
 * for the page in front of it.
 */
import React from "react";
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

import {
  ROOM_SOFFIT_BAND,
  ROOM_SOFFIT_DROP,
  type RoomFixture,
  type RoomSlab,
  type RoomWall,
} from "../page-placements";

/** Panel-anchor origin in world space — everything here is relative to it. */
type Anchor = { x: number; y: number; z: number };

// ── Palette ──────────────────────────────────────────────────
//
// A GALLERY, not a basement. The building deliberately does NOT take the UI
// theme's greys: those are the colours of panels floating in the dark, and a
// building made of them is a corridor at night — which is exactly how this
// read when it was tried. Real galleries are the other way round. They are
// warm off-white boxes, lit brightly and evenly, and the DARK thing in the
// room is the work on the wall. That is also what serves the pages best:
// they hang as dark panels against a light wall, which is the strongest
// contrast the space can give them, in either UI theme.
//
// Fixed colours, therefore, not theme-derived — the accents (signs, spots,
// doors) still come from the theme, so the palette follows the product; the
// architecture does not.

// THE FLOOR IS WHAT WAS WRONG (2026-08-09). The walls were already a gallery
// off-white, but the floor was #CDC6BA — the same khaki, half a shade darker.
// Wall and floor in one beige family, under warm lamps, is the colour of an
// institution after hours, and it is what made a correct gallery read as a
// horror set. So: the wall goes cleaner and brighter (and much less dark
// where it meets the floor — gloom pooling at floor level is a horror cue in
// its own right), and the floor becomes PALE OAK. A wood floor is the single
// cheapest way to say "somewhere people were meant to be": it is warm, it is
// obviously a made surface, and its planks give the reader's own walking
// something to move against down the length of a corridor.

const GALLERY = {
  /** Wall, at the top and where it meets the floor — a gentle wash, not a
      gradient you can name. */
  wallTop: "#F8F6F2",
  wallBottom: "#EAE5DC",
  skirting: "#D6CFC1",
  rail: "#C3B9A6",
  /** Pale oak, and the joint between two boards. */
  floor: "#CBB396",
  floorLine: "#A98F6E",
  floorGrain: "#BCA383",
  /** Gallery ceilings are white; the fittings sit in them, not against them. */
  ceiling: "#F1EFEA",
  soffit: "#FBFAF7",
} as const;

/** Warm bulbs in the rooms, near-neutral daylight in the corridors. */
const LAMP_WARM = "#FFE9CC";
const LAMP_COOL = "#F2F5FC";
/**
 * The gallery lights over the pages are the one fitting whose light lands on
 * something being READ, so they are near-white — a warm bulb here tints the
 * page it is there to make legible.
 */
const LAMP_PICTURE = "#FFF6E9";

/**
 * The section sign over each doorway, in the same architectural palette:
 * a pale plate with the name cut dark into it, the way a gallery labels a
 * room. Unlit, so it reads the same from the dark end of a corridor as from
 * under a luminaire. (Used by the plaque renderer in page-ghosts.tsx.)
 */
export const GALLERY_SIGN = {
  // A shade warmer and darker than the plaster it hangs on. It used to be
  // #F7F5F1 against a #F3F0EA wall, which was already close; once the wall
  // was brightened to #F8F6F2 the plate was the same colour as the wall and
  // the name appeared to be written directly on the lintel.
  plate: "#EFEAE0",
  text: "#23211D",
  // A real dark rule, not a tint. This is what makes a sign read AS a sign
  // from the far end of a corridor, where the name itself is a few pixels
  // tall and the only thing carrying it is the shape of the plate.
  edge: "#6E6455",
} as const;

/**
 * A LINK DOOR, in the same architectural palette (used by `LinkDoors` in
 * room-walk.tsx).
 *
 * These used to be filled with `theme.panelBg` — which in the dark theme is
 * #323232. A row of near-black rectangles set into a pale wall, down a dim
 * corridor, is not a set of doors: it is a set of holes, and it was the
 * loudest single thing making the building read as a horror set. A door is
 * timber, it is lighter than the shadow behind it, and it has a handle. All
 * three matter, and none of them can come from the UI theme, for the same
 * reason the walls don't (see the palette above).
 */
export const GALLERY_DOOR = {
  /** The leaf: warm oak, a shade deeper than the floor it stands on. */
  leaf: "#A98055",
  /** Stiles and rails, and the recessed panels between them. */
  frame: "#966F47",
  panel: "#B98C5E",
  /** Lever and rose. */
  brass: "#C9A45C",
  /** Lifted on hover, so pointing at a door says so before you walk into it. */
  leafHot: "#C39A6C",
} as const;

interface RoomPalette {
  wallTop: THREE.Color;
  wallBottom: THREE.Color;
  skirting: THREE.Color;
  rail: THREE.Color;
  floor: THREE.Color;
  floorLine: THREE.Color;
  floorGrain: THREE.Color;
  ceiling: THREE.Color;
  soffit: THREE.Color;
}

function roomPalette(): RoomPalette {
  return {
    wallTop: new THREE.Color(GALLERY.wallTop),
    wallBottom: new THREE.Color(GALLERY.wallBottom),
    skirting: new THREE.Color(GALLERY.skirting),
    rail: new THREE.Color(GALLERY.rail),
    floor: new THREE.Color(GALLERY.floor),
    floorLine: new THREE.Color(GALLERY.floorLine),
    floorGrain: new THREE.Color(GALLERY.floorGrain),
    ceiling: new THREE.Color(GALLERY.ceiling),
    soffit: new THREE.Color(GALLERY.soffit),
  };
}

// ── Surfaces ─────────────────────────────────────────────────

/** A vertical gradient down a wall, bottom → top of the UV square. */
function wallGradientTexture(p: RoomPalette): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = 4;
  c.height = 256;
  const g = c.getContext("2d")!;
  const grad = g.createLinearGradient(0, c.height, 0, 0);
  grad.addColorStop(0, p.wallBottom.getStyle());
  // Most of the wall is at (or near) the top colour: the wash is there to
  // stop a flat plane reading as a flat plane, not to darken the room. Pulled
  // low, it puts a band of shadow round the reader's feet the whole way down
  // the building, which is precisely how a corridor is lit to frighten people.
  grad.addColorStop(0.3, p.wallBottom.clone().lerp(p.wallTop, 0.85).getStyle());
  grad.addColorStop(0.62, p.wallTop.getStyle());
  grad.addColorStop(1, p.wallTop.getStyle());
  g.fillStyle = grad;
  g.fillRect(0, 0, c.width, c.height);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Boards per metre of floor — a 25 cm board, which is a wide plank. */
const FLOOR_BOARDS = 4;

/**
 * The floor: pale oak boards running the length of the building, with a joint
 * between each pair and a little grain along them, so walking has something
 * to move against. Without it the floor is a single flat colour and the
 * reader's own motion is invisible.
 *
 * The tile is one square metre (the caller sets `repeat` from the slab's size
 * in metres), and the boards run along v — which, on a floor plane laid down
 * by a quarter turn about x, is along z: down the corridor, away from the
 * reader. That is the direction that does the most work, since it is the one
 * they walk in.
 *
 * Everything here is deterministic — a hash of the board index, not an RNG.
 * A floor that came out different on each build is a floor nobody can tune.
 */
function floorTexture(p: RoomPalette): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = 256;
  c.height = 256;
  const g = c.getContext("2d")!;
  const boardW = c.width / FLOOR_BOARDS;
  /** 0…1 from an integer, well spread — the same seed always the same board. */
  const hash = (n: number) => {
    const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
    return x - Math.floor(x);
  };

  for (let b = 0; b < FLOOR_BOARDS; b++) {
    // Each board is its own shade, so the floor reads as laid boards rather
    // than as one surface with lines ruled on it.
    const shade = p.floor
      .clone()
      .lerp(p.floorGrain, hash(b) * 0.7)
      .getStyle();
    g.fillStyle = shade;
    g.fillRect(b * boardW, 0, boardW, c.height);
    // Grain: long, very low-contrast streaks down the board. Faint on
    // purpose — at 0.3 alpha these read as SCRATCHES on a lit floor rather
    // than as figure in the timber, and a scuffed floor is a neglected
    // building, which is the read this whole palette exists to avoid.
    g.strokeStyle = p.floorGrain.getStyle();
    g.globalAlpha = 0.13;
    g.lineWidth = 1;
    for (let s = 0; s < 5; s++) {
      const x = (b + 0.12 + hash(b * 7 + s) * 0.76) * boardW;
      g.beginPath();
      g.moveTo(x, 0);
      // A gentle waver, so the streak is grain and not a pinstripe.
      for (let y = 0; y <= c.height; y += 32)
        g.lineTo(x + Math.sin((y / c.height) * 6 + s) * 1.6, y);
      g.stroke();
    }
    g.globalAlpha = 1;
    // The joint at the board's left edge — the one line that should be
    // legible, since it is what says "boards".
    g.strokeStyle = p.floorLine.getStyle();
    g.globalAlpha = 0.5;
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(b * boardW + 0.5, 0);
    g.lineTo(b * boardW + 0.5, c.height);
    g.stroke();
    g.globalAlpha = 1;
  }
  // No butt joints. Staggering a cross-cut per board looked, at floor scale,
  // like a scatter of short dark dashes across the room — closer to debris
  // than to joinery. Boards that run unbroken down the building also do more
  // for the walk, which is what the floor is mostly there for.

  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  return t;
}

/** A soft round falloff — the pool of light a luminaire throws on the floor. */
function poolTexture(): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = 128;
  c.height = 128;
  const g = c.getContext("2d")!;
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, "rgba(255,255,255,0.85)");
  grad.addColorStop(0.45, "rgba(255,255,255,0.28)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

interface RoomMaterials {
  floorMap: THREE.Texture;
  pool: THREE.Texture;
  floor: THREE.Material;
  wall: THREE.Material;
  trim: THREE.Material;
  rail: THREE.Material;
  ceiling: THREE.Material;
  soffit: THREE.Material;
  headMat: THREE.Material;
  /** The lining round a doorway — jambs and head, seen from both sides. */
  jamb: THREE.Material;
}

/**
 * One set of materials and textures for the whole building, shared by every
 * wall, floor and ceiling AND by the three components that draw them —
 * hundreds of surfaces, one shader each.
 *
 * Built once and kept, rather than owned by one component, because a light
 * fitting and the wall behind it want the same trim material and neither is
 * the other's parent. The gallery palette is fixed, so there is exactly one
 * set to build.
 */
let MATERIALS: RoomMaterials | null = null;

function roomMaterials(): RoomMaterials {
  if (MATERIALS) return MATERIALS;

  const p = roomPalette();
  const floorMap = floorTexture(p);
  const built: RoomMaterials = {
    floorMap,
    pool: poolTexture(),
    // Sealed boards: a shade glossier than plaster, so the luminaires above
    // leave a soft sheen down the floor and the reader can see the light has a
    // source. Not metallic — the old 0.06 metalness on a warm floor greyed it
    // out. One material for every floor in the building: the per-slab tiling
    // that used to need a cloned texture each is baked into the UVs instead
    // (see `slabGeometry`).
    floor: new THREE.MeshStandardMaterial({
      map: floorMap,
      roughness: 0.6,
      metalness: 0,
    }),
    wall: new THREE.MeshStandardMaterial({
      map: wallGradientTexture(p),
      side: THREE.DoubleSide,
      roughness: 0.94,
      metalness: 0,
    }),
    trim: new THREE.MeshStandardMaterial({
      color: p.skirting,
      roughness: 0.7,
      metalness: 0.05,
    }),
    rail: new THREE.MeshStandardMaterial({
      color: p.rail,
      roughness: 0.55,
      metalness: 0.1,
    }),
    ceiling: new THREE.MeshStandardMaterial({
      color: p.ceiling,
      side: THREE.DoubleSide,
      roughness: 1,
      metalness: 0,
    }),
    soffit: new THREE.MeshStandardMaterial({
      color: p.soffit,
      roughness: 0.9,
      metalness: 0,
    }),
    // The head over a doorway: same plaster as the soffit, but double-sided,
    // because a lintel is seen from the space on either side of it.
    headMat: new THREE.MeshStandardMaterial({
      color: p.soffit,
      side: THREE.DoubleSide,
      roughness: 0.9,
      metalness: 0,
    }),
    jamb: new THREE.MeshStandardMaterial({
      color: p.skirting,
      side: THREE.DoubleSide,
      roughness: 0.6,
      metalness: 0.04,
    }),
  };
  MATERIALS = built;
  return built;
}

function useRoomMaterials(): RoomMaterials {
  return React.useMemo(() => roomMaterials(), []);
}

// ── One building, a handful of draw calls ────────────────────
//
// WHY THIS FILE BUILDS GEOMETRY INSTEAD OF WRITING <mesh> PER SURFACE.
//
// The building is big. Every section is a room, every room has four walls with
// doorways cut in them, a floor, a ceiling with a dropped soffit round it, a
// skirting board, a picture rail, and a file of luminaires; the corridor runs
// the whole length of the document between them. Written out one <mesh> per
// surface — which is how this started — a forty-page document is about 640
// meshes and a long one is over 1600, and a mesh is a draw call. An immersive
// session draws the scene once per eye, so those numbers double before the
// headset has drawn a single page.
//
// That was the lag. Not the shaders, not the textures, not the number of
// polygons — which is trivial, a few thousand triangles for the whole
// building — but the per-object cost of having thousands of objects: a matrix
// update, a frustum test and a draw call each, every frame, twice.
//
// Nothing about the building moves. The walls are a pure function of the plan,
// and the plan does not change while the reader walks around inside it. So each
// group of surfaces that shares a material is welded into ONE geometry, once,
// and drawn as one object. Roughly ten draw calls now stand for six hundred, the
// building looks pixel-for-pixel the same, and what is left on the frame budget
// pays for the pages.
//
// The rule for anything added here: if it does not move relative to the
// building, it belongs in a bucket. If it moves — the reader's lights, the
// teleport reticle, a door's hover state — it stays its own object.

/** A surface waiting to be welded: its geometry, and where it sits. */
interface Part {
  geom: THREE.BufferGeometry;
  matrix: THREE.Matrix4;
}

/** Scratch for building part matrices — one, not one per surface. */
const partQuat = new THREE.Quaternion();
const partEuler = new THREE.Euler();
const partPos = new THREE.Vector3();
const partScale = new THREE.Vector3(1, 1, 1);

/** Compose a part's placement the way a <group position rotation> would. */
function at(
  x: number,
  y: number,
  z: number,
  rx = 0,
  ry = 0,
  rz = 0,
): THREE.Matrix4 {
  return new THREE.Matrix4().compose(
    partPos.set(x, y, z),
    partQuat.setFromEuler(partEuler.set(rx, ry, rz)),
    partScale,
  );
}

/**
 * Weld a bucket into one geometry, or null if it is empty.
 *
 * The sources are disposed on the way out: they exist only to be copied into
 * the merged buffer, and a few hundred orphaned BufferGeometries per rebuild is
 * a leak the GPU notices.
 */
function weld(parts: Part[]): THREE.BufferGeometry | null {
  if (parts.length === 0) return null;
  const placed = parts.map((p) => p.geom.applyMatrix4(p.matrix));
  const merged = mergeGeometries(placed);
  for (const g of placed) g.dispose();
  return merged;
}

/**
 * One welded bucket, drawn. Scenery: it never eats a pointer, and it is
 * disposed with the building it belongs to.
 */
function Welded({
  geometry,
  material,
}: {
  geometry: THREE.BufferGeometry | null;
  material: THREE.Material;
}) {
  React.useEffect(() => () => geometry?.dispose(), [geometry]);
  if (!geometry) return null;
  return <mesh geometry={geometry} material={material} raycast={() => null} />;
}

// ── The shell ────────────────────────────────────────────────

/** A wall piece tall enough to be a wall, rather than a lintel or a leaf. */
function isFullHeight(w: RoomWall): boolean {
  return !w.lintel && !w.portal && w.size.height > 1.2;
}

/** Skirting board height, and how far it stands proud of the wall. */
const SKIRT_H = 0.11;
const TRIM_PROUD = 0.022;
/** The rail above the pages — the line a gallery hangs from. */
const RAIL_H = 0.035;
/**
 * The lining round a doorway: how wide the jamb and head bands are, and how
 * far they stand proud of the wall. An opening with no lining is a HOLE, and
 * a corridor of dark rectangular holes is the whole vocabulary of a haunted
 * house; the same opening with a frame round it is a door, which is what it
 * was always meant to be. Cheap, too — three boxes an opening.
 */
const JAMB_W = 0.085;
const JAMB_PROUD = 0.028;

/**
 * The building's walls: the flat surfaces the pages hang on and the corridor
 * runs between, with the DOORWAYS left as gaps in them (see `wallRun` — each
 * opening becomes two flanking pieces and a lintel).
 *
 * Double-sided on purpose: a room has to be a solid box with two doors, or
 * the rooms beyond it show through and the enclosure is gone.
 *
 * Every full-height piece gets a skirting board at the floor, and the walls
 * pages hang on get a rail at the height they hang from — one thin box each,
 * and between them most of what separates "two planes meeting" from "a room
 * somebody built": they give the eye a line to follow around the space, and
 * they catch the light from the fittings at an angle the flat wall never
 * does.
 */
export function RoomShell({
  walls,
  anchor,
  floorY,
  railY,
}: {
  walls: RoomWall[];
  /** The main panel's top-left anchor in world space — walls are relative to it. */
  anchor: Anchor;
  /** The floor, panel-anchor-relative: where the skirting stands. */
  floorY: number;
  /**
   * The picture rail, panel-anchor-relative (`roomRailY`). Passed in rather
   * than assumed: it has to sit just above the top edge of the pages, and the
   * pages no longer hang at the panel-anchor line — they hang to a gallery
   * centre line, so the rail moved with them.
   */
  railY: number;
}) {
  const mats = useRoomMaterials();
  const geom = React.useMemo(
    () => buildShellGeometry(walls, floorY, railY),
    [walls, floorY, railY],
  );

  return (
    <group position={[anchor.x, anchor.y, anchor.z]} raycast={() => null}>
      <Welded geometry={geom.wall} material={mats.wall} />
      <Welded geometry={geom.head} material={mats.headMat} />
      <Welded geometry={geom.jamb} material={mats.jamb} />
      <Welded geometry={geom.trim} material={mats.trim} />
      <Welded geometry={geom.rail} material={mats.rail} />
    </group>
  );
}

/**
 * The shell's geometry, welded by material — the pure half of `RoomShell`, so
 * the weld can be checked against the per-mesh building it replaced without a
 * renderer. Built in ANCHOR-RELATIVE metres: moving the building is then moving
 * one transform rather than rebuilding a thousand.
 */
function buildShellGeometry(
  walls: RoomWall[],
  floorY: number,
  railY: number,
) {
  {
    const wall: Part[] = [];
    const head: Part[] = [];
    const jamb: Part[] = [];
    const trim: Part[] = [];
    const rail: Part[] = [];

    for (const w of walls) {
      const { width, height } = w.size;
      const place = at(w.centre.x, w.centre.y, w.centre.z, 0, w.yaw, 0);
      /** A part in the wall piece's own frame, lifted into the building's. */
      const local = (
        bucket: Part[],
        geometry: THREE.BufferGeometry,
        x: number,
        y: number,
        z: number,
      ) =>
        bucket.push({
          geom: geometry,
          matrix: place.clone().multiply(at(x, y, z)),
        });

      if (w.lintel) {
        /* The head over a doorway, a shade lighter than the wall it sits in —
           the way a plastered reveal catches more light than the wall around
           it. It used to carry a bright accent strip, which read as a neon exit
           sign rather than as a gallery: the opening is legible because the
           space beyond it is lit, and because the section's name hangs above
           it. */
        local(head, new THREE.PlaneGeometry(width, height), 0, 0, 0);
        /* The lining round the opening below it. The lintel is the one piece
           that knows where a doorway IS — it is the piece that spans one — so
           the frame is drawn from it: a head band along its foot and a jamb
           down each side, reaching from there to the floor. Straddling boxes,
           like the skirting, so one set serves the space on either side of the
           wall. */
        local(
          jamb,
          new THREE.BoxGeometry(width + 2 * JAMB_W, JAMB_W, JAMB_PROUD * 2),
          0,
          -height / 2 + JAMB_W / 2,
          0,
        );
        // The opening below this lintel: from the floor up to the lintel's own
        // foot, which IS the door head.
        const openH = Math.max(0.01, w.centre.y - height / 2 - floorY);
        // The jamb runs the height of the opening plus the head band it dies
        // into at the top.
        const jambH = openH + JAMB_W;
        const jambY = floorY + jambH / 2 - w.centre.y;
        for (const side of [-1, 1])
          local(
            jamb,
            new THREE.BoxGeometry(JAMB_W, jambH, JAMB_PROUD * 2),
            (side * (width + JAMB_W)) / 2,
            jambY,
            0,
          );
      } else {
        /* A link door's opening is filled by its own leaf (see LinkDoors),
           which sits exactly on this piece — so the piece drops a centimetre
           behind it rather than z-fighting with it, and still closes the wall
           from the far side. */
        local(
          wall,
          new THREE.PlaneGeometry(width, height),
          0,
          0,
          w.portal ? -0.01 : 0,
        );
      }

      if (isFullHeight(w)) {
        /* Skirting: a box, not a plane, so it has a top face for the ceiling
           light to catch. One box straddling the wall serves both of its
           sides — a wall piece is shared between two spaces, and two
           half-boxes would be two draw calls for the same board. */
        local(
          trim,
          new THREE.BoxGeometry(width, SKIRT_H, TRIM_PROUD * 2),
          0,
          floorY - w.centre.y + SKIRT_H / 2,
          0,
        );
        /* The picture rail, level with the top edge of the pages — and only on
           the walls pages actually hang on. Run down the corridor as well it
           became a long horizontal edge at eye height, and every horizontal
           edge converges on eye height in the distance: it drew itself straight
           through the section sign over each far doorway. */
        if (w.hangs)
          local(
            rail,
            new THREE.BoxGeometry(width, RAIL_H, TRIM_PROUD * 2),
            0,
            railY - w.centre.y,
            0,
          );
      }
    }

    return {
      wall: weld(wall),
      head: weld(head),
      jamb: weld(jamb),
      trim: weld(trim),
      rail: weld(rail),
    };
  }
}

/**
 * How far the perimeter soffit drops below the ceiling, and how wide it is.
 * Owned by page-placements: the band hangs in front of the wall, so anything
 * mounted high on that wall has to know how much clear height it leaves (see
 * `computeFieldLabels`, whose signs it was quietly slicing the tops off).
 */
const SOFFIT_DROP = ROOM_SOFFIT_DROP;
const SOFFIT_BAND = ROOM_SOFFIT_BAND;

/**
 * The floor and the ceiling. A room is not a room without them — four walls
 * in a void give a reader nothing to stand on and no way to tell up from
 * down.
 *
 * The ceiling is not one flat lid: a band of dropped soffit runs round the
 * perimeter of every space, leaving the middle recessed. It is the cheapest
 * honest ceiling there is (four thin boxes) and it does two jobs — it gives
 * the ceiling an edge, so the eye can see how high the room is, and it gives
 * the luminaires in the recess something to wash against.
 */
export function RoomSlabs({
  slabs,
  anchor,
}: {
  slabs: RoomSlab[];
  anchor: Anchor;
}) {
  const mats = useRoomMaterials();
  const geom = React.useMemo(() => buildSlabGeometry(slabs), [slabs]);

  return (
    <group position={[anchor.x, anchor.y, anchor.z]} raycast={() => null}>
      <Welded geometry={geom.floor} material={mats.floor} />
      <Welded geometry={geom.ceiling} material={mats.ceiling} />
      <Welded geometry={geom.soffit} material={mats.soffit} />
    </group>
  );
}

/** The floors, ceilings and soffit bands, welded by material. Pure — see
 *  `buildShellGeometry`. */
function buildSlabGeometry(slabs: RoomSlab[]) {
  {
    const floor: Part[] = [];
    const ceiling: Part[] = [];
    const soffit: Part[] = [];

    // ── Which edges are really EDGES ──────────────────────────
    //
    // The soffit is a band round the perimeter of a SPACE. The ceiling,
    // though, is not one lid per space — it is one lid per piece the plan
    // happens to emit: a room, each stretch of corridor between two rooms,
    // each arm, and (once a flight cuts a shaft through it) three or four
    // pieces of one stair hall. Banding every piece put a dropped band round
    // every internal join, so walking the spine you passed under a pair of
    // them — one from the room's lid, one from the stretch's, 0.52 m of
    // dropped plaster together — at every single room boundary, and the
    // ceiling read as a run of coffers nobody designed. Over the stairs it was
    // worse: the strips left beside the well are 0.20 m and 1.25 m deep, and a
    // 0.26 m band down each of their four sides swallowed the strip whole and
    // hung a solid block over the flight (Anand, 2026-08-23: "the ceiling
    // looks really weird").
    //
    // So an edge earns a band only where the ceiling actually STOPS. Sampled
    // rather than solved: the lids are axis-aligned rectangles but they
    // overlap deliberately at thresholds, and three points a hand's breadth
    // past an edge answer "does it carry on?" without a rectangle algebra
    // nobody needs.
    const lids = slabs
      .filter((s) => s.facing !== "up")
      .map((s) => ({
        src: s,
        y: s.centre.y,
        x0: s.centre.x - s.size.width / 2,
        x1: s.centre.x + s.size.width / 2,
        z0: s.centre.z - Math.abs(s.size.depth) / 2,
        z1: s.centre.z + Math.abs(s.size.depth) / 2,
      }));
    /** Is there OTHER ceiling at this height over (x, z)? */
    const ceilingOver = (self: RoomSlab, y: number, x: number, z: number) =>
      lids.some(
        (l) =>
          l.src !== self &&
          Math.abs(l.y - y) < 0.01 &&
          x >= l.x0 - 0.01 &&
          x <= l.x1 + 0.01 &&
          z >= l.z0 - 0.01 &&
          z <= l.z1 + 0.01,
      );
    /** How far past an edge to ask. Well inside a neighbouring lid, well
     *  short of anything on the other side of a real one. */
    const PAST_EDGE = 0.06;

    for (const s of slabs) {
      const { width } = s.size;
      const depth = Math.abs(s.size.depth);
      if (s.facing === "up") {
        const g = new THREE.PlaneGeometry(width, depth);
        // ONE floor material for the whole building, so the tiling has to live
        // in the vertices. Each floor used to clone the shared texture and set
        // its own `repeat`, which is a texture and a draw call per space; the
        // same tiling baked into the UVs is identical on screen (the map wraps)
        // and costs neither.
        //
        // The tiling is measured from the BUILDING's own origin, not from each
        // slab's corner: one repeat per metre of x and z wherever a floor
        // happens to be. Per-slab repeats (`round(width)` by `round(depth)`)
        // were a whole number of boards across every whole slab — but the
        // moment a slab is cut around a stairwell, the pieces left are 0.2 m
        // and 1.2 m deep and each got a whole repeat of its own, so the floor
        // beside a flight was a pale, differently scaled patch of nothing that
        // read as a hole in it. Anand, 2026-08-18: "there is a gap".
        const uv = g.attributes.uv as THREE.BufferAttribute;
        for (let i = 0; i < uv.count; i++)
          uv.setXY(
            i,
            s.centre.x + (uv.getX(i) - 0.5) * width,
            // The quarter turn below lays +y down −z, so the plane's own v
            // runs against world z.
            s.centre.z - (uv.getY(i) - 0.5) * depth,
          );
        // A plane faces +z; a quarter turn back lays it flat facing up.
        floor.push({
          geom: g,
          matrix: at(s.centre.x, s.centre.y, s.centre.z, -Math.PI / 2, 0, 0),
        });
        continue;
      }

      const place = at(s.centre.x, s.centre.y, s.centre.z);
      ceiling.push({
        geom: new THREE.PlaneGeometry(width, depth),
        matrix: place.clone().multiply(at(0, 0, 0, Math.PI / 2, 0, 0)),
      });
      // The dropped band, over the stretches of each edge where the ceiling
      // really stops.
      const halfW = width / 2;
      const halfD = depth / 2;
      const y = -SOFFIT_DROP / 2 - 0.001;
      // Never deeper than the piece it edges: the slivers left beside a
      // stairwell are thinner than the band itself.
      const bandX = Math.min(SOFFIT_BAND, width);
      const bandZ = Math.min(SOFFIT_BAND, depth);
      const alongX = (t: number) => s.centre.x - halfW + width * t;
      const alongZ = (t: number) => s.centre.z - halfD + depth * t;

      /**
       * The runs of an edge, in [0, 1], with no other ceiling past them.
       *
       * PART of an edge is the case that matters, and treating the edge as one
       * yes/no is what leaves the ceiling striped. A room's lid is wider than
       * the corridor it opens onto, so its end edge stops over the two outer
       * stretches and carries straight on through the middle: banded whole, a
       * bulkhead crosses the opening the reader walks through; not banded at
       * all, the room loses the edge that tells them how high it is. Both
       * pieces are drawn, and nothing is drawn across the gap between them.
       */
      const openRuns = (
        len: number,
        px: (t: number) => number,
        pz: (t: number) => number,
      ): Array<[number, number]> => {
        const n = Math.max(2, Math.ceil(len / 0.08));
        const runs: Array<[number, number]> = [];
        let start: number | null = null;
        for (let i = 0; i < n; i++) {
          const open = !ceilingOver(
            s,
            s.centre.y,
            px((i + 0.5) / n),
            pz((i + 0.5) / n),
          );
          if (open && start === null) start = i / n;
          else if (!open && start !== null) {
            runs.push([start, i / n]);
            start = null;
          }
        }
        if (start !== null) runs.push([start, 1]);
        // A crumb of band is a speck of floating plaster, not an edge.
        return runs.filter(([a, b]) => (b - a) * len > SOFFIT_BAND * 0.5);
      };

      /** The four edges: which way they run, and where their band sits. */
      const edges: Array<{
        len: number;
        px: (t: number) => number;
        pz: (t: number) => number;
        /** Band centre and size, given a run's centre and length. */
        band: (mid: number, run: number) => [number, number, number, number];
      }> = [
        {
          len: width,
          px: alongX,
          pz: () => s.centre.z - halfD - PAST_EDGE,
          band: (mid, run) => [mid, -halfD + bandZ / 2, run, bandZ],
        },
        {
          len: width,
          px: alongX,
          pz: () => s.centre.z + halfD + PAST_EDGE,
          band: (mid, run) => [mid, halfD - bandZ / 2, run, bandZ],
        },
        {
          len: depth,
          px: () => s.centre.x - halfW - PAST_EDGE,
          pz: alongZ,
          band: (mid, run) => [-halfW + bandX / 2, mid, bandX, run],
        },
        {
          len: depth,
          px: () => s.centre.x + halfW + PAST_EDGE,
          pz: alongZ,
          band: (mid, run) => [halfW - bandX / 2, mid, bandX, run],
        },
      ];
      // On a piece thinner than two bands the clamp above makes the band the
      // whole piece, so its two facing edges ask for the same box twice — two
      // coplanar drops fighting over the 0.20 m sliver beside a stairwell.
      // One drop is what a sliver that narrow is.
      const drawn = new Set<string>();
      for (const e of edges)
        for (const [t0, t1] of openRuns(e.len, e.px, e.pz)) {
          const half = e.len / 2;
          const [bx, bz, sx, sz] = e.band(
            -half + e.len * ((t0 + t1) / 2),
            e.len * (t1 - t0),
          );
          const key = [bx, bz, sx, sz].map((v) => v.toFixed(3)).join(",");
          if (drawn.has(key)) continue;
          drawn.add(key);
          soffit.push({
            geom: new THREE.BoxGeometry(sx, SOFFIT_DROP, sz),
            matrix: place.clone().multiply(at(bx, y, bz)),
          });
        }
    }

    return {
      floor: weld(floor),
      ceiling: weld(ceiling),
      soffit: weld(soffit),
    };
  }
}

// ── The light ────────────────────────────────────────────────

/**
 * How many real lights the reader drags around with them. Fixed, and small:
 * three compiles the light count into every material's shader, so a count
 * that changed as somebody walked would stall on every threshold.
 */
const CEILING_LIGHT_SLOTS = 6;
/** One per page on the wall a reader can see at once, near enough. */
const PICTURE_LIGHT_SLOTS = 4;
/**
 * Past this the fitting still glows, but it stops lighting anything. Three
 * windows a point light's falloff to zero at `distance`, so this is also how
 * abruptly the light ends — set tight it draws a visible edge on the floor
 * where the lit part of the corridor stops, and a lit patch you are standing
 * in the middle of with darkness beyond it is the shot every horror film
 * opens on. Generous, therefore, and the slots above are what pay for it.
 */
const CEILING_LIGHT_RANGE = 13;
const PICTURE_LIGHT_RANGE = 5;

/**
 * Brightness in candela — these fall off with the square of the distance, so
 * a ceiling luminaire 2.6 m up lands at roughly the strength of the global
 * fill, and a gallery light a metre off its page at several times it. That
 * ratio is the point: the room is evenly lit, and the PAGE is the brightest
 * thing in it. Pushed too far the other way the fittings stop being accents
 * and the space between them goes black.
 *
 * The ceiling figure tracks the ceiling height (see ROOM_WALL_HEADROOM):
 * inverse-square means the lid's height sets what reaches the floor, so this
 * has to be retuned whenever that is. At ~2.35 m this lands a little above
 * where the old 6 put a ~2.0 m ceiling, which is the intent — the room should
 * be brighter than it was, not merely as bright.
 */
const CEILING_LIGHT_INTENSITY = 8.2;
const PICTURE_LIGHT_INTENSITY = 4;

/** The nearest `n` fixtures of one kind, nearest first. */
function nearest(
  fixtures: RoomFixture[],
  kind: RoomFixture["kind"],
  reader: { x: number; z: number },
  n: number,
  range: number,
): RoomFixture[] {
  return fixtures
    .filter((f) => f.kind === kind)
    .map((f) => ({
      f,
      d: Math.hypot(f.centre.x - reader.x, f.centre.z - reader.z),
    }))
    .filter((e) => e.d <= range)
    .sort((a, b) => a.d - b.d)
    .slice(0, n)
    .map((e) => e.f);
}

/**
 * A spot light aimed at something. Three points a spot light at its
 * `target` object's world position, and an unparented target sits at the
 * world origin — so the target has to be a real object in the same group as
 * the light, which is what the `<primitive>` is doing here.
 */
function AimedSpot({
  from,
  to,
  color,
  intensity,
}: {
  from: [number, number, number];
  to: [number, number, number];
  color: string;
  intensity: number;
}) {
  const target = React.useMemo(() => new THREE.Object3D(), []);
  return (
    <>
      <primitive object={target} position={to} />
      <spotLight
        position={from}
        target={target}
        color={color}
        intensity={intensity}
        angle={0.66}
        penumbra={0.85}
        distance={PICTURE_LIGHT_RANGE}
        decay={2}
        castShadow={false}
      />
    </>
  );
}

/**
 * The lights, and the fittings they hang in.
 *
 * Every fitting is drawn wherever it is — an unlit glowing plate costs
 * nothing and is what makes a corridor read as lit all the way down. Only
 * the handful nearest the reader get a real light, and the slots are fixed
 * (see above), so walking moves lights rather than creating them.
 */
export function RoomLights({
  fixtures,
  anchor,
  reader,
}: {
  fixtures: RoomFixture[];
  anchor: Anchor;
  /** Where the reader is standing, panel-anchor-relative. */
  reader: { x: number; z: number };
}) {
  /**
   * How many slots of each kind this room can EVER light at once.
   *
   * The constants above are a ceiling, not a quota, and the difference is
   * worth real frames. Three compiles the scene's light count into every lit
   * material, so the count must not change while somebody walks — which is why
   * `nearest` parks unused slots dark rather than unmounting them. But a
   * parked light is not free: it still occupies a uniform slot and is still
   * evaluated per fragment by every lit material, dark or not. Measured on the
   * rooms view, three parked spotlights that changed ZERO pixels cost 44% of
   * the frame's GPU time (0.223 ms → 0.125 ms with them gone, same draw calls,
   * byte-identical output) — and that ratio only grows on a fill-rate-bound
   * mobile GPU rendering two eyes.
   *
   * So keep the count fixed, but fix it to what this room can actually use.
   * `nearest` only ever returns fixtures within `range` of the reader, so for
   * any reader position p within range of some fixture f, every fixture it can
   * return lies within 2·range of f. Taking the largest such neighbourhood
   * over all fixtures is therefore a guaranteed upper bound on the slot count
   * — never dimmer than before, just without the dead slots. A corridor whose
   * luminaires are spread out lights two at a time instead of paying for six.
   *
   * Crucially this depends on `fixtures` and NOT on `reader`: it is fixed for
   * as long as the document is, so walking never changes the light count and
   * nothing ever recompiles.
   */
  const slots = React.useMemo(() => {
    const bound = (kind: RoomFixture["kind"], cap: number, range: number) => {
      const of = fixtures.filter((f) => f.kind === kind);
      let most = 0;
      for (const a of of) {
        let n = 0;
        for (const b of of) {
          if (
            Math.hypot(a.centre.x - b.centre.x, a.centre.z - b.centre.z) <=
            2 * range
          )
            n++;
        }
        if (n > most) most = n;
      }
      return Math.min(most, cap);
    };
    return {
      ceiling: bound("ceiling", CEILING_LIGHT_SLOTS, CEILING_LIGHT_RANGE),
      picture: bound("picture", PICTURE_LIGHT_SLOTS, PICTURE_LIGHT_RANGE),
    };
  }, [fixtures]);

  const lit = React.useMemo(
    () => ({
      ceiling: nearest(
        fixtures,
        "ceiling",
        reader,
        slots.ceiling,
        CEILING_LIGHT_RANGE,
      ),
      picture: nearest(
        fixtures,
        "picture",
        reader,
        slots.picture,
        PICTURE_LIGHT_RANGE,
      ),
    }),
    [fixtures, reader, slots],
  );
  const mats = useRoomMaterials();
  const poolMat = React.useMemo(
    () =>
      new THREE.MeshBasicMaterial({
        map: mats.pool,
        // Warm, like the bulbs throwing them — a white pool added over a warm
        // oak floor bleaches the wood back toward the beige it just left.
        color: LAMP_WARM,
        transparent: true,
        // Subtle: on a pale gallery floor a strong pool reads as a puddle of
        // paint, not as light. Lower than it was, because a room now carries
        // two files of luminaires and their pools overlap down the aisle.
        opacity: 0.12,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        toneMapped: false,
      }),
    [mats.pool],
  );
  React.useEffect(() => () => poolMat.dispose(), [poolMat]);

  /**
   * The lit faces: unlit basic materials, one per bulb colour. This is what
   * keeps a corridor reading as lit all the way down while only its near end
   * is actually lighting anything — the glow costs nothing and does not care
   * how far away it is.
   */
  const bulbMats = React.useMemo(
    () => ({
      warm: new THREE.MeshBasicMaterial({
        color: LAMP_WARM,
        toneMapped: false,
      }),
      cool: new THREE.MeshBasicMaterial({
        color: LAMP_COOL,
        toneMapped: false,
      }),
      picture: new THREE.MeshBasicMaterial({
        color: LAMP_PICTURE,
        toneMapped: false,
      }),
    }),
    [],
  );
  React.useEffect(
    () => () => {
      bulbMats.warm.dispose();
      bulbMats.cool.dispose();
      bulbMats.picture.dispose();
    },
    [bulbMats],
  );

  const bulb = (f: RoomFixture) => (f.space === "room" ? LAMP_WARM : LAMP_COOL);
  /** A fixture's own coordinates, which are anchor-relative, in world space. */
  const world = (p: {
    x: number;
    y: number;
    z: number;
  }): [number, number, number] => [
    anchor.x + p.x,
    anchor.y + p.y,
    anchor.z + p.z,
  ];

  /**
   * Every fitting in the building, welded by material.
   *
   * The fittings are the most numerous thing here — a file of luminaires down
   * every corridor and every room, plus a gallery light over each page, three
   * meshes apiece — and they never move. A hundred-page document had over eight
   * hundred of them; now it has six draw calls. See the note above `weld`.
   */
  const geom = React.useMemo(() => buildFixtureGeometry(fixtures), [fixtures]);

  return (
    <>
      <group position={[anchor.x, anchor.y, anchor.z]} raycast={() => null}>
        <Welded geometry={geom.housing} material={mats.soffit} />
        <Welded geometry={geom.warm} material={bulbMats.warm} />
        <Welded geometry={geom.cool} material={bulbMats.cool} />
        <Welded geometry={geom.shade} material={mats.trim} />
        <Welded geometry={geom.picture} material={bulbMats.picture} />
        <Welded geometry={geom.pools} material={poolMat} />
      </group>

      {/* The real lights: one per slot, parked dark when there is no fitting
          near enough to need it. */}
      {Array.from({ length: slots.ceiling }, (_, i) => {
        const f = lit.ceiling[i];
        return (
          <pointLight
            key={`ceiling-light-${i}`}
            position={f ? world(f.centre) : [0, -50, 0]}
            color={f ? bulb(f) : LAMP_WARM}
            intensity={f ? CEILING_LIGHT_INTENSITY : 0}
            distance={CEILING_LIGHT_RANGE}
            decay={2}
            castShadow={false}
          />
        );
      })}
      {Array.from({ length: slots.picture }, (_, i) => {
        const f = lit.picture[i];
        return (
          <AimedSpot
            key={`picture-light-${i}`}
            from={f ? world(f.centre) : [0, -50, 0]}
            to={f ? world(f.target) : [0, -51, 0]}
            color={LAMP_PICTURE}
            intensity={f ? PICTURE_LIGHT_INTENSITY : 0}
          />
        );
      })}
    </>
  );
}

/**
 * Every light fitting in the building, welded by material. Pure — see
 * `buildShellGeometry`.
 */
function buildFixtureGeometry(fixtures: RoomFixture[]) {
  {
    const housing: Part[] = [];
    const warm: Part[] = [];
    const cool: Part[] = [];
    const pools: Part[] = [];
    const shade: Part[] = [];
    const picture: Part[] = [];

    for (const f of fixtures) {
      const place = at(f.centre.x, f.centre.y, f.centre.z);
      const local = (b: Part[], g: THREE.BufferGeometry, m: THREE.Matrix4) =>
        b.push({ geom: g, matrix: place.clone().multiply(m) });

      if (f.kind === "ceiling") {
        /* The luminaire: a glowing plate hanging below a shallow housing. The
           housing's underside is lifted a centimetre clear of the plate —
           flush, the two faces are coplanar and z-fight into moiré stripes
           across the light. */
        local(
          housing,
          new THREE.BoxGeometry(f.size.width + 0.06, 0.07, f.size.depth + 0.06),
          at(0, 0.045, 0),
        );
        local(
          f.space === "room" ? warm : cool,
          new THREE.PlaneGeometry(f.size.width, f.size.depth),
          at(0, 0, 0, Math.PI / 2, 0, 0),
        );
        /* …and the pool it throws, a hair above the floor so it never z-fights
           the slab it lies on. Roughly the spread a lamp throws from ceiling
           height. */
        local(
          pools,
          new THREE.PlaneGeometry(2.7, 2.7),
          at(0, f.target.y - f.centre.y + 0.008, 0, -Math.PI / 2, 0, 0),
        );
        continue;
      }

      // A gallery light: a small shade on an arm off the wall, with its lit
      // underside facing down the page. Turned to the wall's bearing first,
      // exactly as the <group rotation> that used to carry it did.
      const face = place.clone().multiply(at(0, 0, 0, 0, f.yaw, 0));
      const on = (b: Part[], g: THREE.BufferGeometry, m: THREE.Matrix4) =>
        b.push({ geom: g, matrix: face.clone().multiply(m) });
      on(
        shade,
        new THREE.BoxGeometry(f.size.width, 0.07, f.size.depth),
        at(0, 0, 0),
      );
      // The arm back to the wall — long enough to bury its far end in the
      // plaster rather than stop a finger's width short.
      on(
        shade,
        new THREE.BoxGeometry(0.035, 0.035, f.size.depth * 2.6),
        at(0, 0.02, -f.size.depth),
      );
      /* The lit underside, hanging a clear centimetre below the shade rather
         than flush with its bottom face — flush is coplanar, and coplanar
         z-fights. */
      on(
        picture,
        new THREE.PlaneGeometry(f.size.width * 0.8, f.size.depth * 0.7),
        at(0, -0.046, 0, Math.PI / 2, 0, 0),
      );
    }

    return {
      housing: weld(housing),
      warm: weld(warm),
      cool: weld(cool),
      pools: weld(pools),
      shade: weld(shade),
      picture: weld(picture),
    };
  }
}
