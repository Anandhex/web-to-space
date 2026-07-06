# Spatial views — design & implementation plan

Status: living document. Phase 1–3 implemented; Phase 4 interactions partially deferred (see below).

## Thesis framing

The project's premise is *semantic structure → spatial form*. A **view** is a
**semantics-preserving spatial reframing** of the same page: it never changes
*what* is on the page or *how content flows inside a panel* — it only changes
*where the landmark panels sit around the user* and *which reference frame they
live in*.

The original five views (standard, carousel, cards, door, theatre) were each a
hand-tuned `SlotMap` function, and choosing a view **discarded** the auto-selected
content template (`document`/`dashboard`/`form`/`landing`). A news article and a
data dashboard got an identical carousel. This plan fixes that with a two-axis
model and adds views that actually use depth and the space around the user.

## The two-axis model

```
content template (auto, from semantics)   ×   spatial arrangement (user-chosen view)
  document / dashboard / form / landing        reference frame + distribution
        ↓                                              ↓
   rosterFor(): ordered SlotSpec[]  ──►  arrangement.distribute()  ──►  SlotMap
```

- **Content template** answers *"what kind of page is this?"* and produces a
  `SlotRoster`: an ordered list of the landmark slots present, with their sizes
  and a reading-priority weight. No positions.
- **Arrangement** answers *"how do I want it wrapped around me?"* It takes the
  roster and emits a `SlotMap` (positions/rotations/curve/worldLocked) using one
  of a small set of **distribution algorithms**, in one of four **reference
  frames**.

Because the arrangement only rewrites the landmark `SlotMap`, **all intra-panel
placement is untouched**: `layoutPrimitive`, `paginateContentPanel`,
`stampDescendants`, the panel-absolute coordinate contract, clipping — none of it
moves. This is what makes the refactor safe.

### Reference frames

| Frame   | Follows            | Applied by                      | Devices        |
| ------- | ------------------ | ------------------------------- | -------------- |
| `world` | nothing (fixed)    | identity                        | all            |
| `body`  | camera **yaw**     | `ReferenceFrameGroup` per-frame | Quest (6DoF)   |
| `head`  | full head pose     | `ReferenceFrameGroup` per-frame | Quest, glasses |
| `hand`  | a controller grip  | `ReferenceFrameGroup` per-frame | Quest          |

`LayoutEntry` positions are authored in the arrangement's frame. A single
`ReferenceFrameGroup` at the scene-graph root applies the frame transform once —
so the "one group per primitive, children as siblings" contract holds. In the
flat (non-immersive) preview the transform is identity, so every arrangement is
still explorable with the mouse.

### Distributions

- `fan` — primary centred at `-d`, peripherals arced left/right by the comfort
  half-angle. (Reproduces the classic standard/document look.)
- `focus` — primary full-legibility ahead; every other role collapses to a thin
  peripheral ribbon, compression ∝ `readingDepth`. Focus+context reading.
- `stack` — landmarks recede along `-Z` by reading priority. Uses the one axis
  flat web can't. Pull-to-front = drill.
- `ring` — landmarks distributed around a body-locked cylinder; turn to navigate.
- `corridor` — sections as alternating wall panels receding in `z`; reading order
  is a walking path (room-scale).
- `palm` — compact stack anchored to a controller grip; peripherals become chips.

## Views

| View       | Frame  | Distribution | Best content | Device gate |
| ---------- | ------ | ------------ | ------------ | ----------- |
| `standard` | world  | (legacy auto)| any          | all         |
| `carousel` | world  | (legacy)     | any          | all         |
| `theatre`  | world  | (legacy)     | landing/doc  | all         |
| `focus`    | world  | focus        | document     | all         |
| `stack`    | world  | stack        | dashboard/doc| Quest       |
| `orbital`  | body   | ring         | dashboard    | Quest       |
| `palm`     | hand   | palm         | any          | Quest       |
| `gallery`  | world  | corridor     | document     | Quest (room)|

`cards` and `door` are retained as legacy bespoke views but are superseded:
cards is really the `dashboard` template's own look, and door's drill-down is a
behavior that now belongs on `stack` (pull-to-front).

## Architecture map (files)

- `src/layout/types.ts` — `ReferenceFrame`, `Distribution`, `Arrangement`,
  `SlotSpec`, `SlotRoster`; `LayoutPlan.referenceFrame`.
- `src/layout/arrangements.ts` — the arrangement registry + all distribution
  algorithms + `rosterFor()` + `resolveArrangementSlots()`.
- `src/layout/engine.ts` — `computeLayoutPlan(scene, profile, template?, cfg?,
  metrics?, arrangement?)`: when an arrangement is passed, landmark slots come
  from `resolveArrangementSlots`; otherwise the legacy `selectSlots` path runs.
  Stamps `referenceFrame` on the plan.
- `src/renderer/XRSceneRenderer.tsx` — maps `ViewMode → Arrangement`, threads it
  through `usePipeline`, and wraps the scene graph in `<ReferenceFrameGroup>`.
- `src/components/viewTypes.ts`, `ViewToggle.tsx`, `XR3DChrome.tsx` — the mode
  union, device-aware toggle filtering, and in-world toggle.

## Phased roadmap

- **Phase 1 — foundation (done).** Two-axis types, `arrangements.ts`, engine
  wiring, `ReferenceFrameGroup`, view switching. Legacy views unchanged.
- **Phase 2 — focus + stack (done).** `focus` and `stack` arrangements. No new
  interaction primitives (gaze-dwell / grab reuse existing raycast `userData`).
- **Phase 3 — orbital + palm + device-aware toggle (done).** `body` and `hand`
  frames; `ViewToggle`/`XR3DChrome` filter by `deviceFit`.
- **Phase 4 — pinboard + gallery.** `gallery` corridor arrangement (done as
  layout). **Deferred (needs headset XR session plumbing, unverifiable outside a
  device):** pinboard world-persistence across tabs, grab-to-detach, gaze-dwell
  drill-to-front on `stack`, and room-scale locomotion polish. These are layout-
  complete but interaction-stubbed.
- **Transitions (done).** `AtPos` now eases every primitive toward its target
  position/rotation with frame-rate-independent exponential smoothing
  (`MORPH_RATE`), so switching views morphs the panels between arrangements.
  First mount initialises straight to target (no fly-in); settled groups
  early-out so idle cost is ~one branch per node.
- **Palm grip anchoring (done).** The `hand` frame in `ReferenceFrameGroup`
  reads the off-hand controller's grip pose (`gl.xr.getControllerGrip`, selecting
  the `left` input source when present) and anchors the whole arrangement to it,
  falling back to a head-anchored frame when no grip has a live pose. The flat
  preview parks the hand-local layout at a static anchor so it stays explorable
  without a headset.

## Follow-ups / known gaps

- **Legacy view migration.** carousel/cards/door/theatre still use bespoke slot
  functions + renderer branches. They should migrate onto arrangements once the
  new path is battle-tested, at which point the branches in `XRSceneGraph` shrink.
- **Focus ribbons / stack layers vs. clipping.** `ClipPlanesContext` assumes
  rectangular panels; ribbon/layer clip volumes may need per-panel updates.
