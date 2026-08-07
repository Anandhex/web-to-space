import React, { useState, useRef, useMemo, Suspense, useEffect } from "react";
import { Canvas } from "@react-three/fiber";
import { Stars, OrbitControls, Text } from "@react-three/drei";
import * as THREE from "three";
import { Surface } from "../renderer/primitives";
import {
  XR3DTabBar,
  XR3DSearchBar,
  XR3DButton,
  XR3DViewToggle,
  isViewModeFit,
} from "./XR3DChrome";
import type { Tab, ViewMode } from "./viewTypes";
import type { XRDeviceType } from "../renderer/XRSceneRenderer";
import type { ParserConfig, ParserBackend } from "../ir/types";
import {
  LIGHT_THEME,
  DARK_THEME,
  THEME_FIELD_LABELS,
  type XRTheme,
} from "../renderer/theme";
import { contrast } from "../renderer/scene/section-tint";
import { SR_ONLY, usePrefersReducedMotion } from "./a11y";

// Re-exported so existing importers of these from this module keep working.
export { SR_ONLY };

// ─────────────────────────────────────────────────────────────
// Types & defaults
// ─────────────────────────────────────────────────────────────

export interface HomeTheme {
  /**
   * The brand blue. Used for FILLS, rims and focus rings — things WCAG scores
   * as non-text UI (3:1) — never as small ink: #0082FB on the card surface is
   * 3.6:1, which is fine for a chip and not fine for a label.
   */
  accent: string;
  /** The same brand blue lifted until it passes 4.5:1 as ink on a card. */
  accentText: string;
  accentDim: string;
  background: string;
  canvasBg: string;
  cardBg: string;
  cardHover: string;
  /**
   * The board the card grid stands on. Deliberately DARKER than the cards, so
   * they read as raised off it. It is a grouping cue rather than a control, so
   * it is not held to 3:1 itself — the card RIM is what has to be identifiable
   * against it, and that is measured.
   */
  boardBg: string;
  /** The accent chip carrying a destination's initial. */
  chipBg: string;
  chipBgActive: string;
  /** Hairline rule inside a card. Held at 3:1 — an invisible rule is not one. */
  divider: string;
  /**
   * The card's edge. A dark card on a dark starfield cannot reach 3:1 on fill
   * alone without turning into a light grey slab, so the rim is what carries
   * the boundary — which is what SC 1.4.11 actually asks for.
   */
  cardRim: string;
  textPrimary: string;
  textSecondary: string;
  /** Tertiary ink — the URL line. Still held at 4.5:1; it is real text. */
  textMuted: string;
}

export interface HomeSettings {
  deviceType: XRDeviceType;
  theme: HomeTheme;
  /** Colour palette applied to the 3D document viewer (XRSceneRenderer), not the home screen itself. */
  xrTheme: XRTheme;
  parserConfig: Partial<ParserConfig>;
  parserBackend: ParserBackend;
  /**
   * Spatial arrangement the page opens in. Chosen here on the Home screen —
   * the document viewer has no switcher of its own, so the view is decided
   * before launch and travels with the tab.
   */
  viewMode: ViewMode;
}

/**
 * Meta Horizon OS palette — neutral charcoal surfaces, #0082FB brand accent,
 * the same design language as the 3D document viewer's DARK_THEME.
 *
 * Every pair is measured rather than eyeballed. The previous values put the
 * cards at #525256, a mid-grey with no headroom in either direction: seven of
 * fourteen foreground/background pairs failed WCAG AA, the worst being the
 * URL line at 1.82:1 and the divider at 1.13:1 — a rule you cannot see. The
 * card surface moved DOWN instead (dark card, light ink), which is what gives
 * the secondary and muted inks somewhere to go, and the boundary moved from
 * the fill to the rim.
 */
export const DEFAULT_HOME_THEME: HomeTheme = {
  accent: "#0082FB",
  accentText: "#6BAEFF",
  accentDim: "#0A4A8A",
  background: "#131315",
  canvasBg: "#0B0B0D",
  cardBg: "#2E2E32",
  cardHover: "#3C3C42",
  boardBg: "#1A1A1E",
  chipBg: "#1E3350",
  chipBgActive: "#1A3454",
  divider: "#7A7A84",
  cardRim: "#6E6E76",
  textPrimary: "#F5F5F5",
  textSecondary: "#B8B8BE",
  textMuted: "#A8A8B0",
};

export const DEFAULT_HOME_SETTINGS: HomeSettings = {
  deviceType: "QUEST_3",
  theme: DEFAULT_HOME_THEME,
  xrTheme: DARK_THEME,
  parserConfig: {},
  parserBackend: "custom",
  viewMode: "standard",
};

export const HOME_THEME_FIELD_LABELS: Record<keyof HomeTheme, string> = {
  accent: "Accent (fills, rings)",
  accentText: "Accent as ink",
  accentDim: "Accent (dim)",
  background: "Page background",
  canvasBg: "Canvas background",
  cardBg: "Card",
  cardHover: "Card (hover)",
  cardRim: "Card border",
  boardBg: "Launcher board",
  chipBg: "Initial chip",
  chipBgActive: "Initial chip (hover)",
  divider: "Card rule",
  textPrimary: "Text primary",
  textSecondary: "Text secondary",
  textMuted: "Text muted (URL)",
};

/**
 * Every foreground/background pair the launcher actually draws, with the WCAG
 * level each has to clear: 4.5:1 for text, 3:1 for the boundaries and rings
 * that identify a control.
 *
 * The palette is user-editable, and a colour picker will happily produce a
 * launcher nobody can read — the defaults shipped with seven failing pairs,
 * including a URL line at 1.82:1. This is what the Settings panel checks
 * against so a broken palette says so instead of just looking a bit murky.
 */
export function homeContrastPairs(
  t: HomeTheme,
): { label: string; fg: string; bg: string; need: number }[] {
  return [
    { label: "Card title", fg: t.textPrimary, bg: t.cardBg, need: 4.5 },
    { label: "Card subtitle", fg: t.textSecondary, bg: t.cardBg, need: 4.5 },
    {
      label: "Card subtitle (hover)",
      fg: t.textSecondary,
      bg: t.cardHover,
      need: 4.5,
    },
    { label: "Card URL", fg: t.textMuted, bg: t.cardBg, need: 4.5 },
    { label: "Card URL (hover)", fg: t.textMuted, bg: t.cardHover, need: 4.5 },
    { label: "Open hint", fg: t.accentText, bg: t.cardHover, need: 4.5 },
    { label: "Chip initial", fg: t.accentText, bg: t.chipBg, need: 4.5 },
    {
      label: "Chip initial (hover)",
      fg: t.accentText,
      bg: t.chipBgActive,
      need: 4.5,
    },
    { label: "Card border on board", fg: t.cardRim, bg: t.boardBg, need: 3 },
    { label: "Card border on canvas", fg: t.cardRim, bg: t.canvasBg, need: 3 },
    { label: "Card rule", fg: t.divider, bg: t.cardBg, need: 3 },
    { label: "Focus ring on card", fg: t.accent, bg: t.cardBg, need: 3 },
    { label: "Focus ring on board", fg: t.accent, bg: t.boardBg, need: 3 },
    { label: "Heading on canvas", fg: t.textPrimary, bg: t.canvasBg, need: 3 },
    {
      label: "Subheading on canvas",
      fg: t.textSecondary,
      bg: t.canvasBg,
      need: 4.5,
    },
  ];
}

