# Spatial page presentation — research & implementation plan

Status: **implemented** (elevator / wall / deck 2026-07-27; rooms +
link previews 2026-07-28; elevator redesigned as section rings and wall
redesigned as an outline board 2026-08-01).
Companion to `views-plan.md`.

> **2026-08-18 — the elevator was removed.** It introduced no new spatial
> concept: it was Rooms' "navigate the site as an environment" laid out
> vertically — a different navigation configuration of the same idea, not a
> different way of relating to the document — and keeping both weakened the
> distinction the other views carry. The shipping page views are **rooms**,
> **wall** and **deck**. The elevator material below is kept as the design
> record of a view that was built and then dropped; its placement layer
> (`elevator()`, `computeElevatorShell`, the `ELEVATOR_*`/`ATRIUM_*` constants)
> and `scene/elevator-decor.tsx` no longer exist. The legacy `standard` and
> `carousel` views went in the same pass.

**Rooms → arriving is not passing through (2026-08-02, fourteenth pass):**

- Squaring the reader up fired on "no movement key held THIS FRAME", which is
  true in every gap between key repeats — so walking through a room span the
  view at each mark on the way. It now needs a real stop: `SQUARE_AFTER`
  (0.3 s) of stillness, and the reader within `SQUARE_RADIUS` (0.32 m) of the
  middle of the mark rather than anywhere in its 0.55 m claim radius.
  Verified by replaying the rule frame by frame over a stuttering key stream:
  walking the length of a room turns the view 0 times, stopping on a mark
  turns it once, stopping a metre off it leaves the bearing alone.
- **Clicking a spot puts the camera back on the reading line.** The building
  is carried so the page lands on the panel slot — but the preview's camera
  is OrbitControls', orbiting swings the eye around that slot, and a page
  reached from 90° round lands edge-on: correctly placed, uselessly viewed.
  `useReadingView` restores the preview's default vantage (one reading
  distance in front of the panel centre, a little above) as part of going to
  a spot, which is what "take me to this page" has to mean once the camera is
  free. Needs `makeDefault` on the OrbitControls so the scene can find them;
  no-ops in an immersive session, where the headset is the camera.

**Rooms → walk where you look (2026-08-02, thirteenth pass):**

- Orbiting or panning the preview camera reversed the keys. Movement was
  defined relative to the STATION — the building is carried so the reader's
  bearing lands down −z, and the keys assumed the viewer was looking from
  there. Untouched, the two agree; drag the camera round and they diverge,
  until at 180° every key is backwards.
- Movement is now taken from the CAMERA's own heading, rotated back into
  building space (`Ry(pose.yaw)` undoes the group's turn). It reduces exactly
  to the old formula for an untouched camera, so nothing changes until the
  camera moves — and in XR it is simply "walk where you are looking", which
  is what a headset should do anyway.
- Verified by replaying the algebra at five reader bearings × six orbit
  angles: a landmark on the camera's axis closes by exactly one step every
  time, so W always walks along the camera's heading.

**Rooms → a wider lens for the preview (2026-08-02, twelfth pass):**

- The flat preview's 60° camera sits one reading distance from a panel as
  wide as that distance, so the page fills the frame by construction. Right
  for a view whose subject IS the panel; wrong for `rooms`, where the reader
  is standing in a room and the room is the point. `PreviewFieldOfView` now
  widens the preview lens to 82° in rooms (`ROOMS_PREVIEW_FOV`), which brings
  the floor, the ceiling, the side walls and the neighbouring pages into
  frame without moving the reader off the reading mark — the alternative,
  standing further back, would have shrunk the text with it.
- Preview only: in an immersive session the field of view belongs to the
  headset, so the effect no-ops while presenting.

**Rooms → stopping on a mark squares you up (2026-08-02, eleventh pass):**

- Walking onto a spot claimed the focus but deliberately did NOT turn the
  reader — so the page you were "reading" could be anywhere relative to where
  you were looking, which reads exactly as "the camera is not facing the
  panel". Now: **let go of the movement keys while standing on a spot and the
  reader turns to face its page.** Once only, so someone who then looks
  elsewhere stays looking elsewhere, and the position is never touched, so it
  can never shove anyone through a wall. Turning while walking still wins —
  it only fires when nothing is held.
- The pose's initial bearing was π (facing away, a leftover of the old
  convention) until the focused page replaced it; it is 0 now, which under
  the one convention looks down −z at the panel slot.

**Rooms → one yaw convention (2026-08-02, tenth pass):**

- Every movement key was reversed, and the reader kept ending up not facing
  the page. One root cause: TWO contradictory yaw conventions. `poseFacing`
  gave the reader the page's bearing PLUS π, and `roomPoseTransform` turned
  the building by `π − yaw` to match. The two errors cancelled for the page —
  which is why the "square on" check passed and hid the bug — but
  `useRoomWalking` moves along `(−sin yaw, −cos yaw)`, so what the keys
  called forward came out BEHIND the viewer, and every key with it.
- One convention now, stated where it is defined: the reader's forward is
  `(−sin yaw, −cos yaw)` — yaw 0 looks down −z, + turns left — the reader's
  bearing equals the bearing of the page they are reading, and the building
  turns by `−yaw`.
- Verified by what the VIEWER sees rather than by the maths agreeing with
  itself: a landmark two metres "forward" now appears two metres in FRONT
  (it appeared two metres behind before); and on three different pages, W
  walks toward the page, S away, A slides it right, D left, ← swings it
  right, → left. Standing on a spot still puts its page dead ahead at
  reading distance, and the earlier door/wall/spot checks all still pass.

**Rooms → clicking a spot turns you to face it (2026-08-02, ninth pass):**

- Clicking a spot set the focused page and left the turning to the focus
  change — so clicking the spot you were ALREADY reading did nothing, which
  is exactly when a reader clicks one: they have wandered off the mark and
  want to be put back square on. `goToSpot` now writes the pose directly
  (position and bearing), so a click always stands the reader on the spot
  facing the page, whether or not the focus moved.
- **The next room's spots show through the doorway.** The field draws the
  spots of the room the reader is in AND the next room's, fainter — a place
  to go rather than a place you are — so looking down a corridor shows where
  the reading positions are on the far side before you walk in. Only the
  spots: the room itself still does not exist until entered, and the walls
  occlude the rest, so what reaches the eye is this room plus whatever the
  doorway frames.
- Verified: every spot stands the reader square on to its page — applying the
  renderer's own walk transform to the pose a spot gives lands that page dead
  ahead at the panel slot, for all 24 pages of the test plan.

**Rooms → spots on the floor, and pages that come to life as you near them
(2026-08-02, eighth pass):**

- **The pagination widget is gone from rooms.** A page-at-a-time control
  belongs to a panel you sit in front of; in a building you walk. In its
  place every page has a **blue spot on the floor** at reading distance,
  square on to it (`computeReadingSpots` + `<ReadingSpots>`), numbered, with
  the one you are on filled and ringed. Walk onto a spot and that page is the
  one you are reading; click one to be taken there. Walking onto a spot
  changes the focus WITHOUT moving the reader — being teleported to a pose
  you are already standing in would yank the floor out from under a walk.
- **Visibility follows the reader, not the page number.** A page renders for
  real once the reader is within `ROOM_LIVE_RADIUS` (4.2 m, about three
  reading distances) and stays a numbered ghost card until then. In a small
  room that means the whole section is live at once; in a big one the far
  wall is page numbers you walk up to, which is what a big room looks like.
  The reader's position is state, updated every 0.6 m of walking rather than
  every frame — the pose itself stays in a ref precisely so walking does not
  re-render the field.
- Verified on the real document and on deliberately big rooms: every spot is
  exactly one reading distance from its page, inside that page's own room and
  clear of the walls; a room of ≤ 6 pages is entirely live from any of its
  spots; a 20-page room shows 6 live and the rest as numbered ghosts from its
  first spot.

**Rooms → a link door has to be meant (2026-08-02, seventh pass):**

- With the doors finally there, walking into the links corridor teleported
  the reader straight to the first external link. The trigger fired on
  distance alone, at 0.55 m — but a corridor is only 1.15 m from its centre
  line to a wall, and a reader leaving a room from a reading pose is already
  half a metre off-centre, so the first door caught them in passing.
- Going through a link door now takes all three of: being pressed against the
  leaf (0.38 m, and the walk stops at 0.24), MOVING AGAINST its face rather
  than along it, and staying there for `DOOR_DWELL` (0.45 s). Clicking the
  leaf is still the instant way through.
- Verified by replaying the renderer's exact trigger over walks a reader
  really makes, on the real document: walking straight out of all 29 pages'
  rooms and on down the corridor opens nothing; brushing along the wall past
  a row of doors opens nothing; walking deliberately into one opens it.

