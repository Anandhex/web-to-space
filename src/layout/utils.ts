// ─────────────────────────────────────────────────────────────
// Helpers (geometry, rotation)
// ─────────────────────────────────────────────────────────────

import type {
  Rotation3,
  Vec3,
  XRPrimitiveType,
  XRTable,
} from "../mapper/types";
import type {
  PrimitiveFontMetrics,
  RenderMetrics,
  TextBearingMetrics,
} from "./types";
import { MARK_FLOW_PLACEHOLDER } from "../links/direction";

export function deg2rad(deg: number): number {
  return (deg * Math.PI) / 180;
}

export function zeroRotation(): Rotation3 {
  return { x: 0, y: 0, z: 0 };
}

export function zeroVec(): Vec3 {
  return { x: 0, y: 0, z: 0 };
}

/**
 * Horizontal inset a container applies to each side of its children.
 *
 * The base `panelPaddingX` (~52 mm) is tuned for the full-width content panel
 * (~1.3 m), where it is a modest ~8 % margin. But the same absolute value is
 * disproportionate inside a narrow nested container — e.g. an infobox value
 * cell (~0.31 m), where 2×52 mm eats a third of the width and forces short
 * text (a cast name like "Danya Jimenez") to wrap to two lines, which in turn
 * inflates the whole infobox row until it no longer fits on a page.
 *
 * Cap the inset at a fraction of the container width so wide panels keep the
 * full padding (min wins → panelPaddingX) while narrow nested containers keep
 * a proportional, non-wrapping margin. Both the placement pass
 * (stackChildrenSimple) and the height estimates (positionConfigs) must call
 * this so the space reserved matches the space rendered.
 */
export function containerInsetX(
  containerWidth: number,
  panelPaddingX: number,
): number {
  // 0.05 keeps the full panelPaddingX for any container ≥ ~1.04 m (the content
  // panel, references, articles) while shrinking the inset proportionally for
  // narrow nested containers — e.g. a 0.31 m infobox value cell gets ~15 mm
  // per side instead of 52 mm, enough for a 15-character cast name to stay on
  // one line instead of wrapping to two.
  return Math.min(panelPaddingX, containerWidth * 0.05);
}

/** Compute words-per-line for a given panel width and font metrics. */
/**
 * Safety factor on the wrap width used by every line-count estimate.
 *
 * `charWidthRatio` is one AVERAGE advance for a whole font size, so a run whose
 * last line lands near the column limit can wrap one line later than predicted
 * — and an under-estimate is not symmetric with an over-estimate: the block is
 * drawn taller than the space reserved for it and runs straight through the
 * timestamp and the card below (a headline + kicker measured at 34 columns
 * wrapped to 4 lines where the estimate said 3). Measuring at a slightly
 * narrower width biases the count upward only for runs actually near a
 * boundary; a short heading with a half-empty last line is unaffected.
 *
 * This is the same trade list items already make with `listItemWrapCushion`,
 * applied at the wrap step so every text-bearing primitive gets it.
 */
const WRAP_SAFETY = 0.94;

/** Columns available for wrapping `width` metres of `m`-sized text. */
export function charsPerLineFor(
  width: number,
  m: PrimitiveFontMetrics,
): number {
  return Math.max(1, Math.floor((width * WRAP_SAFETY) / (m.fontSize * m.charWidthRatio)));
}

export function computeWordsPerLine(
  panelUsableWidth: number,
  m: PrimitiveFontMetrics,
): number {
  const charWidth = m.fontSize * m.charWidthRatio;
  return Math.max(
    1,
    Math.floor(panelUsableWidth / (charWidth * m.avgCharsPerWord)),
  );
}

/** Count words in a string. */
export function countWords(text: string): number {
  return text.trim() === "" ? 0 : text.trim().split(/\s+/).length;
}

// ─────────────────────────────────────────────────────────────
// Metric-driven height estimation
// ─────────────────────────────────────────────────────────────

/**
 * Estimate the rendered height of a text-bearing interactive element
 * (button, link, menu item, tab, alert, tooltip, list item, card).
 *
 * If the element's label fits on one line the result is `tb.minHeight`.
 * If the label wraps to N lines the result grows: the extra lines are added
 * on top of `tb.minHeight` using the element's line height.
 *
 * @param label           The visible label text (may be empty / undefined).
 * @param panelUsableWidth Width of the containing panel minus padding (m).
 * @param tb              TextBearingMetrics for this element type.
 * @param fallback        Fallback height if tb metrics are degenerate.
 */
