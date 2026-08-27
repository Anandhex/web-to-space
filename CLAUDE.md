# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev        # Start dev server (includes CORS proxy at /api/proxy?url=)
npm run build      # Type-check + Vite production build
npm run preview    # Serve the dist/ output locally
```

There is no linter and no test *runner*, but there are checks, and they are the
gate on anything touching links or the parser:

```bash
npm run test:links    # link classification against the gold set
npm run test:memory   # nav memory (reader-relative corridors)
npm run test:slots    # door/slot budgets
npm run benchmark     # offline parser benchmark: segmentation + XR legibility
npm run census        # link census over the fetched corpus
```

TypeScript strictness (`noUnusedLocals`, `noUnusedParameters`, `erasableSyntaxOnly`) is enforced at build time. `npm run build` runs `tsc` over the WHOLE project, so it goes red on faults in files you did not touch — run `npx tsc --noEmit` and read which files the errors are in before assuming a change broke it.

The dev server requires HTTPS for WebXR — `@vitejs/plugin-basic-ssl` is included. Set `NO_SSL=1` to serve plain HTTP instead, which is how the in-app browser preview and any tool that cannot follow a self-signed cert reach it (WebXR is unavailable in that mode; everything else renders).

## Architecture: 5-Stage Pipeline

```
HTML → Parser → IR → Mapper → SemanticScene → Layout Engine → LayoutPlan → Renderer
```

Each stage is a pure function. Nothing mutates shared state between stages.

### Stage 1 — Parser (`src/ir/`)

`parsePageToIR(html, url, fallbackProvider?, config?)` → `Promise<PageIR>`

Async, and `url` is the SECOND argument — it is the base every relative and
protocol-relative asset URL is resolved against, so passing a config there
throws `ERR_INVALID_URL` on the first `//host/…` image.

Converts raw HTML into an accessibility-semantic intermediate representation using ARIA roles, labels, and structural inference. The IR is a flat dictionary (`PageIR.nodes: Record<string, IRNode>`) with string IDs to avoid reference cycles. `IRNode.readingDepth` tracks semantic containment depth (0 = top-level landmark).

Three-layer classification:
1. Explicit ARIA `role=` attributes
2. Structural inference (heading-bounded sections, link-runs → nav, paragraph-runs → article)
3. AI fallback (`src/ir/ai/` — Claude / OpenAI / Gemini / Ollama adapters behind one `AIFallbackProvider`; the reader supplies the key on the Home screen)

Layer 3 is **batched, not per-node**: the walk parks every unclassified node on `BuildContext.aiQueue` and `parsePageToIR` drains it with a single `classifyBatch` call after the walk (`applyAIClassifications`), which the provider chunks by `batchSize` and runs `maxConcurrent` at a time. An answer is only taken when it clears `aiFallbackThreshold` and beats the node's own confidence; anything else leaves the structural role alone. With no provider configured the parser holds a `StubAIProvider` and the whole layer is a no-op — parses are identical to what they were before it existed, and nothing leaves the browser.

Controlled by `ParserConfig` — individual layers can be disabled for testing.

### Stage 2 — Mapper (`src/mapper/`)

`mapIRToScene(ir, config)` → `SemanticScene`

Translates each `IRRole` to a typed `XRPrimitiveType`. Every IR node is mapped — unmapped roles fall through to `XRGenericPanel` rather than being dropped. The mapper never assigns spatial positions; it only extracts semantic facts (ARIA relations, state, counts) that the layout engine needs.

The full mapping table is the `MappingRule` union type in `src/mapper/types.ts`.

### Stage 3 — Layout Engine (`src/layout/engine.ts`)

`computeLayoutPlan(scene, profile, configOverrides?, metricsOverrides?, arrangement?)` → `LayoutPlan`

The `DeviceProfile` supplies both the `LayoutConfig` and the `RenderMetrics`;
the two override arguments are partials merged over it. `arrangement` is what
the page views (rooms/wall/deck) pass — see `getArrangement` in
`src/layout/placement.ts`.

Places every primitive in 3D space. Outputs a flat `LayoutPlan.entries: Record<string, LayoutEntry>` — one entry per primitive. All measurements are in **metres**, WebXR right-handed coordinate system.

