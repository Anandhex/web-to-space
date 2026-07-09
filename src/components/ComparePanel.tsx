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

  const copyMarkdown = useCallback(() => {
    if (!stats || !gt) return;
    navigator.clipboard.writeText(buildMarkdownTable(stats, gt)).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [stats, gt]);

  return (
    <div
      style={{
        position: "fixed",
        top: "50%",
        left: "50%",
        transform: "translate(-50%, -50%)",
        width: "min(1020px, 96vw)",
        maxHeight: "90vh",
        overflowY: "auto",
        background: "rgba(6,10,18,0.98)",
        border: "1px solid rgba(88,166,255,0.18)",
        borderRadius: 12,
        boxShadow: "0 24px 80px rgba(0,0,0,0.8)",
        backdropFilter: "blur(24px)",
        WebkitBackdropFilter: "blur(24px)",
        zIndex: 99999,
        fontFamily: "system-ui, -apple-system, sans-serif",
      }}
    >
      {/* Sticky header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "13px 18px",
          borderBottom: "1px solid rgba(30,45,61,0.6)",
          position: "sticky",
          top: 0,
          background: "rgba(6,10,18,0.98)",
          zIndex: 1,
        }}
      >
        <div>
          <span style={{ color: "#58a6ff", fontWeight: 600, fontSize: 14 }}>
            Parser Comparison
          </span>
          <span
            style={{
              color: "#2a4a6a",
              fontSize: 11,
              marginLeft: 12,
              fontFamily: "monospace",
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
                background: copied
                  ? "rgba(78,201,102,0.12)"
                  : "rgba(30,45,61,0.5)",
                border: `1px solid ${copied ? "rgba(78,201,102,0.4)" : "rgba(30,45,61,0.6)"}`,
                borderRadius: 6,
                color: copied ? "#4ec966" : "#7a8a9a",
                fontSize: 12,
                padding: "4px 12px",
                cursor: "pointer",
                fontFamily: "monospace",
              }}
            >
              {copied ? "✓ Copied!" : "Copy as Markdown"}
            </button>
          )}
          <button
            onClick={runAll}
            disabled={running}
            style={{
              background: "rgba(88,166,255,0.10)",
              border: "1px solid rgba(88,166,255,0.22)",
              borderRadius: 6,
              color: "#58a6ff",
              fontSize: 12,
              padding: "4px 12px",
              cursor: running ? "default" : "pointer",
              opacity: running ? 0.5 : 1,
            }}
          >
            {running ? "Running…" : "Re-run"}
          </button>
          <button
            onClick={onClose}
            style={{
              background: "none",
              border: "none",
              color: "#3a4a5a",
              fontSize: 18,
              cursor: "pointer",
              lineHeight: 1,
              padding: "0 4px",
            }}
          >
            ✕
          </button>
        </div>
      </div>

      <div style={{ padding: "12px 18px 24px" }}>
        {running && (
          <div
            style={{
              color: "#58a6ff",
              fontSize: 13,
              textAlign: "center",
              padding: "40px 0",
            }}
          >
            <div style={{ marginBottom: 10 }}>
              Running all backends in parallel…
            </div>
            <div
              style={{
                fontSize: 11,
                color: "#2a4a6a",
                fontFamily: "monospace",
              }}
            >
              Custom · Readability · Naive · VIPS
            </div>
          </div>
        )}

        {stats && gt && (
          <>
            <GroundTruthBar gt={gt} />

            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  <th
                    style={{
                      textAlign: "left",
                      padding: "5px 10px",
                      color: "#2a4060",
                      fontSize: 10,
                      fontWeight: 600,
                      borderBottom: "2px solid rgba(30,45,61,0.8)",
                      textTransform: "uppercase",
                      letterSpacing: "0.06em",
                    }}
                  >
                    Metric
                  </th>
                  {stats.map((s) => (
                    <th
                      key={s.label}
                      style={{
                        textAlign: "right",
                        padding: "5px 10px",
                        color: "#58a6ff",
                        fontSize: 11,
                        fontWeight: 600,
                        borderBottom: "2px solid rgba(30,45,61,0.8)",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {s.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {/* Composite */}
                <SectionHeader
                  label="Composite Score"
                  colCount={stats.length}
                />
                <Row
                  label="Semantic richness score"
                  values={stats.map((s) => s.composite.semanticRichness)}
                  suffix="/100"
                />

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
              </tbody>
            </table>

            {stats.some((s) => s.error) && (
              <div style={{ marginTop: 12 }}>
                {stats
                  .filter((s) => s.error)
                  .map((s) => (
                    <div
                      key={s.label}
                      style={{
                        color: "#f6a623",
                        fontSize: 11,
                        fontFamily: "monospace",
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
                marginTop: 14,
                fontSize: 10,
                color: "#1e2e3e",
                lineHeight: 1.8,
              }}
            >
              <span style={{ color: "#4ec966" }}>■</span> best &nbsp;
              <span style={{ color: "#f6a623" }}>■</span> worst &nbsp;·&nbsp;
              Hover <span style={{ color: "#2a4a6a" }}>ⓘ</span> on any metric
              for an explanation &nbsp;·&nbsp; Recall metrics are vs raw HTML
              DOM counts (no manual annotation required) &nbsp;·&nbsp; Timing
              via <code style={{ color: "#2a4a6a" }}>performance.now()</code>{" "}
              &nbsp;·&nbsp; Device profile: Quest 3
            </div>
          </>
        )}
      </div>
    </div>
  );
}
