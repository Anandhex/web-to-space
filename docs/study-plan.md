# Evaluation study — design and operation

n = 5. A **formative, qualitative study**, not an inferential one. Five
participants cannot support p-values, and this document does not pretend
otherwise — see "What this study cannot tell you" at the bottom.

Replaces the offline parser benchmark deleted 2026-08-31 (`src/eval/`,
`src/study/`, the gold corpus, `/api/study`'s old log sink, every
`npm run test:*`). That measured the pipeline; this measures a reader, in a
headset, on two questions:

1. **Does semantic markup change the experience?** Same content, semantic
   HTML vs. div soup, across all three views.
2. **Do directional links work, and does the minimap earn its place?**
   Navigation across a multi-page site with the link system off (plain
   clickable anchors), on without the minimap, and on with it.

## Running a session

Nothing in this workflow requires typing a query string. Every entry point is
a control on screen.

1. `npm run dev` (HTTPS — the headset needs it for WebXR). Confirm
   `public/study/blockA/manifest.json` and `public/study/blockB/manifest.json`
   exist; if not, run `npx tsx scripts/build-stimuli.ts` first.
2. **On the headset**, open the app at `https://<this machine's LAN IP>:5173/`
   and pick **Evaluation Study** — the right-hand cell of the strip under the
   launcher grid, beside Link Direction Test. That opens the control screen
   (`src/study/runner.tsx`), which replaces the reading app entirely.
3. Pick the participant, then click a trial row and press **Launch here**.
   The trial loads in place, on that device, in the right view and condition.
   The condition is rebuilt locally from `src/study/protocol.ts` and the two
   manifests, so a given participant/block/trial always resolves to the same
   condition on any device.
4. Once the trial starts, the operator does nothing: the quest card in the
   top-right corner of the reader's view drives itself, advances on a hit or
   an arrival, and every event is logged to `study-out/P03.jsonl` without
   operator input.
5. **Between trials, the session gates itself — no return to the runner.**
   The instant a trial's last task/hop lands, a centred panel
   (`scene/study-gate.tsx`, mounted from `XRSceneRenderer`) replaces the
   reader's view: "Trial complete — remove the headset and fill in this
   trial's questionnaire. Put it back on and press Start when you're ready
   for the next trial." One click on **Start next trial** loads the next row
   of the protocol in place, in the same tab — no query string, no trip back
   to the runner screen. App.tsx owns the full 15-trial list and the pointer
   into it (`studySession` in `src/components/App.tsx`); the gate panel only
   knows whether there IS a next trial, never what it is. The pointer is
   still written to the SAME `localStorage` key the runner's row click
   uses (`progressStorageKey` in `src/study/protocol.ts`), so either screen
   reflects where the participant actually is. After the last trial, the
   same panel shows a closing **Thank you** screen instead, with no button —
   the session is over.
6. **Abort trial**, on the runner's own screen, logs `trial_end` with
   `status: "aborted"` and does not advance the pointer — re-launch the same
   trial when ready. It is a separate, operator-side control from the
   in-headset gate above, for exactly the cases the gate can't cover (a
   trial that needs to be cut short before it would complete on its own).
