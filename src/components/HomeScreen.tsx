import React, { useState, useRef, useMemo, Suspense, useEffect } from "react";
import { Canvas } from "@react-three/fiber";
import { Stars, OrbitControls, Text } from "@react-three/drei";
import * as THREE from "three";
import { Surface } from "../renderer/primitives";
import { XR3DSearchBar, XR3DButton, XR3DViewToggle } from "./XR3DChrome";
import type { Tab, ViewMode } from "./viewTypes";
import type { XRDeviceType } from "../renderer/XRSceneRenderer";
import type { ParserConfig, ParserBackend } from "../ir/types";
import {
  AI_PROVIDERS,
  DEFAULT_AI_SETTINGS,
  aiProviderMeta,
  aiSettingsReady,
  testAIConnection,
  withProvider,
  type AIProviderId,
  type AIProviderSettings,
} from "../ir/ai";
import { DARK_THEME, type XRTheme } from "../renderer/theme";
import type { StudyCondition } from "../study/types";

import { SR_ONLY, usePrefersReducedMotion } from "./a11y";

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
   * Layer 3 of the parser — which AI service classifies the nodes ARIA and
   * structure could not, and with whose key. Inert until a key is entered.
   */
  ai: AIProviderSettings;
  /**
   * Whether the key is written to this device's localStorage.
   *
   * Off by default, and deliberately a decision rather than a default: a key
   * in localStorage is readable by anything else running on this origin, and
   * survives until it is cleared. Off means the key lives in memory for this
   * session only — everything else about the AI config still persists.
   */
  aiRememberKey: boolean;
  /**
   * Spatial arrangement the page opens in. Chosen here on the Home screen —
   * the document viewer has no switcher of its own, so the view is decided
   * before launch and travels with the tab.
   */
  viewMode: ViewMode;
  /**
   * The active study condition (src/study/), when this tab is a study trial.
   * Rides on settings for the same reason viewMode/theme/parserBackend do —
   * it inherits through link navigation exactly as they already do, so a
   * link followed mid-trial does not silently leave the study. Undefined for
   * every normal reading session; only `src/study/runner.tsx` sets it.
   */
  study?: StudyCondition | null;
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
const DEFAULT_HOME_THEME: HomeTheme = {
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
  ai: DEFAULT_AI_SETTINGS,
  aiRememberKey: false,
  viewMode: "rooms",
};

const LS_KEY = "fsw-home-settings";
/**
 * The AI config is stored under its own key rather than inside the settings
 * blob above, for two reasons: it is the one part of settings that has to
 * survive a reload to be useful (nobody wants to paste a key per page), and it
 * is the only part that holds a secret — so it needs a write path that can
 * leave the secret out. `apiKey` is persisted only with the reader's consent
 * (`aiRememberKey`); everything else about the config always is.
 */
const LS_AI_KEY = "fsw-ai-config";

interface StoredAI extends AIProviderSettings {
  rememberKey: boolean;
}

function loadStoredAI(): { ai: AIProviderSettings; rememberKey: boolean } {
  try {
    const raw = localStorage.getItem(LS_AI_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<StoredAI>;
      const { rememberKey, ...rest } = parsed;
      return {
        ai: { ...DEFAULT_AI_SETTINGS, ...rest, apiKey: rest.apiKey ?? "" },
        rememberKey: rememberKey === true,
      };
    }
  } catch {
    /* unreadable or absent storage — fall through to the defaults */
  }
  return { ai: DEFAULT_AI_SETTINGS, rememberKey: false };
}

function saveStoredAI(ai: AIProviderSettings, rememberKey: boolean) {
  try {
    localStorage.setItem(
      LS_AI_KEY,
      JSON.stringify({
        ...ai,
        apiKey: rememberKey ? ai.apiKey : "",
        rememberKey,
      } satisfies StoredAI),
    );
  } catch {
    /* private mode / storage full — the session still works, it just forgets */
  }
}

