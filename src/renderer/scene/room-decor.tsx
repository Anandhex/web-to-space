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
  const built: RoomMaterials = {
    floorMap: floorTexture(p),
    pool: poolTexture(),
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
  return (
    <group raycast={() => null}>
      {walls.map((w, i) => (
        <group
          key={`room-wall-${i}`}
          position={[
            anchor.x + w.centre.x,
            anchor.y + w.centre.y,
            anchor.z + w.centre.z,
          ]}
          rotation={[0, w.yaw, 0]}
        >
          {w.lintel ? (
            /* The head over a doorway, a shade lighter than the wall it sits
               in — the way a plastered reveal catches more light than the
               wall around it. It used to carry a bright accent strip, which
               read as a neon exit sign rather than as a gallery: the opening
               is legible because the space beyond it is lit, and because the
               section's name hangs above it. */
            <>
              <mesh material={mats.headMat}>
                <planeGeometry args={[w.size.width, w.size.height]} />
              </mesh>
              {/* The lining round the opening below it. The lintel is the one
                  piece that knows where a doorway IS — it is the piece that
                  spans one — so the frame is drawn from it: a head band along
                  its foot and a jamb down each side, reaching from there to
                  the floor. Straddling boxes, like the skirting, so one set
                  serves the space on either side of the wall. */}
              <mesh
                material={mats.jamb}
                position={[0, -w.size.height / 2 + JAMB_W / 2, 0]}
              >
                <boxGeometry
                  args={[
                    w.size.width + 2 * JAMB_W,
                    JAMB_W,
                    JAMB_PROUD * 2,
                  ]}
                />
              </mesh>
              {(() => {
                // The opening below this lintel: from the floor up to the
                // lintel's own foot, which IS the door head.
                const openH = Math.max(
                  0.01,
                  w.centre.y - w.size.height / 2 - floorY,
                );
                // The jamb runs the height of the opening plus the head band
                // it dies into at the top.
                const jambH = openH + JAMB_W;
                const jambY = floorY + jambH / 2 - w.centre.y;
                return [-1, 1].map((s) => (
                  <mesh
                    key={`jamb-${s}`}
                    material={mats.jamb}
                    position={[(s * (w.size.width + JAMB_W)) / 2, jambY, 0]}
                  >
                    <boxGeometry args={[JAMB_W, jambH, JAMB_PROUD * 2]} />
                  </mesh>
                ));
              })()}
            </>
          ) : (
            /* A link door's opening is filled by its own leaf (see
               LinkDoors), which sits exactly on this piece — so the piece
               drops a centimetre behind it rather than z-fighting with it,
               and still closes the wall from the far side. */
            <mesh material={mats.wall} position={[0, 0, w.portal ? -0.01 : 0]}>
              <planeGeometry args={[w.size.width, w.size.height]} />
            </mesh>
          )}
          {isFullHeight(w) && (
            <>
              {/* Skirting: a box, not a plane, so it has a top face for the
                  ceiling light to catch. One box straddling the wall serves
                  both of its sides — a wall piece is shared between two
                  spaces, and two half-boxes would be two draw calls for the
                  same board. Placed in the piece's own frame, where y is
                  measured from its centre and +z is the face. */}
              <mesh
                material={mats.trim}
                position={[0, floorY - w.centre.y + SKIRT_H / 2, 0]}
              >
                <boxGeometry args={[w.size.width, SKIRT_H, TRIM_PROUD * 2]} />
              </mesh>
              {/* The picture rail, level with the top edge of the pages —
                  and only on the walls pages actually hang on. Run down the
                  corridor as well it became a long horizontal edge at eye
                  height, and every horizontal edge converges on eye height in
                  the distance: it drew itself straight through the section
                  sign over each far doorway. */}
              {w.hangs && (
                <mesh material={mats.rail} position={[0, railY - w.centre.y, 0]}>
                  <boxGeometry args={[w.size.width, RAIL_H, TRIM_PROUD * 2]} />
                </mesh>
              )}
            </>
          )}
        </group>
      ))}
    </group>
  );
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
export function RoomSlabs({ slabs, anchor }: { slabs: RoomSlab[]; anchor: Anchor }) {
  const mats = useRoomMaterials();
  // Each floor gets its own tiling of the shared texture image.
  const floorMaps = React.useMemo(
    () =>
      slabs.map((s) => {
        if (s.facing !== "up") return null;
        const t = mats.floorMap.clone();
        t.needsUpdate = true;
        t.repeat.set(
          Math.max(1, Math.round(s.size.width)),
          Math.max(1, Math.round(s.size.depth)),
        );
        return t;
      }),
    [slabs, mats.floorMap],
  );
  React.useEffect(
    () => () => floorMaps.forEach((t) => t?.dispose()),
    [floorMaps],
  );

  return (
    <group raycast={() => null}>
      {slabs.map((s, i) => {
        const at: [number, number, number] = [
          anchor.x + s.centre.x,
          anchor.y + s.centre.y,
          anchor.z + s.centre.z,
        ];
        if (s.facing === "up")
          return (
            <mesh
              key={`room-slab-${i}`}
              position={at}
              // A plane faces +z; a quarter turn back lays it flat facing up.
              rotation={[-Math.PI / 2, 0, 0]}
            >
              <planeGeometry args={[s.size.width, s.size.depth]} />
              {/* Sealed boards: a shade glossier than plaster, so the
                  luminaires above leave a soft sheen down the floor and the
                  reader can see the light has a source. Not metallic — the
                  old 0.06 metalness on a warm floor greyed it out. */}
              <meshStandardMaterial
                map={floorMaps[i] ?? undefined}
                roughness={0.6}
                metalness={0}
              />
            </mesh>
          );
        const halfW = s.size.width / 2;
        const halfD = s.size.depth / 2;
        return (
          <group key={`room-slab-${i}`} position={at}>
            <mesh material={mats.ceiling} rotation={[Math.PI / 2, 0, 0]}>
              <planeGeometry args={[s.size.width, s.size.depth]} />
            </mesh>
            {/* The dropped band round the edge of the ceiling. */}
            {[
              {
                p: [0, -SOFFIT_DROP / 2 - 0.001, -halfD + SOFFIT_BAND / 2],
                a: [s.size.width, SOFFIT_DROP, SOFFIT_BAND],
              },
              {
                p: [0, -SOFFIT_DROP / 2 - 0.001, halfD - SOFFIT_BAND / 2],
                a: [s.size.width, SOFFIT_DROP, SOFFIT_BAND],
              },
              {
                p: [-halfW + SOFFIT_BAND / 2, -SOFFIT_DROP / 2 - 0.001, 0],
                a: [SOFFIT_BAND, SOFFIT_DROP, s.size.depth],
              },
              {
                p: [halfW - SOFFIT_BAND / 2, -SOFFIT_DROP / 2 - 0.001, 0],
                a: [SOFFIT_BAND, SOFFIT_DROP, s.size.depth],
              },
            ].map((b, k) => (
              <mesh
                key={`soffit-${k}`}
                material={mats.soffit}
                position={b.p as [number, number, number]}
              >
                <boxGeometry args={b.a as [number, number, number]} />
              </mesh>
            ))}
          </group>
        );
      })}
    </group>
  );
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
  const lit = React.useMemo(
    () => ({
      ceiling: nearest(
        fixtures,
        "ceiling",
        reader,
        CEILING_LIGHT_SLOTS,
        CEILING_LIGHT_RANGE,
      ),
      picture: nearest(
        fixtures,
        "picture",
        reader,
        PICTURE_LIGHT_SLOTS,
        PICTURE_LIGHT_RANGE,
      ),
    }),
    [fixtures, reader],
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

  const bulb = (f: RoomFixture) => (f.space === "room" ? LAMP_WARM : LAMP_COOL);
  const world = (p: { x: number; y: number; z: number }): [number, number, number] => [
    anchor.x + p.x,
    anchor.y + p.y,
    anchor.z + p.z,
  ];

  return (
    <>
      <group raycast={() => null}>
        {fixtures.map((f, i) =>
          f.kind === "ceiling" ? (
            <group key={`fixture-${i}`} position={world(f.centre)}>
              {/* The luminaire: a glowing plate hanging below a shallow
                  housing. The housing's underside is lifted a centimetre
                  clear of the plate — flush, the two faces are coplanar and
                  z-fight into moiré stripes across the light. */}
              <mesh material={mats.soffit} position={[0, 0.045, 0]}>
                <boxGeometry args={[f.size.width + 0.06, 0.07, f.size.depth + 0.06]} />
              </mesh>
              <mesh rotation={[Math.PI / 2, 0, 0]}>
                <planeGeometry args={[f.size.width, f.size.depth]} />
                <meshBasicMaterial color={bulb(f)} toneMapped={false} />
              </mesh>
              {/* …and the pool it throws, a hair above the floor so it never
                  z-fights the slab it lies on. */}
              <mesh
                material={poolMat}
                position={[0, f.target.y - f.centre.y + 0.008, 0]}
                rotation={[-Math.PI / 2, 0, 0]}
              >
                {/* Roughly the spread a lamp throws from ceiling height. */}
                <planeGeometry args={[2.7, 2.7]} />
              </mesh>
            </group>
          ) : (
            <group
              key={`fixture-${i}`}
              position={world(f.centre)}
              rotation={[0, f.yaw, 0]}
            >
              {/* A gallery light: a small shade on an arm off the wall, with
                  its lit underside facing down the page. */}
              <mesh material={mats.trim}>
                <boxGeometry args={[f.size.width, 0.07, f.size.depth]} />
              </mesh>
              {/* The arm back to the wall — long enough to bury its far end
                  in the plaster rather than stop a finger's width short. */}
              <mesh material={mats.trim} position={[0, 0.02, -f.size.depth]}>
                <boxGeometry args={[0.035, 0.035, f.size.depth * 2.6]} />
              </mesh>
              {/* The lit underside, hanging a clear centimetre below the
                  shade rather than flush with its bottom face — flush is
                  coplanar, and coplanar z-fights. */}
              <mesh position={[0, -0.046, 0]} rotation={[Math.PI / 2, 0, 0]}>
                <planeGeometry args={[f.size.width * 0.8, f.size.depth * 0.7]} />
                <meshBasicMaterial color={LAMP_PICTURE} toneMapped={false} />
              </mesh>
            </group>
          ),
        )}
      </group>

      {/* The real lights: one per slot, parked dark when there is no fitting
          near enough to need it. */}
      {Array.from({ length: CEILING_LIGHT_SLOTS }, (_, i) => {
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
      {Array.from({ length: PICTURE_LIGHT_SLOTS }, (_, i) => {
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
