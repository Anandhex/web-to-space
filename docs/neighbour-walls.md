# Neighbour walls — spec and build plan

> **Extends `docs/directional-links.md`; replaces nothing in it.** Strips stay
> the default and stay the fallback. This adds a third state between "a plate
> naming where you could go" and "you went there": for the few strongest links
> on each axis, the destination is drawn **as itself** — a wall of its own,
> receding, at reading fidelity near and as a nameplate far.
>
> Proposed by the supervisor, 2026-08-28. Every number below was measured on
> this codebase on that date; nothing here is asserted from intuition.

---

# Part I — The brief

*Self-contained: a session with no prior context can act on this alone.*

## The rule, made exact

1. **Every axis keeps its strips.** Expansion is additive. No link that is a
   strip today stops being one, and the overflow mark keeps counting.
2. Per axis, at most **two lanes** expand.
3. Each lane runs **three deep**: lane depth *d* holds the document that the
   lane's depth *d−1* document is most connected to.
4. **Size falls with depth**, σ = 0.62 per step (0.62 → 0.38 → 0.24).
5. All four axes get lanes — lateral, up and down alike.
6. Opening a section re-scopes the whole thing to that section (Part I,
   *Sections*).

## In the run, not around it

This was decided four times, and only the last one is right.

- **A fan** — wings hinged off the board's edges, each level swung further
  round — puts the up wing at **+35.9°** of elevation by depth 3.
- **A corridor** — each level turned 50° away, receding — keeps every angle
  legal and is unreadable, because a surface turned 50° away is read edge-on.
- **A dome** — every wing on a cylinder centred on the reader, facing them —
  reads perfectly and measures 0.0° off-axis on every wing.
- **A ring** around the board's perimeter — the dome, with the corners filled.

Each of those was better than the one before it, and all four were wrong in the
same way. They made the neighbourhood a **second system**: a separate
arrangement of objects, parallel to the doors, in which the same destination
appeared twice — once as a plate in the strip run and once as a panel in the
ring. Two vocabularies for one thing.

