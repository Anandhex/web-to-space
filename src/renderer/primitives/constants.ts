import * as THREE from "three";

/**
 * primitives/constants.ts
 *
 * Fixed panel geometry + the shared Z-depth / render-order ladder for every XR
 * primitive. This is the single place to tune the spatial "look" of surfaces —
 * corner rounding, depth banding, and draw order. Colours do NOT live here;
 * they come from the live-swappable XRTheme (see ../theme).
 *
 * Every value is in metres (WebXR coordinate system).
 */

// Corner radius — soft rounding matching Horizon OS cards.
//
// Horizon OS surfaces are Unity Canvas quads: FLAT rounded rectangles whose
// corner radius is a generous fraction of the surface's shorter edge. The
// old panels used drei <RoundedBox>, whose radius is a 3D bevel constrained
// to `< depth / 2`; with PANEL_DEPTH = 0.01 that hard-capped every corner at
// 5 mm no matter the panel size, so a half-metre panel rounded the same tiny
// amount as a chip and read as a square block — and "pill" buttons weren't
// actually pills. Panels now render through <Surface> (a flat rounded-rect
// ShapeGeometry) whose radius is decoupled from depth, so we can use a
// Horizon-scale radius. PANEL_RADIUS is kept only as a small floor for the
// few remaining legacy <RoundedBox> call sites.
const PANEL_RADIUS = 0.004;
export const PANEL_DEPTH = 0.01;

// Horizon rounds ~1/12 of the shorter edge, clamped to a sane metric range so
// large content panels don't turn into lozenges and tiny chips still round
// visibly.
export const CORNER_FRACTION = 1 / 12;
export const CORNER_MIN = 0.006;
export const CORNER_MAX = 0.03;

// ── Z-depth ladder & render order ────────────────────────────────────────────
// A single monotonic stack of depth bands shared by every primitive. All
// panels are near-coplanar in XR (millimetre-scale Z gaps), and troika text +
// transparent image planes rely on THREE's transparent-object sort, which is
// unstable at those gaps — content bled through panels and through each other.
// Two rules fix it and MUST be kept in lockstep:
//   1. Each visual role sits at its own Z band, strictly increasing toward the
//      viewer: surface fill → accent/stripe → content text → image → overlay.
//   2. renderOrder increases the same way, so the draw order is deterministic
//      regardless of camera-distance sort. Never place two different roles at
//      the same (Z, renderOrder).
// Bands are expressed as offsets in front of a surface's front face (z = 0 in
// panel-local space; surfaces themselves are pushed slightly behind via
// Z_SURFACE).
export const Z_SURFACE = -0.0006; // panel fill sits just behind the content plane
export const Z_SURFACE_RIM = Z_SURFACE - 0.0004; // border peeks out behind the fill
export const Z_LAYER_ACCENT = 0.0008; // accent bars / stripes / selection pills
export const Z_LAYER_INLINE_TEXT = 0.002; // inline prose runs
export const Z_LAYER_BODY_TEXT = 0.0028; // block body text
export const Z_LAYER_IMAGE = 0.0034; // image / poster planes
export const Z_LAYER_OVERLAY_TEXT = 0.0046; // labels/icons drawn on top of imagery

// Base forward lift (metres, toward the viewer) for content inside a CURVED
// panel, added on top of the per-element sagitta (see curveLift in curve.ts).
// The sagitta R·(1−cos(x/R)) puts the element on the backing cylinder at its own
// x; this small base then clears it just in front of the backing so it reads
// without grazing/z-fighting. Keep it SMALL — too large and content floats
// noticeably off the surface toward the viewer. Zero effect on flat panels.
export const Z_CURVE_CONTENT_BASE_LIFT = 0.008;

export const RENDER_ORDER_SURFACE = 0;
export const RENDER_ORDER_ACCENT = 1;
export const RENDER_ORDER_IMAGE = 2;
export const RENDER_ORDER_TEXT = 3;

// Flat rounded-rect ShapeGeometry rounds freely, but a degenerate w/h still
// produces NaN corners — floor both to a small safe minimum.
export const MIN_DIM = PANEL_RADIUS * 2 + 0.001; // 0.025 m — safe floor for w and h


// ── Hit targets ──────────────────────────────────────────────────────────────
/**
 * The material every invisible pointer target shares.
 *
 * A hit target is a quad that exists only to be raycast: a generous, regular
 * grab area over something whose visible geometry is small, irregular, or (for
 * text) not raycastable at glyph resolution. It is never meant to be SEEN.
 *
 * The old spelling — `transparent opacity={0}` — got that wrong in the way
 * that costs the most. A fully transparent fragment is still a fragment: the
 * mesh joins the render list, takes a draw call, and lands in the depth-sorted
 * TRANSPARENT pass, which is the expensive one. Measured on the deck view of
 * the Wikipedia "Space" article, 140 of 671 draw calls were invisible hit
 * targets — a fifth of the frame spent rasterising nothing at all.
 *
 * `visible: false` on the MATERIAL is the fix, and it is not the same as
 * `visible={false}` on the mesh. Three's projectObject only adds an object to
 * the render list `if ( material.visible )`, so the draw call disappears —
 * while Raycaster tests only layers and geometry and never consults the
 * material, so the target stays exactly as hittable as it was. Hiding the MESH
 * would have taken it out of both.
 *
 * (Layers look like the other way to do this and are a trap here: three
 * reserves layers 1 and 2 for the left and right eyes in an XR session —
 * `cameraL.layers.mask = cameraXR.layers.mask & -5` — so a target parked there
 * would render to one eye and give the reader a monocular ghost.)
 *
 * One module-level instance, shared by every call site: these carry no colour,
 * no opacity and no clipping, so there is nothing to vary. Meshes using it
 * must pass `dispose={null}` — it outlives any one of them.
 */
export const HIT_TARGET_MATERIAL = /* @__PURE__ */ (() => {
  const m = new THREE.MeshBasicMaterial();
  m.visible = false;
  return m;
})();
