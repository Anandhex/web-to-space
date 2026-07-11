/**
 * primitives/inline.tsx
 *
 * Inline text rendering shared across the block meshes: <ClippedText> (a
 * clip-aware troika Text wrapper) plus the inline-prose row system
 * (buildInlineRows / buildRowMeta / InlineProseRows / ProseRow) used by
 * paragraphs, headings, list items and blockquotes to flow mixed text/link/bold
 * runs. Must stay in sync with engine.ts's inline-flow height estimate.
 */

import React, { useContext } from "react";
import { Text } from "@react-three/drei";
import * as THREE from "three";

import { isInlinePrimitive } from "../../layout/utils";
import { useTheme, type XRTheme } from "../theme";
import { FontContext } from "../XRSceneRenderer";
import { useClipPlanes, NavigateContext } from "./contexts";
import { usePanelCurve } from "./curve";
import { Z_LAYER_INLINE_TEXT, RENDER_ORDER_TEXT } from "./constants";

// ─────────────────────────────────────────────────────────────
// ClippedText — troika Text with clipping plane support
// ─────────────────────────────────────────────────────────────

/**
 * Drop-in wrapper around drei <Text> that applies the current ClipPlanesContext
 * to the troika mesh material via onSync.
 *
 * Troika manages its own MeshStandardMaterial internally, so passing
 * clippingPlanes as a JSX prop to a <meshStandardMaterial> child has no effect.
 * The onSync callback fires after troika has built/updated the text mesh and
 * its material, giving us a stable hook to inject clippingPlanes imperatively.
 *
 * All props are forwarded to <Text> transparently.
 */
type TextProps = React.ComponentPropsWithoutRef<typeof Text>;

export function ClippedText(props: TextProps) {
  const clips = useClipPlanes();
  const curve = usePanelCurve();

  const fontType = useContext(FontContext);

  // Inside a curved panel, bend the glyphs along the same cylinder so text hugs
  // the surface rather than sitting on a flat chord that recedes behind it. The
  // sign MUST be POSITIVE — a negative radius curves the glyphs INTO the concave
  // backing and troika truncates the run to its first few characters. An
  // explicit curveRadius passed by the caller always wins.
  const curveRadius =
    (props as { curveRadius?: number }).curveRadius ?? (curve ? curve.radius : undefined);

  const handleSync = React.useCallback(
    (mesh: THREE.Mesh) => {
      if (!mesh) return;
      const mat = mesh.material as THREE.Material & {
        clippingPlanes?: THREE.Plane[] | null;
      };
      if (mat) {
        mat.clippingPlanes = clips.length > 0 ? clips : null;
        mat.needsUpdate = true;
      }
      // Also propagate to the onSync the caller may have passed
      if (typeof props.onSync === "function") {
        props.onSync(mesh);
      }
    },
    // clips array reference changes when planes change; stringify for comparison
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [clips, props.onSync],
  );

  // `curveRadius` is a valid troika-three-text prop forwarded at runtime, but
  // drei's <Text> type doesn't declare it — pass it through an untyped spread.
  const curveProp = (
    curveRadius !== undefined ? { curveRadius } : {}
  ) as Record<string, unknown>;

  return (
    <Text {...props} {...curveProp} font={fontType} onSync={handleSync} />
  );
}

// ─────────────────────────────────────────────────────────────
// Shared inline prose utilities
// Used by XRParagraphMesh and XRListItemMesh — must stay in sync
// with engine.ts's estimateInlineFlowHeight + flattenInlineWrappers.
// ─────────────────────────────────────────────────────────────

type TextSeg = { kind: "text"; text: string; bold?: boolean; italic?: boolean };
type LinkSeg = { kind: "link"; text: string; href?: string | null };
export type InlineSeg = TextSeg | LinkSeg;

export type InlineRow =
  | { kind: "inline"; segments: InlineSeg[] }
  | { kind: "block"; childId: string };

