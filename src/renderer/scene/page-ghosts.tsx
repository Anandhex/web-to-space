/**
 * scene/page-ghosts.tsx
 *
 * The spatial page field for content-only page views (wall / deck / rooms). It REPLACES the paginated panel — the panel itself is not
 * dispatched — drawing every page at the placement computed by
 * renderer/page-placements.ts. The wall is a field over the same cells but a
 * different model (sections that open into pages), so it lives in
 * scene/wall-field.tsx and this component hands off to it.
 *
 *  • Pages near the focus render as full live ghosts (the whole primitive
 *    subtree pinned to that page, with scale + click-to-focus).
 *  • Distant pages render as cheap imposter cards (page number + first
 *    heading) so a 100-page document stays drawable.
 *  • Every ghost/imposter is ONE hit target: clicking it focuses that page
 *    (links inside ghosts are deliberately inert until focused).
 *  • In deck the focused page flies to the stage and its vacated cell
 *    renders as a highlight frame — the "you are here" marker. Rooms has no
 *    stage and moves the READER instead: the field is wrapped in one eased
 *    <RoomWalk> that carries the whole room rigidly until the reader stands
 *    in front of the focused exhibit.
 *
 * Ghost groups are wrapped in <AtPos>, so a change of focus — or of what the
 * pointer is on — morphs the field with the same easing as a view switch.
 */
import React from "react";
import { Text } from "@react-three/drei";

import type { XRPrimitive } from "../../mapper/types";
import type { LayoutEntry, LayoutPlan } from "../../layout/types";
import { useTheme } from "../theme";
import {
  computePagePlacements,
  computeFieldLabels,
  computeRoomShell,
  computeRoomSlabs,
  computeRoomStairs,
  computeRoomFixtures,
  computeReadingSpots,
  corridorPageAt,
  roomAtPose,
  roomReadingPose,
  roomRailY,
  LIVE_GHOST_RADIUS,
  MIN_PAGES_FOR_PAGE_VIEWS,
  type PagePlacement,
  type ReaderPose,
  type SectionLink,
  type SectionPageRange,
} from "../page-placements";
import { AtPos } from "./AtPos";
import { FontContext, type PageState } from "./contexts";
import {
  EasedScale,
  FocusCellFrame,
  LivePageGhost,
  PageHitPlane,
  PageImposter,
  usePageHeadings,
} from "./page-cells";
import { WallField } from "./wall-field";
import { DeckField } from "./deck-field";
import { usePageLinks } from "./contexts";
import { buildSlots, drawable } from "../../links/slots";
import type { LateralSide } from "../../links/direction";
import { windowFor } from "../../links/memory";
import type { SpatialLink } from "../../links/types";
import { NavigateContext } from "../primitives/contexts";
import {
  RoomStairs,
  RoomWalk,
  RoomTeleport,
  LinkDoors,
  ReadingSpots,
  SPOT_REACH,
  useReadingView,
  useRoomWalking,
} from "./room-walk";
import { RoomShell, RoomSlabs, RoomLights, GALLERY_SIGN } from "./room-decor";

// ── Section ranges (grouping for wall / deck / rooms) ──
//
// The spans themselves come from `plan.sections`, which the layout engine
// derives once (see layout/outline.ts) — only pagination knows which page a
// primitive landed on. What is left here is presentation policy: which
// sections a given view treats as groups, and how the gaps between them are
// filled so every page belongs to exactly one.

/**
 * Turn a list of section starts into a gap-free, ordered partition of
 * [0, pageCount − 1] — every page belongs to exactly one range.
 *
 * The normalisation is the point. This used to take reading order on faith and
 * just walk the list setting `out[i].end = out[i+1].start − 1`, which silently
 * produces ranges with `end < start` on any input that isn't already sorted and
 * unique. Two shapes do that on real pages, and both occur:
 *
 *  • Two sections starting on the SAME page — unavoidable, since a page can
 *    hold several headings and a section's start is wherever its first
 *    primitive landed. Each earlier twin got `end = start − 1`.
 *  • Starts arriving out of order, which pagination can produce when content
 *    is extracted or re-homed between passes.
 *
 * A degenerate range is not a harmless empty: the desk's outline rail drew it
 * as a 9 mm nub (the <Surface> minimum) at a position computed from a negative
 * width, and the pages it should have covered got no segment at all — a rail
 * of scattered blocks with the bare track showing between them. The page views
 * group by these ranges too, so the same input stranded pages in no lane, no
 * floor and no room.
 *
 * Sorting is the right normalisation here even though it can reorder labels: a
 * page belongs to whichever section starts at or before it, which is a
 * statement about page numbers, not about the DOM. Where several sections share
 * a start page they cannot be told apart by page at all, so they collapse to
 * one range under the first one's name.
 */
