/**
 * eval/verify-vips-visual.ts — checks that visual VIPS reads geometry, not tags.
 *
 *   npm run verify:vips
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * `ir/vips-visual.ts` only runs where there is a layout engine, so the offline
 * harness (jsdom) never exercises it and a regression there would ship silently.
 * Rather than require a headless browser in CI, this stubs the two APIs the
 * algorithm actually consumes — `getBoundingClientRect` and `getComputedStyle` —
 * with hand-authored values, giving a *synthetic rendered page* that jsdom can
 * host. The algorithm under test is the real one, unmodified.
 *
 * The fixtures are built so that a tag-tree reading of the page and a visual
 * reading disagree. Every case therefore fails if VIPS quietly reverts to
 * structural heuristics, which is exactly the regression worth catching: the
 * DOM-only fallback is a legitimate code path, so "it still returns blocks" is
 * not evidence that the visual path ran.
 */

import "./dom-bootstrap";
import { JSDOM } from "jsdom";
import { runVipsVisual } from "../ir/vips-visual";
import type { RenderedFrame } from "../ir/render-frame";

// ─────────────────────────────────────────────────────────────
// Synthetic rendering
// ─────────────────────────────────────────────────────────────

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
  bg?: string;
  fontSize?: number;
  fontWeight?: number;
}

/** A fixture: HTML plus the rendered box for every element with an `id`. */
interface Fixture {
  name: string;
  html: string;
  boxes: Record<string, Box>;
  /** What a correct visual segmentation must satisfy. */
  expect: (leafIds: string[][], describe: string) => string | null;
}

const VIEWPORT = { w: 1200, h: 900 };

/**
 * Build a `RenderedFrame` over a jsdom document whose geometry and styles come
 * from `boxes` instead of a real layout pass.
 *
 * Elements without an entry collapse to a zero box, which the algorithm drops —
 * the same treatment a real renderer gives `display:none`.
 */
function makeFrame(html: string, boxes: Record<string, Box>): RenderedFrame {
  const dom = new JSDOM(html);
  const doc = dom.window.document;

  const boxOf = (el: Element): Box => {
    const id = el.getAttribute("id");
    const b = id ? boxes[id] : undefined;
    return b ?? { x: 0, y: 0, w: 0, h: 0 };
  };

  for (const el of Array.from(doc.querySelectorAll("*"))) {
    const b = boxOf(el);
    (el as Element & { getBoundingClientRect: () => DOMRect }).getBoundingClientRect =
      () =>
        ({
          x: b.x, y: b.y, width: b.w, height: b.h,
          left: b.x, top: b.y, right: b.x + b.w, bottom: b.y + b.h,
          toJSON: () => ({}),
        }) as DOMRect;
  }

  // body spans the viewport so page-relative coordinates equal fixture coords.
  (doc.body as Element & { getBoundingClientRect: () => DOMRect }).getBoundingClientRect =
    () =>
      ({
        x: 0, y: 0, width: VIEWPORT.w, height: VIEWPORT.h,
        left: 0, top: 0, right: VIEWPORT.w, bottom: VIEWPORT.h,
        toJSON: () => ({}),
      }) as DOMRect;

  const win = dom.window as unknown as Window;
  (win as { getComputedStyle: (el: Element) => CSSStyleDeclaration }).getComputedStyle = (
    el: Element,
  ) => {
    const b = boxOf(el);
    return {
      backgroundColor: b.bg ?? "rgba(0, 0, 0, 0)",
      fontSize: `${b.fontSize ?? 16}px`,
      fontWeight: String(b.fontWeight ?? 400),
      color: "rgb(0, 0, 0)",
      display: "block",
      visibility: "visible",
      opacity: "1",
      borderTopWidth: "0px",
      borderBottomWidth: "0px",
      borderTopColor: "rgb(0, 0, 0)",
    } as unknown as CSSStyleDeclaration;
  };
  (win as { innerWidth: number }).innerWidth = VIEWPORT.w;
  (win as { innerHeight: number }).innerHeight = VIEWPORT.h;

  return { doc, win, bodyRect: doc.body.getBoundingClientRect() };
}

// ─────────────────────────────────────────────────────────────
// Assertion helpers
// ─────────────────────────────────────────────────────────────

/** True when `a` and `b` never land in the same leaf block. */
function separated(leaves: string[][], a: string, b: string): boolean {
  return !leaves.some((ids) => ids.includes(a) && ids.includes(b));
}

/** True when `a` and `b` always land in the same leaf block. */
function together(leaves: string[][], a: string, b: string): boolean {
  return leaves.some((ids) => ids.includes(a) && ids.includes(b));
}

// ─────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────

