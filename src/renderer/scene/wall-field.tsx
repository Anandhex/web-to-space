/**
 * scene/wall-field.tsx
 *
 * The wall view: a board of the document's OUTLINE that opens one level at a
 * time, rather than a contact sheet of every page.
 *
 *   overview → one tile per root+1 section
 *   click a tile → that section expands IN PLACE into its pages as previews
 *   click a preview → that page grows to full size, still in its own cell
 *
 * Nothing flies to a separate stage: every level of the disclosure happens in
 * the board, which reflows around whatever is open, so the sections you did
 * not open keep their place on the wall (and with it their spatial memory).
 * Clicking an open tile closes it, the full-size page carries a ✕, Escape
 * steps back one level, and ←/→ walk pages when a page is open and sections
 * when one isn't.
 *
 * Pointing at any cell leans the WHOLE board toward it — the geometry of that
 * is `computeWallCells`; everything here is state and rendering.
 */
import React from "react";
import { Text } from "@react-three/drei";

import type { XRPrimitive } from "../../mapper/types";
import type { LayoutEntry, LayoutPlan } from "../../layout/types";
import { useTheme } from "../theme";
import {
  computeWallCells,
  wallSectionOf,
  type SectionPageRange,
  type WallCell,
} from "../page-placements";
import { AtPos } from "./AtPos";
import { FontContext, type PageState } from "./contexts";
import {
  EasedScale,
  LivePageGhost,
  PageHitPlane,
  PageImposter,
  usePageHeadings,
} from "./page-cells";

/** Pages this far from the open one render as real (mini) content, not cards. */
const WALL_LIVE_PREVIEWS = 3;

/**
 * A section tile: the closed state of a whole run of pages. Shows the section
 * name, how many pages it stands for, and a chevron for its open/closed
 * state — the tile is also the affordance for closing again, so it stays on
 * the board at the head of its expanded run.
 */
function SectionTile({
  width,
  height,
  label,
  pages,
  open,
  recession,
}: {
  width: number;
  height: number;
  label: string;
  pages: number;
  open: boolean;
  recession: number;
}) {
  const theme = useTheme();
  const fontType = React.useContext(FontContext);
  const opacity = 1 - 0.4 * recession;
  return (
    <>
      <mesh position={[width / 2, -height / 2, 0]}>
        <planeGeometry args={[width, height]} />
        <meshStandardMaterial
          color={open ? theme.listItemBg : theme.navBg}
          transparent
          opacity={opacity}
          roughness={0.85}
          metalness={0}
        />
      </mesh>
      {open && (
        <mesh position={[width / 2, -height * 0.03, 0.002]}>
          <planeGeometry args={[width, height * 0.06]} />
          <meshBasicMaterial color={theme.accentCol} transparent opacity={0.9} />
        </mesh>
      )}
      <Text
        font={fontType}
        anchorX="left"
        anchorY="top"
        position={[width * 0.08, -height * 0.16, 0.003]}
        fontSize={Math.min(0.1, height * 0.15)}
        color={theme.headingCol}
        fillOpacity={opacity}
        maxWidth={width * 0.84}
        overflowWrap="break-word"
      >
        {label.slice(0, 60)}
      </Text>
      <Text
        font={fontType}
        anchorX="left"
        anchorY="bottom"
        position={[width * 0.08, -height * 0.9, 0.003]}
        fontSize={Math.min(0.06, height * 0.09)}
        color={theme.mutedTextCol}
        fillOpacity={opacity}
      >
        {`${pages} page${pages === 1 ? "" : "s"}`}
      </Text>
      <Text
        font={fontType}
        anchorX="right"
        anchorY="bottom"
        position={[width * 0.92, -height * 0.9, 0.003]}
        fontSize={Math.min(0.06, height * 0.09)}
        color={theme.accentCol}
        fillOpacity={opacity}
      >
        {open ? "▾" : "▸"}
      </Text>
    </>
  );
}

/**
 * Close affordance for the full-size page. The other cells are one big hit
 * target, but this one's content is live — a plane over it would eat every
 * link — so it gets a chip on its top edge instead.
 */