**Coordinate contract (critical):**
- Top-level landmark panels → **world space** (relative to scene origin)
- All primitives inside an `XRContentPanel` → **panel-absolute space** (relative to the panel's top-left origin at `(0, 0, 0)`)
- The renderer applies a single `<group position={[x, y, z]}>` per primitive. There is no parent-relative nesting; children are dispatched as siblings.

**Pagination:** `XRContentPanel` is the only container that paginates. `paginateContentPanel()` runs a `stampDescendants` pass that writes panel-absolute positions for every descendant into `placedPositionMap` so the renderer always reads a uniform coordinate system regardless of nesting depth.

Landmark slot placement comes from ONE hand-tuned desk (`selectSlots` in `src/layout/placement.ts`), sized off the device profile's comfort cone. It offers exactly three slots — `main`, `alert`, `dialog`. The rails (`toc` / `navigation` / `complementary`) and the whole shared-cylinder geometry that placed them were removed 2026-08-19, along with `selectLayoutTemplate` and the `document | landing | generic` union: all three shipped views are page views, so `resolveArrangementSlots` collapsed the roster to `[main]` and every rail was computed and thrown away on every layout. A `<nav>` / `<aside>` / `<header>` now folds into the content panel's flow (`foldForArrangement` in `src/layout/content-only.ts`) instead of getting a panel of its own. Any caller that builds a plan MUST pass an arrangement and fold through that helper — the no-arrangement path exists only as a type-level default and places landmarks on top of the main panel. If you find a reference to a layout template or a rail slot anywhere, it is stale.

Device profiles are in `src/layout/profiles.ts`. There is only ONE — `QUEST_3_PROFILE` — and `XRSceneRenderer` hard-codes it; the Home screen's device picker does not reach layout. (`QUEST_PRO_PROFILE` and `RAY_BAN_META_PROFILE` are referenced in comments but do not exist.)

### Stage 4 — Renderer (`src/renderer/`)

`<XRSceneRenderer>` accepts `html`, `url`, or a pre-built `scene` prop. It runs all three pipeline stages internally (`parsePageToIR` → `mapIRToScene` → `computeLayoutPlan`), then renders the `LayoutPlan` into a React Three Fiber `<Canvas>`.

Key renderer rules:
- Each primitive gets `<AtPos entry={...}>` wrapping its visual mesh.
- The mesh itself receives `zeroedEntry()` — it never re-applies its own position.
- Children of a panel are dispatched via `<DispatchChildren>` as siblings (not nested), because their positions are already panel-absolute.
- Clipping planes for `XRContentPanel` are provided via `ClipPlanesContext` to prevent child geometry bleeding outside the panel viewport.
- Page visibility is gated by `CurrentPageContext` — primitives return `null` if their `pageIndex` differs from the current page.

Primitive meshes are in `src/renderer/primitives.tsx`. Text rendering uses `troika-three-text` via `@react-three/drei`'s `<Text>`.

### Stage 5 — XR Session (`src/renderer/`)

XR lives in the renderer, not in a module of its own. (An `src/xr/` existed until 2026-08-18 with its own session manager and controller raycasting; nothing had imported it in months and it was deleted. If you find it referenced anywhere, that reference is stale.)

`<XR store>` mounts the controllers and hands itself — do not hand-roll target-ray/grip mounting. (A `scene/xr-input.tsx` doing exactly that survived the move to @react-three/xr v6 unreferenced, and was deleted with `src/xr/`.)

The live path is:

- `useXRSession.tsx` — owns the `@react-three/xr` store and adapts it to the DOM-side session API (VRButton) plus the flat-preview gating. The store is used rather than a raw `navigator.xr.requestSession()` precisely because R3F's declarative handlers (`onClick` / `onPointerOver`) are sourced from DOM pointer events, which an immersive session never delivers — every handler went dead inside VR under the old approach.
- `xr-render-path.ts` — the baseLayer-vs-projection-layers decision, which must match the `layers` feature request or `setSession` throws mid-entry.
- `scene/camera.tsx` — the reference space and where the reader's eye sits relative to the panels.
- `scene/xr-locomotion.tsx` — thumbstick walk, snap turn and gaze teleport: the headset ends of the same actions the keyboard drives.

One hazard worth knowing before touching any of it: **an uncaught throw inside an XR frame ends rendering permanently** — the headset falls back to its loading environment with nothing surfaced.

## Key Invariants

- **Metres everywhere.** Never use pixel units in layout or renderer code.
- **Mapper never positions.** Any placement logic belongs in `engine.ts`.
- **No nodes dropped.** Unmapped IR roles → `XRGenericPanel`. Missing entries break the renderer.
- **`RenderMetrics` is the single source of dimensional truth.** The engine never hard-codes font sizes or element heights — they come from the active `DeviceProfile`. This includes **spacing**: `metrics.spacing` is the interior-padding ladder every primitive surface insets its content by (`hairline` / `tight` / `snug` / `comfortable` / `generous`, derived as fractions of one degree of visual angle at the profile's viewing distance), and `metrics.rhythm` is the vertical rhythm between stacked blocks (derived as fractions of the body line box). Neither belongs in a mesh as a literal — the meshes used to carry a scatter of 4/14/18/20/26 mm insets that no two primitives agreed on, and several of them silently disagreed with the height the engine had reserved.
- **Stacking gaps are pair-aware.** Every site that stacks siblings — `stackChildrenSimple` (engine), `sumChildrenHeights` (estimate) and the paginator's flow loops — calls `blockGap(prev, next, metrics)` in `src/layout/utils.ts`. A heading binds tightly to the content below it and opens a wide gap above it; a flat `config.childGapY` could not express that, and `childGapY` now survives only as the residual gap inside a single prose node.
- **UI surfaces are unlit.** `<Surface>` defaults to `meshBasicMaterial` (`flat` defaults to **true**). Cards are interface, not scenery: lit surfaces took a tint from whatever the surrounding space happened to be lit with, so the same card read warm in the rooms view and neutral elsewhere. Depth comes from the Z ladder, the rim, and the baked top-lighter gradient. Pass `flat={false}` only for something meant to be part of the room.
- **CORS proxy is dev-only.** `vite.config.ts` registers **`/api/proxy?url=`** as a Vite middleware. It is not available in the production build.
