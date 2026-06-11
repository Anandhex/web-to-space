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
  return children;
}

// ─────────────────────────────────────────────────────────────
// Semantic fact helpers
// ─────────────────────────────────────────────────────────────

/**
 * Word count and reading time for paragraph-like nodes.
 * Layout uses densityScore to decide text rendering approach.
 */
export function computeDensity(node: IRNode): {
  wordCount: number;
  estimatedReadingTimeSec: number;
  densityScore: number;
} {
  const text = node.label ?? "";
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
