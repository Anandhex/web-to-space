/**
 * primitives/meshes/block.tsx
 *
 * Block-level text content meshes: headings, paragraphs, sections, code blocks,
 * blockquotes, separators and progress bars. These share the inline-prose flow
 * system and the Surface card.
 */
import React from "react";

import type { XRHeading, XRParagraph, XRSection } from "../../../mapper/types";
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
  RENDER_ORDER_ACCENT,
  RENDER_ORDER_TEXT,
  Z_CURVE_CONTENT_BASE_LIFT,
} from "../constants";
import {
  Surface,
  safeDim,
  entryTransform,
  headingWeight,
  resolveHeadingMetric,
} from "../surface";
import { useClipPlanes, useRenderMetrics } from "../contexts";
import { usePanelCurve } from "../curve";
import { ClippedText, buildInlineRows, InlineProseRows } from "../inline";

// ─────────────────────────────────────────────────────────────
// 1. XRHeadingMesh
// ─────────────────────────────────────────────────────────────

export interface XRHeadingMeshProps {
  primitive: XRHeading;
  entry: LayoutEntry;
  renderChild: (primitiveId: string) => React.ReactNode;
}

/**
 * Floating text billboard for headings.
 *
 * Renders the heading as a world-space troika Text node with no backing panel
 * for H1–H2 (they stand alone as large anchors) and a subtle underline
 * accent bar for H3–H6.
 *
 * The text is anchored top-left so vertical stacking from the layout engine
 * is consistent: position.y is the top edge of the text.
 */
export function XRHeadingMesh({
  primitive,
  entry,
  renderChild,
}: XRHeadingMeshProps) {
  const { pos, rot } = entryTransform(entry);
  const clips = useClipPlanes();
  const theme = useTheme();
  const metrics = useRenderMetrics();
  const headingMetric = resolveHeadingMetric(primitive.level, metrics);
  const fontSize = headingMetric.fontSize;
  const showAccent = primitive.level >= 3;

  const hasTextChildren = primitive.children.some(
    (child) =>
      child.type === "XRText" ||
      child.type === "XRLink" ||
      child.type === "XRButton",
  );
  if (hasTextChildren) {
    // Inline children (XRText, XRLink) are flowed as a prose run — they are
    // NOT dispatched through renderChild/PrimitiveDispatcher since the engine
    // does not stamp plan entries for inline children of inline-owning nodes.
    const flattened = flattenInlineWrappers(
      mergeAdjacentTextRuns(primitive.children as any[]) as any[],
    );
    const rows = buildInlineRows(flattened);
    return (
      <group position={pos} rotation={rot}>
        <InlineProseRows
          rows={rows}
          startY={0}
          panelWidth={entry.size.width}
          fontSize={fontSize}
          lineHeightRatio={headingMetric.lineHeightRatio}
          xInset={0}
          renderChild={renderChild}
        />
      </group>
    );
  }

  return (
    <group position={pos} rotation={rot}>
      <ClippedText
        anchorX="left"
        anchorY="top"
        position={[0, 0, 0.001]}
        fontSize={fontSize}
        color={theme.headingCol}
        font={undefined}
        fontWeight={headingWeight(primitive.level)}
        maxWidth={entry.size.width}
        lineHeight={headingMetric.lineHeightRatio}
        letterSpacing={-0.01}
        outlineWidth={0}
      >
        {primitive.content ?? primitive.label ?? ""}
      </ClippedText>

      {/* Accent underline for H3+ */}
      {showAccent && (
        <mesh position={[entry.size.width * 0.5, -fontSize * 1.35, 0]}>
          <planeGeometry args={[entry.size.width, 0.002]} />
          <meshBasicMaterial
            color={theme.accentCol}
            transparent
            opacity={0.5}
            clippingPlanes={clips}
          />
        </mesh>
      )}
      {primitive.children.map((child) => renderChild(child.id))}
    </group>
  );
}

// ─────────────────────────────────────────────────────────────
// Shared inline prose utilities
// Used by XRParagraphMesh and XRListItemMesh — must stay in sync
// with engine.ts's estimateInlineFlowHeight + flattenInlineWrappers.
// ─────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────
// 2. XRParagraphMesh
// ─────────────────────────────────────────────────────────────

export interface XRParagraphMeshProps {
  primitive: XRParagraph;
  entry: LayoutEntry;
  renderChild: (primitiveId: string) => React.ReactNode;
  /** Returns the layout entry for a direct child by id, or null if not found. */
  getChildEntry?: (childId: string) => LayoutEntry | null;
}