**A neighbour is not a place beside the list. It is an entry in the list that
has earned more room.** So there is one run per side of the page — the doors in
rank order — and a door whose document has arrived is drawn as a *card* instead
of a plate: the destination's name, and its sections as colours. Everything
else stays a plate. That is what the brief said in the first place ("at most
two such views and other links will be as strip"); it took four geometries to
hear it.

What follows from that:

- **The run is the layout problem**, not the neighbourhood. `run-layout.ts`
  stacks items of mixed size along the page's edge, outward from the middle so
  the rank still reads from where the reader is already looking, scaled down
  when a long run would overrun the edge and spread out when a short one would
  not reach it. It is pure, and `npm run test:wings` checks it.
- **The closed board still has a neighbourhood.** Strips belong to a page the
  reader has opened; the neighbourhood belongs to the document. On the closed
  board the runs carry the cards alone.
- **Each column turns to face the reader.** A column two metres out to the
  side, drawn in the page's own plane, is read almost edge-on — its plates
  foreshorten to slivers and its cards to nothing. A column is already one
  plane, so turning it about its own axis costs nothing and is the difference
  between a door you can read and a door you can only tell is there. The runs
  therefore wrap the page rather than lying flat beside it, and the further out
  a column sits the more it turns.
- **A card appears in the direction its own link points, and its plate does
  not appear at all.** The ranker cannot decide the side: `links/neighbours.ts`
  splits its laterals right-first by SCORE, `links/slots.ts` splits the page's
  right-first by READING ORDER, so a link whose inline mark says `▸` could have
  its card open on the left — the one failure the directional legend exists to
  prevent. The PLATE has the final say, and the claim is worked out once across
  all four directions rather than per direction, because that is the only way
  to notice that a card ranked `left` belongs to a plate on the `right` — and
  the only way to be sure a destination is drawn exactly once. A neighbour with
  no plate on this page (one the reader travelled to, or one ranked from the
  document while no page is open) keeps the direction the ranker gave it, since
  nothing else has an opinion.
- **Cards to the middle, plates around them.** `stackRun` places item 0 at the
  centre and works outward, so the order of a run *is* the order of the column
  from the middle out. The run leads with its cards, which puts the
  neighbourhood where the reader is already looking and rings it with the rest
  of the page's doors. One exception, and it is the older rule: the way back
  keeps the centre where there is one — it is the single door a reader must be
  able to find without reading anything, and a card is a thing you read.
- **One column per depth.** The first column holds this page's own doors, with
  the neighbours among them drawn as cards — because a depth-1 neighbour *is*
  one of this page's links. Depth 2 and 3 are not: they are links on somebody
  else's page, reached through the card in front of them, so mixing them into
  this page's list would be a category error. They get their own columns beyond
  it, each narrower than the last (`COLUMN_SCALE` 1 / 0.82 / 0.68), which is
  the corridor's recession expressed in the only channel a column has.

## The three fidelities

The `subtends` row is not a curiosity, it is the LOD ladder. A surface 2.5°
tall cannot be a board however much we would like it to be.

| | at | worth | drawn as |
|---|---|---|---|
| **L0** | depth 1 | ~18° × 8° | the neighbour's **board**: section tiles with their own section tints, its title plate. Imposter cards only — **never** `LivePageGhost` (draw-call budget). |
| **L1** | depth 2 | ~11° × 5° | a **spine card**: title, page count, the section colour bars down one edge. One `<Surface>`, one `<Text>`, one instanced bar strip. |
| **L2** | depth 3 | ~7° × 3° | a **nameplate**. `STRIP_H` is 0.076 m ≈ 2.9° — so the deepest level degrades into exactly the strip vocabulary that already exists, standing on the dome instead of on the board's edge. Reuse `DoorPlate` verbatim. |

The label inside every tier holds an **angular floor**, and is not scaled with
its surface: recession is for distance, never for text (in-world legibility
rule, already settled).

## Re-normalisation

Stepping into a wing makes that wall the home board and rebuilds the
neighbourhood around it. This is the dice's existing rule (directional-links,
*Decisions taken* item 3) applied one level up, and it is what keeps depth 3
honest: it is **foresight**, not a reading surface. Nobody is asked to read a
2.5° plate — they are told there is something that way, and one move makes it
full size.

## Which links get a lane

A lane is spent on the destination the current document is **most connected
to**. Measured over the 11-document corpus, the naïve reading of that — count
the repeats — ranks the *citation apparatus* first: `doi ×64`, `PMID ×27`,
`ISBN ×16`, `OCLC ×19` on Wikipedia, `Semantics ×221` on the HTML spec. The
score therefore runs over `region: "field"`, non-`citation`, `locus:
"same-site"` candidates only, and is:

```
score(t) = w₁·occurrences(t)          // how often this document points at t
         + w₂·pagesLinkingFrom(t)     // over how many distinct rendered pages
         + w₃·prominence(t)           // earliest pageIndex / reading order
         + w₄·reciprocal(t)           // t links back — the "and from" half
```

Three things about it, all measured:

- **`occurrences` alone is not enough.** After the citation filter, MDN's
  WebXR page has **76 candidates all tied at 1**; NN/g has a 6-way tie at 2.
  `pagesLinkingFrom` and `prominence` break most of those; where they do not,
  the ranking degrades to reading order — "what the document's opening says it
  is about" — which is defensible but must be **stated in the thesis, not
  hidden**.
- **`reciprocal` is the only honest inbound signal available.** True inbound
  links need a crawl or an index and cannot be had in a browser. Reciprocity —
  does the destination link back? — is a fair proxy and it is **free**, because
  the document has to be fetched to be drawn anyway.
- **The up axis will usually be empty.** `ascent` is p90 = 0, max 6 per page,
  because `prunePageChrome` deletes site nav before classification. The up
  wings will mostly be fed by **travelled** history instead — which is the best
  case, since those documents are already in the cache and cost no fetch.