export function estimateTextBearingHeight(
  label: string | undefined,
  panelUsableWidth: number,
  tb: TextBearingMetrics,
  fallback: number,
): number {
  const minHeight = Math.max(tb.minHeight, fallback);

  const text = (label ?? "").trim();
  if (text === "") {
    return minHeight;
  }

  const lineH = tb.font.fontSize * tb.font.lineHeightRatio;
  if (lineH <= 0 || !isFinite(lineH)) {
    return minHeight;
  }

  const lineCount = estimateTextLineCount(text, panelUsableWidth, tb.font);

  if (lineCount <= 1) {
    return minHeight;
  }

  const height = minHeight + (lineCount - 1) * lineH;

  return Math.max(minHeight, height);
}

/**
 * Fixed-height floors for primitives whose minimum height is dictated by
 * RenderMetrics regardless of content.
 *
 * These values are consumed by the universal fallback in `estimateHeight` as a
 * *floor*: if a primitive also has children or a label, the derived height is
 * taken as max(fixedFloor, derivedHeight), so the element never shrinks below
 * its designed baseline but can grow to fit its actual content.
 */
export function FIXED_HEIGHT_LOOKUP(
  m: RenderMetrics,
): Partial<Record<XRPrimitiveType, number>> {
  return {
    // Interactive — truly fixed (no meaningful label or children in practice)
    XRToggle: m.toggle.height,
    XRSlider: m.slider.height,
    XRComboBox: m.comboBox.height,
    XRSearchBox: m.searchBox.height,
    XRProgressBar: m.progressBar.height,
    XRSeparator: m.separator.height,
    XRTabGroup: m.tabGroup.height,
    // Media (XRFigure is handled above with caption awareness)
    XRImage: m.image.height,
    // Landmark containers — floors only; children/label can push them taller.
    XRBanner: m.banner.height,
    XRFooter: m.footer.height,
    XRNavigationBar: m.navigationBar.height,
  };
}

/**
 * Vertical inset from an XRListItem card's top edge to the first glyph of
 * its label. This is a layout contract value, not a visual tuning constant:
 * XRSceneRenderer's XRListItemMesh positions the label text mesh at exactly
 * this offset, and the layout engine (engine.ts, in both estimateHeight's
 * XRListItem branch and stackChildrenSimple's top-padding calculation) must
 * use the same value when deciding where the card's children start. If
 * these two sites ever read different numbers, the label and the first
 * child either overlap (renderer inset smaller than what layout reserved)
 * or leave a dead gap (renderer inset larger than what layout reserved).
 */
// List-item card spacing (top/bottom pad and left/right inset) now lives on the
// device profile as metrics.listItemContentPad / metrics.listItemProseInset so
// it is tunable per profile alongside childGapY. Both the engine (height
// estimates) and the renderer (mesh positions) read the SAME metric values — any
// drift causes visual overlap or dead gaps. The top inset equals the content pad
// (there is no longer an accent band above the content to reserve space for).

/**
 * Height occupied by an XRListItem's own label line, including its top
 * inset (metrics.listItemContentPad).
 *
 * Unlike estimateTextBearingHeight, this does NOT model word-wrapping —
 * XRListItemMesh renders the label as a single fixed-size top line (it does
 * not wrap across multiple lines), so the height contribution is always
 * exactly one line, regardless of label length or panel width.
 *
 * Used by:
 *   - estimateHeight()'s XRListItem branch, to size the card.
 *   - stackChildrenSimple(), to know where the children's stack should
 *     start (y = -listItemLabelBlockHeight(...)) instead of the flat
 *     panelPaddingTop every other OWNS_TOP_PADDING container uses.
 *   - XRListItemMesh, to offset its rendered children group by the same
 *     amount the layout engine assumed when it positioned them.
 *
 * Returns 0 when there is no label, matching XRListItemMesh's behaviour of
 * skipping the text mesh entirely when primitive.label is falsy.
 */
export function listItemLabelBlockHeight(
  label: string | null | undefined,
  metrics: RenderMetrics,
): number {
  if (!label) return 0;
  const font = metrics.listItem.font;
  return metrics.listItemContentPad + font.fontSize * font.lineHeightRatio;
}

