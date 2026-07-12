/**
 * PanelTuner.tsx
 *
 * A 2D DOM overlay (NOT an in-world panel — so it never occludes the 3D scene)
 * for live-tuning landmark panels in the flat preview: pick a target (main,
 * toc, complementary, banner, footer, navigation, or the carousel ghosts), drag
 * the sliders, and the panel moves live. "Export" copies a paste-ready snippet
 * for the source of truth (a *Slots() slot literal, or the scene-graph ghost
 * offsets).
 *
 * Angles are radians (WebXR), distances/radii metres. `x` is the panel's LEFT
 * edge (top-left anchor), matching the layout engine's slot convention.
 */
import React, {
  useCallback,
  useState,
  useEffect,
  type CSSProperties,
} from "react";

/** Full tuning state — every field defined (unlike the Partial override). */
export interface TuneState {
  x: number;
  y: number;
  z: number;
  rotX: number;
  rotY: number;
  rotZ: number;
  curveRadius: number;
}

/** A tunable target: a landmark slot, or a carousel ghost panel. */
export interface TunerTarget {
  id: string;
  label: string;
  kind: "slot" | "ghost";
}

interface FieldDef {
  key: keyof TuneState;
  label: string;
  min: number;
  max: number;
  step: number;
}

const FIELDS: FieldDef[] = [
  { key: "x", label: "X (left edge)", min: -3, max: 3, step: 0.01 },
  { key: "y", label: "Y", min: -1, max: 3, step: 0.01 },
  { key: "z", label: "Z (depth)", min: -5, max: 0, step: 0.01 },
  { key: "rotX", label: "Rot X", min: -Math.PI, max: Math.PI, step: 0.01 },
  { key: "rotY", label: "Rot Y", min: -Math.PI, max: Math.PI, step: 0.01 },
  { key: "rotZ", label: "Rot Z", min: -Math.PI, max: Math.PI, step: 0.01 },
  { key: "curveRadius", label: "Curve radius", min: 0, max: 3, step: 0.01 },
];

const DEFAULT_STATE: TuneState = {
  x: 0,
  y: 1.4,
  z: -1.2,
  rotX: 0,
  rotY: 0,
  rotZ: 0,
  curveRadius: 0,
};

export interface PanelTunerProps {
  /** Tunable targets present in the current scene/view. */
  targets: TunerTarget[];
  /** Active override per target id (present = tuning on for that target). */
  overrides: Record<string, TuneState>;
  /** Seed values for a target, used when tuning is switched on. */
  seedFor: (id: string) => TuneState | null;
  /** Live size for a slot target — carried into the exported slot literal. */
  sizeFor: (id: string) => { width: number; height: number } | null;
  /** Reference anchor (main slot position) for computing ghost export offsets. */
  anchorFor: (id: string) => { x: number; y: number; z: number } | null;
  deviceType: string;
  viewMode: string | undefined;
  template: string | undefined;
  onChange: (id: string, next: TuneState | null) => void;
}

const RAD2DEG = 180 / Math.PI;