const LS_KEY = "fsw-home-settings";

function loadStoredSettings(): HomeSettings {
  // try {
  //   const raw = localStorage.getItem(LS_KEY);
  //   if (raw) {
  //     const parsed = JSON.parse(raw);
  //     return {
  //       ...DEFAULT_HOME_SETTINGS,
  //       ...parsed,
  //       theme: { ...DEFAULT_HOME_THEME, ...(parsed.theme ?? {}) },
  //       xrTheme: { ...DARK_THEME, ...(parsed.xrTheme ?? {}) },
  //       parserConfig: parsed.parserConfig ?? {},
  //       parserBackend: parsed.parserBackend ?? "custom",
  //     };
  //   }
  // } catch {}
  return DEFAULT_HOME_SETTINGS;
}

function hexToRgb(hex: string): string {
  const r = parseInt(hex.slice(1, 3), 16) || 0;
  const g = parseInt(hex.slice(3, 5), 16) || 0;
  const b = parseInt(hex.slice(5, 7), 16) || 0;
  return `${r}, ${g}, ${b}`;
}

// ─────────────────────────────────────────────────────────────
// Preset sites
// ─────────────────────────────────────────────────────────────

// Sentinel URL for the built-in renderer test page. Resolved to an absolute
// same-origin URL at click time (see handleLoad) so it can be fetched directly
// without the CORS proxy, and so the parser can resolve relative asset URLs.
export const TEST_PAGE_TOKEN = "__test_elements__";
const TEST_PAGE_PATH = "/test-elements.html";

export interface PresetSite {
  id: string;
  title: string;
  subtitle: string;
  url: string;
  initial: string;
}

/**
 * The six destinations, in grid order. The renderer test page is NOT one of
 * them — it is a local smoke test, a different kind of thing from a website,
 * and giving it the seventh cell of a six-cell grid left it orphaned on a row
 * of its own 1.8 m below the others (a 30° drop in gaze). It gets its own
 * strip under the grid instead; see UTILITY_SITE.
 */
const PRESET_SITES: PresetSite[] = [
  {
    id: "nasa",
    title: "NASA",
    subtitle: "Space exploration & science",
    url: "https://www.nasa.gov/",
    initial: "N",
  },
  {
    id: "wikipedia",
    title: "Wikipedia",
    subtitle: "The free encyclopedia",
    url: "https://en.wikipedia.org/wiki/Space",
    initial: "W",
  },
  {
    id: "mdn",
    title: "MDN Web Docs",
    subtitle: "Web developer reference",
    url: "https://developer.mozilla.org/",
    initial: "M",
  },
  {
    id: "github",
    title: "GitHub",
    subtitle: "Open source & code exploration",
    url: "https://github.com/explore",
    initial: "G",
  },
  {
    id: "webdev",
    title: "web.dev",
    subtitle: "Modern web guidance & tools",
    url: "https://web.dev/",
    initial: "D",
  },
  {
    id: "test-elements",
    title: "Renderer Test Page",
    subtitle: "Every primitive + edge cases · local smoke test",
    url: TEST_PAGE_TOKEN,
    initial: "▦",
  },
];

// ─────────────────────────────────────────────────────────────
// Launcher geometry
//
// The grid used to be a flat table of seven hand-written positions on the
// plane z = −3, spanning y −0.3 → 2.1. Measured from the camera at
// (0, 1.5, 2.8) that is a 5.8 m reach and a vertical span of ±30° — the
// bottom card sat a metre and a half below the eye line, and it collided in
// screen space with the in-world search bar 3.5 m nearer the viewer.
//
// Everything below is derived from one arc instead: cards sit on a cylinder
// centred on the viewer, so every card is the same distance (one
// accommodation, one focal plane) and each is yawed to face them squarely
// rather than raked away at the edges. The band is chosen to clear the chrome
// stack, which occupies roughly −12° to −33° of elevation in front of it.
// ─────────────────────────────────────────────────────────────

/** Where the launcher's camera sits — the centre of the card cylinder. */
const HOME_EYE: [number, number, number] = [0, 1.5, 2.8];
/** Radius of that cylinder: every card is exactly this far from the eye. */
const HOME_RADIUS = 3.4;

const CARD_W = 1.16;
const CARD_H = 0.62;
const CARD_GAP_X = 0.1;
const CARD_GAP_Y = 0.11;
const CARD_COLS = 3;

/** The utility strip under the grid — wider and shorter than a card. */
const UTIL_W = CARD_COLS * CARD_W + (CARD_COLS - 1) * CARD_GAP_X;
const UTIL_H = 0.28;

/**
 * Elevation of the BOTTOM of the whole board.
 *
 * The chrome stack sits 2.3–2.6 m from the eye and runs from −10.8° down to
 * −29.9°; the board is 3.4 m away, so the two never intersect in world space
 * and would happily overlap on screen. This clears the top of that band by
 * ~2°, and the board's height then falls out of it: the whole launcher spans
 * −8.5° to +20°, inside the comfortable vertical viewing zone.
 */
const BOARD_BOTTOM_DEG = -8.5;

const DEG = Math.PI / 180;

/** World y at a given elevation on the card cylinder. */
function yAtElevation(deg: number): number {
  return HOME_EYE[1] + HOME_RADIUS * Math.tan(deg * DEG);
}

const BOARD_BOTTOM_Y = yAtElevation(BOARD_BOTTOM_DEG);
const GRID_ROWS = Math.ceil(PRESET_SITES.length / CARD_COLS);
const BOARD_INNER_H =
  UTIL_H + CARD_GAP_Y + GRID_ROWS * CARD_H + (GRID_ROWS - 1) * CARD_GAP_Y;
const BOARD_PAD = 0.12;

export interface CardPose {
  position: [number, number, number];
  /** Yaw that turns the card square-on to the eye. */
  yaw: number;
}

/**
 * Place a cell of width `w` whose centre is `alongX` metres along the arc from
 * dead ahead, at world height `y`. The arc offset is converted to an angle so
 * the row wraps around the reader instead of running off on a flat plane.
 */
function arcPose(alongX: number, y: number): CardPose {
  const theta = alongX / HOME_RADIUS;
  return {
    position: [
      HOME_EYE[0] + HOME_RADIUS * Math.sin(theta),
      y,
      HOME_EYE[2] - HOME_RADIUS * Math.cos(theta),
    ],
    yaw: -theta,
  };
}

/** Pose of the i-th destination card, in reading order (left→right, top→down). */
export function cardPose(i: number): CardPose {
  const col = i % CARD_COLS;
  const row = Math.floor(i / CARD_COLS);
  const alongX = (col - (CARD_COLS - 1) / 2) * (CARD_W + CARD_GAP_X);
  const topRowY = BOARD_BOTTOM_Y + BOARD_INNER_H - CARD_H / 2;
  return arcPose(alongX, topRowY - row * (CARD_H + CARD_GAP_Y));
}

/** Pose of the utility strip, under the last grid row. */
export function utilityPose(): CardPose {
  return arcPose(0, BOARD_BOTTOM_Y + UTIL_H / 2);
}