// ─────────────────────────────────────────────────────────────
// Resolved strategy helpers
// ─────────────────────────────────────────────────────────────

/**
 * Decide the column count for an XRList given the available panel width.
 *
 * floor(panelUsableWidth / minCardWidth), clamped to [1, maxCardColumns] and —
 * when the caller knows it — to the number of items in the list.
 *
 * The item-count clamp is what stops a one- or two-item list from being laid
 * out on a four-column grid: the lone card kept a quarter-width column with
 * three empty columns beside it, so its headline wrapped into a tall ragged
 * stack while the rest of the row sat empty. Two adjacent lists on the same
 * page — one with a single item, one with four — then rendered at completely
 * different widths for no reason the reader can see. Every call site must pass
 * the same count, or the placer and the estimate disagree about card width.
 */
export function resolveListColumns(
  panelUsableWidth: number,
  metrics: RenderMetrics,
  itemCount?: number,
): number {
  const fromWidth = Math.floor(panelUsableWidth / metrics.minCardWidth);
  const capped = Math.max(1, Math.min(fromWidth, metrics.maxCardColumns));
  return itemCount && itemCount > 0 ? Math.min(capped, itemCount) : capped;
}

/**
 * Primitive types that read as a self-contained block object rather than as
 * running prose: they carry their own surface, so the space around them has to
 * separate two objects, not two paragraphs.
 */
const BLOCK_OBJECT_TYPES = new Set<string>([
  "XRFigure",
  "XRImage",
  "XRTable",
  "XRBlockQuote",
  "XRCodeBlock",
  "XRMediaPlayer",
  "XRList",
  "XRCardGrid",
]);

/**
 * The vertical gap that belongs between two stacked blocks.
 *
 * Replaces the single flat `config.childGapY` that used to sit between every
 * pair regardless of what they were. A uniform gap cannot express grouping, and
 * proximity is read as grouping whether or not it was intended — with one
 * constant, a heading floated equidistant between the section it closed and the
 * section it opened, so the reader had no way to tell which content it named.
 *
 * Precedence, strongest boundary first:
 *   1. nothing above       → no gap
 *   2. next is a heading   → beforeHeading   (a new group starts here)
 *   3. prev is a heading   → afterHeading    (the heading binds to what follows)
 *   4. either is a rule    → aroundRule
 *   5. both are table rows → spacing.tight   (one grid, not two blocks)
 *   6. either is an object → aroundBlock
 *   7. otherwise           → betweenBlocks
 *
 * Rule 2 outranks rule 5 deliberately: a heading following a figure still opens
 * a group, and that boundary must read as the stronger of the two.
 *
 * EVERY site that stacks children must call this — the placer
 * (stackChildrenSimple), the height estimate (sumChildrenHeights) and the
 * paginator's flow loops. If one of them keeps using a flat constant, the space
 * it reserves stops matching the space the others draw and content drifts off
 * the bottom of its parent.
 */
export function blockGap(
  prev: { type: string } | null | undefined,
  next: { type: string } | null | undefined,
  metrics: RenderMetrics,
): number {
  if (!prev || !next) return 0;
  const r = metrics.rhythm;
  if (next.type === "XRHeading") return r.beforeHeading;
  if (prev.type === "XRHeading") return r.afterHeading;
  if (prev.type === "XRSeparator" || next.type === "XRSeparator") {
    return r.aroundRule;
  }
  // Two rows of the same table are one grid, not two stacked blocks. They take
  // the same gutter their columns do, so the grid reads as a unit — a prose gap
  // here would space the rows further apart than the cells within a row.
  if (prev.type === "XRTableRow" && next.type === "XRTableRow") {
    return metrics.spacing.tight;
  }
  if (BLOCK_OBJECT_TYPES.has(prev.type) || BLOCK_OBJECT_TYPES.has(next.type)) {
    return r.aroundBlock;
  }
  return r.betweenBlocks;
}

/**
 * Gutter between cards in an XRList grid, horizontally and between rows.
 *
 * One step above a tile's own interior padding (metrics.spacing.snug), which is
 * the classic grid relationship: the space BETWEEN two tiles has to beat the
 * space INSIDE one, or the eye groups a tile's right-hand text with its
 * neighbour's left-hand text instead of with its own. At the flat 10 mm this
 * originally used, two cards side by side read as one continuous slab with a
 * hairline seam down it.
 *
 * On the shared ladder rather than scaled off minCardWidth, so a gutter and a
 * padding are always comparable quantities.
 */
