/**
 * layout/outline.ts
 *
 * The document's section outline, derived once per plan.
 *
 * Which pages a section occupies is only knowable AFTER pagination has
 * stamped a pageIndex on every primitive, so the engine is the stage that
 * owns it. Page views (elevator storeys, wall tiles, deck piles, rooms)
 * all group by section, and without this they each re-walk the panel's whole
 * subtree — on every focus change — to rediscover the same spans.
 *
 * Naming a section is fiddlier than it looks, hence `sectionName`: the
 * XRHeading node is often emitted with no text of its own, with the heading
 * line sitting at the head of the SECTION's content instead, and
 * `label` falls back to the synthesized node id — which must never reach a
 * user-visible plaque. A section with no heading at all (structural
 * inference emits them for paragraph runs) has no name, and the renderer
 * decides what that means for it.
 */
import type { SemanticScene, XRPrimitive } from "../mapper/types";
import type { LayoutEntry, SectionSpan } from "./types";

/** Text carried by a node or, failing that, by its descendants. */
function textOf(node: XRPrimitive): string {
  const own = (node.content ?? node.label ?? "").trim();
  if (own) return own;
  for (const c of node.children) {
    const t = textOf(c);
    if (t) return t;
  }
  return "";
}

function firstHeading(node: XRPrimitive): XRPrimitive | null {
  if (node.type === "XRHeading") return node;
  for (const c of node.children) {
    const h = firstHeading(c);
    if (h) return h;
  }
  return null;
}

/** A section's heading text, or "" when it has no heading to be named by. */
function sectionName(node: XRPrimitive): string {
  const h = firstHeading(node);
  if (!h) return "";
  const own = textOf(h);
  if (own) return own;
  // Heading node carries nothing — the section's own text starts with it.
  return (
    (node.content ?? "")
      .split("\n")
      .map((s) => s.trim())
      .find(Boolean) ?? ""
  );
}

/** Page range covered by a primitive's whole subtree, or null if unplaced. */
function subtreePageSpan(
  node: XRPrimitive,
  entries: Record<string, LayoutEntry>,
): [number, number] | null {
  let min = Infinity;
  let max = -Infinity;
  const walk = (p: XRPrimitive): void => {
    const page = entries[p.id]?.pageIndex;
    if (page !== undefined) {
      if (page < min) min = page;
      if (page > max) max = page;
    }
    for (const c of p.children) walk(c);
  };
  walk(node);
  return min === Infinity ? null : [min, max];
}

/**
 * Every XRSection inside the paginated panel, at any depth, in reading
 * order. Pre-order, so a parent always precedes the children nested in it.
 */
export function computeSectionOutline(
  scene: SemanticScene,
  entries: Record<string, LayoutEntry>,
): SectionSpan[] {
  const panel = scene.root.children.find((p) => p.type === "XRContentPanel");
  if (!panel) return [];

  const out: SectionSpan[] = [];
  const walk = (node: XRPrimitive, depth: number): void => {
    let childDepth = depth;
    if (node.type === "XRSection") {
      const span = subtreePageSpan(node, entries);
      if (span) {
        out.push({
          label: sectionName(node),
          depth,
          startPage: span[0],
          endPage: span[1],
        });
      }
      childDepth = depth + 1;
    }
    for (const c of node.children) walk(c, childDepth);
  };
  for (const child of panel.children) walk(child, 0);

  out.sort((a, b) => a.startPage - b.startPage || a.depth - b.depth);
  return out;
}