**Rooms → the link doors were never there (2026-08-02, sixth pass):**

- Anand asked whether the external-link doors actually exist. They did not.
  `sectionLinksFor` bucketed links by `plan.entries[link.id].pageIndex`, and
  run against the real pipeline **not one link has one**: an inline link has
  no layout entry of its own — the paragraph around it is what pagination
  stamped, and the link is drawn as one of that paragraph's inline runs. So
  every link was dropped and every links corridor came out empty. The
  collector now walks the panel's subtree carrying the page down and takes a
  link's page from its nearest placed ancestor (which also gets them in
  reading order, which iterating the primitive map never guaranteed). On
  `test-elements.html` that is **16 links → 16 doors** across 5 sections,
  signed with their own text ("mid-sentence inline link", "External Alpha").
- He also thought the doors between sections were blocked. Re-checked with
  the real 22-section document: **22/22 rooms and 16/16 link doors are
  reachable on foot** from where page 1 stands, so the widened doorways of
  the fifth pass did fix the geometry. What was left was legibility — an
  opening in a dark wall reads as wall — so **the lintel over every doorway
  is now picked out in the trim colour**, which is what tells a reader down
  the corridor that there is a way through.

**Rooms → doors that open, a floor to stand on (2026-08-02, fifth pass):**

- **The movement block was the doorways.** A door was 1.2 m wide and the
  reader 0.3 m across, so only a ±0.3 m band of a 2.3 m corridor got through
  one: walk even slightly off-centre and the jamb caught you, and since the
  push was straight into it, sliding could not help. Found by flood-filling
  the building with the real `roomWalkStep` — an off-centre walk stopped dead
  at the first room's near wall while a dead-centre one sailed through. Doors
  are now 1.9 m (nearly the corridor's width), the reader 0.24 m, and
  `roomWalkFunnel` steers a blocked step toward a doorway that is nearly
  lined up, so a door you are aiming at is a door you get through. Re-checked
  the same way: every offset up to 0.8 m off the spine now walks the length
  of the building without stopping.
- **A floor and a ceiling.** `computeRoomSlabs` gives every space — lobby,
  each room, each links corridor — a floor and a ceiling; they tile the spine
  end to end with no gaps, at 1.95 m of head height. The floor is a shade
  lighter than the walls so the reader can see where the ground is; the
  ceiling matches the walls and just closes the space. Without them a room
  was four walls in a void.
- **External links are doors to another gallery**, not plates on a wall. Each
  link in a section cuts a real opening in its links corridor, filled by a
  leaf carrying the link's text over where it goes. Walking into the leaf
  goes through it, and so does clicking it — both route through
  `NavigateContext`, the same path an inline link inside a page takes. The
  leaf is solid, so the reader stops against it rather than stepping into the
  void, and that stop IS the door being used. Checked: every door has its
  opening cut, walking at one stops 0.27 m away (inside the 0.55 m
  activation reach), and a walk down the middle of a corridor passes them at
  1.15 m — far too wide to trip one by accident.

**Rooms → an enfilade you walk through (2026-08-02, fourth pass):**

Anand, on the third pass: the nameplate was invisible, both of a room's doors
opened onto the same corridor, the walls were too tall, a room should not be
rendered until you have entered it, all of a room's panels should be visible
once you are in it — and should there be controls for moving? Yes, there
should. Everything below is that pass.

- **The building is a straight enfilade**, not rooms hanging off one
  corridor: lobby → room 1 → the links of section 1 → room 2 → … Each room's
  entrance is in its NEAR wall and its exit in its FAR wall, so the two doors
  genuinely lead to different corridors — you came from the one behind and
  you leave into the one ahead.
- **Pages alternate the two side walls** as they advance, so reading a
  section walks the reader from its door in to its door out, and every page
  is one turn of the head away.
- **Walking.** The reader now has a POSE in the building — where they stand,
  which way they face — held in a ref and written straight from the frame
  loop (`useRoomWalking`). W/A/S/D or the arrow keys walk and strafe, ←/→ and
  Q/E turn. Focusing a page still stands the reader square-on to it: the two
  are the same mechanism, one reader with one pose, which is why
  `computeRoomWalk` is gone and `roomReadingPose` + `roomPoseTransform` took
  its place. **`roomWalkStep` makes the walls solid**, sliding a blocked step
  along the wall instead of sticking, so a doorway is the only way between a
  corridor and a room — which is what makes the doors mean anything.
- **A room is not rendered until you are in it.** `roomAtPose` says which
  room the reader is standing in (generous by a doorway's slack so nothing
  pops at the threshold), and only that room's pages are mounted — plus the
  focused page wherever it is, so its pagination controls survive a walk out
  into the corridor, hidden behind the walls in the meantime. In exchange,
  every page of the room you ARE in renders live rather than as an imposter
  (up to `ROOM_ALL_LIVE_MAX`).
- **The nameplate was invisible** because it sat a centimetre INSIDE the
  wall it hung on — from the corridor you saw its back through the wall, which
  is what put mirrored text in the screenshot. Everything mounted on a wall —
  pages, plates, plaques — now sits `MOUNT_PROUD` in front of the wall's own
  plane, and the walls no longer shuffle backwards to compensate.
- **Walls came down** from 2.55 m to 1.95 m of world height, with a 1.62 m
  doorway leaving a lintel for the nameplate.
- Verified offline: focusing lands each page on the panel slot square-on AND
  puts the reader inside that page's own room; walking down the spine enters
  room 1 and carries on through room after room, while the same walk started
  off-centre is stopped dead by the room's near wall; every plate and plaque
  lies on a wall surface, plaques on the lintel. A floor plan rendered from
  the same functions shows the enfilade. **Not verified interactively:** the
  headless preview pane never fires `requestAnimationFrame`, so the frame
  loop is frozen there and the key handling could not be exercised — the
  movement maths (`roomWalkStep`) is covered offline instead.

**Rooms → a corridor of rooms, with doors (2026-08-02, third pass):**

Anand: "doors to enter the room, so basically it's a corridor of rooms with a
room nameplate — the section name — and then when you enter the room you see
that section's pages, and you have two exits: one you came from, and one
where all the related links for that page are, and then again another
corridor." That is the building the view now generates.

- **One corridor runs the document's length**, walled both sides, starting in
  a lobby. Every top-level section is a ROOM off it, rooms taking alternate
  sides in reading order.
- **Two doors per room, both on its corridor wall**: the one you come in by
  at the near end, the way out at the far end. They are real openings — the
  shell's `wallRun` breaks a wall around each doorway into the pieces either
  side plus the lintel over it — and the section's **nameplate hangs on that
  lintel**, facing the corridor, so you read a room's name before you go in.
- **Inside**, the section's pages hang around the room's three other walls,
  life-size, facing in: near-end wall from the door outward, the long far
  wall facing the corridor, then the far-end wall back to the exit — so
  reading the section through leaves you at the way out.
- **Out of the far door is the links corridor**: a stretch whose two walls
  carry that section's RELATED LINKS as plates (the link's own text over its
  destination host, or "↳ anchor" for a fragment), and clicking one follows
  it through `NavigateContext` — the same route an inline link inside a page
  takes. The stretch is as long as its plates need. Walking on down it
  reaches the next section's door. `computeLinkPlates` + `<LinkCorridor>`;
  the links themselves are collected by `sectionLinksFor` in page-ghosts,
  which buckets every `XRLink` primitive by the page pagination stamped it
  onto (capped per section so a link farm cannot stretch the building).
- Because the stretch lengths come from the link counts, **every rooms entry
  point takes the same `sectionLinks`** — placements, walk, shell, plates and
  plaques all derive one `museumPlan`, so their floor plans cannot disagree.
- Verified offline: identity landing for every focus, no page interpenetration
  (≥ 0.12 m), a rigid building, the reader never standing closer than 1.2 m
  to any wall, and every link plate lying on a corridor wall. A top-down plan
  and an ELEVATION of the corridor wall were rendered from the same functions
  — the elevation is what caught the nameplate floating above the roofline
  (fixed by giving the walls enough headroom for a lintel). In the app on
  `test-elements.html`: a page reads dead ahead on its room's wall with the
  side walls and floor around it, and ‹ › walks through the doorway into the
  next room.

**Rooms → a section IS a room, its pages ARE the walls (2026-08-02):**

- Anand: the room should be an *actual walk-in*, not the current page
  zooming in — and then, on seeing the first cut: "I was expecting section's
  pages to be like walls that made up the room." Both notes land on the same
  redesign, and the ribbon-of-folds geometry is gone.
