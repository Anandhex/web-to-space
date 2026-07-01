import React, { useState, useRef, Suspense, useEffect } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { Stars, OrbitControls, Text, RoundedBox } from "@react-three/drei";
import * as THREE from "three";
import type { XRDeviceType } from "../renderer/XRSceneRenderer";
import type { ParserConfig, ParserBackend } from "../ir/types";

// ─────────────────────────────────────────────────────────────
// Types & defaults
// ─────────────────────────────────────────────────────────────

export interface HomeTheme {
  accent: string;
  accentDim: string;
  background: string;
  canvasBg: string;
  cardBg: string;
  cardHover: string;
  textPrimary: string;
  textSecondary: string;
}

export interface HomeSettings {
  deviceType: XRDeviceType;
  theme: HomeTheme;
  parserConfig: Partial<ParserConfig>;
  parserBackend: ParserBackend;
}

export const DEFAULT_HOME_THEME: HomeTheme = {
  accent: "#58a6ff",
  accentDim: "#1e4a8a",
  background: "#020408",
  canvasBg: "#030810",
  cardBg: "#0d1828",
  cardHover: "#162236",
  textPrimary: "#e6f1ff",
  textSecondary: "#7a8a9a",
};

export const DEFAULT_HOME_SETTINGS: HomeSettings = {
  deviceType: "QUEST_3",
  theme: DEFAULT_HOME_THEME,
  parserConfig: {},
  parserBackend: "custom",
};

const LS_KEY = "fsw-home-settings";

function loadStoredSettings(): HomeSettings {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      return {
        ...DEFAULT_HOME_SETTINGS,
        ...parsed,
        theme: { ...DEFAULT_HOME_THEME, ...(parsed.theme ?? {}) },
        parserConfig: parsed.parserConfig ?? {},
        parserBackend: parsed.parserBackend ?? "custom",
      };
    }
  } catch {}
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

const PRESET_SITES = [
  { id: "nasa", title: "NASA", subtitle: "Space exploration & science", url: "https://www.nasa.gov/", initial: "N" },
  { id: "wikipedia", title: "Wikipedia", subtitle: "The free encyclopedia", url: "https://en.wikipedia.org/wiki/Space", initial: "W" },
  { id: "hn", title: "Hacker News", subtitle: "Tech news & discussion", url: "https://news.ycombinator.com/", initial: "H" },
  { id: "mdn", title: "MDN Web Docs", subtitle: "Web developer reference", url: "https://developer.mozilla.org/", initial: "M" },
  { id: "github", title: "GitHub", subtitle: "Open source & code exploration", url: "https://github.com/explore", initial: "G" },
  { id: "webdev", title: "web.dev", subtitle: "Modern web guidance & tools", url: "https://web.dev/", initial: "D" },
];

const CARD_POSITIONS: [number, number, number][] = [
  [-1.65, 2.1, -3.0], [0, 2.1, -3.0], [1.65, 2.1, -3.0],
  [-1.65, 0.9, -3.0], [0, 0.9, -3.0], [1.65, 0.9, -3.0],
];

// ─────────────────────────────────────────────────────────────
// 3D Components
// ─────────────────────────────────────────────────────────────

interface SiteCardProps {
  title: string;
  subtitle: string;
  url: string;
  initial: string;
  position: [number, number, number];
  onSelect: (url: string) => void;
  phase: number;
  disabled: boolean;
  theme: HomeTheme;
}

