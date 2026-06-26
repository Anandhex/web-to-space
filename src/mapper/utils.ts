// ─────────────────────────────────────────────────────────────
// State extraction
// ─────────────────────────────────────────────────────────────

import type { IRNode, IRRole, PageIR } from "../ir/types";
import { mapNode } from "./nodeMapper";
import type {
  XRInteractionState,
  MappingContext,
  XRPrimitive,
  MappingRule,
} from "./types";

export function extractState(node: IRNode): XRInteractionState {
  const s = node.state;
  const parseNum = (v: string | null): number | null => {
    if (v === null) return null;
    const n = parseFloat(v);
    return isNaN(n) ? null : n;
  };
  const now = parseNum(s.valueNow);
  const min = parseNum(s.valueMin);
  const max = parseNum(s.valueMax);
  let valueFraction: number | null = null;
  if (now !== null && min !== null && max !== null && max !== min) {
    valueFraction = (now - min) / (max - min);
  }
  return {
    disabled: s.disabled === "true",
    expanded: s.expanded === null ? null : s.expanded === "true",
    checked:
      s.checked === null
        ? null
        : s.checked === "mixed"
          ? null
          : s.checked === "true",
    selected: s.selected === null ? null : s.selected === "true",
    pressed: s.pressed === null ? null : s.pressed === "true",
    required: s.required === "true",
    readonly: s.readonly === "true",
    invalid: s.invalid !== null && s.invalid !== "false",
    busy: s.busy === "true",
    valueFraction,
  };
}

// ─────────────────────────────────────────────────────────────
// ARIA relation resolution
// ─────────────────────────────────────────────────────────────

export function resolveLabel(node: IRNode, ir: PageIR): string | null {
  if (node.relations.labelledBy.length === 0) return null;
  const parts: string[] = [];
  for (const refId of node.relations.labelledBy) {
    const ref = ir.nodes[refId];
    if (ref?.label) parts.push(ref.label);
  }
  return parts.length > 0 ? parts.join(" ") : null;
}

export function resolveDescription(node: IRNode, ir: PageIR): string | null {
  if (node.relations.describedBy.length === 0) return null;
  const parts: string[] = [];
  for (const refId of node.relations.describedBy) {
    const ref = ir.nodes[refId];
    if (ref?.label) parts.push(ref.label);
  }
  return parts.length > 0 ? parts.join(" ") : null;
}

// ─────────────────────────────────────────────────────────────
// Child resolution
// ─────────────────────────────────────────────────────────────

export function resolveChildren(
  node: IRNode,
  ctx: MappingContext,
): XRPrimitive[] {
  const children: XRPrimitive[] = [];
  for (const childId of node.children) {
    const childNode = ctx.ir.nodes[childId];
    if (!childNode) continue;
    const child = mapNode(childNode, ctx);
    if (child) children.push(child);
  }

  // Leaf-text fallback: table cell nodes (`cell`, `columnheader`, `rowheader`)
  // whose text was never decomposed into inline children by the parser would
  // otherwise resolve to children: [] here, silently dropping their only text.
  // Synthesise a single XRText leaf so XRTableCell.children always has
  // something to render via DispatchChildren.
  //
  // This fallback is intentionally restricted to table cell roles. Other
  // text-bearing nodes (XRHeading, XRParagraph, XRLink, XRListItem, etc.) each
  // have their own "no-children" rendering path (ClippedText with label/content)
  // and do NOT need synthesised children. Firing the fallback for them changes
  // their rendering path from direct ClippedText (using their own metrics) to
  // InlineProseRows, while the layout engine still measures the synthesised
  // XRText with paragraph metrics — causing a size mismatch that makes content
  // visually overflow into the next element and appear doubled.
  //
  // CRITICAL: the synthesised primitive must use a derived id, never
  // node.id verbatim. node.id is already claimed by the primitive this
  // function was called to fill in (e.g. an XRTableCell built via
  // baseFrom(node, ...) one frame up the call stack). Both ctx.primitives
  // and the layout plan's entries map are keyed by id — reusing node.id here
  // overwrites the parent's own registry entry and makes renderChild(child.id)
  // re-resolve to a colliding/independently laid-out node.
  const TABLE_CELL_ROLES = new Set(["cell", "columnheader", "rowheader"]);
  const text = node.content ?? node.label ?? "";
  if (children.length === 0 && text.trim() !== "" && TABLE_CELL_ROLES.has(node.role)) {
    const textId = `${node.id}__leaftext`;
    const textPrimitive: XRPrimitive = {
      id: textId,
      type: "XRText",
      label: node.label,
      content: node.content,
      sourceIds: [node.id],
      confidence: node.confidence,
      depth: node.readingDepth,
      children: [],
      relations: {
        controls: node.relations.controls,
        labelledBy: node.relations.labelledBy,
        describedBy: node.relations.describedBy,
        details: node.relations.details,
        errorMessage: node.relations.errorMessage,
      },
      text,
      // Preserve link accent styling: node.attributes.componentType reflects
      // the original HTML tag (often null), not the ARIA role, so a 'link'
      // role node would otherwise lose its accent color once funnelled
      // through this fallback instead of XRLinkMesh's own styling.
      componentType:
        node.role === "link"
          ? "link"
          : (node.attributes?.componentType ?? null),
      styleTags: node.attributes?.styleTags ?? [],
      isProseRun: true,
    } as XRPrimitive;
    registerPrimitive(ctx, textPrimitive, "leaf-text-fallback→XRText", {
      sourceNodeIds: [node.id],
      heuristic: "resolveChildren-leaf-text-fallback",
    });
    children.push(textPrimitive);
  }

  return children;
}