## Sections

Opening a section on the board re-scopes the ranker to that section's
`SectionPageRange` and re-aims the wings at the section's own strongest links.
Closing it restores the document-scoped neighbourhood. This is a **widening**
of directional-links *Decisions taken* item 5 (corridors are per rendered
page): a wing is a heavier object than a strip and re-aiming it per page would
make the neighbourhood flicker as the reader turns pages. Per **section** is
the unit — stable enough to build spatial memory against, specific enough to
answer "what does this part of the document connect to".

Deck follows the same rule with tables in place of boards.

---

# Part II — Evidence

Measured 2026-08-28 over `src/eval/link-corpus` (11 documents, 1234 rendered
pages), via the same offline path `npm run census` takes.

## Cost of one neighbour

Full `parsePageToIR → mapIRToScene → computeLayoutPlan`, Node + jsdom:

| document | size | pages | parse | layout | total |
|---|---|---|---|---|---|
| Wikipedia *Spatial navigation* | 105 KB | 3 | 59 ms | 1 ms | **60 ms** |
| MDN *WebXR Device API* | 163 KB | 16 | 101 ms | 6 ms | **109 ms** |
| Wikipedia *Hypertext* | 322 KB | 41 | 254 ms | 7 ms | **263 ms** |
| Wikipedia *Virtual reality* | 849 KB | 107 | 533 ms | 22 ms | **559 ms** |
| WAI-ARIA 1.2 | 1.4 MB | 750 | 2535 ms | 227 ms | **2813 ms** |

Parse dominates layout by 10–20×, and parse is DOM work on the main thread.
A naïve 24-document neighbourhood (2 lanes × 3 deep × 4 axes) is **5–60 s** of
main-thread work. That is not a slow feature, it is a dead XR session: one long
block or one throw inside a frame ends rendering permanently.

**This is what the LOD ladder is really for.** Only L0 needs a plan. L1 and L2
need a title, a page estimate and section headings — a `<title>` + heading
scrape, ~5–10 ms, no IR, no layout. So the real budget is **2 full pipelines
per axis at most (8 worst case), and 16 cheap scrapes**, not 24 pipelines.

## Ranking signal

`region: "field"`, non-citation, same-site. `×n/Np` = n occurrences over N
distinct rendered pages.

| document | candidates | top | tied at top | top 3 |
|---|---|---|---|---|
| Wikipedia *Hypertext* | 124 | 4 | 1 | Theodor H. Nelson ×4/2p · NLS ×3/3p · World Wide Web ×3/3p |
| Wikipedia *Vannevar Bush* | 286 | 4 | 2 | Office of Scientific R&D ×4/4p · Tufts ×4/4p · NDRC ×3/3p |
| Wikipedia *Virtual reality* | 271 | 3 | 5 | simulated ×3 · 3D HMD ×3 · haptic technology ×3 |
| HTML spec *links* | 27 | 221 | 1 | Semantics ×221/61p · Text level semantics ×56/36p · area ×51/33p |
| WAI-ARIA 1.2 | 36 | 17 | 1 | XML Schema Datatypes ×17/5p · Authoring Practices ×13/12p |
| MDN *WebXR* | 76 | 1 | **76** | — no signal — |
| NN/g *heuristics* | 62 | 2 | 6 | Kelley Gordon ×2 · Kate Moran ×2 · Feifei Liu ×2 |
| MDN *landmark roles* | 24 | 3 | 3 | role="banner" ×3 · role="complementary" ×3 |

Long documents rank well. Short reference pages tie completely. Both cases have
to be designed for, and the second one is why the ranker needs a stated
fallback rather than a silent one.

## What the numbers decide

