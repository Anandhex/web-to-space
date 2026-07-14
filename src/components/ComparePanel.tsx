/**
 * ComparePanel.tsx
 *
 * Modal that runs every parser backend over the current page and renders a
 * side-by-side metric comparison. The metric math, backend runners, Markdown
 * export, and presentational table pieces live in the `compare/` package; this
 * file is just the panel component that wires them together.
 */
import React, { useState, useCallback } from "react";

import type { BackendStats, HTMLGroundTruth } from "./compare/types";
import { KEY_PRIMITIVE_TYPES } from "./compare/config";
import { extractHTMLGroundTruth } from "./compare/metrics";
import { BACKENDS, runBackend } from "./compare/backends";
import { buildMarkdownTable } from "./compare/markdown";
import {
  SectionHeader,
  Row,
  BoolRow,
  GroundTruthBar,
} from "./compare/components";
// ─────────────────────────────────────────────────────────────
// Tabbed structure — group the ~60 metrics by the question they answer,
// so the panel reads as five focused views instead of one wall of numbers.
// ─────────────────────────────────────────────────────────────

type TabId = "overview" | "semantic" | "xr" | "segmentation" | "diagnostics";

const TABS: { id: TabId; label: string; blurb: string }[] = [
  {
    id: "overview",
    label: "Overview",
    blurb:
      "The headline: which backend best turns this page into a semantic XR scene, plus one indicator per dimension. ▲ higher is better.",
  },
  {
    id: "semantic",
    label: "Semantic Fidelity",
    blurb:
      "How faithfully the parse recovers the page's meaning vs the raw HTML — structure, ARIA, text, and classification quality. ▲ higher is better.",
  },
  {
    id: "xr",
    label: "XR Experience",
    blurb:
      "Whether the placed 3D scene is actually readable and reachable on a Quest 3 — legibility, comfort envelope, and navigation cost.",
  },
  {
    id: "segmentation",
    label: "Segmentation",
    blurb:
      "How well each backend's produced scene groups the page into blocks, scored with size-weighted BCubed (Kiesel CIKM'20) against the page's semantic sectioning. ▲ higher F is better; 'aligned units' shows how much content matched the reference.",
  },
  {
    id: "diagnostics",
    label: "Diagnostics",
    blurb:
      "Raw counts and timings behind the scores — pipeline speed, IR structure, node provenance, and primitive inventory.",
  },
];

const round3 = (v: number): number => Math.round(v * 1000) / 1000;

/** Backend label with the best (numerically max/min) value of a selector. */
function winnerBy(
  stats: BackendStats[],
  sel: (s: BackendStats) => number,
  lowIsBest = false,
): { label: string; value: number } {
  let best = stats[0];
  for (const s of stats) {
    const v = sel(s);
    const bv = sel(best);
    if (lowIsBest ? v < bv : v > bv) best = s;
  }
  return { label: best.label, value: sel(best) };
}

/** Persistent summary: the "so what" of the run, above the tabs. */
function VerdictBar({ stats }: { stats: BackendStats[] }) {
  const overall = winnerBy(stats, (s) => s.composite.semanticRichness);
  const readable = winnerBy(stats, (s) =>
    s.xr ? s.xr.legibleFraction * 100 + s.xr.comfortableFraction : 0,
  );
  const fastest = winnerBy(stats, (s) => s.timing.totalMs, true);
  const bestSeg = winnerBy(stats, (s) => s.segmentation.f);

  const cards = [
    { k: "Best overall", v: overall.label, sub: `${overall.value}/100 semantic richness`, tone: "#16a34a" },
    { k: "Most readable", v: readable.label, sub: "legible + comfortable text", tone: "#4f46e5" },
    { k: "Best segmentation", v: bestSeg.label, sub: `F = ${bestSeg.value.toFixed(3)}`, tone: "#7c3aed" },
    { k: "Fastest", v: fastest.label, sub: `${fastest.value} ms total`, tone: "#6b7280" },
  ];

  return (
    <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 18 }}>
      {cards.map((c) => (
        <div
          key={c.k}
          style={{
            flex: "1 1 180px",
            minWidth: 165,
            padding: "12px 14px",
            background: "#ffffff",
            border: "1px solid #e6e8ec",
            borderLeft: `3px solid ${c.tone}`,
            borderRadius: 8,
          }}
        >
          <div
            style={{
              fontSize: 10,
              color: "#8a91a0",
              textTransform: "uppercase",
              letterSpacing: "0.06em",
              fontWeight: 600,
              marginBottom: 5,
            }}
          >
            {c.k}
          </div>
          <div style={{ fontSize: 15, color: "#111827", fontWeight: 600, lineHeight: 1.2 }}>
            {c.v}
          </div>
          <div
            style={{
              fontSize: 11,
              color: "#8a91a0",
              marginTop: 3,
              fontVariantNumeric: "tabular-nums",
            }}
          >
            {c.sub}
          </div>
        </div>
      ))}
    </div>
  );
}

