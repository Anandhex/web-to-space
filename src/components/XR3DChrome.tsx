import React, { useState } from "react";
import { Text } from "@react-three/drei";
import { Surface } from "../renderer/primitives";
import { DARK_THEME, type XRTheme } from "../renderer/theme";
import type { Tab, ViewMode } from "./viewTypes";

// ─────────────────────────────────────────────────────────────
// Shared 3D UI primitives (Meta Horizon OS look)
//
// These render the browser chrome — tab switcher, view-mode toggle — as
// real R3F meshes living in the 3D world, replacing the flat HTML overlays.
// Everything is built on the canonical Horizon `Surface` so it matches the
// document-viewer panels exactly.
// ─────────────────────────────────────────────────────────────

const ACCENT_ON = "#0A3A66"; // active tile fill (accent-tinted charcoal)

/** A clickable rounded tile with a centred text label and hover feedback. */
export function XR3DButton({
  width,
  height,
  label,
  fontSize = 0.038,
  active = false,
  disabled = false,
  onClick,
  theme = DARK_THEME,
  radius,
  labelColor,
}: {
  width: number;
  height: number;
  label: string;
  fontSize?: number;
  active?: boolean;
  disabled?: boolean;
  onClick?: () => void;
  theme?: XRTheme;
  radius?: number;
  labelColor?: string;
}) {
  const [hovered, setHovered] = useState(false);
  const hot = (hovered || active) && !disabled;
  const fill = active ? ACCENT_ON : hot ? theme.listItemBg : theme.navBg;
  const rim = active ? theme.accentCol : hot ? theme.accentCol : theme.panelRim;
  const col =
    labelColor ??
    (disabled
      ? theme.mutedTextCol
      : active
        ? "#7FC0FF"
        : hot
          ? theme.headingCol
          : theme.bodyCol);
  return (
    <group>
      <mesh
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
          if (!disabled) onClick?.();
        }}
      >
        <planeGeometry args={[width, height]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} />
      </mesh>
      <Surface
        width={width}
        height={height}
        radius={radius ?? Math.min(width, height) * 0.28}
        color={fill}
        flat
        rimColor={rim}
        rimOpacity={hot ? 0.9 : 0.5}
        origin={[0, 0]}
      />
      <Text
        position={[0, 0, 0.006]}
        fontSize={fontSize}
        color={col}
        anchorX="center"
        anchorY="middle"
        maxWidth={width - 0.04}
      >
        {label}
      </Text>
    </group>
  );
}

// ─────────────────────────────────────────────────────────────
// Tab switcher
// ─────────────────────────────────────────────────────────────

const TAB_W = 0.34;
const TAB_H = 0.14;
const TAB_GAP = 0.028;
const NEWTAB_W = 0.14;

function TabTile({
  tab,
  active,
  canClose,
  onSwitch,
  onClose,
  theme,
}: {
  tab: Tab;
  active: boolean;
  canClose: boolean;
  onSwitch: () => void;
  onClose: () => void;
  theme: XRTheme;
}) {
  const [hovered, setHovered] = useState(false);
  const hot = hovered || active;
  // const initial =
  //   tab.label === "New Tab" ? "+" : (tab.label[0]?.toUpperCase() ?? "•");

  return (
    <group>
      {/* Tile background + switch hit area */}
      <mesh
        onPointerOver={(e) => {
          e.stopPropagation();
          setHovered(true);
          document.body.style.cursor = "pointer";
        }}
        onPointerOut={() => {
          setHovered(false);
          document.body.style.cursor = "default";
        }}
        onClick={(e) => {
          e.stopPropagation();
          onSwitch();
        }}
      >
        <planeGeometry args={[TAB_W, TAB_H]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} />
      </mesh>
      <Surface
        width={TAB_W}
        height={TAB_H}
        radius={0.035}
        color={active ? ACCENT_ON : hot ? theme.listItemBg : theme.navBg}
        flat
        rimColor={active ? theme.accentCol : theme.panelRim}
        rimOpacity={active ? 0.9 : 0.45}
        origin={[0, 0]}
      />

      <Text
        position={[-TAB_W / 2 + 0.05, 0, 0.006]}
        fontSize={0.036}
        color={active ? "#EAF3FF" : theme.bodyCol}
        anchorX="left"
        anchorY="middle"
        maxWidth={TAB_W}
        clipRect={[0, -TAB_H, TAB_W, TAB_H]}
      >
        {tab.label}
      </Text>

      {/* Close button */}
      {canClose && (
        <group position={[TAB_W / 2 - 0.04, 0, 0.004]}>
          <mesh
            onPointerOver={(e) => {
              e.stopPropagation();
              document.body.style.cursor = "pointer";
            }}
            onClick={(e) => {
              e.stopPropagation();
              onClose();
            }}
          >
            <planeGeometry args={[0.06, 0.06]} />
            <meshBasicMaterial transparent opacity={0} depthWrite={false} />
          </mesh>
          <Text
            position={[0, 0, 0.006]}
            fontSize={0.05}
            color={active ? "#9CC8F0" : theme.mutedTextCol}
            anchorX="center"
            anchorY="middle"
          >
            ×
          </Text>
        </group>
      )}
    </group>
  );
}

