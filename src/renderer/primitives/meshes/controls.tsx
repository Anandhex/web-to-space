/**
 * primitives/meshes/controls.tsx
 *
 * Interactive control meshes: buttons, alerts, tables, and form controls
 * (text field, toggle, slider, combobox, searchbox) plus tab groups.
 */
import React from "react";

import type { LayoutEntry } from "../../../layout/types";
import {
  mergeAdjacentTextRuns,
  isInlinePrimitive,
  flattenInlineWrappers,
} from "../../../layout/utils";
import { useTheme } from "../../theme";
import {
  Z_LAYER_ACCENT,
  Z_LAYER_BODY_TEXT,
  Z_LAYER_OVERLAY_TEXT,
  RENDER_ORDER_ACCENT,
  RENDER_ORDER_TEXT,
} from "../constants";
import {
  Surface,
  safeDim,
  cornerRadius,
  entryTransform,
  useHoverScale,
} from "../surface";
import { useClipPlanes, useRenderMetrics } from "../contexts";
import { ClippedText, buildInlineRows, InlineProseRows } from "../inline";

export interface XRButtonMeshProps {
  primitive: import("../../../mapper/types").XRButton;
  entry: LayoutEntry;
}

export function XRButtonMesh({ primitive, entry }: XRButtonMeshProps) {
  const { ref, handlers } = useHoverScale(1.0, 1.04);
  const { pos, rot } = entryTransform(entry);
  const clips = useClipPlanes();
  const theme = useTheme();
  const metrics = useRenderMetrics();
  const w = safeDim(entry.size.width);
  const h = safeDim(entry.size.height);
  const isDisabled = primitive.state?.disabled;

  // Read label text from the synthetic child when available (added by
  // normalizeSceneLabels in the mapper), otherwise fall back to primitive.label.
  const flatChildren = flattenInlineWrappers(primitive.children ?? []);
  const labelText =
    flatChildren.length > 0
      ? ((flatChildren[0] as unknown as { text?: string }).text ??
        flatChildren[0].label ??
        "")
      : (primitive.label ?? "");

  // Primary button fill is monochrome (emphasisCol — near-black on light
  // panels, near-white on dark panels) rather than the brand-blue accent.
  // The Horizon UI Set's "Buttons" reference shows Primary as a plain
  // white/light pill with dark content; blue/red are reserved for links and
  // destructive actions respectively, not general primary controls.
  const btnColor = isDisabled ? theme.disabledBg : theme.emphasisCol;

  return (
    <group ref={ref} position={pos} rotation={rot} {...handlers}>
      {/* Pill body — flat, unlit, fully-rounded Horizon primary button */}
      <Surface
        width={w}
        height={h}
        radius={cornerRadius(w, h, h / 2)}
        color={btnColor}
        opacity={isDisabled ? 0.6 : 1}
        flat
        clips={clips}
      />

      <ClippedText
        anchorX="center"
        anchorY="middle"
        position={[w / 2, -h / 2, Z_LAYER_BODY_TEXT]}
        fontSize={metrics.button.font.fontSize}
        color={isDisabled ? theme.mutedTextCol : theme.panelBg}
        fontWeight="600"
        maxWidth={w - 0.02}
      >
        {labelText}
      </ClippedText>
    </group>
  );
}

// ─────────────────────────────────────────────────────────────
// 13. XRAlertMesh
// ─────────────────────────────────────────────────────────────

export interface XRAlertMeshProps {
  primitive: import("../../../mapper/types").XRAlert;
  entry: LayoutEntry;
  renderChild: (primitiveId: string) => React.ReactNode;
}