export function cardGridGap(metrics: RenderMetrics): number {
  return metrics.spacing.comfortable;
}

/**
 * Column geometry for one XRTableRow: `cellCount` equal columns across
 * `rowWidth`, separated by a gutter.
 *
 * A row is the one container in the pipeline whose children run ACROSS rather
 * than down. Without this it fell through to the default vertical stack in
 * stackChildrenSimple and every table rendered as one tall column — "Token",
 * "Metres", "hairline", "0.0042" one under the other, with the table's whole
 * grid structure lost.
 *
 * Equal columns rather than content-proportional ones: proportional widths need
 * a measuring pass over every cell in every row before any of them can be
 * placed, and the engine has no such pass. Equal columns are predictable, and a
 * cell that needs more room wraps into more lines, which the row absorbs by
 * taking the tallest cell's height.
 *
 * Both the placer (stackChildrenSimple) and the height estimate
 * (_estimateTableRowHeight) MUST size cells through here — a row whose cells
 * were measured at one width and drawn at another wraps to a different number
 * of lines than the height reserved for it.
 */
export function tableColumnGeometry(
  rowWidth: number,
  cellCount: number,
  metrics: RenderMetrics,
): { columnWidth: number; gutter: number } {
  const n = Math.max(1, cellCount);
  const gutter = metrics.spacing.tight;
  return {
    columnWidth: Math.max(0.02, (rowWidth - gutter * (n - 1)) / n),
    gutter,
  };
}

/**
 * Decide the rendering strategy for an XRTable.
 *
 * Rules:
 *   columns > tableMaxFlatColumns → "scrollable" (too wide to show flat)
 *   rows    > tableMaxFlatRows    → "scrollable" (too tall to paginate row by row)
 *   columns > 2 && rows > 4      → "curved-2d"  (ergonomic at wide angles)
 *   rows    < columns (wide/flat) → "cards"      (each row becomes a card)
 *   default                      → "flat-2d"
 */
export function resolveTableStrategy(
  table: XRTable,
  metrics: RenderMetrics,
): "flat-2d" | "curved-2d" | "scrollable" | "cards" {
  const { columnCount, rowCount } = table;
  if (columnCount > metrics.tableMaxFlatColumns) return "scrollable";
  if (rowCount > metrics.tableMaxFlatRows) return "scrollable";
  if (columnCount > 2 && rowCount > 4) return "curved-2d";
  if (rowCount < columnCount) return "cards";
  return "flat-2d";
}

// ─────────────────────────────────────────────────────────────
// Inline flow layout helpers
// ─────────────────────────────────────────────────────────────

/**
 * Primitive types that are purely inline (flow horizontally on the same
 * line as adjacent runs). Everything else is treated as a block-break.
 *
 * XRImage / XRFigure are intentionally absent — they always force a new
 * vertical row.
 */
const INLINE_PRIMITIVE_TYPES = new Set(["XRText", "XRLink", "XRButton"]);

/** Returns true when a primitive should flow inline with its neighbours. */
export function isInlinePrimitive(type: string): boolean {
  return INLINE_PRIMITIVE_TYPES.has(type);
}

/**
 * A link whose children include block-level content (an image, heading,
 * paragraph, or a nested panel) is a clickable "card"/teaser — e.g. a news
 * teaser wrapping `<img> + <h2> + <p>` in one `<a>` — not an inline text link.
 * It must be laid out and dispatched as a block container that stacks its
 * children, never flowed as a single prose run (which collapses the image and
 * structure into one line of concatenated label text).
 *
 * The renderer's XRLink dispatcher (to pick the sibling-dispatch path) and
 * XRLinkMesh (to draw a bare clickable backing instead of the label) both gate
 * on this, so it lives here to keep the two decisions in sync.
 */
export function linkHasBlockChildren(
  children: { type: string; children?: unknown[] }[],
): boolean {
  const flat = flattenInlineWrappers(children as any[]);
  return flat.length > 0 && flat.some((c) => !isInlinePrimitive(c.type));
}