function SiteCard({ title, subtitle, url, initial, position, onSelect, phase, disabled, theme }: SiteCardProps) {
  const [hovered, setHovered] = useState(false);
  const groupRef = useRef<THREE.Group>(null);
  const baseY = position[1];

  useFrame((state) => {
    if (!groupRef.current) return;
    const t = state.clock.elapsedTime;
    groupRef.current.position.y = baseY + Math.sin(t * 0.7 + phase) * 0.045;
    const target = hovered && !disabled ? 1.055 : 1;
    const cur = groupRef.current.scale.x;
    groupRef.current.scale.setScalar(cur + (target - cur) * 0.1);
  });

  const active = hovered && !disabled;

  return (
    <group ref={groupRef} position={position}>
      <RoundedBox
        args={[1.25, 0.88, 0.055]}
        radius={0.055}
        smoothness={4}
        onPointerOver={(e) => {
          e.stopPropagation();
          if (!disabled) { setHovered(true); document.body.style.cursor = "pointer"; }
        }}
        onPointerOut={() => { setHovered(false); document.body.style.cursor = "default"; }}
        onClick={(e) => { e.stopPropagation(); if (!disabled) onSelect(url); }}
      >
        <meshStandardMaterial
          color={active ? theme.cardHover : theme.cardBg}
          emissive={active ? theme.cardHover : theme.background}
          emissiveIntensity={active ? 0.8 : 0.3}
          roughness={0.2}
          metalness={0.5}
          transparent
          opacity={0.95}
        />
      </RoundedBox>

      <mesh position={[0, 0.37, 0.03]}>
        <planeGeometry args={[1.2, 0.022]} />
        <meshBasicMaterial
          color={active ? theme.accent : theme.accentDim}
          transparent
          opacity={active ? 1 : 0.5}
        />
      </mesh>

      <Text position={[-0.44, 0.12, 0.04]} fontSize={0.2} color={active ? "#a594f9" : "#6a56d4"} anchorX="center" anchorY="middle">
        {initial}
      </Text>
      <Text position={[-0.1, 0.17, 0.04]} fontSize={0.1} color={theme.textPrimary} anchorX="left" anchorY="middle" maxWidth={0.78}>
        {title}
      </Text>
      <Text position={[-0.1, -0.1, 0.04]} fontSize={0.068} color={theme.textSecondary} anchorX="left" anchorY="middle" maxWidth={0.78}>
        {subtitle}
      </Text>
      <Text position={[-0.1, -0.30, 0.04]} fontSize={0.055} color={active ? "#3a7aaa" : "#1a3a5a"} anchorX="left" anchorY="middle" maxWidth={0.9}>
        {url}
      </Text>

      {active && (
        <mesh position={[0, 0, -0.003]}>
          <planeGeometry args={[1.27, 0.9]} />
          <meshBasicMaterial color={theme.accent} transparent opacity={0.1} />
        </mesh>
      )}
    </group>
  );
}

function SceneTitle({ theme }: { theme: HomeTheme }) {
  const groupRef = useRef<THREE.Group>(null);
  useFrame((state) => {
    if (!groupRef.current) return;
    groupRef.current.position.y = 3.1 + Math.sin(state.clock.elapsedTime * 0.4) * 0.03;
  });
  return (
    <group ref={groupRef} position={[0, 3.1, -3.0]}>
      <Text fontSize={0.36} color={theme.textPrimary} anchorX="center" anchorY="middle" letterSpacing={0.02}>
        From Space to Web
      </Text>
      <Text position={[0, -0.44, 0]} fontSize={0.1} color={theme.accent} anchorX="center" anchorY="middle" letterSpacing={0.04}>
        Choose a destination below — or enter any URL
      </Text>
    </group>
  );
}

// ─────────────────────────────────────────────────────────────
// Settings panel sub-components
// ─────────────────────────────────────────────────────────────

function Toggle({ value, onChange, accent }: { value: boolean; onChange: (v: boolean) => void; accent: string }) {
  return (
    <div
      onClick={() => onChange(!value)}
      style={{
        width: 36, height: 20, borderRadius: 10, flexShrink: 0,
        background: value ? accent : "#1a2840",
        border: `1px solid ${value ? accent : "#253550"}`,
        cursor: "pointer", position: "relative",
        transition: "background 0.2s, border-color 0.2s",
      }}
    >
      <div style={{
        position: "absolute", top: 3, left: value ? 17 : 3,
        width: 14, height: 14, borderRadius: 7,
        background: value ? "#fff" : "#4a6080",
        transition: "left 0.18s",
      }} />
    </div>
  );
}

