/**
 * scene/page-ghosts.tsx
 *
 * The spatial page field for content-only page views (elevator / wall / deck
 * / rooms). It REPLACES the paginated panel — the panel itself is not
 * dispatched — drawing every page at the placement computed by
 * renderer/page-placements.ts. The wall is a field over the same cells but a
 * different model (sections that open into pages), so it lives in
 * scene/wall-field.tsx and this component hands off to it.
 *
 *  • Pages near the focus render as full live ghosts (the whole primitive
 *    subtree pinned to that page — same mechanism as the carousel's
 *    prev/next ghosts, generalized with scale + click-to-focus).
 *  • Distant pages render as cheap imposter cards (page number + first
 *    heading) so a 100-page document stays drawable.
 *  • Every ghost/imposter is ONE hit target: clicking it focuses that page
 *    (links inside ghosts are deliberately inert until focused).
 *  • In deck the focused page flies to the stage and its vacated cell
 *    renders as a highlight frame — the "you are here" marker. The elevator
 *    has no stage: every page stays in its slot, and the page under the
 *    pointer is the one that grows and closes in. Rooms has no stage either
 *    and moves the READER instead: the field is wrapped in one eased
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
  computeRoomFixtures,
  computeReadingSpots,
  computeElevatorShell,
  roomAtPose,
  roomReadingPose,
  elevatorEmphasis,
  elevatorFloorTarget,
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
import { NavigateContext } from "../primitives/contexts";
import {
  RoomWalk,
  LinkDoors,
  ReadingSpots,
  useReadingView,
  useRoomWalking,
} from "./room-walk";
import { RoomShell, RoomSlabs, RoomLights, GALLERY_SIGN } from "./room-decor";
import {
  ElevatorShaft,
  ElevatorDirectory,
  ElevatorSlotMark,
} from "./elevator-decor";

// ── Section ranges (grouping for wall / deck / rooms / elevator) ──
//
// The spans themselves come from `plan.sections`, which the layout engine
// derives once (see layout/outline.ts) — only pagination knows which page a
// primitive landed on. What is left here is presentation policy: which
// sections a given view treats as groups, and how the gaps between them are
// filled so every page belongs to exactly one.

/** Turn a reading-ordered list of section starts into disjoint page ranges. */
function fillRanges(
  starts: { start: number; label: string }[],
  pageCount: number,
): SectionPageRange[] {
  if (starts.length === 0) return [];
  const out: SectionPageRange[] = starts.map((s) => ({
    start: s.start,
    end: pageCount - 1,
    label: s.label,
  }));
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
 * Page ranges for EVERY named section, nested subsections included, in
 * reading order — the elevator gives each one its own floor. A section's
 * range runs from where its content starts to just before the next one
 * begins, so a parent that contains subsections keeps only its own intro
 * pages and each child gets the storey for its own.
 *
 * Unnamed sections are skipped, not floored: structural inference emits
 * sections for things like paragraph runs, which no reader would name, and
 * each of those became an anonymous storey with a blank sign. Their pages
 * belong to the named section enclosing them, which is where the reader
 * already thinks they are.
 */
export function deepSectionRangesFor(
  plan: LayoutPlan,
  pageCount: number,
): SectionPageRange[] {
  const starts: { start: number; label: string }[] = [];
  for (const s of plan.sections ?? []) {
    if (!s.label) continue;
    const prev = starts[starts.length - 1];
    // A page can only live on one floor, and two storeys signed alike (a
    // parent and its first child often resolve to the same heading) are
    // worse than one.
    if (prev && (prev.start === s.startPage || prev.label === s.label)) continue;
    starts.push({ start: s.startPage, label: s.label });
  }
  return fillRanges(starts, pageCount);
}


/**
 * Every outbound link a section's pages contain, in reading order, de-duped
 * by target — what the `rooms` view hangs down the corridor past that
 * section's room.
 *
 * Links are `XRLink` primitives whether they came from a nav list or from
 * mid-prose (see `primitives/inline.tsx`), and pagination has already stamped
 * each one with the page it landed on, so bucketing them by section is a walk
 * of the primitive map. Same-page fragments count: a link to another part of
 * this document is still a door out of this room, and NavigateContext knows
 * how to follow one.
 */
const LINKS_PER_SECTION_CAP = 14;

/**
 * rooms: how close the reader has to be for a page to render for real rather
 * than as a numbered ghost card. Roughly three reading distances — near
 * enough that the page is worth mounting, far enough that walking into a
 * room brings its near wall to life before you reach it.
 */
const ROOM_LIVE_RADIUS = 4.2;

export function sectionLinksFor(
  ranges: SectionPageRange[],
  panel: XRPrimitive,
  plan: LayoutPlan,
): SectionLink[][] {
  const out: SectionLink[][] = ranges.map(() => []);
  const seen = ranges.map(() => new Set<string>());
  // Walk the panel's subtree carrying the page down. An inline link has no
  // layout entry of its own — the paragraph around it is what pagination
  // stamped, and the link is drawn as one of its inline runs — so asking a
  // link which page it is on only ever answers "none". Its page is its
  // nearest placed ancestor's, and walking the tree also gets them in
  // reading order, which iterating the primitive map does not guarantee.
  const visit = (p: XRPrimitive, page: number | undefined) => {
    const e = plan.entries[p.id];
    if (e?.suppressed) return;
    const at = e?.pageIndex ?? page;
    const href = p.type === "XRLink" ? p.href : null;
    if (href && at !== undefined) {
      const s = ranges.findIndex((r) => at >= r.start && at <= r.end);
      if (s >= 0 && out[s].length < LINKS_PER_SECTION_CAP && !seen[s].has(href)) {
        seen[s].add(href);
        const raw =
          (p as { text?: string }).text ?? p.label ?? p.content ?? href;
        const label = raw.replace(/\s+/g, " ").trim();
        out[s].push({ label: label || href, href });
      }
    }
    for (const c of p.children ?? []) visit(c, at);
  };
  visit(panel, undefined);
  return out;
}

/**
 * A section plaque. Rooms marks it a `sign`: an illuminated plate over the
 * doorway, because the lintel it hangs on is the darkest surface in the
 * corridor and a lit sign is how a real building solves exactly that. (The
 * elevator's plaques are a floor directory rather than a name — they are part
 * of its shell, see ElevatorDirectory.)
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
  const plate = React.useMemo(() => {
    if (!label.sign) return null;
    const wanted = label.text.length * label.fontSize * 0.56 + 0.34;
    const width = Math.min(2.4, Math.max(0.9, wanted));
    // A long heading wraps rather than being cut, so the plate has to grow
    // with it — a sign the name overflows is worse than no sign.
    const lines = Math.max(1, Math.ceil(wanted / width));
    return { width, height: label.fontSize * (1.1 + lines) };
  }, [label.sign, label.text, label.fontSize]);
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
            <planeGeometry args={[plate.width + 0.016, plate.height + 0.016]} />
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
        fontSize={label.fontSize}
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
      mode === "elevator"
        ? // Every subsection is its own storey, so the elevator needs the
          // deep section list, not just the panel's top-level ones.
          deepSectionRangesFor(plan, pageCount)
        : mode === "wall" || mode === "deck" || mode === "rooms"
          ? // Root + 1: the panel's top-level sections are what the wall
            // shows as tiles, and what the other three group by.
            sectionRangesFor(plan, pageCount)
          : [],
    [mode, plan, pageCount],
  );

  const viewingDistance = plan.config.viewingDistance;

  // rooms: every outbound link each section's pages contain. These hang on the
  // corridor past that section's room — the payoff of its second door — and
  // their count sizes that stretch of corridor, so the SAME list has to reach
  // every rooms entry point below or their floor plans disagree.
  const sectionLinks = React.useMemo(
    () =>
      mode === "rooms"
        ? sectionLinksFor(sectionRanges, panel, plan)
        : undefined,
    [mode, sectionRanges, panel, plan],
  );

  const roomOpts = React.useMemo(
    () => ({
      sectionRanges,
      viewingDistance,
      sectionLinks,
      // The floor is world y = 0, which in the panel-anchor space these
      // offsets live in sits the panel's own height below the anchor line.
      floorY: entry ? -entry.position.y : undefined,
    }),
    [sectionRanges, viewingDistance, sectionLinks, entry],
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
  if (readingPose && lastFocus.current !== focus) {
    if (!focusFromWalk.current) poseRef.current = readingPose;
    focusFromWalk.current = false;
    lastFocus.current = focus;
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
  // Re-derive on a focus change: being teleported into a room counts as
  // having entered it, and as having arrived at that page's spot.
  React.useEffect(() => {
    if (!isRooms) return;
    const pose = poseRef.current;
    updateRoom(pose);
    setReaderAt({ x: pose.x, z: pose.z });
    setStandingOn(focus);
  }, [isRooms, focus, updateRoom]);


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
      // The page lands on the panel slot; put the eye back on the line that
      // looks at it, or an orbited camera sees the page edge-on.
      restoreReadingView();
    },
    [mode, entry, pageCount, roomOpts, setPage, panel.id, restoreReadingView],
  );

  const navigate = React.useContext(NavigateContext);
  useRoomWalking({
    enabled: isRooms,
    poseRef,
    walls: roomShell,
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

  // elevator: the atrium the rings hang in — a deck and a lit soffit per
  // storey, a balustrade round the well the reader stands in, and the shaft
  // wall behind the pages. Scenery only; the rings themselves are unchanged.
  const elevatorShell = React.useMemo(
    () =>
      mode && entry
        ? computeElevatorShell(mode, pageCount, entry.size, focus, roomOpts)
        : null,
    [mode, entry, pageCount, focus, roomOpts],
  );

  // elevator: the page under the pointer/ray grows and closes in on its own
  // bearing (see elevatorEmphasis) instead of anything flying to the reader.
  const [pointedAt, setPointedAt] = React.useState<number | null>(null);

  // The key handler reads the focus through a ref, not the closure: holding
  // ↓ (or any burst faster than a render) would otherwise have every repeat
  // compute its target from the same stale page and land on one storey.
  const focusRef = React.useRef(focus);
  focusRef.current = focus;

  // elevator: ride the shaft from the keyboard. ↑/↓ change storey (previous
  // / next section), ←/→ step a page around the current ring. This is the
  // whole of the view's navigation — it has no pagination controls, because
  // a page-at-a-time widget makes no sense in a room you look around.
  React.useEffect(() => {
    if (mode !== "elevator") return;
    const onKey = (e: KeyboardEvent) => {
      const at = focusRef.current;
      // Never steal arrows from the URL bar or any other text field.
      const t = e.target as HTMLElement | null;
      if (
        t &&
        (t.isContentEditable ||
          t.tagName === "INPUT" ||
          t.tagName === "TEXTAREA" ||
          t.tagName === "SELECT")
      )
        return;
      let next: number | null = null;
      switch (e.key) {
        case "ArrowUp":
          next = elevatorFloorTarget(at, pageCount, sectionRanges, -1);
          break;
        case "ArrowDown":
          next = elevatorFloorTarget(at, pageCount, sectionRanges, 1);
          break;
        case "ArrowLeft":
          next = Math.max(0, at - 1);
          break;
        case "ArrowRight":
          next = Math.min(pageCount - 1, at + 1);
          break;
        default:
          return;
      }
      e.preventDefault();
      if (next !== null && next !== at) {
        focusRef.current = next; // so a burst of repeats keeps climbing
        setPage(panel.id, next);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mode, pageCount, sectionRanges, setPage, panel.id]);

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
      {elevatorShell && (
        <>
          <ElevatorShaft shell={elevatorShell} anchor={entry.position} />
          <ElevatorDirectory shell={elevatorShell} anchor={entry.position} />
        </>
      )}
      {roomShell.length > 0 && (
        <RoomShell
          walls={roomShell}
          anchor={entry.position}
          floorY={-entry.position.y}
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
        // Pointing at a ring page magnifies it in place — it grows to full
        // size and closes in to reading distance without leaving its bearing,
        // so a glance never rearranges the room.
        const elevator = mode === "elevator";
        const p =
          elevator && pointedAt === raw.pageIndex
            ? elevatorEmphasis(raw, entry.size, viewingDistance)
            : elevator && pointedAt !== null
              ? // A magnified page is full width where a slot is one ring-page
                // wide, so it necessarily stands in front of the pages either
                // side of it. Stepping those back while it is up makes that
                // read as one page in front of the others rather than as two
                // pages fighting over the same piece of wall.
                { ...raw, recession: Math.min(1, raw.recession + 0.3) }
              : raw;
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
          pointedAt === p.pageIndex ||
          nearReader ||
          (!isRooms &&
            !p.offFloor &&
            Math.abs(p.pageIndex - focus) <= LIVE_GHOST_RADIUS);
        // One persistent eased group per page (stable key), so whenever a
        // page's target transform changes — a new focus in the field views, a
        // pointer entering or leaving in the elevator — AtPos morphs it there
        // rather than cutting. The marker frame is a separate object.
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
                    controls={!elevator && !isRooms}
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
                {/* The elevator numbers every slot, and marks the one being
                    read: nothing moves when the focus changes here, so a mark
                    under the card is the only thing that can say where in the
                    section the reader is. */}
                {elevator && elevatorShell && (
                  <ElevatorSlotMark
                    width={cellW}
                    height={cellH}
                    trim={elevatorShell.trim}
                    pageIndex={p.pageIndex}
                    current={p.isStage}
                    pointed={pointedAt === p.pageIndex}
                    dim={!!p.offFloor}
                  />
                )}
                {/* In the elevator the current page sits in the wall like
                    every other one, so it needs a hit target too — being
                    current buys it no special treatment here. */}
                {(!p.isStage || elevator) && (
                  <PageHitPlane
                    width={cellW}
                    height={cellH}
                    onSelect={() => setPage(panel.id, p.pageIndex)}
                    onOver={
                      elevator ? () => setPointedAt(p.pageIndex) : undefined
                    }
                    onOut={
                      elevator
                        ? () =>
                            setPointedAt((cur) =>
                              cur === p.pageIndex ? null : cur,
                            )
                        : undefined
                    }
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
      panel={entry.size}
      viewingDistance={viewingDistance}
    >
      {field}
    </RoomWalk>
  ) : (
    field
  );
}