/**
 * The text a CHILDLESS node draws on its own, exactly as the renderer resolves
 * it (`content ?? label` — see the XRGenericPanel leaf branch in
 * scene/dispatcher.tsx). A node whose `content` is the empty string draws
 * nothing even when it carries a `label`: that is the Wikipedia Z3988 COinS
 * span, whose label is an OpenURL metadata blob that must never be shown.
 *
 * Every place that decides whether a childless node occupies space must ask
 * this same question, or the space reserved and the pixels drawn disagree.
 */
export function leafNodeText(p: {
  content?: string | null;
  label?: string | null;
}): string {
  return (p.content ?? p.label ?? "").trim();
}

/**
 * Flatten XRGenericPanel wrappers that contain only inline children.
 *
 * The parser wraps Korean-romanisation spans, citation superscripts, and
 * other purely-stylistic inline containers in XRGenericPanel nodes (because
 * they carry a `title` attribute that prevents wrapper-piercing). Those
 * wrappers must be transparent to both the layout engine and the renderer:
 *
 *   Before: [..., XRText("wields a "), XRGenericPanel[XRLink("saingeom")], XRText(" sword")]
 *   After:  [..., XRText("wields a "), XRLink("saingeom"), XRText(" sword")]
 *
 * Called in:
 *   - estimateHeight (engine.ts) — XRListItem and XRParagraph branches
 *   - XRParagraphMesh / XRListItemMesh (primitives.tsx) — inline flow renderer
 *
 * Both call sites must use this function on the same input so the height the
 * engine reserves matches the height the renderer actually draws.
 *
 * A wrapper is flattened when ALL of its direct children are inline
 * primitives (XRText, XRLink, XRButton). Wrappers with block children
 * (XRImage, sub-lists) are left in place.
 */
/**
 * A list item whose entire content is one or two punctuation glyphs — no
 * letters, no digits.
 *
 * The Guardian's cards each carry a pair of bare `<div>`s holding a single "…",
 * a CSS-driven flourish in their kicker line (46 of them on the front page).
 * Nothing in the markup marks them as decoration: they parse into ordinary list
 * items, so each one claimed a full card tile and a whole grid column, and the
 * reader got a card containing nothing but an ellipsis next to the real
 * stories. Layout gives these no space and the renderer draws nothing for them.
 *
 * Deliberately narrow — list items only, two characters at most, and only when
 * there is not a single alphanumeric — so it can never swallow real content
 * like a "1." marker or a lone initial.
 */
export function isDecorativeGlyphItem(p: {
  type: string;
  content?: string | null;
  label?: string | null;
  text?: string;
  children?: unknown[];
}): boolean {
  if (p.type !== "XRListItem") return false;
  const collect = (n: any, depth: number): string => {
    if (depth > 3) return "";
    let out = String(n.text ?? n.content ?? n.label ?? "");
    for (const c of n.children ?? []) out += collect(c, depth + 1);
    return out;
  };
  const text = collect(p, 0).trim();
  return text.length > 0 && text.length <= 2 && !/[\p{L}\p{N}]/u.test(text);
}

export function flattenInlineWrappers<
  T extends { type: string; children?: T[] },
>(children: T[]): T[] {
  // A childless, textless XRGenericPanel is a metadata-only node (e.g. the
  // Wikipedia Z3988 COinS span) or a bare structural <div>. It draws nothing —
  // drop it entirely and do not let it block the "are all siblings inline?"
  // check on the parent.
  //
  // A childless panel that DOES carry text (an unmapped <time>: "11m ago") is
  // NOT dropped: the renderer draws that text, so hiding the node here would
  // both lose the text from the prose flow and leave its height unreserved,
  // letting the sibling below it render on top.
  const isEmptyPanel = (c: T) =>
    c.type === "XRGenericPanel" &&
    (!Array.isArray((c as any).children) || (c as any).children.length === 0) &&
    leafNodeText(c as any) === "";

  return children
    .filter((child) => !isEmptyPanel(child)) // drop empty metadata panels
    .flatMap((child) => {
      if (child.type !== "XRGenericPanel" || !Array.isArray(child.children)) {
        return [child];
      }
      // Filter out empty sub-panels before checking inline-ness
      const meaningfulChildren = child.children.filter(
        (c) => !isEmptyPanel(c as T),
      );
      if (
        meaningfulChildren.length > 0 &&
        meaningfulChildren.every((c) => isInlinePrimitive((c as T).type))
      ) {
        return meaningfulChildren as T[];
      }
      // Recurse: the wrapper may contain nested wrappers that haven't
      // been unwrapped yet (e.g. <span><i><a>…</a></i></span>).
      if (meaningfulChildren.length > 0) {
        const unwrapped = flattenInlineWrappers(meaningfulChildren as T[]);
        if (unwrapped.every((c) => isInlinePrimitive(c.type))) {
          return unwrapped;
        }
      }
      return [child];
    });
}