export interface XR3DTabBarProps {
  tabs: Tab[];
  activeTabId: string;
  onSwitch: (id: string) => void;
  onClose: (id: string) => void;
  onNewTab: () => void;
  /** World-space position of the bar's centre. */
  position?: [number, number, number];
  /** X-rotation (radians) to tilt the bar up toward the viewer. */
  tiltX?: number;
  theme?: XRTheme;
}

/**
 * World-space tab strip. Renders every open tab as a Horizon tile plus a
 * "new tab" button, centred at `position` and tilted slightly up toward the
 * user. Replaces the flat HTML <TabBar>.
 */
export function XR3DTabBar({
  tabs,
  activeTabId,
  onSwitch,
  onClose,
  onNewTab,
  position = [0, 0.6, -0.95],
  tiltX = 0.32,
  theme = DARK_THEME,
}: XR3DTabBarProps) {
  const count = tabs.length;
  const rowWidth = count * TAB_W + (count - 1) * TAB_GAP + NEWTAB_W + TAB_GAP;
  const startX = -rowWidth / 2 + TAB_W / 2;

  return (
    <group position={position} rotation={[-tiltX, 0, 0]}>
      {/* Backing tray */}
      <Surface
        width={rowWidth + 0.12}
        height={TAB_H + 0.08}
        radius={0.05}
        color={theme.panelBg}
        flat
        rimColor={theme.panelRim}
        rimOpacity={0.5}
        origin={[0, 0]}
        z={-0.004}
      />
      {tabs.map((tab, i) => (
        <group key={tab.id} position={[startX + i * (TAB_W + TAB_GAP), 0, 0]}>
          <TabTile
            tab={tab}
            active={tab.id === activeTabId}
            canClose={count > 1}
            onSwitch={() => onSwitch(tab.id)}
            onClose={() => onClose(tab.id)}
            theme={theme}
          />
        </group>
      ))}
      {/* New-tab button */}
      <group
        position={[
          startX + count * (TAB_W + TAB_GAP) - TAB_W / 2 + NEWTAB_W / 2,
          0,
          0,
        ]}
      >
        <XR3DButton
          width={NEWTAB_W}
          height={TAB_H}
          label="+"
          fontSize={0.07}
          onClick={onNewTab}
          theme={theme}
        />
      </group>
    </group>
  );
}

// ─────────────────────────────────────────────────────────────
// View-mode toggle
// ─────────────────────────────────────────────────────────────

type ViewDeviceType = "QUEST_3" | "QUEST_PRO" | "RAY_BAN_META";

/**
 * View catalogue for the in-world switcher. `fit` lists the device types the
 * view is usable on (arrangement views gate on 6DoF / room-scale; legacy
 * front-facing views work everywhere). Superseded views (cards/door) are kept
 * in the codebase but omitted here — see docs/views-plan.md.
 */
const VIEW_MODES: {
  id: ViewMode;
  label: string;
  fit: ViewDeviceType[];
}[] = [
  {
    id: "standard",
    label: "Standard",
    fit: ["QUEST_3", "QUEST_PRO", "RAY_BAN_META"],
  },
  {
    id: "carousel",
    label: "Carousel",
    fit: ["QUEST_3", "QUEST_PRO", "RAY_BAN_META"],
  },
  {
    id: "theatre",
    label: "Theatre",
    fit: ["QUEST_3", "QUEST_PRO", "RAY_BAN_META"],
  },
  {
    id: "focus",
    label: "Focus",
    fit: ["QUEST_3", "QUEST_PRO", "RAY_BAN_META"],
  },
  { id: "stack", label: "Stack", fit: ["QUEST_3", "QUEST_PRO"] },
  { id: "orbital", label: "Orbital", fit: ["QUEST_3", "QUEST_PRO"] },
  { id: "palm", label: "Palm", fit: ["QUEST_3", "QUEST_PRO"] },
  { id: "gallery", label: "Gallery", fit: ["QUEST_3", "QUEST_PRO"] },
];

export interface XR3DViewToggleProps {
  mode: ViewMode;
  onChange: (m: ViewMode) => void;
  position?: [number, number, number];
  tiltX?: number;
  theme?: XRTheme;
  /** Filters the offered views to those the device can present. */
  deviceType?: ViewDeviceType;
}

/**
 * World-space segmented control for the layout view mode. Replaces the flat
 * HTML <ViewToggle>. Wraps to a second row when many views are offered.
 */