export function PanelTuner({
  targets,
  overrides,
  seedFor,
  sizeFor,
  anchorFor,
  deviceType,
  viewMode,
  template,
  onChange,
}: PanelTunerProps) {
  const [active, setActive] = useState<string>(targets[0]?.id ?? "");

  // Keep the active target valid as the scene/view changes the target list.
  useEffect(() => {
    if (targets.length && !targets.some((t) => t.id === active)) {
      setActive(targets[0].id);
    }
  }, [targets, active]);

  const activeTarget = targets.find((t) => t.id === active);
  const isGhost = activeTarget?.kind === "ghost";
  const value = overrides[active] ?? null;
  const enabled = value !== null;

  const toggle = useCallback(() => {
    if (enabled) {
      onChange(active, null);
    } else {
      onChange(active, seedFor(active) ?? DEFAULT_STATE);
    }
  }, [enabled, active, seedFor, onChange]);

  const setField = useCallback(
    (key: keyof TuneState, v: number) => {
      if (!value) return;
      onChange(active, { ...value, [key]: v });
    },
    [value, active, onChange],
  );

  const reseed = useCallback(() => {
    const s = seedFor(active);
    if (s) onChange(active, s);
  }, [active, seedFor, onChange]);

  const exportSnippet = useCallback(() => {
    if (!value || !activeTarget) return;
    const f = (n: number) => n.toFixed(3).replace(/\.?0+$/, "") || "0";
    let snippet: string;
    if (activeTarget.kind === "ghost") {
      // Ghosts are computed in scene-graph.tsx from the main entry + constants.
      // Emit the offset from main plus the facing angle so the values are
      // pasteable into the ghost entry there.
      // NB: angularRotation() negates its argument (returns y = -deg2rad(deg)),
      // while live tuning applies value.rotY straight as the Euler y. So negate
      // here — angularRotation(-rotY°) reproduces the exact pose that was tuned.
      const anchor = anchorFor(active) ?? { x: 0, y: 0, z: 0 };
      const angleDeg = -value.rotY * RAD2DEG;
      // Signed offset: "+ 0.3" / "- 1.6" so the expression reads cleanly.
      const off = (a: number, b: number) => {
        const d = a - b;
        return d < 0 ? `- ${f(-d)}` : `+ ${f(d)}`;
      };
      snippet = [
        `// ${deviceType} · carousel ${activeTarget.label} — offsets from main in scene-graph.tsx`,
        `position: {`,
        `  x: entry.position.x ${off(value.x, anchor.x)},`,
        `  y: entry.position.y ${off(value.y, anchor.y)},`,
        `  z: entry.position.z ${off(value.z, anchor.z)},`,
        `},`,
        `rotation: angularRotation(${f(angleDeg)}),`,
      ].join("\n");
    } else {
      // Slot: emit a paste-ready `<slot>` LandmarkSlot literal for the matching
      // *Slots() function in placement.ts, tagged with the active view.
      const view = viewMode ?? "standard";
      const size = sizeFor(active);
      const lines = [
        `// ${deviceType} · ${view} view${template ? ` (${template})` : ""} — paste into the matching *Slots() ${activeTarget.id} slot in placement.ts`,
        `${activeTarget.id}: {`,
        `  position: { x: ${f(value.x)}, y: ${f(value.y)}, z: ${f(value.z)} },`,
        `  rotation: { x: ${f(value.rotX)}, y: ${f(value.rotY)}, z: ${f(value.rotZ)} },`,
      ];
      if (size) {
        lines.push(
          `  size: { width: ${f(size.width)}, height: ${f(size.height)} },`,
        );
      }
      lines.push(
        `  curveRadius: ${f(value.curveRadius)},`,
        `  worldLocked: true,`,
        `},`,
      );
      snippet = lines.join("\n");
    }
    navigator.clipboard?.writeText(snippet).catch(() => {});
    // Fallback + visibility: also log it so it's grabbable if clipboard is denied.
    // eslint-disable-next-line no-console
    console.log(snippet);
  }, [
    value,
    activeTarget,
    active,
    anchorFor,
    sizeFor,
    deviceType,
    viewMode,
    template,
  ]);

  // Ghosts inherit the main panel's curve — hide the curve row for them.
  const fields = isGhost
    ? FIELDS.filter((fd) => fd.key !== "curveRadius")
    : FIELDS;

  return (
    <div style={S.root}>
      <div style={S.header}>
        <span style={S.title}>Panel tuner</span>
        <label style={S.toggle}>
          <input type="checkbox" checked={enabled} onChange={toggle} />
          <span>{enabled ? "on" : "off"}</span>
        </label>
      </div>

      <select
        style={S.select}
        value={active}
        onChange={(e) => setActive(e.target.value)}
      >
        {targets.map((t) => (
          <option key={t.id} value={t.id}>
            {t.label}
            {overrides[t.id] ? "  ●" : ""}
          </option>
        ))}
      </select>

      {enabled && value && (
        <>
          <div style={S.fields}>
            {fields.map((fd) => {
              const v = value[fd.key];
              return (
                <div key={fd.key} style={S.field}>
                  <div style={S.fieldLabel}>
                    <span>{fd.label}</span>
                    <span style={S.fieldVal}>{v.toFixed(3)}</span>
                  </div>
                  <div style={S.fieldRow}>
                    <input
                      type="range"
                      min={fd.min}
                      max={fd.max}
                      step={fd.step}
                      value={v}
                      onChange={(e) => setField(fd.key, Number(e.target.value))}
                      style={S.range}
                    />
                    <input
                      type="number"
                      step={fd.step}
                      value={Number(v.toFixed(3))}
                      onChange={(e) => setField(fd.key, Number(e.target.value))}
                      style={S.num}
                    />
                  </div>
                </div>
              );
            })}
          </div>
          <div style={S.actions}>
            <button
              style={S.btn}
              onClick={reseed}
              title="Reset sliders to the current layout"
            >
              Sync
            </button>
            <button
              style={{ ...S.btn, ...S.btnPrimary }}
              onClick={exportSnippet}
            >
              Export → clipboard
            </button>
          </div>
        </>
      )}
    </div>
  );
}

const S: Record<string, CSSProperties> = {
  root: {
    position: "fixed",
    bottom: 12,
    left: 12,
    zIndex: 1000,
    width: 240,
    padding: "10px 12px",
    borderRadius: 10,
    background: "rgba(10,16,24,0.86)",
    border: "1px solid #223247",
    backdropFilter: "blur(6px)",
    color: "#cbd5e1",
    font: "12px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace",
    boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
  },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 8,
  },
  title: { color: "#e2e8f0", fontWeight: 600 },
  toggle: { display: "flex", alignItems: "center", gap: 4, cursor: "pointer" },
  select: {
    width: "100%",
    marginBottom: 8,
    background: "#0d1520",
    border: "1px solid #223247",
    borderRadius: 4,
    color: "#cbd5e1",
    padding: "3px 4px",
    font: "inherit",
  },
  fields: { display: "flex", flexDirection: "column", gap: 8 },
  field: { display: "flex", flexDirection: "column", gap: 2 },
  fieldLabel: {
    display: "flex",
    justifyContent: "space-between",
    color: "#94a3b8",
  },
  fieldVal: { color: "#58a6ff" },
  fieldRow: { display: "flex", alignItems: "center", gap: 6 },
  range: { flex: 1, accentColor: "#58a6ff" },
  num: {
    width: 58,
    background: "#0d1520",
    border: "1px solid #223247",
    borderRadius: 4,
    color: "#cbd5e1",
    padding: "2px 4px",
    font: "inherit",
  },
  actions: { display: "flex", gap: 6, marginTop: 10 },
  btn: {
    flex: 1,
    padding: "5px 8px",
    borderRadius: 6,
    border: "1px solid #223247",
    background: "#0d1520",
    color: "#cbd5e1",
    cursor: "pointer",
    font: "inherit",
  },
  btnPrimary: { background: "#1d4ed8", borderColor: "#1d4ed8", color: "#fff" },
};