function fillRanges(
  starts: { start: number; label: string }[],
  pageCount: number,
): SectionPageRange[] {
  if (starts.length === 0 || pageCount <= 0) return [];

  // Clamp into the document, then keep one entry per start page (first wins).
  const byStart = new Map<number, string>();
  for (const s of starts) {
    const at = Math.max(0, Math.min(pageCount - 1, Math.floor(s.start)));
    if (!byStart.has(at)) byStart.set(at, s.label);
  }

  const out: SectionPageRange[] = [...byStart.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([start, label]) => ({ start, end: pageCount - 1, label }));

  // Pages before the first section are the document's opening.
  if (out[0].start > 0)
    out.unshift({ start: 0, end: pageCount - 1, label: "Intro" });
  for (let i = 0; i < out.length - 1; i++) out[i].end = out[i + 1].start - 1;
  return out;
}

/**
 * Page ranges of the panel's TOP-LEVEL sections, in reading order, gaps
 * filled: pages before the first section become an "Intro" pseudo-section
 * (sections force new pages, so ranges are disjoint; any stragglers between
 * ranges are absorbed into the preceding section's column).
 */
export function sectionRangesFor(
  plan: LayoutPlan,
  pageCount: number,
): SectionPageRange[] {
  const top = (plan.sections ?? []).filter((s) => s.depth === 0);
  if (top.length === 0) return [];
  return fillRanges(
    top.map((s) => ({ start: s.startPage, label: s.label })),
    pageCount,
  );
}


/**
 * rooms: how close the reader has to be for a page to render for real rather
 * than as a numbered ghost card. Roughly three reading distances — near
 * enough that the page is worth mounting, far enough that walking into a
 * room brings its near wall to life before you reach it.
 */
const ROOM_LIVE_RADIUS = 4.2;

/**
 * A section plaque. Rooms marks it a `sign`: an illuminated plate over the
 * doorway, because the lintel it hangs on is the darkest surface in the
 * corridor and a lit sign is how a real building solves exactly that.
 */
function FieldLabelText({
  label,
  base,
}: {
  label: import("../page-placements").FieldLabel;
  base: LayoutEntry;
}) {
  const theme = useTheme();
  const fontType = React.useContext(FontContext);
  const opacity = label.opacity ?? 1;
  // The sign's plate, sized off the text: roughly half an em per character
  // for the mixed-case names these are, with a comfortable margin. Only the
  // renderer knows the font, so the placement side ships a flag, not a size.
  //
  // …and a BUDGET (`maxHeight`): the plate hangs on a lintel with a soffit
  // dropping in front of it, and only the placement side knows how much clear
  // wall that leaves. A section name long enough to wrap grew the plate past
  // the band and the soffit took the top line off it, so the size below is a
  // ceiling to come down from rather than the size to use. Coming down beats
  // wrapping further: two lines of a real page's h1 ("Resources for
  // Developers, by Developers") need three times the band that one line does.
  const plate = React.useMemo(() => {
    if (!label.sign) return null;
    const budget = label.maxHeight ?? Infinity;
    let fontSize = label.fontSize;
    for (let i = 0; i < 8; i++) {
      const wanted = label.text.length * fontSize * 0.56 + 0.34;
      const width = Math.min(3.1, Math.max(0.9, wanted));
      // A long heading wraps rather than being cut, so the plate has to grow
      // with it — a sign the name overflows is worse than no sign.
      const lines = Math.max(1, Math.ceil(wanted / width));
      // 0.3 em of margin above and below the name. It was 0.55 em each way,
      // which is a generous plate when there is wall to spare — but the band
      // between a door head and the soffit is about 0.2 m, and every
      // centimetre spent on margin came off the letters, which is how a
      // one-word section name ended up set at 9 cm.
      const height = fontSize * (0.6 + lines);
      if (height <= budget || fontSize <= 0.055)
        return { width, height, fontSize };
      fontSize *= 0.85;
    }
    return { width: 3.1, height: budget, fontSize };
  }, [label.sign, label.text, label.fontSize, label.maxHeight]);
  return (
    <group
      position={[
        base.position.x + label.offset.x,
        base.position.y + label.offset.y,
        base.position.z + label.offset.z,
      ]}
      rotation={[label.rotation.x, label.rotation.y, label.rotation.z]}
    >
      {plate && (
        <>
          {/* Unlit on purpose — a sign that needed lighting to be read would
              be no better than the bare letters it replaces — and pale, with
              the name dark on it, which is how a gallery labels a room. */}
          <mesh position={[0, 0, -0.006]}>
            <planeGeometry args={[plate.width, plate.height]} />
            <meshBasicMaterial color={GALLERY_SIGN.plate} toneMapped={false} />
          </mesh>
          <mesh position={[0, 0, -0.008]}>
            <planeGeometry args={[plate.width + 0.03, plate.height + 0.03]} />
            <meshBasicMaterial color={GALLERY_SIGN.edge} toneMapped={false} />
          </mesh>
        </>
      )}
      <Text
        font={fontType}
        anchorX="center"
        anchorY="middle"
        // A hair proud of its plate: the name must never be a coplanar
        // decision for the depth buffer to make.
        position={[0, 0, plate ? 0.004 : 0]}
        fontSize={plate ? plate.fontSize : label.fontSize}
        color={plate ? GALLERY_SIGN.text : theme.emphasisCol}
        fillOpacity={opacity}
        outlineWidth={plate ? 0 : label.fontSize * 0.06}
        outlineColor={theme.panelBg}
        maxWidth={plate ? plate.width * 0.9 : 2.6}
      >
        {label.text}
      </Text>
    </group>
  );
}