/**
 * Multi-line body text rendered on a matte beveled panel.
 *
 * Dense paragraphs (densityScore > 0.6) receive a slightly larger panel
 * with a faint top-edge glow to signal long-form reading mode.\
 * Short snippets (≤ 10 words) skip the backing panel entirely.
 */
export function XRParagraphMesh({
  primitive,
  entry,
  renderChild,
}: XRParagraphMeshProps) {
  const { pos, rot } = entryTransform(entry);
  const clips = useClipPlanes();
  const theme = useTheme();
  const w = safeDim(entry.size.width);
  const h = safeDim(entry.size.height);
  const metrics = useRenderMetrics();

  // FIX: flatten transparent XRGenericPanel wrappers (e.g. a <span title="…">
  // around a link/text run) BEFORE checking for inline content. Previously
  // this check ran against the unflattened `primitive.children`, so a
  // paragraph whose only "inline-looking" content was wrapped one level
  // deeper (XRGenericPanel → XRLink) registered as having zero inline
  // children, skipped the InlineProseRows flow path entirely, and fell
  // through to the block-stacked fallback below.
  const flatForInlineCheck = flattenInlineWrappers(primitive.children ?? []);
  const hasAnyInlineChild = flatForInlineCheck.some((c) =>
    isInlinePrimitive(c.type),
  );
  // ── Mixed / pure-inline children: flow layout ────────────────────────────
  // Merge adjacent plain-text XRText siblings so fragmented runs like
  //   ["This page was last edited on ", "20 June 2026", " (UTC)."]
  // collapse into one <Text> call with the correct word-count.
  //
  // Scan the merged list left-to-right:
  //   • Consecutive inline primitives (XRText, XRLink, XRButton) are
  //     accumulated into a single text string and rendered as one <Text>
  //     node anchored top-left at the current cursor Y.
  //   • Block primitives (XRImage, XRFigure, or any unknown type) flush
  //     the current inline run, then render the block via renderChild at
  //     the cursor Y so it gets the block's layout-plan position.
  if (hasAnyInlineChild) {
    const mergedChildren = mergeAdjacentTextRuns(flatForInlineCheck);
    const rows = buildInlineRows(mergedChildren);
    const m = metrics.paragraph;

    return (
      <group position={pos} rotation={rot}>
        <InlineProseRows
          rows={rows}
          startY={-m.verticalPadding / 2}
          panelWidth={w}
          fontSize={m.fontSize}
          lineHeightRatio={m.lineHeightRatio}
          renderChild={renderChild}
        />
      </group>
    );
  }

  const skipPanel = primitive.wordCount <= 10;

  return (
    <group position={pos} rotation={rot}>
      {/* Backing panel — flat Horizon card with a subtle top-lighter gradient */}
      {!skipPanel && (
        <Surface
          width={w}
          height={h}
          color={theme.panelBg}
          gradient
          clips={clips}
        />
      )}

      {/* Body text - only render content directly if no text children */}
      <ClippedText
        anchorX="left"
        anchorY="top"
        position={[0.02, -0.018, Z_LAYER_BODY_TEXT]}
        renderOrder={RENDER_ORDER_TEXT}
        fontSize={0.026}
        color={theme.bodyCol}
        maxWidth={w - 0.04}
        lineHeight={1.55}
        letterSpacing={0.005}
      >
        {primitive.content ?? primitive.label ?? ""}
      </ClippedText>

      {/* Any non-text children (images, lists, etc.) — dispatched as true
          siblings at their own absolute positions; renderOrder on this
          paragraph's own text above ensures it never renders behind a
          same-depth image child regardless of THREE's transparent draw
          order sort. */}
      {primitive.children.map((child) => renderChild(child.id))}
    </group>
  );
}

// ─────────────────────────────────────────────────────────────
// 3. XRSectionMesh
// ─────────────────────────────────────────────────────────────

export interface XRSectionMeshProps {
  primitive: XRSection;
  entry: LayoutEntry;
  /**
   * Resolved child entries for the children visible on the current page.
   * The renderer passes only entries whose pageIndex matches the current page
   * (or all entries when the section fits on one page). Used solely to compute
   * the correct backing panel height — the section must not be taller than
   * its visible content.
   */
  childEntries: LayoutEntry[];
  /** Renderer for child primitives — injected by XRSceneRenderer. */
  renderChild: (primitiveId: string) => React.ReactNode;
  /**
   * True when this section is a mid-section continuation (its first child is
   * on a later page index than the section itself). Drives the top-edge
   * "continued from" accent stripe.
   */
  isContinuation?: boolean;
  /**
   * True when this section overflows onto a subsequent page. Drives the
   * bottom-edge "continues on" accent stripe.
   */
  hasMore?: boolean;
}