1. Wings **recede at 50°**; they do not fan. (Up-gaze budget.)
2. Depth 1 is the only tier that gets a pipeline run. (Parse cost.)
3. Depth 3 is a `DoorPlate`. (2.5° of arc.)
4. The ranker filters citations **before** it counts. (`doi ×64`.)
5. A tie-broken-by-reading-order path is a *specified* behaviour, not a bug.
   (76-way tie.)

---

# Part III — Build plan

> **BUILT 2026-08-28.** Phases 1-8 are in the tree and all seven checks pass
> (`test:links`, `test:memory`, `test:slots`, `test:neighbours`, `test:wings`,
> `test:minimap`, `test:travel`) along with `npm run build`. What the build
> changed about the plan is recorded in Part IIIa; what it did not reach is in
> Part V. Module map:
>
> | piece | file |
> |---|---|
> | link weight | `src/links/collect.ts` (`occurrences`, `pageSpread`) |
> | the ranker | `src/links/neighbours.ts` |
> | the cheap read | `src/links/scan.ts` |
> | the store | `src/renderer/scene/use-neighbourhood.ts` |
> | wall + deck geometry | `src/renderer/page-placements.ts` (`computeWingLadder`, `computeDeckWing`) |
> | the drawing | `src/renderer/scene/neighbour-walls.tsx` |
> | wiring | `wall-field.tsx`, `deck-field.tsx` |
> | gates | `src/links/__tests__/neighbours.ts`, `src/renderer/scene/__tests__/wings.ts` |

Phases are ordered so each one is verifiable alone. Gates are the project's
existing idiom: an offline `tsx` harness, no browser.

### Phase 1 — recover link weight

`src/links/collect.ts` dedupes repeat destinations, which throws away the
signal the ranker needs. Add to `SpatialLink`:

```ts
/** How many times this document points at this destination. */
occurrences: number;
/** How many distinct rendered pages it is linked from. */
pageSpread: number;
```

Both are computed on the full (undeduped) pass and stamped onto the survivor,
so `dedupe: true` callers are unaffected in count and gain the weights.

**Gate:** `npm run test:links` unchanged; `npm run census` reproduces the
Part II ranking table.

### Phase 2 — the ranker

New pure module `src/links/neighbours.ts`, sibling to `slots.ts`, no three.js:

```ts
export interface Neighbour { url: string; label: string; axis: Axis;
  depth: number; score: number; why: "weight" | "spread" | "order" | "travelled"; }

export function rankNeighbours(opts: {
  links: readonly SpatialLink[];   // document- or section-scoped
  nav: NavState | null;            // travelled nodes seed their own axis
  lanesPerAxis: number;            // 2
}): Record<Axis, Neighbour[]>;
```

`why` is carried deliberately: when the score degrades to reading order the
renderer can say so, and the thesis can report how often that happens.

**Gate:** new `npm run test:neighbours` over the corpus asserting (a) no
citation host ever wins a lane, (b) the tie fallback is `why: "order"` and
never silently arbitrary, (c) determinism across two runs.

### Phase 3 — the neighbourhood store

The one genuinely new layer: nothing in this architecture has ever held more
than one document. Lives beside the tab in `src/components/`, exposed through a
`NeighbourhoodContext` in `scene/contexts.tsx`.

- Keyed by URL. Holds `{ html, plan, headings, title, state }` per neighbour.
- **Tiered fetch:** L0 candidates get `fetchHtml` → full pipeline. L1/L2 get
  `fetchHtml` → `<title>` + `h1..h3` scrape only, never a pipeline.
- **Budget:** ≤ 2 full pipelines in flight, ≤ 6 scrapes; a document over
  ~500 KB is demoted from L0 to L1 rather than parsed (the ARIA spec at 2.8 s
  must never be parsed for a wing).
- **Cache:** per tab, LRU ~24 entries. Travelled URLs are pinned — the up/down
  wings are mostly history, and a revisit must cost no network.
- **Cancellation:** every fetch and every parse is abandoned on document change.
  A wing arriving for a document the reader has left must not mount.
- Runs entirely in effects. **Nothing here is ever touched from `useFrame`.**

