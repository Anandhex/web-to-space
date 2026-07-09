/**
 * primitives/meshes/inline-mesh.tsx
 *
 * Standalone inline meshes: XRTextMesh and XRLinkMesh — used when a text or
 * link primitive is rendered on its own rather than flowed inside a prose row.
 */
import React, { useContext } from "react";

import type { LayoutEntry } from "../../../layout/types";
import {
  mergeAdjacentTextRuns,
  isInlinePrimitive,
  flattenInlineWrappers,
} from "../../../layout/utils";
import { useTheme } from "../../theme";
import { safeDim, entryTransform, useHoverScale } from "../surface";
import {
  useRenderMetrics,
  TextStyleContext,
  NavigateContext,
} from "../contexts";
import {
  ClippedText,
  buildInlineRows,
  InlineProseRows,
} from "../inline";

export interface XRTextMeshProps {
  primitive: import("../../../mapper/types").XRText;
  entry: LayoutEntry;
}

/**
 * XRTextMesh renders a single text node.
 *
 * Text nodes are atomic - they represent a single text run with optional
 * semantic formatting (em, strong, code, etc.).
 *
 * The componentType determines the visual styling:
 * - "strong" / "b": bold
 * - "em" / "i": italic
 * - "code": monospace
 * - "span": plain text (default)
 * - "text": plain text (default)
 */
export function XRTextMesh({ primitive, entry }: XRTextMeshProps) {
  const { pos, rot } = entryTransform(entry);
  const theme = useTheme();
  const w = safeDim(entry.size.width);
  const metrics = useRenderMetrics();
  // An ancestor (e.g. XRHeadingMesh) may override the metric this text run
  // renders with — see TextStyleContext. Falls back to paragraph metrics,
  // matching estimateHeight()'s default for a standalone XRText.
  const styleOverride = useContext(TextStyleContext);
  const textMetric = styleOverride ?? metrics.paragraph;

  // Determine styling based on component type and/or the accumulated
  // styleTags stack (e.g. <i><b>text</b></i> produces componentType: null,
  // styleTags: ["i", "b"] — a single componentType string can't represent
  // two simultaneous styles, so we OR both signals in rather than treating
  // componentType as the only source of truth).
  const componentType = primitive.componentType || "text";
  const styleTags = primitive.styleTags ?? [];
  const isBold =
    componentType === "strong" ||
    componentType === "b" ||
    styleTags.includes("strong") ||
    styleTags.includes("b");
  const isItalic =
    componentType === "em" ||
    componentType === "i" ||
    styleTags.includes("em") ||
    styleTags.includes("i");

  let fontWeight: string | number = isBold ? "700" : "400";
  let fontStyle: "normal" | "italic" = isItalic ? "italic" : "normal";
  let color = isBold || isItalic ? theme.headingCol : theme.bodyCol;

  switch (componentType) {
    case "code":
      fontWeight = "500";
      color = "#116329";
      break;
    case "link":
      color = theme.accentCol;
      fontWeight = "500";
      break;
    default:
      // bold/italic/color already resolved above from isBold/isItalic;
      // nothing else to do for 'text' / 'span' / unknown.
      break;
  }

  return (
    <group position={pos} rotation={rot}>
      <ClippedText
        anchorX="left"
        anchorY="top"
        position={[0, 0, 0.002]}
        fontSize={textMetric.fontSize}
        color={color}
        fontWeight={fontWeight}
        fontStyle={fontStyle}
        maxWidth={w}
        lineHeight={textMetric.lineHeightRatio}
        letterSpacing={0.005}
      >
        {primitive.text}
      </ClippedText>
    </group>
  );
}

// primitives.tsx - Add XRLinkMesh

export interface XRLinkMeshProps {
  primitive: import("../../../mapper/types").XRLink;
  entry: LayoutEntry;
  renderChild: (primitiveId: string) => React.ReactNode;
}

/**
 * XRLinkMesh renders a link's text content inline.
 *
 * When the link has children (synthetic XRLink leaf from normalizeSceneLabels,
 * or real mixed XRText/XRLink children), they are flowed via InlineProseRows.
 * XRLink segments in buildRowMeta automatically receive the theme's accent
 * colour, so a synthetic XRLink child renders in link colour with no extra
 * wiring needed.
 *
 * Label-only fallback (no children after normalization) renders via ClippedText.
 */
export function XRLinkMesh({ primitive, entry, renderChild }: XRLinkMeshProps) {
  const { pos, rot } = entryTransform(entry);
  const w = safeDim(entry.size.width);
  const metrics = useRenderMetrics();
  const theme = useTheme();
  const accentHex = parseInt(theme.accentCol.replace("#", ""), 16);
  const styleOverride = useContext(TextStyleContext);
  const linkMetric = styleOverride ?? metrics.link.font;
  const { ref, handlers } = useHoverScale(1.0, 1.02);
  const navigate = useContext(NavigateContext);

  const flatChildren = flattenInlineWrappers(primitive.children ?? []);
  const hasInlineChildren = flatChildren.some((c) => isInlinePrimitive(c.type));
  const rows = hasInlineChildren
    ? buildInlineRows(mergeAdjacentTextRuns(flatChildren))
    : [];

  const clickHandler =
    primitive.href && navigate
      ? {
          onClick: (e: { stopPropagation: () => void }) => {
            e.stopPropagation();
            navigate(primitive.href!);
          },
        }
      : {};

  return (
    <group
      ref={ref}
      position={pos}
      rotation={rot}
      {...handlers}
      {...clickHandler}
    >
      {hasInlineChildren ? (
        <InlineProseRows
          rows={rows}
          startY={0}
          panelWidth={w}
          fontSize={linkMetric.fontSize}
          lineHeightRatio={linkMetric.lineHeightRatio}
          xInset={0}
          renderChild={renderChild}
          forceColor={accentHex}
        />
      ) : (
        <ClippedText
          anchorX="left"
          anchorY="top"
          position={[0, 0, 0.002]}
          fontSize={linkMetric.fontSize}
          color={primitive.isCurrent ? theme.headingCol : theme.accentCol}
          fontWeight={primitive.isCurrent ? "700" : "500"}
          maxWidth={w}
          lineHeight={linkMetric.lineHeightRatio}
        >
          {primitive.label ?? primitive.href ?? ""}
        </ClippedText>
      )}
    </group>
  );
}