function TabBar({
  active,
  onChange,
}: {
  active: TabId;
  onChange: (t: TabId) => void;
}) {
  return (
    <div
      style={{
        display: "flex",
        gap: 2,
        marginBottom: 4,
        borderBottom: "1px solid #e6e8ec",
        flexWrap: "wrap",
      }}
    >
      {TABS.map((t) => {
        const on = t.id === active;
        return (
          <button
            key={t.id}
            onClick={() => onChange(t.id)}
            style={{
              background: "transparent",
              border: "none",
              borderBottom: `2px solid ${on ? "#4f46e5" : "transparent"}`,
              color: on ? "#4f46e5" : "#6b7280",
              fontSize: 13,
              fontWeight: on ? 600 : 500,
              padding: "9px 14px",
              cursor: "pointer",
              marginBottom: -1,
            }}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}

export function ComparePanel({
  html,
  url,
  onClose,
}: {
  html: string;
  url: string;
  onClose: () => void;
}) {
  const [stats, setStats] = useState<BackendStats[] | null>(null);
  const [gt, setGt] = useState<HTMLGroundTruth | null>(null);
  const [running, setRunning] = useState(false);
  const [copied, setCopied] = useState(false);
  const [tab, setTab] = useState<TabId>("overview");

  const runAll = useCallback(async () => {
    setRunning(true);
    setStats(null);
    const groundTruth = extractHTMLGroundTruth(html);
    setGt(groundTruth);
    const results = await Promise.all(
      BACKENDS.map((b) => runBackend(b.id, b.label, html, url, groundTruth)),
    );
    setStats(results);
    setRunning(false);
  }, [html, url]);

  React.useEffect(() => {
    runAll();
  }, [runAll]);

  const winnerLabel =
    stats && stats.length
      ? stats.reduce((a, b) =>
          b.composite.semanticRichness > a.composite.semanticRichness ? b : a,
        ).label
      : null;

  const copyMarkdown = useCallback(() => {
    if (!stats || !gt) return;
    navigator.clipboard.writeText(buildMarkdownTable(stats, gt)).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [stats, gt]);

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 20,
        background: "rgba(17,24,39,0.35)",
        zIndex: 99999,
        fontFamily:
          '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "min(1040px, 96vw)",
          maxHeight: "90vh",
          overflowY: "auto",
          background: "#ffffff",
          border: "1px solid #e6e8ec",
          borderRadius: 14,
          boxShadow: "0 20px 60px rgba(17,24,39,0.22)",
          color: "#1f2937",
        }}
      >
        {/* Sticky header */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "16px 22px",
            borderBottom: "1px solid #eef0f3",
            position: "sticky",
            top: 0,
            background: "#ffffff",
            zIndex: 1,
          }}
        >
          <div>
            <span
              style={{
                color: "#111827",
                fontWeight: 600,
                fontSize: 16,
                letterSpacing: "-0.01em",
              }}
            >
              Parser Comparison
            </span>
            <span
              style={{
                color: "#9aa3af",
                fontSize: 12,
                marginLeft: 12,
                fontVariantNumeric: "tabular-nums",
              }}
            >
              {url.length > 55 ? url.slice(0, 53) + "…" : url}
            </span>
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            {stats && (
              <button
                onClick={copyMarkdown}
                style={{
                  background: copied ? "#f0fdf4" : "#ffffff",
                  border: `1px solid ${copied ? "#bbe5c6" : "#dcdfe4"}`,
                  borderRadius: 7,
                  color: copied ? "#15803d" : "#4b5563",
                  fontSize: 12.5,
                  fontWeight: 500,
                  padding: "6px 13px",
                  cursor: "pointer",
                }}
              >
                {copied ? "✓ Copied" : "Copy as Markdown"}
              </button>
            )}
            <button
              onClick={runAll}
              disabled={running}
              style={{
                background: running ? "#eef0f3" : "#4f46e5",
                border: "1px solid transparent",
                borderRadius: 7,
                color: running ? "#9aa3af" : "#ffffff",
                fontSize: 12.5,
                fontWeight: 500,
                padding: "6px 14px",
                cursor: running ? "default" : "pointer",
              }}
            >
              {running ? "Running…" : "Re-run"}
            </button>
            <button
              onClick={onClose}
              style={{
                background: "none",
                border: "none",
                color: "#9aa3af",
                fontSize: 20,
                cursor: "pointer",
                lineHeight: 1,
                padding: "0 4px",
              }}
            >
              ✕
            </button>
          </div>
        </div>

        <div style={{ padding: "18px 22px 26px" }}>
        {running && (
          <div
            style={{
              color: "#4f46e5",
              fontSize: 14,
              textAlign: "center",
              padding: "56px 0",
            }}
          >
            <div style={{ marginBottom: 8, fontWeight: 500 }}>
              Running all backends in parallel…
            </div>
            <div style={{ fontSize: 12, color: "#9aa3af" }}>
              Custom · Readability · Naive · VIPS
            </div>
          </div>
        )}

        {stats && gt && (
          <>
            <VerdictBar stats={stats} />
            <TabBar active={tab} onChange={setTab} />
            <div
              style={{
                fontSize: 12.5,
                color: "#6b7280",
                lineHeight: 1.55,
                margin: "14px 0 16px",
              }}
            >
              {TABS.find((t) => t.id === tab)!.blurb}
            </div>

            {(tab === "overview" ||
              tab === "semantic" ||
              tab === "segmentation") && <GroundTruthBar gt={gt} />}

            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  <th
                    style={{
                      textAlign: "left",
                      padding: "8px 10px",
                      color: "#8a91a0",
                      fontSize: 10.5,
                      fontWeight: 600,
                      borderBottom: "1px solid #e6e8ec",
                      textTransform: "uppercase",
                      letterSpacing: "0.06em",
                    }}
                  >
                    Metric
                  </th>
                  {stats.map((s) => {
                    const isWinner = s.label === winnerLabel;
                    return (
                      <th
                        key={s.label}
                        style={{
                          textAlign: "right",
                          padding: "8px 10px",
                          color: isWinner ? "#15803d" : "#374151",
                          fontSize: 12,
                          fontWeight: 600,
                          borderBottom: `2px solid ${isWinner ? "#16a34a" : "#e6e8ec"}`,
                          whiteSpace: "nowrap",
                        }}
                        title={isWinner ? "Highest semantic richness" : undefined}
                      >
                        {isWinner ? "★ " : ""}
                        {s.label}
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {tab === "overview" && (
                  <>
                    <SectionHeader
                      label="Composite Score"
                      colCount={stats.length}
                    />
                    <Row
                      label="Semantic richness score"
                      values={stats.map((s) => s.composite.semanticRichness)}
                      suffix="/100"
                    />
                    <SectionHeader
                      label="Key Indicators — one per dimension"
                      colCount={stats.length}
                    />
                    <Row
                      label="Heading recall"
                      values={stats.map((s) => s.precisionRecall.headingRecall)}
                      suffix="%"
                    />
                    <Row
                      label="Text coverage"
                      values={stats.map((s) => s.fidelity.textCoverage)}
                      suffix="%"
                    />
                    <Row
                      label="Semantic node ratio"
                      values={stats.map((s) => s.irQuality.semanticNodeRatio)}
                      suffix="%"
                    />
                    <Row
                      label="Legible text fraction"
                      values={stats.map((s) => (s.xr ? s.xr.legibleFraction : "—"))}
                    />
                    <Row
                      label="Total pages"
                      values={stats.map((s) => s.totalPages)}
                      bestIsLow
                    />
                    <Row
                      label="Total pipeline"
                      values={stats.map((s) => s.timing.totalMs)}
                      bestIsLow
                      suffix=" ms"
                    />
                  </>
                )}

                {tab === "diagnostics" && (
                  <>
                {/* Performance */}
                <SectionHeader label="Performance" colCount={stats.length} />
                <Row
                  label="Total pipeline"
                  values={stats.map((s) => s.timing.totalMs)}
                  bestIsLow
                  suffix=" ms"
                />
                <Row
                  indent
                  label="IR parse"
                  values={stats.map((s) => s.timing.parseMs)}
                  bestIsLow
                  suffix=" ms"
                  dim
                />
                <Row
                  indent
                  label="Mapper"
                  values={stats.map((s) => s.timing.mapMs)}
                  bestIsLow
                  suffix=" ms"
                  dim
                />
                <Row
                  indent
                  label="Layout engine"
                  values={stats.map((s) => s.timing.layoutMs)}
                  bestIsLow
                  suffix=" ms"
                  dim
                />
                <Row
                  label="HTML input size"
                  values={stats.map((s) => s.htmlSizeKb)}
                  suffix=" KB"
                />
                  </>
                )}

                {tab === "semantic" && (
                  <>
                {/* Semantic precision & recall */}
                <SectionHeader
                  label="Semantic Precision & Recall (vs HTML)"
                  colCount={stats.length}
                />
                <Row
                  label="Heading recall"
                  values={stats.map((s) => s.precisionRecall.headingRecall)}
                  suffix="%"
                />
                <Row
                  label="Landmark recall"
                  values={stats.map((s) => s.precisionRecall.landmarkRecall)}
                  suffix="%"
                />
                <Row
                  label="Nav region recall"
                  values={stats.map((s) => s.precisionRecall.navRecall)}
                  suffix="%"
                />
                <Row
                  label="Form input recall"
                  values={stats.map((s) => s.precisionRecall.formInputRecall)}
                  suffix="%"
                />
                <Row
                  label="Image recall"
                  values={stats.map((s) => s.precisionRecall.imageRecall)}
                  suffix="%"
                />

                {/* Accessibility preservation */}
                <SectionHeader
                  label="Accessibility Preservation"
                  colCount={stats.length}
                />
                <Row
                  label="aria-labelledby preserved"
                  values={stats.map((s) => s.accessibility.ariaLabelledByRate)}
                  suffix="%"
                />
                <Row
                  label="aria-describedby preserved"
                  values={stats.map((s) => s.accessibility.ariaDescribedByRate)}
                  suffix="%"
                />
                <Row
                  label="Explicit role honor rate"
                  values={stats.map(
                    (s) => s.accessibility.explicitRoleHonorRate,
                  )}
                  suffix="%"
                />
                <Row
                  label="Alt text coverage"
                  values={stats.map((s) => s.accessibility.altTextCoverage)}
                  suffix="%"
                />

                {/* Structure & interaction fidelity */}
                <SectionHeader
                  label="Structure & Interaction"
                  colCount={stats.length}
                />
                <Row
                  label="Interactive affordance preservation"
                  values={stats.map(
                    (s) => s.structuralFidelity.interactiveAffordanceRate,
                  )}
                  suffix="%"
                />
                <Row
                  label="Control label coverage"
                  values={stats.map(
                    (s) => s.structuralFidelity.controlLabelCoverage,
                  )}
                  suffix="%"
                />
                <Row
                  label="Heading hierarchy validity"
                  values={stats.map(
                    (s) => s.structuralFidelity.headingHierarchyValidity,
                  )}
                  suffix="%"
                />
                <Row
                  label="Reading-order fidelity"
                  values={stats.map(
                    (s) => s.structuralFidelity.readingOrderFidelity,
                  )}
                  suffix="%"
                />
                <Row
                  label="Link target retention"
                  values={stats.map((s) => s.structuralFidelity.linkRetention)}
                  suffix="%"
                />
                <Row
                  indent
                  dim
                  label="— navigation links"
                  values={stats.map(
                    (s) => s.structuralFidelity.navLinkRetention,
                  )}
                  suffix="%"
                />
                <Row
                  indent
                  dim
                  label="— inline links"
                  values={stats.map(
                    (s) => s.structuralFidelity.inlineLinkRetention,
                  )}
                  suffix="%"
                />
                <Row
                  label="Table structure preservation"
                  values={stats.map(
                    (s) => s.structuralFidelity.tablePreservation,
                  )}
                  suffix="%"
                />
                <Row
                  label="Media preservation"
                  values={stats.map(
                    (s) => s.structuralFidelity.mediaPreservation,
                  )}
                  suffix="%"
                />

                {/* Information fidelity */}
                <SectionHeader
                  label="Information Fidelity"
                  colCount={stats.length}
                />
                <Row
                  label="Text coverage"
                  values={stats.map((s) => s.fidelity.textCoverage)}
                  suffix="%"
                />
                <Row
                  label="Heading text retention"
                  values={stats.map((s) => s.fidelity.headingTextRetention)}
                  suffix="%"
                />
                <Row
                  label="Nodes per KB"
                  values={stats.map((s) => s.fidelity.nodesPerKb)}
                />
                  </>
                )}

                {tab === "diagnostics" && (
                  <>
                {/* IR Structure */}
                <SectionHeader label="IR Structure" colCount={stats.length} />
                <Row
                  label="IR nodes total"
                  values={stats.map((s) => s.irNodeCount)}
                />
                <Row
                  label="Landmarks"
                  values={stats.map((s) => s.analytics.landmarkCount)}
                />
                <Row
                  label="Headings"
                  values={stats.map((s) => s.analytics.headingCount)}
                />
                <Row
                  label="Sections (regions)"
                  values={stats.map((s) => s.analytics.sectionCount)}
                />
                <Row
                  label="Interactive controls"
                  values={stats.map((s) => s.analytics.controlCount)}
                />
                <Row
                  label="Word count"
                  values={stats.map((s) => s.analytics.wordCount)}
                />
                <Row
                  label="Text length (chars)"
                  values={stats.map((s) => s.analytics.textLength)}
                />
                <Row
                  label="Text density (chars/node)"
                  values={stats.map((s) => Math.round(s.analytics.textDensity))}
                />
                <Row
                  label="Live regions"
                  values={stats.map((s) => s.analytics.liveRegionCount)}
                />
                  </>
                )}

                {tab === "semantic" && (
                  <>
                {/* IR Quality */}
                <SectionHeader
                  label="IR Semantic Quality"
                  colCount={stats.length}
                />
                <Row
                  label="Labeling rate"
                  values={stats.map((s) => s.irQuality.labelingRate)}
                  suffix="%"
                />
                <Row
                  label="Parse confidence rate"
                  values={stats.map((s) => s.irQuality.parseConfidenceRate)}
                  suffix="%"
                />
                <Row
                  label="Avg node confidence"
                  values={stats.map((s) => s.irQuality.avgConfidence)}
                />
                <Row
                  label="Semantic node ratio"
                  values={stats.map((s) => s.irQuality.semanticNodeRatio)}
                  suffix="%"
                />
                <Row
                  label="Generic node ratio"
                  values={stats.map((s) => s.irQuality.genericRatio)}
                  bestIsLow
                  suffix="%"
                />
                <Row
                  label="Content-to-chrome ratio"
                  values={stats.map((s) => s.irQuality.contentToChromeRatio)}
                />
                <Row
                  label="Nodes with ARIA relations"
                  values={stats.map((s) => s.irQuality.nodesWithRelations)}
                />
                <Row
                  label="Max semantic depth"
                  values={stats.map((s) => s.irQuality.maxDepth)}
                />
                <Row
                  label="Avg semantic depth"
                  values={stats.map((s) => s.irQuality.avgDepth)}
                />
                  </>
                )}

                {tab === "diagnostics" && (
                  <>
                {/* Source breakdown */}
                <SectionHeader
                  label="Node Source Breakdown"
                  colCount={stats.length}
                />
                {[
                  "explicit",
                  "structural",
                  "ai",
                  "ai-timeout",
                  "inline",
                  "generic",
                ].map((src) => (
                  <Row
                    key={src}
                    indent
                    label={src}
                    values={stats.map((s) => s.sourceBreakdown[src] ?? 0)}
                  />
                ))}

                {/* XR Primitive types */}
                <SectionHeader
                  label="XR Primitive Types"
                  colCount={stats.length}
                />
                {KEY_PRIMITIVE_TYPES.map((type) => {
                  const vals = stats.map(
                    (s) => s.primitiveTypeBreakdown[type] ?? 0,
                  );
                  if (vals.every((v) => v === 0)) return null;
                  return (
                    <Row
                      key={type}
                      indent
                      label={type}
                      values={vals}
                      dim={vals.every((v) => v < 2)}
                    />
                  );
                })}
                  </>
                )}

                {tab === "xr" && (
                  <>
                {/* XR Usability */}
                <SectionHeader label="XR Usability" colCount={stats.length} />
                <BoolRow
                  label="Content panel present"
                  values={stats.map((s) => s.usability.hasContentPanel)}
                />
                <BoolRow
                  label="TOC / nav available"
                  values={stats.map((s) => s.usability.hasTOC)}
                />
                <Row
                  label="Words per page"
                  values={stats.map((s) => s.usability.wordsPerPage)}
                />
                <Row
                  label="Section granularity"
                  values={stats.map((s) => s.usability.sectionGranularity)}
                />
                <Row
                  label="Semantic diversity"
                  values={stats.map((s) => s.usability.semanticDiversity)}
                  suffix="%"
                />

                {/* XR Layout */}
                <SectionHeader
                  label="XR Layout Output"
                  colCount={stats.length}
                />
                <Row
                  label="Layout template"
                  values={stats.map((s) => s.layoutTemplate)}
                />
                <Row
                  label="Primitives placed"
                  values={stats.map((s) => s.primitiveCount)}
                />
                <Row
                  label="Paginated panels"
                  values={stats.map((s) => s.paginatedPanels)}
                />
                <Row
                  label="Total pages"
                  values={stats.map((s) => s.totalPages)}
                />
                <Row
                  label="Unplaced primitives"
                  values={stats.map((s) => s.unplacedCount)}
                  bestIsLow
                />
                <Row
                  label="Fallback height estimates"
                  values={stats.map((s) => s.fallbackHeightCount)}
                  bestIsLow
                />

                {/* XR Spatial Quality (literature-grounded) */}
                <SectionHeader
                  label="XR Spatial Quality (placed plan)"
                  colCount={stats.length}
                />
                <Row
                  label="Mean text angular size"
                  values={stats.map((s) =>
                    s.xr ? s.xr.meanAngularSizeDeg : "—",
                  )}
                  suffix="°"
                />
                <Row
                  label="Legible text fraction"
                  values={stats.map((s) => (s.xr ? s.xr.legibleFraction : "—"))}
                />
                <Row
                  label="Comfortable text fraction"
                  values={stats.map((s) =>
                    s.xr ? s.xr.comfortableFraction : "—",
                  )}
                />
                <Row
                  label="Comfort envelope coverage"
                  values={stats.map((s) => (s.xr ? s.xr.comfortCoverage : "—"))}
                />
                <Row
                  label="Peripheral panels"
                  values={stats.map((s) =>
                    s.xr ? s.xr.peripheralPanelCount : "—",
                  )}
                  bestIsLow
                />
                <Row
                  label="Main panel FOV fill"
                  values={stats.map((s) => (s.xr ? s.xr.mainPanelFovFill : "—"))}
                />
                <Row
                  label="Page turns to read all"
                  values={stats.map((s) =>
                    s.xr ? s.xr.pageTurnsToReadAll : "—",
                  )}
                  bestIsLow
                />
                <Row
                  label="Reading distance error"
                  values={stats.map((s) =>
                    s.xr ? s.xr.meanReadingDistanceErrorM : "—",
                  )}
                  bestIsLow
                  suffix=" m"
                />
                  </>
                )}

                {tab === "segmentation" && (
                  <>
                    <SectionHeader
                      label="Segmentation Quality — BCubed vs reference (Kiesel CIKM'20)"
                      colCount={stats.length}
                    />
                    <Row
                      label="Segmentation F-measure"
                      values={stats.map((s) => round3(s.segmentation.f))}
                    />
                    <Row
                      label="Segmentation precision"
                      values={stats.map((s) => round3(s.segmentation.precision))}
                    />
                    <Row
                      label="Segmentation recall"
                      values={stats.map((s) => round3(s.segmentation.recall))}
                    />
                    <Row
                      label="Segments produced"
                      values={stats.map((s) => String(s.segmentation.segmentCount))}
                    />
                    <Row
                      label="Aligned units (of reference)"
                      values={stats.map((s) => String(s.segmentation.coveredUnits))}
                    />
                  </>
                )}
              </tbody>
            </table>

            {stats.some((s) => s.error) && (
              <div style={{ marginTop: 14 }}>
                {stats
                  .filter((s) => s.error)
                  .map((s) => (
                    <div
                      key={s.label}
                      style={{
                        color: "#b45309",
                        fontSize: 12,
                        marginBottom: 4,
                      }}
                    >
                      {s.label}: {s.error}
                    </div>
                  ))}
              </div>
            )}

            <div
              style={{
                marginTop: 20,
                paddingTop: 14,
                borderTop: "1px solid #eef0f3",
                fontSize: 11,
                color: "#9aa3af",
                lineHeight: 1.9,
              }}
            >
              <span style={{ color: "#16a34a" }}>■</span> best in row &nbsp;
              <span style={{ color: "#d97706" }}>■</span> worst in row &nbsp;·&nbsp;
              <span style={{ color: "#16a34a" }}>★</span> highest semantic
              richness &nbsp;·&nbsp; Hover{" "}
              <span style={{ color: "#b7bcc6" }}>ⓘ</span> on any metric for an
              explanation &nbsp;·&nbsp; Recall metrics are vs raw HTML DOM counts
              &nbsp;·&nbsp; Device profile: Quest 3
            </div>
          </>
        )}
        </div>
      </div>
    </div>
  );
}