`api/proxy.ts` is a Vercel edge function with a 1-hour cache, so this works in
production as well as dev — CLAUDE.md's "CORS proxy is dev-only" describes the
Vite middleware only and should be amended.

**Gate:** a Node harness driving the store against the corpus with a stubbed
fetch: assert the budget is never exceeded, the ARIA spec is demoted, and a
document change cancels everything in flight.

### Phase 4 — wing geometry

Pure, in `src/renderer/page-placements.ts`, beside `computeWallBoard`:

```ts
export function computeWingLadder(
  board: WallBoard, panel: { width: number; height: number },
  axis: Axis, lane: 0 | 1, depth: 1 | 2 | 3,
): { position: Vec3; rotation: Vec3; scale: number; tier: "L0" | "L1" | "L2" };
```

Constants: `WING_SPLAY_DEG = 50`, `WING_SHRINK = 0.62`, `WING_DEPTH_MAX = 3`.
Lane 1 is offset along the hinge from lane 0 by one wing height (lateral) or
one wing width (vertical), so two lanes per axis never overlap.

**Gate:** new `npm run test:wings` asserting the Part I budget table over board
sizes 3×1 … 11×3 — `|yaw_edge| ≤ 45°`, `elev_edge ∈ [−35°, +25°]`, depth-1
subtends ≥ 20° wide, depth-3 height ≥ 2.4° (the strip floor) — plus no AABB
overlap between any wing and the board or the in-world chrome column.

### Phase 5 — the wall wings

`src/renderer/scene/neighbour-walls.tsx`. Renders `computeWingLadder` output
around the existing `<WallLinkStrips>`, which stays exactly as it is.

- L0 mounts the neighbour's plan through the existing imposter path in
  `page-cells.tsx` under its **own** `CurrentPageContext` / `PageRangeContext`
  providers — a second document's contexts must not leak into the home board's.
- A lane with no neighbour resolved yet draws **its strip**, unchanged. The
  wing replaces the strip only once its document has arrived, so a slow network
  degrades to today's behaviour rather than to a hole.
- Gaze binding: pointing at a wing lights the anchor it came from, exactly as a
  strip does. Same `LinkBindingContext`, same key.

**Gate:** screenshot in the flat preview (`NO_SSL=1`) with a corpus document,
plus console/draw-call check — the wall's draw calls must not more than double.

### Phase 6 — section re-scope

Wire the board's `openSection` into the ranker's scope, and ease the wings from
the document neighbourhood to the section neighbourhood over the same duration
the board reflows in. Closing restores.

**Gate:** section-scoped ranking is deterministic and non-empty on the corpus
documents that have sections with outbound links; wings re-aim without a
remount (the panel id is always `"main"` — reset on the **plan**, not on a
focus change).

### Phase 7 — the deck

Same store, same ranker, same ladder — table geometry instead of board.
`computeDeckLayout` is already table-local inside one pitched group, so a
neighbour is another group hinged at the table's far / near / side edge, pitched
and shrunk by the identical schedule. North (up) sits beyond the far edge, south
(down) near the reader, east/west off the sides — where `DeckLinkPaths` already
puts its plates, so the paths lead **to** the wings.

**Gate:** the same `test:wings` budgets, run against the deck's frame.

### Phase 8 — travel and re-normalisation

Selecting a wing runs the existing leave/cross/arrive transition to that wing's
**actual pose** — which is the first time the transition has had a real
destination to land on instead of a placeholder. On arrival, re-normalise: the
wing becomes the home board, the neighbourhood is rebuilt, the cache keeps the
document you came from pinned.

**Gate:** `npm run test:travel` extended with a wing pose.

### Phase 9 — XR safety and perf

- No neighbour work of any kind inside a frame. One uncaught throw in an XR
  frame ends rendering permanently.
- Every wing render tolerates a missing, partial or failed neighbour by falling
  back to the strip. No error boundary can save an in-frame throw, so the
  fallback has to be structural.
