# Directional links — spec and build plan

> **Status note (2026-08-18): the elevator view has been removed.** It was not a
> fourth spatial concept — it was Rooms' "navigate the site as an environment"
> laid out vertically, a navigation configuration of the same idea rather than a
> new way of relating to the document, and keeping both weakened the distinction
> the remaining three carry. The three shipping views are **rooms**, **wall** and
> **deck**. Everything below about the elevator's ring corridor is kept as the
> design record of a view that was built and then dropped; the ring geometry, its
> shell and its fit-mode budget are gone from the code.

Replaces the abandoned "reference neighbourhood" design (stashed at
`stash@{0}`, message `abandoned: reference-neighbourhood link design`).

That design encoded navigational cost as **radius**, which a headset reader
cannot judge — bodies were scale-compensated so every one subtended the same
visual angle regardless of distance, so the channel carried nothing
perceivable. This design encodes relation as **direction**, read by head yaw
and pitch, and turns links from a display problem into a locomotion problem.

---

# Part I — The brief

*Self-contained: a session with no prior context can act on this alone.*

## The model

Every link on a rendered page is classified into one of five kinds. Four have
a **fixed direction**, identical in all four views, so the reader learns one
legend and it holds everywhere.

| kind | direction | what it is |
|---|---|---|
| **parent / top-level** | **up** | site navigation, breadcrumbs, footer nav |
| **sibling** | **lateral** (right, overflowing left) | another document on the same site |
| **same-page** | **no direction** — a pointer | a fragment resolving inside this document |
| **external** | **down** | another site |
| **operational** | **none** — stays at the anchor | `mailto:`, `tel:`, `javascript:`, downloads |

Two rules make the model work:

1. **Same-page links never open anything.** The target is already drawn by the
   current view — a tile on this board, a card on this table, a room in this
   building, a page of this panel. A same-page link lights that object up
   and moves the reader to it inside the current structure. Opening a corridor
   to it would draw the same content twice.
2. **No blue text anywhere.** Links are doors, stairs, strips and paths. The
   only thing left inline is a small directional mark (below).

Everything is scoped to the **current rendered page** of the paginated content
panel — not the whole document. A corridor belongs to the page the reader is
on; other pages' corridors are not live.

## Cross-cutting mechanisms

### Directional marks (inline)

Direction tells the reader the *kind* of a link; it cannot tell them *which*
link a given door came from. The census says alignment can't fix this either:
**49.8% of anchors share a block with another anchor**, so pointing a door at
its paragraph is ambiguous half the time.

So the anchor text keeps a mark — just not a chromatic one:

- `▴` parent · `▸` sibling · `▾` external · same-page gets a filled dot ·
  operational gets nothing
- **No colour, no underline — when there IS a mark.** The mark's orientation
  reinforces the same legend the geometry uses, and a second affordance on
  top of it would be redundant.
- On gaze or hover, the mark and its matching door/strip/path light together.
  That is the binding channel, and it is the only one.
- **A link with no mark gets a plain underline instead**, added 2026-09
  (`underlineTransform` in `src/renderer/primitives/inline.tsx`, drawn from
  each `useLinkRects` hit rect wherever the caller's own direction lookup
  came back empty). Two cases reach it: `linkMode: "plain"` in a study trial
  (`src/study/`, where `pageLinks` is null by design — the baseline
  condition has no direction system to test against) and an anchor the
  classifier never resolved a direction for. Without it, either case draws a
  link identically to body text — no colour, no mark, no way to tell it is
  clickable at all. Thin and muted (`theme.bodyCol` at partial opacity), not
  a return to coloured link text: a shape cue, not a chromatic one, so the
  marked system's own no-underline look is untouched.

### Navigation memory

Shared by all four views and **view-independent** — it must not know about
geometry.

- Each direction holds a **path, not a set**. Going east four times is a
  four-long east corridor.
- The **window** is how much of that path is rendered. The **history** is
  unbounded and lives in the minimap. These are different budgets and must be
  named differently.
- On arrival, the direction the reader **came from is reserved** as the return
  slot, and does not take a new link. Arriving eastward means west holds the
  way back; the other three directions keep their full budget.
- Every floor / face / table also carries an explicit **back door** to the
  place the reader came from.

| view | window |
|---|---|
| wall | 3 lateral each side, 2 up, 2 down |
| deck | 5 per direction (N/S/E/W) |
| rooms | 2 per direction |

A view that has narrowed to ONE rendered page ignores the window and shows
every link that page has (`fitBudget`) — there is nothing to ration, and the
census puts outbound links at a median of 0 and a p90 of 7 per rendered page.

### Minimap

A corner overlay in every view, reading navigation memory directly. Shows the
travelled graph; selecting a node moves the world to it — the dice rotates to
that face, the deck slides to that table, the building changes floor.

## Per-view specification

### Wall — a dice

- Links are **strips attached to the wall's edges**: top edge = parent,
  bottom = external, left and right = siblings.