function CloseChip({ width, onClose }: { width: number; onClose: () => void }) {
  const theme = useTheme();
  const fontType = React.useContext(FontContext);
  const [hover, setHover] = React.useState(false);
  return (
    <group position={[width - 0.05, 0.055, 0.02]}>
      <mesh
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        onPointerOver={(e) => {
          e.stopPropagation();
          setHover(true);
        }}
        onPointerOut={() => setHover(false)}
      >
        <planeGeometry args={[0.09, 0.07]} />
        <meshBasicMaterial
          color={hover ? theme.accentCol : theme.navBg}
          transparent
          opacity={0.95}
        />
      </mesh>
      <Text
        font={fontType}
        anchorX="center"
        anchorY="middle"
        position={[0, 0, 0.002]}
        fontSize={0.036}
        color={theme.headingCol}
      >
        ✕
      </Text>
    </group>
  );
}

export function WallField({
  panel,
  plan,
  pageState,
  setPage,
  primitiveMap,
  sectionRanges,
}: {
  panel: XRPrimitive;
  plan: LayoutPlan;
  pageState: PageState;
  setPage: (id: string, page: number) => void;
  primitiveMap: Map<string, XRPrimitive>;
  sectionRanges: SectionPageRange[];
}) {
  const entry = plan.entries[panel.id];
  const pageCount = entry?.pagination?.pageCount ?? 1;
  const focus = pageState[panel.id] ?? 0;
  const headings = usePageHeadings(primitiveMap, plan);

  // The board starts on the outline: sections only, nothing expanded.
  const [openSection, setOpenSection] = React.useState<number | null>(null);
  const [openPage, setOpenPage] = React.useState<number | null>(null);
  const [hoverKey, setHoverKey] = React.useState<string | null>(null);

  const ranges = React.useMemo(
    () =>
      sectionRanges.length > 0
        ? sectionRanges
        : [{ start: 0, end: Math.max(0, pageCount - 1), label: "" }],
    [sectionRanges, pageCount],
  );

  // Handlers read state through this ref rather than their closure: a held
  // arrow key repeats faster than React re-renders, and every repeat would
  // otherwise start from the same stale cell and land one step away however
  // long you hold it.
  const state = React.useRef({ openSection, openPage, ranges });
  state.current = { openSection, openPage, ranges };

  // A focus change the board did NOT make — a #fragment jump, or a tab
  // restoring its page — opens the section that owns that page, so the wall
  // follows the document instead of silently disagreeing with it. Keyed off a
  // real CHANGE, so arriving on the wall still shows the outline.
  const lastFocus = React.useRef(focus);
  React.useEffect(() => {
    if (lastFocus.current === focus) return;
    lastFocus.current = focus;
    const s = state.current;
    const r = s.openSection === null ? undefined : ranges[s.openSection];
    if (r && focus >= r.start && focus <= r.end) return;
    setOpenSection(wallSectionOf(focus, ranges, pageCount));
    setOpenPage((p) => (p === null ? null : focus));
  }, [focus, ranges, pageCount]);

  const openTile = React.useCallback(
    (s: number) => {
      if (s === state.current.openSection) {
        setOpenSection(null);
        setOpenPage(null);
        return;
      }
      setOpenSection(s);
      setOpenPage(null);
      setPage(panel.id, state.current.ranges[s].start);
    },
    [setPage, panel.id],
  );

  const openPageCell = React.useCallback(
    (p: number) => {
      setOpenPage((cur) => (cur === p ? null : p));
      setPage(panel.id, p);
    },
    [setPage, panel.id],
  );

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (
        t &&
        (t.isContentEditable ||
          t.tagName === "INPUT" ||
          t.tagName === "TEXTAREA" ||
          t.tagName === "SELECT")
      )
        return;
      const s = state.current;
      if (e.key === "Escape") {
        // Step back exactly one level of disclosure.
        if (s.openPage !== null) setOpenPage(null);
        else if (s.openSection !== null) setOpenSection(null);
        else return;
        e.preventDefault();
        return;
      }
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      const dir = e.key === "ArrowRight" ? 1 : -1;
      e.preventDefault();
      if (s.openPage !== null && s.openSection !== null) {
        // Walk the open section's pages.
        const r = s.ranges[s.openSection];
        const next = Math.min(Math.max(s.openPage + dir, r.start), r.end);
        if (next === s.openPage) return;
        s.openPage = next;
        setOpenPage(next);
        setPage(panel.id, next);
        return;
      }
      // Otherwise walk the outline, opening the section stepped onto.
      const at = s.openSection ?? (dir === 1 ? -1 : s.ranges.length);
      const next = Math.min(Math.max(at + dir, 0), s.ranges.length - 1);
      if (next === s.openSection) return;
      s.openSection = next;
      setOpenSection(next);
      setOpenPage(null);
      setPage(panel.id, s.ranges[next].start);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setPage, panel.id]);

  const cells = React.useMemo(
    () =>
      entry
        ? computeWallCells(pageCount, entry.size, {
            sectionRanges: ranges,
            openSection,
            openPage,
            hoverKey,
            headingOf: (p) => headings.get(p) ?? "",
          })
        : [],
    [entry, pageCount, ranges, openSection, openPage, hoverKey, headings],
  );

  if (!entry) return null;

  const openRange = openSection === null ? null : ranges[openSection];
  const cellEntry = (c: WallCell): LayoutEntry => ({
    ...entry,
    pagination: undefined,
    curveRadius: 0,
    position: {
      x: entry.position.x + c.offset.x,
      y: entry.position.y + c.offset.y,
      z: entry.position.z + c.offset.z,
    },
    rotation: c.rotation,
  });

  return (
    <>
      {cells.map((c) => {
        const w = entry.size.width * c.scale;
        const h = entry.size.height * c.scale;
        const ce = cellEntry(c);
        const isOpenPage = c.kind === "page" && c.open;
        // One persistent eased group per cell (stable key), so opening a
        // level reflows the board by morphing every cell to its new slot
        // instead of cutting to a new arrangement.
        return (
          <AtPos key={c.key} entry={ce}>
            <EasedScale target={c.scale}>
              {c.kind === "section" ? (
                <SectionTile
                  width={w}
                  height={h}
                  label={c.label}
                  pages={c.pages ?? 0}
                  open={c.open}
                  recession={c.recession}
                />
              ) : renderLive(c, openRange, openPage) ? (
                <LivePageGhost
                  panel={panel}
                  plan={plan}
                  primitiveMap={primitiveMap}
                  entry={ce}
                  targetPage={c.pageIndex!}
                  scale={c.scale}
                  recession={c.recession}
                  // The flat top/bottom clip planes only hold while the cell
                  // is unpitched, which a leaning board rarely is; clipping
                  // is a safety net here, not a correctness requirement.
                  clip={c.rotation.x === 0}
                  // Only the full-size page is interactive — on a preview a
                  // ray hit means "open this page", never "follow that link".
                  stage={isOpenPage}
                  controls={false}
                  setPage={setPage}
                />
              ) : (
                <PageImposter
                  width={w}
                  height={h}
                  pageIndex={c.pageIndex!}
                  heading={headings.get(c.pageIndex!)}
                  recession={c.recession}
                />
              )}
              {isOpenPage ? (
                <CloseChip width={w} onClose={() => setOpenPage(null)} />
              ) : (
                <PageHitPlane
                  width={w}
                  height={h}
                  onSelect={() =>
                    c.kind === "section"
                      ? openTile(c.sectionIndex)
                      : openPageCell(c.pageIndex!)
                  }
                  onOver={() => setHoverKey(c.key)}
                  onOut={() =>
                    setHoverKey((cur) => (cur === c.key ? null : cur))
                  }
                />
              )}
            </EasedScale>
          </AtPos>
        );
      })}
    </>
  );
}

/**
 * Preview policy: a real (mini) render of the page beats an imposter card,
 * but only pages near the one being read are worth the troika text cost —
 * a section can be dozens of pages long.
 */
function renderLive(
  c: WallCell,
  openRange: SectionPageRange | null,
  openPage: number | null,
): boolean {
  if (c.kind !== "page" || c.pageIndex === undefined) return false;
  if (c.open) return true;
  const anchor = openPage ?? openRange?.start ?? 0;
  return Math.abs(c.pageIndex - anchor) <= WALL_LIVE_PREVIEWS;
}