// ─────────────────────────────────────────────────────────────
// 3D Components
// ─────────────────────────────────────────────────────────────

interface SiteCardProps {
  site: PresetSite;
  pose: CardPose;
  /** Cell size — the utility strip is wider and shorter than a grid card. */
  width: number;
  height: number;
  onSelect: (url: string) => void;
  disabled: boolean;
  theme: HomeTheme;
  /**
   * This cell owns keyboard focus. Driven by the DOM layer's focus, not by
   * anything in the canvas: the ring IS the focus indicator for a sighted
   * keyboard user, so it has to track the real focus and not a mouse hover.
   */
  focused: boolean;
}

/**
 * One destination.
 *
 * Hover and focus are drawn DIFFERENTLY on purpose. Hover lifts the fill and
 * warms the rim; focus draws a separate accent ring standing proud of the
 * card, sized so it is still visible when the card is also hovered. Using one
 * treatment for both would leave a keyboard user unable to tell where they
 * are the moment the pointer happened to be resting somewhere.
 */
function SiteCard({
  site,
  pose,
  width,
  height,
  onSelect,
  disabled,
  theme,
  focused,
}: SiteCardProps) {
  const [hovered, setHovered] = useState(false);
  const groupRef = useRef<THREE.Group>(null);

  const active = (hovered || focused) && !disabled;
  const halfW = width / 2;
  const halfH = height / 2;
  const pad = height * 0.13;
  const chip = height * 0.3;
  // Type scale, proportional to the cell so the utility strip and the grid
  // cards share one ratio rather than two hand-picked sets of sizes.
  const titleSize = height * 0.133;
  const bodySize = height * 0.088;
  const metaSize = height * 0.072;

  return (
    <group ref={groupRef} position={pose.position} rotation={[0, pose.yaw, 0]}>
      {/* Focus ring — behind the card, standing proud on every side. */}
      {focused && (
        <Surface
          width={width + 0.05}
          height={height + 0.05}
          radius={0.09}
          color={theme.accent}
          flat
          origin={[0, 0]}
          z={-0.006}
        />
      )}

      {/* Invisible hit plane so the whole card is one click target. */}
      <mesh
        position={[0, 0, 0.004]}
        onPointerOver={(e) => {
          e.stopPropagation();
          if (!disabled) {
            setHovered(true);
            document.body.style.cursor = "pointer";
          }
        }}
        onPointerOut={() => {
          setHovered(false);
          document.body.style.cursor = "default";
        }}
        onClick={(e) => {
          e.stopPropagation();
          if (!disabled) onSelect(site.url);
        }}
      >
        <planeGeometry args={[width, height]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} />
      </mesh>

      <Surface
        width={width}
        height={height}
        radius={0.07}
        color={active ? theme.cardHover : theme.cardBg}
        flat
        rimColor={active ? theme.accent : theme.cardRim}
        rimOpacity={active ? 1 : 0.85}
        origin={[0, 0]}
      />

      {/* Accent chip carrying the initial, top-left. */}
      <group
        position={[-halfW + pad + chip / 2, halfH - pad - chip / 2, 0.004]}
      >
        <Surface
          width={chip}
          height={chip}
          radius={chip * 0.26}
          color={active ? theme.chipBgActive : theme.chipBg}
          flat
          rimColor={theme.accent}
          rimOpacity={active ? 1 : 0.6}
          origin={[0, 0]}
        />
        <Text
          position={[0, 0, 0.006]}
          fontSize={chip * 0.52}
          color={theme.accentText}
          anchorX="center"
          anchorY="middle"
        >
          {site.initial}
        </Text>
      </group>

      {/* Title, right of the chip */}
      <Text
        position={[
          -halfW + pad + chip + pad * 0.7,
          halfH - pad - chip * 0.34,
          0.006,
        ]}
        fontSize={titleSize}
        color={theme.textPrimary}
        anchorX="left"
        anchorY="middle"
        maxWidth={width - (pad * 2 + chip + pad * 0.7)}
        letterSpacing={-0.01}
      >
        {site.title}
      </Text>

      {/* Subtitle spans the full width below the header */}
      <Text
        position={[-halfW + pad, halfH - pad - chip - pad * 0.75, 0.006]}
        fontSize={bodySize}
        color={theme.textSecondary}
        anchorX="left"
        anchorY="top"
        maxWidth={width - 2 * pad}
        lineHeight={1.3}
      >
        {site.subtitle}
      </Text>

      {/* Rule above the footer row */}
      <mesh position={[0, -halfH + pad * 1.5, 0.005]}>
        <planeGeometry args={[width - 2 * pad, 0.004]} />
        <meshBasicMaterial
          color={active ? theme.accent : theme.divider}
          transparent
          opacity={active ? 0.9 : 0.55}
        />
      </mesh>

      {/* Footer: host on the left, the Open affordance on the right */}
      <Text
        position={[-halfW + pad, -halfH + pad * 0.72, 0.006]}
        fontSize={metaSize}
        color={theme.textMuted}
        anchorX="left"
        anchorY="middle"
        maxWidth={width - 2 * pad - 0.34}
      >
        {site.url === TEST_PAGE_TOKEN
          ? "localhost"
          : site.url.replace(/^https?:\/\//, "")}
      </Text>
      {active && (
        <Text
          position={[halfW - pad, -halfH + pad * 0.72, 0.006]}
          fontSize={metaSize}
          color={theme.accentText}
          anchorX="right"
          anchorY="middle"
        >
          Open →
        </Text>
      )}
    </group>
  );
}

/**
 * The board the grid stands on: one dark surface behind every cell, following
 * the same arc they sit on. Same reason the wall has a backing and the desk
 * has one — cards floating in a starfield have nothing behind them, so their
 * text sits on whatever star happens to be there, and nothing says the six of
 * them are one set.
 */
function LauncherBoard({ theme }: { theme: HomeTheme }) {
  const w = UTIL_W + 2 * BOARD_PAD;
  const h = BOARD_INNER_H + 2 * BOARD_PAD;
  const pose = arcPose(0, BOARD_BOTTOM_Y + BOARD_INNER_H / 2);
  return (
    <group
      position={[pose.position[0], pose.position[1], pose.position[2] - 0.03]}
      rotation={[0, pose.yaw, 0]}
    >
      <Surface
        width={w}
        height={h}
        radius={0.12}
        color={theme.boardBg}
        flat
        rimColor={theme.cardRim}
        rimOpacity={0.35}
        origin={[0, 0]}
      />
    </group>
  );
}

/**
 * The launcher's heading, on the same arc just above the board.
 *
 * It used to be 0.36 m of type at (0, 3.1, −3.0) — 1.6 m above the eye line
 * and subtending nearly 7°, which is not a heading so much as a billboard.
 * Sized against the board instead, and kept inside the vertical band.
 */
function SceneTitle({ theme }: { theme: HomeTheme }) {
  const pose = arcPose(0, BOARD_BOTTOM_Y + BOARD_INNER_H + BOARD_PAD + 0.19);
  return (
    <group position={pose.position} rotation={[0, pose.yaw, 0]}>
      <Text
        fontSize={0.15}
        color={theme.textPrimary}
        anchorX="center"
        anchorY="middle"
        letterSpacing={0.01}
      >
        From Space to Web
      </Text>
      <Text
        position={[0, -0.13, 0]}
        fontSize={0.062}
        color={theme.textSecondary}
        anchorX="center"
        anchorY="middle"
        letterSpacing={0.03}
      >
        Choose a destination — or enter any URL
      </Text>
    </group>
  );
}

// ─────────────────────────────────────────────────────────────
// Accessibility layer
//
// Everything the launcher draws lives on a WebGL canvas: to a screen reader
// the whole screen was one <canvas> with no accessible name, and to a
// keyboard it was a single 1×1 invisible <input>. Six destinations, a
// settings panel, a tab bar and a view picker, none of them reachable without
// a mouse and none of them announced.
//
// The fix is the standard one for canvas UI: a real DOM control per canvas
// affordance, kept in the accessibility tree and in the tab order but drawn
// nowhere, with DOM focus mirrored back into the scene as a visible ring. The
// canvas stays the presentation; the DOM is the interface. Two rules make it
// work and are easy to get wrong:
//
//  • The controls must NOT be `display:none` or `visibility:hidden` — either
//    removes them from the tree and from the tab order, which is the whole
//    point. They are clipped to a 1 px box instead.
//  • Focus must be genuinely on them, so the browser's own focus management,
//    screen-reader virtual cursor and `:focus-visible` all keep working. The
//    ring in the scene is a mirror of that state, never a substitute for it.
// ─────────────────────────────────────────────────────────────

export interface A11yTarget {
  id: string;
  label: string;
  hint: string;
  onActivate: () => void;
}

/**
 * The keyboard/screen-reader interface to the card grid.
 *
 * Roving tabindex: the grid is ONE tab stop and the arrow keys move within
 * it, which is what a grid of peers should do — six separate tab stops would
 * make getting past the launcher a six-key journey. Home/End jump to the ends.
 */
export function CardGridA11y({
  targets,
  focusIndex,
  setFocusIndex,
  disabled,
  cols,
  itemRefs,
}: {
  targets: A11yTarget[];
  focusIndex: number;
  setFocusIndex: (i: number) => void;
  disabled: boolean;
  cols: number;
  itemRefs: React.MutableRefObject<(HTMLButtonElement | null)[]>;
}) {
  const move = (next: number) => {
    const i = Math.max(0, Math.min(targets.length - 1, next));
    setFocusIndex(i);
    itemRefs.current[i]?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent, i: number) => {
    switch (e.key) {
      case "ArrowRight":
        e.preventDefault();
        move(i + 1);
        break;
      case "ArrowLeft":
        e.preventDefault();
        move(i - 1);
        break;
      case "ArrowDown":
        e.preventDefault();
        move(i + cols);
        break;
      case "ArrowUp":
        e.preventDefault();
        move(i - cols);
        break;
      case "Home":
        e.preventDefault();
        move(0);
        break;
      case "End":
        e.preventDefault();
        move(targets.length - 1);
        break;
      default:
        break;
    }
  };

  return (
    <ul style={{ ...SR_ONLY, listStyle: "none" }} aria-label="Destinations">
      {targets.map((t, i) => (
        <li key={t.id}>
          <button
            ref={(el) => {
              itemRefs.current[i] = el;
            }}
            type="button"
            // Roving tabindex — only the current cell is in the tab order.
            tabIndex={i === focusIndex ? 0 : -1}
            disabled={disabled}
            onFocus={() => setFocusIndex(i)}
            onKeyDown={(e) => onKeyDown(e, i)}
            onClick={t.onActivate}
          >
            {t.label}. {t.hint}
          </button>
        </li>
      ))}
    </ul>
  );
}

// ─────────────────────────────────────────────────────────────
// Settings panel sub-components
// ─────────────────────────────────────────────────────────────

function Toggle({
  value,
  onChange,
  accent,
}: {
  value: boolean;
  onChange: (v: boolean) => void;
  accent: string;
}) {
  return (
    <div
      onClick={() => onChange(!value)}
      style={{
        width: 36,
        height: 20,
        borderRadius: 10,
        flexShrink: 0,
        background: value ? accent : "#1a2840",
        border: `1px solid ${value ? accent : "#253550"}`,
        cursor: "pointer",
        position: "relative",
        transition: "background 0.2s, border-color 0.2s",
      }}
    >
      <div
        style={{
          position: "absolute",
          top: 3,
          left: value ? 17 : 3,
          width: 14,
          height: 14,
          borderRadius: 7,
          background: value ? "#fff" : "#4a6080",
          transition: "left 0.18s",
        }}
      />
    </div>
  );
}

function ColorSwatch({
  label,
  value,
  onChange,
  theme,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  theme: HomeTheme;
}) {
  return (
    <label
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        marginBottom: 8,
        cursor: "pointer",
      }}
    >
      <span style={{ flex: 1, fontSize: 12, color: theme.textPrimary }}>
        {label}
      </span>
      <div style={{ position: "relative", width: 28, height: 20 }}>
        <div
          style={{
            width: 28,
            height: 20,
            borderRadius: 4,
            background: value,
            border: "1px solid rgba(255,255,255,0.15)",
            pointerEvents: "none",
          }}
        />
        <input
          type="color"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          style={{
            position: "absolute",
            inset: 0,
            opacity: 0,
            cursor: "pointer",
            width: "100%",
            height: "100%",
          }}
        />
      </div>
      <span
        style={{
          fontSize: 11,
          color: theme.textSecondary,
          fontFamily: "monospace",
          width: 60,
        }}
      >
        {value}
      </span>
    </label>
  );
}