- Weld the wings' static geometry the way the rooms view welds its buildings;
  budget one `<Surface>` + one `<Text>` per L1/L2 wing.

**Gate:** headset run over adb with the frame probe; no dropped frames on
arrival, and the draw-call count reported before/after.

---

# Part IIIa — What the build changed

Six things the plan had wrong or had not thought about. Each was found by a
measurement, and each is now a check that will catch it again.

1. **`ascent` was being filtered out with the citations.** The first cut of the
   ranker kept `region: "field"` only, which drops `footing` — and every parent
   link in the corpus is `ascent`. "No citation may win a lane" had quietly
   become "no parent may either", and the up axis had no source but travelled
   history. The filter is now `field` **or** `ascent`, never `footing`.
2. **Off-site has to be earned.** The region filter alone still let
   `web.archive.org` win a down lane on three corpus documents and "Share on
   LinkedIn" on a fourth — cited once, from one page, at the bottom. The down
   axis now requires a weight signal (`occurrences > 1` or `pageSpread > 1`)
   where the lateral axis accepts reading order. Asymmetric on purpose: off-site
   is where the apparatus lives.
3. **The deepest wing stopped being a strip.** Shrunk three times it measured
   2.3° tall against `STRIP_H`'s 2.9° — smaller than the plate it degrades
   into. L2 now stops shrinking across the corridor, the way a strip's height
   is a constant rather than a share of the run.
4. **The deck needed a splay after all.** The plan said it would not, because a
   raked table already recedes. True for its north corridor; false for its
   lateral ones, which ran straight out to **65°** at depth 2 and **69°** at
   depth 3 — the wall's fan fault, in a different frame. Deck laterals now
   advance up-slope as well as sideways (68°), and the bearing plateaus at
   27.5° → 26.0°.
5. **The deck's south corridor is one table deep.** Down-slope on a raked table
   is down and *towards the reader*: depth 3 lands 1.07 m into their lap, and no
   splay fixes it, because the only direction that recedes is the one north
   already took. `DECK_SOUTH_MAX_DEPTH = 1`; the rest of that direction stays
   path plates. The wall carries all three of its downward levels, because a
   wall has a floor to hang them over.
6. **The corridor had to be replaced by a dome.** The first build turned every
   lane 50° away from the reader. It passed every angular budget it was given —
   and it was unreadable, because those budgets never asked the one question
   that mattered: *is the surface facing anybody?* Seeing it rendered settled
   it in a second. The placement model is now a dome centred on the reader,
   the ladder is fitted to angular bands rather than scaled off the board, and
   `test:wings` checks facing and non-overlap alongside the angles. **The
   lesson is about the gate, not the geometry:** a budget made only of comfort
   limits will happily certify a design that cannot be read.
7. **The vertical axes were sized three times.** Off their own elevation band
   they came out as slivers; widened into banners they read but no longer
   matched the lateral wings; the answer that satisfies both is to stop
   spending elevation on depth and fan the levels across instead. Worth
   recording as a shape of problem rather than a bug: when one axis of a layout
   is scarce, the fix is usually to move the job onto the axis that is not.
8. **The top and bottom wings vanished on a square board, and the real board
   is square.** Every board in `test:wings` was WIDE, so its lateral wings were
   short enough to fit above it. The link-test page's actual board is 1.42 ×
   1.16 m: its lateral wings are 14.7° tall, its top edge is already 16.7° up,
   and 16.7 + 14.7 is past the 30° cap — so `computeWingLadder` returned null
   and the axis simply disappeared. A vertical wing now keeps its lateral
   twin's WIDTH and has its HEIGHT clamped to the elevation actually left above
   the board: identical on a wide board, shorter on a square one, never absent.
   Two near-square boards were added to the gate.