export function XRAlertMesh({
  primitive,
  entry,
  renderChild,
}: XRAlertMeshProps) {
  const { pos, rot } = entryTransform(entry);
  const clips = useClipPlanes();
  const theme = useTheme();
  const w = safeDim(entry.size.width);
  const h = safeDim(entry.size.height);
  const metrics = useRenderMetrics();
  const isAssertive = primitive.liveRegion === "assertive";
  const alertColor = isAssertive ? "#D32F2F" : theme.accentCol;
  const alertBg = isAssertive ? "#FDECEA" : "#EAF2FE";

  // If the alert has inline children (e.g. a hatnote whose label is followed
  // by a link), flow them with InlineProseRows exactly like XRParagraphMesh.
  // Without this, only primitive.label renders and all link/text children are
  // silently discarded — the XRAlert case in PrimitiveDispatcher never passed
  // renderChild, so there was no path for children to appear at all.
  const flatChildren = flattenInlineWrappers(primitive.children ?? []);
  const hasAnyInlineChild = flatChildren.some((c) => isInlinePrimitive(c.type));
  const rows = hasAnyInlineChild
    ? buildInlineRows(mergeAdjacentTextRuns(flatChildren))
    : [];
  const m = metrics.paragraph;
  const X_INSET = 0.02;

  return (
    <group position={pos} rotation={rot}>
      <Surface
        width={w}
        height={h}
        color={alertBg}
        rimColor={theme.panelRim}
        clips={clips}
      />

      {/* Left accent bar */}
      <mesh
        position={[0.004, -h / 2, Z_LAYER_ACCENT]}
        renderOrder={RENDER_ORDER_ACCENT}
      >
        <planeGeometry args={[0.007, h * 0.8]} />
        <meshBasicMaterial
          color={alertColor}
          transparent
          opacity={0.95}
          clippingPlanes={clips}
        />
      </mesh>

      {hasAnyInlineChild ? (
        // Inline flow: renders "Main article: " (XRText) + link (XRLink) as a
        // single prose run with correct accent colouring for the link segment.
        <InlineProseRows
          rows={rows}
          startY={-0.014}
          panelWidth={w - X_INSET}
          fontSize={m.fontSize}
          lineHeightRatio={m.lineHeightRatio}
          xInset={X_INSET}
          renderChild={renderChild}
        />
      ) : (
        // Fallback: label-only alerts (live regions, status messages, etc.)
        // Prefer primitive.content over primitive.label — the mapper may set
        // label to only the accessible short-name (e.g. "Main article:") while
        // content carries the full visible text (e.g. "Main article: KPop Demon
        // Hunters (soundtrack)").  This is a stop-gap: link text will appear
        // but without accent colouring.  The proper fix is for the mapper to
        // populate primitive.children so the hasAnyInlineChild branch above
        // fires and InlineProseRows handles link styling correctly.
        <ClippedText
          anchorX="left"
          anchorY="top"
          position={[X_INSET, -0.014, Z_LAYER_BODY_TEXT]}
          renderOrder={RENDER_ORDER_TEXT}
          fontSize={0.022}
          color={isAssertive ? "#B3261E" : theme.bodyCol}
          maxWidth={w - 0.032}
          lineHeight={1.4}
        >
          {primitive.content ?? primitive.label ?? ""}
        </ClippedText>
      )}
    </group>
  );
}

// ─────────────────────────────────────────────────────────────
// 14. XRTableMesh
// ─────────────────────────────────────────────────────────────

export interface XRTableMeshProps {
  primitive: import("../../../mapper/types").XRTable;
  entry: LayoutEntry;
  renderChild: (primitiveId: string) => React.ReactNode;
}