- Selecting a strip **rotates the wall** so that face comes forward.
- **The rotation is a transition, not a coordinate frame.** After it lands,
  re-normalise: the current page is front, its parent is up. A cube's rotation
  group is non-commutative, so east-then-north does not leave the faces where
  north-then-east does — without re-normalisation the reader's spatial memory
  goes wrong exactly when they start trusting it. History lives in the
  minimap, which stays true.
- One strip on the arrival edge is reserved as the way back.

### Deck — connected tables

- Links are **paths leading off the table**: north = parent, east and west =
  siblings, south = external.
- Travelling a direction moves the world to that table; the reverse path is
  reserved, the other directions keep 5 slots.
- Minimap jumps move the world to that table.

### Rooms — a building

- Each rendered page opens a doorway in the gallery wall **beside** it, onto a
  **crossing**: the square where the whole legend is read in one look.
  - **Left and right** along the corridor's two arms to the siblings — a
    "right" link is a door on the reader's right as they step out of the room,
    on either wall of the building.
  - **Straight ahead** into the stair hall: the flight **up** to the parents
    and the flight **down** to the externals, side by side across its width,
    starting at the crossing rather than at the end of a walk.
- The arms run **along** the gallery wall, which every page on that wall
  shares, so only the page the reader is at has its corridor built out. Every
  other page keeps its doorway and the lit crossing behind it, so a reader
  walking the gallery still sees which pages lead somewhere.
- Each flight arrives on a landing that is **the whole stair hall at that
  storey**, its doors hung past the head of the flight — **flat and
  ungrouped**, see *Decisions taken*, item 2.
- A **back door on every floor**, so a reader three rooms deep can leave from
  where they are rather than walking back to the one corridor that carries the
  return.

## Decisions taken

1. **Same-page links are pointers, not doors** — settled.
2. **The parent corridor is flat.** The census shows one MDN page carrying
   **167** parent links on a single rendered page (`page 4: 171 outbound —
   4 field, 0 footing, 167 ascent`) because a nav sidebar is one landmark and
   pagination drops it whole onto one page. Grouping the corridor into
   side-rooms by nav sub-heading was proposed and **declined**. Build it flat;
   revisit only if it bites in practice.
3. **The dice re-normalises** after every move — settled.
4. **Memory is a path, window is a render budget** — settled.
5. **Corridors are per rendered page**, not per document section — settled.
6. **Operational links stay at the anchor** with no direction — settled.

## Deferred

- **`panelCurveRadius` is 1.2 m**, so a page's curve assumes the reader at its
  centre. Free movement breaks that assumption — a page in a room the reader
  can walk around is read from wherever they stand, not from one authored
  point. Flatten or re-curve per approach point.
- **Sibling overflow.** p90 is 5 per page but max is 50. Default until
  measured: fill right, overflow to left, then paginate the lateral run.

## Evidence

`npm run census:real` over 11 documents / 1192 rendered pages, output at
`eval-out/link-census-link-corpus.md` (gitignored, currently on disk):

| metric | median | p90 | p99 | max |
|---|---|---|---|---|
| outbound | 0 | 7 | 16 | 171 |
| field (sibling + external) | 0 | 5 | 12 | 50 |
| arrangement (same-page) | 0 | 1 | 8 | 41 |
| ascent (parent) | 0 | 0 | 3 | 167 |

Plus: **49.8%** of anchors share a block with another anchor; **63.2%** of
references are two words or fewer, though only **0.7%** need a name synthesised
by the stricter test `identity.ts` acts on.

---

# Part II — Build plan

## Phase 0 — recover the semantic layer

The abandoned design's *geometry* is dead. Its *semantic layer* was never
about that idea and is directly reusable.

```
git stash pop
```

**Keep:**

| file | why |
|---|---|
| `src/links/collect.ts` | walks the primitive tree, binds each anchor to its page and panel |
| `src/links/identity.ts` | door labels; 63% of anchors are two words or fewer |
| `src/links/classify.ts` | 92.2% accurate, with a gold set to score changes |
| `src/links/__tests__/gold-set.ts`, `sample-anchors.ts`, `gold-annotations.ts` | the scoring harness |
| `src/eval/link-census.ts`, `fetch-link-corpus.ts`, `link-corpus.urls` | sets the budgets |
| `.gitignore`, `package.json`, `src/eval/README.md` edits | census scripts and corpus ignore |

**Delete:**

- `src/links/views/neighbourhood.ts` — radius/azimuth placement
- `src/links/visual/neighbourhood-field.tsx`, `src/links/visual/body.tsx`
- `src/links/__tests__/neighbourhood.ts`, `wall-standing.ts`
- `docs/link-build-plan.md`, `docs/reference-neighbourhood.md`,
  `docs/spatial-links.md`, `docs/link-design-brief-v.html`
- the `ReferenceNeighbourhood` wiring in `src/renderer/scene/scene-graph.tsx`
- `WALL_PREVIEW_FOV` in `src/renderer/XRSceneRenderer.tsx`
- `NeighbourhoodPlacement` from `src/links/types.ts`
- the `test:geometry` / `test:wall` scripts in `package.json`