9. **Every "right" wing was standing on the left.** The board sits at −z, so
   the base yaw is about π, and sin(π + θ) = −sin θ: an azimuth offset added
   the obvious way mirrors the whole arrangement. Every angular check passed
   throughout, because they all look at |yaw| — and a door on the wrong side is
   precisely what the directional legend exists to prevent, since its anchor's
   `▸` then points across the room at somebody else's door. There is now a
   handedness check.
10. **The strips ring the opened page, not the board — and the wings start
    outside the strips.** With a page open, that page is lifted
    `WALL_OPEN_LIFT` toward the reader: 1.386 m wide at about 1.2 m, it
    subtends ~60° against the whole board's ~64°, so strips hung on the
    board's edge were behind the very page whose links they are. They now ring
    the page **in the page's own plane**, which settles it by construction — a
    plate outside the page's silhouette, at the page's depth, cannot be behind
    it at any viewing distance. (An earlier attempt moved the *rectangle* to
    the page and left the *plane* on the board, which is why its plates came
    out half hidden; the plane was the missing half.) That ring then reaches
    ~43° of yaw where the board reaches ~32°, so `computeWingLadder` takes a
    `clear` angle and the wings begin outside it rather than being drawn
    through the doors they complement.
11. **The opened page is the centre of the composition.** It used to render in
    whichever grid block the packing gave it, which put the thing being read
    off to one side while the board's centre — the reader's own forward axis —
    held tiles. The block is still reserved and the board still reflows around
    it, so unopened sections keep their places; the PAGE is drawn on the
    reader's axis, and it takes the arc's yaw there (zero) rather than the yaw
    of a cell it no longer occupies. The strips then ring the centre and the
    wings spread from it.
12. **A narrow band carries fewer, bigger wings.** With a page open, the page
    and its strips take ~43° of the reader's field against the board's ~32°,
    so the wings' band falls from 24° to 13°. Split three ways that made the
    NEAREST neighbour 6.6° wide — narrower than a door plate — to leave room
    for a third at 2.9°, which is the trade backwards: the nearest neighbour is
    the one most likely to be taken and the only one that can carry a board's
    worth of detail. `wingLevels` now drops to two levels under 30° of band and
    one under 18°, so depth 1 is never shortened to make room for depth 3.
13. **A ring, but every axis keeps its own quadrant.** The wings were laid out
    as four separate arms with empty corners, which is not what a ring around a
    board looks like. They are now placed by position on the board's perimeter:
    within its side a lane spreads ACROSS and depth walks OUTWARD, so the top
    carries a row of wings with a second and third row beyond it and the sides
    carry a column with further columns outside it. The corners fill from both
    directions.

    An intermediate cut let a deep vertical lane *drift* toward the horizontal
    to find room, which filled the corners beautifully and broke the legend: an
    `up` door ended up where a `lateral` one belongs. **No wing crosses into a
    neighbouring quadrant.** Parent above, siblings left and right, externals
    below — that is the one thing the reader is asked to learn, and the ring is
    only worth having if it holds.
14. **The strips are a block with the page, not a queue beside it.** They were
    laid out at a fixed pitch fanning from the centre, which is right about
    RANK — the way back and the nearest sibling land where the reader is
    already looking — and wrong about the composition: a short run floated in
    the middle of a tall panel and a long one ran off its end. The positions
    are now an even ladder across the panel's whole edge, top to bottom, and
    the items are dealt into them from the middle outward. Slot 0 still lands
    at the centre; the run still reaches both ends; the plate shrinks only when
    a long run would otherwise overlap, and never grows past its authored size.
15. **A sign error that only the vertical axes could show.** Aiming a wing at
   the reader under YXZ needs `rotation.x = +pitch`; negated, it looks right on
   the lateral axes, where pitch is near zero, and turns the up and down wings
   through twice their own elevation — 50° off-axis at depth 3. Caught by the
   facing check, which is exactly the kind of thing it exists for.