/**
 * Convert a flat list of XR primitives (after flattenInlineWrappers +
 * mergeAdjacentTextRuns) into alternating rows of inline segments and
 * block slots. Every XRText/XRLink/XRButton becomes a segment; everything
 * else forces a block row rendered via renderChild.
 */
export function buildInlineRows(children: any[]): InlineRow[] {
  const rows: InlineRow[] = [];
  let currentSegs: InlineSeg[] = [];

  const flush = (): void => {
    if (currentSegs.length === 0) return;
    rows.push({ kind: "inline", segments: currentSegs });
    currentSegs = [];
  };

  for (const child of children) {
    if (isInlinePrimitive(child.type)) {
      // Collapse HTML inline whitespace: the parser keeps source newlines and
      // indentation inside prose text runs (e.g. "\n        A paragraph…"),
      // and troika renders each "\n" as a HARD line break — inflating the
      // paragraph well past the word-count-based height the engine reserved,
      // so it overlaps the next block. Browsers collapse any run of whitespace
      // in inline flow to a single space; do the same here so wrapping is
      // driven only by maxWidth and matches the height estimate.
      const text: string = (
        child.text ??
        child.label ??
        child.content ??
        ""
      ).replace(/\s+/g, " ");
      if (child.type === "XRLink") {
        currentSegs.push({ kind: "link", text, href: child.href ?? null });
      } else {
        // Bold/italic can come from a single componentType ("b"/"strong"/
        // "i"/"em") or from an accumulated styleTags stack (e.g. ["i","b"]
        // for <i><b>…</b></i>, where componentType alone can't represent
        // two simultaneous styles). OR both signals in, same as XRTextMesh.
        const componentType = child.componentType ?? null;
        const styleTags: string[] = child.styleTags ?? [];
        const bold =
          componentType === "strong" ||
          componentType === "b" ||
          styleTags.includes("strong") ||
          styleTags.includes("b");
        const italic =
          componentType === "em" ||
          componentType === "i" ||
          styleTags.includes("em") ||
          styleTags.includes("i");
        currentSegs.push({
          kind: "text",
          text,
          ...(bold ? { bold: true } : {}),
          ...(italic ? { italic: true } : {}),
        });
      }
    } else {
      flush();
      rows.push({ kind: "block", childId: child.id });
    }
  }
  flush();
  return rows;
}

/**
 * Build the joined string + troika colorRanges for one inline row.
 *
 * Color is the only per-character styling troika's <Text colorRanges>
 * supports — there is no equivalent per-character ranging for fontWeight/
 * fontStyle, so bold/italic spans can't be drawn heavier or slanted within
 * a single mesh. Instead, styled (bold/italic) text segments are given the
 * theme's emphasisCol instead of the muted bodyCol, so they still stand
 * out from plain prose on the same line without forcing a line break.
 */
export function buildRowMeta(
  segments: InlineSeg[],
  theme: XRTheme,
  forceColor?: number,
): {
  text: string;
  colorRanges: Record<number, number> | null;
} {
  let text = "";
  const colorRanges: Record<number, number> = {};
  let hasColor = false;

  const accentHex = parseInt(theme.accentCol.replace("#", ""), 16);
  const bodyHex = parseInt(theme.bodyCol.replace("#", ""), 16);
  const emphasisHex = parseInt(theme.emphasisCol.replace("#", ""), 16);

  const colorForSegment = (seg: InlineSeg): number => {
    if (seg.kind === "link") return accentHex;
    if (seg.kind === "text" && (seg.bold || seg.italic)) return emphasisHex;
    return bodyHex;
  };

  let prevColor: number | null = null;
  for (let si = 0; si < segments.length; si++) {
    const seg = segments[si];
    const charStart = text.length;
    text += seg.text;

    const color = forceColor !== undefined ? forceColor : colorForSegment(seg);
    if (color !== prevColor) {
      colorRanges[charStart] = color;
      hasColor = true;
    }
    prevColor = color;
  }

  // Always seed an explicit entry at character 0 once colorRanges is used.
  // Troika's <Text colorRanges> applies the `color` prop as the default for
  // any uncovered leading span, but only once the GPU vertex-color buffer
  // has been (re)synced for that exact range layout. Rows whose first
  // segment's color wasn't written above (shouldn't happen given the loop
  // always writes charStart === 0 on the first iteration, but kept as a
  // defensive guard) would otherwise render with a stale/near-black vertex
  // color until troika's next full resync instead of inheriting the
  // intended `color` prop immediately.
  if (hasColor && colorRanges[0] === undefined) {
    colorRanges[0] = bodyHex;
  }

  return { text, colorRanges: hasColor ? colorRanges : null };
}