/**
 * Live WCAG check on the editable palette. Silent when everything passes, so
 * it only speaks up when a picked colour has actually broken something.
 */
function ContrastReport({ theme }: { theme: HomeTheme }) {
  const failing = homeContrastPairs(theme)
    .map((p) => ({ ...p, ratio: contrast(p.fg, p.bg) }))
    .filter((p) => p.ratio < p.need);

  if (failing.length === 0) {
    return (
      <div style={{ fontSize: 11, color: theme.textSecondary, marginTop: 8 }}>
        ✓ All {homeContrastPairs(theme).length} colour pairs meet WCAG AA.
      </div>
    );
  }
  return (
    <div
      role="status"
      style={{
        marginTop: 8,
        padding: "8px 10px",
        borderRadius: 6,
        background: "rgba(220, 80, 60, 0.12)",
        border: "1px solid rgba(220, 80, 60, 0.45)",
      }}
    >
      <div style={{ fontSize: 11, color: "#FFB3A6", marginBottom: 4 }}>
        {failing.length} colour pair{failing.length === 1 ? "" : "s"} below WCAG
        AA:
      </div>
      {failing.map((p) => (
        <div
          key={p.label}
          style={{ fontSize: 10, color: theme.textSecondary, lineHeight: 1.6 }}
        >
          {p.label} — {p.ratio.toFixed(2)}:1 (needs {p.need}:1)
        </div>
      ))}
    </div>
  );
}

function SectionHeader({ title, accent }: { title: string; accent: string }) {
  return (
    <div
      style={{
        fontSize: 10,
        fontWeight: 700,
        letterSpacing: "0.1em",
        color: accent,
        opacity: 0.7,
        marginBottom: 12,
      }}
    >
      {title}
    </div>
  );
}