16. **Three things about the store that only showed up running.**
   · Neighbour work starting on mount competed with the reader's own document,
   so the whole walk now waits on `requestIdleCallback` and yields again before
   every parse. · `PageLinksApi` is rebuilt whenever a view publishes which hand
   its lateral doors took, so depending on the links array re-walked every
   corridor on the wall's first render — a loop with a network call in it; the
   links are read through a ref instead. · Three lanes reaching one document at
   once fetched it three times before any response landed to fill the cache (one
   dead link produced five 404s), so loads are coalesced and failures cached.

# Part IV — Decisions the supervisor needs to make

Answered provisionally in the build, each the cheapest option that keeps the
claim honest. All three are still the supervisor's to overturn.

1. **"Most connected" or "most visited"?** — **BUILT AS STRUCTURAL.** A section
   scopes the same score to its page range; nothing logs visits across sessions
   and nothing new stores them. Keeps the thesis claim structural rather than
   behavioural. Overturning it means a persisted per-URL counter and a
   different claim.
2. **Is reciprocity enough for "and from"?** — **BUILT AS RECIPROCITY-ONLY**,
   and the scaffolding is there (`rankNeighbours` takes a `reciprocal` set)
   though nothing fills it yet, because filling it needs the depth-1 documents
   to have arrived before the depth-1 ranking is done — a second pass. True
   inbound needs a crawl or an index, and would only hold over a fixed corpus.
3. **Two lanes, or one?** — **BUILT AS TWO, DEMOTING TO ONE** where a second
   costs angle: the wall's vertical axes on a board wider than ~2.4 panel
   widths, and the deck's north and south always. Lateral lanes stack along
   their hinge and cost nothing, so they are always two.

# Part V — What is not done, and risks

**Not done.**

- **Reciprocity is wired but unfilled** (Part IV item 2). Every wing today is
  chosen on outbound evidence alone.
- **The deck got the correction, but not the full dome.** Its wings are now
  stood UP out of the table plane and yawed toward the reader, so they are no
  longer read at the table's own rake. The yaw uses an approximated reader
  distance (`DECK_READER_REACH`) rather than the true pose, because expressing
  an exact aim inside the table's tilted group needs a matrix the pure
  placement module does not have. Good to within a few degrees; not the
  wall's measured 0.0°.
- **The deck's wings are verified numerically, not visually.** `test:wings`
  covers them and the south wing was seen rendering, but the lateral and north
  wings sit up-slope, where the deck's own stage panel may stand between them
  and a reader at the default pose. It needs a headset or a moved camera, and
  it is the first thing to check before anyone demonstrates the deck.
- **No headset run.** Everything below was verified in the flat preview
  (`NO_SSL=1`). Phase 9's frame-probe run over adb has not happened.
- **`npm run census` has not been re-run** since `occurrences`/`pageSpread`
  were added. The numbers in Part II stand, but the census output does not yet
  report the new columns.

**A consequence worth knowing.** The "off-site must be earned" rule (Part IIIa
item 2) means a document whose external links are all one-offs gets **no down
wings at all**. `public/link-test/index.html` is the extreme case — it is a
catalogue of href shapes, so all eleven of its off-site links occur exactly
once on one page, and its down axis is empty. Long documents fill it normally
(`HTTP(S) scheme`, `Document Object Model`). This is the rule working, not
failing, but it is a visible asymmetry between the axes and it should be a
deliberate choice rather than a surprise.

**Risks.**

- **Prior art.** 3D hyperlink-neighbourhood visualisation is heavily worked
  ground (`docs/novelty-audit.md`). What is defensible here is not "links in
  3D" but that the neighbours are *rendered documents at reading fidelity
  through the same semantic pipeline*, not abstract graph nodes. The claim has
  to be written that way from the start.
- **Empty neighbourhoods.** Per rendered page the median outbound count is 0.
  Document- and section-scoping is what makes the feature non-empty; if it were
  ever scoped per page it would be blank most of the time.
- **Network variance.** A wing that takes 3 s to arrive is a strip for 3 s.
  Acceptable, but it means the study cannot claim the neighbourhood is *always*
  visible, only that it resolves.