/**
 * Render a list of InlineRows as React Three Fiber nodes.
 *
 * Uses a local cursorY counter starting at `startY` — no dependency on
 * layout-plan entries. This is correct because:
 *  - For XRListItem children, plan entries use list-local stacked Y values
 *    that assumed the old "one block per child" model, not the prose flow.
 *  - For XRParagraph children, the plan entries after flattenInlineWrappers
 *    may reference IDs of nodes that no longer appear at the top level.
 *
 * xInset shifts all text/underlines right from the group origin (used by
 * XRListItemMesh to apply the card's left padding).
 */
interface InlineProseRowsProps {
  rows: InlineRow[];
  startY: number;
  panelWidth: number;
  fontSize: number;
  lineHeightRatio: number;
  xInset?: number;
  forceColor?: number;
  renderChild: (id: string) => React.ReactNode;
}

export function InlineProseRows({
  rows,
  startY,
  panelWidth,
  fontSize,
  lineHeightRatio,
  xInset = 0,
  renderChild,
  forceColor,
}: InlineProseRowsProps) {
  const lineH = fontSize * lineHeightRatio;
  const usableWidth = panelWidth - xInset;
  // cursorY is mutated during render — intentional, single render pass.
  let cursorY = startY;

  return (
    <>
      {rows.map((row, i) => {
        if (row.kind === "block") {
          return <group key={`b-${i}`}>{renderChild(row.childId)}</group>;
        }

        const rowY = cursorY;
        cursorY -= lineH;

        return (
          <ProseRow
            key={`il-${i}`}
            segments={row.segments}
            rowY={rowY}
            xInset={xInset}
            usableWidth={usableWidth}
            fontSize={fontSize}
            lineHeightRatio={lineHeightRatio}
            forceColor={forceColor}
          />
        );
      })}
    </>
  );
}

// Transparent click target for one contiguous run of a link's glyphs on a
// single visual line, in the ProseRow group's local coordinate space.
interface LinkHitRect {
  cx: number;
  cy: number;
  w: number;
  h: number;
  href: string;
}

function rectsEqual(a: LinkHitRect[], b: LinkHitRect[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (
      a[i].cx !== b[i].cx ||
      a[i].cy !== b[i].cy ||
      a[i].w !== b[i].w ||
      a[i].h !== b[i].h ||
      a[i].href !== b[i].href
    ) {
      return false;
    }
  }
  return true;
}

interface ProseRowProps {
  segments: InlineSeg[];
  rowY: number;
  xInset: number;
  usableWidth: number;
  fontSize: number;
  lineHeightRatio: number;
  forceColor?: number;
}

/**
 * One inline prose row: a single troika <Text> mesh plus transparent click
 * targets for any link segments.
 *
 * The click targets are derived from troika's actual per-character
 * `caretPositions` (read after layout via onSync) rather than a fixed
 * average-glyph-width estimate. troika wraps on word boundaries with
 * proportional glyph widths, so a guessed (charOffset × avgWidth) box drifts
 * off the visible link — especially once the merged row text wraps. Reading
 * the real caret bounds keeps the hit area locked to the glyphs the user
 * sees, and a link that wraps across lines produces one rect per line.
 */
