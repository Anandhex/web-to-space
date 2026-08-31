/**
 * links/neighbours.ts — which destinations are worth drawing as themselves.
 *
 * `slots.ts` answers "what goes in each direction" for STRIPS, where the cost
 * of being wrong is a plate the reader ignores. This answers the same question
 * for WINGS — a neighbouring document drawn as its own wall — where the cost
 * of being wrong is a fetch, a parse and a surface occupying 28° of the
 * reader's view (docs/neighbour-walls.md, Part I).
 *
 * Pure: no three.js, no React, no metres, no network. A view turns a ranked
 * candidate into geometry; the store turns it into a document; this only ever
 * decides which one deserves either.
 *
 * ── The one thing the measurement changed ──
 *
 * The obvious score is "count the repeats", and over the corpus it ranks the
 * CITATION APPARATUS first: doi ×64, PMID ×27, ISBN ×16, OCLC ×19 on
 * Wikipedia, `Semantics` ×221 on the HTML spec. Those are `footing` — the
 * region citations and provenance already have — so the filter is a region
 * test rather than a host blocklist, and it holds on the down axis (where
 * off-site is the whole point and a blocklist would have to guess) as well as
 * on the lateral one.
 *
 * ── The tie ──
 *
 * On long documents the weights discriminate cleanly. On short reference pages
 * they do not: MDN's WebXR page has 76 candidates all tied at one occurrence.
 * That is not a failure mode to be hidden — the ranking degrades to reading
 * order, "what the document's opening says it is about", and every candidate
 * carries `why` so the renderer can say which rule chose it and the thesis can
 * report how often each one did.
 */
import { directionOf, assignLateralSides } from "./direction";
import { AXES, visible, type Axis, type NavState, type WindowBudget } from "./memory";
import type { SpatialLink } from "./types";

/** Which rule actually chose this candidate. Reported, not just used. */
export type NeighbourWhy =
  /** The document points at it more often than at anything else. */
  | "weight"
  /** Occurrences tied; it is linked from more distinct pages. */
  | "spread"
  /** Everything tied; it is the earliest in reading order. */
  | "order"
  /** The reader has already been there — it costs no fetch. */
  | "travelled"
  /**
   * Chosen from a cheap `links/scan.ts` read rather than from the classifier.
   * Depth 2 and 3 are nameplates; parsing a whole document to pick the next
   * one would cost more than the plate is worth. Carried so the weaker
   * evidence is visible rather than implied.
   */
  | "scan";

export interface Neighbour {
  /** Resolved, fragment stripped: the document identity the store fetches. */
  url: string;
  label: string;
  axis: Axis;
  /** 0 = the lane nearest the board's centre line. */
  lane: number;
  score: number;
  why: NeighbourWhy;
  /** The anchor this came from, so a wing lights with its inline mark. */
  linkId: string | null;
  /** `travelled` only: where a selection jumps to. */
  historyIndex?: number;
  occurrences: number;
  pageSpread: number;
}

export type NeighbourLanes = Record<Axis, Neighbour[]>;

/**
 * Score weights.
 *
 * Ordered so that no amount of one term can overturn the term above it inside
 * the ranges the census reports: occurrences reach 221, spread 61, and
 * prominence is normalised to [0,1]. Reciprocity is deliberately the smallest
 * — it is a tie-break between destinations the document already leans on
 * equally, not a reason to prefer a page the document barely mentions.
 */
const W_OCCURRENCE = 100;
const W_SPREAD = 10;
const W_RECIPROCAL = 4;
const W_PROMINENCE = 1;

/** A destination's identity: the URL without its fragment. */
export function neighbourKey(url: string): string {
  const hash = url.indexOf("#");
  return hash === -1 ? url : url.slice(0, hash);
}

/**
 * Candidates a wing may be spent on.
 *
 * `field` only — that is what drops the citation apparatus, and with it the
 * `footing` region entirely. `arrangement` and `page` have no document to
 * fetch: a fragment is already drawn by this view and an operational link
 * hands off to another application.
 */
