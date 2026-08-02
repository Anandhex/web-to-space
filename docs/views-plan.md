# Spatial views — design & implementation plan

Status: living document. The shipping views are `standard`, `carousel` and the
four page views (`elevator`/`wall`/`deck`/`rooms`); the landmark-scattering
arrangements this plan introduced have since been removed (see "Removed views").

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

`fan` is the only surviving distribution. The landmark-scattering arrangements
(`cockpit`, `strata`, `dome`, `hud`, `exploded`, `constellation`) were removed
along with the `theatre` template — see "Removed views" below.

## Views

| View       | Frame  | Distribution | Page distribution | Device gate |
| ---------- | ------ | ------------ | ----------------- | ----------- |
| `standard` | world  | (legacy auto)| flip              | all         |
| `carousel` | world  | (legacy)     | flip              | all         |
| `elevator` | world  | fan          | elevator          | all         |
| `wall`     | world  | fan          | wall              | Quest       |
| `deck`     | world  | fan          | deck              | Quest       |
| `rooms`    | world  | fan          | rooms             | Quest       |

`standard` and `carousel` are the legacy bespoke path (hand-tuned `SlotMap` +
renderer branches). The four page views route through the arrangement path but
use it only to collapse the roster to `[main]`; their spatial interest is in the
PAGE set, not the landmark panels — see `docs/page-presentation-plan.md`.

### Removed views

`theatre`, `cockpit`, `strata`, `dome`, `hud`, `exploded`, `constellation` and
`grid` (labelled "Sections") were deleted. With them went the `theatre` layout
template and its `SlotMap`, the six landmark distributions, the `grid` page
distribution, and the `SlotTethers` renderer branch that drew hub-and-spoke
lines for `exploded`/`constellation`. Earlier still-referenced-but-absent views
(`focus`, `stack`, `orbital`, `palm`, `gallery`, `cards`, `door`) were removed
before that.

## Architecture map (files)

- `src/layout/types.ts` — `ReferenceFrame`, `Distribution`, `Arrangement`,
  `SlotSpec`, `SlotRoster`; `LayoutPlan.referenceFrame`.
- `src/layout/placement.ts` — per-template `SlotMap`s (`selectSlots`) + the
  arrangement registry + the `fan` distribution + `rosterFor()` +
  `resolveArrangementSlots()`.
- `src/layout/engine.ts` — `computeLayoutPlan(scene, profile, template?, cfg?,
  metrics?, arrangement?)`: when an arrangement is passed, landmark slots come
  from `resolveArrangementSlots`; otherwise the legacy `selectSlots` path runs.
  Stamps `referenceFrame` on the plan.
- `src/renderer/XRSceneRenderer.tsx` — maps `ViewMode → Arrangement`, threads it
  through `usePipeline`, and wraps the scene graph in `<ReferenceFrameGroup>`.
- `src/components/viewTypes.ts`, `ViewToggle.tsx`, `XR3DChrome.tsx` — the mode
  union, device-aware toggle filtering, and in-world toggle.

## Phased roadmap

- **Phase 1 — foundation (done).** Two-axis types, the arrangement registry,
  engine wiring, `ReferenceFrameGroup`, view switching. Legacy views unchanged.
- **Phase 2 — device-aware toggle (done).** `ViewToggle`/`XR3DChrome` filter by
  `deviceFit`.
- **Phase 3 — landmark distributions (removed).** The scattering distributions
  built on this path were deleted; see "Removed views". The `body`/`head`/`hand`
  frames survive in `ReferenceFrameGroup` but no shipping view selects them.
- **Phase 4 — page views (done).** The interest moved from scattering the
  landmark panels to spatialising the PAGE set: `elevator`, `wall`, `deck`,
  `rooms`. Tracked in `docs/page-presentation-plan.md`.
- **Transitions (done).** `AtPos` now eases every primitive toward its target
  position/rotation with frame-rate-independent exponential smoothing
  (`MORPH_RATE`), so switching views morphs the panels between arrangements.
  First mount initialises straight to target (no fly-in); settled groups
  early-out so idle cost is ~one branch per node.
- **Hand-frame anchoring (retained, unused).** The `hand` frame in
  `ReferenceFrameGroup` reads the off-hand controller's grip pose
  (`gl.xr.getControllerGrip`, selecting the `left` input source when present) and
  anchors the whole arrangement to it, falling back to a head-anchored frame when
  no grip has a live pose. The flat preview parks the hand-local layout at a
  static anchor. No current view requests this frame.

## Follow-ups / known gaps

- **Legacy view migration.** `standard` and `carousel` still use bespoke slot
  functions + renderer branches. They should migrate onto arrangements once the
  new path is battle-tested, at which point the branches in `XRSceneGraph` shrink.