/**
 * Translucent bounding panel for a section.
 *
 * Purely a spatial container: draws a frosted backing panel sized to the
 * visible child content and delegates all child rendering to the injected
 * renderChild. Child positions are resolved by the layout engine; this
 * component does not re-layout them.
 *
 * Panel height is derived from childEntries (the current page's visible
 * children) rather than entry.size.height, because entry.size.height is
 * the full section height across all pages. The renderer passes only the
 * entries whose pageIndex matches the current page.
 *
 * Continuation indicators (thin accent stripes) are shown at the top/bottom
 * edges when the section spans multiple pages, driven by the isContinuation
 * and hasMore props computed by the renderer.
 */
export function XRSectionMesh({
  primitive,
  entry,
  childEntries,
  renderChild,
  isContinuation,
}: XRSectionMeshProps) {
  const { pos, rot } = entryTransform(entry);
  const clips = useClipPlanes();
  const theme = useTheme();
  const w = safeDim(entry.size.width);

  // Panel height = span from the top of the first visible child to the
  // bottom of the last, read from their real engine-assigned positions —
  // not reconstructed from hardcoded padding/gap constants, which drift out
  // of sync with the engine's actual values (e.g. when a nested section's
  // own top/bottom padding is zero) and leave a dead gap or an oversized box.
  const visibleHeight =
    childEntries.length > 0
      ? childEntries[0].position.y -
        (childEntries[childEntries.length - 1].position.y -
          childEntries[childEntries.length - 1].size.height)
      : entry.size.height;

  const h = safeDim(visibleHeight);

  return (
    <group position={pos} rotation={rot}>
      {/* Section backing — a single flat fill. Sections nest inside the main
          content panel (which already carries the border/gradient "hero"
          treatment — see PanelBacking), so every section does NOT repeat
          that same border+gradient+highlight stack: a document with a dozen
          short sections on one page previously stacked a dozen near-
          identical 4-layer glass slabs at nearly the same Z depth, reading
          as a solid "brick" when viewed edge-on. One flat layer per section
          keeps nested containers visually quiet and avoids that compounding. */}
      <Surface width={w} height={h} color={theme.panelBg} clips={clips} />

      {/* "Continued from previous page" top edge indicator */}
      {isContinuation && (
        <mesh
          position={[w / 2, -0.001, Z_LAYER_ACCENT]}
          renderOrder={RENDER_ORDER_ACCENT}
        >
          <planeGeometry args={[w * 0.4, 0.003]} />
          <meshBasicMaterial
            color={theme.accentCol}
            transparent
            opacity={0.5}
            clippingPlanes={clips}
          />
        </mesh>
      )}

      {primitive.children.map((child) => renderChild(child.id))}
    </group>
  );
}

// ─────────────────────────────────────────────────────────────
// 4. XRNavigationMesh
// ─────────────────────────────────────────────────────────────

export interface XRCodeBlockMeshProps {
  primitive: import("../../../mapper/types").XRCodeBlock;
  entry: LayoutEntry;
  renderChild: (primitiveId: string) => React.ReactNode;
}