**Done when:** `npm run build` is clean and `npm run test:links` still scores
the classifier.

## Phase 1 — the direction model

New `src/links/direction.ts`. A pure re-projection of the existing classifier
onto the four axes — the classifier itself barely changes.

| region + locus | direction |
|---|---|
| `ascent` | `up` |
| `arrangement` | `here` (pointer) |
| `field` + `same-site` | `lateral` |
| `field` + `off-site` | `down` |
| `footing` | resolve by locus: same-document → `here`, same-site → `lateral`, off-site → `down` |
| `page`, `operational` | `inline` |

`footing` collapses entirely; the `citation` flag survives as a marker.

Extend `gold-set.ts` to score **direction** alongside region, so a
mis-projection is caught by a number rather than by eye.

**Done when:** `npm run test:links` reports per-direction accuracy on the gold
set with no regression in region accuracy.

## Phase 2 — navigation memory

New `src/links/memory.ts`. Pure, no three.js, testable under `tsx` in Node —
same discipline `classify.ts` already follows.

```ts
type Axis = "up" | "down" | "left" | "right";
interface NavNode { url: string; label: string; direction: Axis }
interface NavAxis { path: NavNode[]; cursor: number; reserved: boolean }
interface NavState {
  axes: Record<Axis, NavAxis>;
  history: NavNode[];        // unbounded — the minimap reads this
  arrivedFrom: Axis | null;  // this axis holds the way back
}
interface WindowBudget { up: number; down: number; left: number; right: number }
```

Operations: `enter(state, link)`, `back(state)`, `jump(state, historyIndex)`,
`visible(state, budget)`. The window clamps what `visible` returns; it never
truncates `history`.

**Critical:** following a link must inherit the reader's current view, device
profile and theme. The tab layer already does this via `activeTab.settings` in
`openInNewTab` — route door traversal through the same path, not around it.

**Done when:** a Node test covers reserve-on-arrival, path growth past the
window, back, and jump.

## Phase 3 — minimap

A view-agnostic corner overlay reading `NavState.history`. Renders the
travelled graph; selecting a node emits a jump the view animates.

Build it before the views: every view needs it, and building it once against
the memory model stops four bespoke versions appearing.

**Done when:** it renders in one view and jumps correctly with the wall stubbed.

## Phase 4 — inline directional marks

`src/renderer/primitives/inline.tsx` and
`src/renderer/primitives/meshes/inline-mesh.tsx` currently draw anchors as
coloured text. Replace with the mark scheme.

Two existing traps apply here:

- **Hit quads must follow the curve.** troika's `caretPositions` are flat; bend
  them through `curvePoint` or the mark's hit target drifts off the glyph.
- `link-preview.tsx` gates hover preview cards to rooms via
  `PREVIEW_VIEW_MODES`. The marks are not preview cards — decide whether
  preview survives at all now that doors carry the destination, and if it does,
  make sure the two don't both fire on gaze.

Add a gaze-binding context (follow the `ClipPlanesContext` /
`CurrentPageContext` pattern in `src/renderer/primitives/contexts.tsx`) so a
lit mark can light its door and vice versa.

**Done when:** anchors show no colour, marks read at the profile's legibility
floor, and gaze lights both ends of the pair.

## Phase 5 — wall

First, because it is the flattest geometry and therefore tests the *idea*
rather than a view's quirks. `src/renderer/scene/wall-field.tsx`.

Edge strips → face rotation → re-normalise → reserved back strip → minimap
wired to real memory.

## Phase 6 — deck

`src/renderer/scene/deck-field.tsx`. Paths off the table, world translation on
travel, reserved return path.

## Phase 7 — rooms

`src/renderer/scene/room-walk.tsx`, `room-decor.tsx`. Per-page corridor,
stairs up and down, flat parent corridor, back door. Locomotion already exists in `xr-locomotion.tsx` (thumbstick walk, snap
turn, gaze teleport).

## Standing hazards

- **An uncaught throw inside an XR frame ends rendering permanently** — the
  headset falls back to its loading environment with no error surfaced. Guard
  anything new that runs per-frame.
- **Never unmount the `<Canvas>` mid-session** — it kills the XR session.
  Render new navigation states as overlays.
- **Layout vs renderer boundary:** presentation (page and panel transforms) is
  renderer-side. Only touch the layout engine if pagination or flow genuinely
  changes. Parser and mapper stay frozen.
- **Metres everywhere**, and `RenderMetrics` remains the only source of
  dimensional truth — no hard-coded font sizes or element heights.

---

# Part III — Build status (2026-08-16)

Built against Part II. What follows is what landed, what changed on contact
with the code, and what is still open. Deviations are recorded because they
are decisions, not slips.

## What is built

