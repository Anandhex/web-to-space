/**
 * scene/neighbour-walls.tsx — a neighbouring document, drawn in the run.
 *
 * A strip says where you COULD go. A card shows what is there
 * (docs/neighbour-walls.md). The two live in the SAME list: a column of doors
 * down the side of the page, most of them plates, and the few the document
 * leans on hardest opened out into a card carrying the destination's name and
 * the shape of its contents.
 *
 * That is the one structural decision here, and it was arrived at the long way
 * round. Earlier builds placed the neighbours as a separate ring outside the
 * strips — a corridor receding away, then a dome facing the reader, then a
 * ring around the board's perimeter. All of them worked geometrically and all
 * of them were wrong in the same way: they made the neighbourhood a second
 * system, parallel to the doors, with the same destination appearing twice in
 * two different vocabularies. A neighbour is not a place beside the list. It
 * is an entry IN the list that has earned more room.
 *
 * Three rules survive from those builds and still hold:
 *
 *  1. **A card never draws a live page.** The rooms view learned this the
 *     expensive way — 1336 meshes down to 14. A neighbour is a picture of a
 *     document, not a second copy of the renderer: a name and its section
 *     colours, nothing more.
 *  2. **The label holds an angular floor.** A card shrinks when its run is
 *     long; its text does not follow it down past legibility.
 *  3. **A card that has not arrived is not a hole.** Until its document lands
 *     the reader keeps the plate they already had, and nothing here can throw
 *     a network error into a frame.
 */
import React from "react";
import { Text } from "@react-three/drei";

import { useTheme } from "../theme";
import { Surface } from "../primitives/surface";
import { Z_LAYER_ACCENT, Z_LAYER_OVERLAY_TEXT, Z_SURFACE } from "../primitives/constants";
import { FontContext, useLinkBinding } from "./contexts";
import { sectionRangesFor } from "./page-ghosts";
import { isDarkTheme, sectionTint, shade } from "./section-tint";
import type { WingDoc } from "./use-neighbourhood";

/** Smallest a card's own text may be drawn, whatever its surface measures. */
const WING_MIN_FONT = 0.016;

/**
 * Truncate a name to what will actually fit on a surface of this width.
 *
 * The same rule and the same 0.5-em working average `DoorPlate` uses, for the
 * same reason: a fixed character cap clips a wide card's title for nothing and
 * leaves a narrow one reading "en.wikipedia…", and a card whose name is
 * truncated to nothing is a card with no name.
 */
function fitLabel(name: string, boxWidth: number, fontSize: number): string {
  const fits = Math.max(6, Math.floor(boxWidth / (fontSize * 0.5)));
  const t = name || "link";
  return t.length > fits ? `${t.slice(0, Math.max(3, fits - 1))}…` : t;
}

/** Section names of a neighbour, from its plan when it has one, its scan otherwise. */
function sectionsOf(wing: WingDoc): string[] {
  if (wing.plan && wing.pageCount) {
    const ranges = sectionRangesFor(wing.plan, wing.pageCount);
    if (ranges.length > 0) return ranges.map((r) => r.label).filter(Boolean);
  }
  return wing.scan?.headings ?? [];
}

/**
 * A neighbour drawn IN THE RUN, in the place its plate would have taken.
 *
 * Sized by the run, not by a geometry of its own: the caller gives it the
 * column's width and whatever height that run's budget allowed, so a card in a
 * crowded column is a smaller card rather than an overflowing one.
 */
export function WingCard({
  wing,
  width,
  height,
  onTake,
}: {
  wing: WingDoc;
  width: number;
  height: number;
  onTake: (w: WingDoc) => void;
}) {
  const theme = useTheme();
  const dark = isDarkTheme(theme);
  const fontType = React.useContext(FontContext);
  const { lit, setLit } = useLinkBinding();
  const [hover, setHover] = React.useState(false);
  const active = hover || (wing.linkId !== null && lit === wing.linkId);

  const sections = sectionsOf(wing).slice(0, 5);
  const titleSize = Math.max(WING_MIN_FONT, Math.min(height * 0.24, width * 0.075));
  const chipH = Math.min(height * 0.16, width * 0.07);
  const chipW =
    sections.length > 0
      ? Math.max(0.004, Math.min(chipH * 1.3, (width * 0.86) / sections.length - width * 0.015))
      : 0;

  return (
    <group
      onClick={(e) => {
        e.stopPropagation();
        onTake(wing);
      }}
      onPointerOver={(e) => {
        e.stopPropagation();
        setHover(true);
        if (wing.linkId) setLit(wing.linkId);
      }}
      onPointerOut={() => {
        setHover(false);
        if (wing.linkId) setLit(null);
      }}
    >
      <Surface
        width={width}
        height={height}
        color={shade(theme.panelBg, dark ? 0.05 : -0.08)}
        gradient
        rimColor={active ? sectionTint(0, dark).accent : theme.panelRim}
        rimOpacity={active ? 1 : 0.8}
        origin={[0, 0]}
        z={Z_SURFACE}
      />
      <Text
        font={fontType}
        anchorX="left"
        anchorY="top"
        position={[-width / 2 + width * 0.055, height / 2 - height * 0.12, Z_LAYER_OVERLAY_TEXT]}
        fontSize={titleSize}
        color={theme.bodyCol}
        maxWidth={width * 0.89}
      >
        {fitLabel(wing.label, width * 0.89 * 2, titleSize)}
      </Text>
      {/* The destination's own sections, as its colours. Not a preview — the
          one thing a plate cannot say is how much is on the other side. */}
      {sections.map((_, i) => (
        <mesh
          key={i}
          position={[
            -width / 2 + width * 0.055 + chipW / 2 + i * (chipW + width * 0.015),
            -height / 2 + chipH * 0.85,
            Z_LAYER_ACCENT,
          ]}
        >
          <planeGeometry args={[chipW, chipH]} />
          <meshBasicMaterial color={sectionTint(i, dark).accent} toneMapped={false} />
        </mesh>
      ))}
    </group>
  );
}
