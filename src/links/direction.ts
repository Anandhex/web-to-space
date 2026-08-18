/**
 * links/direction.ts — relation as direction.
 *
 * The abandoned design encoded navigational cost as RADIUS, which a headset
 * reader cannot judge: bodies were scale-compensated so every one subtended
 * the same visual angle whatever its distance, so the channel carried nothing
 * perceivable. This design encodes relation as DIRECTION, read by head yaw and
 * pitch, and it is identical in all four views so the reader learns one legend
 * and it holds everywhere (docs/directional-links.md, Part I).
 *
 *   up       parent / top-level — site navigation, breadcrumbs, footer nav
 *   lateral  sibling — another document on the same site
 *   here     same-page — a pointer at something this view already draws
 *   down     external — another site
 *   inline   operational — mailto:, tel:, javascript:, downloads; no direction
 *
 * This module is a PURE RE-PROJECTION of `classify.ts` onto those five. The
 * classifier is not re-tuned for it and does not import it: regions are what
 * the gold set scores and what the census counted, and they stay the unit of
 * evidence. Direction is what the geometry consumes.
 *
 * `footing` collapses entirely. A citation had its own region because the
 * abandoned design gave it its own ring; with no rings there is nowhere for it
 * to be, and where a citation actually LEADS is the only question left — so it
 * resolves by locus like anything else, and the `citation` flag on the link
 * survives as a marker the renderer may still draw.
 *
 * Renderer-free and three.js-free, like the rest of `src/links/` — it runs in
 * Node under the offline census and the gold set.
 */
import type { Locus, Region } from "./types";

/**
 * The five kinds. Four are directions the reader turns their head to; `inline`
 * is the absence of one — an operational link stays at its anchor because
 * following it hands off to another application and no corridor could stand
 * for that (docs/directional-links.md, "Decisions taken" item 6).
 */
export type LinkDirection = "up" | "lateral" | "down" | "here" | "inline";

/** In legend order: up, lateral, here, down, inline. */
export const DIRECTIONS: readonly LinkDirection[] = [
  "up",
  "lateral",
  "here",
  "down",
  "inline",
];

/**
 * The directions that open something — a corridor, a stair, a face of the
 * dice, a path off the table. `here` moves the reader inside the current
 * structure and `inline` moves them out of the browser, so neither travels.
 */
export const TRAVELLED: readonly LinkDirection[] = ["up", "lateral", "down"];

export function isTravelled(d: LinkDirection): boolean {
  return d === "up" || d === "lateral" || d === "down";
}

/**
 * The inline mark that reinforces the legend at the anchor.
 *
 * Direction tells the reader the KIND of a link; it cannot tell them WHICH
 * link a given door came from, and the census says alignment cannot fix that
 * either — 49.8% of anchors share a block with another anchor, so pointing a
 * door at its paragraph is ambiguous half the time. So the anchor text keeps a
 * mark, and the mark's ORIENTATION is the same legend the geometry uses.
 *
 * NO COLOUR AND NO UNDERLINE. That is the whole point of the scheme: there is
 * no blue text anywhere in this design, and a mark that reintroduced a
 * chromatic channel would reintroduce the thing it replaced.
 */
export const DIRECTION_MARKS: Record<LinkDirection, string> = {
  up: "▴", // ▴ small up-pointing triangle
  lateral: "▸", // ▸ small right-pointing triangle
  here: "•", // • filled dot: a pointer, not a direction
  down: "▾", // ▾ small down-pointing triangle
  inline: "", // operational links get nothing
};

export function markFor(d: LinkDirection): string {
  return DIRECTION_MARKS[d];
}

/** The space that separates an anchor from its mark. Hair-thin, not a word gap. */
export const MARK_SEPARATOR = " "; // thin space

/** An anchor's text with its mark, exactly as troika is handed it. */
export function textWithMark(text: string, d: LinkDirection): string {
  const mark = DIRECTION_MARKS[d];
  return mark === "" ? text : text + MARK_SEPARATOR + mark;
}