/**
 * Merge adjacent XRText sibling primitives into single combined nodes.
 *
 * Fragmented text like:
 *   XRText("This page was last edited on ")
 *   XRText("20 June 2026, at 23:57")
 *   XRText(" (UTC).")
 * arrives from the mapper as three separate nodes but should measure and
 * render as one continuous run. This function collapses consecutive XRText
 * nodes (preserving non-XRText nodes in place) before height estimation or
 * rendering so both sites see the same fused word-count.
 *
 * IMPORTANT: only merges nodes whose `componentType` is plain text (null,
 * "text", "span") AND that carry no `styleTags` (e.g. ["b"], ["i"]).
 * Bold/italic/code runs keep their individual identity — whether that's
 * signalled via componentType or via an accumulated styleTags stack (the
 * latter is how nested style-only tags like <i><b>…</b></i> are
 * represented) — so their visual styling is not lost.
 *
 * @returns a new array of primitives (original array is not mutated).
 */
export function mergeAdjacentTextRuns<
  T extends {
    type: string;
    text?: string;
    componentType?: string | null;
    styleTags?: string[] | null;
    id: string;
  },
>(children: T[]): T[] {
  if (children.length === 0) return children;

  const result: T[] = [];

  const isPlainText = (c: T) =>
    c.type === "XRText" &&
    (c.componentType == null ||
      c.componentType === "text" ||
      c.componentType === "span") &&
    (!c.styleTags || c.styleTags.length === 0);

  let i = 0;
  while (i < children.length) {
    const child = children[i];

    if (isPlainText(child)) {
      // Collect consecutive plain-text siblings
      const parts: string[] = [child.text ?? ""];
      i++;
      while (i < children.length && isPlainText(children[i])) {
        parts.push(children[i].text ?? "");
        i++;
      }

      if (parts.length === 1) {
        // Nothing to merge
        result.push(child);
      } else {
        // Produce a single fused node (shallow-clone the first node).
        // Fusing happens BEFORE buildInlineRows sees the runs, so the
        // element-boundary space has to be restored here too — otherwise the
        // renderer's own join rule has no boundary left to act on and two
        // separate elements read as one word.
        let fused = parts[0];
        for (let k = 1; k < parts.length; k++) {
          if (fused !== "" && needsInlineSeparator(fused, parts[k]))
            fused += " ";
          fused += parts[k];
        }
        const merged: T = {
          ...child,
          id: child.id, // keep the first node's id for map lookups
          text: fused,
        } as T;
        result.push(merged);
      }
    } else {
      result.push(child);
      i++;
    }
  }

  return result;
}

/**
 * Estimate the rendered height of a mixed inline+block child list.
 *
 * Algorithm
 * ─────────
 * Scan `children` left-to-right maintaining a current-line word budget:
 *
 *   • INLINE primitives (XRText, XRLink, XRButton):
 *       Accumulate their word counts onto the current line.  When the line
 *       overflows `wordsPerLine`, add extra wrapped lines at `lineH`.
 *
 *   • BLOCK primitives (XRImage, XRFigure, or any unknown type):
 *       1. Flush the current inline run (add its height to totalHeight).
 *       2. Add the block primitive's own height (via `blockHeightFn`).
 *       3. Reset the inline cursor.
 *
 * After the loop, flush any remaining inline words.
 *
 * This matches the renderer's behaviour in XRParagraphMesh where inline
 * runs are grouped into a single <Text> and images are stacked below.
 *
 * @param children       Already-merged list of child primitives.
 * @param wordsPerLine   From `computeWordsPerLine(panelUsableWidth, m)`.
 * @param lineH          `m.fontSize * m.lineHeightRatio`.
 * @param vertPad        `m.verticalPadding` (added once, at the end).
 * @param blockHeightFn  Returns the height for a non-inline child.
 * @param gapY           Gap between a flushed inline block and the next block.
 */
