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
import { useLinkBinding, usePageLinks } from "../../scene/contexts";
import { MARK_SEPARATOR, markFor } from "../../../links/direction";
import {
  ClippedText,
  buildInlineRows,
  InlineProseRows,
  useLinkRects,
} from "../inline";

interface XRTextMeshProps {
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
      // No blue text (docs/directional-links.md). A text run that came from
      // inside an anchor is still prose; what marks it as leading somewhere is
      // the anchor's own directional mark, drawn by XRLinkMesh below.
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

interface XRLinkMeshProps {
  primitive: import("../../../mapper/types").XRLink;
  entry: LayoutEntry;
  renderChild: (primitiveId: string) => React.ReactNode;
}

/**
 * XRLinkMesh renders a link's text content inline.
 *
 * When the link has children (synthetic XRLink leaf from normalizeSceneLabels,
 * or real mixed XRText/XRLink children), they are flowed via InlineProseRows,
 * which draws each anchor in body colour with its directional mark after it.
 *
 * Label-only fallback (no children after normalization) renders via ClippedText.
 */
export function XRLinkMesh({ primitive, entry, renderChild }: XRLinkMeshProps) {
  const { pos, rot } = entryTransform(entry);
  const w = safeDim(entry.size.width);
  const metrics = useRenderMetrics();
  const theme = useTheme();
  const styleOverride = useContext(TextStyleContext);
  const linkMetric = styleOverride ?? metrics.link.font;
  const { ref, handlers } = useHoverScale(1.0, 1.02);
  const navigate = useContext(NavigateContext);

  // Directional marks (docs/directional-links.md, Phase 4). A link drawn on
  // its own — a nav card, a link card — is still an anchor and still carries
  // the legend, so it is marked exactly as one inside a paragraph is. No
  // accent colour and no underline: what says "this leads somewhere" is the
  // mark's orientation, and where it leads is the door it opens.
  const pageLinks = usePageLinks();
  const { lit, setLit } = useLinkBinding();
  const isLit = lit !== null && lit === primitive.id;
  const direction = pageLinks?.directionOf(primitive.id) ?? null;
  const mark = direction ? MARK_SEPARATOR + markFor(direction) : "";

  // The whole label plus its mark is one link run: one range covering the
  // string troika is handed, which useLinkRects turns into per-line rects.
  const linkText = (primitive.label ?? primitive.href ?? "") + mark;
  const linkRanges = React.useMemo(
    () =>
      primitive.href
        ? [
            {
              start: 0,
              end: linkText.length,
              href: primitive.href,
              label: linkText,
              id: primitive.id,
            },
          ]
        : [],
    [primitive.href, primitive.id, linkText],
  );
  const { handleSync, hitQuads } = useLinkRects(linkRanges, 0, 0);

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
        // No forceColor: the run's own segments carry the marks and take body
        // colour, the same as prose anywhere else.
        <InlineProseRows
          rows={rows}
          startY={0}
          panelWidth={w}
          fontSize={linkMetric.fontSize}
          lineHeightRatio={linkMetric.lineHeightRatio}
          xInset={0}
          renderChild={renderChild}
        />
      ) : (
        <>
          <ClippedText
            anchorX="left"
            anchorY="top"
            position={[0, 0, 0.002]}
            fontSize={linkMetric.fontSize}
            color={
              primitive.isCurrent || isLit ? theme.headingCol : theme.bodyCol
            }
            fontWeight={primitive.isCurrent ? "700" : "500"}
            maxWidth={w}
            lineHeight={linkMetric.lineHeightRatio}
            onSync={linkText ? handleSync : undefined}
          >
            {linkText}
          </ClippedText>
          {/* Hit quads. They exist here for the gaze binding as much as for
              the click: lighting an anchor lights the door it opens, and that
              pairing is the only channel left once colour is gone. */}
          {hitQuads.map((r) => (
            <mesh
              key={r.key}
              position={r.position}
              rotation={[0, r.yaw, 0]}
              onPointerOver={(e) => {
                e.stopPropagation();
                setLit(primitive.id);
              }}
              onPointerOut={() => setLit(null)}
            >
              <planeGeometry args={[r.w, r.h]} />
              <meshBasicMaterial transparent opacity={0} depthWrite={false} />
            </mesh>
          ))}
        </>
      )}
    </group>
  );
}