function ProseRow({
  segments,
  rowY,
  xInset,
  usableWidth,
  fontSize,
  lineHeightRatio,
  forceColor,
}: ProseRowProps) {
  const navigate = useContext(NavigateContext);
  const theme = useTheme();
  const { text, colorRanges } = buildRowMeta(segments, theme, forceColor);
  const [hitRects, setHitRects] = React.useState<LinkHitRect[]>([]);

  // Char ranges (start inclusive, end exclusive) of each link segment within
  // the merged row string. Offsets match the string handed to troika, so they
  // index directly into caretPositions.
  const linkRanges = React.useMemo(() => {
    const ranges: { start: number; end: number; href: string }[] = [];
    let offset = 0;
    for (const seg of segments) {
      if (seg.kind === "link" && seg.href) {
        ranges.push({
          start: offset,
          end: offset + seg.text.length,
          href: seg.href,
        });
      }
      offset += seg.text.length;
    }
    return ranges;
  }, [segments]);

  const handleSync = React.useCallback(
    (mesh: THREE.Mesh) => {
      const caret = (
        mesh as unknown as { textRenderInfo?: { caretPositions?: Float32Array } }
      )?.textRenderInfo?.caretPositions;
      if (!caret || linkRanges.length === 0) {
        setHitRects((prev) => (prev.length === 0 ? prev : []));
        return;
      }
      // caretPositions packs 4 floats per char: [startX, endX, bottomY, topY]
      // in the text mesh's local space (anchorX="left", anchorY="top" → x ≥ 0,
      // y ≤ 0). The text mesh sits at [xInset, rowY] within this group, so a
      // rect centre in group space is [xInset + midX, rowY + midY].
      const EPS = 1e-4;
      const rects: LinkHitRect[] = [];
      for (const { start, end, href } of linkRanges) {
        let minX = Infinity;
        let maxX = -Infinity;
        let bottom = 0;
        let top = 0;
        let lineY: number | null = null;
        const flush = () => {
          if (lineY === null) return;
          rects.push({
            cx: xInset + (minX + maxX) / 2,
            cy: rowY + (bottom + top) / 2,
            w: Math.max(maxX - minX, 0.01),
            h: Math.max(top - bottom, 0.01),
            href,
          });
          minX = Infinity;
          maxX = -Infinity;
          lineY = null;
        };
        for (let ci = start; ci < end; ci++) {
          const base = ci * 4;
          if (base + 3 >= caret.length) break;
          const loX = Math.min(caret[base], caret[base + 1]);
          const hiX = Math.max(caret[base], caret[base + 1]);
          const by = caret[base + 2];
          const ty = caret[base + 3];
          // A change in the shared bottom-Y means troika wrapped to a new line.
          if (lineY !== null && Math.abs(by - lineY) > EPS) flush();
          lineY = by;
          bottom = by;
          top = ty;
          if (loX < minX) minX = loX;
          if (hiX > maxX) maxX = hiX;
        }
        flush();
      }
      setHitRects((prev) => (rectsEqual(prev, rects) ? prev : rects));
    },
    [linkRanges, xInset, rowY],
  );

  return (
    <group>
      <ClippedText
        anchorX="left"
        {...(colorRanges ? ({ colorRanges } as any) : {})}
        anchorY="top"
        position={[xInset, rowY, Z_LAYER_INLINE_TEXT]}
        renderOrder={RENDER_ORDER_TEXT}
        fontSize={fontSize}
        color={theme.bodyCol}
        maxWidth={usableWidth}
        lineHeight={lineHeightRatio}
        letterSpacing={0.005}
        overflowWrap="break-word"
        onSync={navigate ? handleSync : undefined}
      >
        {text}
      </ClippedText>
      {navigate &&
        hitRects.map((r, hi) => (
          <mesh
            key={`lh-${hi}`}
            position={[r.cx, r.cy, 0.004]}
            onClick={(e) => {
              e.stopPropagation();
              navigate(r.href);
            }}
          >
            <planeGeometry args={[r.w, r.h]} />
            <meshBasicMaterial transparent opacity={0} depthWrite={false} />
          </mesh>
        ))}
    </group>
  );
}