function loadStoredSettings(): HomeSettings {
  const stored = loadStoredAI();
  return {
    ...DEFAULT_HOME_SETTINGS,
    ai: stored.ai,
    aiRememberKey: stored.rememberKey,
  };
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

// Sentinel URLs for the built-in local test pages. Each is resolved to an
// absolute same-origin URL at click time (see handleLoad) so it can be fetched
// directly without the CORS proxy, and — the part that matters for the link
// test page — so the parser has a real base URL to resolve every relative and
// root-relative href against.
const TEST_PAGE_TOKEN = "__test_elements__";
const LINK_TEST_TOKEN = "__link_test__";

/**
 * The evaluation study (src/study/, docs/study-plan.md).
 *
 * NOT in `LOCAL_PAGES`: the other two sentinels resolve to a document the
 * pipeline renders, and this one does not resolve to a document at all — it
 * leaves the reading app entirely for the operator's control screen. It is on
 * the board because that is where the operator looks for a way in, and
 * because the alternative was typing `?study=1&p=P03` by hand with a
 * participant already in the headset.
 */
const STUDY_TOKEN = "__study__";

/** Sentinel → same-origin path. The only local pages the launcher offers. */
const LOCAL_PAGES: Record<string, string> = {
  [TEST_PAGE_TOKEN]: "/test-elements.html",
  [LINK_TEST_TOKEN]: "/link-test/index.html",
};

function isLocalPage(url: string): boolean {
  return Object.prototype.hasOwnProperty.call(LOCAL_PAGES, url);
}

interface PresetSite {
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
  {
    id: "link-test",
    title: "Link Direction Test",
    subtitle: "Relative, top-level & external links · smoke test",
    url: LINK_TEST_TOKEN,
    initial: "▸",
  },
  {
    id: "study",
    title: "Evaluation Study",
    subtitle: "Operator control screen · 15 trials",
    url: STUDY_TOKEN,
    initial: "S",
  },
];

/**
 * The strip under the grid — the cells that are not websites.
 *
 * They are here rather than in the grid for the reason the note above gives:
 * a seventh cell in a three-wide grid is one card alone on a row, 1.8 m below
 * the others. The strip is the shape the board already reserves space for
 * (see BOARD_INNER_H), and it reads as what it holds — the local smoke test
 * and the study, neither of which is a destination to browse.
 *
 * Two of them share the strip's width rather than each taking a row of their
 * own: a second full-width strip would push the whole board up by UTIL_H and
 * a gap, moving all six cards for the sake of one cell.
 */
const UTILITY_SITES: PresetSite[] = [];

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

/** The utility strip under the grid — shorter than a card, full grid width. */
const UTIL_ROW_W = CARD_COLS * CARD_W + (CARD_COLS - 1) * CARD_GAP_X;
const UTIL_H = 0.28;
/** That width shared between the strip's cells, with a card gap between. */
const UTIL_W =
  (UTIL_ROW_W - (UTILITY_SITES.length - 1) * CARD_GAP_X) / UTILITY_SITES.length;

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
  CARD_GAP_Y + GRID_ROWS * CARD_H + (GRID_ROWS - 1) * CARD_GAP_Y;
const BOARD_PAD = 0.12;

interface CardPose {
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
function cardPose(i: number): CardPose {
  const col = i % CARD_COLS;
  const row = Math.floor(i / CARD_COLS);
  const alongX = (col - (CARD_COLS - 1) / 2) * (CARD_W + CARD_GAP_X);
  const topRowY = BOARD_BOTTOM_Y + BOARD_INNER_H - CARD_H / 2;
  return arcPose(alongX, topRowY - row * (CARD_H + CARD_GAP_Y));
}

/**
 * Pose of the i-th cell of the utility strip, which together span the full
 * width of the grid at the bottom of the board, on the same arc.
 * BOARD_INNER_H already reserves UTIL_H + a gap for the row, so the strip's
 * cells change no other cell's position however many of them there are.
 */
function utilityPose(i: number): CardPose {
  const n = UTILITY_SITES.length;
  const alongX = (i - (n - 1) / 2) * (UTIL_W + CARD_GAP_X);
  return arcPose(alongX, BOARD_BOTTOM_Y + UTIL_H / 2);
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
  /**
   * `card` is the grid cell: chip and title on top, subtitle beneath, a rule
   * and a footer row. `strip` is the wide short cell under the grid, which has
   * no room for four stacked rows and does not need them — everything sits on
   * one line, with the destination pushed to the right edge.
   */
  variant: "card" | "strip";
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
  variant,
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
  const strip = variant === "strip";
  const pad = height * (strip ? 0.22 : 0.13);
  const chip = height * (strip ? 0.58 : 0.3);

  // Type scale.
  //
  // It used to be proportional to the CELL, on the reasoning that one ratio
  // beats two hand-picked sets of sizes. That is right for a grid of cells the
  // same shape and wrong the moment one of them is a third the height: the
  // strip's title came out 0.037 m, which at the 3.4 m card radius is 0.62° of
  // visual angle — under the legibility floor, and unreadable in the headset
  // even though it looked merely small on a flat screen.
  //
  // What legibility depends on is ANGULAR size, so the scale is keyed to the
  // grid card's height for every cell. The strip and the cards then share one
  // type scale in metres, which is the thing that actually has to match.
  const typeUnit = CARD_H;
  const titleSize = typeUnit * 0.133;
  const bodySize = typeUnit * 0.088;
  const metaSize = typeUnit * 0.072;

  // A strip STACKS its title over its subtitle, right of the chip — the same
  // arrangement the cards use, at strip scale.
  //
  // It used to put both on one line, title left and subtitle pinned to the
  // right edge. That worked only while the strip was the full width of the
  // grid. Once two strips shared the row at half width each, "Link Direction
  // Test" wanted 0.78 m of a 0.73 m budget and wrapped, and — worse — each
  // strip's subtitle ended up hard against its own right edge, 0.14 m from
  // the next strip's title, so the two runs of text read as one and the
  // strips looked like they were overlapping even though the panels are
  // 0.14 m apart. Stacking gives both lines the full width right of the chip
  // and leaves nothing to collide with horizontally.
  const stripTextLeft = -halfW + pad + chip + pad * 0.7;
  const stripTextW = halfW - pad - stripTextLeft;
  /** Leading between the stacked pair. */
  const stripLead = metaSize * 0.5;
  // Both anchored "middle", offset so the PAIR is centred on the strip:
  // the block runs ±(titleSize + lead + metaSize) / 2 about y = 0.
  const stripTitleY = (metaSize + stripLead) / 2;
  const stripSubY = -(titleSize + stripLead) / 2;

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
        position={[
          -halfW + pad + chip / 2,
          strip ? 0 : halfH - pad - chip / 2,
          0.004,
        ]}
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
          stripTextLeft,
          strip ? stripTitleY : halfH - pad - chip * 0.34,
          0.006,
        ]}
        fontSize={titleSize}
        color={theme.textPrimary}
        anchorX="left"
        anchorY="middle"
        maxWidth={strip ? stripTextW : width - (pad * 2 + chip + pad * 0.7)}
        letterSpacing={-0.01}
      >
        {site.title}
      </Text>

      {/* A strip stacks the rest directly under the title, same left edge. */}
      {strip && (
        <Text
          position={[stripTextLeft, stripSubY, 0.006]}
          fontSize={metaSize}
          color={theme.textMuted}
          anchorX="left"
          anchorY="middle"
          maxWidth={stripTextW}
        >
          {site.subtitle}
        </Text>
      )}

      {/* Subtitle spans the full width below the header */}
      {!strip && (
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
      )}

      {/* Rule above the footer row */}
      {!strip && (
        <>
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
            {isLocalPage(site.url)
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
        </>
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

interface A11yTarget {
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
function CardGridA11y({
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

/** A labelled text/password field, sized for the settings rail. */
function SettingsField({
  label,
  value,
  onChange,
  theme,
  type = "text",
  placeholder,
  hint,
  mono,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  theme: HomeTheme;
  type?: "text" | "password";
  placeholder?: string;
  hint?: string;
  mono?: boolean;
}) {
  return (
    <label style={{ display: "block", marginBottom: 10 }}>
      <span
        style={{
          display: "block",
          fontSize: 12,
          color: theme.textPrimary,
          marginBottom: 4,
        }}
      >
        {label}
      </span>
      <input
        type={type}
        value={value}
        placeholder={placeholder}
        spellCheck={false}
        autoComplete="off"
        onChange={(e) => onChange(e.target.value)}
        style={{
          width: "100%",
          boxSizing: "border-box",
          background: "#0a1220",
          border: "1px solid #1a3a6a",
          color: theme.textPrimary,
          borderRadius: 4,
          padding: "6px 8px",
          fontSize: 12,
          fontFamily: mono ? "ui-monospace, monospace" : "inherit",
          outline: "none",
        }}
      />
      {hint && (
        <span
          style={{
            display: "block",
            fontSize: 10.5,
            color: theme.textSecondary,
            marginTop: 3,
          }}
        >
          {hint}
        </span>
      )}
    </label>
  );
}

/**
 * Layer 3's whole configuration surface.
 *
 * Everything here is inert until a key is entered: with no provider
 * configured the parser runs its stub and nothing leaves the browser, which
 * is what the panel says at the top rather than making the reader infer it
 * from an empty field.
 *
 * The Test button sends one real classification rather than pinging a health
 * endpoint — a key can be valid and the call still fail on the model id or on
 * the browser's CORS policy, and those are exactly the failures worth finding
 * here instead of on the next page load.
 */
function AISettings({
  ai,
  rememberKey,
  onChange,
  onRememberChange,
  theme,
}: {
  ai: AIProviderSettings;
  rememberKey: boolean;
  onChange: (next: AIProviderSettings) => void;
  onRememberChange: (v: boolean) => void;
  theme: HomeTheme;
}) {
  const meta = aiProviderMeta(ai.provider);
  const [status, setStatus] = useState<
    { state: "idle" | "testing" } | { state: "ok" | "fail"; detail: string }
  >({ state: "idle" });
  const set = (partial: Partial<AIProviderSettings>) =>
    onChange({ ...ai, ...partial });

  async function runTest() {
    setStatus({ state: "testing" });
    try {
      const res = await testAIConnection(ai);
      setStatus({
        state: res.ok ? "ok" : "fail",
        detail: res.ok ? `${res.detail} (${res.elapsedMs} ms)` : res.detail,
      });
    } catch (err) {
      setStatus({ state: "fail", detail: (err as Error).message });
    }
  }

  const ready = aiSettingsReady(ai);

  return (
    <>
      <p
        style={{
          color: theme.textSecondary,
          fontSize: 11,
          margin: "0 0 12px",
          lineHeight: 1.5,
        }}
      >
        Nodes that ARIA and structural inference both leave as{" "}
        <code style={{ fontFamily: "ui-monospace, monospace" }}>generic</code>{" "}
        are sent to a model in one batched request per {ai.batchSize} nodes.
        Leave the key empty and this stays off — the parser keeps its own
        answers and nothing leaves the browser.
      </p>

      <div
        style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 12 }}
      >
        {AI_PROVIDERS.map((p) => {
          const active = p.id === ai.provider;
          return (
            <button
              key={p.id}
              onClick={() => onChange(withProvider(ai, p.id as AIProviderId))}
              style={{
                flex: "1 1 45%",
                background: active ? theme.chipBgActive : "transparent",
                border: `1px solid ${active ? theme.accent : theme.cardRim}`,
                color: active ? theme.accentText : theme.textSecondary,
                borderRadius: 6,
                padding: "6px 8px",
                fontSize: 11.5,
                cursor: "pointer",
                textAlign: "left",
              }}
            >
              {p.label}
            </button>
          );
        })}
      </div>

      <p
        style={{
          color: theme.textSecondary,
          fontSize: 10.5,
          lineHeight: 1.5,
          margin: "0 0 12px",
        }}
      >
        {meta.note}
      </p>

      {meta.needsKey && (
        <SettingsField
          label="API key"
          type="password"
          value={ai.apiKey}
          placeholder="sk-…"
          hint={meta.keyHint}
          mono
          theme={theme}
          onChange={(v) => set({ apiKey: v.trim() })}
        />
      )}
      <SettingsField
        label="Model"
        value={ai.model}
        placeholder={meta.defaultModel}
        hint="Any model id this provider accepts."
        mono
        theme={theme}
        onChange={(v) => set({ model: v })}
      />
      <SettingsField
        label={ai.provider === "ollama" ? "Ollama host" : "API base URL"}
        value={ai.baseUrl}
        placeholder={meta.defaultBaseUrl || "(provider default)"}
        hint={
          ai.provider === "ollama"
            ? "Needs OLLAMA_ORIGINS set, or the browser blocks the call."
            : "Point at a proxy or gateway; blank uses the provider's own host."
        }
        mono
        theme={theme}
        onChange={(v) => set({ baseUrl: v.trim() })}
      />

      <div style={{ display: "flex", gap: 10 }}>
        <label style={{ flex: 1 }}>
          <span
            style={{
              display: "block",
              fontSize: 12,
              color: theme.textPrimary,
              marginBottom: 4,
            }}
          >
            Nodes per request
          </span>
          <input
            type="number"
            min={1}
            max={100}
            value={ai.batchSize}
            onChange={(e) =>
              set({
                batchSize: Math.max(
                  1,
                  Math.min(100, Number(e.target.value) || 1),
                ),
              })
            }
            style={{
              width: "100%",
              boxSizing: "border-box",
              background: "#0a1220",
              border: "1px solid #1a3a6a",
              color: theme.textPrimary,
              borderRadius: 4,
              padding: "6px 8px",
              fontSize: 12,
              outline: "none",
            }}
          />
        </label>
        <label style={{ flex: 1 }}>
          <span
            style={{
              display: "block",
              fontSize: 12,
              color: theme.textPrimary,
              marginBottom: 4,
            }}
          >
            Max nodes / page
          </span>
          <input
            type="number"
            min={0}
            max={2000}
            value={ai.maxNodes}
            onChange={(e) =>
              set({
                maxNodes: Math.max(
                  0,
                  Math.min(2000, Number(e.target.value) || 0),
                ),
              })
            }
            style={{
              width: "100%",
              boxSizing: "border-box",
              background: "#0a1220",
              border: "1px solid #1a3a6a",
              color: theme.textPrimary,
              borderRadius: 4,
              padding: "6px 8px",
              fontSize: 12,
              outline: "none",
            }}
          />
        </label>
      </div>

      {meta.needsKey && (
        <div style={{ marginTop: 12 }}>
          <ParserToggle
            label="Remember key on this device"
            desc="Off: kept for this session only. On: stored in localStorage, readable by any script on this origin."
            value={rememberKey}
            onChange={onRememberChange}
            theme={theme}
          />
        </div>
      )}

      <div
        style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 6 }}
      >
        <button
          onClick={runTest}
          disabled={!ready || status.state === "testing"}
          style={{
            background: ready ? theme.chipBgActive : "transparent",
            border: `1px solid ${ready ? theme.accent : theme.cardRim}`,
            color: ready ? theme.accentText : theme.textSecondary,
            borderRadius: 6,
            padding: "6px 12px",
            fontSize: 12,
            cursor: ready ? "pointer" : "not-allowed",
          }}
        >
          {status.state === "testing" ? "Testing…" : "Test"}
        </button>
        {"detail" in status && (
          <span
            style={{
              flex: 1,
              fontSize: 11,
              lineHeight: 1.4,
              color: status.state === "ok" ? "#7ee787" : "#f6a623",
            }}
          >
            {status.detail}
          </span>
        )}
      </div>
    </>
  );
}

// ─────────────────────────────────────────────────────────────
// Settings panel
// ─────────────────────────────────────────────────────────────

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
    id: "vips",
    icon: "◈",
    label: "VIPS Visual Blocks",
    desc: "Cai et al. 2003 — DOM-based visual block segmentation, then semantic pipeline",
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
  const { theme, parserBackend } = settings;
  const acc = theme.accent;

  const updateBackend = (b: ParserBackend) =>
    onChange({ ...settings, parserBackend: b });

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

        {/* ── Parser options ──────────────────────────── */}
        {/* ── AI fallback (parser layer 3) ────────────── */}
        <SettingsSection title="AI FALLBACK · LAYER 3" accent={acc}>
          <AISettings
            ai={settings.ai}
            rememberKey={settings.aiRememberKey}
            onChange={(ai) => onChange({ ...settings, ai })}
            onRememberChange={(v) =>
              onChange({ ...settings, aiRememberKey: v })
            }
            theme={theme}
          />
        </SettingsSection>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Main component
// ─────────────────────────────────────────────────────────────

interface HomeScreenProps {
  onLoad: (url: string, settings: HomeSettings) => void;
  loading: boolean;
  /** Open tabs — rendered as the in-world 3D tab switcher. */
  tabs?: Tab[];
  activeTabId?: string;
  onSwitchTab?: (id: string) => void;
  onCloseTab?: (id: string) => void;
  onNewTab?: () => void;
}

export function HomeScreen({ onLoad, loading }: HomeScreenProps) {
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
      // The key never rides in the general settings blob — that is written on
      // every keystroke and has no consent attached. It goes through
      // saveStoredAI, which honours aiRememberKey.
      const { ai, ...rest } = settings;
      localStorage.setItem(
        LS_KEY,
        JSON.stringify({ ...rest, ai: { ...ai, apiKey: "" } }),
      );
    } catch {}
    saveStoredAI(settings.ai, settings.aiRememberKey);
  }, [settings]);

  const reduceMotion = usePrefersReducedMotion();

  const { theme } = settings;

  /** Every cell of the launcher, grid first then the utility strip. */
  const cells = useMemo(() => [...PRESET_SITES], []);

  function handleLoad(url: string) {
    const raw = url.trim();
    if (!raw) return;

    // The study is not a document, so it is handled before anything that
    // announces a render or resolves a path: it leaves the reading app for
    // the operator's control screen, which picks the participant itself.
    // A full navigation because App.tsx resolves study mode from the query
    // string once at mount — the runner is a different program, not a panel.
    if (raw === STUDY_TOKEN) {
      setAnnouncement("Opening the evaluation study control screen.");
      const target = new URL(window.location.href);
      target.search = "";
      target.searchParams.set("study", "1");
      window.location.href = target.href;
      return;
    }

    const site = cells.find((c) => c.url === raw);
    setAnnouncement(
      `Loading ${site?.title ?? raw} in ${settings.viewMode} view. Rendering in 3D.`,
    );
    // Built-in test page: resolve the sentinel to an absolute same-origin URL.
    const localPath = LOCAL_PAGES[raw];
    if (localPath !== undefined) {
      onLoad(window.location.origin + localPath, settings);
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
          {cells.map((site, i) => (
            <SiteCard
              key={site.id}
              site={site}
              pose={
                i < PRESET_SITES.length
                  ? cardPose(i)
                  : utilityPose(i - PRESET_SITES.length)
              }
              width={i < PRESET_SITES.length ? CARD_W : UTIL_W}
              height={i < PRESET_SITES.length ? CARD_H : UTIL_H}
              variant={i < PRESET_SITES.length ? "card" : "strip"}
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
            // A sentinel is an implementation detail, not something to read
            // out: the local pages already suppress theirs, and the study —
            // which is not a URL at all — would otherwise announce
            // "__study__" as its address.
            hint:
              isLocalPage(site.url) || site.url === STUDY_TOKEN
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

      {/* The evaluation material, one click from Home. Renders nothing until
          opened, and reports honestly when the generated pages are absent. */}

      <style>{`
        @keyframes hs-spin {
          from { transform: rotate(0deg); }
          to   { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
}
