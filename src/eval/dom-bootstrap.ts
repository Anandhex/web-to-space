/**
 * eval/dom-bootstrap.ts — make the browser-oriented pipeline runnable in Node.
 *
 * The IR parser, VIPS port, and Readability backend all call `new DOMParser()`,
 * a browser global. Importing this module (for its side effect) installs a jsdom
 * DOMParser onto `globalThis` so the exact same pipeline code runs unmodified in
 * the offline benchmark. `Blob`/`performance` are already globals in Node ≥ 18.
 *
 * Import this FIRST, before any pipeline module.
 */
import { JSDOM } from "jsdom";

const { window } = new JSDOM("<!DOCTYPE html><html><body></body></html>");

const g = globalThis as unknown as {
  DOMParser?: unknown;
  Node?: unknown;
  document?: unknown;
  window?: unknown;
};

if (!g.DOMParser) g.DOMParser = window.DOMParser;
if (!g.Node) g.Node = window.Node;
// Some libraries probe for a document/window; provide the jsdom ones.
if (!g.document) g.document = window.document;
if (!g.window) g.window = window;