/**
 * Greedy word-wrap line count for a run of text at `charsPerLine` columns.
 *
 * The old model — `ceil(totalWords / wordsPerLine)` — assumes every word is
 * `avgCharsPerWord` long. That badly under-counts lines for content full of
 * long unbreakable tokens (citation ISBNs/URLs, "Constitutional", code), so an
 * atomic list-item card estimated from it renders far taller than reserved,
 * gets clipped, and strands a blank continuation page. This wraps using each
 * token's real length instead, matching troika's word-boundary wrapping
 * (`overflowWrap="break-word"` splits any single token wider than a line).
 */
function countWrappedLines(text: string, charsPerLine: number): number {
  const cpl = Math.max(1, Math.floor(charsPerLine));
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return 0;
  let lines = 1;
  let col = 0; // chars already occupied on the current line
  for (const w of words) {
    const len = w.length;
    if (len > cpl) {
      // Token wider than a line: it moves to a fresh line (if the current one
      // has content) then break-word splits it across ceil(len/cpl) lines.
      if (col > 0) lines += 1;
      const span = Math.ceil(len / cpl);
      lines += span - 1;
      col = len - (span - 1) * cpl;
      continue;
    }
    const needed = col === 0 ? len : col + 1 + len; // +1 for the joining space
    if (needed <= cpl) {
      col = needed;
    } else {
      lines += 1;
      col = len;
    }
  }
  return lines;
}

/**
 * Line count for one string laid out at `usableWidth`, using each token's real
 * length (countWrappedLines) instead of `ceil(words / avgWordsPerLine)`.
 *
 * The averaged model is only defensible for a wide column of ordinary prose.
 * In a narrow grid card it under-counts badly — a news headline prefixed with
 * its kicker ("TechnologySpotify to distinguish AI artists…") is one 17-char
 * token followed by short words, which the average scores as two lines and
 * troika wraps to six. The card was then sized for two, and the headline ran
 * out through the timestamp below it. Anything measuring a single run of text
 * should use this; `estimateInlineFlowHeight` already does the same thing for
 * multi-child inline runs.
 */
export function estimateTextLineCount(
  text: string,
  usableWidth: number,
  m: PrimitiveFontMetrics,
): number {
  return Math.max(1, countWrappedLines(text, charsPerLineFor(usableWidth, m)));
}

/**
 * Cut `text` down to the first `maxLines` lines it wraps to at `charsPerLine`,
 * ending in an ellipsis when anything was dropped.
 *
 * The mirror of countWrappedLines: same greedy walk, same break-word rule, but
 * it returns the text that survives instead of the count. Use it wherever the
 * renderer draws into a box whose height was fixed by something OTHER than the
 * text (an image's aspect ratio, a card's slot), where the alternative to
 * clamping is glyphs drawn straight through the neighbouring block.
 */
export function clampTextToLines(
  text: string,
  charsPerLine: number,
  maxLines: number,
): string {
  const cpl = Math.max(1, Math.floor(charsPerLine));
  const max = Math.max(1, Math.floor(maxLines));
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "";

  const kept: string[] = [];
  let lines = 1;
  let col = 0; // chars already occupied on the current line

  for (const w of words) {
    const span = Math.ceil(w.length / cpl); // rows a break-word token spans
    let nextLines: number;
    let nextCol: number;
    if (col === 0) {
      nextLines = lines + span - 1;
      nextCol = w.length - (span - 1) * cpl;
    } else if (span === 1 && col + 1 + w.length <= cpl) {
      nextLines = lines;
      nextCol = col + 1 + w.length;
    } else {
      nextLines = lines + span;
      nextCol = w.length - (span - 1) * cpl;
    }
    if (nextLines > max) return ellipsised(kept, cpl, max);
    lines = nextLines;
    col = nextCol;
    kept.push(w);
  }
  return kept.join(" ");
}

/**
 * Join the words that fit and mark the cut.
 *
 * The ellipsis is a character like any other: appended to a last word that
 * already fills its line, it wraps to a line of its own and the clamped run is
 * one line TALLER than the budget it was clamped to. So re-measure and drop
 * trailing words until the marked text really fits.
 */
function ellipsised(kept: string[], charsPerLine: number, maxLines: number): string {
  const words = [...kept];
  while (words.length > 0) {
    const marked = words.join(" ").replace(/[\s,;:.\u2013\u2014-]+$/, "") + "\u2026";
    if (countWrappedLines(marked, charsPerLine) <= maxLines) return marked;
    words.pop();
  }
  return "\u2026";
}

