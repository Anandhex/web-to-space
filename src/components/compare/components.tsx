/**
 * compare/components.tsx — presentational building blocks for the comparison
 * table (tooltip, section header, cells, rows, ground-truth bar).
 */
import React, { useRef, useState, useCallback } from "react";
import { createPortal } from "react-dom";

import { METRIC_DESCRIPTIONS } from "./config";
import type { HTMLGroundTruth } from "./types";

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
          color: "#2a4a6a",
          fontSize: 10,
          marginLeft: 5,
          cursor: "default",
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
              background: "rgba(6,12,22,0.97)",
              border: "1px solid rgba(88,166,255,0.22)",
              borderRadius: 7,
              padding: "9px 12px",
              fontSize: 11,
              color: "#8aaac8",
              lineHeight: 1.6,
              width: 290,
              zIndex: 999999,
              pointerEvents: "none",
              boxShadow: "0 10px 40px rgba(0,0,0,0.7)",
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
          padding: "10px 10px 4px",
          color: "#2a4a6a",
          fontSize: 10,
          fontWeight: 700,
          textTransform: "uppercase",
          letterSpacing: "0.1em",
          borderTop: "1px solid rgba(30,45,61,0.6)",
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
        padding: "4px 10px",
        textAlign: "right",
        fontFamily: "monospace",
        fontSize: 12,
        color: dim
          ? "#3a5a7a"
          : best
            ? "#4ec966"
            : worst
              ? "#f6a623"
              : "#c8d8e8",
        background: best
          ? "rgba(78,201,102,0.06)"
          : worst
            ? "rgba(246,166,35,0.06)"
            : "transparent",
        borderBottom: "1px solid rgba(20,30,40,0.7)",
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
          padding: "4px 10px",
          fontSize: 12,
          color: dim ? "#3a5a7a" : "#8a9aaa",
          whiteSpace: "nowrap",
          borderBottom: "1px solid rgba(20,30,40,0.7)",
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
          padding: "4px 10px",
          fontSize: 12,
          color: "#8a9aaa",
          whiteSpace: "nowrap",
          borderBottom: "1px solid rgba(20,30,40,0.7)",
        }}
      >
        {label}
        {tooltipText && <Tooltip text={tooltipText} />}
      </td>
      {values.map((v, i) => (
        <td
          key={i}
          style={{
            padding: "4px 10px",
            textAlign: "right",
            fontFamily: "monospace",
            fontSize: 12,
            color: v ? "#4ec966" : "#f6a623",
            background:
              allTrue || allFalse
                ? "transparent"
                : v
                  ? "rgba(78,201,102,0.06)"
                  : "rgba(246,166,35,0.06)",
            borderBottom: "1px solid rgba(20,30,40,0.7)",
          }}
        >
          {v ? "yes" : "no"}
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
        gap: 16,
        flexWrap: "wrap",
        padding: "8px 10px",
        marginBottom: 10,
        background: "rgba(20,35,55,0.4)",
        borderRadius: 6,
        border: "1px solid rgba(30,45,61,0.5)",
      }}
    >
      <span
        style={{
          fontSize: 10,
          color: "#2a4a6a",
          textTransform: "uppercase",
          letterSpacing: "0.08em",
          alignSelf: "center",
          whiteSpace: "nowrap",
        }}
      >
        HTML ground truth
      </span>
      {items.map(({ label, value }) => (
        <span
          key={label}
          style={{ fontSize: 11, color: "#4a6a8a", fontFamily: "monospace" }}
        >
          <span style={{ color: "#58a6ff" }}>{value}</span>
          <span style={{ color: "#2a4a6a", marginLeft: 3 }}>{label}</span>
        </span>
      ))}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Main component
// ─────────────────────────────────────────────────────────────