export function XRTableMesh({
  primitive,
  entry,
  renderChild,
}: XRTableMeshProps) {
  const { pos, rot } = entryTransform(entry);
  const clips = useClipPlanes();
  const theme = useTheme();
  const w = safeDim(entry.size.width);
  const h = safeDim(entry.size.height);
  const HEADER_H = 0.04;

  return (
    <group position={pos} rotation={rot}>
      <Surface
        width={w}
        height={h}
        color={theme.panelBg}
        gradient
        rimColor={theme.panelRim}
        clips={clips}
      />

      {/* Header row — a recessed nav-toned band across the top */}
      <Surface
        width={w}
        height={HEADER_H}
        color={theme.navBg}
        origin={[w / 2, -HEADER_H / 2]}
        z={Z_LAYER_ACCENT}
        clips={clips}
      />

      {primitive.label && (
        <ClippedText
          anchorX="left"
          anchorY="middle"
          position={[0.014, -HEADER_H / 2, Z_LAYER_BODY_TEXT]}
          fontSize={0.018}
          color={theme.headingCol}
          fontWeight="600"
          maxWidth={w - 0.12}
        >
          {primitive.label}
        </ClippedText>
      )}

      {primitive.children.map((child) => renderChild(child.id))}
    </group>
  );
}

// ─────────────────────────────────────────────────────────────
// 15. XRFormFieldMesh
// ─────────────────────────────────────────────────────────────

export interface XRFormFieldMeshProps {
  primitive: import("../../../mapper/types").XRFormField;
  entry: LayoutEntry;
}

export function XRFormFieldMesh({ primitive, entry }: XRFormFieldMeshProps) {
  const { pos, rot } = entryTransform(entry);
  const clips = useClipPlanes();
  const theme = useTheme();
  const w = safeDim(entry.size.width);
  const h = safeDim(entry.size.height);
  const disabled = primitive.state?.disabled === true;
  const readonly = primitive.state?.readonly === true;
  const invalid = primitive.state?.invalid === true;
  const INPUT_H = Math.min(0.04, h * 0.62);
  const cy = -h + INPUT_H / 2;
  const label = primitive.resolvedLabel ?? primitive.label ?? "";
  // Meta-style filled field: the typed value (content) reads as body text,
  // the placeholder as muted; a readonly/disabled field dims its fill.
  const value = (primitive.content ?? "").trim();
  const isSpin = primitive.controlType === "spinbutton";
  const stepperW = isSpin ? INPUT_H : 0;
  const fieldW = w - stepperW - (isSpin ? 0.006 : 0);

  return (
    <group position={pos} rotation={rot}>
      {label && (
        <ClippedText
          anchorX="left"
          anchorY="bottom"
          position={[0.004, -(h - INPUT_H) + 0.006, Z_LAYER_BODY_TEXT]}
          fontSize={0.015}
          color={theme.mutedTextCol}
          maxWidth={w}
          letterSpacing={0.01}
        >
          {label}
        </ClippedText>
      )}

      <Surface
        width={fieldW}
        height={INPUT_H}
        radius={0.008}
        color={theme.inputBg}
        rimColor={invalid ? "#E5484D" : theme.panelRim}
        opacity={disabled ? 0.45 : readonly ? 0.75 : 1}
        origin={[fieldW / 2, cy]}
        clips={clips}
      />

      <ClippedText
        anchorX="left"
        anchorY="middle"
        position={[0.014, cy, Z_LAYER_BODY_TEXT]}
        fontSize={0.016}
        color={value ? theme.bodyCol : theme.mutedTextCol}
        maxWidth={fieldW - 0.028}
      >
        {value || primitive.placeholder || ""}
      </ClippedText>

      {isSpin && (
        <group>
          <Surface
            width={stepperW}
            height={INPUT_H}
            radius={0.008}
            color={theme.listItemBg}
            rimColor={theme.panelRim}
            opacity={disabled ? 0.45 : 1}
            origin={[w - stepperW / 2, cy]}
            clips={clips}
          />
          <ClippedText
            anchorX="center"
            anchorY="middle"
            position={[w - stepperW / 2, cy + INPUT_H * 0.22, Z_LAYER_OVERLAY_TEXT]}
            fontSize={0.011}
            color={theme.bodyCol}
          >
            ▲
          </ClippedText>
          <ClippedText
            anchorX="center"
            anchorY="middle"
            position={[w - stepperW / 2, cy - INPUT_H * 0.22, Z_LAYER_OVERLAY_TEXT]}
            fontSize={0.011}
            color={theme.bodyCol}
          >
            ▼
          </ClippedText>
        </group>
      )}
    </group>
  );
}