/**
 * What a mark costs the inline flow, for the LAYOUT ESTIMATE.
 *
 * `layout/utils.ts`'s `estimateInlineFlowHeight` measures the string the
 * renderer will draw, and the note there says why the two must not drift: a
 * join that adds a wrap line gets drawn taller than the space reserved for it
 * and overruns the block below. Marks add characters to every anchor, so the
 * estimate has to add them too.
 *
 * The estimate cannot classify — it has no page URL and no ancestry, and the
 * layout engine is not the place to acquire either. So it appends this fixed
 * placeholder to EVERY link instead. That is exact for the four directions
 * that draw a mark and one separator-plus-glyph too generous for operational
 * links, which draw none. Over-reserving is the safe side of the error: the
 * text comes out shorter than the space kept for it, never longer.
 */
export const MARK_FLOW_PLACEHOLDER = MARK_SEPARATOR + "▸";

/**
 * The projection table. Every branch is in docs/directional-links.md Phase 1;
 * the only case the doc leaves open is `field` with an `unknown` locus, which
 * is an absolute href that would not parse. It goes DOWN: it is absolute, so
 * it was written as a destination away from this document, and the one thing
 * we can say is that it is not a fragment of this page.
 */
export function directionFor(region: Region, locus: Locus): LinkDirection {
  switch (region) {
    case "page":
      return "inline";
    case "ascent":
      return "up";
    case "arrangement":
      return "here";
    case "field":
    case "footing":
      // `footing` collapses into the same locus test as `field`: the region
      // survives only as the `citation` flag on the link itself.
      return directionForLocus(locus);
  }
}

/** Locus alone, once a region has handed over. */
export function directionForLocus(locus: Locus): LinkDirection {
  switch (locus) {
    case "operational":
      return "inline";
    case "same-document":
      return "here";
    case "same-site":
      return "lateral";
    case "off-site":
    case "unknown":
      return "down";
  }
}

/** Convenience over anything shaped like a classified link. */
export function directionOf(link: { region: Region; locus: Locus }): LinkDirection {
  return directionFor(link.region, link.locus);
}

// ── Lateral overflow ─────────────────────────────────────────────────────

/** The two halves a lateral run fills. */
export type LateralSide = "right" | "left";

/**
 * Which side of the reader each sibling takes.
 *
 * Deferred in the spec ("Sibling overflow"), with a stated default: fill
 * right, overflow to left, then paginate the lateral run. p90 is 5 siblings a
 * page and the max in the census is 50, so overflow is real but rare, and the
 * default is cheap enough to replace once it is measured.
 *
 * `perSide` is one side's window (the wall's is 3), so a run of 7 with a
 * window of 3 fills right 0–2, left 3–5, and reports 6 as overflow.
 */
export function assignLateralSides<T>(
  items: readonly T[],
  perSide: number,
): { item: T; side: LateralSide; slot: number; overflow: boolean }[] {
  const out: { item: T; side: LateralSide; slot: number; overflow: boolean }[] = [];
  items.forEach((item, i) => {
    const side: LateralSide = i < perSide ? "right" : "left";
    const slot = side === "right" ? i : i - perSide;
    out.push({ item, side, slot, overflow: slot >= perSide });
  });
  return out;
}

// ── Grouping ─────────────────────────────────────────────────────────────

/** A page's references sorted into the four kinds, in reading order. */
export interface DirectionGroups<T> {
  up: T[];
  lateral: T[];
  down: T[];
  here: T[];
  inline: T[];
}

export function groupByDirection<T extends { region: Region; locus: Locus }>(
  links: readonly T[],
): DirectionGroups<T> {
  const groups: DirectionGroups<T> = { up: [], lateral: [], down: [], here: [], inline: [] };
  for (const l of links) groups[directionOf(l)].push(l);
  return groups;
}
