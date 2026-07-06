/**
 * mapper.ts — Semantic IR → XR Verb Translation
 *
 * Consumes a `PageIR` produced by the parser and emits a `SemanticScene` —
 * a tree of typed XR primitives annotated with semantic facts.
 *
 * Architecture position:
 *   HTML → Parser → IR → **Mapper (this file)** → SemanticScene → Layout → Renderer
 *
 * Strict responsibilities
 * ───────────────────────
 * ✓  Translate each IR role to the correct XR verb (type)
 * ✓  Extract semantic facts the Layout layer needs (state, relations, counts)
 * ✓  Resolve ARIA relations (labelledBy, describedBy, controls)
 * ✓  Record diagnostics (unmapped roles, elisions, merges)
 *
 * Explicit non-responsibilities (handled by Layout)
 * ──────────────────────────────────────────────────
 * ✗  Spatial placement — no positions, rotations, or sizes
 * ✗  Layout strategies — flat-2d vs curved, card columns, media sizing
 * ✗  Scene template selection — document / dashboard / form / landing
 *
 * Design principles
 * ─────────────────
 * 1. Pure function: (PageIR, MapperConfig) → SemanticScene. No side-effects.
 * 2. Every mapping rule is a named function — testable in isolation.
 * 3. The mapper never drops nodes. Unmapped roles → XRGenericPanel.
 * 4. Spatial facts (counts, sizes, live regions) are attached as data for
 *    Layout to act on — the mapper makes no spatial decisions itself.
 */

import type { IRNode, PageIR } from "../ir/types";
import { mapNode } from "./nodeMapper";
import type {
  MapperConfig,
  MappingContext,
  XRPrimitive,
  XRPrimitiveType,
  XRPrimitiveBase,
  XRNavigationBar,
  XRLink,
  XRScene,
  SemanticScene,
} from "./types";
import { deriveConfidence, registerPrimitive } from "./utils";

// ─────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────

export const DEFAULT_MAPPER_CONFIG: MapperConfig = {
  elidePresentation: true,
  minCardGridItems: 2,
  maxPanelChildren: 50,
  lowConfidenceThreshold: 0.55,
};

// ─────────────────────────────────────────────────────────────
// Primitive construction
// ─────────────────────────────────────────────────────────────

/**
 * Build the common fields shared by every XR primitive.
 * Placement is intentionally absent — Layout sets it.
 */
export function baseFrom(node: IRNode, type: XRPrimitiveType): XRPrimitiveBase {
  return {
    id: node.id,
    type,
    label: node.label,
    content: node.content,
    sourceIds: [node.id],
    confidence: node.confidence,
    depth: node.readingDepth,
    // placement: absent — Layout's responsibility
    children: [],
    relations: {
      controls: node.relations.controls,
      labelledBy: node.relations.labelledBy,
      describedBy: node.relations.describedBy,
      details: node.relations.details,
      errorMessage: node.relations.errorMessage,
    },
  };
}

// ─────────────────────────────────────────────────────────────
/**
 * Synthesise an XRNavigationBar from the heading hierarchy of the IR.
 * Only fires when config.generateTOC is true and the layout template
 * resolves to "document".
 *
 * Each heading in reading order becomes an XRLink item in the nav bar,
 * with the heading text as the label and a fragment href derived from the
 * heading's IR node ID.
 */
function synthesiseTOC(
  ir: PageIR,
  ctx: MappingContext,
): XRNavigationBar | null {
  const sectionNodes = ir.readingOrder
    .map((id) => ir.nodes[id])
    .filter(
      (n): n is IRNode =>
        !!n &&
        n.role === "region" &&
        typeof n.label === "string" &&
        n.label.trim().length > 0,
    );

  if (sectionNodes.length === 0) return null;

  const baseDepth = Math.min(...sectionNodes.map((n) => n.readingDepth));

  const items: XRLink[] = sectionNodes.map((n) => {
    const link: XRLink = {
      id: `toc__${n.id}`,
      type: "XRLink",
      label: n.label,
      content: n.content,
      sourceIds: [n.id],
      confidence: n.confidence,

      depth: n.readingDepth - baseDepth,

      children: [],
      relations: {
        controls: [],
        labelledBy: [],
        describedBy: [],
        details: [],
        errorMessage: [],
      },
      href: `#${n.id}`,
      isCurrent: false,
    };

    registerPrimitive(ctx, link, "link→XRLink", {
      sourceNodeIds: [n.id],
      heuristic: "toc-from-sections",
    });

    return link;
  });

  const tocId = "toc__nav";

  const tocNode: XRNavigationBar = {
    id: tocId,
    type: "XRNavigationBar",
    label: "Table of Contents",
    content: null,

    sourceIds: sectionNodes.map((n) => n.id),
    confidence: deriveConfidence(sectionNodes),

    depth: 0,

    children: items,
    items: [...items],

    relations: {
      controls: [],
      labelledBy: [],
      describedBy: [],
      details: [],
      errorMessage: [],
    },
  };

  registerPrimitive(ctx, tocNode, "toc:inferred→XRNavigationBar", {
    sourceNodeIds: sectionNodes.map((n) => n.id),
    heuristic: "toc-from-parser-sections",
  });

  return tocNode;
}

// ─────────────────────────────────────────────────────────────
// Landmark hoisting
// ─────────────────────────────────────────────────────────────

/**
 * The set of XR primitive types that belong at the top-level scene, each
 * assigned to their own spatial slot by the engine's landmark classifier.
 *
 * When the parser folds these into `main`'s subtree (because they appear
 * as DOM siblings of the main content that get captured by `resolveChildren`),
 * the mapper must extract them from `XRContentPanel.children` and promote
 * them to direct scene children so the engine slots them correctly.
 */