// ─────────────────────────────────────────────────────────────
// Semantic fact helpers
// ─────────────────────────────────────────────────────────────

function collectText(
  nodeId: string,
  ir: PageIR,
  visited = new Set<string>(),
): string {
  if (visited.has(nodeId)) return "";
  visited.add(nodeId);
  const node = ir.nodes[nodeId];
  if (!node) return "";
  const own = node.content ?? node.label ?? "";
  const childText = node.children
    .map((id) => collectText(id, ir, visited))
    .filter(Boolean)
    .join(" ");
  return [own, childText].filter(Boolean).join(" ");
}

/**
 * Word count and reading time for paragraph-like nodes.
 * Layout uses densityScore to decide text rendering approach.
 */
export function computeDensity(
  node: IRNode,
  ir?: PageIR,
): {
  wordCount: number;
  estimatedReadingTimeSec: number;
  densityScore: number;
} {
  const text = ir
    ? collectText(node.id, ir)
    : (node.content ?? node.label ?? "");
  const wordCount = text.trim() === "" ? 0 : text.trim().split(/\s+/).length;
  const estimatedReadingTimeSec = Math.round((wordCount / 200) * 60);
  const densityScore = Math.min(1, Math.max(0, (wordCount - 10) / (200 - 10)));
  return { wordCount, estimatedReadingTimeSec, densityScore };
}

/**
 * Conservative confidence for primitives synthesised from multiple IR nodes.
 */
export function deriveConfidence(nodes: IRNode[]): number {
  if (nodes.length === 0) return 0;
  return Math.min(...nodes.map((n) => n.confidence));
}

export function trackElision(ctx: MappingContext): void {
  ctx.diagnostics.elisionCount += 1;
}

export function warnPanelOverflow(
  panelId: string,
  children: XRPrimitive[],
  ctx: MappingContext,
): void {
  if (children.length > ctx.config.maxPanelChildren) {
    ctx.diagnostics.unmappedRoles.push(
      `[overflow:${panelId}:${children.length}>${ctx.config.maxPanelChildren}]` as IRRole,
    );
  }
}

// ─────────────────────────────────────────────────────────────
// Context helpers
// ─────────────────────────────────────────────────────────────

export function registerPrimitive(
  ctx: MappingContext,
  primitive: XRPrimitive,
  rule: MappingRule,
  opts: {
    sourceNodeIds?: string[];
    confidence?: number;
    heuristic?: string | null;
  } = {},
): void {
  ctx.primitives[primitive.id] = primitive;
  ctx.diagnostics.appliedRules[primitive.id] = {
    rule,
    confidence: opts.confidence ?? primitive.confidence,
    sourceNodeIds: opts.sourceNodeIds ?? primitive.sourceIds,
    heuristic: opts.heuristic ?? null,
  };
  ctx.diagnostics.totalPrimitives += 1;
}
