/**
 * scene/elevator-decor.tsx
 *
 * What the `elevator` view's shaft is MADE of, and the signage that makes it
 * navigable. The placement side (renderer/page-placements.ts) says where each
 * storey's ring, deck, soffit and plaque are; this file decides how they
 * read. Same split as room-decor.tsx, and for the same reason.
 *
 * The problem it solves: rings of pages hanging in an empty void give the eye
 * nothing. No horizon, no scale, no line where one storey ends and the next
 * begins, and no clue that ↑/↓ ride between them — so a view whose whole idea
 * is "a building of sections you ride through" read as a debug plot of a
 * cylinder. So the shaft is BUILT:
 *
 *   • a deck under each storey's pages and a lit soffit over them — the two
 *     horizontal lines every real gallery floor has, and between them the
 *     strongest cue there is that a storey IS a storey;
 *   • a glass balustrade with a metal handrail at the edge of the well, which
 *     is what says the middle is open and that you are standing in it;
 *   • a wall behind the pages, so they hang on something rather than float;
 *   • a cove over each ring — the storey's own light, so its pages are the
 *     brightest thing on it and a neighbouring floor is visibly dimmer;
 *   • a directory plate in the slot dead ahead, and a number under every
 *     page, so the ring can be read as an ordered section instead of a wall
 *     of anonymous cards.
 *
 * Everything here is raycast-inert: scenery must never eat a click meant for
 * the page in front of it.
 */
import React from "react";
import * as THREE from "three";
import { Text } from "@react-three/drei";

import type { ElevatorShell, ElevatorFloorShell } from "../page-placements";
import { useTheme, type XRTheme } from "../theme";
import { FontContext } from "./contexts";

/** Panel-anchor origin in world space — everything here is relative to it. */
type Anchor = { x: number; y: number; z: number };

// ── Palette ──────────────────────────────────────────────────
//
// The atrium is architecture, not UI, so — as with the rooms gallery — its
// surfaces are a FIXED palette rather than theme tokens, and only the accents
// follow the product's accent colour.
//
// Unlike the gallery, though, it cannot be fixed in one direction. A page
// card here is the theme's own panel: near-white in the light theme, charcoal
// in the dark one. One shaft colour would sooner or later put charcoal pages
// on a charcoal wall, and the pages are the only thing in this view that
// matters. So there are two shafts — graphite for pale pages, stone for dark
// ones — and the theme picks whichever its pages stand out against. The same
// building, lit for a different exhibit.

interface AtriumPalette {
  /** The shaft wall behind the pages: the ends and the middle of its wash. */
  wallTop: string;
  wallMid: string;
  /** The walkway under a storey's pages, and the ceiling over them. */
  deck: string;
  soffit: string;
  /** The deck's edge beam, and the balustrade standing on it. */
  fascia: string;
  glass: string;
  glassOpacity: number;
  /** The handrail capping the balustrade — the one bright metal line. */
  rail: string;
  /** The cove over each ring, and the plate the signage is cut into. */
  cove: string;
  plate: string;
  plateEdge: string;
  plateText: string;
  plateMuted: string;
}

/** Pale pages (light theme) hang in a graphite shaft. */
const ATRIUM_GRAPHITE: AtriumPalette = {
  wallTop: "#1D1E22",
  wallMid: "#2E3036",
  deck: "#3A3B41",
  soffit: "#34353B",
  fascia: "#4A4B53",
  glass: "#A8BDD6",
  glassOpacity: 0.13,
  rail: "#B9C2CC",
  cove: "#FFE3BC",
  plate: "#3E3F46",
  plateEdge: "#5C5E68",
  plateText: "#F2F1EE",
  plateMuted: "#ADACB4",
};