function SettingsSection({
  title,
  accent,
  children,
}: {
  title: string;
  accent: string;
  children: React.ReactNode;
}) {
  return (
    <div
      style={{
        padding: "16px 20px",
        borderBottom: "1px solid rgba(255,255,255,0.05)",
      }}
    >
      <SectionHeader title={title} accent={accent} />
      {children}
    </div>
  );
}

function ParserToggle({
  label,
  desc,
  value,
  onChange,
  theme,
}: {
  label: string;
  desc: string;
  value: boolean;
  onChange: (v: boolean) => void;
  theme: HomeTheme;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: 10,
        marginBottom: 10,
      }}
    >
      <div style={{ flex: 1 }}>
        <div
          style={{ fontSize: 12, color: theme.textPrimary, marginBottom: 2 }}
        >
          {label}
        </div>
        <div style={{ fontSize: 11, color: theme.textSecondary }}>{desc}</div>
      </div>
      <Toggle value={value} onChange={onChange} accent={theme.accent} />
    </div>
  );
}

function ParserNumber({
  label,
  value,
  onChange,
  theme,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  theme: HomeTheme;
}) {
  return (
    <label
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        marginBottom: 8,
      }}
    >
      <span style={{ flex: 1, fontSize: 12, color: theme.textPrimary }}>
        {label}
      </span>
      <input
        type="number"
        min={2}
        max={10}
        value={value}
        onChange={(e) =>
          onChange(Math.max(2, Math.min(10, Number(e.target.value))))
        }
        style={{
          width: 52,
          background: "#0a1220",
          border: "1px solid #1a3a6a",
          color: theme.textPrimary,
          borderRadius: 4,
          padding: "3px 6px",
          fontSize: 12,
          textAlign: "center",
          outline: "none",
        }}
      />
    </label>
  );
}

// ─────────────────────────────────────────────────────────────
// Settings panel
// ─────────────────────────────────────────────────────────────

const DEVICES: {
  id: XRDeviceType;
  label: string;
  desc: string;
  icon: string;
}[] = [
  { id: "QUEST_3", label: "Quest 3", desc: "Full VR · 110° FOV", icon: "◉" },
  {
    id: "QUEST_PRO",
    label: "Quest Pro",
    desc: "Mixed Reality · 100° FOV",
    icon: "◎",
  },
  {
    id: "RAY_BAN_META",
    label: "Ray-Ban Meta",
    desc: "AR Glasses · 40° FOV",
    icon: "◯",
  },
];

const BACKENDS: {
  id: ParserBackend;
  icon: string;
  label: string;
  desc: string;
}[] = [
  {
    id: "custom",
    icon: "⬡",
    label: "Custom Pipeline",
    desc: "ARIA + structural inference + wrapper piercing — 3 semantic layers",
  },
  {
    id: "readability",
    icon: "◎",
    label: "Mozilla Readability",
    desc: "@mozilla/readability article extractor — strips nav/ads, returns clean content",
  },
  {
    id: "naive",
    icon: "◯",
    label: "Naive (Tags Only)",
    desc: "Basic HTML tag → role mapping · No ARIA, no inference",
  },
  {
    id: "flat",
    icon: "▭",
    label: "Browser Panel",
    desc: "Raw HTML in a flat iframe — no XR processing, like a traditional VR browser",
  },
  {
    id: "vips",
    icon: "◈",
    label: "VIPS Visual Blocks",
    desc: "Cai et al. 2003 — DOM-based visual block segmentation, then semantic pipeline",
  },
  {
    id: "web2vr",
    icon: "⬕",
    label: "Web2VR",
    desc: "kikoano/web2vr — direct CSS layout → 3D via getBoundingClientRect() (no semantic parsing)",
  },
];