| phase | state | where |
|---|---|---|
| 0 recover | done | stash popped; `views/`, `visual/`, the geometry tests and four superseded docs deleted; `test:geometry`/`test:wall` scripts gone |
| 1 direction | done | `src/links/direction.ts`, exhaustive table test in `__tests__/direction.ts` |
| 2 memory | done | `src/links/memory.ts`, 83 checks in `__tests__/memory.ts` |
| 3 minimap | done | `src/renderer/scene/minimap.tsx` |
| 4 marks | done | `primitives/inline.tsx`, `meshes/inline-mesh.tsx`; `layout/utils.ts` measures the mark |
| 5 wall | done | `scene/wall-field.tsx` — edge strips, the turn, re-normalisation |
| 6 deck | done | `scene/deck-field.tsx` — paths off the table, world slide |
| 7 rooms | done | corridor doors directional and per-page, stair treads on the up/down doors, a back door in every stretch |

`npm run test:links` (92.2% region, 94.2% direction), `npm run test:memory`,
`npm run test:slots`, `npm run build` all pass.

One module the plan did not name turned out to be the load-bearing one:
`src/links/slots.ts`, which decides what goes in each direction and in what
order. All four views were about to answer that question separately.

## Deviations, and why

1. **`NavAxis` is reader-relative, and `cursor` became `walked`.** The plan's
   sketch reads the axes as absolute corridors from the session origin. That
   shape cannot represent a TURN: go east then north and the eastern document —
   the way back — lies on no axis, so the reader is stranded one move into
   their second corridor. Corridors are now relative to where the reader
   stands. "Going east four times is a four-long east corridor" survives
   intact; it is described from the reader instead of from the origin, which is
   the end a headset reader can actually check.

2. **The wall's strips appear only when a page is OPEN, and then show every
   link that page has** (Anand, mid-build). The board has three levels and only
   the last is a reader reading — on the outline, `focus` is just whichever page
   a section starts at. Once it is one page there is nothing to ration (census:
   median 0, p90 7 outbound per rendered page), so `fitBudget` sizes the window
   to the page and no link overflows.

3. **The document stays on screen while the next one loads** (Anand,
   mid-build). Navigation used to clear the tab's html on departure, which
   unmounted the scene and put a DOM spinner over the canvas — replacing the
   one thing the reader needed to see, the direction they were going, with a
   loading screen. `Tab.pending` replaces it: url, html and memory commit
   together on arrival, and `scene/transition.tsx` says a move is under way.

4. **The dice turns about the BOARD, not the origin** (Anand, mid-build). The
   board hangs a metre and a half in front of the reader and well off the
   origin, so a rotation applied at the origin swung it around them rather than
   turning it in place.

5. **The hover preview card is deleted**, not gated. Phase 4 left the decision
   open. A door already carries the destination and gaze already lights the
   anchor and its door together, so a preview card would be a second thing
   firing on the same gaze.

6. **Rooms' stairs are a flight into the doorway, not a second storey.** The
   building has one floor plane and a stair to nowhere is worse than a door, so
   an up-door gets three treads rising into its opening and a down-door three
   falling away from it — which is what a real building does at a door onto a
   different level, and it makes the direction readable from down the corridor
   rather than only off the sign.