/** Dark pages (dark theme) hang in a stone one. */
const ATRIUM_STONE: AtriumPalette = {
  wallTop: "#C9C3B7",
  wallMid: "#E8E4DB",
  deck: "#D6D0C4",
  soffit: "#EDEAE3",
  fascia: "#B7B0A2",
  glass: "#6F8299",
  glassOpacity: 0.16,
  rail: "#8A8578",
  cove: "#FFF1D9",
  plate: "#F4F2ED",
  plateEdge: "#BDB6A7",
  plateText: "#23211D",
  plateMuted: "#6B675F",
};

/**
 * Is this surface pale? — the only question asked of a colour here. Kept off
 * THREE.Color on purpose: three's constructors convert into LINEAR sRGB, and
 * comparing a linear value against a threshold picked by eye in sRGB gives
 * the wrong answer right through the middle of the range.
 */
function isPale(hex: string): boolean {
  const h = hex.replace("#", "");
  if (h.length !== 6) return true;
  const r = parseInt(h.slice(0, 2), 16) / 255;
  const g = parseInt(h.slice(2, 4), 16) / 255;
  const b = parseInt(h.slice(4, 6), 16) / 255;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.5;
}

function atriumPalette(theme: XRTheme): AtriumPalette {
  return isPale(theme.panelBg) ? ATRIUM_GRAPHITE : ATRIUM_STONE;
}

// ── Materials ────────────────────────────────────────────────

/**
 * A wash down the shaft wall: darkest at the top and bottom of the run, so
 * the shaft reads as continuing past the storeys it shows rather than as a
 * tube with two cut ends.
 */
function shaftTexture(p: AtriumPalette): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = 4;
  c.height = 256;
  const g = c.getContext("2d")!;
  const grad = g.createLinearGradient(0, c.height, 0, 0);
  grad.addColorStop(0, p.wallTop);
  grad.addColorStop(0.5, p.wallMid);
  grad.addColorStop(1, p.wallTop);
  g.fillStyle = grad;
  g.fillRect(0, 0, c.width, c.height);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/**
 * The deck's surface: concentric joints, so a walkway seen almost edge-on
 * still gives the eye something to measure distance by, and the far side of
 * the well reads as curving away rather than as a flat grey band.
 *
 * Drawn as a disc, not a strip, because three maps a RingGeometry's UVs
 * PLANARLY — u,v come from the vertex's x,y over the outer radius, so the
 * texture square is laid across the annulus like a stencil and a circle in
 * the image is a circle on the deck. (A striped strip, which is what a
 * radial v would have wanted, comes out as parallel bars across the floor.)
 */