- **The floor plan.** Every top-level section becomes a **three-walled room
  opening onto a central aisle** (Anand's original aisle sketch is now the
  museum's spine), rooms alternating right and left in reading order, one
  pair per band of aisle. The section's pages hang **edge to edge around
  those three walls**, life-size, facing in, so the reader inside a room is
  enclosed by that section and the wall opposite is a wall of readable
  pages. A room's circuit starts and ends at its mouth — the ENTRY wall
  running from the mouth outward, the long FAR wall, then the EXIT wall back
  to the mouth — so reading order is one loop that finishes where the next
  room begins. Rooms are sized from their own page count (far wall ≈ a third
  of the pages, side walls the rest, which keeps a room roughly square
  however long the section), floored at a span you can stand inside.
  `roomPlan` / `roomCell` / `computeRoomShell` in `page-placements.ts`.
- **The walls are real surfaces.** Pages alone floated in the dark, so each
  room also gets the three planes its pages are hung on: `computeRoomShell`
  returns them (standing on the world floor, carrying a head above the page
  band, set back 3 cm so pages read as hung ON them rather than z-fighting)
  and `<RoomShell>` draws them double-sided in `navBg`, raycast-inert. A
  room has to be a solid box with one open side or the rooms beyond show
  through and the enclosure is gone.
- **No stage — you walk.** Nothing ever flies to the reader. Focusing a page
  — clicking it, or paging with ‹ › — **moves the reader**: `computeRoomWalk`
  returns the rigid transform that puts the viewer square-on to that page at
  `viewingDistance`, and `scene/room-walk.tsx` wraps the whole field in ONE
  eased group that applies it. Because the museum morphs as a body instead
  of cell by cell, a change of focus reads as walking (and turning) through
  it; the pages beside the one you are reading are the ones physically
  beside it, and the room you walked out of is still behind you.
- **The world moves, not the camera.** The flat preview's camera belongs to
  OrbitControls and the immersive one to the headset, and keeping the reader
  at the origin is what lets the in-world chrome, `readingLook` and the XR
  recentre go on meaning what they mean. The walk stops square-on at exactly
  the reading distance, and exhibits are the panel's own size, so the
  focused fold lands ON the main panel slot — the reading pose is identical
  to the flip view's, and the walk is y-invariant so panel clipping (built
  from world y) is untouched.
- **Plaques are door signs**: one per room, on the mouth's edge, facing the
  aisle, so you read a room's name from the corridor before walking in (and
  from the room across from it).
- **Dimming follows the reader**, not the document: recession is now the
  distance from where the reader is standing, so the room you are in is the
  bright one wherever you have walked to.
- A document with no sections degenerates cleanly: one range, so one room
  with every page around its walls.
- Verified offline (`page-placements.ts` is node-importable): for every
  focus the focused page lands at identity, square on, full size; page
  rectangles clear each other by ≥ 0.12 m; pairwise distances are
  focus-invariant (the museum really is rigid); every page lies on a wall of
  its own room; and the reader's station is inside that room's walls for
  every page. A top-down floor plan rendered from the same functions
  confirms the enfilade. Verified in the preview on `test-elements.html`
  (29 pages, 22 sections): page 1 reads dead ahead on its wall with the
  room's side walls and floor around it, and ‹ › walks — visibly, corner
  swinging past — out of one room and into the next.

**Removed 2026-08-02:** the `grid` mode (toggle label "Sections" — the
section×page matrix of §2.4 / §4.3 / Phase 3 below) was deleted along with
the landmark-scattering views. Its research section, design section and
roadmap phase have been removed with it; the remaining page views are
`elevator`, `wall`, `deck` and `rooms`.

**Wall → an outline board that opens one level at a time (2026-08-01):**

- The contact sheet of every page is gone. The wall's first view is the
  document's **outline: one tile per ROOT+1 section** — `plan.sections`
  filtered to `depth === 0`, i.e. the panel's top-level sections, which is
  what `sectionRangesFor` already produced for deck/rooms. A
  hundred-page article is a dozen tiles, which is what a wall is good for; a
  hundred thumbnails was not. A tile carries the section name and its page
  count, and a ▸/▾ chevron for its state.
- **Clicking a tile expands it IN PLACE** into that section's pages, spliced
  into the board right behind the tile, which stays at the head of its run
  (click it again to close). The rest of the board **reflows around** the
  run rather than being replaced, so the sections you did not open keep
  their place on the wall — and with it their spatial memory (P1). Pages
  near the one being read render as real mini renders; the rest are the
  usual imposter cards.
- **Clicking a page preview grows it to FULL SIZE** (scale 1) in a
  `WALL_OPEN_SPAN`² block of the same grid, and only that page is
  interactive — links live, everything else is one hit target. **There is no
  stage** (Anand, 2026-08-01, per his mockup): every level of the disclosure
  happens in the board, nothing flies to a separate reading slot.