7. **The rooms floor window is gone** (Anand, 2026-08-16: *"I never spoke about
   window part remove that"*). It was in the plan's own table and was never
   asked for. Rooms keeps a per-direction window like everything else, and a
   single open page ignores it entirely.

8. **`gold-set.ts` reports direction but does not gate on it.** Six of the gold
   anchors are ambiguous by construction — one MDN href appears twice, in a body
   list and in the sidebar tree, with identical anchor text — so the annotation
   key cannot say which occurrence it meant. Gating a number a harness artefact
   controls would only ever be resolved by biasing the matcher. The projection
   table is gated exhaustively by `__tests__/direction.ts` instead. Fixing the
   ANNOTATION is the real fix.

## Still open

- **Rooms** is still one storey on one floor plane. The up/down doors carry a
  flight of treads that reads as a level change, which is what a real building
  does at such a door, but there is no second floor to walk to.
- **Sibling overflow** is still the stated default (fill right, overflow left,
  then mark) and still unmeasured.
- **Verification:** the wall, the deck's table and the minimap were checked in
  the flat preview. The rooms corridor was not seen
  rendered — only type-checked and built — and no view has been checked in a
  headset.

---

# Part IV — Second pass (2026-08-16, on Anand's review)

Six things came back from the first look. All six are in.

## 1. The transition played half a move

*"the transitions of the wall is not smooth, it turns and then the other frame
just appears"* — and the same for the deck.

Only the LEAVING half existed. The board turned away, the fetch landed, and the
next document was snapped in at rest: the direction the reader had chosen was
animated, the direction they had just gone was not.

`scene/travel.tsx` now owns both halves for both views — leave, hold for as long
as the fetch takes, then the NEW document enters from the opposite side and
completes the same motion. One turn of a dice, not two half-turns meeting in a
cut. Eased over a fixed 0.42 s with `easeInOutCubic` rather than by exponential
decay, which is fast and then asymptotic and reads as "already arrived".

One bug worth recording, because it looked like the animation was broken rather
than mis-triggered: the arriving half is cued by `resetKey` while the view's own
`axis` state is often still set — the view clears it in an effect, which runs
after render — so any re-render in that gap re-started the LEAVING half. The
board turned away, arrived, and turned away again, holding edge-on. `TravelGroup`
now arms the leaving half separately and disarms only when `axis` goes null.

## 2. Strips fill from the centre out

*"The tags in the wall view should start from center than outwards"* — offsets
now go 0, +1, −1, +2, −2 …, on both the rows and the side columns. Filling from
an edge put the nearest door wherever the packing happened to start, which moves
as the board reflows.

## 3. The links were not readable

*"The links aren't actually visible properly"* — three separate causes:

- **They were behind the page.** The strips were drawn on the board's surface,
  which is `WALL_BOARD_STANDOFF` behind the plane the pages hang in, so the open
  page and its mount occluded the very doors that belong to it. They are now in
  the page's own plane.
- **They were the size of a caption.** 0.052 m tall and 0.2 m wide gave a label
  about nine characters, so every door read "Measuremen…". Plates are now
  0.076 × 0.42 m, and `DoorPlate` truncates the name to what will actually FIT
  rather than to a fixed character count.
- **They were hung off the wrong thing.** The board grows past four metres wide
  with a long section open, so its edges are a metre either side of the reader.
  The strips now hang off the OPEN PAGE's own cell — which is also what the
  model already said, since a corridor belongs to the page the reader is on.

Plus: recession dimming now applies to the travelled path only. A page's own
links are not a corridor — their `distance` is just the slot they landed in —
and fading them by index made the fourth sibling a near-black plate.

`WALL_PREVIEW_FOV` is back (100°) for the same reason it existed before: in a
headset the reader glances sideways and the doors are there, and in the flat
preview a 60° lens crops away exactly what the strips exist to show.

## 4. The minimap speaks each view's language

*"quick view should reflect the metaphor of the view rather than just dots"* —
`NodeGlyph` draws a visited document as the thing that view is made of: a square
FACE for the wall, a card with the table's lip for the deck, and a room in plan
with its doorway left open for rooms. Rooms joins its nodes with corridors
rather than wires. The caption says what the map
is of ("4 rooms"), so the shapes read as shapes.

Colour still carries nothing. What separates "visited" from "here" is weight and
an outline; what separates the three views is shape.

## 5. The elevator is two states, not an arc of plates *(view since removed)*

*"the user walks around the circular corridor and then checks a page and then
finds on the right a path which opens to another circular corridor of links,
along with top and bottom for the parent and external links"* — built as
described. Closed, a single PATH stands to the right of the page saying how many
documents it leads to. Open, the siblings ring the reader in the clear band
below the pages, with parents stacked above dead ahead and externals below, and
the way out at the corridor's own threshold.

It arrives by CONTRACTING from a larger radius onto its resting one, which is
what walking into a circular corridor looks like from inside — the walls come
round you — and it needs no camera move, which matters because the camera
belongs to OrbitControls in the preview and to the headset in a session.

Two placements were wrong first time and are worth recording: the run's bearing
had to be negated (θ increasing sweeps left on a ring the reader stands inside),
and the corridor had to go BELOW the pages — at eye level it cut across them,
and at a larger radius they stood in front of it.

## 6. Rooms

The floor window is gone (*"I never spoke about window part remove that"*) — it
was in the plan's own table and was never asked for. Added instead: a back door
in EVERY stretch, so a reader three rooms deep can leave from where they are;
and a flight of three treads rising into each up-door and falling away from each
down-door, which is what a real building does at a door onto a different level.
The building is still one storey.

## 7. Rooms' corridor is a branch beside the PAGE

*"the corridor should appear next to the section and open up to a corridor of
doors and stairs"* → *"I mean next to the page not section"*.

The first build hung the links down the STRETCH of spine corridor past each
section's room. That is a corridor of doors, but it is one the reader walks
THROUGH on the way to the next room rather than one they turn and walk INTO,
and it belonged to the section — so a link on page 3 and a link on page 30 came
off the same wall, nowhere near either page.

Now: the room's side wall has an OPENING beside the page the reader is on, into
a branch corridor with its own floor, ceiling and light. Its two long walls
carry the doors — eastward siblings and parents on the right-hand wall,
westward siblings and externals on the left — siblings nearest, then the doors
that change level, each with its own flight of treads. The spine's stretches
are plain circulation again and shrink to a fixed length.

Two things that had to change with it:

- **Rooms uses the WINDOW, not fit mode.** One Wikipedia page's 28 ascent links
  built a fifty-six-metre corridor. The wall can show every link a page has
  because they are all within a glance; a corridor has to be walked. Rooms'
  budget went to 4 a direction — two ranks of eight doors, about five metres —
  (the elevator, then still shipping, kept fit mode: its corridor was a ring
  you turned to read rather than walked). This is the revisit the spec's decision item 2 invited ("build it flat;
  revisit only if it bites in practice"). It bit.
- **The branch's door pitch is 62% of the spine's.** The spine is walked past
  at reading pace with a room of pages either side; the branch is a rank of
  doors the reader turned into deliberately, and doors on a rank stand close.

`windowFor`'s fallback also stopped borrowing rooms' budget — it now has its
own constant, because a default that moves when an unrelated view is retuned is
not a default. The memory test caught that.

## 8. The branch, corrected twice more

Two faults in the first cut of it, both visible the moment the reader stood in
the corridor.

**"next to the page not in the page."** The opening was cut at the page's own
z, so the wall came out from behind the very page whose corridor it is and the
page hung in the doorway. Three things had to change together, because the room
simply did not have the depth for a corridor beside a page:

- clearance is now measured from the page's EDGE (half the page, half the
  corridor, and a 0.45 m margin), with a hard invariant that the opening never
  overlaps the page — right of it by preference, left of it where the room's
  depth will not take that, and the far end of the room if neither fits;
