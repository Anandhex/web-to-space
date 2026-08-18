/**
 * layout/content-only.ts
 *
 * Content-only folding for page views (wall/deck/rooms): the spatial
 * page set replaces the landmark side panels, so XRContentPanel becomes the
 * only panel. This pure scene→scene pass re-parents the top-level landmarks
 * that carry CONTENT into the content panel's child flow, in reading order:
 *
 *   • XRBanner        → prepended (top of page 1)
 *   • XRComplementary → at its document position relative to the panel
 *                       (before-panel asides prepend after the banner,
 *                       after-panel asides append before the footer)
 *   • XRFooter        → appended (end of the last page)
 *
 * XRNavigationBar / TOC stay at the top level — the engine gives them
 * suppressed stub entries instead (the page set itself is the navigation).
 * XRDialog / XRAlert stay too: modal overlays keep their template slots.
 *
 * Folded landmarks keep their mapper-emitted types (the mapper is frozen —
 * no new primitive types); they paginate as ordinary in-flow children
 * because content-only slot rosters have no complementary/banner/footer
 * slot, so no extraction pass ever fires. Only the root and the content
 * panel are cloned; every other primitive object is reused untouched, and
 * the pass never mutates its input (safe to re-run — idempotent by
 * construction since it builds from the original scene each time).
 */
import type { SemanticScene, XRPrimitive } from "../mapper/types";

const FOLDED_TYPES = new Set(["XRBanner", "XRComplementary", "XRFooter"]);

/** True when a scene has a top-level content panel and something to fold. */
export function sceneHasFoldableLandmarks(scene: SemanticScene): boolean {
  const kids = scene.root.children;
  return (
    kids.some((p) => p.type === "XRContentPanel") &&
    kids.some((p) => FOLDED_TYPES.has(p.type))
  );
}

export function foldSceneContentOnly(scene: SemanticScene): SemanticScene {
  const kids = scene.root.children;
  const panel = kids.find((p) => p.type === "XRContentPanel");
  if (!panel || !sceneHasFoldableLandmarks(scene)) return scene;

  const panelIdx = kids.indexOf(panel);
  const banners: XRPrimitive[] = [];
  const beforeAsides: XRPrimitive[] = [];
  const afterAsides: XRPrimitive[] = [];
  const footers: XRPrimitive[] = [];
  const keptTopLevel: XRPrimitive[] = [];

  kids.forEach((p, i) => {
    if (p === panel) return; // re-inserted as the clone below
    switch (p.type) {
      case "XRBanner":
        banners.push(p);
        return;
      case "XRFooter":
        footers.push(p);
        return;
      case "XRComplementary":
        (i < panelIdx ? beforeAsides : afterAsides).push(p);
        return;
      default:
        keptTopLevel.push(p);
    }
  });

  const foldedPanel: XRPrimitive = {
    ...(panel as object),
    children: [
      ...banners,
      ...beforeAsides,
      ...panel.children,
      ...afterAsides,
      ...footers,
    ],
  } as XRPrimitive;

  // Preserve the panel's original position among the survivors so reading
  // order (and the renderer's dispatch order) is stable.
  const newChildren: XRPrimitive[] = [];
  let inserted = false;
  kids.forEach((p) => {
    if (p === panel) {
      newChildren.push(foldedPanel);
      inserted = true;
    } else if (keptTopLevel.includes(p)) {
      newChildren.push(p);
    }
  });
  if (!inserted) newChildren.push(foldedPanel);

  const newRoot = {
    ...(scene.root as object),
    children: newChildren,
  } as typeof scene.root;

  return {
    ...scene,
    root: newRoot,
    primitives: {
      ...scene.primitives,
      [newRoot.id]: newRoot,
      [foldedPanel.id]: foldedPanel,
    },
  };
}