// ─────────────────────────────────────────────────────────────
// 15b. Form controls — Meta XR UI-kit styled inputs
//   XRToggle (checkbox / radio / switch), XRSlider, XRComboBox, XRSearchBox.
//   Each renders as a single control row of height entry.size.height with a
//   flat, rounded Horizon-OS chip and the Meta accent (#0082FB) for the
//   active/checked state.
// ─────────────────────────────────────────────────────────────

export function XRToggleMesh({
  primitive,
  entry,
}: {
  primitive: import("../../../mapper/types").XRToggle;
  entry: LayoutEntry;
}) {
  const { pos, rot } = entryTransform(entry);
  const clips = useClipPlanes();
  const theme = useTheme();
  const w = safeDim(entry.size.width);
  const h = safeDim(entry.size.height);
  const midY = -h / 2;
  const on =
    primitive.state?.checked === true || primitive.state?.selected === true;
  const disabled = primitive.state?.disabled === true;
  const kind = primitive.toggleType;
  const accent = theme.accentCol;
  const opacity = disabled ? 0.45 : 1;
  const S = Math.min(h * 0.7, 0.026);
  const labelText = primitive.label ?? "";

  let control: React.ReactNode;
  let labelX: number;

  if (kind === "switch") {
    const trackW = S * 1.85;
    const trackH = S;
    const thumbR = trackH * 0.4;
    control = (
      <group>
        <Surface
          width={trackW}
          height={trackH}
          radius={trackH / 2}
          color={on ? accent : theme.inputBg}
          rimColor={theme.panelRim}
          flat
          opacity={opacity}
          origin={[trackW / 2, midY]}
          clips={clips}
        />
        <Surface
          width={thumbR * 2}
          height={thumbR * 2}
          radius={thumbR}
          color="#FFFFFF"
          flat
          opacity={opacity}
          z={Z_LAYER_ACCENT}
          origin={[on ? trackW - thumbR - 0.003 : thumbR + 0.003, midY]}
          clips={clips}
        />
      </group>
    );
    labelX = trackW + 0.016;
  } else {
    const r = kind === "radio" ? S / 2 : Math.max(0.004, S * 0.28);
    control = (
      <group>
        <Surface
          width={S}
          height={S}
          radius={r}
          color={on ? accent : theme.inputBg}
          rimColor={on ? accent : theme.panelRim}
          flat
          opacity={opacity}
          origin={[S / 2, midY]}
          clips={clips}
        />
        {on && kind === "checkbox" && (
          <ClippedText
            anchorX="center"
            anchorY="middle"
            position={[S / 2, midY, Z_LAYER_OVERLAY_TEXT]}
            fontSize={S * 0.82}
            color="#FFFFFF"
            fontWeight="700"
          >
            ✓
          </ClippedText>
        )}
        {on && kind === "radio" && (
          <Surface
            width={S * 0.44}
            height={S * 0.44}
            radius={S * 0.22}
            color="#FFFFFF"
            flat
            opacity={opacity}
            z={Z_LAYER_ACCENT}
            origin={[S / 2, midY]}
            clips={clips}
          />
        )}
      </group>
    );
    labelX = S + 0.016;
  }

  return (
    <group position={pos} rotation={rot}>
      {control}
      {labelText && (
        <ClippedText
          anchorX="left"
          anchorY="middle"
          position={[labelX, midY, Z_LAYER_BODY_TEXT]}
          fontSize={0.016}
          color={disabled ? theme.mutedTextCol : theme.bodyCol}
          maxWidth={Math.max(0.05, w - labelX)}
        >
          {labelText}
        </ClippedText>
      )}
    </group>
  );
}