- `ROOM_PAGE_GAP` went from 0.12 m to a full BAY, derived rather than chosen:
  `2 × BRANCH_HALF + 0.5`, the width of an opening plus its jambs. A gallery
  that hangs doors between its pictures spaces the pictures for it;
- a room's depth now has to hold its pages AND a corridor beside the outermost
  of them, or the clamp lands back on the page. Rooms are about 3.5 m per row
  rather than 1.5 m; that is the cost of a corridor per page.

**"no boundary."** Two separate causes, and the dump of the wall pieces showed
both at once:

- the pier between doors had been tuned as a fraction of the spine's pitch and
  came out at **0.37 m**, so the run read as a colonnade of openings with
  slivers between them. It is now a derived `BRANCH_PIER` of 0.95 m — still
  tighter than the spine's 1.15 m, which is right, because the spine is walked
  past and the branch is a rank the reader turned into;
- both long walls indexed their doors from row 0, so **every opening faced an
  opening** and the two walls cancelled: looking down the branch you saw
  through both sides into the void. The left wall is now staggered by half a
  pitch, so every door faces a pier.

## 9. Every page's corridor, built with the building

*"I want the corridors present irrespective whether the user is standing on the
page, they should be pre-rendered before not after standing."*

A departure from the spec, which says only the page the reader is on has a live
corridor — and the right one for a view you WALK. A reader coming down a
gallery has to see which pages lead somewhere BEFORE choosing which to stand
at; a corridor that appears only once they are already there cannot be part of
that choice. (The wall still opens one at a time. Its reader is not walking
past anything.)

`PagePlacementOptions.focusPage` became `pageLinks`, indexed by page, and
`branchesOf` returns one branch per page that has links — 38 of them on the
Wikipedia "Hypertext" test, with 256 doors and no overlapping openings.

Building them all also **removed the hard part**, which is why the single-branch
version kept breaking. It had to hunt for a gap in a wall already full of
pages, and the hunt failed on a shallow room and put the opening through the
page. Now every page owns the BAY immediately after it, `ROOM_PAGE_GAP` is
derived as `2 × BRANCH_HALF + 2 × BRANCH_PAGE_CLEAR` so a bay is exactly a
corridor plus its jambs, and the room is built `rows × step + 2 × BRANCH_HALF`
deep so the last page on a wall has one too. The position is arithmetic, not a
search that can fail.

Two smaller faults fixed with it:

- **Openings must be sorted along their run.** `wallRun` measures each doorway
  from the run's start, so an unsorted list walks backwards over itself and
  emits overlapping and negative-width pieces. With one opening per wall this
  never showed; with a dozen it is most of the wall.
- **The branch's floor and ceiling now overlap the room wall by 0.5 m.** Butted
  exactly to it they left a hairline of nothing at the threshold, which reads
  as a black seam across the doorway and, at a grazing angle, as a hole.

## 10. Rooms is a building with storeys

Anand's floor plan, 2026-08-16 — three frames marked `0f`, `1f`, `2f`, with the
reading floor in the middle, corridors spurring off it, and two blocks in the
circulation marked as *"the stairs to upper floor and bottom floor with the top
level and external links"*.

So the legend is finally built out of the material the view is made of:

| direction | where it is |
|---|---|
| sibling | a door on the reading floor, down the page's own corridor |
| **parent** | a door on the **landing above**, up the flight at the corridor's end |
| **external** | a door on the **landing below**, down the other flight |

Every page's corridor now has up to three storeys on one footprint — the
corridor itself, and a landing above and below it wherever that direction has
anything — joined by flights standing in the clear run `BRANCH_END_RUN` was
always reserving. On the Wikipedia "Hypertext" test that is 186 sibling doors on
the reading floor, 23 parents above, 47 externals below, and 22 flights.

This replaced an approximation that had been quietly wrong: a door at floor
level with three treads drawn in front of it. It said "up" without being up —
every door was on one storey and the reader never changed height, so the
legend's strongest claim, that a parent is ABOVE you, was the one thing the
geometry did not make.