export function XRCodeBlockMesh({
  primitive,
  entry,
  renderChild,
}: XRCodeBlockMeshProps) {
  const { pos, rot } = entryTransform(entry);
  const clips = useClipPlanes();
  const theme = useTheme();
  const w = safeDim(entry.size.width);
  const h = safeDim(entry.size.height);
  const CODE_BG = theme.inputBg;
  const CODE_COL = "#116329";

  // Mirrors XRBlockQuoteMesh: children extracted by the parser (e.g. a
  // synthetic text run, or block-level content) were previously discarded
  // by the mapper (children: [] hardcoded) — now that they're preserved,
  // flow inline children through InlineProseRows and let block-only
  // children be dispatched externally as siblings (see the "XRCodeBlock"
  // case in XRSceneRenderer.tsx) rather than duplicating them here.
  const flatChildren = flattenInlineWrappers(primitive.children ?? []);
  const hasAnyInlineChild = flatChildren.some((c) => isInlinePrimitive(c.type));
  const hasAnyChildren = (primitive.children ?? []).length > 0;
  const rows = hasAnyInlineChild
    ? buildInlineRows(mergeAdjacentTextRuns(flatChildren))
    : [];

  return (
    <group position={pos} rotation={rot}>
      <Surface
        width={w}
        height={h}
        color={CODE_BG}
        rimColor={theme.panelRim}
        clips={clips}
      />

      {/* Left accent stripe */}
      <mesh
        position={[0.005, -h / 2, Z_LAYER_ACCENT]}
        renderOrder={RENDER_ORDER_ACCENT}
      >
        <planeGeometry args={[0.007, h * 0.85]} />
        <meshBasicMaterial
          color={CODE_COL}
          transparent
          opacity={0.75}
          clippingPlanes={clips}
        />
      </mesh>

      {hasAnyInlineChild ? (
        <InlineProseRows
          rows={rows}
          startY={-0.014}
          panelWidth={w - 0.018}
          fontSize={0.02}
          lineHeightRatio={1.6}
          xInset={0.018}
          renderChild={renderChild}
        />
      ) : hasAnyChildren ? null : ( // the caller — render nothing here to avoid duplicating content. // Block-only children are dispatched as true positioned siblings by
        <ClippedText
          anchorX="left"
          anchorY="top"
          position={[0.018, -0.014, Z_LAYER_BODY_TEXT]}
          renderOrder={RENDER_ORDER_TEXT}
          fontSize={0.02}
          color={CODE_COL}
          maxWidth={w - 0.03}
          lineHeight={1.6}
          letterSpacing={0.02}
        >
          {primitive.content ?? primitive.label ?? ""}
        </ClippedText>
      )}
    </group>
  );
}

// ─────────────────────────────────────────────────────────────
// 7. XRBlockQuoteMesh
// ─────────────────────────────────────────────────────────────

export interface XRBlockQuoteMeshProps {
  primitive: import("../../../mapper/types").XRBlockQuote;
  entry: LayoutEntry;
  renderChild: (primitiveId: string) => React.ReactNode;
}

export function XRBlockQuoteMesh({
  primitive,
  entry,
  renderChild,
}: XRBlockQuoteMeshProps) {
  const { pos, rot } = entryTransform(entry);
  const clips = useClipPlanes();
  const theme = useTheme();
  const w = safeDim(entry.size.width);
  const h = safeDim(entry.size.height);
  const metrics = useRenderMetrics();
  const QUOTE_ACCENT = "#d2a679";

  // Hatnotes (role="note" → XRBlockQuote) arrive with inline children:
  //   [XRText("Main article: "), XRLink("KPop Demon Hunters (soundtrack)")]
  // Without this path XRBlockQuoteMesh rendered only primitive.label
  // ("Main article:") and silently discarded all children — exactly the
  // same leaf-only pattern that bit XRAlertMesh.  Apply the same fix:
  // flatten wrappers → merge adjacent text → flow via InlineProseRows so
  // link segments get accent colouring.
  const flatChildren = flattenInlineWrappers(primitive.children ?? []);
  const hasAnyInlineChild = flatChildren.some((c) => isInlinePrimitive(c.type));
  const hasAnyChildren = (primitive.children ?? []).length > 0;
  const rows = hasAnyInlineChild
    ? buildInlineRows(mergeAdjacentTextRuns(flatChildren))
    : [];
  const m = metrics.blockQuote ?? metrics.paragraph;
  const X_INSET = 0.026;

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

      {/* Left quote accent bar */}
      <mesh
        position={[0.006, -h / 2, Z_LAYER_ACCENT]}
        renderOrder={RENDER_ORDER_ACCENT}
      >
        <planeGeometry args={[0.01, h * 0.8]} />
        <meshBasicMaterial
          color={QUOTE_ACCENT}
          transparent
          opacity={0.9}
          clippingPlanes={clips}
        />
      </mesh>

      {hasAnyInlineChild ? (
        // Inline flow: "Main article: " (body colour) + link (accent colour)
        // rendered as a single prose run, matching what the engine measured.
        <InlineProseRows
          rows={rows}
          startY={-0.018}
          panelWidth={w - X_INSET}
          fontSize={m.fontSize}
          lineHeightRatio={m.lineHeightRatio}
          xInset={X_INSET}
          clearCurvedBacking
          renderChild={renderChild}
        />
      ) : hasAnyChildren ? null : ( // their content via the text fallback below. // XRSceneRenderer.tsx) — render nothing here to avoid duplicating // positioned siblings by the caller (see the "XRBlockQuote" case in // Block-only children (e.g. a wrapped <p>) are dispatched as true
        // Fallback: plain blockquote with no structured children.
        // Use content (full visible string) in preference to label (may be
        // the accessible short-name only, e.g. "Main article:").
        <ClippedText
          anchorX="left"
          anchorY="top"
          position={[X_INSET, -0.018, Z_LAYER_BODY_TEXT]}
          renderOrder={RENDER_ORDER_TEXT}
          fontSize={0.024}
          color="#8B6D3F"
          maxWidth={w - 0.04}
          lineHeight={1.5}
          letterSpacing={0.003}
          clearCurvedBacking
        >
          {primitive.content ?? primitive.label ?? ""}
        </ClippedText>
      )}
    </group>
  );
}

