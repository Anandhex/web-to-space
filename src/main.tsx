import React from "react";
import ReactDOM from "react-dom/client";
import App from "./components/App";
import {
  installXRErrorCapture,
  installXRSessionWatchdog,
} from "./renderer/xr-diagnostics";
import { selectXRRenderPath } from "./renderer/xr-render-path";

// Installed before anything else renders. A headset has no devtools, so the
// console is mirrored into a buffer the app can draw back into the page (see
// renderer/xr-diagnostics.ts and the log panel in renderer/scene/chrome.tsx) —
// and a capture that starts with the first component would miss exactly the
// startup errors that leave the reader looking at nothing.
installXRErrorCapture();

// Ends any session that never presents a frame, so a failure between
// "requestSession resolved" and "first frame drawn" drops the reader back into
// the browser with a reason instead of leaving them in the compositor's loading
// environment with no way out but the system menu. See xr-diagnostics.ts.
installXRSessionWatchdog();

// Chosen before the first WebGLRenderer exists, because three reads the
// capability once at construction — and the same decision drives whether the
// session asks for the `layers` feature (see renderer/xr-render-path.ts).
// Logged, not silent: it is captured into the in-page log, so the path actually
// taken is visible on the device where it matters.
console.warn(`[xr] render path: ${selectXRRenderPath()}`);

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