**A storey is a height the BUILDING moves by.** `ReaderPose` gained a `level`
and `roomPoseTransform` translates the world by `−level × ROOM_STOREY_H`, which
is the same trick the walk already used for x and z: the reader stays at the
origin, where the XR recentre and every piece of in-world chrome expect them.

**A flight is taken, not climbed.** The walk model puts the reader on a floor
PLANE, and walking between planes needs a step-height model this view does not
have. Selecting a flight lands them at its head, cut rather than eased —
gliding a reader vertically through three metres of slab is the strongest
vection this app could produce and there is nothing to learn from watching it.
The treads are real geometry because the reader has to see that it goes up.

## 11. Walked, and what walking found

The preview driver only sends discrete key presses, and rooms' walking is
held-key — so it had been verified from a corridor mouth and by offline dumps,
never from inside. Dispatching a synthetic `keydown` without its `keyup` holds
a key, which is enough to walk. Doing that found three real faults that no dump
would have shown:

1. **Collision is worked in PLAN, so another storey's walls blocked the
   reader.** `roomWalkStep` filtered walls to those whose base was at or below
   the reader's floor — fine on one storey, wrong the moment there were three:
   a wall on the landing BELOW passed the test and stopped a reader on the
   reading floor. A wall is solid to a reader only when it SPANS their floor,
   and the storey it spans is the reader's own (`floorY + level × STOREY_H`),
   not the building's.
2. **Slabs stopped at the wall centre lines**, leaving a sliver of nothing at
   every pier base and above every door head. A sliver onto nothing is a black
   wedge, and down a corridor of a dozen piers at a grazing angle it is most of
   what the reader sees. The floor and ceiling now run 0.34 m UNDER the walls.
3. **Door leaves were cut exactly to their openings**, so every jamb and head
   had a hairline. Leaves are now 6 cm proud; the architrave hides the overrun.

Walking the corridor confirms what the dumps claimed: doors hung on both walls
with real piers between them, each carrying its direction's glyph and its
destination's name — "▸ mass · en.wikipedia.org".

## 12. Stairs you climb, and a building that is not needlessly long

Three corrections, all from walking it.

**The stairs were not stairs.** A flight was a narrow box set ACROSS the
corridor inside a group turned by the wall's bearing, so every tread drew
edge-on — a plank stuck to the wall — and the sign came out mirrored. A flight
now runs the way you WALK it: along the corridor's own axis, the full width of
it, with each tread a solid block from the floor to its own nosing so the run
reads as a stair from the side. Up and down are laid end to end rather than
side by side, because two flights sharing a corridor's width leaves neither
wide enough to walk. Composed in world components rather than a rotated group —
that group was the whole cause of both faults.

**You climb them.** `ReaderPose.level` was an integer storey, and an integer
cannot represent "halfway up" — which is exactly why the only way onto a
landing was to be put there. It is now a continuous `rise`, sampled from
`walkSurfaceAt(stairs, x, z)` on every step: flat almost everywhere, ramped
across a flight's footprint, held at the top so a landing is a floor rather
than the crest of a ramp that falls away again. Walking measured: from the foot
at x = 4.15 to x = 9.32 the reader rose **0 → 2.44 m**, and on to the head
**3.60 m — exactly one storey**. No teleport anywhere in it.

**The building was needlessly long.** Every page got a full bay whether or not
it had a corridor to open into one. A room now lays its rows out one at a time
and gives a bay only where one of that row's two pages actually has links;
everything else follows at a hairline gap. And the bay belongs to the ROW, so a
facing pair of pages gets a facing pair of doorways at the same z rather than
one near and one far — Anand: *"I want the corridor opening of page 2 at same
position as the page 3"*. 41 pages now build a 157 m enfilade with 38
corridors, 14 of the bays shared by a facing pair.