function eligible(l: SpatialLink): boolean {
  // `field` and `ascent`, never `footing`.
  //
  // The region test is doing one job — dropping the citation apparatus, which
  // is what `footing` IS — and it must not take the ascent with it. An earlier
  // cut filtered to `field` alone and the up axis then had no source at all
  // except travelled history: every parent link in the corpus is `ascent`, so
  // "no citation may win a lane" had quietly become "no parent may either".
  if (l.region !== "field" && l.region !== "ascent") return false;
  if (l.citation) return false;
  const d = directionOf(l);
  if (d !== "up" && d !== "lateral" && d !== "down") return false;
  // ── Off-site has to be EARNED ──
  //
  // The `field`-only filter drops the identifier apparatus (doi, PMID, ISBN
  // are `footing`), but it does not drop a reference-list entry whose href is
  // an ordinary archived page: `web.archive.org` won a down lane on three
  // corpus documents, and a social share link won two more. What those all
  // have in common is that the document points at them EXACTLY ONCE, from one
  // page, at the bottom — they are cited, not connected.
  //
  // So the down axis requires a weight signal, where the lateral axis accepts
  // reading order. That asymmetry is the point: a same-site sibling is part of
  // the document's own neighbourhood whatever its position, and off-site is
  // where the apparatus lives, so a wing pointed out of the site has to be
  // paid for with more than a position.
  if (d === "down" && l.occurrences <= 1 && l.pageSpread <= 1) return false;
  return true;
}

interface RankOptions {
  /**
   * The scope's references, in reading order — the whole document, or one
   * section's page range. NOT one rendered page: a wing is a heavier object
   * than a strip and re-aiming it per page would make the neighbourhood
   * flicker as the reader turns pages (docs/neighbour-walls.md, Part I).
   */
  links: readonly SpatialLink[];
  /** The tab's navigation memory. Travelled documents cost no fetch. */
  nav: NavState | null;
  /** The strip window, so a reserved axis is reserved here too. */
  budget: WindowBudget;
  /** How many wings an axis may open. */
  lanesPerAxis: number;
  /** Destinations already known to link back, if any have been fetched. */
  reciprocal?: ReadonlySet<string>;
  /** Never offer these — the document itself, and anything already in a lane. */
  exclude?: ReadonlySet<string>;
}

/**
 * The lane heads: one ranked list per axis, nearest lane first.
 *
 * Deeper levels are NOT decided here. Depth 2 is whatever the depth-1 document
 * itself leans on, which cannot be known until that document has arrived, so
 * the store extends a lane by calling `continueLane` on it.
 */