const LANDMARK_TYPES_TO_HOIST = new Set<XRPrimitiveType>([
  "XRBanner",
  "XRFooter",
  // XRComplementary is hoisted so the engine slots it into the complementary
  // slot (right-side panel) as a persistent landmark. Leaving it inside
  // XRContentPanel caused it to be page-gated (pageIndex matched only one page
  // of the main content) so it vanished when the user navigated past page 0.
  "XRComplementary",
]);

/**
 * Walk the direct children of an XRContentPanel and pull out any primitive
 * whose type belongs at top-level scene scope (banner, footer, complementary).
 *
 * Mutates `contentPanel.children` in place — removes hoisted primitives.
 * Returns the hoisted primitives in document order so the caller can insert
 * them into `sceneChildren` at the appropriate position.
 *
 * Why mutate rather than rebuild:
 *   The content panel was just constructed; no other reference holds its
 *   children array yet. Mutating avoids an unnecessary object spread and
 *   keeps the registered primitive reference in `ctx.primitives` valid.
 */
function hoistLandmarkChildren(contentPanel: XRPrimitive): XRPrimitive[] {
  const hoisted: XRPrimitive[] = [];
  const kept: XRPrimitive[] = [];

  for (const child of contentPanel.children) {
    const shouldHoist = LANDMARK_TYPES_TO_HOIST.has(child.type);

    if (shouldHoist) {
      hoisted.push(child);
    } else {
      kept.push(child);
    }
  }

  // Mutate in place — preserves the registered ctx.primitives reference.
  contentPanel.children.length = 0;
  contentPanel.children.push(...kept);

  return hoisted;
}

// Entry point
// ─────────────────────────────────────────────────────────────

/**
 * Translate a parsed IR into a semantic scene.
 *
 * The returned SemanticScene contains no placement data — all spatial
 * decisions (positions, sizes, curve radii, layout strategies) are
 * deferred to the Layout stage.
 *
 * @param ir      PageIR produced by `parsePageToIR`.
 * @param config  Mapper configuration (optional).
 * @returns       SemanticScene ready for the Layout stage.
 */
export function mapIRToScene(
  ir: PageIR,
  config: MapperConfig = DEFAULT_MAPPER_CONFIG,
): SemanticScene {
  const ctx: MappingContext = {
    ir,
    config,
    primitives: {},
    diagnostics: {
      unmappedCount: 0,
      unmappedRoles: [],
      mergedCount: 0,
      elisionCount: 0,
      totalIRNodes: 0,
      totalPrimitives: 0,
      appliedRules: {},
    },
  };

  const rootIRNode = ir.nodes[ir.root];
  if (!rootIRNode) {
    throw new Error(`IR root node "${ir.root}" not found in nodes dictionary.`);
  }

  const sceneChildren: XRPrimitive[] = [];

  const rootPrimitive = mapNode(rootIRNode, ctx);

  if (rootPrimitive) {
    // Problem 1 fix: landmarks that the parser folded into XRContentPanel's
    // subtree must be promoted to top-level scene children so the engine
    // can slot them into their correct spatial positions (banner slot,
    // footer slot, complementary slot). hoistLandmarkChildren mutates
    // rootPrimitive.children in place and returns the extracted primitives.
    const hoisted =
      rootPrimitive.type === "XRContentPanel"
        ? hoistLandmarkChildren(rootPrimitive)
        : [];

    sceneChildren.push(rootPrimitive);

    // The layout engine has a single global complementary slot. If a page has
    // more than one top-level <aside>, each hoisted XRComplementary targets
    // that same slot and the engine bumps the surplus into the MAIN slot —
    // rendering it directly on top of the content panel (aside title overlaps
    // the section title). Merge all hoisted complementary landmarks into one
    // panel so they share the single global slot (stacked), never main.
    // Section-scoped asides are not hoisted (they stay inside the content
    // panel and are re-homed at layout time), so this only affects genuine
    // page-level asides.
    const complementary = hoisted.filter((h) => h.type === "XRComplementary");
    const others = hoisted.filter((h) => h.type !== "XRComplementary");

    sceneChildren.push(...others);

    if (complementary.length > 0) {
      const merged = complementary[0];
      for (const extra of complementary.slice(1)) {
        merged.children.push(...extra.children);
        merged.sourceIds.push(...extra.sourceIds);
        // Orphan the now-empty surplus container so the engine doesn't try to
        // place it (its children now live under `merged`).
        delete ctx.primitives[extra.id];
      }
      sceneChildren.push(merged);
    }
  }

  const toc = synthesiseTOC(ir, ctx);
  if (toc) sceneChildren.unshift(toc);

  const rootScene: XRScene = {
    id: "scene",
    type: "XRScene",
    label: ir.meta.title,
    sourceIds: [ir.root],
    confidence: 1.0,
    depth: 0,
    content: null,
    // placement: absent — Layout sets the scene root transform
    children: sceneChildren,
    relations: {
      controls: [],
      labelledBy: [],
      describedBy: [],
      details: [],
      errorMessage: [],
    },
    pageTitle: ir.meta.title,
    readingOrder: ir.readingOrder,
  };

  ctx.primitives["scene"] = rootScene;
  console.log(rootScene, ctx.primitives);
  return {
    root: rootScene,
    primitives: ctx.primitives,
    readingOrder: ir.readingOrder,
    diagnostics: ctx.diagnostics,
  };
}
