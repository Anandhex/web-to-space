/**
 * engine/classify.ts
 *
 * Pure classification helpers used across the layout engine: the landmark→slot
 * classifier, the top-of-page origin, and the inline-flow predicates that
 * decide whether a node owns its inline children's prose (and must therefore
 * NOT position them as independent 3D nodes). No placement state lives here.
 */
import type { Vec3, XRPrimitive } from "../../mapper/types";
import type {
  LayoutConfig,
  SlotName,
  RenderMetrics,
  PrimitiveFontMetrics,
} from "../types";
import { PRIMITIVE_CONFIG } from "../positionConfigs";
import { flattenInlineWrappers, isInlinePrimitive } from "../utils";
import { INLINE_OWNING_TYPES } from "../inline-constants";

export function topOfPagePos(config: LayoutConfig): Vec3 {
  return { x: config.panelPaddingX, y: -config.panelPaddingTop, z: 0 };
}

export function classifyLandmark(primitive: XRPrimitive): SlotName {
  const cfg = PRIMITIVE_CONFIG[primitive.type];
  if (!cfg) return "main";
  if (cfg.slotFn) return cfg.slotFn(primitive);
  return cfg.slot;
}

export function inlineOwnerFontMetrics(
  node: { type: string; level?: number | null },
  metrics: RenderMetrics,
): PrimitiveFontMetrics {
  switch (node.type) {
    case "XRHeading": {
      const level = (node.level ?? 2) as 1 | 2 | 3 | 4 | 5 | 6;
      return metrics.heading[level] ?? metrics.heading[2] ?? metrics.paragraph;
    }
    case "XRBlockQuote":
      return metrics.blockQuote;
    case "XRLink":
      return metrics.link.font;
    case "XRButton":
      return metrics.button.font;
    default:
      return metrics.paragraph;
  }
}

export function isInlineOwningNode(node: {
  type: string;
  children: unknown[];
}): boolean {
  if (INLINE_OWNING_TYPES.has(node.type)) return true;
  if (node.type !== "XRGenericPanel" || node.children.length === 0)
    return false;
  const flatEffective = flattenInlineWrappers(node.children as any[]);
  return (
    flatEffective.length > 0 &&
    flatEffective.every((c: any) => isInlinePrimitive(c.type))
  );
}

export function isFlattenedIntoProse(child: {
  type: string;
  children: unknown[];
}): boolean {
  if (isInlinePrimitive(child.type)) return true;
  if (child.type !== "XRGenericPanel") return false;
  const flat = flattenInlineWrappers(child.children as any[]);
  return flat.length > 0 && flat.every((c: any) => isInlinePrimitive(c.type));
}
