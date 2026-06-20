// ─────────────────────────────────────────────────────────────
// Template selection
// ─────────────────────────────────────────────────────────────

import type { SemanticScene, XRPrimitive, XRParagraph } from "../mapper/types";
import type { LayoutTemplate } from "./types";

/**
 * Inspect a SemanticScene and select the best-fit layout template.
 *
 * Decision logic:
 *  - "form"      — XRFormPanel present as a main-slot child, no long-form text
 *  - "dashboard" — XRList child count > threshold, or many XRTable nodes
 *  - "landing"   — XRBanner present, few sections, short total text
 *  - "document"  — default for long-form content (articles, docs, blogs)
 *  - "generic"   — fallback
 *
 * Callers may override by passing an explicit `template` to `computeLayoutPlan`.
 */
export function selectLayoutTemplate(scene: SemanticScene): LayoutTemplate {
  const children = scene.root.children;

  let hasForm = false;
  let hasBanner = false;
  let listCount = 0;
  let tableCount = 0;
  let sectionCount = 0;
  let totalWordCount = 0;

  function walk(primitives: XRPrimitive[]): void {
    for (const p of primitives) {
      if (p.type === "XRFormPanel") hasForm = true;
      if (p.type === "XRBanner") hasBanner = true;
      if (p.type === "XRList") listCount++;
      if (p.type === "XRTable") tableCount++;
      if (p.type === "XRSection" || p.type === "XRArticle") sectionCount++;
      if (p.type === "XRParagraph") {
        totalWordCount += (p as XRParagraph).wordCount ?? 0;
      }
      if (p.children.length > 0) walk(p.children);
    }
  }
  walk(children);

  if (hasForm && totalWordCount < 300) return "form";
  if (listCount >= 2 || tableCount >= 2) return "dashboard";
  if (hasBanner && sectionCount <= 3 && totalWordCount < 600) return "landing";
  if (totalWordCount > 200 || sectionCount >= 2) return "document";
  return "generic";
}
