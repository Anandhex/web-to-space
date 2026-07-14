/**
 * compare/components.tsx — presentational building blocks for the comparison
 * table (tooltip, section header, cells, rows, ground-truth bar).
 *
 * Light theme. Palette kept in one place so every piece stays consistent:
 *   ink #1f2937 · muted #6b7280 · faint #9aa3af · border #e6e8ec
 *   accent #4f46e5 · good #15803d/#f1faf4 · warn #b45309/#fdf6ec
 * Numbers use tabular-nums in the system font (not monospace) for a cleaner,
 * less "terminal" feel while still aligning columns.
 */
import React, { useRef, useState, useCallback } from "react";
import { createPortal } from "react-dom";

import { METRIC_DESCRIPTIONS } from "./config";
import type { HTMLGroundTruth } from "./types";

const NUM: React.CSSProperties = {
  fontVariantNumeric: "tabular-nums",
  fontFeatureSettings: '"tnum"',
};

export function Tooltip({ text }: { text: string }) {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const iconRef = useRef<HTMLSpanElement>(null);

  const show = useCallback(() => {
    if (iconRef.current) {
      const r = iconRef.current.getBoundingClientRect();
      setPos({ x: r.left + r.width / 2, y: r.top });
    }
  }, []);

  const hide = useCallback(() => setPos(null), []);

  return (
    <>
      <span
        ref={iconRef}
        onMouseEnter={show}
        onMouseLeave={hide}
        style={{
          color: "#b7bcc6",
          fontSize: 10,
          marginLeft: 5,
          cursor: "help",
          userSelect: "none",
        }}
      >
        ⓘ
      </span>
      {pos &&
        createPortal(
          <div
            style={{
              position: "fixed",
              left: pos.x,
              top: pos.y - 8,
              transform: "translate(-50%, -100%)",
              background: "#ffffff",
              border: "1px solid #e6e8ec",
              borderRadius: 8,
              padding: "9px 12px",
              fontSize: 11.5,
              color: "#4b5563",
              lineHeight: 1.55,
              width: 290,
              zIndex: 999999,
              pointerEvents: "none",
              boxShadow: "0 8px 28px rgba(17,24,39,0.14)",
              whiteSpace: "normal",
            }}
          >
            {text}
          </div>,
          document.body,
        )}
    </>
  );
}

// ─────────────────────────────────────────────────────────────
// Table sub-components
// ─────────────────────────────────────────────────────────────

export function SectionHeader({
  label,
  colCount,
}: {
  label: string;
  colCount: number;
}) {
  return (
    <tr>
      <td
        colSpan={colCount + 1}
        style={{
          padding: "16px 10px 6px",
          color: "#8a91a0",
          fontSize: 10.5,
          fontWeight: 600,
          textTransform: "uppercase",
          letterSpacing: "0.07em",
        }}
      >
        {label}
      </td>
    </tr>
  );
}

export function Cell({
  value,
  best,
  worst,
  dim,
}: {
  value: string | number;
  best?: boolean;
  worst?: boolean;
  dim?: boolean;
}) {
  return (
    <td
      style={{
        ...NUM,
        padding: "6px 10px",
        textAlign: "right",
        fontSize: 12.5,
        fontWeight: best || worst ? 600 : 400,
        color: dim
          ? "#aeb4bf"
          : best
            ? "#15803d"
            : worst
              ? "#b45309"
              : "#1f2937",
        background: best
          ? "#f1faf4"
          : worst
            ? "#fdf6ec"
            : "transparent",
        borderBottom: "1px solid #f0f1f4",
      }}
    >
      {typeof value === "number" ? value.toLocaleString() : value}
    </td>
  );
}

