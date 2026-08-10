/**
 * scene/link-preview.tsx
 *
 * Link ghost previews (the plan's "challenge 6" — make linked pages visible
 * as spatial neighbours instead of hidden jumps). Dwelling the pointer on
 * any inline link for ~350 ms spawns a small tethered card beside the hit
 * point showing the link's label and where it leads (domain for external
 * links, "jump to section" for fragments). The card is non-interactive, so
 * it never steals the click from the link underneath.
 *
 * Where it runs: rooms only — see PREVIEW_VIEW_MODES. In the reading views a
 * link should just be a link you click; a card that floats up over the prose
 * on hover covers the very text you are reading and turns a one-step action
 * into a wait. Rooms is the one view whose whole point is standing off and
 * surveying, so a tethered satellite has somewhere to sit and something to add.
 *
 * Research basis: VRowser / WebDriving / LitForager — tethered satellite
 * previews of link targets aid foraging. This is the instant, zero-network
 * tier; a full mini-pipeline render of the target page can later mount
 * inside the same card.
 */
import React from "react";
import { Line, Text } from "@react-three/drei";

import { useTheme } from "../theme";
import { FontContext } from "./contexts";
import type { ViewMode } from "../../components/viewTypes";

export interface LinkPreviewApi {
  show: (href: string, label: string, point: [number, number, number]) => void;
  clear: () => void;
}

export const LinkPreviewContext = React.createContext<LinkPreviewApi | null>(
  null,
);

const DWELL_MS = 350;
const LINGER_MS = 150;

/**
 * The only view modes that summon a preview card. Everywhere else an inline
 * link is a plain click target with nothing rendered over it on hover.
 *
 * Enforced by handing down a null context rather than by a check at the hit
 * mesh: consumers already call through `linkPreview?.show(...)`, so a null
 * provider switches off the dwell timer, the card, and its state in one move,
 * and no per-link code needs to know about view modes at all.
 */
const PREVIEW_VIEW_MODES: ReadonlySet<ViewMode> = new Set<ViewMode>(["rooms"]);

interface PreviewState {
  href: string;
  label: string;
  point: [number, number, number];
}

function describeTarget(href: string): string {
  if (href.startsWith("#")) return "jump to section";
  try {
    const u = new URL(href);
    return u.hostname.replace(/^www\./, "");
  } catch {
    return href.length > 40 ? `${href.slice(0, 37)}…` : href;
  }
}

function LinkPreviewCard({ preview }: { preview: PreviewState }) {
  const theme = useTheme();
  const fontType = React.useContext(FontContext);
  const [px, py, pz] = preview.point;
  // Card floats up-right of the hit point, pulled toward the viewer so it
  // clears the panel surface (and any curve) it was summoned from.
  const cx = px + 0.3;
  const cy = py + 0.16;
  const cz = pz + 0.1;
  const W = 0.46;
  const H = 0.13;
  const label =
    preview.label.length > 46 ? `${preview.label.slice(0, 43)}…` : preview.label;
  return (
    <group renderOrder={10}>
      <Line
        points={[
          [px, py, pz + 0.005],
          [cx - W / 2, cy - H / 2, cz],
        ]}
        color={theme.emphasisCol}
        lineWidth={1.5}
        transparent
        opacity={0.6}
        dashed
        dashSize={0.02}
        gapSize={0.014}
      />
      <group position={[cx, cy, cz]} raycast={() => null}>
        <mesh>
          <planeGeometry args={[W, H]} />
          <meshBasicMaterial
            color={theme.navBg}
            transparent
            opacity={0.96}
            depthWrite={false}
          />
        </mesh>
        <mesh position={[0, 0, -0.001]}>
          <planeGeometry args={[W + 0.008, H + 0.008]} />
          <meshBasicMaterial
            color={theme.emphasisCol}
            transparent
            opacity={0.35}
            depthWrite={false}
          />
        </mesh>
        <Text
          font={fontType}
          anchorX="left"
          anchorY="top"
          position={[-W / 2 + 0.02, H / 2 - 0.022, 0.002]}
          fontSize={0.026}
          color={theme.bodyCol}
          maxWidth={W - 0.04}
          clipRect={[-W / 2, -H / 2, W / 2, H / 2]}
        >
          {label || "link"}
        </Text>
        <Text
          font={fontType}
          anchorX="left"
          anchorY="bottom"
          position={[-W / 2 + 0.02, -H / 2 + 0.014, 0.002]}
          fontSize={0.02}
          color={theme.emphasisCol}
        >
          {`→ ${describeTarget(preview.href)}`}
        </Text>
      </group>
    </group>
  );
}

/**
 * Mount once inside the scene graph. Provides the show/clear API to every
 * inline link hit-mesh below it and renders the active card.
 */
export function LinkPreviewProvider({
  viewMode,
  children,
}: {
  viewMode: ViewMode | undefined;
  children: React.ReactNode;
}) {
  const enabled = viewMode !== undefined && PREVIEW_VIEW_MODES.has(viewMode);
  const [preview, setPreview] = React.useState<PreviewState | null>(null);
  const dwellTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const lingerTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const api = React.useMemo<LinkPreviewApi>(
    () => ({
      show(href, label, point) {
        if (lingerTimer.current) {
          clearTimeout(lingerTimer.current);
          lingerTimer.current = null;
        }
        if (dwellTimer.current) clearTimeout(dwellTimer.current);
        dwellTimer.current = setTimeout(
          () => setPreview({ href, label, point }),
          DWELL_MS,
        );
      },
      clear() {
        if (dwellTimer.current) {
          clearTimeout(dwellTimer.current);
          dwellTimer.current = null;
        }
        if (lingerTimer.current) clearTimeout(lingerTimer.current);
        lingerTimer.current = setTimeout(() => setPreview(null), LINGER_MS);
      },
    }),
    [],
  );

  React.useEffect(
    () => () => {
      if (dwellTimer.current) clearTimeout(dwellTimer.current);
      if (lingerTimer.current) clearTimeout(lingerTimer.current);
    },
    [],
  );

  return (
    <LinkPreviewContext.Provider value={enabled ? api : null}>
      {children}
      {enabled && preview && <LinkPreviewCard preview={preview} />}
    </LinkPreviewContext.Provider>
  );
}