export function XRSliderMesh({
  primitive,
  entry,
}: {
  primitive: import("../../../mapper/types").XRSlider;
  entry: LayoutEntry;
}) {
  const { pos, rot } = entryTransform(entry);
  const clips = useClipPlanes();
  const theme = useTheme();
  const w = safeDim(entry.size.width);
  const h = safeDim(entry.size.height);
  const disabled = primitive.state?.disabled === true;
  const frac = Math.max(
    0,
    Math.min(1, primitive.valueFraction ?? primitive.state?.valueFraction ?? 0),
  );
  const accent = theme.accentCol;
  const label = primitive.label ?? "";
  const trackH = 0.006;
  const trackY = -h + 0.012;
  const thumbR = 0.011;
  const fillW = Math.max(0, w * frac);
  const pct = Math.round(frac * 100);

  return (
    <group position={pos} rotation={rot}>
      {label && (
        <ClippedText
          anchorX="left"
          anchorY="top"
          position={[0.004, -0.002, Z_LAYER_BODY_TEXT]}
          fontSize={0.015}
          color={theme.mutedTextCol}
          maxWidth={w - 0.08}
        >
          {label}
        </ClippedText>
      )}
      <ClippedText
        anchorX="right"
        anchorY="top"
        position={[w, -0.002, Z_LAYER_BODY_TEXT]}
        fontSize={0.015}
        color={disabled ? theme.mutedTextCol : theme.bodyCol}
      >
        {`${pct}%`}
      </ClippedText>

      {/* Track */}
      <Surface
        width={w}
        height={trackH}
        radius={trackH / 2}
        color={theme.inputBg}
        flat
        opacity={disabled ? 0.45 : 1}
        origin={[w / 2, trackY]}
        clips={clips}
      />
      {/* Filled portion */}
      {fillW > 0.001 && (
        <Surface
          width={fillW}
          height={trackH}
          radius={trackH / 2}
          color={accent}
          flat
          opacity={disabled ? 0.5 : 1}
          z={Z_LAYER_ACCENT}
          origin={[fillW / 2, trackY]}
          clips={clips}
        />
      )}
      {/* Thumb */}
      <Surface
        width={thumbR * 2}
        height={thumbR * 2}
        radius={thumbR}
        color="#FFFFFF"
        rimColor={accent}
        flat
        opacity={disabled ? 0.5 : 1}
        z={Z_LAYER_OVERLAY_TEXT}
        origin={[Math.max(thumbR, Math.min(w - thumbR, fillW)), trackY]}
        clips={clips}
      />
    </group>
  );
}

export function XRComboBoxMesh({
  primitive,
  entry,
}: {
  primitive: import("../../../mapper/types").XRComboBox;
  entry: LayoutEntry;
}) {
  const { pos, rot } = entryTransform(entry);
  const clips = useClipPlanes();
  const theme = useTheme();
  const w = safeDim(entry.size.width);
  const h = safeDim(entry.size.height);
  const disabled = primitive.state?.disabled === true;
  const INPUT_H = Math.min(0.04, h * 0.9);
  const cy = -h / 2;
  // Show the selected option's label (an <option selected> anywhere in the
  // options subtree), falling back to the first option, then a neutral prompt.
  const value = React.useMemo(() => {
    let firstOption: string | null = null;
    const walk = (node: import("../../../mapper/types").XRPrimitive): string | null => {
      for (const child of node.children) {
        if (child.type === "XRListItem" || child.type === "XRMenuItem") {
          const lbl = (child.label ?? child.content ?? "").trim();
          if (lbl && firstOption === null) firstOption = lbl;
          const selected = (child as unknown as { state?: { selected?: boolean } })
            .state?.selected;
          if (selected === true && lbl) return lbl;
        }
        const nested = walk(child);
        if (nested) return nested;
      }
      return null;
    };
    return walk(primitive) ?? firstOption ?? "Select…";
  }, [primitive]);

  return (
    <group position={pos} rotation={rot}>
      <Surface
        width={w}
        height={INPUT_H}
        radius={0.008}
        color={theme.inputBg}
        rimColor={theme.panelRim}
        opacity={disabled ? 0.45 : 1}
        origin={[w / 2, cy]}
        clips={clips}
      />
      <ClippedText
        anchorX="left"
        anchorY="middle"
        position={[0.014, cy, Z_LAYER_BODY_TEXT]}
        fontSize={0.016}
        color={disabled ? theme.mutedTextCol : theme.bodyCol}
        maxWidth={w - 0.05}
      >
        {value}
      </ClippedText>
      <ClippedText
        anchorX="right"
        anchorY="middle"
        position={[w - 0.014, cy, Z_LAYER_OVERLAY_TEXT]}
        fontSize={0.018}
        color={theme.bodyCol}
      >
        ▾
      </ClippedText>
    </group>
  );
}