function SettingsPanel({
  settings,
  onChange,
  onClose,
}: {
  settings: HomeSettings;
  onChange: (s: HomeSettings) => void;
  onClose: () => void;
}) {
  const {
    theme,
    xrTheme,
    deviceType,
    parserConfig: pc,
    parserBackend,
  } = settings;
  const acc = theme.accent;

  const updateTheme = (partial: Partial<HomeTheme>) =>
    onChange({ ...settings, theme: { ...theme, ...partial } });
  const updateXrTheme = (partial: Partial<XRTheme>) =>
    onChange({ ...settings, xrTheme: { ...xrTheme, ...partial } });
  const updateParser = (partial: Partial<ParserConfig>) =>
    onChange({ ...settings, parserConfig: { ...pc, ...partial } });
  // Not every view survives every device — wall/deck/rooms need room-scale
  // 6DoF. Drop back to Standard rather than launching into a view the newly
  // selected device cannot present.
  const updateDevice = (dt: XRDeviceType) =>
    onChange({
      ...settings,
      deviceType: dt,
      viewMode: isViewModeFit(settings.viewMode, dt)
        ? settings.viewMode
        : "standard",
    });
  const updateBackend = (b: ParserBackend) =>
    onChange({ ...settings, parserBackend: b });

  // Resolve each boolean against its default value
  const bool = (key: keyof ParserConfig, def: boolean): boolean =>
    pc[key] !== undefined ? (pc[key] as boolean) : def;

  return (
    <div
      id="fsw-settings"
      role="dialog"
      aria-label="Settings"
      style={{
        position: "fixed",
        top: 0,
        right: 0,
        bottom: 0,
        width: 360,
        background: "rgba(6, 10, 20, 0.97)",
        backdropFilter: "blur(24px)",
        WebkitBackdropFilter: "blur(24px)",
        borderLeft: `1px solid rgba(${hexToRgb(acc)}, 0.2)`,
        zIndex: 500,
        display: "flex",
        flexDirection: "column",
        fontFamily: "system-ui, -apple-system, sans-serif",
        boxShadow: `-8px 0 40px rgba(0,0,0,0.5)`,
      }}
    >
      {/* Header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "16px 20px",
          borderBottom: "1px solid rgba(255,255,255,0.06)",
          flexShrink: 0,
        }}
      >
        <span
          style={{ color: theme.textPrimary, fontSize: 15, fontWeight: 600 }}
        >
          ⚙ Settings
        </span>
        <button
          onClick={onClose}
          style={{
            background: "none",
            border: "none",
            color: theme.textSecondary,
            cursor: "pointer",
            fontSize: 18,
            padding: "2px 6px",
            lineHeight: 1,
          }}
        >
          ✕
        </button>
      </div>

      <div style={{ flex: 1, overflowY: "auto" }}>
        {/* ── Parser Backend ──────────────────────────── */}
        <SettingsSection title="PARSER BACKEND" accent={acc}>
          <p
            style={{
              color: theme.textSecondary,
              fontSize: 11,
              margin: "0 0 12px",
              lineHeight: 1.5,
            }}
          >
            Selects how HTML is pre-processed before entering the XR pipeline.
            Switch backends and reload the same URL to compare output.
          </p>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {BACKENDS.map((b) => (
              <button
                key={b.id}
                onClick={() => updateBackend(b.id)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                  padding: "10px 14px",
                  background:
                    parserBackend === b.id
                      ? `rgba(${hexToRgb(acc)}, 0.12)`
                      : "rgba(255,255,255,0.03)",
                  border: `1px solid ${
                    parserBackend === b.id
                      ? `rgba(${hexToRgb(acc)}, 0.5)`
                      : "rgba(255,255,255,0.07)"
                  }`,
                  borderRadius: 8,
                  cursor: "pointer",
                  textAlign: "left",
                  transition: "all 0.15s",
                }}
              >
                <span
                  style={{
                    fontSize: 16,
                    color: parserBackend === b.id ? acc : theme.textSecondary,
                    flexShrink: 0,
                  }}
                >
                  {b.icon}
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    style={{
                      color: parserBackend === b.id ? acc : theme.textPrimary,
                      fontSize: 13,
                      fontWeight: 600,
                    }}
                  >
                    {b.label}
                  </div>
                  <div
                    style={{
                      color: theme.textSecondary,
                      fontSize: 10,
                      marginTop: 2,
                      lineHeight: 1.4,
                    }}
                  >
                    {b.desc}
                  </div>
                </div>
                {parserBackend === b.id && (
                  <span style={{ color: acc, fontSize: 13, flexShrink: 0 }}>
                    ✓
                  </span>
                )}
              </button>
            ))}
          </div>
        </SettingsSection>

        {/* ── Device ─────────────────────────────────── */}
        <SettingsSection title="DEVICE" accent={acc}>
          <p
            style={{
              color: theme.textSecondary,
              fontSize: 11,
              margin: "0 0 12px",
            }}
          >
            Selects the device profile — determines FOV, panel dimensions, and
            reading metrics used to lay out the 3D scene.
          </p>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {DEVICES.map((d) => (
              <button
                key={d.id}
                onClick={() => updateDevice(d.id)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                  padding: "10px 14px",
                  background:
                    deviceType === d.id
                      ? `rgba(${hexToRgb(acc)}, 0.12)`
                      : "rgba(255,255,255,0.03)",
                  border: `1px solid ${
                    deviceType === d.id
                      ? `rgba(${hexToRgb(acc)}, 0.5)`
                      : "rgba(255,255,255,0.07)"
                  }`,
                  borderRadius: 8,
                  cursor: "pointer",
                  textAlign: "left",
                  transition: "all 0.15s",
                }}
              >
                <span
                  style={{
                    fontSize: 18,
                    color: deviceType === d.id ? acc : theme.textSecondary,
                  }}
                >
                  {d.icon}
                </span>
                <div>
                  <div
                    style={{
                      color: deviceType === d.id ? acc : theme.textPrimary,
                      fontSize: 13,
                      fontWeight: 600,
                    }}
                  >
                    {d.label}
                  </div>
                  <div style={{ color: theme.textSecondary, fontSize: 11 }}>
                    {d.desc}
                  </div>
                </div>
                {deviceType === d.id && (
                  <span
                    style={{ marginLeft: "auto", color: acc, fontSize: 13 }}
                  >
                    ✓
                  </span>
                )}
              </button>
            ))}
          </div>
          <div
            style={{
              marginTop: 12,
              padding: "8px 12px",
              background: "rgba(255,255,255,0.03)",
              border: "1px solid rgba(255,255,255,0.06)",
              borderRadius: 6,
              display: "flex",
              alignItems: "center",
              gap: 8,
            }}
          >
            <span style={{ fontSize: 14 }}>◎</span>
            <span
              style={{
                color: theme.textSecondary,
                fontSize: 11,
                lineHeight: 1.4,
              }}
            >
              Scene renders in immersive VR / AR on supported devices via WebXR
            </span>
          </div>
        </SettingsSection>

        {/* ── Appearance (this Home screen only) ──────── */}
        <SettingsSection title="HOME SCREEN APPEARANCE" accent={acc}>
          {(Object.keys(HOME_THEME_FIELD_LABELS) as (keyof HomeTheme)[]).map(
            (key) => (
              <ColorSwatch
                key={key}
                label={HOME_THEME_FIELD_LABELS[key]}
                value={theme[key]}
                onChange={(v) => updateTheme({ [key]: v })}
                theme={theme}
              />
            ),
          )}
          <ContrastReport theme={theme} />
          <button
            onClick={() => updateTheme(DEFAULT_HOME_THEME)}
            style={{
              marginTop: 4,
              padding: "5px 12px",
              background: "none",
              border: `1px solid rgba(${hexToRgb(acc)}, 0.3)`,
              borderRadius: 6,
              color: acc,
              fontSize: 11,
              cursor: "pointer",
            }}
          >
            Reset to defaults
          </button>
        </SettingsSection>

        {/* ── Document viewer theme (Meta Horizon UI Set palette) ── */}
        <SettingsSection title="DOCUMENT VIEWER THEME" accent={acc}>
          <p
            style={{
              color: theme.textSecondary,
              fontSize: 11,
              margin: "0 0 12px",
              lineHeight: 1.5,
            }}
          >
            Colours applied to every panel, card and text run in the 3D document
            view (not this Home screen).
          </p>
          <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
            <button
              onClick={() => updateXrTheme(LIGHT_THEME)}
              style={{
                flex: 1,
                padding: "6px 0",
                fontSize: 12,
                fontWeight: 600,
                borderRadius: 6,
                cursor: "pointer",
                background:
                  xrTheme.panelBg === LIGHT_THEME.panelBg
                    ? `rgba(${hexToRgb(acc)}, 0.15)`
                    : "rgba(255,255,255,0.04)",
                border: `1px solid ${xrTheme.panelBg === LIGHT_THEME.panelBg ? `rgba(${hexToRgb(acc)}, 0.5)` : "rgba(255,255,255,0.08)"}`,
                color:
                  xrTheme.panelBg === LIGHT_THEME.panelBg
                    ? acc
                    : theme.textSecondary,
              }}
            >
              ☀ Light
            </button>
            <button
              onClick={() => updateXrTheme(DARK_THEME)}
              style={{
                flex: 1,
                padding: "6px 0",
                fontSize: 12,
                fontWeight: 600,
                borderRadius: 6,
                cursor: "pointer",
                background:
                  xrTheme.panelBg === DARK_THEME.panelBg
                    ? `rgba(${hexToRgb(acc)}, 0.15)`
                    : "rgba(255,255,255,0.04)",
                border: `1px solid ${xrTheme.panelBg === DARK_THEME.panelBg ? `rgba(${hexToRgb(acc)}, 0.5)` : "rgba(255,255,255,0.08)"}`,
                color:
                  xrTheme.panelBg === DARK_THEME.panelBg
                    ? acc
                    : theme.textSecondary,
              }}
            >
              ☾ Dark
            </button>
          </div>
          {(Object.keys(THEME_FIELD_LABELS) as (keyof XRTheme)[]).map((key) => (
            <ColorSwatch
              key={key}
              label={THEME_FIELD_LABELS[key]}
              value={xrTheme[key]}
              onChange={(v) => updateXrTheme({ [key]: v })}
              theme={theme}
            />
          ))}
          <button
            onClick={() => updateXrTheme(LIGHT_THEME)}
            style={{
              marginTop: 4,
              padding: "5px 12px",
              background: "none",
              border: `1px solid rgba(${hexToRgb(acc)}, 0.3)`,
              borderRadius: 6,
              color: acc,
              fontSize: 11,
              cursor: "pointer",
            }}
          >
            Reset to defaults
          </button>
        </SettingsSection>

        {/* ── Parser options ──────────────────────────── */}
        <SettingsSection title="PARSER OPTIONS" accent={acc}>
          <p
            style={{
              color: theme.textSecondary,
              fontSize: 11,
              margin: "0 0 12px",
            }}
          >
            Controls how HTML is analysed into the XR intermediate
            representation. Defaults are tuned for best results.
          </p>

          <ParserToggle
            label="Use ARIA roles"
            desc="Honour explicit role= attributes"
            value={bool("useExplicitSemantics", true)}
            onChange={(v) => updateParser({ useExplicitSemantics: v })}
            theme={theme}
          />
          <ParserToggle
            label="Use ARIA labels"
            desc="Resolve aria-label, aria-labelledby, alt"
            value={bool("useAriaLabels", true)}
            onChange={(v) => updateParser({ useAriaLabels: v })}
            theme={theme}
          />
          <ParserToggle
            label="Infer structure"
            desc="Heading sections, link & paragraph runs"
            value={bool("useStructuralInference", true)}
            onChange={(v) => updateParser({ useStructuralInference: v })}
            theme={theme}
          />
          <ParserToggle
            label="Pierce wrappers"
            desc="Collapse inert div / span chains"
            value={bool("useWrapperPiercing", true)}
            onChange={(v) => updateParser({ useWrapperPiercing: v })}
            theme={theme}
          />
          <ParserToggle
            label="Exclude hidden content"
            desc="Skip aria-hidden and display:none nodes"
            value={bool("excludeHiddenContent", true)}
            onChange={(v) => updateParser({ excludeHiddenContent: v })}
            theme={theme}
          />
          <ParserToggle
            label="Include SVG"
            desc="Treat <svg> as labelled image nodes"
            value={bool("includeSvg", false)}
            onChange={(v) => updateParser({ includeSvg: v })}
            theme={theme}
          />
          <ParserToggle
            label="Include canvas"
            desc="Treat <canvas> as labelled image nodes"
            value={bool("includeCanvas", false)}
            onChange={(v) => updateParser({ includeCanvas: v })}
            theme={theme}
          />

          <div
            style={{
              borderTop: "1px solid rgba(255,255,255,0.06)",
              paddingTop: 12,
              marginTop: 4,
            }}
          >
            <label
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                marginBottom: 10,
              }}
            >
              <span style={{ flex: 1, fontSize: 12, color: theme.textPrimary }}>
                Reading order
              </span>
              <select
                value={(pc.readingOrderStrategy as string) ?? "dom"}
                onChange={(e) =>
                  updateParser({
                    readingOrderStrategy: e.target.value as
                      | "dom"
                      | "landmark-first"
                      | "flowto-aware",
                  })
                }
                style={{
                  background: "#0a1220",
                  border: "1px solid #1a3a6a",
                  color: theme.textPrimary,
                  borderRadius: 4,
                  padding: "3px 8px",
                  fontSize: 12,
                  cursor: "pointer",
                  outline: "none",
                }}
              >
                <option value="dom">DOM order</option>
                <option value="landmark-first">Landmark-first</option>
                <option value="flowto-aware">Flow-to aware</option>
              </select>
            </label>
            <ParserNumber
              label="Min list run"
              value={pc.minListRun ?? 3}
              onChange={(v) => updateParser({ minListRun: v })}
              theme={theme}
            />
            <ParserNumber
              label="Min link run"
              value={pc.minLinkRun ?? 3}
              onChange={(v) => updateParser({ minLinkRun: v })}
              theme={theme}
            />
            <ParserNumber
              label="Min paragraph run"
              value={pc.minParagraphRun ?? 3}
              onChange={(v) => updateParser({ minParagraphRun: v })}
              theme={theme}
            />
          </div>

          <button
            onClick={() => onChange({ ...settings, parserConfig: {} })}
            style={{
              marginTop: 6,
              padding: "5px 12px",
              background: "none",
              border: `1px solid rgba(${hexToRgb(acc)}, 0.3)`,
              borderRadius: 6,
              color: acc,
              fontSize: 11,
              cursor: "pointer",
            }}
          >
            Reset to defaults
          </button>
        </SettingsSection>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Main component
