# Web-to-Space

A spatial web browser that converts any web page into an interactive 3D scene for AR/VR headsets.

Instead of showing a flat browser window inside a headset, **Web-to-Space** understands the semantic structure of a page — navigation, articles, forms, buttons — and lays them out spatially in 3D space using WebXR.

---

## What it does

1. You enter any URL
2. The page is fetched and parsed into a semantic accessibility tree (ARIA roles, headings, landmarks)
3. Semantic elements are mapped to 3D primitives — panels, buttons, text blocks, nav rails
4. A layout engine positions everything in 3D space (in metres, for XR viewports)
5. The scene renders inside a WebXR session with hand/controller interaction
   https://from-space-to-web.vercel.app - link to the weboage

---

## View Modes

Switch between five spatial layout modes:

| Mode         | Description                                    |
| ------------ | ---------------------------------------------- |
| **Standard** | Landmark panels spread across the scene        |
| **Carousel** | Pages arc around the user in a cylinder        |
| **Cards**    | Content as floating cards in front of the user |
| **Door**     | Full-height vertical panels like open doors    |
| **Theatre**  | Wide-screen presentation layout                |

---

## Architecture

```
HTML → Parser → IR → Mapper → Layout Engine → Renderer (WebXR)
```

Each stage is a pure function with no shared mutable state:

- `src/ir/` — parses HTML into an intermediate semantic representation
- `src/mapper/` — maps IR nodes to typed 3D primitives
- `src/layout/` — places primitives in 3D space (world-space and panel-local coordinates)
- `src/renderer/` — renders the layout as Three.js meshes in a React Three Fiber canvas
- `src/xr/` — WebXR session management and controller raycasting
- `src/components/` — tab bar, home screen, view toggle UI

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

> HTTPS is required — the dev server uses `@vitejs/plugin-basic-ssl` to self-sign a certificate. Accept the browser warning on first load.

A CORS proxy is included at `/proxy?url=` so you can fetch arbitrary external URLs during development.

```bash
npm run build    # type-check + production build
npm run preview  # serve the dist/ output locally
```

---

## Target devices

Tested profiles: Meta Quest 3, Meta Quest Pro, Ray-Ban Meta glasses.  
Any WebXR-capable browser/headset should work.