export function XRSearchBoxMesh({
  primitive,
  entry,
}: {
  primitive: import("../../../mapper/types").XRSearchBox;
  entry: LayoutEntry;
}) {
  const { pos, rot } = entryTransform(entry);
  const clips = useClipPlanes();
  const theme = useTheme();
  const w = safeDim(entry.size.width);
  const h = safeDim(entry.size.height);
  const disabled = primitive.state?.disabled === true;
  const INPUT_H = Math.min(0.04, h * 0.9);
  const cy = -h / 2;
  const value = (primitive.content ?? "").trim();
  const placeholder = primitive.placeholder ?? primitive.label ?? "Search…";

  return (
    <group position={pos} rotation={rot}>
      {/* Rounded pill search field */}
      <Surface
        width={w}
        height={INPUT_H}
        radius={INPUT_H / 2}
        color={theme.inputBg}
        rimColor={theme.panelRim}
        opacity={disabled ? 0.45 : 1}
        origin={[w / 2, cy]}
        clips={clips}
      />
      {/* Magnifier glyph */}
      <ClippedText
        anchorX="left"
        anchorY="middle"
        position={[0.014, cy, Z_LAYER_OVERLAY_TEXT]}
        fontSize={0.018}
        color={theme.mutedTextCol}
      >
        ⌕
      </ClippedText>
      <ClippedText
        anchorX="left"
        anchorY="middle"
        position={[0.04, cy, Z_LAYER_BODY_TEXT]}
        fontSize={0.016}
        color={value ? theme.bodyCol : theme.mutedTextCol}
        maxWidth={w - 0.06}
      >
        {value || placeholder}
      </ClippedText>
    </group>
  );
}

// ─────────────────────────────────────────────────────────────
// 16. XRTabGroupMesh
// ─────────────────────────────────────────────────────────────

export interface XRTabGroupMeshProps {
  primitive: import("../../../mapper/types").XRTabGroup;
  entry: LayoutEntry;
  renderChild: (primitiveId: string) => React.ReactNode;
}

export function XRTabGroupMesh({
  primitive,
  entry,
  renderChild,
}: XRTabGroupMeshProps) {
  const { pos, rot } = entryTransform(entry);
  const clips = useClipPlanes();
  const theme = useTheme();
  const w = safeDim(entry.size.width);
  const h = safeDim(entry.size.height);
  const TAB_H = 0.042;

  return (
    <group position={pos} rotation={rot}>
      {/* Tab bar — recessed nav-toned strip */}
      <Surface
        width={w}
        height={TAB_H}
        color={theme.navBg}
        origin={[w / 2, -TAB_H / 2]}
        clips={clips}
      />

      {/* Content panel below the tab bar */}
      <Surface
        width={w}
        height={h - TAB_H}
        color={theme.panelBg}
        gradient
        origin={[w / 2, -(TAB_H + (h - TAB_H) / 2)]}
        clips={clips}
      />

      {primitive.children.map((child) => renderChild(child.id))}
    </group>
  );
}

// primitives.tsx - Add XRTextMesh for rendering text nodes