/**
 * Does the join between two adjacent inline runs need a space inserted?
 *
 * Segments come from adjacent ELEMENTS, and the browser almost always puts
 * something between them — a news card's kicker is a block `<div>` rendered on
 * its own line above the headline `<span>`, with no whitespace between the tags
 * for the parser to keep. Concatenating the runs therefore produced one word:
 * "ReviewI Give You My Silence…", "UK weatherAndy Burnham…".
 *
 * A space everywhere would be wrong too — runs also split mid-phrase around a
 * symbol ("£" + "4.4bn"), where the browser shows no gap. So add one only where
 * the join runs a word straight into the start of the next phrase.
 *
 * SHARED so the renderer and the height estimate cannot drift: buildInlineRows
 * (renderer/primitives/inline.tsx) inserts the space into the drawn segments,
 * and estimateInlineFlowHeight below inserts it into the string it measures. If
 * only one side did, a join that adds a wrap line would be drawn taller than
 * the space reserved for it and would overrun the block below.
 */
export function needsInlineSeparator(prev: string, next: string): boolean {
  return /[\w)\]]$/.test(prev) && /^[A-Z0-9(['"\u2018\u201c]/.test(next);
}

/** Collapse an inline run's whitespace the way a browser does (see below). */
export function collapseInlineWhitespace(text: string): string {
  return text.replace(/\s+/g, " ");
}

export function estimateInlineFlowHeight(
  children: ReadonlyArray<{
    type: string;
    text?: string;
    label?: string;
    wordCount?: number;
  }>,
  wordsPerLine: number,
  charsPerLine: number,
  lineH: number,
  vertPad: number,
  blockHeightFn: (child: {
    type: string;
    text?: string;
    label?: string;
    wordCount?: number;
  }) => number,
  gapY: number,
): number {
  if (children.length === 0) return 0;

  let totalHeight = 0;
  // Accumulate the run's actual text so wrapping is driven by real token
  // lengths (see countWrappedLines). fallbackWords covers inline children that
  // carry only a wordCount (e.g. split continuation fragments) with no text.
  let runText = "";
  let fallbackWords = 0;
  let firstBlock = true;

  const flushInline = (): void => {
    if (runText === "" && fallbackWords === 0) return;
    let lineCount = runText !== "" ? countWrappedLines(runText, charsPerLine) : 0;
    if (fallbackWords > 0) {
      lineCount += Math.ceil(fallbackWords / Math.max(1, wordsPerLine));
    }
    lineCount = Math.max(1, lineCount);
    if (!firstBlock) totalHeight += gapY;
    totalHeight += lineCount * lineH;
    firstBlock = false;
    runText = "";
    fallbackWords = 0;
  };

  for (const child of children) {
    if (isInlinePrimitive(child.type)) {
      // Mirror buildInlineRows exactly: collapse each run's whitespace the way
      // a browser does (the parser keeps HTML source newlines + indentation,
      // which troika would render as HARD breaks), then restore the boundary
      // the markup dropped between adjacent element runs. Measuring the raw
      // concatenation instead reserves height for a different string than the
      // one that actually gets drawn.
      const t = collapseInlineWhitespace(
        (child as { text?: string }).text ??
          (child as { label?: string }).label ??
          "",
      );
      if (t) {
        if (runText !== "" && needsInlineSeparator(runText, t)) runText += " ";
        runText += t;
        // Directional marks (docs/directional-links.md, Phase 4): every anchor
        // is drawn with a mark after it, so every anchor must be MEASURED with
        // one. See MARK_FLOW_PLACEHOLDER for why a fixed placeholder rather
        // than the real mark — the estimate cannot classify, and over-
        // reserving by one glyph is the safe direction of the error.
        if (child.type === "XRLink") runText += MARK_FLOW_PLACEHOLDER;
      } else if (child.wordCount != null && child.wordCount > 0)
        fallbackWords += child.wordCount;
    } else {
      // Block element — flush inline first, then account for the block
      flushInline();
      const bh = blockHeightFn(child);
      if (!firstBlock) totalHeight += gapY;
      totalHeight += bh;
      firstBlock = false;
    }
  }

  // Flush any trailing inline run
  flushInline();

  return totalHeight + vertPad;
}