- **The opened page gets a BAND of its own** — the whole of
  `WALL_OPEN_SPAN` rows, starting on the first row after every cell that
  precedes it in reading order, with the page centred in it. So the board
  reads strictly top to bottom: the cells before the page in complete rows
  above the band, the page, then the cells after it in complete rows below.
  **Nothing is ever beside the page**, which is the whole point. Because
  every other cell is 1×1 and they fill without holes, "the cells that
  precede it" is just the page's index in reading order, so the band's row
  is `⌈i / cols⌉`. `wallColumns` counts CELLS rather than area precisely so
  opening a page cannot change the column count and reflow the board.
  Three earlier versions got this wrong, each visible only on a particular
  page (all three, and the sectionless and last-section cases, are now in
  the offline check):
  1. First-fit put the block at the earliest slot it fitted, so opening the
     LAST page of a section yanked it to the front of the board.
  2. Centring the block on its own cell and clamping into the grid broke at
     the END of a document (Anand — "shouldn't the last page expand in its
     place but it now expands outside to the top and messes the reading
     order"): the last page's cell is near the top of a short board, so the
     clamp pulled the block to row 0 and pushed every tile that should
     precede it underneath.
  3. Anchoring the block's top-left on its own cell fixed both, but left the
     remaining cells flowing in a narrow strip beside it — and when the
     block sits right of centre that strip is on its LEFT, so reading ran
     backwards and down (Anand, on the first page of a 13-page section —
     "it goes to the last row and the order might be a bit confusing"). A
     side strip reads badly whichever side it lands on: the cells next in
     order end up level with the middle of a five-row block.
  The tail of the row before the band is left dead — a line break before a
  full-width figure, rather than a later cell reaching backwards into a hole
  that sits before the page in reading order.
- **The rest of the board keeps its reading order**, row-major, above and
  below the band. A version that arranged the other cells as a ring on the
  block's four sides with the corners left empty was built and then
  withdrawn (Anand, 2026-08-01 — "don't surround, keep the order of the
  opened same, that was a mistake from my end"): with a 5-wide block and
  one-cell sides, ring order zig-zags across the page and you cannot tell
  which cell is the next page. Leaving the order alone means "which cell is
  next" is the same question it was before anything opened.
- **Only the opened PAGE steps off the wall toward the reader.** An expanded
  section's tile stays flush with the board; lifting it too (the `open` flag
  covers both) put a thumbnail at reading distance right in the reader's
  face for no reason — its accent bar and ▾ already say it is open.
- **Hovering any cell leans the WHOLE board toward it** (Anand, 2026-08-01).
  A cell's face is +z and the Euler (φ, θ) turns it to
  (sin θ, −sin φ cos θ, cos φ cos θ), so +θ looks right and −φ looks up;
  the lean is `WALL_TILT_MAX · tanh(Δ / WALL_TILT_FALLOFF)` per axis, which
  saturates about a cell away so neighbours lean hard and the far corners
  still lean. The full-size page is the one exemption — it is a reading
  surface, not scenery. Because hover is an *input* to `computeWallCells`,
  the lean is plain eased rotation through `AtPos`, with no animation code.
- Everything is one reflowing grid, so all three states are the same layout
  problem: `computeWallCells` builds a cell list (section tiles, plus the
  open section's pages, plus the open page at `WALL_OPEN_SPAN`² ), picks a
  column count, first-fit packs it row-major, and gives each cell the arc's
  yaw/pushback plus the lean. Reading order survives packing; the only
  reordering is small cells backfilling the gap beside the open page's
  block, which is exactly where the mockup puts them.
- **The tile scale is a constant, never fitted to the row count.** An
  earlier version shrank the whole board to fit inside the panel's volume
  so it could never grow into the in-world chrome — but that resized every
  tile whenever anything opened, which undoes the point of leaving closed
  sections where they were. Instead the board keeps a fixed cell size,
  `WALL_MAX_ROWS` is 3 so it grows along the cheap horizontal axis (P3), and
  the separation from the chrome is in DEPTH: the board stands
  `WALL_BACK` (0.55 m) behind the reading plane and an opened page lifts
  back to it (R4).
- `WALL_OPEN_SPAN` is 5 because that is the smallest square block holding a
  whole panel in BOTH axes at the tile scale — "full size" has to mean full
  size, not almost.
- Navigation: click to open/close, ✕ on the full-size page (a plane over it
  would eat every link), Escape steps back one level, ←/→ walk the open
  section's pages or, with none open, the outline. A focus change the board
  did not make (a `#fragment` jump, R3) opens the section owning that page.
- Known gap: with a page open the board is ~7 rows, so its top row rises
  past the panel and the in-world view toggle projects over it in the flat
  preview (0.55 m in front of it). The proper fix is R4's per-mode chrome
  anchor, which is a change to `XRSceneRenderer` affecting every view — not
  done here.
- Implementation: `computeWallCells` + `wallSectionOf` in
  `page-placements.ts` (pure, AABB-checked offline: overview fits inside the
  panel's own height, no overlaps in any state, full-size page at scale
  1.000, the band landing right after the cells that precede its page with
  nothing beside it — first page, last page, mid-section, first section and
  last-section-of-the-document all checked — reading order still strictly
  row-major across the whole board with the band in it, every cell turns
  toward the hovered one); `scene/wall-field.tsx`
  for state + rendering; the cell components the two fields share moved out
  of `page-ghosts.tsx` into `scene/page-cells.tsx` so neither imports the
  other. `computePagePlacements("wall")` now returns `[]` — the wall has its
  own model because its cells are sections as well as pages.

**Elevator → a building of section rings (2026-08-01):**

- The vertical page column is gone. Every **NAMED section is a floor —
  subsections included**. The spans come from **`plan.sections`, which the
  layout engine now stamps** (`src/layout/outline.ts`, Anand's call): only
  pagination knows which page a primitive landed on, so the engine is the
  stage that owns the outline, and the page views stop re-walking the panel's
  whole subtree on every focus change. `deepSectionRangesFor` /
  `sectionRangesFor` in `page-ghosts.tsx` are now thin filters over it (all
  named sections vs. `depth === 0`) plus the gap-filling that makes the
  ranges disjoint — presentation policy, which stays renderer-side.
  Unnamed sections are skipped, not floored: structural inference also emits
  sections for things like paragraph runs, and each of those became an
  anonymous storey with a blank sign. Consecutive floors resolving to the
  same heading (a parent and its first child) collapse too.
  A floor is a **cylinder of that section's pages built around the
  reader**: the ring axis passes through the viewer, so every page sits at
  reading distance and faces inward (yaw = −θ). The focused section's floor
  is the one you stand on; the previous/next sections' rings hang one storey
  above and below, so the shaft reads as an atrium you ride through
  (`ELEVATOR_FLOOR_WINDOW = 1`).
- The ring is **fixed, not a lazy Susan** (Anand, 2026-08-01): the section
  name is always dead ahead at the centre. Because the room never spins,
  where a page sits on the wall is a stable thing to remember.
- **Reading order wraps clockwise from the name and closes back at it**
  (Anand, 2026-08-01, per his mockup). Page 1 sits one slot to the RIGHT of
  the plaque, page 2 two slots, on around the back, until the last page
  arrives one slot to the LEFT of the plaque — so a page's arc distance from
  the name is just its number × the slot arc, and the circle closes.
  `elevatorAngle` is simply `wrap((k + 1) · step)`. For an 8-page section:
  Content 1 and 2 at 40° and 80° right, Content 7 and 8 at 80° and 40° left.
  (An earlier version centred the run on the plaque, putting page 1 at the
  far left with the seam at the back; the one before that ran anticlockwise.)
- **Nothing flies to a reading position** (Anand, 2026-08-01). The elevator
  has **no stage**: every page sits in its slot, and the page under the
  pointer/ray is emphasised *in place* by `elevatorEmphasis` — grown to full
  scale and closed in along its inward normal until it sits at reading
  distance. Hover state lives in `PageGhostField` (`pointedAt`), which also
  forces the pointed-at page live so you magnify a real page, not an
  imposter card.
- **Being the current page earns no special treatment** (Anand,
  2026-08-01). It is drawn in its slot at ring scale like every other page,
  and gets a hit plane like every other page; `isStage` survives only as
  "the live, interactive one". Emphasis is something the pointer does.
- **Slot arc, not an even division** (Anand, 2026-08-01 — "the pages are too
  far apart, they should be next to each other"). A slot is one page WIDE
  (`ELEVATOR_ARC_GAP` 0.08 m), so `elevatorStep` is that arc over the radius
  and neighbours always touch; `elevatorRadius` is whatever makes one turn
  hold the name plus every page, floored at reading distance + the wall
  standoff and capped at 3.2 m. A section big enough to need it gets a
  bigger room; one too small to fill a turn leaves the arc behind the reader
  empty rather than spreading its pages out to fill it.
- `EasedScale` (page-ghosts) eases a scale CHANGE without touching how any
  size is computed: children are already built at the new scale, so the group
  starts at the old/new ratio and relaxes to 1. Cells whose scale never
  changes sit at 1, so wall/deck/rooms are unaffected.
- **Naming a section is `outline.ts`'s `sectionName`, and it is fiddlier
  than it looks.** The heading's own text when it has any — but on the
  Wikipedia article every subsection but two carries an `XRHeading` node with
  *no text on it*, the heading line sitting at the head of the SECTION's
  content instead, so that first line is the fallback. `label` is never used:
  it falls back to the synthesized node id, which is how
  "main-node-4-node-12-node-14-section-1" reached a sign. A section with no
  heading at all has no name. (The same id leaks into the TOC primitive in
  the standard view — that comes from the parser/mapper, which are frozen, so
  it is left alone.)
- **Navigation is keys and pointing — there are no pagination controls**
  (Anand, 2026-08-01; `LivePageGhost` takes `controls={false}`). A
  page-at-a-time widget makes no sense in a room you look around. ↑/↓ ride
  a storey (previous / next section, via the exported
  `elevatorFloorTarget`), ←/→ step a page around the current ring. The
  handler ignores events from inputs so the URL bar keeps its arrows.
- **The name is a slot on the ring, not a floating caption** (Anand,
  2026-08-01). A floor of `n` pages occupies `n + 1` slots; slot j = 0 is
  the plaque, dead ahead, and `elevatorAngle` gives the pages the slots
  either side of it. Every plaque sits at its own ring's band height, in the
  wall with its pages, and `FieldLabel.card` makes the renderer draw it as a
  PANEL filling that slot — the same size as the pages flanking it, dimmed
  with `FieldLabel.opacity` on the neighbouring floors. The current floor's
  card just gets a larger face. `wrapAngle` is half-open at the BACK
  (`[−π, π)`) so a full-turn ring's first page stays on the left where
  reading order starts instead of flipping to the right end.
- The ring wall stands `ELEVATOR_WALL_STANDOFF` (0.2 m) beyond reading
  distance, so an emphasised page has somewhere to travel toward the reader.
- **Radius** is whatever makes one turn hold the name plaque plus every page
  at one slot each, floored at that wall distance and capped at 3.2 m — past
  the cap the ring windows around the focus (a sectionless 98-page article
  shows 19 pages). Because the slot arc is fixed, apparent size and
  neighbour spacing are constant however long the section is: the room grows
  instead of the pages cramping.
- **Storey height** clears a FULL-SIZE page, not just a ring-scale one:
  `(h + h·S)/2 + gap`, because any page on the ring can be emphasised up to
  full size.
- **The rings you're not standing on are translucent scenery.** They run to
  near-full recession, and the new `PagePlacement.offFloor` makes the
  renderer draw them as dimmed imposters however close their page index is
  to the focus — without it an adjacent one-page subsection rendered as a
  full live ghost with undimmed text, which read as a second, competing
  reading panel.
- **Section names** are per-floor marquees (`computeFieldLabels` now covers
  elevator as well as rooms), always centred. The reader stands on the ring
  axis, so the geometric centre is their own head — the name goes at the
  centre of each floor's *view* instead: over the stage for the current
  floor, at the ring front for the floors above/below, hung on each
  neighbour's OUTWARD side (over the floor above, under the floor below) so
  the full-height stage can't clip it. A headingless floor gets no sign
  rather than a fabricated "Section N".
- **One section = one storey, never merged** (Anand, 2026-08-01). Documents
  often section far finer than they paginate — the renderer test page is 22
  sections over 29 pages — so those floors are single pages and the ring
  degenerates to just the stage. `elevatorFloors()` therefore only clamps
  ranges disjoint and in-bounds (two sections starting on the same page must
  not place that page twice); it does not combine them.
- Needs `sectionRanges` + `viewingDistance` in `PagePlacementOptions`
  (`page-ghosts.tsx` now computes section ranges for elevator too).
  Verified offline: pages face the axis, min neighbour chord ≥ page width in
  every case, floors clear the stage, radius fixed ≤ 7 / growing > 7.

**Rooms + link previews (2026-07-28)** — the rooms half of this entry is
superseded twice over (by the aisle-and-ribbons sketch, then by the walk-in
above); kept for the link-preview half and the history:

- **`rooms`** — the museum mode, redesigned 2026-07-28 to Anand's sketch:
  the room is built AROUND the viewer, one section at a time. The focused
  page is the room's centre wall dead ahead (the stage — identity
  placement), and the rest of the SAME section's pages wrap around the
  viewer as the side walls of a U (earlier pages sweep the right wall,
  later pages the left, so reading order flows right → centre → left, like
  turning through a room). Pages past the wall's ~99° reach pile up at the
  two ends, where the neighbouring sections' edge pages sit as door
  handles; focusing one — or just paging past the section boundary — morphs
  the ENTIRE room into the next section's (the a=0 wall cell degenerates to
  the stage transform, so the morph reads as the room rotating around you).
  Plaques: current section name over the stage, neighbour names with arrows
  over the door stacks. Other sections' interior pages are not placed at
  all — one room at a time. Implementation: `rooms()` + `roomWallCell()` +
  `computeFieldLabels` in `page-placements.ts` (needs
  `LayoutConfig.viewingDistance`, passed via `PagePlacementOptions`).
  Verified on the 98-page Wikipedia article: clicking a wall page morphs
  the room around the new focus.
- **Link previews** (challenge 6, tier 1) — dwelling ~350 ms on any inline
  link spawns a tethered card at the hit point showing the link's text and
  target (domain, or "jump to section" for fragments), dashed-tether to the
  glyphs, in every view. `scene/link-preview.tsx` (context + card) hooks the
  existing per-glyph link hit-rects in `primitives/inline.tsx` (which now
  carry the link label). Cards are raycast-inert so they never steal the
  click. Next tier (future): mount a proxied mini-pipeline render of the
  target page inside the card on select, and doorway-load targets in rooms.

## 0. Implementation snapshot (what actually shipped)

The build simplified further than the plan below describes — during
implementation, `CarouselGhostPanel` turned out to already be the "render a
page at an arbitrary transform" mechanism, so page views became: **the real
panel renders at the main slot unchanged; a ghost field renders every other
page around it.** No changes to page gating, `CurrentPageContext`, or the
panel renderer at all.

- `src/layout/types.ts` — `PageDistribution`, `Arrangement.pageDistribution`,
  `LayoutEntry.suppressed`, `LayoutPlan.contentOnly` / `.pageDistribution`.
- `src/layout/content-only.ts` — pure `foldSceneContentOnly` (banner/asides/
  footer → panel flow, reading order; input never mutated).
- `src/layout/placement.ts` — four new content-only arrangements; roster
  collapses to `[main]`, which by itself disables aside extraction (it was
  already gated on `!!slots.complementary`).
- `src/layout/engine.ts` — suppressed stub entries for slotless landmarks
  (nav/TOC) in content-only mode; plan stamps. ~30 lines.
- `src/renderer/page-placements.ts` — pure placement math (node-importable;
  AABB-checked offline for all four modes).
- `src/renderer/scene/page-ghosts.tsx` — ghost field: live ghosts within
  ±2 pages of focus, heading imposters beyond, one hit-plane per cell
  (click = focus; links inert on ghosts), focus-cell "● reading" frame,
  `AtPos`-eased so focus changes morph the field.
- `dispatch-children.tsx` / `dispatcher.tsx` — `plan.contentOnly` guard on
  the aside-extraction chokepoint (R2); `entry.suppressed` skip.
- `use-pipeline.ts` — folds the scene before layout for page views.
- `viewTypes.ts` / `ViewToggle.tsx` / `XR3DChrome.tsx` — the four new modes.

**Revision (2026-07-28, after 98-page Wikipedia testing):** the separate
reading panel is gone — in page views the `XRContentPanel` is not
dispatched at all. Instead every page keeps ONE persistent eased ghost
group, and the focused page's placement target becomes the **stage**
(identity transform, scale 1, flat, fully interactive with links +
pagination controls). Clicking a field cell therefore *morphs that page
forward* from its cell to the reading position while the previous focus
morphs back, leaving a "● reading" hole marker in the field. Scale-safety
fixes from the same test: deck piles cap at 6 pages and wrap into adjacent
sub-piles (a sectionless 98-page article fans across the desk instead of
descending through the floor); the elevator emits only a ±6-page window of
its shaft. `pageCount < 3` still falls back to the normal flip panel.

Verified: offline fixture (3 sections + nested & top-level asides + nav →
9 pages) — folding order, no extraction, suppression, stage identity/flat,
floor-safety (tilt-corrected), AABB non-overlap, 98-page sectionless wrap,
and standard-view parity all pass; in-browser on the 28-page renderer test
page AND en.wikipedia.org/wiki/Space (98 pages), all four modes render,
click-to-focus morphs cell→stage, and links work on the stage.

## 1. Problem statement

The two-axis view system (`views-plan.md`) rearranges **landmark panels**
(main / nav / aside / banner / footer) around the user, but the main
`XRContentPanel` itself is still a browser window: pagination splits long
content into N pages and `CurrentPageContext` renders exactly one of them,
flipping like a book. For a long document that paginates into dozens or
~100 pages, the spatial medium is unused — the user sees one page at a time
in a fixed frame.

Supervisor feedback: parsing is good; **presentation is too browser-like**.
The pages themselves (and the sections that own them) should become spatial
objects: spread on a desk, pinned to a wall, stacked like floors, arranged
as a section×page matrix, or built into walkable rooms — with linked pages
made visible too.

## 2. Research grounding

### 2.1 Spatial memory and user-arranged surfaces (→ idea 1: desk/table)

- **Data Mountain** (Robertson et al., UIST '98) — documents placed freely on
  an inclined 3D plane; users' *own* placement builds spatial memory and beats
  standard bookmark lists for retrieval. Key: user-driven placement, subtle
  landmarks on the surface, occlusion cues (shadows) for depth.
- **The Task Gallery** (Robertson et al., CHI 2000) — tasks as artwork on
  gallery walls, selected task on a centre "stage". Validates the
  *stage + periphery* pattern we already use (main slot + rails), and that 3D
  metaphors evoke spatial memory.
- **Documents in Your Hands** (CHI '25) — N=21 study of interaction techniques
  for spatially arranging AR documents across predefined layouts; confirms
  users want quick grab-and-place plus snapping, not free 6-DoF fiddling.

**Takeaway:** a desk mode should give *coarse snapped placement* (piles,
slots) with shadows for depth cues, not free-floating physics.

### 2.2 Walls, boards and shelf curvature (→ idea 2: sticky-note wall)

- **Immersive Space to Think** (Lisle et al., IEEE VR '21 + follow-ups) —
  analysts arranging document collections in VR converge on three layouts:
  **semicircular**, **planar (wall)**, and **environment-based** (leaning on
  virtual structure). Semicircular dominates for overview + reach.
- **Virtual data shelf** (IJCARS '23) — flat vs **curved** vs spherical grid
  shelves compared for browsing large collections: curved wins for overview
  and exploration; spherical disorients.
- **Ethereal Planes** (Ens et al., SUI '14) — design framework for 2D info
  surfaces in 3D: dimensions include reference frame (ego/exocentric),
  discretization (continuous vs slotted), proximity, and input directness. Our
  frame × distribution model is a subset; page placement adds the
  *discretization* axis (slotted grid vs free placement).

**Takeaway:** the "wall" should be a **cylindrical arc centred on the user**
(we already have `PanelCurveContext` + curved panels), with pages as
uniformly scaled thumbnails in a slotted grid.

### 2.3 Vertical arrangements and ergonomics (→ idea 3: elevator)

- Ergonomics literature (and VR comfort-zone patents/guidelines): comfortable
  gaze rests **10–20° below horizontal**; comfortable eye rotation ~±30°
  horizontal; head rotation ~±45°; sustained *upward* gaze is the most
  fatiguing direction. Vertical space is expensive for the neck.
- **Personal Cockpit** (Ens et al., CHI '14) — empirically tuned ego-centric
  window layout; 40 % faster app switching than view-fixed display. Windows
  live in a shallow vertical band around eye height, wider than tall.

**Takeaway:** an "elevator" must **move the content column, not the user's
neck**: the page column scrolls/snaps vertically through a fixed comfortable
reading window, with dimmed prev/next pages as ghosts above/below. (Also
avoids simulator sickness from smooth vertical locomotion.)

### 2.5 Rooms, corridors, museums (→ idea 5: VR rooms)

- **Museum of All Things** (godotengine.org article) — procedurally generates
  a museum from Wikipedia: each article is a room of exhibits, and
  **hyperlinks are doorways/corridors** to the linked article's room.
- **Viki LibraRy** (New Review of Hypermedia & Multimedia, 2024) —
  collaborative hypertext browsing in VR using buildings/rooms as information
  containers; validates rooms-as-pages at study level.
- **RealityMedia** (Frontiers in VR, 2023) — immersive narrative space using
  rooms/galleries per topic.
- **Real and Virtual Spaces: Mapping from Spatial Cognition to Hypertext**
  (Dieberger) — theoretical basis: people navigate hypertext better when it
  borrows architectural schemata (rooms, corridors, landmarks).

**Takeaway:** rooms are the highest-payoff *and* highest-cost mode: they need
floor/wall generation, teleport locomotion, and a link graph → floor-plan
solver. Treat as a stretch phase with a reduced first version (one room per
section, one corridor per section transition, doorframes for top links).

### 2.6 Showing linked pages (→ challenge 6)

- **VRowser** (2018) — VR parallel web browser; pages as spatial panels with
  grouping/retrieval; links spawn adjacent panels.
- **WebDriving** — extracts linked/peripheral pages into the same 3D world so
  the user sees the target page *and* its neighbourhood.
- **Multi-Window Web Browser with History Tree** (UIST '21 adjunct) —
  visualizes browsing history as a spatial tree next to windows.
- **I-Sphere** — site link structure as a 3D node/link object for orientation.
- **LitForager** (2025) — immersive literature foraging with link-following;
  shows tethered satellite previews work for "what's behind this link?".

**Takeaway:** two cheap, mode-independent mechanisms first: (a) **link
ghosts** — hover/point at an `XRLink` spawns a tethered preview card (title/
domain card instantly; full mini-pipeline render on select); (b) a
**link constellation** satellite cluster per page. Doorways (museum mode)
subsume these later.

### 2.7 Distilled design principles

| # | Principle | Source |
|---|-----------|--------|
| P1 | Spatial memory needs *stable, user-influenced* placement + depth cues (shadows) | Data Mountain, CHI '25 |
| P2 | Curved/semicircular beats flat and spherical for overview of many items | data shelf, IST |
| P3 | Horizontal arc is cheap (±30–45°); vertical neck travel is expensive; sustained up-gaze worst | ergonomics, Personal Cockpit |
| P4 | One spatial axis = one semantic variable (section vs page) | multiview studies, Ethereal Planes |
| P5 | Links should be *visible spatial neighbours* (tethered previews or doorways), not hidden jumps | VRowser, WebDriving, MoAT |
| P6 | Move content or teleport; never smoothly translate the user vertically | VR locomotion literature |

## 3. Architecture gap and core abstraction

### Change-surface constraint (hard rule)

All work in this plan touches **only layout and renderer code** — plus the
view-plumbing components and eval tooling. Parser and mapper are frozen:

- **Allowed:** `src/layout/*`, `src/renderer/*`; view plumbing in
  `src/components/` (`viewTypes.ts`, `ViewToggle.tsx`, `XR3DChrome.tsx`);
  `src/eval/*` (metrics exclusions only).
- **Frozen:** `src/ir/*` (parser), `src/mapper/*` (mapper).

Two consequences that shape the design below:

1. **No new primitive types.** `XRPrimitiveType` and the `XRPrimitive`
   shapes live in `src/mapper/types.ts`. So the fold pass must NOT invent an
   `XRCallout` type — instead all page-mode semantics (folded, suppressed,
   page placement) are expressed as **layout-owned data**: fields on
   `LayoutEntry` / `LayoutPlan` in `src/layout/types.ts`, which the renderer
   branches on. Primitive *instances* may be re-parented/cloned by the
   engine (it already injects synthetic paragraph primitives during
   pagination — same precedent), but their types stay whatever the mapper
   emitted.
2. **The pipeline is used, never modified.** Link ghosts *call*
   `parsePageToIR` → `mapIRToScene` on fetched pages exactly as
   `XRSceneRenderer` does today; no parser/mapper behavior changes.

Today: `paginateContentPanel()` produces `PaginationMeta` + a
`pageIndexMap` (primitive → page), every page occupies the *same* panel
volume, and the renderer's `CurrentPageContext` culls all but one page.
Distributions (`fan`, …) place **slots**, never pages.

**Division of labour — placement is presentational, flow is not.** The
engine's job stays exactly what it is today: decide *what content flows on
which page* (heights, breaks, `PaginationMeta`, panel-absolute coords).
*Where each page sits in space* is a pure function of `PaginationMeta` +
view mode + device profile — it needs no per-primitive knowledge — so it is
a **renderer-side presentational transform**, following the precedent
already set by `StackDepthContext` (engine flattens z=0, renderer staggers)
and `PanelCurveContext` (engine plans flat, renderer bends).

**New abstraction — `PagePlacement`, renderer-owned:**

```ts
// src/renderer/page-placements.ts  (pure math, NO three/react imports —
// node-importable so the offline harness can AABB-check placements)
export interface PagePlacement {
  pageIndex: number;
  /** Offset of this page's origin relative to the content panel's slot origin. */
  position: Vec3;
  rotation?: Vec3;
  /** Uniform scale for thumbnail modes (wall). 1 = full size. */
  scale?: number;
  /** 0 = focused/current, 1 = fully de-emphasized (drives dim/shadow). */
  recession: number;
}

export type PageDistribution =
  | "flip"           // legacy: current page only (default, zero behavior change)
  | "elevator"       // vertical column, snap-scroll        (idea 3)
  | "wallGrid"       // curved wall of thumbnails           (idea 2)
  | "deck"           // desk piles with shadows, grabbable  (idea 1)
  | "rooms";         // walkable museum                     (idea 5, stretch)

export function computePagePlacements(
  pagination: PaginationMeta,
  panelSize: Size2,
  mode: PageDistribution,
  profile: DeviceProfile,
  focusIndex: number,
): PagePlacement[];
```

The renderer renders *all* pages (or a windowed subset), each wrapped in a
group carrying its placement, with the "current" page treated as *focused*
rather than *only*. `ViewMode → PageDistribution` is a data mapping in
`viewTypes.ts`, same as views map to arrangements today. Existing views
implicitly get `"flip"`.

**The engine changes exactly once — the `contentOnly` flag.** Folding
asides/banner/footer into the flow changes page heights, page breaks and
`pageCount` — that is pagination, which only the engine computes, so it
cannot be presentational. But it reduces to a `LayoutConfig.contentOnly`
flag that skips slot extraction for those landmarks so they paginate as
ordinary in-flow children (details next section). The section-grouped
modes' page→section grouping is derived renderer-side from data the plan
already has (top-level section entries carry `pageIndex`). Nothing else in
`src/layout/` changes.

### Content-only landmark folding

In every page-distribution mode the pages themselves ARE the spatial
structure, so the landmark side panels lose their job: **`XRContentPanel`
becomes the only panel**. Concretely, whenever
`pageDistribution !== "flip"`:

- **`XRComplementary` (asides)** are *folded into the content flow*: with
  `LayoutConfig.contentOnly` set, the engine simply does **not** extract the
  aside to its own slot — it stays where it sits in reading order and
  paginates as an ordinary in-flow child (a generic container, exactly as
  the user framing puts it). The primitive keeps its mapper-emitted type
  (no new types — see §3 change-surface rule); the engine stamps
  `folded: true` on the aside's `LayoutEntry` so the renderer can (a) style
  it as a visually distinct callout block (background tint, inset) and
  (b) bypass the complementary-specific extraction branches. Side benefit:
  this sidesteps the known aside coordinate quirks (asides are the one
  landmark whose children use parent-relative coords and several renderer
  mechanisms assume panel-absolute — folded content is plain panel-absolute
  like everything else).
- **`XRNavigationBar` / TOC** are *suppressed*: these modes make the page set
  itself the navigation (a wall grid or elevator column *is* an overview), so
  nav rails are redundant. To honour the "no nodes dropped" invariant, nav
  primitives still receive layout entries but marked `suppressed: true`; the
  renderer skips suppressed entries. (Optional later: reuse nav links as
  jump-to-section shortcuts in `rooms`.)
- **`XRBanner` / footer** fold into the flow too — banner content joins the
  top of page 1, footer content the end of the last page — so the roster for
  these modes collapses to `[main]` and the slot-distribution axis becomes
  trivial (the main slot's origin is just the anchor the page distribution
  offsets from).

In short: the ONLY layout-side change in the whole plan is this
`contentOnly` treatment, because it alters pagination. Everything else —
page transforms, dimming, clipping, focus, chrome anchoring, grab — is
presentation and lives in `src/renderer/` (+ view plumbing in
`src/components/`).

### Renderer changes (the one risky area)

- Replace the binary `CurrentPageContext` cull with a `PagePlacementContext`:
  when `pagePlacements` exist for a panel, `<DispatchChildren>` groups each
  page's primitives under a `<group>` carrying that page's transform; when
  absent, behavior is byte-identical to today.
- **Clipping**: `ClipPlanesContext` planes are computed from the panel
  viewport in world space. Once pages move, planes must be derived **per page
  instance** (each page keeps its own rectangular viewport). Plan: compute
  planes from `slotOrigin + pagePlacement` inside the page group.
- **Recession styling**: reuse the carousel-ghost dimming approach
  (`carouselGhostPlacement` already proves ghost pages render fine) — dim +
  slight desaturation ∝ `recession`, plus a cheap drop-shadow quad for `deck`.
- **Focus change**: clicking/pointing a non-focused page sets it current —
  same `userData.nodeId` raycast routing that panels already use, new
  `userData.pageIndex`.
- **Perf guard**: with ~100 pages, troika text cost dominates. Add a
  `maxLivePages` per device profile (e.g. Quest 3: 12 full + rest as
  imposter quads showing only headings), windowed around the focus page.

Everything else — parser, mapper, intra-page placement, `stampDescendants`,
panel-absolute coordinates — is untouched, which is what makes this safe.

## 4. The modes, mapped to supervisor's ideas

### 4.1 `elevator` (idea 3) — build FIRST
Pages stacked vertically at the main slot's x/z; page *i* at
`y = focusY − (i − focus) · (pageH + gap)`. Thumbstick / scroll snaps the
column, easing via the existing `AtPos` morph. Ghosts above/below at
`recession > 0`. Content moves, user doesn't (P3, P6).
*Effort: S — pure vertical offsets + input hook; reuses ghost dimming.*

### 4.2 `wallGrid` (idea 2)
Pages as thumbnails (`scale ≈ 0.3–0.4`) on a cylindrical arc (P2), rows
capped so the grid stays within ~±20° vertical; grid centred slightly below
eye height. Select → page morphs (AtPos easing) to the full-size reading slot
in front; a ghost frame remains in the grid marking "you are here" (P1).
*Effort: M — adds per-page scale to clipping + thumbnail imposter for far pages.*

### 4.3 `deck` (idea 1)
A desk surface (simple quad w/ grid texture) at ~0.75 m height, tilted ~30°
toward the user (Data Mountain's inclined plane). Pages grouped into
section piles; pile fan-offset a few cm per page with drop shadows; grab
(existing controller raycast + squeeze) lifts a page to the reading slot;
release over the desk drops it into the nearest snap cell (CHI '25: snapped,
not free). Persist user rearrangement per-URL via `SlotOverride`-style JSON.
*Effort: M/L — first mode with real grab interaction; layout itself is easy.*

### 4.4 `rooms` (idea 5) — stretch
Reduced v1: one rectangular room per section, room size ∝ page count; the
section's pages hang as wall panels (reuse `wallGrid` math per wall);
corridors connect section *i* → *i+1* in reading order; the top-N outbound
links of a section become labelled doorframes that lazy-load the target page
(via the link-ghost pipeline of §4.5) into a new room. Teleport locomotion
only (P6). This is Museum-of-All-Things-style but derived from one page's
semantic tree instead of a wiki corpus.
*Effort: L — floor-plan generation, portals, locomotion; do last.*

### 4.5 Link visibility (challenge 6) — orthogonal to all modes
1. **Link ghost (cheap, do with Phase 2):** pointing at an `XRLink` ≥ 400 ms
   spawns a tethered card (favicon + title + domain) beside the panel;
   line from link anchor to card. Select → dev-proxy fetch → full pipeline →
   mini scene rendered into the card (scale ~0.25) → "open" promotes it to a
   new tab / focused panel.
2. **Rooms:** doorways subsume both (§4.4).

## 5. Risks, edge cases, and preflight code findings

Issues found by walking the real code paths the plan touches, ranked by how
much they change the plan. Each has a mitigation that is folded into the
phase list below.

### 5.1 Found in code (concrete, verified)

- **R1 — Clipping is axis-aligned and will break for every rotated page.**
  `usePanelClipPlanes` builds four world-space planes from `entry.position`
  x/y only — it assumes an unrotated, unscaled, axis-aligned panel. Pages in
  `wallGrid` (arc tangents), `deck` (30° tilt), and `rooms` (±90° walls) are
  all rotated. *Mitigation:* Phase 0 replaces it with an oriented variant —
  build the four planes in page-local space and `plane.applyMatrix4(pageGroup
  .matrixWorld)`, recomputed only when the page transform changes. `elevator`
  keeps axis-aligned planes (pure y-offsets), which is one more reason it
  ships first.
- **R2 — `XRComplementary` already has a special renderer path that folding
  must neutralize.** `dispatch-children.tsx` *extracts* asides that carry a
  `pageIndex` out of the panel into a world-space slot, and asides are the
  one landmark whose children use parent-relative coords. The fold pass must
  produce ordinary panel children (no extraction trigger), and the extraction
  branch must be bypassed when a fold ran — otherwise folded asides get
  double-placed. *Mitigation:* the aside keeps its type (mapper is frozen,
  §3) but its `LayoutEntry` carries `folded: true`; the extraction branch in
  `dispatch-children.tsx` (a renderer file) is gated on `!entry.folded`, and
  every other complementary-specific branch gets the same guard. Add a
  fixture asserting the extraction branch is not taken for folded asides.
- **R3 — Fragment (`#`) navigation writes the panel's current page.**
  `scene-graph.tsx` resolves a fragment target to its `pageIndex` and calls
  `setPage`. In page modes this must *animate focus* (elevator scrolls the
  column, wall zooms the target page) rather than teleport-swap. *Mitigation:*
  keep `CurrentPageContext` as the single "focus index" source of truth; page
  distributions derive placements from it and `AtPos` easing animates the
  transition for free. Fragment nav then works unchanged.
- **R4 — In-world chrome anchors to the main panel.** The tab bar / view
  toggle anchor to the main slot with a keep-out column; in `wallGrid`/`deck`
  the main slot origin sits inside the grid/desk field, so chrome would
  overlap pages. *Mitigation:* per-mode chrome anchor rule (elevator: below
  the focus window; wall: below the arc's centre column; deck: front desk
  edge), verified with the existing AABB overlap page.
- **R5 — Sections do break pages, but "no section" content exists.**
  `XRSection` has `forceNewPage: true`, so page→section grouping is mostly
  clean — but content before the first section (intro paragraphs directly
  under the panel) belongs to no section, and nested sub-sections span their
  parent's pages. *Mitigation:* the section-grouped modes group by
  **top-level** section only and synthesize an "intro" group for
  pre-section pages.
- **R6 — A production proxy exists.** `api/proxy.ts` is a Vercel edge CORS
  proxy (`/api/proxy?url=`), so link ghosts are *not* dev-only as first
  assumed — but hover-triggered prefetch can spam it. *Mitigation:* ghosts
  fetch only on dwell (≥400 ms) with an in-memory LRU cache; full pipeline
  render only on explicit select. (CLAUDE.md's "CORS proxy is dev-only"
  refers to the Vite middleware at `/proxy`; the plan should use the right
  endpoint per environment.)

### 5.2 Design and scale risks

- **R7 — Wall capacity math doesn't fit 100 pages.** At 0.35 scale
  (~0.4 m thumbnails), a 2.5 m-radius arc within ±60° holds ~13 per row, and
  the ±20° vertical comfort cap allows 3–4 rows → ~50 pages max. *Mitigation:*
  the wall itself scrolls (yaw-rotates) in row-sized steps, or overflows into
  a second, dimmer shell 0.5 m behind the first; pick via prototype.
- **R8 — Click ambiguity on non-focused pages.** A ray hit on a ghost page
  could mean "focus this page" or "click that link". *Mitigation:* while
  `recession > 0` the entire page is a single hit target (links inert);
  links only interactive on the focused page.
- **R9 — Mount hitch when entering a page mode.** Switching flip→elevator
  mounts up to `maxLivePages` troika-text pages in one commit — a multi-frame
  stall on Quest. *Mitigation:* staged mounting — the live window grows
  outward from the focus page over successive frames; imposters (heading-only
  quads) render immediately.
- **R10 — Per-page materials multiply.** Per-page clipping planes and
  recession dimming force material cloning per page → draw-call and memory
  growth at ~100 pages. *Mitigation:* imposters beyond the live window;
  shared uniform-driven dimming where possible; profile on device in Phase 1.
- **R11 — Degenerate content.** `pageCount === 1` (landing pages) makes every
  page mode a silly single floating card, and forms need sequential input
  focus that spatial scatter harms. *Mitigation:* auto-fallback to `flip`
  when `pageCount < 3` or template === `form`, with the view toggle showing
  why.
- **R12 — Deck ergonomics.** A 30°-tilted page at desk height is for triage,
  not reading — oblique troika text at 0.75 m is borderline. Reading always
  happens by lifting to the reading slot; seated vs standing eye height must
  come from the device profile, not a constant.
- **R13 — Deck persistence staleness.** A refetched page can paginate to a
  different `pageCount`, invalidating stored placements. *Mitigation:* key
  persistence by URL + `pageCount` (+ cheap content hash); on mismatch, fall
  back to default piles rather than misplacing pages.
- **R14 — Frame × page-distribution combos need constraining.** `deck` only
  makes sense world-framed (gravity metaphor); `elevator` works in `world` or
  `body`; none belong in `head`/`hand`. *Mitigation:* `Arrangement` data
  declares the allowed combos; the toggle filters like `deviceFit` already
  does.
- **R15 — Rooms can recurse unboundedly.** Link doorways load target pages,
  which have their own doorways. *Mitigation:* lazy-load depth 1, evict
  rooms beyond the two nearest, cap total live rooms.
- **R16 — Suppressed entries skew metrics.** `src/eval` xr-quality iterates
  plan entries; suppressed nav entries and folded callouts must be excluded /
  re-classified or legibility scores shift between modes for spurious
  reasons. Update the eval harness alongside Phase 0.

## 6. Phased roadmap (each phase independently runnable & verifiable)

- **Phase 0 — PagePlacement infrastructure + `contentOnly`.**
  Layout side (the only layout change in the plan): `LayoutConfig.contentOnly`
  — skip slot extraction for complementary/banner/footer so they paginate
  in-flow, stamp `folded: true` on their entries (R2); nav entries unchanged
  but renderer-skipped (`suppressed` handling is renderer-side; excluded
  from eval metrics, R16). Renderer side: `page-placements.ts` (pure,
  node-importable, `"flip"` default), `PagePlacementContext` + per-page
  groups, oriented per-page clip planes (`applyMatrix4` variant of
  `usePanelClipPlanes`, R1), recession dimming, `maxLivePages` windowing,
  and the `pageCount < 3` / form-template auto-fallback to `flip` (R11).
  Zero visual change for existing views. *Verify:* offline tsx pipeline
  snapshot — plan entries for a many-page fixture with an aside + nav under
  `contentOnly` (aside content paginates inline on the right page, entries
  marked folded); `computePagePlacements` unit-checked + AABB overlap page
  shows no collisions; existing views pixel-unchanged in preview.
- **Phase 1 — `elevator`.** New view in `ViewToggle`; snap-scroll input
  (reuse scroll=page-nav binding in flat preview; thumbstick in XR); focus
  driven by `CurrentPageContext` so fragment nav animates for free (R3);
  staged mounting of the live window (R9); chrome anchored below the focus
  window (R4); profile per-page material cost on device (R10).
  *Verify:* NO_SSL preview, scroll steps pages with easing; ghosts dim;
  `#fragment` click scrolls the column to the target page.
- **Phase 2 — `wallGrid` + link ghosts.** Thumbnail scaling, select-to-focus
  morph, hover link cards (dwell-gated, LRU-cached, env-correct proxy
  endpoint, R6); wall scroll or second shell for >50 pages (R7); ghost pages
  are single hit targets — links inert until focused (R8). *Verify:* preview
  drag-orbit the wall; AABB page for grid spacing + chrome keep-out; ghost
  card appears on simulated hover; 100-page fixture stays within comfort
  angles.
- **Phase 3 — `deck` + grab + persistence.** Desk mesh, pile layout,
  grab/snap, per-URL placement persistence keyed by URL + pageCount/hash
  (R13); eye height from device profile (R12); world frame only (R14).
  *Verify:* layout offline; grab requires headset — interaction behind the
  same "layout-complete, interaction-stubbed" gate used in views-plan
  Phase 4.
- **Phase 4 — `rooms` (stretch).** Floor-plan gen, wall reuse of wallGrid,
  teleport, doorway links (depth-1 lazy load, room eviction, R15).
- **Evaluation hook (thesis):** extend `src/eval` xr-quality metrics with
  per-mode measures — mean angular distance of page from comfort zone,
  overlap count, focus-switch cost — so modes can be compared quantitatively
  in the write-up, mirroring the layout studies above.

## 7. Demo recommendation for supervisor

Ship Phases 0–2 first (elevator + wall + link ghosts): they demonstrate all
three research-backed wins — vertical content motion, curved overview,
visible links — with the least new interaction machinery, and every one is
verifiable in the flat preview without a headset. `rooms` is the best
*wow* mode.

## 8. Sources

- Robertson et al., *Data Mountain: Using Spatial Memory for Document
  Management*, UIST '98 — https://www.microsoft.com/en-us/research/publication/data-mountain-using-spatial-memory-for-document-management/
- Robertson et al., *The Task Gallery: a 3D Window Manager*, CHI 2000 — https://www.researchgate.net/publication/2455143_The_Task_Gallery_a_3D_window_manager
- *Documents in Your Hands: Interaction Techniques for Spatial Arrangement of
  AR Documents*, CHI '25 — https://dl.acm.org/doi/10.1145/3706598.3713518
- Lisle et al., *Sensemaking Strategies with Immersive Space to Think*,
  IEEE VR '21 — https://ieeexplore.ieee.org/document/9417736/ (project: http://www.leelisle.com/ist/)
- *Design of a virtual data shelf … flat, curved, spherical*, IJCARS '23 — https://link.springer.com/article/10.1007/s11548-023-02851-z
- Ens et al., *Ethereal Planes: A Design Framework for 2D Information Spaces
  in 3D Mixed Reality Environments*, SUI '14 — https://hci.cs.umanitoba.ca/Publications/details/ethereal-planes
- Ens et al., *The Personal Cockpit: A Spatial Interface for Effective Task
  Switching on Head-Worn Displays*, CHI '14 — https://hci.cs.umanitoba.ca/publications/details/personal-cockpit
- *Exploring Multiview UI Layouts and Placement Strategies for Collaborative
  Sensemaking in VR* — https://arxiv.org/pdf/2511.17919
- *WindowSpace: A Web-Based XR Window Manager*, PACM HCI — https://dl.acm.org/doi/10.1145/3773063
- *DuoZone: LLM-Guided Mixed-Initiative XR Window Management* — https://arxiv.org/html/2511.15676
- *Adaptive Content Layout in 3D Spaces* — https://link.springer.com/chapter/10.1007/978-3-031-68130-1_16
- *Museum of All Things* (Godot showcase) — https://godotengine.org/article/museum-of-all-things/
- *Viki LibraRy: collaborative hypertext browsing and navigation in VR*,
  New Review of Hypermedia and Multimedia 2024 — https://www.tandfonline.com/doi/full/10.1080/13614568.2024.2383581
- *RealityMedia: immersive technology and narrative space*, Frontiers in VR
  2023 — https://www.frontiersin.org/journals/virtual-reality/articles/10.3389/frvir.2023.1155700/full
- Dieberger, *Real and Virtual Spaces: Mapping from Spatial Cognition to
  Hypertext* — https://www.researchgate.net/publication/220534159_Real_and_Virtual_Spaces_Mapping_from_Spatial_Cognition_to_Hypertext
- *VRowser: A Virtual Reality Parallel Web Browser*, 2018 — https://link.springer.com/chapter/10.1007/978-3-319-91581-4_17
- *Multi-Window Web Browser with History Tree Visualization for VR*,
  UIST '21 adjunct — https://dl.acm.org/doi/10.1145/3474349.3480221
- *I-Sphere: a VR-based 3D interactive web navigation interface* — https://www.semanticscholar.org/paper/0eb5a8a4382aa2ace3f16b7246722cb823f24913
- *LitForager: Multimodal Literature Foraging in Immersive Sensemaking*,
  2025 — https://arxiv.org/pdf/2508.15043
- *An Immersive Layout Framework for Web Design in VR*, CHI '23 EA — https://dl.acm.org/doi/10.1145/3544549.3585889