export function XR3DViewToggle({
  mode,
  onChange,
  position = [0, 1.55, -1.02],
  tiltX = -0.1,
  theme = DARK_THEME,
  deviceType = "QUEST_3",
}: XR3DViewToggleProps) {
  const modes = VIEW_MODES.filter((m) => m.fit.includes(deviceType));
  const segW = 0.185;
  const segH = 0.075;
  const gap = 0.012;
  const rowGap = 0.016;

  const perRow = Math.ceil(modes.length / Math.ceil(modes.length / 5));
  const rows: (typeof modes)[] = [];
  for (let i = 0; i < modes.length; i += perRow) {
    rows.push(modes.slice(i, i + perRow));
  }
  const widest = Math.max(...rows.map((r) => r.length));
  const rowWidth = widest * segW + (widest - 1) * gap;
  const totalH = rows.length * segH + (rows.length - 1) * rowGap;
  const topY = totalH / 2 - segH / 2;

  return (
    <group position={position} rotation={[tiltX, 0, 0]}>
      <Surface
        width={rowWidth + 0.06}
        height={totalH + 0.045}
        radius={0.04}
        color={theme.panelBg}
        flat
        rimColor={theme.panelRim}
        rimOpacity={0.5}
        origin={[0, 0]}
        z={-0.004}
      />
      {rows.map((row, r) => {
        const rw = row.length * segW + (row.length - 1) * gap;
        const startX = -rw / 2 + segW / 2;
        const y = topY - r * (segH + rowGap);
        return row.map((m, i) => (
          <group key={m.id} position={[startX + i * (segW + gap), y, 0]}>
            <XR3DButton
              width={segW}
              height={segH}
              label={m.label}
              fontSize={0.024}
              active={mode === m.id}
              onClick={() => onChange(m.id)}
              theme={theme}
            />
          </group>
        ));
      })}
    </group>
  );
}

// ─────────────────────────────────────────────────────────────
// Search / URL bar
// ─────────────────────────────────────────────────────────────

export interface XR3DSearchBarProps {
  /** Current text (mirrors the hidden HTML input backing the field). */
  value: string;
  placeholder?: string;
  /** Focus the hidden HTML input so the user can type. */
  onFocusField: () => void;
  onSubmit: () => void;
  focused?: boolean;
  loading?: boolean;
  width?: number;
  height?: number;
  position?: [number, number, number];
  tiltX?: number;
  theme?: XRTheme;
}

/**
 * World-space URL/search field. Text entry itself is handled by a hidden HTML
 * <input> the caller focuses via `onFocusField`; this component only renders
 * the field surface, the current text, and the Launch button.
 */
export function XR3DSearchBar({
  value,
  placeholder = "Enter a URL to explore in 3D…",
  onFocusField,
  onSubmit,
  focused = false,
  loading = false,
  width = 1.4,
  height = 0.16,
  position = [0, 1.0, 0.5],
  tiltX = 0.18,
  theme = DARK_THEME,
}: XR3DSearchBarProps) {
  const launchW = 0.34;
  const pad = 0.06;
  const textLeft = -width / 2 + pad + 0.02;
  const hasText = value.trim().length > 0;

  return (
    <group position={position} rotation={[tiltX, 0, 0]}>
      {/* Field surface (click to focus the hidden input) */}
      <mesh
        onPointerOver={(e) => {
          e.stopPropagation();
          document.body.style.cursor = "text";
        }}
        onPointerOut={() => {
          document.body.style.cursor = "default";
        }}
        onClick={(e) => {
          e.stopPropagation();
          onFocusField();
        }}
      >
        <planeGeometry args={[width, height]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} />
      </mesh>
      <Surface
        width={width}
        height={height}
        radius={height / 2}
        color={theme.inputBg}
        flat
        rimColor={focused ? theme.accentCol : theme.panelRim}
        rimOpacity={focused ? 0.9 : 0.5}
        origin={[0, 0]}
      />

      {/* Leading search glyph */}
      <Text
        position={[textLeft - 0.005, 0, 0.006]}
        fontSize={0.05}
        color={theme.mutedTextCol}
        anchorX="left"
        anchorY="middle"
      >
        ⌕
      </Text>

      {/* Value / placeholder */}
      <Text
        position={[textLeft + 0.07, 0, 0.006]}
        fontSize={0.044}
        color={hasText ? theme.headingCol : theme.mutedTextCol}
        anchorX="left"
        anchorY="middle"
        maxWidth={width - launchW - 0.2}
        clipRect={[0, -height, width - launchW - 0.2, height]}
      >
        {hasText ? value : placeholder}
      </Text>

      {/* Launch button */}
      <group position={[width / 2 - launchW / 2 - 0.03, 0, 0.004]}>
        <XR3DButton
          width={launchW}
          height={height - 0.05}
          label={loading ? "Loading…" : "Launch →"}
          fontSize={0.036}
          active={hasText && !loading}
          disabled={!hasText || loading}
          onClick={onSubmit}
          theme={theme}
        />
      </group>
    </group>
  );
}