// ─────────────────────────────────────────────────────────────
// 8. XRSeparatorMesh
// ─────────────────────────────────────────────────────────────

export interface XRSeparatorMeshProps {
  primitive: import("../../../mapper/types").XRSeparator;
  entry: LayoutEntry;
}

export function XRSeparatorMesh({ primitive, entry }: XRSeparatorMeshProps) {
  const { pos, rot } = entryTransform(entry);
  const clips = useClipPlanes();
  const theme = useTheme();
  const curve = usePanelCurve();
  const w = safeDim(entry.size.width);
  const h = safeDim(entry.size.height);
  const isHoriz = primitive.orientation !== "vertical";

  // Render the rule as a thin <Surface> so it BENDS onto the panel cylinder
  // instead of staying a flat chord that the curved backing bulges in front of
  // (which hid the line). On a curved panel also nudge it forward by the same
  // base clearance the text uses so it reads just in front of the backing; on a
  // flat panel it sits on the shared accent Z band as before.
  const zPos = Z_LAYER_ACCENT + (curve ? Z_CURVE_CONTENT_BASE_LIFT : 0);

  return (
    <group position={pos} rotation={rot}>
      <Surface
        width={isHoriz ? w : 0.002}
        height={isHoriz ? 0.002 : h}
        radius={0.0005}
        color={theme.panelRim}
        opacity={0.6}
        flat
        z={zPos}
        clips={clips}
      />
    </group>
  );
}

// ─────────────────────────────────────────────────────────────
// 9. XRProgressBarMesh
// ─────────────────────────────────────────────────────────────

export interface XRProgressBarMeshProps {
  primitive: import("../../../mapper/types").XRProgressBar;
  entry: LayoutEntry;
}

export function XRProgressBarMesh({
  primitive,
  entry,
}: XRProgressBarMeshProps) {
  const { pos, rot } = entryTransform(entry);
  const clips = useClipPlanes();
  const theme = useTheme();
  const w = safeDim(entry.size.width);
  const h = safeDim(entry.size.height);
  const fraction = Math.max(0, Math.min(1, primitive.valueFraction ?? 0));
  const fillW = Math.max(0.001, w * fraction);
  const TRACK_H = Math.min(0.018, h);

  return (
    <group position={pos} rotation={rot}>
      <mesh position={[w / 2, -h / 2, 0]}>
        <planeGeometry args={[w, TRACK_H]} />
        <meshBasicMaterial
          color={theme.panelRim}
          transparent
          opacity={0.5}
          clippingPlanes={clips}
        />
      </mesh>

      {/* Monochrome fill (matches the Horizon UI Set's Slider reference —
          white/light track fill in dark theme, not a blue accent). */}
      <mesh position={[fillW / 2, -h / 2, 0.001]}>
        <planeGeometry args={[fillW, TRACK_H]} />
        <meshBasicMaterial
          color={theme.emphasisCol}
          transparent
          opacity={0.85}
          clippingPlanes={clips}
        />
      </mesh>

      {primitive.label && (
        <ClippedText
          anchorX="left"
          anchorY="bottom"
          position={[0, -h / 2 + TRACK_H / 2 + 0.006, 0.002]}
          fontSize={0.018}
          color={theme.bodyCol}
          maxWidth={w}
        >
          {primitive.label}
        </ClippedText>
      )}
    </group>
  );
}

// ─────────────────────────────────────────────────────────────
// 10. XRImageMesh
// ─────────────────────────────────────────────────────────────
