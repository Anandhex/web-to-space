import React from "react";
import ReactDOM from "react-dom/client";
import App from "./components/App";

// three.js's WebXRManager locks in "supportsGlBinding" once at renderer
// construction time and, when present, unconditionally tries
// `new XRWebGLBinding(session, gl)` on setSession. WebXR device emulators
// (Immersive Web Emulator, etc.) polyfill navigator.xr/XRSession with plain
// JS objects that aren't a genuine native platform XRSession, so the
// browser's real XRWebGLBinding constructor throws
// "parameter 1 is not of type 'XRSession'". This app never touches the
// Layers API (projection layers, foveation-via-layers, depth sensing,
// camera access), so forcing the legacy XRWebGLLayer path is free on real
// hardware and required for emulator-based dev testing.
delete (window as unknown as { XRWebGLBinding?: unknown }).XRWebGLBinding;

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