export function Row({
  label,
  values,
  bestIsLow,
  suffix = "",
  dim,
  indent,
}: {
  label: string;
  values: (number | string)[];
  bestIsLow?: boolean;
  suffix?: string;
  dim?: boolean;
  indent?: boolean;
}) {
  const nums = values.filter((v): v is number => typeof v === "number");
  const allSame = nums.length > 1 && nums.every((n) => n === nums[0]);
  const best =
    !allSame && nums.length > 0
      ? bestIsLow
        ? Math.min(...nums)
        : Math.max(...nums)
      : null;
  const worst =
    !allSame && nums.length > 1
      ? bestIsLow
        ? Math.max(...nums)
        : Math.min(...nums)
      : null;
  const tooltipText = METRIC_DESCRIPTIONS[label];

  return (
    <tr>
      <td
        style={{
          padding: "6px 10px",
          fontSize: 12.5,
          color: dim ? "#aeb4bf" : "#4b5563",
          whiteSpace: "nowrap",
          borderBottom: "1px solid #f0f1f4",
          paddingLeft: indent ? 22 : 10,
        }}
      >
        {label}
        {tooltipText && <Tooltip text={tooltipText} />}
      </td>
      {values.map((v, i) => (
        <Cell
          key={i}
          value={typeof v === "number" ? v + suffix : v}
          best={typeof v === "number" && v === best}
          worst={typeof v === "number" && v === worst && worst !== best}
          dim={dim}
        />
      ))}
    </tr>
  );
}

export function BoolRow({ label, values }: { label: string; values: boolean[] }) {
  const tooltipText = METRIC_DESCRIPTIONS[label];
  const allTrue = values.every(Boolean);
  const allFalse = values.every((v) => !v);
  return (
    <tr>
      <td
        style={{
          padding: "6px 10px",
          fontSize: 12.5,
          color: "#4b5563",
          whiteSpace: "nowrap",
          borderBottom: "1px solid #f0f1f4",
        }}
      >
        {label}
        {tooltipText && <Tooltip text={tooltipText} />}
      </td>
      {values.map((v, i) => (
        <td
          key={i}
          style={{
            ...NUM,
            padding: "6px 10px",
            textAlign: "right",
            fontSize: 12.5,
            fontWeight: 600,
            color: v ? "#15803d" : "#b45309",
            background:
              allTrue || allFalse ? "transparent" : v ? "#f1faf4" : "#fdf6ec",
            borderBottom: "1px solid #f0f1f4",
          }}
        >
          {v ? "Yes" : "No"}
        </td>
      ))}
    </tr>
  );
}

// Ground truth reference bar shown above the table
export function GroundTruthBar({ gt }: { gt: HTMLGroundTruth }) {
  const items = [
    { label: "headings", value: gt.headingCount },
    { label: "landmarks", value: gt.landmarkCount },
    { label: "nav regions", value: gt.navCount },
    { label: "form inputs", value: gt.formInputCount },
    { label: "images w/ alt", value: gt.imageWithAltCount },
    { label: "aria-labelledby", value: gt.ariaLabelledByCount },
    { label: "DOM words", value: gt.totalTextWordCount.toLocaleString() },
  ];
  return (
    <div
      style={{
        display: "flex",
        gap: 18,
        flexWrap: "wrap",
        padding: "10px 14px",
        marginBottom: 14,
        background: "#f7f8fa",
        borderRadius: 8,
        border: "1px solid #ebedf1",
      }}
    >
      <span
        style={{
          fontSize: 10,
          color: "#8a91a0",
          textTransform: "uppercase",
          letterSpacing: "0.07em",
          fontWeight: 600,
          alignSelf: "center",
          whiteSpace: "nowrap",
        }}
      >
        HTML ground truth
      </span>
      {items.map(({ label, value }) => (
        <span
          key={label}
          style={{ fontSize: 12, color: "#6b7280", ...NUM }}
        >
          <span style={{ color: "#111827", fontWeight: 600 }}>{value}</span>
          <span style={{ color: "#9aa3af", marginLeft: 4 }}>{label}</span>
        </span>
      ))}
    </div>
  );
}