function ColorSwatch({ label, value, onChange, theme }: {
  label: string; value: string; onChange: (v: string) => void; theme: HomeTheme;
}) {
  return (
    <label style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8, cursor: "pointer" }}>
      <span style={{ flex: 1, fontSize: 12, color: theme.textPrimary }}>{label}</span>
      <div style={{ position: "relative", width: 28, height: 20 }}>
        <div style={{
          width: 28, height: 20, borderRadius: 4,
          background: value,
          border: "1px solid rgba(255,255,255,0.15)",
          pointerEvents: "none",
        }} />
        <input
          type="color"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          style={{
            position: "absolute", inset: 0, opacity: 0,
            cursor: "pointer", width: "100%", height: "100%",
          }}
        />
      </div>
      <span style={{ fontSize: 11, color: theme.textSecondary, fontFamily: "monospace", width: 60 }}>{value}</span>
    </label>
  );
}

function SectionHeader({ title, accent }: { title: string; accent: string }) {
  return (
    <div style={{
      fontSize: 10, fontWeight: 700, letterSpacing: "0.1em",
      color: accent, opacity: 0.7, marginBottom: 12,
    }}>
      {title}
    </div>
  );
}

function SettingsSection({ title, accent, children }: { title: string; accent: string; children: React.ReactNode }) {
  return (
    <div style={{ padding: "16px 20px", borderBottom: "1px solid rgba(255,255,255,0.05)" }}>
      <SectionHeader title={title} accent={accent} />
      {children}
    </div>
  );
}

function ParserToggle({ label, desc, value, onChange, theme }: {
  label: string; desc: string; value: boolean;
  onChange: (v: boolean) => void; theme: HomeTheme;
}) {
  return (
    <div style={{ display: "flex", alignItems: "flex-start", gap: 10, marginBottom: 10 }}>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 12, color: theme.textPrimary, marginBottom: 2 }}>{label}</div>
        <div style={{ fontSize: 11, color: theme.textSecondary }}>{desc}</div>
      </div>
      <Toggle value={value} onChange={onChange} accent={theme.accent} />
    </div>
  );
}

function ParserNumber({ label, value, onChange, theme }: {
  label: string; value: number; onChange: (v: number) => void; theme: HomeTheme;
}) {
  return (
    <label style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
      <span style={{ flex: 1, fontSize: 12, color: theme.textPrimary }}>{label}</span>
      <input
        type="number"
        min={2} max={10}
        value={value}
        onChange={(e) => onChange(Math.max(2, Math.min(10, Number(e.target.value))))}
        style={{
          width: 52, background: "#0a1220",
          border: "1px solid #1a3a6a", color: theme.textPrimary,
          borderRadius: 4, padding: "3px 6px", fontSize: 12, textAlign: "center",
          outline: "none",
        }}
      />
    </label>
  );
}

// ─────────────────────────────────────────────────────────────
// Settings panel
// ─────────────────────────────────────────────────────────────

const DEVICES: { id: XRDeviceType; label: string; desc: string; icon: string }[] = [
  { id: "QUEST_3",       label: "Quest 3",     desc: "Full VR · 110° FOV",       icon: "◉" },
  { id: "QUEST_PRO",     label: "Quest Pro",   desc: "Mixed Reality · 100° FOV", icon: "◎" },
  { id: "RAY_BAN_META",  label: "Ray-Ban Meta",desc: "AR Glasses · 40° FOV",     icon: "◯" },
];

