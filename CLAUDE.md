# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev        # Start dev server (includes CORS proxy at /proxy?url=)
npm run build      # Type-check + Vite production build
npm run preview    # Serve the dist/ output locally
```

There is no test runner or linter configured. TypeScript strictness (`noUnusedLocals`, `noUnusedParameters`, `erasableSyntaxOnly`) is enforced at build time.

The dev server requires HTTPS for WebXR — `@vitejs/plugin-basic-ssl` is included.

## Architecture: 5-Stage Pipeline

```
HTML → Parser → IR → Mapper → SemanticScene → Layout Engine → LayoutPlan → Renderer
```

Each stage is a pure function. Nothing mutates shared state between stages.

### Stage 1 — Parser (`src/ir/`)

`parsePageToIR(html, config, url)` → `PageIR`

Converts raw HTML into an accessibility-semantic intermediate representation using ARIA roles, labels, and structural inference. The IR is a flat dictionary (`PageIR.nodes: Record<string, IRNode>`) with string IDs to avoid reference cycles. `IRNode.readingDepth` tracks semantic containment depth (0 = top-level landmark).

Three-layer classification:
1. Explicit ARIA `role=` attributes
2. Structural inference (heading-bounded sections, link-runs → nav, paragraph-runs → article)
3. AI fallback (stubbed via `StubAIProvider` — swap in a real provider via `AIFallbackProvider` interface)

Controlled by `ParserConfig` — individual layers can be disabled for testing.

### Stage 2 — Mapper (`src/mapper/`)

`mapIRToScene(ir, config)` → `SemanticScene`

Translates each `IRRole` to a typed `XRPrimitiveType`. Every IR node is mapped — unmapped roles fall through to `XRGenericPanel` rather than being dropped. The mapper never assigns spatial positions; it only extracts semantic facts (ARIA relations, state, counts) that the layout engine needs.

The full mapping table is the `MappingRule` union type in `src/mapper/types.ts`.

### Stage 3 — Layout Engine (`src/layout/engine.ts`)

`computeLayoutPlan(scene, config, metrics, profileOrTemplate?)` → `LayoutPlan`

Places every primitive in 3D space. Outputs a flat `LayoutPlan.entries: Record<string, LayoutEntry>` — one entry per primitive. All measurements are in **metres**, WebXR right-handed coordinate system.

**Coordinate contract (critical):**
- Top-level landmark panels → **world space** (relative to scene origin)
- All primitives inside an `XRContentPanel` → **panel-absolute space** (relative to the panel's top-left origin at `(0, 0, 0)`)
- The renderer applies a single `<group position={[x, y, z]}>` per primitive. There is no parent-relative nesting; children are dispatched as siblings.

**Pagination:** `XRContentPanel` is the only container that paginates. `paginateContentPanel()` runs a `stampDescendants` pass that writes panel-absolute positions for every descendant into `placedPositionMap` so the renderer always reads a uniform coordinate system regardless of nesting depth.

Template selection (`selectLayoutTemplate`) classifies the scene as `"document" | "dashboard" | "form" | "landing" | "generic"` and drives landmark slot placement.

Device profiles are in `src/layout/profiles.ts`: `QUEST_3_PROFILE`, `QUEST_PRO_PROFILE`, `RAY_BAN_META_PROFILE`.

### Stage 4 — Renderer (`src/renderer/`)

`<XRSceneRenderer>` accepts `html`, `url`, or a pre-built `scene` prop. It runs all three pipeline stages internally (`parsePageToIR` → `mapIRToScene` → `computeLayoutPlan`), then renders the `LayoutPlan` into a React Three Fiber `<Canvas>`.

Key renderer rules:
- Each primitive gets `<AtPos entry={...}>` wrapping its visual mesh.
- The mesh itself receives `zeroedEntry()` — it never re-applies its own position.
- Children of a panel are dispatched via `<DispatchChildren>` as siblings (not nested), because their positions are already panel-absolute.
- Clipping planes for `XRContentPanel` are provided via `ClipPlanesContext` to prevent child geometry bleeding outside the panel viewport.
- Page visibility is gated by `CurrentPageContext` — primitives return `null` if their `pageIndex` differs from the current page.

Primitive meshes are in `src/renderer/primitives.tsx`. Text rendering uses `troika-three-text` via `@react-three/drei`'s `<Text>`.

### Stage 5 — XR Session (`src/xr/`)

`createXRSessionManager()` wires up `THREE.WebGLRenderer.xr`, two controllers with raycaster hit-detection, and a per-frame ray update loop. Hit objects expose `userData.nodeId` / `userData.role` / `userData.controls` for interaction routing. The session bridge (`src/renderer/useXRSession.tsx`) integrates this with the React Three Fiber renderer.

## Key Invariants

- **Metres everywhere.** Never use pixel units in layout or renderer code.
- **Mapper never positions.** Any placement logic belongs in `engine.ts`.
- **No nodes dropped.** Unmapped IR roles → `XRGenericPanel`. Missing entries break the renderer.
- **`RenderMetrics` is the single source of dimensional truth.** The engine never hard-codes font sizes or element heights — they come from the active `DeviceProfile`.
- **CORS proxy is dev-only.** `vite.config.ts` registers `/proxy?url=` as a Vite middleware. It is not available in the production build.