7. Immediately after each trial, the operator/participant fills in that
   trial's row directly in Excel — the Likert ratings, open-ended answers and
   any observer comment. This is manual entry, on purpose: those answers only
   exist as what a person writes down, so Excel is where they're written
   once, not typed into the app and then transcribed again. Open
   `study-out/P<nn>.xlsx` for just this participant (Session info/Block
   A/Block B/Debrief, trial numbers matching the runner's table) — it's
   generated ahead of the session by `npx tsx scripts/build-worksheet.ts`
   (every participant's is independent of the others and of whether they've
   run yet, so all five already exist) — or the combined
   `study-out/worksheet.xlsx` if you'd rather work across participants.
   Neither is linked from the runner screen; open it yourself alongside it.
   See "Deriving trial summary metrics" below for what IS captured
   automatically.
8. Break between Block A and Block B, with the SSQ check (`docs/study-consent.md`)
   before and after. This is load-bearing at 15 trials, not decoration — see
   fatigue below.

**Running the runner on a second device.** If you would rather keep the
control screen on a laptop and drive the headset separately, the runner
prints each trial's full URL with a **Copy** button, and **Open in new tab**
previews it locally. Reach the dev server by its LAN address rather than
`localhost` for those URLs to resolve on the headset — the runner says so
when it detects it is on `localhost`. Once a trial is launched this way the
in-headset gate (step 5 above) carries the session through the rest of the
protocol on its own — the runner only has to be revisited to START a
session, or to resume one after a break (mid-block, or across the SSQ check
in step 8) at whichever row the participant left off on.

## The quest mechanic

**Block A — click the target.** 4 tasks per trial, chained: find the named
item, click it, the card advances. The target is an inline fragment anchor,
`#task/<id>` — not a button (`XRButtonMesh` has no click handler and draws a
filled pill that would delete the search task). It never resolves to a real
primitive, so `navigate()`'s existing same-document dead end
([scene-graph.tsx](../src/renderer/scene/scene-graph.tsx)) already returns
without opening anything; the study layer only adds a record-and-advance hook
at that return (`onTaskClick` — see `useStudyTask` in
[task-hud.tsx](../src/renderer/scene/task-hud.tsx)). Every Block A page
carries several same-looking clickable entries — the target plus decoys — so
a wrong click is a real signal, not a slip. **Block A always runs with the
link system off** (`plain`): it is a test of semantics, not of the link
channel.

**Block B — reach the page.** No click target: the card advances when the
named document loads. Doors, corridors, strips and the in-place `plain`
traversal all commit through the SAME function,
[`traverse()` in App.tsx](../src/components/App.tsx) — the one hook that
logs `hop_attempt` (the moment of the click, with axis) uniformly across
every condition. `hop_landed` is logged separately, from
`StudyTaskProvider` watching the tab's `url` prop actually change, so a slow
fetch is never charged to the participant as if they'd chosen the wrong door.
A landed URL that isn't the expected hop logs `wrong_turn` and does not
advance the card.

**The baseline travels in place.** An inline anchor click normally opens a
new tab (`navigate()` → `onExternalNavigate` → `openInNewTab`), which would
give the `plain` condition a structurally different experience (a new tab per
hop, no navigation memory) for a reason that has nothing to do with the
manipulation. In study mode, `navigate()`'s external branch instead calls
`onTraverse(url, null)` — the same in-place traversal every door uses, with a
**null axis**, because a plain link has no direction. `links/memory.ts`'s
`enter()` accepts a null axis for exactly this: it takes no lattice step and
reserves no return direction, same as the session root.

## The switches

The whole directional link system dies at one seam:
[`scene-graph.tsx`'s `pageLinks` memo](../src/renderer/scene/scene-graph.tsx)
returns `links: []` when `study.linkMode === "plain"`. Inline marks, wall/deck
doors and rooms corridors all derive from that one context, so nothing else
branches on link mode. The minimap is separately gated in
[XRSceneRenderer.tsx](../src/renderer/XRSceneRenderer.tsx) to show only in
`doors+map`.

`StudyCondition` rides on `HomeSettings` ([HomeScreen.tsx](../src/components/HomeScreen.tsx))
exactly the way `viewMode`/`theme`/`parserBackend` already do — it inherits
through link navigation without any special-casing.

## Design

Within-subjects, 15 trials per participant (`src/study/protocol.ts`).

### Block A — semantics × view (6 trials × 4 targets)

3 views × 2 markups (semantic / non-semantic), one distinct topic per cell —
6 topics total, fixed to (view, markup) cells so every participant's view
gets the same two topics regardless of trial order.

### Block B — link condition × view (9 trials × 5 hops)

3 views × 3 link conditions (plain / doors / doors+map). Each cell gets one
of 9 generated site themes, fixed to (view-position, link-condition-position)
cells; the specific 5-hop route within that theme's pool of 4 is chosen by a
participant+trial-seeded PRNG (mulberry32), so it's reproducible per
participant without being hand-assigned.

### Counterbalancing

All resolved in `src/study/protocol.ts`, printed into the runner's table so
the operator never works it out live:

- **View order** — a 3×3 Latin square over (rooms, wall, deck). P1–P3 take
  its rows; P4–P5 take the first two rows of the row-reversed square. The
  SAME per-participant order is used for both blocks.
- **Markup order** (Block A) — alternates semantic-first / non-semantic-first
  by participant parity.
- **Link-condition order** (Block B) — a second Latin square over
  (plain, doors, doors+map), rotated by `participantIndex + viewPosition`, so
  no participant meets the same link condition in the same view-position
  another participant did.

## Stimuli

`scripts/build-stimuli.ts` (run via `npm run build:stimuli`) generates into
`public/study/`, same-origin so it needs no CORS proxy. Page content comes
from two layers: the authored core in `BLOCK_B_THEMES` (site, hub and leaf
prose) and `scripts/stimuli-detail/` (one file per theme) which carries the
rest of each page. Two manifests
(`blockA/manifest.json`, `blockB/manifest.json`) record topic/theme, target
and decoy ids, and route pools — `protocol.ts` and the worksheet generator
both read them, so there is exactly one source of truth for what a
participant will see.

- **Block A** — 6 topics × 2 markup variants = 12 pages, byte-identical
  visible text and identical DOM order between variants; only the markup
  differs (semantic: landmarks/headings/ARIA; non-semantic: nested
  `div`/`span`, no landmarks). 4 target anchors + decoys at identical text
  offsets in both variants.
- **Block B** — one fixed topology (root + 3 hubs + 9 leaves = 13 pages,
  constant branching) instantiated with 9 themes, each carrying a pool of 4
  five-hop routes. Branching capped at **≤4 outbound links per direction per
  page** — rooms' corridor budget (`windowFor("rooms")`) is the tightest of
  the three views, so this cap is what keeps a route step from falling into
  rooms' overflow while staying visible in wall and deck.

Two properties of the Block B corpus are load-bearing, invisible in the HTML,
and were both violated by the first generated version. `scripts/check-stimuli.ts`
(`npm run check:stimuli`, and part of `npm run build:stimuli`) asserts them.

**Every page must reach three layout pages.** Below `MIN_PAGES_FOR_PAGE_VIEWS`
(3) neither `scene-graph.tsx` nor `page-ghosts.tsx` will mount a spatial field,
and the view falls back to the flip panel. The first corpus wrote ~250-word
pages, which is one layout page: every Block B trial rendered as the same flat
panel in rooms, wall AND deck, so the block's view factor measured nothing, and
rooms' corridors — gated on the same count — never built, leaving its `doors`
condition without doors. Pages now run ~500–600 words and measure 3–4 layout
pages each. **Adding a theme or trimming prose means re-running the check**:
this failure is silent, and it looks like a working trial.

**Every hop needs a link that survives the parser.** `up` is the `ascent`
region, which `links/classify.ts` only assigns inside a navigation landmark —
and `prunePageChrome` deletes `<nav>` breadcrumbs before classification ever
runs. The first corpus put the leaf → hub link in exactly such a breadcrumb, so
hop 4 of all four routes (the ascend) had no link on the page at all: 45 of the
225 participant-hops were impossible in every condition, `plain` included. Each
non-root page now carries a **rail** of bare sibling anchors — the shape
`handleLinkRun` (`minLinkRun: 3`) turns into a navigation landmark — so the
hub link classifies `up` and the ascend hop exists. Measured over all five
participants: 225 hops, 180 lateral and 45 up, none missing.

**The link that answers a hop must be near the top.** Each page view draws
every page at its own placement, so a link's layout page is how much work the
hop costs before the reader even chooses. With the prose sections written
first, the hub and article lists landed on layout page 3 of 4 and the leaf
cross-link on page 4 — making every hop "traverse to the back of the document,
THEN choose", inflating hop time in all three conditions and exaggerating the
`doors` advantage for a reason that has nothing to do with the link channel.
Each renderer therefore puts the link-bearing section (Explore, Articles,
Related) immediately after the lead paragraphs, which is also where a real site
puts its navigation. All 225 answering links now sit on layout page 1–2 of 3–4.

The check also confirms each trial's task is *answerable*: the Block B card
reads `Go to "<toLabel>"`, so an anchor for that destination must read exactly
that and no other destination on the page may (0 mismatches, 0 ambiguous), and
Block A's 4 targets + 12 decoys must all survive as clickable `#task/` anchors
on both markup variants (12 pages, 0 missing).

## What this study cannot tell you

- **n = 5 supports description, not inference.** Report per participant; no
  p-values.
- **Conditions are not blindable.** Rooms without links has no corridors —
  it is visibly a different building, not a subtly different one.
- **Views are not comparable on hop time.** Wall needs three moves to expose
  a link (open section → open page → strips appear), deck two (focus a
  card), rooms one (the corridor is pre-built). That is the design each view
  represents, not noise, and no amount of counterbalancing removes it — Block
  B's timing claims are read WITHIN a view, across its three conditions,
  never across views. Cross-view claims come from the debrief ranking and
  comments.
- **Block A confounds "markup quality" with "what this parser recovers from
  it."** That is the system-level question this pipeline exists to ask, but
  the finding is about this system, not about human reading of semantic HTML
  in general.
- **Four targets on one document are not independent observations** — the
  reader learns the page as they go. Target order is fixed across
  participants so at least the learning curve is comparable
  participant-to-participant.
- **Fifteen trials is close to the top of a comfortable headset session.**
  Fatigue is a live threat; the SSQ stop rule in `docs/study-consent.md` may
  cost cells, and that is an acceptable trade against pushing a participant
  through a trial they should have stopped.

## Recorded events

One JSONL line per event in `study-out/P<nn>.jsonl`:
`{t, participant, block, trial, view, condition, topic, event, payload}`.

- `trial_start`, `trial_end` (`status`: complete | aborted)
- Block A: `task_shown`, `task_hit` (`targetId`, `index`, `ms` since shown),
  `task_miss` (`decoyId`)
- Block B: `task_shown`, `hop_attempt` (`to`, `axis`), `hop_landed` (`to`,
  `ms` since shown), `wrong_turn` (`to`, `expected`), `route_complete`,
  `backtrack`, `minimap_jump`

No PII in any event — participant codes only. Observer notes and the
post-trial questionnaire are NOT among these events — see the workflow step
above and "Deriving trial summary metrics" below for where they live
instead.

## Deriving trial summary metrics

`npx tsx scripts/derive-study-metrics.ts [P03 …]` (all logged participants if
none are named) reads `study-out/P<nn>.jsonl`, rebuilds each trial's
`StudyCondition` from `buildProtocol` (the same source `runner.tsx` and
`build-worksheet.ts` use — nothing about scoring is re-typed by hand), and
writes `study-out/P<nn>.summary.jsonl`: one line per trial with completion
time, task success, interaction count, wrong selections, navigation steps,
backtracking, revisits, time-to-first-correct-action, direct-path completion,
navigation efficiency and (Block B) the directional-selection and
minimap-assistance fields. See `src/study/metrics.ts` for exactly how each
field is derived and why Block A's navigation/backtracking/revisit/efficiency
fields are left `null` (no inter-page graph exists to measure a Block A trial
against — see that file's header). It is read-only over the raw log and safe
to re-run any time.

One thing worth knowing before reading a summary: a trial slot that was
launched more than once (a crash-and-relaunch, or a stray page reload) is
scored from its most recent COMPLETED launch if one exists, otherwise from
its most recent launch — never from an earlier abandoned attempt, and never
overridden by a later bare reload that did nothing.

**Where each kind of result lives, and why they're not in the same place.**
`npx tsx scripts/build-worksheet.ts` (`study-out/worksheet.xlsx`) carries the
Likert ratings, open-ended answers and observer comments as plain manual-entry
columns — filled in directly in Excel after each trial, never through the app
or the JSONL log, because those answers only exist as what a person writes
down. The item set and labels still come from `src/study/types.ts`'s
`QUESTIONNAIRE_RATING_ITEMS` (five core measures, both blocks, plus two
Block B items on link/minimap usefulness) and `QUESTIONNAIRE_OPEN_ITEMS`, so
the worksheet's headers can't drift out of step with what the study brief
asks for, even though the cells themselves are never auto-filled.

Every BEHAVIOURAL count (hits/misses, navigation steps, wrong turns,
backtracking, revisits, directional/minimap fields, …) is the opposite: it is
never typed by hand anywhere. It is fully code-derived from
`study-out/P<nn>.jsonl` by `derive-study-metrics.ts` into
`study-out/P<nn>.summary.jsonl`, and does not appear in the worksheet at all.
Two separate outputs, one per kind of data, rather than one column set trying
to hold both — a rating only a person can supply lives in Excel; a number
code can compute has exactly one place computing it, and it isn't Excel.