function deckTexture(p: AtriumPalette): THREE.Texture {
  const size = 256;
  const c = document.createElement("canvas");
  c.width = size;
  c.height = size;
  const g = c.getContext("2d")!;
  g.fillStyle = p.deck;
  g.fillRect(0, 0, size, size);
  // Joints every so often across the disc rather than at the walkway's own
  // edges: how much of the disc a deck covers depends on its ring's radius
  // (the walkway's width is fixed, the radius is not), so a joint placed to
  // land on the well's edge at one radius misses it at every other.
  const mid = size / 2;
  g.strokeStyle = p.fascia;
  for (const [r, width, alpha] of [
    [0.55, 2, 0.3],
    [0.65, 1.5, 0.2],
    [0.75, 1.5, 0.2],
    [0.85, 1.5, 0.2],
    [0.95, 2, 0.35],
  ] as const) {
    g.globalAlpha = alpha;
    g.lineWidth = width;
    g.beginPath();
    g.arc(mid, mid, mid * r, 0, Math.PI * 2);
    g.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

interface AtriumMaterials {
  palette: AtriumPalette;
  wall: THREE.Material;
  deck: THREE.Material;
  soffit: THREE.Material;
  fascia: THREE.Material;
  glass: THREE.Material;
  rail: THREE.Material;
  cove: THREE.Material;
}

/**
 * One set of materials for the whole shaft — a dozen surfaces, one shader
 * each — built once and kept, as the rooms building does. Keyed by palette
 * because the theme can be swapped live from the settings panel, and the
 * graphite and stone shafts are two different buildings.
 */
const MATERIALS = new Map<AtriumPalette, AtriumMaterials>();

function atriumMaterials(p: AtriumPalette): AtriumMaterials {
  const cached = MATERIALS.get(p);
  if (cached) return cached;
  const built: AtriumMaterials = {
    palette: p,
    wall: new THREE.MeshStandardMaterial({
      map: shaftTexture(p),
      side: THREE.BackSide, // a shaft is only ever seen from inside
      roughness: 0.95,
      metalness: 0,
    }),
    deck: new THREE.MeshStandardMaterial({
      map: deckTexture(p),
      side: THREE.DoubleSide, // a walkway is also the storey below's ceiling
      roughness: 0.8,
      metalness: 0.04,
    }),
    soffit: new THREE.MeshStandardMaterial({
      color: p.soffit,
      side: THREE.DoubleSide,
      roughness: 1,
      metalness: 0,
    }),
    fascia: new THREE.MeshStandardMaterial({
      color: p.fascia,
      side: THREE.DoubleSide,
      roughness: 0.7,
      metalness: 0.08,
    }),
    // Glass, i.e. barely there: a balustrade you see the next storey through.
    // Depth-write off, so nothing behind it is clipped away.
    glass: new THREE.MeshBasicMaterial({
      color: p.glass,
      transparent: true,
      opacity: p.glassOpacity,
      side: THREE.DoubleSide,
      depthWrite: false,
      toneMapped: false,
    }),
    rail: new THREE.MeshStandardMaterial({
      color: p.rail,
      roughness: 0.35,
      metalness: 0.5,
    }),
    // The cove is a light fitting, not a lit surface: unlit, so it reads as
    // bright from the storeys above and below as well as from under it.
    cove: new THREE.MeshBasicMaterial({ color: p.cove, toneMapped: false }),
  };
  MATERIALS.set(p, built);
  return built;
}

function useAtriumMaterials(): AtriumMaterials {
  const theme = useTheme();
  return React.useMemo(() => atriumMaterials(atriumPalette(theme)), [theme]);
}

// ── The shaft ────────────────────────────────────────────────

// The trim sizes below are quoted for a Quest-sized page and multiplied by
// the shell's `trim` factor, which is how much room the storey gap actually
// leaves for them (a Ray-Ban page is half a Quest's, and so is its gap).

/** Radial segments round the shaft — smooth enough at arm's reach. */
const SEGMENTS = 64;
/** How far the deck's edge beam hangs below it. */
const DECK_FASCIA = 0.07;
/** The handrail's section. */
const RAIL_R = 0.018;
/** How far the cove strip drops below the soffit, and how tall it is. */
const COVE_DROP = 0.012;
const COVE_H = 0.028;
/** The cove's lamp, on the storey you are on and on the ones you are not. A
 *  neighbouring floor is meant to be legible scenery, not a second room
 *  competing with yours, so it is lit to about a third. */
const COVE_LIGHT_HERE = 2.8;
const COVE_LIGHT_OFF = 1;
/**
 * How many cove lamps are mounted, always — the placement side draws the
 * focused storey plus ELEVATOR_FLOOR_WINDOW either side of it, so three is
 * the most that can ever be lit, and a top or bottom floor simply parks the
 * spare. Fixed on purpose: three compiles the light count into every
 * material's shader, so a count that fell to two at the ends of the document
 * would stall the whole scene on the first and last storey of every ride.
 */
const COVE_LIGHT_SLOTS = 3;

/**
 * One storey's architecture: deck, balustrade, soffit, cove. Every piece is a
 * ring or a cylinder about the shaft axis, so the storey is one group parked
 * on the axis with nothing but a height to place each piece at.
 */
function AtriumStorey({
  floor,
  inner,
  outer,
  railHeight,
  trim,
  mats,
  anchor,
}: {
  floor: ElevatorFloorShell;
  /** The well's edge and the wall side of the walkway, as radii. */
  inner: number;
  outer: number;
  railHeight: number;
  /** How thick this building's trim may be — see ElevatorShell.trim. */
  trim: number;
  mats: AtriumMaterials;
  anchor: Anchor;
}) {
  const fascia = DECK_FASCIA * trim;
  const coveH = COVE_H * trim;
  const at = (y: number): [number, number, number] => [
    anchor.x + floor.centre.x,
    anchor.y + y,
    anchor.z + floor.centre.z,
  ];

  return (
    <group raycast={() => null}>
      {/* The walkway. A ring geometry is born in the xy-plane facing +z; a
          quarter turn back lays it flat, facing up. */}
      <mesh
        material={mats.deck}
        position={at(floor.deckY)}
        rotation={[-Math.PI / 2, 0, 0]}
      >
        <ringGeometry args={[inner, outer, SEGMENTS]} />
      </mesh>
      {/* Its edge beam at the well, hanging below — what gives a floor plate
          thickness instead of leaving it a sheet of paper seen on edge. */}
      <mesh material={mats.fascia} position={at(floor.deckY - fascia / 2)}>
        <cylinderGeometry args={[inner, inner, fascia, SEGMENTS, 1, true]} />
      </mesh>
      {/* The balustrade: glass standing on the deck's inner edge… */}
      <mesh material={mats.glass} position={at(floor.deckY + railHeight / 2)}>
        <cylinderGeometry
          args={[inner, inner, railHeight, SEGMENTS, 1, true]}
        />
      </mesh>
      {/* …capped by the handrail: one bright ring per storey, and the line
          the eye follows round the well to see how far the far side is. */}
      <mesh
        material={mats.rail}
        position={at(floor.deckY + railHeight)}
        rotation={[-Math.PI / 2, 0, 0]}
      >
        <torusGeometry args={[inner, RAIL_R * trim, 8, SEGMENTS]} />
      </mesh>
      {/* The ceiling over the storey's pages… */}
      <mesh
        material={mats.soffit}
        position={at(floor.soffitY)}
        rotation={[Math.PI / 2, 0, 0]}
      >
        <ringGeometry args={[inner, outer, SEGMENTS]} />
      </mesh>
      {/* …and the cove tucked just inside its outer edge, washing down the
          ring. Inside, so it lights the pages rather than the wall. */}
      <mesh
        material={mats.cove}
        position={at(floor.soffitY - COVE_DROP * trim - coveH / 2)}
      >
        <cylinderGeometry
          args={[
            outer - 0.03 * trim,
            outer - 0.03 * trim,
            coveH,
            SEGMENTS,
            1,
            true,
          ]}
        />
      </mesh>
    </group>
  );
}

/**
 * The shaft the storeys hang in: one wall behind every ring, running well
 * past the top and bottom floors so the building carries on out of sight
 * instead of stopping in mid-air, plus the light each storey's cove throws.
 *
 * The lamps are a fixed set of slots (see COVE_LIGHT_SLOTS), moved between
 * storeys and parked dark when a ride reaches the top or bottom of the
 * document — the same discipline the rooms building keeps, and for the same
 * reason: a changing light count recompiles every material in the scene.
 */
export function ElevatorShaft({
  shell,
  anchor,
}: {
  shell: ElevatorShell;
  anchor: Anchor;
}) {
  const mats = useAtriumMaterials();
  const { shaft } = shell;

  return (
    <>
      <group raycast={() => null}>
        <mesh
          material={mats.wall}
          position={[
            anchor.x + shaft.centreX,
            anchor.y + (shaft.topY + shaft.bottomY) / 2,
            anchor.z + shaft.centreZ,
          ]}
        >
          <cylinderGeometry
            args={[
              shaft.radius,
              shaft.radius,
              shaft.topY - shaft.bottomY,
              SEGMENTS,
              1,
              true,
            ]}
          />
        </mesh>
        {shell.floors.map((f) => (
          <AtriumStorey
            key={`atrium-storey-${f.index}`}
            floor={f}
            inner={Math.max(0.35, f.radius + shell.deckInner)}
            outer={f.radius + shell.deckOuter}
            railHeight={shell.railHeight}
            trim={shell.trim}
            mats={mats}
            anchor={anchor}
          />
        ))}
      </group>
      {/* What the cove actually emits: a lamp on the axis at each storey's
          ceiling. On the axis rather than in the cove itself because the cove
          is a full circle, and one lamp at its centre lights every page on
          the ring alike — which is what a ring of coves does. Always
          COVE_LIGHT_SLOTS of them; a shaft showing only two storeys parks the
          third dark rather than unmounting it. */}
      {Array.from({ length: COVE_LIGHT_SLOTS }, (_, i) => {
        const f = shell.floors[i];
        return (
          <pointLight
            key={`atrium-light-${i}`}
            position={
              f
                ? [
                    anchor.x + f.centre.x,
                    anchor.y + f.soffitY - 0.06,
                    anchor.z + f.centre.z,
                  ]
                : [0, -50, 0]
            }
            color={mats.palette.cove}
            intensity={
              f ? (f.delta === 0 ? COVE_LIGHT_HERE : COVE_LIGHT_OFF) : 0
            }
            distance={f ? f.radius + 1.6 : 1}
            decay={1.3}
            castShadow={false}
          />
        );
      })}
    </>
  );
}

// ── The directory ────────────────────────────────────────────

/** A section name longer than this is a heading, not a name — cut it. Three
 *  lines is what the plate has room for at the name's size. */
const NAME_CAP = 52;

/**
 * An arrow, drawn rather than typed.
 *
 * The scene's font has no ↑ or ↓ — they came out as tofu boxes in the middle
 * of the key legend, which is worse than no legend at all — and a font that
 * is missing two arrows cannot be trusted with ▲ ▼ ● either. A triangle is
 * three vertices; `circleGeometry` with three segments is exactly that, and
 * it renders the same on every device. Vertex 0 of a circle sits on +x, so
 * the rotation below is simply where the point should face.
 */
function Chevron({
  dir,
  size,
  color,
  opacity = 1,
  position,
}: {
  dir: "up" | "down" | "left" | "right";
  size: number;
  color: string;
  opacity?: number;
  position: [number, number, number];
}) {
  const spin = { right: 0, up: Math.PI / 2, left: Math.PI, down: -Math.PI / 2 };
  return (
    <mesh position={position} rotation={[0, 0, spin[dir]]}>
      <circleGeometry args={[size, 3]} />
      <meshBasicMaterial
        color={color}
        transparent
        opacity={opacity}
        toneMapped={false}
      />
    </mesh>
  );
}

/**
 * The plate in the slot the ring keeps dead ahead of the reader.
 *
 * On the storey you are standing on it is a lift's floor indicator, which is
 * the piece of signage this view was missing: which floor this is out of how
 * many, what it is called, how many pages it holds — and the arrow keys that
 * ride between floors, which were otherwise a secret the view never told
 * anyone. The storeys above and below get the same plate with a direction
 * arrow instead of the key legend: they are one floor away, and their own
 * name is what the reader needs in order to decide to go there.
 *
 * It runs the full height of its bay, deck to soffit — see the plaque note in
 * computeElevatorShell — so the whole stack below has room to breathe.
 */
export function ElevatorDirectory({
  shell,
  anchor,
}: {
  shell: ElevatorShell;
  anchor: Anchor;
}) {
  const theme = useTheme();
  const mats = useAtriumMaterials();
  const p = mats.palette;
  const fontType = React.useContext(FontContext);

  return (
    <group raycast={() => null}>
      {shell.floors.map((f) => {
        const here = f.delta === 0;
        // The plate is laid out at the reference page size and the whole
        // group is then scaled to this build's — otherwise a floor number set
        // in absolute metres is a third of the plate on a Quest and most of it
        // on a Ray-Ban. `w`/`h` below are therefore reference units.
        const k = shell.trim;
        const w = f.plaque.size.width / k;
        const h = f.plaque.size.height / k;
        // A neighbouring storey's plate is scenery at the same brightness its
        // pages are — the ring above must not out-shout the one you are on.
        const dim = here ? 1 : 0.5;
        const left = -w / 2 + 0.06;
        // A document with no sections at all is one nameless floor; calling
        // it "Section 1 of 1" would be inventing a structure it hasn't got.
        const name = (
          f.label || (f.floorCount === 1 ? "All pages" : `Section ${f.index + 1}`)
        ).slice(0, NAME_CAP);
        return (
          <group
            key={`atrium-plaque-${f.index}`}
            position={[
              anchor.x + f.plaque.offset.x,
              anchor.y + f.plaque.offset.y,
              anchor.z + f.plaque.offset.z,
            ]}
            rotation={[
              f.plaque.rotation.x,
              f.plaque.rotation.y,
              f.plaque.rotation.z,
            ]}
            scale={k}
          >
            {/* The plate, and a hairline reveal round it — an edge is what
                separates a sign screwed to the wall from a decal printed on
                it. Unlit, so it reads the same from the storey above as from
                under this one's cove. */}
            <mesh position={[0, 0, -0.008]}>
              <planeGeometry args={[w + 0.018, h + 0.018]} />
              <meshBasicMaterial
                color={p.plateEdge}
                transparent
                opacity={dim}
                toneMapped={false}
              />
            </mesh>
            <mesh position={[0, 0, -0.006]}>
              <planeGeometry args={[w, h]} />
              <meshBasicMaterial
                color={p.plate}
                transparent
                opacity={dim}
                toneMapped={false}
              />
            </mesh>

            {/* The floor number, where a lift indicator puts it. The rows
                below are spaced off measured line boxes, not eyeballed: a
                troika "top" anchor is the top of the LINE, so a row's ink
                reaches about 0.9 of its font size below the anchor, and two
                rows set a font size apart collide. */}
            <Text
              font={fontType}
              anchorX="left"
              anchorY="top"
              position={[left, h / 2 - 0.035, 0]}
              fontSize={0.14}
              color={theme.accentCol}
              fillOpacity={dim}
            >
              {`${f.index + 1}`}
            </Text>
            <Text
              font={fontType}
              anchorX="left"
              anchorY="top"
              // Clear of the number itself, which is a digit wider on floor 10
              // than on floor 9.
              position={[
                left + 0.055 + 0.062 * String(f.index + 1).length,
                h / 2 - 0.048,
                0,
              ]}
              fontSize={0.036}
              color={p.plateMuted}
              fillOpacity={dim}
            >
              {`OF ${f.floorCount}`}
            </Text>
            {/* …and, on a floor you are not on, which way it lies. */}
            {!here && (
              <Chevron
                dir={f.delta < 0 ? "up" : "down"}
                size={0.03}
                color={p.plateMuted}
                opacity={dim}
                position={[w / 2 - 0.085, h / 2 - 0.09, 0]}
              />
            )}

            {/* The section's name — the plate's whole reason to exist. */}
            <Text
              font={fontType}
              anchorX="left"
              anchorY="top"
              position={[left, h / 2 - 0.2, 0]}
              fontSize={0.062}
              color={p.plateText}
              fillOpacity={dim}
              maxWidth={w - 0.12}
              lineHeight={1.2}
            >
              {name}
            </Text>

            {/* A rule, then the section's size: how much floor this is. */}
            <mesh position={[0, -h / 2 + 0.235, 0]}>
              <planeGeometry args={[w - 0.12, 0.005]} />
              <meshBasicMaterial
                color={p.plateEdge}
                transparent
                opacity={dim}
                toneMapped={false}
              />
            </mesh>
            <Text
              font={fontType}
              anchorX="left"
              anchorY="top"
              position={[left, -h / 2 + 0.215, 0]}
              fontSize={0.036}
              color={p.plateMuted}
              fillOpacity={dim}
              maxWidth={w - 0.12}
            >
              {`${f.pageCount} page${f.pageCount === 1 ? "" : "s"}${
                f.shownCount < f.pageCount ? ` · ${f.shownCount} on this ring` : ""
              }`}
            </Text>

            {/* The controls, on the floor you are on only: repeated on all
                three plates they would be wallpaper and read as nothing.
                The arrows are DRAWN (see Chevron) — the font has no ↑/↓, and
                typing them put two tofu boxes in the middle of the legend. */}
            {here && (
              <>
                <Chevron
                  dir="up"
                  size={0.016}
                  color={theme.accentCol}
                  position={[left + 0.017, -h / 2 + 0.115, 0]}
                />
                <Chevron
                  dir="down"
                  size={0.016}
                  color={theme.accentCol}
                  position={[left + 0.056, -h / 2 + 0.115, 0]}
                />
                <Text
                  font={fontType}
                  anchorX="left"
                  anchorY="middle"
                  position={[left + 0.08, -h / 2 + 0.115, 0]}
                  fontSize={0.03}
                  color={theme.accentCol}
                >
                  floor
                </Text>
                <Chevron
                  dir="left"
                  size={0.016}
                  color={theme.accentCol}
                  position={[left + 0.192, -h / 2 + 0.115, 0]}
                />
                <Chevron
                  dir="right"
                  size={0.016}
                  color={theme.accentCol}
                  position={[left + 0.231, -h / 2 + 0.115, 0]}
                />
                <Text
                  font={fontType}
                  anchorX="left"
                  anchorY="middle"
                  position={[left + 0.255, -h / 2 + 0.115, 0]}
                  fontSize={0.03}
                  color={theme.accentCol}
                >
                  page
                </Text>
                <Text
                  font={fontType}
                  anchorX="left"
                  anchorY="middle"
                  position={[left, -h / 2 + 0.055, 0]}
                  fontSize={0.026}
                  color={p.plateMuted}
                >
                  drag to look round · point at a page to enlarge it
                </Text>
              </>
            )}
          </group>
        );
      })}
    </group>
  );
}

// ── Slot signage ─────────────────────────────────────────────

/** How far INSIDE a card's bottom edge its number chip sits, and how tall
 *  that chip is. Scaled by the shell's trim factor, like all the rest. */
const TAG_INSET = 0.012;
const TAG_H = 0.054;
/** The accent frame marking the page under the pointer. */
const FRAME_W = 0.014;
/**
 * How far proud of the card the mark's own geometry sits. Content inside a
 * page is z-staggered by nesting depth up to MAX_STACK_DEPTH · Z_STACK_STEP
 * (0.024 m), so anything meant to read as ON the page has to clear that — and
 * having cleared it, it also wins the depth test against every page behind it
 * on the ring.
 */
const MARK_PROUD = 0.04;
/** Text on the accent chip. Not pure white: nothing on a surface in a
 *  headset should be (see theme.ts on the Meta brightness bounds). */
const CHIP_TEXT = "#F4F4F4";

/**
 * The mark on one page's slot: its number, and — for the page actually being
 * read — an accent chip saying so.
 *
 * This answers a problem the elevator's own design creates. Being the current
 * page deliberately earns no emphasis here (nothing flies out of the wall, so
 * the ring keeps its shape and a page keeps its place), which left the reader
 * with no way whatever to see where in the section they were. A mark on the
 * slot says it without moving anything.
 *
 * It sits ON the card, just inside the bottom edge, where a printed page puts
 * its own number — not hanging below the card, which is where it started.
 * Below the card is the band the balustrade sweeps: the rail runs half a
 * metre nearer the reader than the ring, so anything hung under a page is
 * behind the rail from any eye lower than it.
 *
 * Drawn in the cell's own space: the card spans x ∈ [0, width] and
 * y ∈ [−height, 0] from the top-left anchor <AtPos> parks the group at, and
 * <EasedScale> has already built it at this cell's scale.
 */
export function ElevatorSlotMark({
  width,
  height,
  trim,
  pageIndex,
  current,
  pointed,
  dim,
}: {
  width: number;
  height: number;
  /** How much room the storey leaves under a card — see ElevatorShell.trim. */
  trim: number;
  pageIndex: number;
  /** The page being read — the one the live ghost on the ring is pinned to. */
  current: boolean;
  /** The page under the pointer/ray, i.e. the one being magnified. */
  pointed: boolean;
  /** On a storey the reader is not standing on: scenery, so barely marked. */
  dim: boolean;
}) {
  const theme = useTheme();
  const mats = useAtriumMaterials();
  const fontType = React.useContext(FontContext);
  const p = mats.palette;
  const opacity = dim ? 0.4 : 1;
  // The chip grows to hold its legend on the page being read, and is a bare
  // number everywhere else — one loud mark on the ring, not thirty.
  const tagW = current
    ? Math.min(width * 0.6, 0.46 * trim)
    : Math.max(0.07, width * 0.13);
  const tagH = TAG_H * trim;
  const tagY = -height + TAG_INSET * trim + tagH / 2;

  return (
    <group raycast={() => null}>
      {/* Proud of the page's own content, which it is now lying on top of. */}
      <mesh position={[width / 2, tagY, MARK_PROUD]}>
        <planeGeometry args={[tagW, tagH]} />
        {/* Only see-through on a storey the reader is not on. A solid chip
            stays solid: transparent-with-depthWrite-off is what let the pages
            behind the frame paint over it, and the chip is no different. */}
        <meshBasicMaterial
          color={current ? theme.accentCol : p.plate}
          transparent={dim}
          opacity={dim ? 0.45 : 1}
          depthWrite={!dim}
          toneMapped={false}
        />
      </mesh>
      <Text
        font={fontType}
        anchorX="center"
        anchorY="middle"
        position={[width / 2, tagY, MARK_PROUD + 0.003]}
        fontSize={(current ? 0.03 : 0.032) * trim}
        color={current ? CHIP_TEXT : p.plateMuted}
        fillOpacity={opacity}
      >
        {/* No bullet glyph: the font that lost ↑ and ↓ cannot be trusted
            with ● either, and a tofu box on the one mark that says where you
            are would be the worst place in the view to find one. */}
        {current ? `reading · page ${pageIndex + 1}` : `${pageIndex + 1}`}
      </Text>

      {/* The frame marking the page under the pointer. It is already growing
          to full size and closing in; the frame is what says that is a
          response to the reader rather than the room rearranging itself.

          Inset ONTO the card's face rather than ringing its outside edge, and
          proud of it in z. Outside the edge it was competing for pixels with
          whatever the ring put behind it, and — being an opaque material with
          depthWrite off — it wrote colour but no depth, so every page drawn
          after it painted straight back over the parts it had covered. Half a
          frame is worse than none: it reads as the page being clipped. */}
      {pointed &&
        [
          {
            p: [width / 2, -FRAME_W / 2, MARK_PROUD],
            a: [width, FRAME_W],
          },
          {
            p: [width / 2, -height + FRAME_W / 2, MARK_PROUD],
            a: [width, FRAME_W],
          },
          {
            p: [FRAME_W / 2, -height / 2, MARK_PROUD],
            a: [FRAME_W, height],
          },
          {
            p: [width - FRAME_W / 2, -height / 2, MARK_PROUD],
            a: [FRAME_W, height],
          },
        ].map((b, i) => (
          <mesh
            key={`slot-frame-${i}`}
            position={b.p as [number, number, number]}
          >
            <planeGeometry args={b.a as [number, number]} />
            <meshBasicMaterial color={theme.accentCol} toneMapped={false} />
          </mesh>
        ))}
    </group>
  );
}
