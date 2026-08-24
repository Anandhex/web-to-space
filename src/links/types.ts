/**
 * links/types.ts — the vocabulary of the reference neighbourhood.
 *
 * The model (docs/reference-neighbourhood.md §13A) is five things, four of
 * them spatial and none of them requiring a legend:
 *
 *   page        actions on the thing in front of you — never given a position
 *   footing     citations and provenance, close under the page
 *   field       destinations that lead away; RADIUS is navigational cost
 *   ascent      site navigation, the level above, expensive on purpose
 *   arrangement same-document references — no body at all; they light up the
 *               storey / tile / card / room the current view already draws
 *
 * These types are the contract every later phase writes against, and they are
 * deliberately renderer-free: `classify.ts` and `collect.ts` run in Node under
 * the offline census with no browser and no three.js.
 */
import type { Vec3 } from "../mapper/types";

/**
 * Which of the five the reference belongs to. Exactly one, always — a link the
 * classifier cannot place still lands in `field`, because the neighbourhood
 * has the same no-nodes-dropped invariant the rest of the pipeline does.
 */
export type Region = "page" | "footing" | "field" | "ascent" | "arrangement";

/**
 * How far the destination is to reach — the only thing radius is allowed to
 * encode (§13C rule 1). `same-document` and `operational` are the two loci
 * that have no distance at all, because their regions have no radius.
 */
export type Locus =
  | "same-document"
  | "same-site"
  | "off-site"
  | "operational"
  | "unknown";

/**
 * One reference, classified and bound to the place on the page it came from.
 *
 * Positions are NOT here: this is the semantic layer, and where a body goes is
 * `views/neighbourhood.ts`'s job. The split is the same one the codebase
 * already draws between the mapper (facts) and the layout engine (placement).
 */
export interface SpatialLink {
  /** The primitive that carried the anchor — stable across a re-render. */
  id: string;
  href: string;
  region: Region;
  locus: Locus;
  /** Synthesised display name; see identity.ts. Never empty. */
  label: string;
  /** Host of the resolved destination, or null for fragments and actions. */
  host: string | null;
  /** Fully-resolved absolute URL when one could be formed, else the raw href. */
  resolved: string;

  /**
   * True when the anchor's own text was too weak to identify the destination
   * ("read more", "here", a bare URL) and `label` had to be synthesised from
   * somewhere else. The census reports the rate; the renderer can mark it.
   */
  synthesised: boolean;
  /**
   * The census's degeneracy test, which is broader than `synthesised` (it
   * counts every anchor of two words or fewer). Kept separate so the metric
   * reported in the thesis is not quietly redefined by a rendering decision.
   */
  degenerate: boolean;

  /**
   * A `#cite`-style fragment, or an anchor that reads as a citation marker
   * ("[13]", "^", "a b c"). Set independently of `region`: a Wikipedia
   * superscript is BOTH a citation and a same-document reference, and rule 5
   * says the same-document part wins for placement.
   */
  citation: boolean;

  // ── Binding to the page (§7 mechanism C: spatial alignment) ──────────────
  /**
   * The page of the paginated content panel this anchor sits on.
   * −1 when the link is outside the panel (a top-level nav bar, a footer).
   */
  pageIndex: number;
  /**
   * The nearest ancestor the layout engine actually placed — in practice the
   * containing paragraph or list item. An inline link has no entry of its own.
   */
  anchorId: string | null;
  /**
   * That ancestor's panel-absolute position. v1 resolves alignment to
   * PARAGRAPH granularity, not line: line boxes would need troika's internals
   * and are not worth it yet. This is the stated limitation of the mechanism.
   */
  anchorPos: Vec3 | null;
  /** Reading order among all the references on the page — the tie-break. */
  order: number;
  /**
   * Another reference shares this anchor's block. Alignment alone cannot then
   * say which sentence points where, which is what highlighting is for (§7).
   */
  sameBlock: boolean;
  /** The text of the block the reference came from, for L3. Trimmed. */
  sourceText: string | null;

  // ── arrangement only ────────────────────────────────────────────────────
  /** The primitive the fragment resolves to, when it exists in this document. */
  targetId?: string;
  /** The page that primitive is on — the tile/storey/card to light up. */
  targetPage?: number;
}