The way in is a door-height doorway rather than a full-height hole (*"the
entrance frame is too big and corridor is small"*), and the corridor is wider
for it.

## 13. Three bugs that made the climb impossible

*"I can't actually climb and there is no floor of the top rendered … no
collision with the stairs and pre-rendered floor with doors doesn't exist."*
Three separate faults, each of which alone would have produced exactly that.

1. **The climb was computed and then thrown away.** The walk wrote a new
   `rise` onto the target pose every step, and `RoomWalk`'s ease copied x, z
   and yaw — everything EXCEPT the height. So the transform always used a rise
   of zero: the reader walked *through* the flight rather than up it, and the
   measurement I had taken was of a number nothing was reading. `rise` is now
   eased with the rest, and faster than the plane movement — lagging height
   behind position by the same amount as a turn sinks the reader into the
   treads.

2. **The flights climbed into a solid slab.** A flight crosses the ceiling of
   the storey it leaves and the floor of the one it reaches, and neither had a
   hole in it — so the landing above was capping its own stairwell. That is why
   the floor at the top "did not exist": it did, from below. `RoomSlab` is a
   single quad, so an opening means emitting the pieces AROUND it, and the hole
   has to be bounded at both ends: it starts a little before the foot for
   head-room and stops a tread SHORT of the head, or the reader steps off the
   top step into the shaft they just climbed. It also cuts only the slabs a
   flight passes THROUGH, never the one it stands on — cutting the full span
   removed the corridor floor at the bottom of an up flight.

3. **Mid-climb there were no walls at all.** Collision picks the walls that
   span the reader's floor, and the raw rise put them, part-way up, in the band
   between the ceiling below and the floor above — where nothing spans. They
   were bounded by nothing and walked straight out through the end wall of the
   stairwell. Collision now snaps to the NEAREST storey, so the reader is
   inside one storey's walls for the whole climb.

Walked and measured after all three: **0 → 1.09 → 2.57 → 3.60 m**, held at 3.60
on the landing, and the reader now stops against the end wall instead of
leaving the building. From the head of the flight the landing reads as a
corridor of doors with the stairwell open in its floor.

## 14. A corridor opens as you approach, and holds while you are in it

Two faults, one walking session.

**It opened on the mark, not on approach.** The build-out was gated on `focus`,
and `focus` only moves when the reader stands inside a page's 0.55 m reading
spot — so the arms, the stair hall and the flights arrived only once both feet
were on the disc. Anand: *"the corridors for the room activates when I am at
the pointer, it should activate when I am the vicinity."* Which page is on show
and which corridor is open are now two questions. `corridorPageAt` elects the
latter by proximity: the nearest page within `VICINITY_REACH` (2.6 m — most of
a bay), among the pages of the room the reader is actually in, so a spot the
same distance off through a wall does not count. Walked and measured: along a
wall the corridor opens **1.75–1.80 m** out, and for a facing pair (which is a
walk across the room, the two marks only 1.3 m apart) at **0.66 m** — in both
cases before the mark, never after it.

**It could move while you were inside it.** The vicinity rule alone is worse
than the old one: an arm runs ALONG the room wall and past the neighbouring
bays, so a few strides down it the nearest reading spot belongs to a neighbour,
and re-electing there would rebuild the floor, the walls and the very doorway
the reader came in by while they stood on them. Anand: *"the corridor should
have same entrance and exit."* So the election stops the moment the reader
crosses the wall line — the room test is taken with **no** `ROOM_ENTERED_SLACK`,
which means standing in the threshold already counts as committed — and a
`VICINITY_MARGIN` of 0.5 m stops a reader hovering between two bays swapping
the whole corridor back and forth on every reported step.

Verified by walking it offline in 5 cm steps with the real collision, the real
walking surface and the real election on every step, for pages on both walls
and in both rooms: out through the doorway, down one arm, back down the other,
and in again — the corridor is the same one throughout, and the door out is the
door back in.

## 15. The second move in a row landed the reader in the void

*"If i click one direction of links after second continuous link in the same
direction i get teleported to void."* One cause, and it is a lifetime problem
rather than a geometry one.

**The rooms field never remounts between documents.** Every document's main
content panel has the id `"main"` — the parser numbers from the root — and that
id is the React key, so the same `PageGhostField` instance, and every ref
inside it, carries straight over from one building into the next. The reader's
pose is one of those refs.

**And the pose was reset only on a change of `focus`.** A new document resets
paging to page 0, so the FIRST move worked by luck: the reader was standing at
page 7, and 7 → 0 is a change. The second move in a row is 0 → 0, nothing fired,
and the reader kept the coordinates they held in the previous building —
usually out in a corridor, sometimes up on a landing. Measured on the corpus: a
reader at page 24 of the 40-page Wikipedia page stands at z = −58 m, and the
14-page MDN page has **no room and no floor** anywhere near it. Where the
previous document was the shorter of the two the failure is quieter but the
same — they arrive in room 4 of a document they have never read a word of.

Arrival is now its own trigger, next to the focus one: a new `LayoutPlan` puts
the reader at page 0's reading spot of the building they have just entered,
lands rather than glides (easing across the gap would drag them through several
rooms of the new document), and clears `rise` — a landing one storey up in the
document you left is thin air in the one you enter. The room the reader is in,
the coarse walking position and the open corridor are all re-derived on the
same trigger, since each of them was keyed on the focus change too.

## Still open after this pass

- The deferred `panelCurveRadius` problem: a page's curve still assumes one
  authored reading point, and a reader who has walked is not there.
- Nothing has been checked **in a headset**. Everything above was verified in
  the flat preview.
- A couple of small seams remain in the corridor at grazing angles — much
  reduced by the slab overrun, not eliminated.
- The landing corridor has been seen from the head of the flight but not
  walked to its far end, so its doors are placed and visible rather than tried.
- There is no balustrade round the stairwell opening: the hole in the landing
  floor is unguarded.
- **Climbing** a flight on foot is not built; a flight is selected. That needs a
  step-height model in `useRoomWalking`, which currently assumes one plane.
