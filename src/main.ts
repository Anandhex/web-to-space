import * as THREE from "three";
import { collectLandmarkIds, parsePageToIR } from "./ir/parser";
import { SpatialShell } from "./layout/SpatialShell";
import { createXRLayer } from "./xr/index";
import type { XRLayer } from "./xr/index";

// ─── Renderer ─────────────────────────────────────────────────────────────────

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.xr.enabled = true;
document.body.appendChild(renderer.domElement);

// ─── Scene ────────────────────────────────────────────────────────────────────

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0a0a0f);

const camera = new THREE.PerspectiveCamera(
  70,
  window.innerWidth / window.innerHeight,
  0.01,
  20,
);
camera.position.set(0, 1.6, 0); // average standing eye height

// ─── Lighting ─────────────────────────────────────────────────────────────────

const ambient = new THREE.AmbientLight(0xffffff, 0.6);
scene.add(ambient);

const directional = new THREE.DirectionalLight(0xffffff, 0.8);
directional.position.set(1, 2, 1);
scene.add(directional);

// ─── State ────────────────────────────────────────────────────────────────────

let shell: SpatialShell | null = null;
let xrLayer: XRLayer | null = null;
let setStatusRef: ((msg: string, isError?: boolean) => void) | null = null;

// ─── Hit Handler ──────────────────────────────────────────────────────────────

function onHit(nodeId: string, role: string, controls: string | null): void {
  console.log(`[XR Hit] nodeId=${nodeId} role=${role}`);
  if (controls && shell) {
    shell.focusNode(controls);
    setStatusRef?.(`Focused section: ${controls}`);
  }
}

// ─── XR Layer Init ────────────────────────────────────────────────────────────

function getInteractives(): THREE.Object3D[] {
  return shell ? shell.getInteractives() : [];
}

xrLayer = createXRLayer(renderer, scene, camera, getInteractives, onHit);

// ─── Resize ───────────────────────────────────────────────────────────────────

window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ─── Render Loop ──────────────────────────────────────────────────────────────

renderer.setAnimationLoop(() => {
  xrLayer?.desktopControls?.update();
  renderer.render(scene, camera);
});

// ─── Page Load ────────────────────────────────────────────────────────────────

// ─── UI ───────────────────────────────────────────────────────────────────────
window.addEventListener("DOMContentLoaded", () => {
  async function fetchHTML(url: string): Promise<string> {
    const res = await fetch(`/proxy?url=${encodeURIComponent(url)}`);
    if (!res.ok)
      throw new Error(`Fetch failed: ${res.status} ${res.statusText}`);
    return res.text();
  }

  async function loadPage(url: string): Promise<void> {
    // Tear down existing shell
    if (shell) {
      shell.dispose();
      shell = null;
    }

    setStatus("Fetching page...");

    try {
      const html = await fetchHTML(url);
      setStatus("Parsing IR...");
      const ir = await parsePageToIR(html, url);
      console.log("Parsed IR:", ir);
      setStatus("Building spatial shell...");
      shell = new SpatialShell(scene, ir);
      shell.build();

      setStatus(
        `Loaded — ${Object.keys(ir.nodes).length} nodes, ${collectLandmarkIds(ir.landmarks).length} landmarks`,
      );
    } catch (err) {
      setStatus(`Error: ${String(err)}`, true);
    }
  }

  const input = document.getElementById("url-input") as HTMLInputElement;
  const parseBtn = document.getElementById("parse-btn") as HTMLButtonElement;
  const xrBtn = document.getElementById("xr-btn") as HTMLButtonElement;
  const statusEl = document.getElementById("status") as HTMLDivElement;

  function setStatus(msg: string, isError = false): void {
    statusEl.textContent = msg;
    statusEl.className = isError ? "error" : "";
  }

  setStatusRef = setStatus;

  parseBtn.addEventListener("click", async () => {
    const url = input.value.trim();
    if (!url) {
      setStatus("Enter a URL first.", true);
      return;
    }
    parseBtn.disabled = true;
    await loadPage(url);
    parseBtn.disabled = false;
  });

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") parseBtn.click();
  });

  xrBtn.addEventListener("click", async () => {
    if (!xrLayer) return;
    if (!xrLayer.sessionManager.isSupported) {
      setStatus("WebXR not supported on this device.", true);
      return;
    }
    try {
      await xrLayer.enterXR();
      setStatus("XR session active");
    } catch (err) {
      setStatus(`XR error: ${String(err)}`, true);
    }
  });

  navigator.xr?.isSessionSupported("immersive-vr").then((supported) => {
    xrBtn.style.display = supported ? "inline-block" : "none";
  });
});