const FIXTURES: Fixture[] = [
  {
    // A 40px gutter splits two columns that are SIBLINGS UNDER THE SAME PARENT
    // with identical tags. Nothing in the tag tree distinguishes them; only the
    // vertical whitespace does.
    name: "vertical gutter splits two visually separated columns",
    html: `
      <body><div id="wrap">
        <div id="left"><p id="l1">Left column paragraph one with enough text to count.</p></div>
        <div id="right"><p id="r1">Right column paragraph one with enough text to count.</p></div>
      </div></body>`,
    boxes: {
      wrap: { x: 0, y: 0, w: 1200, h: 500 },
      left: { x: 0, y: 0, w: 380, h: 500, bg: "rgb(238, 238, 238)" },
      l1: { x: 10, y: 10, w: 360, h: 480, bg: "rgb(238, 238, 238)" },
      right: { x: 420, y: 0, w: 780, h: 500, bg: "rgb(255, 255, 255)" },
      r1: { x: 430, y: 10, w: 760, h: 480, bg: "rgb(255, 255, 255)" },
    },
    expect: (leaves, d) =>
      separated(leaves, "l1", "r1")
        ? null
        : `expected the 40px gutter to separate #l1 from #r1 — ${d}`,
  },

  {
    // Same markup shape, but the columns are now flush against each other. With
    // no gutter and no background change there is no visual boundary, so a
    // correct visual segmenter must NOT split them — a tag-tree reader would.
    name: "adjacent columns with no gutter are not split",
    html: `
      <body><div id="wrap">
        <div id="left"><p id="l1">Left column paragraph one with enough text to count.</p></div>
        <div id="right"><p id="r1">Right column paragraph one with enough text to count.</p></div>
      </div></body>`,
    boxes: {
      wrap: { x: 0, y: 0, w: 1200, h: 500 },
      left: { x: 0, y: 0, w: 600, h: 500, bg: "rgb(255, 255, 255)" },
      l1: { x: 0, y: 0, w: 600, h: 500, bg: "rgb(255, 255, 255)" },
      right: { x: 600, y: 0, w: 600, h: 500, bg: "rgb(255, 255, 255)" },
      r1: { x: 600, y: 0, w: 600, h: 500, bg: "rgb(255, 255, 255)" },
    },
    expect: (leaves, d) =>
      together(leaves, "l1", "r1")
        ? null
        : `expected no split without a gutter or colour change — ${d}`,
  },

  {
    // A large horizontal gap separates two runs of identically-tagged <p>s.
    // The tag tree is a flat list of siblings; only the whitespace says where
    // one region ends.
    name: "horizontal gap splits a flat run of identical siblings",
    html: `
      <body><div id="wrap">
        <p id="a1">First region, first paragraph with sufficient body text here.</p>
        <p id="a2">First region, second paragraph with sufficient body text here.</p>
        <p id="b1">Second region, first paragraph with sufficient body text here.</p>
        <p id="b2">Second region, second paragraph with sufficient body text here.</p>
      </div></body>`,
    boxes: {
      wrap: { x: 0, y: 0, w: 1200, h: 700 },
      a1: { x: 0, y: 0, w: 1200, h: 60 },
      a2: { x: 0, y: 70, w: 1200, h: 60 },
      // 120px of whitespace here — the only signal.
      b1: { x: 0, y: 250, w: 1200, h: 60 },
      b2: { x: 0, y: 320, w: 1200, h: 60 },
    },
    expect: (leaves, d) => {
      if (!separated(leaves, "a2", "b1")) {
        return `expected the 120px gap to separate #a2 from #b1 — ${d}`;
      }
      if (!together(leaves, "a1", "a2")) {
        return `expected tightly-spaced #a1/#a2 to stay together — ${d}`;
      }
      return null;
    },
  },

  {
    // Identical geometry and spacing throughout; the ONLY difference is the
    // background colour of the second run. VIPS weights background change as a
    // separator cue, so this must split where a geometry-only reader would not.
    name: "background change alone creates a boundary",
    html: `
      <body><div id="wrap">
        <p id="a1">Region one paragraph with sufficient body text to be counted.</p>
        <p id="a2">Region one paragraph with sufficient body text to be counted.</p>
        <p id="b1">Region two paragraph with sufficient body text to be counted.</p>
        <p id="b2">Region two paragraph with sufficient body text to be counted.</p>
      </div></body>`,
    boxes: {
      wrap: { x: 0, y: 0, w: 1200, h: 500 },
      a1: { x: 0, y: 0, w: 1200, h: 60, bg: "rgb(255, 255, 255)" },
      a2: { x: 0, y: 70, w: 1200, h: 60, bg: "rgb(255, 255, 255)" },
      b1: { x: 0, y: 160, w: 1200, h: 60, bg: "rgb(20, 30, 40)" },
      b2: { x: 0, y: 230, w: 1200, h: 60, bg: "rgb(20, 30, 40)" },
    },
    expect: (leaves, d) =>
      separated(leaves, "a2", "b1")
        ? null
        : `expected the background change to separate #a2 from #b1 — ${d}`,
  },
];

// ─────────────────────────────────────────────────────────────
// Runner
// ─────────────────────────────────────────────────────────────

function leafIdSets(frame: RenderedFrame): string[][] {
  const { blocks } = runVipsVisual(frame, frame.doc.body, { minSeparatorPx: 6 });
  return blocks.map((b) => {
    const ids = new Set<string>();
    for (const el of b.els) {
      const own = el.getAttribute("id");
      if (own) ids.add(own);
      for (const d of Array.from(el.querySelectorAll("[id]"))) {
        const id = d.getAttribute("id");
        if (id) ids.add(id);
      }
    }
    return [...ids];
  });
}

function main(): void {
  let failures = 0;
  console.log("Visual VIPS — synthetic geometry checks\n");

  for (const fx of FIXTURES) {
    let problem: string | null;
    let describe = "";
    try {
      const leaves = leafIdSets(makeFrame(fx.html, fx.boxes));
      describe = `got ${leaves.length} leaf block(s): ${JSON.stringify(leaves)}`;
      problem = fx.expect(leaves, describe);
    } catch (err) {
      problem = `threw: ${err instanceof Error ? err.message : String(err)}`;
    }

    if (problem) {
      failures++;
      console.log(`  ✗ ${fx.name}`);
      console.log(`      ${problem}`);
    } else {
      console.log(`  ✓ ${fx.name}`);
      console.log(`      ${describe}`);
    }
  }

  console.log(
    `\n${FIXTURES.length - failures}/${FIXTURES.length} passed.`,
  );
  if (failures > 0) process.exit(1);
}

main();