export function rankNeighbours(opts: RankOptions): NeighbourLanes {
  const { links, nav, budget, lanesPerAxis, reciprocal, exclude } = opts;
  const out: NeighbourLanes = { up: [], down: [], left: [], right: [] };
  if (lanesPerAxis <= 0) return out;

  const taken = new Set<string>(exclude ?? []);

  // ── 1. Travelled documents first ──
  //
  // The same rule the strips run on: the way back comes first and its axis
  // takes nothing else. It is also the cheap case — a travelled URL is in the
  // store's cache, so these wings cost no network at all, which is what makes
  // the up axis viable on a corpus where ascent links are p90 = 0.
  if (nav) {
    const seen = visible(nav, budget);
    for (const axis of AXES) {
      for (const v of seen[axis]) {
        if (out[axis].length >= lanesPerAxis) break;
        const key = neighbourKey(v.node.url);
        if (taken.has(key)) continue;
        taken.add(key);
        out[axis].push({
          url: key,
          label: v.node.label,
          axis,
          lane: out[axis].length,
          score: Number.POSITIVE_INFINITY,
          why: "travelled",
          linkId: null,
          historyIndex: v.historyIndex,
          occurrences: 0,
          pageSpread: 0,
        });
      }
    }
  }

  // ── 2. This scope's own links ──
  const pool = links.filter(eligible);
  const maxOrder = pool.reduce((m, l) => Math.max(m, l.order), 1);

  const scored = new Map<string, { link: SpatialLink; score: number; why: NeighbourWhy }>();
  for (const l of pool) {
    const key = neighbourKey(l.resolved);
    if (taken.has(key) || scored.has(key)) continue;
    // Prominence: earliest in reading order scores highest, normalised so it
    // can never outweigh a single extra occurrence.
    const prominence = 1 - l.order / (maxOrder + 1);
    const score =
      W_OCCURRENCE * (l.occurrences - 1) +
      W_SPREAD * (l.pageSpread - 1) +
      W_RECIPROCAL * (reciprocal?.has(key) ? 1 : 0) +
      W_PROMINENCE * prominence;
    const why: NeighbourWhy =
      l.occurrences > 1 ? "weight" : l.pageSpread > 1 ? "spread" : "order";
    scored.set(key, { link: l, score, why });
  }

  // Deterministic to the last tie: score, then reading order, then URL. Two
  // runs over the same document must place the same wings in the same lanes or
  // the reader's spatial memory is being rewritten under them.
  const ranked = [...scored.entries()].sort(
    (a, b) =>
      b[1].score - a[1].score ||
      a[1].link.order - b[1].link.order ||
      (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0),
  );

  // Laterals fill right-first then left, exactly as the strips do, so a wing
  // and its inline mark cannot disagree about which hand the destination is on.
  const laterals: typeof ranked = [];
  for (const entry of ranked) {
    const [key, { link, score, why }] = entry;
    const dir = directionOf(link);
    if (dir === "lateral") {
      laterals.push(entry);
      continue;
    }
    const axis: Axis = dir === "up" ? "up" : "down";
    if (nav?.axes[axis].reserved) continue; // the way back takes nothing else
    if (out[axis].length >= lanesPerAxis) continue;
    taken.add(key);
    out[axis].push({
      url: key,
      label: link.label,
      axis,
      lane: out[axis].length,
      score,
      why,
      linkId: link.id,
      occurrences: link.occurrences,
      pageSpread: link.pageSpread,
    });
  }

  const sides = assignLateralSides(laterals, lanesPerAxis);
  for (const { item, side, slot, overflow } of sides) {
    if (overflow) continue;
    const axis: Axis = side === "right" ? "right" : "left";
    if (nav?.axes[axis].reserved) continue;
    if (out[axis].length >= lanesPerAxis) continue;
    const [key, { link, score, why }] = item;
    void slot;
    taken.add(key);
    out[axis].push({
      url: key,
      label: link.label,
      axis,
      lane: out[axis].length,
      score,
      why,
      linkId: link.id,
      occurrences: link.occurrences,
      pageSpread: link.pageSpread,
    });
  }

  return out;
}

/**
 * The next document down a lane: what THIS document leans on hardest.
 *
 * Called on a wing's own links once it has arrived, to extend the corridor to
 * depth 2 and 3. The axis is not re-derived — a corridor keeps going the way
 * it was going, and a lane that changed direction because the neighbour
 * happened to classify its own strongest link differently would be a corridor
 * that turns a corner the reader never took.
 *
 * `exclude` must carry every URL already standing in the corridor, this
 * document's own included. Wikipedia is full of A → B → A, and without it the
 * third wall down a lane is regularly the wall the reader is standing at.
 */
export function continueLane(opts: {
  links: readonly SpatialLink[];
  axis: Axis;
  lane: number;
  exclude: ReadonlySet<string>;
  reciprocal?: ReadonlySet<string>;
}): Neighbour | null {
  const { links, axis, lane, exclude, reciprocal } = opts;
  const ranked = rankNeighbours({
    links,
    nav: null,
    budget: { up: 0, down: 0, left: 0, right: 0 },
    lanesPerAxis: 1,
    reciprocal,
    exclude,
  });
  // Whichever direction the neighbour's own strongest link took, it continues
  // along the lane it is already in.
  const best = AXES.map((a) => ranked[a][0]).filter(Boolean) as Neighbour[];
  if (best.length === 0) return null;
  best.sort((a, b) => b.score - a.score);
  return { ...best[0], axis, lane };
}