// ── The field ────────────────────────────────────────────────

export function PageGhostField({
  panel,
  plan,
  pageState,
  setPage,
  primitiveMap,
}: {
  panel: XRPrimitive;
  plan: LayoutPlan;
  pageState: PageState;
  setPage: (id: string, page: number) => void;
  primitiveMap: Map<string, XRPrimitive>;
}) {
  const mode = plan.pageDistribution;
  const entry = plan.entries[panel.id];
  const pageCount = entry?.pagination?.pageCount ?? 1;
  const focus = pageState[panel.id] ?? 0;

  const headings = usePageHeadings(primitiveMap, plan);

  const sectionRanges = React.useMemo(
    () =>
      mode === "wall" || mode === "deck" || mode === "rooms"
        ? // Root + 1: the panel's top-level sections are what the wall shows
          // as tiles, and what the other two group by.
          sectionRangesFor(plan, pageCount)
        : [],
    [mode, plan, pageCount],
  );

  const viewingDistance = plan.config.viewingDistance;

  // rooms: the corridor past a section's room carries the links of the page
  // the reader is ON — not every link the section contains.
  //
  // "Corridors are per rendered page, not per document section" is a decision
  // the spec settles (docs/directional-links.md, item 5), and the census says
  // why: one MDN page carries 167 parent links on a single rendered page,
  // because a nav sidebar is one landmark and pagination drops it whole onto
  // one page. Hanging a section's whole link set off its corridor built a
  // stretch nobody could walk to the end of. Only the live page's corridor is
  // furnished; the others are empty stretches the reader passes through.
  //
  // The SAME list has to reach every rooms entry point below, because its
  // length sizes the stretch — a corridor built for one list and doored from
  // another disagrees with its own floor plan.

  // ── rooms: every page's corridor, built with the building ──
  //
  // Not just the focused page's. Anand, 2026-08-16: "I want the corridors
  // present irrespective whether the user is standing on the page, they should
  // be pre-rendered before not after standing." A reader walking a gallery has
  // to see which pages lead somewhere BEFORE choosing which to stand at, and a
  // corridor that appears only once they are already there cannot be part of
  // that choice.
  //
  // Windowed, not fitted: a corridor is walked, and one Wikipedia page's 28
  // ascent links once built a fifty-six-metre one.
  const allPageLinks = usePageLinks();
  const roomPageLinks = React.useMemo(() => {
    if (mode !== "rooms") return undefined;
    const budget = windowFor("rooms");
    const byPage: SpatialLink[][] = Array.from({ length: pageCount }, () => []);
    for (const l of allPageLinks?.links ?? [])
      if (l.pageIndex >= 0 && l.pageIndex < pageCount) byPage[l.pageIndex].push(l);
    return byPage.map((links) => {
      if (links.length === 0) return [];
      // `nav` is deliberately left out: a page the reader is not standing on
      // has no way back FROM it, and threading the current corridor into every
      // page's door list would put the same return door in forty places.
      const slots = buildSlots({ links, nav: null, budget });
      const out: SectionLink[] = [];
      for (const axis of ["left", "right", "up", "down"] as const)
        for (const s of drawable(slots[axis]))
          out.push({
            label: s.label,
            href: s.url,
            axis,
            isReturn: false,
            linkId: s.linkId,
          });
      return out;
    });
  }, [mode, pageCount, allPageLinks]);

  // Which hand each sibling's door took, published so the inline mark beside
  // the anchor can point the same way the corridor does. Rooms builds EVERY
  // page's corridor up front (see above), so this covers the whole document
  // rather than just the page the reader is standing on.
  const publishSides = allPageLinks?.publishSides;
  React.useEffect(() => {
    if (!publishSides || !roomPageLinks) return;
    const sides = new Map<string, LateralSide>();
    for (const page of roomPageLinks)
      for (const link of page)
        if (link.linkId && (link.axis === "left" || link.axis === "right"))
          sides.set(link.linkId, link.axis);
    publishSides(sides);
  }, [roomPageLinks, publishSides]);

  /**
   * Which page's corridor is BUILT OUT — its arms, its stair hall and its
   * flights. See `PagePlacementOptions.activePage`.
   *
   * The VICINITY, not the mark. Anand, 2026-08-18: *"the corridors for the
   * room activates when I am at the pointer, it should activate when I am in
   * the vicinity"*. Gating it on `focus` meant the corridor arrived only once
   * the reader had both feet inside the 0.55 m reading spot: walk up to a
   * page, stand beside it, and the way on was still a blind vestibule. It is
   * elected by proximity below (`VICINITY_REACH`), and it is deliberately NOT
   * `focus` — which page is on show and which corridor is open are now two
   * questions, because the reader is near a page long before they are on it.
   */
  const [corridorPage, setCorridorPage] = React.useState(focus);

  const roomOpts = React.useMemo(
    () => ({
      sectionRanges,
      viewingDistance,
      pageLinks: roomPageLinks,
      activePage: corridorPage,
      // The floor is world y = 0, which in the panel-anchor space these
      // offsets live in sits the panel's own height below the anchor line.
      floorY: entry ? -entry.position.y : undefined,
    }),
    [sectionRanges, viewingDistance, roomPageLinks, entry, corridorPage],
  );

  const placements = React.useMemo(
    () =>
      mode && entry
        ? computePagePlacements(mode, pageCount, entry.size, focus, roomOpts)
        : [],
    [mode, entry, pageCount, focus, roomOpts],
  );

  // rooms: the building never moves — this is where the READER is, and the
  // one thing that changes every frame, so it lives in a ref (see RoomWalk).
  const isRooms = mode === "rooms" && !!entry && pageCount >= MIN_PAGES_FOR_PAGE_VIEWS;
  // Yaw 0 looks down −z, which is where the panel slot is: a sane pose to
  // hold until the focused page's own reading pose replaces it below.
  const poseRef = React.useRef<ReaderPose>({ x: 0, z: 0, yaw: 0 });
  /**
   * Bumped whenever the reader JUMPED to a pose instead of walking to it — a
   * headset teleport, or a reading spot clicked from the far side of a room.
   * `RoomWalk` eases everything else; it lands on these.
   */
  const jumpRef = React.useRef(0);
  const readingPose =
    isRooms && entry
      ? roomReadingPose(mode, pageCount, entry.size, focus, roomOpts)
      : null;
  // Focusing a page stands the reader in front of it. Walking (below) moves
  // the same ref, so the two are the same mechanism: one reader, one pose.
  const lastFocus = React.useRef<number | null>(null);
  // …unless the focus changed BECAUSE they walked onto that page's spot, in
  // which case they are already standing in the right place and moving them
  // again would yank the floor out from under a walk in progress.
  const focusFromWalk = React.useRef(false);
  /**
   * ── Arriving in a NEW DOCUMENT stands the reader in the new building ──
   *
   * This field does not remount when the document changes. The panel's id is
   * `"main"` in every document, and it is the React key, so the same component
   * instance — and every ref in it, the reader's pose included — carries
   * straight over from one building into the next.
   *
   * The pose used to be reset only when `focus` CHANGED, and a new document
   * resets paging to page 0. So the first move worked (the reader was standing
   * at page 7, say, and 7 → 0 is a change) and the second in a row did not:
   * page 0 → page 0 is no change, nothing reset the pose, and the reader was
   * left at the coordinates they had in the PREVIOUS building — out in a
   * corridor, or up on a landing — which in the new one is very often outside
   * the building altogether. Anand, 2026-08-18: *"if i click one direction of
   * links after second continuous link in the same direction i get teleported
   * to void"*. Measured: a reader at page 24 of a 40-page document stands at
   * z = −58 m, and a 14-page document has no room and no floor within reach
   * of it.
   *
   * So arrival is its own trigger, and it lands rather than glides (`jumpRef`)
   * — easing across the gap between two buildings would drag the reader
   * through several rooms of the new one. `rise` is cleared with it: a landing
   * one storey up in the document you left is thin air in the one you enter.
   */
  const lastPlan = React.useRef<LayoutPlan | null>(null);
  const arrived = readingPose !== null && lastPlan.current !== plan;
  if (readingPose) lastPlan.current = plan;
  if (readingPose && (arrived || lastFocus.current !== focus)) {
    if (arrived || !focusFromWalk.current)
      poseRef.current = { ...readingPose, rise: 0 };
    focusFromWalk.current = false;
    lastFocus.current = focus;
    if (arrived) jumpRef.current += 1;
  }

  /**
   * Where the reader is, coarsely: state, unlike the pose, because which
   * pages are close enough to render for real depends on it. Updated only
   * every PROXIMITY_STEP of walking, not every frame.
   */
  const [readerAt, setReaderAt] = React.useState({ x: 0, z: 0 });
  const [standingOn, setStandingOn] = React.useState<number | null>(null);

  // Which room the reader is standing in — the only part of the pose that
  // needs to be state, because a room's pages are mounted only once entered.
  const [roomIn, setRoomIn] = React.useState<number | null>(null);
  const roomInRef = React.useRef<number | null>(null);
  const updateRoom = React.useCallback(
    (pose: ReaderPose) => {
      if (!isRooms || !entry) return;
      const r = roomAtPose(mode!, pageCount, entry.size, pose, roomOpts);
      if (r !== roomInRef.current) {
        roomInRef.current = r;
        setRoomIn(r);
      }
    },
    [isRooms, entry, mode, pageCount, roomOpts],
  );
  // Re-derive on a focus change — being teleported into a room counts as
  // having entered it, and as having arrived at that page's spot — and on a
  // new document, where the room the reader was in no longer exists.
  React.useEffect(() => {
    if (!isRooms) return;
    const pose = poseRef.current;
    updateRoom(pose);
    setReaderAt({ x: pose.x, z: pose.z });
    setStandingOn(focus);
  }, [isRooms, focus, plan, updateRoom]);


  // The walls: rooms, corridor, and the gaps left in them for the doors.
  const roomShell = React.useMemo(
    () =>
      mode && entry ? computeRoomShell(mode, pageCount, entry.size, roomOpts) : [],
    [mode, entry, pageCount, roomOpts],
  );


  /** The page range of the room the reader is in — null out in the corridor. */
  const roomPages =
    roomIn !== null && sectionRanges[roomIn] ? sectionRanges[roomIn] : null;

  // Walking: the arrow keys / WASD move the reader, and the walls stop them,
  // so the doorways are the only way between the corridor and a room.
  // Where to stand to read each page — the blue spots on the floor.
  const readingSpots = React.useMemo(
    () =>
      mode && entry ? computeReadingSpots(mode, pageCount, entry.size, roomOpts) : [],
    [mode, entry, pageCount, roomOpts],
  );
  /** The section the focused page belongs to — where the reader is "at". */
  const focusRoom = React.useMemo(
    () => sectionRanges.findIndex((r) => focus >= r.start && focus <= r.end),
    [sectionRanges, focus],
  );

  // ── Which corridor is open: the page the reader is NEAR ──
  //
  // The two rules — vicinity opens it, crossing the wall line freezes it —
  // are `corridorPageAt`'s, and the reasoning lives with them. Re-run whenever
  // the reader's coarse position is re-reported, which walking does every
  // PROXIMITY_STEP: a sixth of the vicinity, so the corridor of the page being
  // walked towards opens several strides out.
  const corridorRef = React.useRef(corridorPage);
  corridorRef.current = corridorPage;
  React.useEffect(() => {
    if (!isRooms || !entry || !mode) return;
    // `readerAt` is the TRIGGER, not the input: it is re-reported every
    // PROXIMITY_STEP of walking, which is the cadence this wants, while the
    // pose itself lives in a ref and is exact.
    const next = corridorPageAt(
      mode,
      pageCount,
      entry.size,
      poseRef.current,
      corridorRef.current,
      roomOpts,
    );
    if (next !== corridorRef.current) setCorridorPage(next);
  }, [isRooms, mode, entry, pageCount, roomOpts, roomIn, readerAt]);

  // A focus change the reader did not walk into is a teleport onto that page's
  // mark — from the minimap, a link, or a clicked spot across the room. The
  // corridor goes where the reader goes, and a new document is the same thing
  // written larger: page 0 of the building they have just walked into, even
  // when the page NUMBER has not changed.
  React.useEffect(() => {
    setCorridorPage(focus);
  }, [focus, plan]);

  /**
   * The spots worth showing: this room's, and the NEXT room's — so that
   * looking through a doorway shows where the reading positions are on the
   * far side of it before you have walked in. (Only the spots: the room
   * itself still does not exist until entered.) Everything further off is
   * behind walls anyway, and the walls occlude these too, so what actually
   * reaches the eye is the room you are in plus whatever the doorway frames.
   */
  const roomSpots = React.useMemo(() => {
    const base = roomIn ?? (focusRoom >= 0 ? focusRoom : null);
    if (base === null) return [];
    const spans = [sectionRanges[base], sectionRanges[base + 1]].filter(Boolean);
    return readingSpots.filter((s) =>
      spans.some((r) => s.pageIndex >= r.start && s.pageIndex <= r.end),
    );
  }, [readingSpots, roomIn, focusRoom, sectionRanges]);

  /**
   * The panel's centre in world space — where the reading camera looks, and
   * where a focused page lands.
   */
  const panelCentre = React.useMemo(
    () =>
      entry
        ? {
            x: entry.position.x + entry.size.width / 2,
            y: entry.position.y - entry.size.height / 2,
            z: entry.position.z,
          }
        : null,
    [entry],
  );
  const restoreReadingView = useReadingView(panelCentre, viewingDistance);

  /** Stand on a spot, facing its page — what clicking one does. */
  const goToSpot = React.useCallback(
    (pageIndex: number) => {
      if (!mode || !entry) return;
      const pose = roomReadingPose(mode, pageCount, entry.size, pageIndex, roomOpts);
      // Set the pose directly rather than leaning on the focus change: click
      // the spot you are already reading and the focus does not change, but
      // the reader still asked to be stood on it, square on to the page.
      if (pose) poseRef.current = pose;
      setStandingOn(pageIndex);
      setReaderAt({ x: pose?.x ?? 0, z: pose?.z ?? 0 });
      setPage(panel.id, pageIndex);
      // Clicking a spot across the room is a jump, not a walk — see RoomWalk's
      // jumpRef. The glide is a pleasure through a window and a lurch inside a
      // headset, so the carrier lands on the pose instead of easing to it.
      jumpRef.current += 1;
      // The page lands on the panel slot; put the eye back on the line that
      // looks at it, or an orbited camera sees the page edge-on.
      restoreReadingView();
    },
    [mode, entry, pageCount, roomOpts, setPage, panel.id, restoreReadingView],
  );

  /**
   * Landing somewhere: what a teleport has to settle once the pose has moved.
   * Walking reports the same three things a step at a time (`onReachSpot`);
   * arriving all at once has to do them in one go, and against EVERY reading
   * spot rather than the current room's — the whole point of a teleport is
   * that it can put the reader in a room they had not entered.
   */
  const arriveAt = React.useCallback(
    (pose: ReaderPose) => {
      updateRoom(pose);
      setReaderAt({ x: pose.x, z: pose.z });
      let on: number | null = null;
      for (const s of readingSpots)
        if (Math.hypot(pose.x - s.centre.x, pose.z - s.centre.z) < SPOT_REACH) {
          on = s.pageIndex;
          break;
        }
      setStandingOn(on);
      if (on !== null && on !== focusRef.current) {
        focusFromWalk.current = true;
        setPage(panel.id, on);
      }
    },
    [updateRoom, readingSpots, setPage, panel.id],
  );

  const navigate = React.useContext(NavigateContext);
  // The flights at the end of every page's corridor: up to the parents'
  // landing, down to the externals'.
  const roomStairs = React.useMemo(
    () =>
      mode && entry ? computeRoomStairs(mode, pageCount, entry.size, roomOpts) : [],
    [mode, entry, pageCount, roomOpts],
  );


  useRoomWalking({
    enabled: isRooms,
    poseRef,
    jumpRef,
    walls: roomShell,
    stairs: roomStairs,
    floorY: entry ? -entry.position.y : 0,
    onRoomChange: updateRoom,
    // Walking into a link door goes through it, the same as clicking it.
    onEnterDoor: (href) => navigate?.(href),
    spots: roomSpots,
    onReachSpot: (pageIndex, pose) => {
      setReaderAt({ x: pose.x, z: pose.z });
      setStandingOn(pageIndex);
      if (pageIndex !== null && pageIndex !== focusRef.current) {
        focusFromWalk.current = true;
        setPage(panel.id, pageIndex);
      }
    },
  });

  // The floor underfoot and the ceiling overhead, one pair per space.
  const roomSlabs = React.useMemo(
    () =>
      mode && entry ? computeRoomSlabs(mode, pageCount, entry.size, roomOpts) : [],
    [mode, entry, pageCount, roomOpts],
  );


  // The light fittings: luminaires over every space and a gallery light over
  // every page. Static, like the walls — the reader's position decides which
  // of them cast a real light, not which of them exist (see RoomLights).
  const roomFixtures = React.useMemo(
    () =>
      mode && entry
        ? computeRoomFixtures(mode, pageCount, entry.size, roomOpts)
        : [],
    [mode, entry, pageCount, roomOpts],
  );

  const fieldLabels = React.useMemo(
    () =>
      mode && entry
        ? computeFieldLabels(mode, pageCount, entry.size, focus, roomOpts)
        : [],
    [mode, entry, pageCount, focus, roomOpts],
  );

  // The walk handlers read the focus through a ref, not the closure: a burst
  // faster than a render would otherwise have every repeat compute its target
  // from the same stale page.
  const focusRef = React.useRef(focus);
  focusRef.current = focus;

  if (!mode || mode === "flip" || !entry) return null;
  if (pageCount < MIN_PAGES_FOR_PAGE_VIEWS) return null;

  // The wall is an outline board that opens a level at a time, so its cells
  // are sections as well as pages and it owns its own disclosure state — see
  // wall-field.tsx. It shares this file's cell components, not its model.
  if (mode === "wall")
    return (
      <WallField
        panel={panel}
        plan={plan}
        pageState={pageState}
        setPage={setPage}
        primitiveMap={primitiveMap}
        sectionRanges={sectionRanges}
        viewMode={mode}
      />
    );

  // The deck is a card table the reader rearranges by hand: its lanes hold
  // whatever the reader put in them, so the page order it draws is not the
  // document's and cannot come from a placement list — see deck-field.tsx.
  if (mode === "deck")
    return (
      <DeckField
        panel={panel}
        plan={plan}
        pageState={pageState}
        setPage={setPage}
        primitiveMap={primitiveMap}
        sectionRanges={sectionRanges}
        viewMode={mode}
      />
    );

  const ghostEntryFor = (p: PagePlacement): LayoutEntry => ({
    ...entry,
    pagination: undefined,
    curveRadius: 0,
    position: {
      x: entry.position.x + p.offset.x,
      y: entry.position.y + p.offset.y,
      z: entry.position.z + p.offset.z,
    },
    rotation: p.rotation,
  });

  const field = (
    <>
      {roomShell.length > 0 && (
        <RoomShell
          walls={roomShell}
          anchor={entry.position}
          floorY={-entry.position.y}
          railY={roomRailY(entry.size, -entry.position.y)}
        />
      )}
      {roomSlabs.length > 0 && (
        <RoomSlabs slabs={roomSlabs} anchor={entry.position} />
      )}
      {roomFixtures.length > 0 && (
        <RoomLights
          fixtures={roomFixtures}
          anchor={entry.position}
          reader={readerAt}
        />
      )}
      {roomShell.some((w) => w.portal) && (
        <LinkDoors walls={roomShell} anchor={entry.position} />
      )}
      {roomStairs.length > 0 && (
        <RoomStairs stairs={roomStairs} anchor={entry.position} />
      )}
      {isRooms && entry && (
        <RoomTeleport
          enabled={isRooms}
          poseRef={poseRef}
          jumpRef={jumpRef}
          walls={roomShell}
          stairs={roomStairs}
          slabs={roomSlabs}
          anchor={entry.position}
          floorY={-entry.position.y}
          onArrive={arriveAt}
        />
      )}
      {roomSpots.length > 0 && (
        <ReadingSpots
          spots={roomSpots}
          anchor={entry.position}
          focus={focus}
          standingOn={standingOn}
          here={roomPages ?? (focusRoom >= 0 ? sectionRanges[focusRoom] : null)}
          onSelect={goToSpot}
        />
      )}
      {fieldLabels.map((l, i) => (
        <FieldLabelText key={`field-label-${i}`} label={l} base={entry} />
      ))}
      {placements.map((raw) => {
        // rooms: a room you have not walked into is a closed box — nothing
        // inside it can be seen, so nothing inside it is mounted. Only the
        // pages of the room the reader is standing in exist, plus the focused
        // page wherever it is, so its pagination controls survive a walk out
        // into the corridor (the walls hide it in the meantime).
        if (
          isRooms &&
          !raw.isStage &&
          (roomPages === null ||
            raw.pageIndex < roomPages.start ||
            raw.pageIndex > roomPages.end)
        )
          return null;
        const p = raw;
        const ghostEntry = ghostEntryFor(p);
        const w = entry.size.width;
        const h = entry.size.height;
        const cellW = w * p.scale;
        const cellH = h * p.scale;

        // rooms: a page renders for real once the reader is near enough to
        // read it, and stays a numbered ghost card until then. In a small
        // room that means all of it at once; in a big one the far wall is
        // page numbers you walk up to — which is what a big room looks like.
        const nearReader =
          isRooms &&
          Math.hypot(
            raw.offset.x + (w / 2) * Math.cos(raw.rotation.y) - readerAt.x,
            raw.offset.z - (w / 2) * Math.sin(raw.rotation.y) - readerAt.z,
          ) <= ROOM_LIVE_RADIUS;
        const live =
          p.isStage ||
          nearReader ||
          (!isRooms && Math.abs(p.pageIndex - focus) <= LIVE_GHOST_RADIUS);
        // One persistent eased group per page (stable key), so whenever a
        // page's target transform changes — a new focus in the field views —
        // AtPos morphs it there rather than cutting. The marker frame is a
        // separate object.
        const key = p.isFocusCell
          ? `page-cell-marker-${p.pageIndex}`
          : `page-ghost-${p.pageIndex}`;
        return (
          <AtPos key={key} entry={ghostEntry}>
            {p.isFocusCell ? (
              <FocusCellFrame width={cellW} height={cellH} />
            ) : (
              <EasedScale target={p.scale}>
                {live ? (
                  <LivePageGhost
                    panel={panel}
                    plan={plan}
                    primitiveMap={primitiveMap}
                    entry={ghostEntry}
                    targetPage={p.pageIndex}
                    scale={p.scale}
                    recession={p.recession}
                    clip={p.rotation.x === 0}
                    stage={p.isStage}
                    // rooms navigates by the blue spots on the floor, not by
                    // a page-at-a-time widget bolted to the page.
                    controls={!isRooms}
                    setPage={setPage}
                  />
                ) : (
                  <PageImposter
                    width={cellW}
                    height={cellH}
                    pageIndex={p.pageIndex}
                    heading={headings.get(p.pageIndex)}
                    recession={p.recession}
                  />
                )}
                {/* Never over the page being read. PageHitPlane is a
                    full-cell quad at z = 0.045 that stopPropagation()s its
                    click, so it sits in front of that page's links (z ≈ 0.004)
                    and eats every one of them — which on the focused page
                    would make the one live, interactive page the only
                    unclickable one, in exchange for a click that only ever
                    re-selected the page already current. */}
                {!p.isStage && (
                  <PageHitPlane
                    width={cellW}
                    height={cellH}
                    onSelect={() => setPage(panel.id, p.pageIndex)}
                  />
                )}
              </EasedScale>
            )}
          </AtPos>
        );
      })}
    </>
  );

  // rooms: the building is fixed and the READER moves through it — one eased
  // rigid transform around everything instead of a per-cell morph.
  return isRooms ? (
    <RoomWalk
      anchor={entry.position}
      poseRef={poseRef}
      jumpRef={jumpRef}
      panel={entry.size}
      viewingDistance={viewingDistance}
    >
      {field}
    </RoomWalk>
  ) : (
    field
  );
}

