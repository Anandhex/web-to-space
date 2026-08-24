# Web-to-Space

A spatial web browser that converts any web page into an interactive 3D scene for AR/VR headsets.

Instead of showing a flat browser window inside a headset, **Web-to-Space** understands the semantic structure of a page — navigation, articles, forms, buttons — and lays them out spatially in 3D space using WebXR.

---

## What it does

1. You enter any URL
2. The page is fetched and parsed into a semantic accessibility tree (ARIA roles, headings, landmarks)
3. Semantic elements are mapped to 3D primitives — panels, buttons, text blocks, nav rails
4. A layout engine positions everything in 3D space (in metres, for XR viewports)
5. The scene renders inside a WebXR session, navigable with controllers or bare hands

Live: **https://from-space-to-web.vercel.app**

---

## View Modes

Three spatial views. Each is a different *kind* of spatial interaction with the
document, not a different layout of the same one:

| Mode      | You…                                                    | The document is…                                                                |
| --------- | ------------------------------------------------------- | ------------------------------------------------------------------------------- |
| **Rooms** | navigate the site as an environment you walk through    | a building: one gallery per section, corridors to its links                       |
| **Wall**  | see the site as one spatial structure you survey at once | an outline board that opens a level at a time                                     |
| **Deck**  | handle the page's parts as objects on a surface          | a table of cards you rearrange by hand                                            |

In all three the page SET becomes the spatial structure: the landmark side
panels fold into the content flow and the pages themselves are what gets
placed.

---

## Links are directions

A page's outbound links are classified by where they GO relative to where you
are — up to a parent, sideways to a sibling, down and out to another site — and
each view gives that direction a spatial form. In **rooms** it is architecture:
a page's links open a corridor through the gallery wall beside it, with an arm
to each hand carrying that hand's siblings and a stair hall straight ahead —
up a flight to the parents' landing, down to the externals'. Walking into a
door follows the link.

Because links are directions, the route you took is a shape: the navigation
memory is **reader-relative**, so "east four times" stays a four-long corridor
of the documents you walked through, seen from wherever you are now.

Design and build notes: [`docs/directional-links.md`](docs/directional-links.md).

---

## Architecture

```
HTML → Parser → IR → Mapper → Layout Engine → Renderer (WebXR)
```

Each stage is a pure function with no shared mutable state:

- `src/ir/` — parses HTML into an intermediate semantic representation
- `src/mapper/` — maps IR nodes to typed 3D primitives
- `src/layout/` — places primitives in 3D space (world-space and panel-local coordinates)
- `src/renderer/` — renders the layout as Three.js meshes in a React Three Fiber canvas, and owns the WebXR session, the controller/hand input and the three views' geometry (`src/renderer/scene/`)
- `src/links/` — link classification, direction, slot budgets and the reader-relative navigation memory
- `src/components/` — tab bar, home screen, view toggle UI
- `src/eval/` — offline benchmark and link census; runs in Node against a fetched corpus, no GPU or headset needed

Every measurement is in **metres**, in the WebXR right-handed coordinate
system. There are no pixel units below the parser.

---

## Stack

- [React 19](https://react.dev/) + TypeScript 6
- [React Three Fiber](https://docs.pmnd.rs/react-three-fiber) + [Three.js](https://threejs.org/)
- [@react-three/drei](https://github.com/pmndrs/drei) — helpers and text rendering
- [troika-three-text](https://github.com/protectwise/troika/tree/main/packages/troika-three-text) — GPU text
- [WebXR Device API](https://developer.mozilla.org/en-US/docs/Web/API/WebXR_Device_API)
- [Vite 8](https://vite.dev/) with HTTPS (required for WebXR)

---

## Running locally

```bash
npm install
npm run dev      # starts dev server at https://localhost:5173
```

> HTTPS is required — the dev server uses `@vitejs/plugin-basic-ssl` to self-sign a certificate. Accept the browser warning on first load. It binds `0.0.0.0`, so a headset on the same network can reach `https://<your-ip>:5173` directly; a LAN IP over plain HTTP is not a secure context and WebXR will refuse it.

Set `NO_SSL=1` to serve plain HTTP instead — useful for browser previews and tools that cannot follow a self-signed certificate. Everything renders in that mode except WebXR itself.

A CORS proxy is included at `/api/proxy?url=` so you can fetch arbitrary external URLs during development. It is a Vite middleware, so it exists in `npm run dev` only — never in the production build.

```bash
npm run build    # type-check + production build
npm run preview  # serve the dist/ output locally
```

### Checks

No test runner, but the link and parser layers have offline checks that run in
Node — no browser, no GPU, no headset:

```bash
npm run test:links    # link classification against the gold set
npm run test:memory   # navigation memory
npm run test:slots    # door/slot budgets
npm run benchmark     # parser benchmark: segmentation + XR legibility metrics
```

---

## Target devices

A device profile is the single source of dimensional truth — eye height,
viewing distance, panel viewport, font sizes — so the layout engine hard-codes
none of them and a new headset is a new profile, not a new layout. Panel width,
for instance, is derived as `2 · viewingDistance · tan(comfortHalfAngleDeg)`
rather than stored.

`src/layout/profiles.ts` exports exactly **one** profile, `QUEST_3_PROFILE`,
and `XRSceneRenderer` hard-codes it (`XRSceneRenderer.tsx:213`). Quest 3 is the
device the system is developed against. The Home screen's device picker selects
a view roster, not a layout profile — it does not reach the layout engine.
`QUEST_PRO_PROFILE` and `RAY_BAN_META_PROFILE` appear in older comments and in
the `ViewDeviceType` union in `src/components/XR3DChrome.tsx`, but no such
profiles exist; adding one is the work required to target another headset.

Any WebXR-capable browser or headset should work.