// ─────────────────────────────────────────────────────────────

export interface HomeScreenProps {
  onLoad: (url: string, settings: HomeSettings) => void;
  loading: boolean;
  /** Open tabs — rendered as the in-world 3D tab switcher. */
  tabs?: Tab[];
  activeTabId?: string;
  onSwitchTab?: (id: string) => void;
  onCloseTab?: (id: string) => void;
  onNewTab?: () => void;
}

export function HomeScreen({
  onLoad,
  loading,
  tabs,
  activeTabId,
  onSwitchTab,
  onCloseTab,
  onNewTab,
}: HomeScreenProps) {
  const [inputValue, setInputValue] = useState("");
  const [settings, setSettings] = useState<HomeSettings>(loadStoredSettings);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [searchFocused, setSearchFocused] = useState(false);
  // Hidden HTML input that captures keystrokes for the in-world search field.
  const hiddenInputRef = useRef<HTMLInputElement>(null);
  /**
   * Which launcher cell owns keyboard focus, and whether the focus ring should
   * be drawn at all. The ring only appears once the reader is actually
   * navigating by keyboard — showing it on load would put a ring on a card
   * nobody has focused.
   */
  const [focusIndex, setFocusIndex] = useState(0);
  const [keyboardActive, setKeyboardActive] = useState(false);
  const cellRefs = useRef<(HTMLButtonElement | null)[]>([]);
  /** Announced to screen readers when the launcher starts loading a page. */
  const [announcement, setAnnouncement] = useState("");

  useEffect(() => {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(settings));
    } catch {}
  }, [settings]);

  const reduceMotion = usePrefersReducedMotion();

  const { theme } = settings;

  /** Every cell of the launcher, grid first then the utility strip. */
  const cells = useMemo(() => [...PRESET_SITES], []);

  function handleLoad(url: string) {
    const raw = url.trim();
    if (!raw) return;
    const site = cells.find((c) => c.url === raw);
    setAnnouncement(
      `Loading ${site?.title ?? raw} in ${settings.viewMode} view. Rendering in 3D.`,
    );
    // Built-in test page: resolve the sentinel to an absolute same-origin URL.
    if (raw === TEST_PAGE_TOKEN) {
      onLoad(window.location.origin + TEST_PAGE_PATH, settings);
      return;
    }
    const target = /^https?:\/\//i.test(raw) ? raw : "https://" + raw;
    onLoad(target, settings);
  }

  function handleSubmit() {
    handleLoad(inputValue);
  }

  return (
    <div
      style={{
        width: "100vw",
        height: "100vh",
        background: theme.background,
        position: "relative",
        overflow: "hidden",
      }}
    >
      {/* 3D Scene */}
      <Canvas
        camera={{ position: [0, 1.5, 2.8], fov: 65, near: 0.3, far: 200 }}
        gl={{ antialias: true }}
        style={{ position: "absolute", inset: 0 }}
      >
        <color
          attach="background"
          args={[theme.canvasBg as THREE.ColorRepresentation]}
        />
        <fog attach="fog" args={[theme.canvasBg, 15, 50]} />

        <ambientLight intensity={0.08} color="#2050a0" />
        <pointLight
          position={[0, 5, -1]}
          intensity={1.8}
          color="#4080ff"
          distance={18}
        />
        <pointLight position={[-3, 2, -5]} intensity={0.35} color="#2040a0" />
        <pointLight position={[3, 2, -5]} intensity={0.35} color="#1a3080" />

        {/* The starfield drifts. Readers who have asked their OS for reduced
            motion get it still — WCAG 2.3.3; a slow field-wide drift is
            exactly the kind of background motion that provokes symptoms in
            vestibular disorders, and nothing here depends on it moving. */}
        <Stars
          radius={100}
          depth={60}
          count={6000}
          factor={3.5}
          saturation={0.3}
          fade
          speed={reduceMotion ? 0 : 0.5}
        />

        <Suspense fallback={null}>
          <LauncherBoard theme={theme} />
          <SceneTitle theme={theme} />
          {PRESET_SITES.map((site, i) => (
            <SiteCard
              key={site.id}
              site={site}
              pose={cardPose(i)}
              width={CARD_W}
              height={CARD_H}
              onSelect={handleLoad}
              disabled={loading}
              theme={theme}
              focused={keyboardActive && focusIndex === i}
            />
          ))}

          {/* ── In-world chrome: search, settings, tabs, view picker ──── */}
          <XR3DSearchBar
            value={inputValue}
            focused={searchFocused}
            loading={loading}
            onFocusField={() => {
              setKeyboardActive(false);
              hiddenInputRef.current?.focus();
            }}
            onSubmit={handleSubmit}
            width={1.3}
            position={[-0.12, 0.95, 0.6]}
            tiltX={0.16}
          />
          {/* Compact gear button, right of the search field */}
          <group position={[0.78, 0.95, 0.6]} rotation={[0.16, 0, 0]}>
            <XR3DButton
              width={0.15}
              height={0.15}
              label="⚙"
              fontSize={0.07}
              active={settingsOpen}
              onClick={() => setSettingsOpen((o) => !o)}
            />
          </group>
          {tabs && activeTabId && onSwitchTab && onCloseTab && onNewTab && (
            <XR3DTabBar
              tabs={tabs}
              activeTabId={activeTabId}
              onSwitch={onSwitchTab}
              onClose={onCloseTab}
              onNewTab={onNewTab}
              position={[0, 0.7, 0.55]}
              tiltX={0.34}
            />
          )}

          {/* View selection lives here, not in the document viewer: the
              arrangement is chosen before launch and rides along in the tab's
              settings. Bottom of the chrome stack, kept centred so it reads
              head-on rather than skewed off-axis. */}
          <group position={[0, 0.46, 0.5]} rotation={[0.48, 0, 0]}>
            <Text
              fontSize={0.045}
              color={theme.textSecondary}
              anchorX="center"
              anchorY="middle"
              letterSpacing={0.08}
            >
              VIEW
            </Text>
          </group>
          <XR3DViewToggle
            mode={settings.viewMode}
            onChange={(m) => setSettings((s) => ({ ...s, viewMode: m }))}
            deviceType={settings.deviceType}
            position={[0, 0.3, 0.5]}
            tiltX={-0.48}
          />
        </Suspense>

        {/* Rotation disabled — the scene stays fixed so the in-world chrome
            keeps a stable position in front of the user. */}
        <OrbitControls
          target={[0, 1.4, -2.5]}
          enablePan={false}
          enableZoom={false}
          enableRotate={false}
          dampingFactor={0.05}
          enableDamping
        />
      </Canvas>

      {/* ── Accessibility layer ─────────────────────────────────
          The real interface. Everything above this point is drawn on a
          canvas and is invisible to assistive technology; these controls
          are what a screen reader reads and what the Tab key lands on, and
          focus here is mirrored back into the scene as a ring. See the
          "Accessibility layer" section above for why they are clipped
          rather than hidden. */}
      <h1 style={SR_ONLY}>From Space to Web</h1>
      <p style={SR_ONLY}>
        Choose a destination to render in 3D, or enter any URL. Use the arrow
        keys to move between destinations.
      </p>

      <nav aria-label="Launcher">
        <CardGridA11y
          targets={cells.map((site) => ({
            id: site.id,
            label: site.title,
            hint:
              site.url === TEST_PAGE_TOKEN
                ? site.subtitle
                : `${site.subtitle}. ${site.url.replace(/^https?:\/\//, "")}`,
            onActivate: () => handleLoad(site.url),
          }))}
          focusIndex={focusIndex}
          setFocusIndex={(i) => {
            setFocusIndex(i);
            setKeyboardActive(true);
          }}
          disabled={loading}
          cols={CARD_COLS}
          itemRefs={cellRefs}
        />
      </nav>

      {/* Backs the in-world search field: the 3D field is a drawing of this
          input's value, and clicking it moves focus here so keystrokes and
          the screen reader both go to a real text box. */}
      <label style={SR_ONLY} htmlFor="fsw-url">
        Enter a URL to explore in 3D
      </label>
      <input
        id="fsw-url"
        ref={hiddenInputRef}
        type="url"
        value={inputValue}
        onChange={(e) => setInputValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") handleSubmit();
        }}
        onFocus={() => {
          setSearchFocused(true);
          setKeyboardActive(false);
        }}
        onBlur={() => setSearchFocused(false)}
        disabled={loading}
        style={SR_ONLY}
      />

      {/* The settings panel's own trigger. The 3D gear button draws the same
          state; both drive `settingsOpen`. */}
      <button
        type="button"
        style={SR_ONLY}
        aria-expanded={settingsOpen}
        aria-controls="fsw-settings"
        onClick={() => setSettingsOpen((o) => !o)}
      >
        Settings
      </button>

      {/* Status, not alert: page loads are expected, so they are announced
          when the reader next comes up for air rather than interrupting. */}
      <div role="status" aria-live="polite" style={SR_ONLY}>
        {announcement}
      </div>

      {/* Settings panel */}
      {settingsOpen && (
        <SettingsPanel
          settings={settings}
          onChange={setSettings}
          onClose={() => setSettingsOpen(false)}
        />
      )}

      {/* Loading overlay */}
      {loading && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            background: "rgba(3, 8, 16, 0.72)",
            backdropFilter: "blur(8px)",
            WebkitBackdropFilter: "blur(8px)",
            zIndex: 200,
          }}
        >
          <div
            style={{
              width: 44,
              height: 44,
              border: `2px solid rgba(${hexToRgb(theme.accent)}, 0.15)`,
              borderTop: `2px solid ${theme.accent}`,
              borderRadius: "50%",
              animation: reduceMotion ? "none" : "hs-spin 1s linear infinite",
              marginBottom: 14,
            }}
          />
          <p
            style={{
              margin: 0,
              color: theme.accent,
              fontSize: 13,
              letterSpacing: "0.06em",
              fontFamily: "system-ui, sans-serif",
            }}
          >
            Rendering in 3D…
          </p>
        </div>
      )}

      <style>{`
        @keyframes hs-spin {
          from { transform: rotate(0deg); }
          to   { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
}