const BACKENDS: { id: ParserBackend; icon: string; label: string; desc: string }[] = [
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

function SettingsPanel({ settings, onChange, onClose }: {
  settings: HomeSettings;
  onChange: (s: HomeSettings) => void;
  onClose: () => void;
}) {
  const { theme, deviceType, parserConfig: pc, parserBackend } = settings;
  const acc = theme.accent;

  const updateTheme = (partial: Partial<HomeTheme>) =>
    onChange({ ...settings, theme: { ...theme, ...partial } });
  const updateParser = (partial: Partial<ParserConfig>) =>
    onChange({ ...settings, parserConfig: { ...pc, ...partial } });
  const updateDevice = (dt: XRDeviceType) =>
    onChange({ ...settings, deviceType: dt });
  const updateBackend = (b: ParserBackend) =>
    onChange({ ...settings, parserBackend: b });

  // Resolve each boolean against its default value
  const bool = (key: keyof ParserConfig, def: boolean): boolean =>
    pc[key] !== undefined ? (pc[key] as boolean) : def;

  return (
    <div style={{
      position: "fixed", top: 0, right: 0, bottom: 0, width: 360,
      background: "rgba(6, 10, 20, 0.97)",
      backdropFilter: "blur(24px)",
      WebkitBackdropFilter: "blur(24px)",
      borderLeft: `1px solid rgba(${hexToRgb(acc)}, 0.2)`,
      zIndex: 500,
      display: "flex", flexDirection: "column",
      fontFamily: "system-ui, -apple-system, sans-serif",
      boxShadow: `-8px 0 40px rgba(0,0,0,0.5)`,
    }}>
      {/* Header */}
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "16px 20px",
        borderBottom: "1px solid rgba(255,255,255,0.06)",
        flexShrink: 0,
      }}>
        <span style={{ color: theme.textPrimary, fontSize: 15, fontWeight: 600 }}>⚙ Settings</span>
        <button onClick={onClose} style={{
          background: "none", border: "none", color: theme.textSecondary,
          cursor: "pointer", fontSize: 18, padding: "2px 6px", lineHeight: 1,
        }}>✕</button>
      </div>

      <div style={{ flex: 1, overflowY: "auto" }}>

        {/* ── Parser Backend ──────────────────────────── */}
        <SettingsSection title="PARSER BACKEND" accent={acc}>
          <p style={{ color: theme.textSecondary, fontSize: 11, margin: "0 0 12px", lineHeight: 1.5 }}>
            Selects how HTML is pre-processed before entering the XR pipeline.
            Switch backends and reload the same URL to compare output.
          </p>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {BACKENDS.map((b) => (
              <button
                key={b.id}
                onClick={() => updateBackend(b.id)}
                style={{
                  display: "flex", alignItems: "center", gap: 12,
                  padding: "10px 14px",
                  background: parserBackend === b.id
                    ? `rgba(${hexToRgb(acc)}, 0.12)`
                    : "rgba(255,255,255,0.03)",
                  border: `1px solid ${parserBackend === b.id
                    ? `rgba(${hexToRgb(acc)}, 0.5)`
                    : "rgba(255,255,255,0.07)"}`,
                  borderRadius: 8, cursor: "pointer", textAlign: "left",
                  transition: "all 0.15s",
                }}
              >
                <span style={{ fontSize: 16, color: parserBackend === b.id ? acc : theme.textSecondary, flexShrink: 0 }}>
                  {b.icon}
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ color: parserBackend === b.id ? acc : theme.textPrimary, fontSize: 13, fontWeight: 600 }}>
                    {b.label}
                  </div>
                  <div style={{ color: theme.textSecondary, fontSize: 10, marginTop: 2, lineHeight: 1.4 }}>{b.desc}</div>
                </div>
                {parserBackend === b.id && (
                  <span style={{ color: acc, fontSize: 13, flexShrink: 0 }}>✓</span>
                )}
              </button>
            ))}
          </div>
        </SettingsSection>

        {/* ── Device ─────────────────────────────────── */}
        <SettingsSection title="DEVICE" accent={acc}>
          <p style={{ color: theme.textSecondary, fontSize: 11, margin: "0 0 12px" }}>
            Selects the device profile — determines FOV, panel dimensions, and reading metrics used to lay out the 3D scene.
          </p>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {DEVICES.map((d) => (
              <button
                key={d.id}
                onClick={() => updateDevice(d.id)}
                style={{
                  display: "flex", alignItems: "center", gap: 12,
                  padding: "10px 14px",
                  background: deviceType === d.id
                    ? `rgba(${hexToRgb(acc)}, 0.12)`
                    : "rgba(255,255,255,0.03)",
                  border: `1px solid ${deviceType === d.id
                    ? `rgba(${hexToRgb(acc)}, 0.5)`
                    : "rgba(255,255,255,0.07)"}`,
                  borderRadius: 8, cursor: "pointer", textAlign: "left",
                  transition: "all 0.15s",
                }}
              >
                <span style={{ fontSize: 18, color: deviceType === d.id ? acc : theme.textSecondary }}>
                  {d.icon}
                </span>
                <div>
                  <div style={{ color: deviceType === d.id ? acc : theme.textPrimary, fontSize: 13, fontWeight: 600 }}>
                    {d.label}
                  </div>
                  <div style={{ color: theme.textSecondary, fontSize: 11 }}>{d.desc}</div>
                </div>
                {deviceType === d.id && (
                  <span style={{ marginLeft: "auto", color: acc, fontSize: 13 }}>✓</span>
                )}
              </button>
            ))}
          </div>
          <div style={{
            marginTop: 12, padding: "8px 12px",
            background: "rgba(255,255,255,0.03)",
            border: "1px solid rgba(255,255,255,0.06)",
            borderRadius: 6,
            display: "flex", alignItems: "center", gap: 8,
          }}>
            <span style={{ fontSize: 14 }}>◎</span>
            <span style={{ color: theme.textSecondary, fontSize: 11, lineHeight: 1.4 }}>
              Scene renders in immersive VR / AR on supported devices via WebXR
            </span>
          </div>
        </SettingsSection>

        {/* ── Appearance ──────────────────────────────── */}
        <SettingsSection title="APPEARANCE" accent={acc}>
          <ColorSwatch label="Accent" value={theme.accent} onChange={(v) => updateTheme({ accent: v })} theme={theme} />
          <ColorSwatch label="Accent (dim)" value={theme.accentDim} onChange={(v) => updateTheme({ accentDim: v })} theme={theme} />
          <ColorSwatch label="Background" value={theme.background} onChange={(v) => updateTheme({ background: v })} theme={theme} />
          <ColorSwatch label="Canvas background" value={theme.canvasBg} onChange={(v) => updateTheme({ canvasBg: v })} theme={theme} />
          <ColorSwatch label="Card" value={theme.cardBg} onChange={(v) => updateTheme({ cardBg: v })} theme={theme} />
          <ColorSwatch label="Card (hover)" value={theme.cardHover} onChange={(v) => updateTheme({ cardHover: v })} theme={theme} />
          <ColorSwatch label="Text primary" value={theme.textPrimary} onChange={(v) => updateTheme({ textPrimary: v })} theme={theme} />
          <ColorSwatch label="Text secondary" value={theme.textSecondary} onChange={(v) => updateTheme({ textSecondary: v })} theme={theme} />
          <button
            onClick={() => updateTheme(DEFAULT_HOME_THEME)}
            style={{
              marginTop: 4, padding: "5px 12px", background: "none",
              border: `1px solid rgba(${hexToRgb(acc)}, 0.3)`,
              borderRadius: 6, color: acc, fontSize: 11, cursor: "pointer",
            }}
          >
            Reset to defaults
          </button>
        </SettingsSection>

        {/* ── Parser options ──────────────────────────── */}
        <SettingsSection title="PARSER OPTIONS" accent={acc}>
          <p style={{ color: theme.textSecondary, fontSize: 11, margin: "0 0 12px" }}>
            Controls how HTML is analysed into the XR intermediate representation. Defaults are tuned for best results.
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

          <div style={{ borderTop: "1px solid rgba(255,255,255,0.06)", paddingTop: 12, marginTop: 4 }}>
            <label style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
              <span style={{ flex: 1, fontSize: 12, color: theme.textPrimary }}>Reading order</span>
              <select
                value={(pc.readingOrderStrategy as string) ?? "dom"}
                onChange={(e) => updateParser({
                  readingOrderStrategy: e.target.value as "dom" | "landmark-first" | "flowto-aware",
                })}
                style={{
                  background: "#0a1220", border: "1px solid #1a3a6a",
                  color: theme.textPrimary, borderRadius: 4,
                  padding: "3px 8px", fontSize: 12, cursor: "pointer", outline: "none",
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
              marginTop: 6, padding: "5px 12px", background: "none",
              border: `1px solid rgba(${hexToRgb(acc)}, 0.3)`,
              borderRadius: 6, color: acc, fontSize: 11, cursor: "pointer",
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
}

export function HomeScreen({ onLoad, loading }: HomeScreenProps) {
  const [inputValue, setInputValue] = useState("");
  const [settings, setSettings] = useState<HomeSettings>(loadStoredSettings);
  const [settingsOpen, setSettingsOpen] = useState(false);

  useEffect(() => {
    try { localStorage.setItem(LS_KEY, JSON.stringify(settings)); } catch {}
  }, [settings]);

  const { theme } = settings;

  function handleLoad(url: string) {
    const raw = url.trim();
    if (!raw) return;
    const target = /^https?:\/\//i.test(raw) ? raw : "https://" + raw;
    onLoad(target, settings);
  }

  function handleSubmit() {
    handleLoad(inputValue);
  }

  return (
    <div style={{
      width: "100vw", height: "100vh",
      background: theme.background,
      position: "relative", overflow: "hidden",
    }}>
      {/* 3D Scene */}
      <Canvas
        camera={{ position: [0, 1.5, 2.8], fov: 65, near: 0.01, far: 200 }}
        gl={{ antialias: true }}
        style={{ position: "absolute", inset: 0 }}
      >
        <color attach="background" args={[theme.canvasBg as THREE.ColorRepresentation]} />
        <fog attach="fog" args={[theme.canvasBg, 15, 50]} />

        <ambientLight intensity={0.08} color="#2050a0" />
        <pointLight position={[0, 5, -1]} intensity={1.8} color="#4080ff" distance={18} />
        <pointLight position={[-3, 2, -5]} intensity={0.35} color="#2040a0" />
        <pointLight position={[3, 2, -5]} intensity={0.35} color="#1a3080" />

        <Stars radius={100} depth={60} count={6000} factor={3.5} saturation={0.3} fade speed={0.5} />

        <Suspense fallback={null}>
          <SceneTitle theme={theme} />
          {PRESET_SITES.map((site, i) => (
            <SiteCard
              key={site.id}
              {...site}
              position={CARD_POSITIONS[i]}
              onSelect={handleLoad}
              phase={(i * Math.PI * 2) / PRESET_SITES.length}
              disabled={loading}
              theme={theme}
            />
          ))}
        </Suspense>

        <OrbitControls
          target={[0, 1.5, -2.5]}
          enablePan={false}
          enableZoom={false}
          autoRotate
          autoRotateSpeed={0.25}
          maxPolarAngle={Math.PI * 0.58}
          minPolarAngle={Math.PI * 0.38}
          dampingFactor={0.05}
          enableDamping
        />
      </Canvas>

      {/* Search bar overlay */}
      <div style={{
        position: "fixed", bottom: 36, left: "50%",
        transform: "translateX(-50%)",
        display: "flex", alignItems: "center", gap: 10,
        padding: "10px 18px",
        background: "rgba(8, 14, 24, 0.88)",
        border: `1px solid rgba(${hexToRgb(theme.accent)}, 0.22)`,
        borderRadius: 28,
        backdropFilter: "blur(20px)",
        WebkitBackdropFilter: "blur(20px)",
        boxShadow: `0 0 40px rgba(${hexToRgb(theme.accent)}, 0.08), 0 4px 24px rgba(0,0,0,0.6)`,
        width: 480, zIndex: 100, boxSizing: "border-box",
      }}>
        <span style={{ color: "#3a7aaa", fontSize: 15, flexShrink: 0, lineHeight: 1 }}>⊕</span>
        <input
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") handleSubmit(); }}
          placeholder="Enter a URL to explore in 3D…"
          disabled={loading}
          style={{
            flex: 1, background: "transparent", border: "none",
            color: theme.textPrimary, fontSize: 14, outline: "none",
            fontFamily: "system-ui, -apple-system, sans-serif",
            caretColor: theme.accent, minWidth: 0,
          }}
        />
        <button
          onClick={handleSubmit}
          disabled={loading || !inputValue.trim()}
          style={{
            padding: "6px 16px",
            background: loading || !inputValue.trim()
              ? "rgba(20, 35, 55, 0.5)"
              : "rgba(15, 35, 65, 0.9)",
            border: `1px solid rgba(${hexToRgb(theme.accent)}, 0.3)`,
            color: loading || !inputValue.trim() ? "#3a5a7a" : theme.accent,
            borderRadius: 16,
            cursor: loading || !inputValue.trim() ? "not-allowed" : "pointer",
            fontSize: 13, fontFamily: "system-ui, sans-serif",
            whiteSpace: "nowrap", transition: "all 0.2s", flexShrink: 0,
          }}
        >
          {loading ? "Loading…" : "Launch →"}
        </button>
      </div>

      {/* Settings button */}
      <button
        onClick={() => setSettingsOpen((o) => !o)}
        style={{
          position: "fixed", bottom: 36, right: settingsOpen ? 376 : 36,
          padding: "10px 16px",
          background: settingsOpen
            ? `rgba(${hexToRgb(theme.accent)}, 0.15)`
            : "rgba(8, 14, 24, 0.88)",
          border: `1px solid rgba(${hexToRgb(theme.accent)}, ${settingsOpen ? "0.5" : "0.22"})`,
          borderRadius: 28,
          backdropFilter: "blur(20px)",
          WebkitBackdropFilter: "blur(20px)",
          color: theme.accent, cursor: "pointer",
          fontSize: 14, fontFamily: "system-ui, sans-serif",
          display: "flex", alignItems: "center", gap: 7,
          zIndex: 100, transition: "right 0.25s, background 0.2s, border-color 0.2s",
          boxShadow: `0 4px 24px rgba(0,0,0,0.4)`,
        }}
      >
        <span style={{ fontSize: 15 }}>⚙</span>
        <span>Settings</span>
      </button>

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
        <div style={{
          position: "fixed", inset: 0,
          display: "flex", flexDirection: "column",
          alignItems: "center", justifyContent: "center",
          background: "rgba(3, 8, 16, 0.72)",
          backdropFilter: "blur(8px)",
          WebkitBackdropFilter: "blur(8px)",
          zIndex: 200,
        }}>
          <div style={{
            width: 44, height: 44,
            border: `2px solid rgba(${hexToRgb(theme.accent)}, 0.15)`,
            borderTop: `2px solid ${theme.accent}`,
            borderRadius: "50%",
            animation: "hs-spin 1s linear infinite",
            marginBottom: 14,
          }} />
          <p style={{
            margin: 0, color: theme.accent, fontSize: 13,
            letterSpacing: "0.06em",
            fontFamily: "system-ui, sans-serif",
          }}>
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
