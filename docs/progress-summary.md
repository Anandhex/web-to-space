# Web-to-Space — Progress Summary

**A spatial web browser: any web page → an interactive 3D scene for AR/VR headsets.**

Live build: https://from-space-to-web.vercel.app

This note accompanies the video walkthroughs of the presentation views. It covers what
the system does, what was built, how the views differ, and where the work stands.

---

## 1. The premise

A headset today shows you a flat browser window floating in space. That wastes the
medium: the page is still a 2D rectangle you scroll, just further from your face.

This project takes the opposite approach — **read the page's semantic structure, then
give that structure a spatial form**. Navigation, articles, headings, forms and buttons
are recovered from the HTML as meaning, not as pixels, and then placed as real objects
in a room around the reader. A view is a *semantics-preserving spatial reframing*: it
never changes what is on the page or how text flows inside a panel, only where the
content sits around the user and how they move through it.

---

## 2. How it works — a five-stage pipeline

```
HTML → Parser → IR → Mapper → SemanticScene → Layout Engine → LayoutPlan → Renderer (WebXR)
```

Every stage is a pure function; nothing mutates shared state between stages. This is
what makes each stage independently testable and the whole thing benchmarkable offline
without a headset.

| Stage | What it does |
|---|---|
| **Parser** (`src/ir/`) | HTML → an accessibility-semantic intermediate representation, using ARIA roles, labels and structural inference. |
| **Mapper** (`src/mapper/`) | Each semantic role → a typed 3D primitive. No node is ever dropped; unknown roles fall back to a generic panel. |
| **Layout engine** (`src/layout/`) | Places every primitive in 3D space. **Metres everywhere** — no pixel units anywhere in layout or rendering. |
| **Renderer** (`src/renderer/`) | Draws the plan with React Three Fiber / Three.js; GPU text via troika. |
| **XR session** (`src/renderer/scene/`) | WebXR session, controller raycasting, hand/controller interaction, in-world chrome. |

### The parser's three classification layers

1. **Explicit ARIA** — `role=` attributes, where the author gave us the answer.
2. **Structural inference** — heading-bounded sections, link-runs → navigation,
   paragraph-runs → article. This is what carries the majority of the real web, where
   markup is div soup.
3. **AI fallback** *(new)* — anything the first two layers could not classify is sent to
   a language model. Supports **Claude, OpenAI, Gemini and Ollama** behind one interface;
   the reader supplies their own key on the home screen.

The AI layer is deliberately constrained so it can never become a liability:
it is **batched** (the whole page's unknowns go out in two or three requests, not forty
sequential ones), **partial** (a failed chunk costs only its own nodes), **bounded**
(timeouts, capped retries, a per-page node ceiling), and **confidence-gated** (an
uncertain answer is discarded and the node keeps its structural role). With no key
configured, the layer is a no-op — parses are byte-identical to before it existed and
**nothing leaves the browser**. Keys are only written to disk with explicit consent.

---

## 3. The presentation views — what the videos show

The key architectural move is a **two-axis model**:

```
content template (chosen automatically from semantics)  ×  spatial view (chosen by reader)
   document / dashboard / form / landing / generic            reference frame + distribution
```

Previously, picking a view *discarded* what we knew about the page — a news article and
a data dashboard got the identical carousel. Now the page type and the spatial framing
are independent, so the reader's choice of view composes with, rather than overrides,
the semantics.

Six views ship. The first two are **reading views** (the page comes to you); the last
four are **page views**, where the document's whole page set becomes the spatial
structure you navigate.

| View | Idea | Devices |
|---|---|---|
| **Standard** | A reading desk. One page head-on, with a section/page plate and a progress rail across the whole document. | All |
| **Carousel** | The same desk, with the neighbouring pages standing on an arc either side of the one being read. | All |
| **Elevator** | The document as a *building*. Each top-level section is a storey — a ring of pages around an open well, with its own deck, lit soffit, balustrade and directory plate. You ride up and down between sections. | All |
| **Wall** | The document's *outline* as a board that opens one level at a time: sections → pages → full-size page, each expanding in place. Nothing flies to a separate stage, so the sections you didn't open keep their position, and with it your spatial memory of them. | Quest 3 / Pro |
| **Deck** | A *card table* you deal and re-deal by hand. Sections arrive as overlapping lanes of cards; you drag cards between lanes or onto a shelf, and the arrow keys then read the document **in your order rather than the author's**. | Quest 3 / Pro |
| **Rooms** | The document as a *gallery you walk through*. Each section is a room hung with its pages, joined by corridors whose walls carry that section's outbound links. You walk; the pages hold still. | Quest 3 / Pro |

Two details worth pointing out on the videos:

- **Rooms moves the world, not the camera.** Every other view morphs the page cells when
  focus changes; rooms morphs the room around a stationary reader. That is what makes it
  read as *walking* rather than as furniture rearranging itself — and it keeps the reader
  at the origin, which the in-world chrome and the headset's recentre both depend on.
- **Deck's arrangement is the point.** The card positions are the reader's own working
  memory of the document, made physical and persistent.

### Making 3D content actually legible

An early lesson: panels floating in a void read as a debug plot, not as an interface. An
unlit plane with no edge reads as a hole rather than a surface; every card is the same
value as the next; nothing says the pieces belong together. Every view was rebuilt on
three shared principles:

1. **A real surface behind the content** — a board, a table, a wall, a deck — so text
   always has a known value behind it and the pieces read as one built object.
2. **Edges** — rounded surfaces with hairline rims, pages sitting in mounts, shadows that
   grow as a card lifts. The difference between "two planes meeting" and "a card on a wall".
3. **Colour that means something** — each section owns a hue, and *the same hue in every
   view*. A page is visibly *of* its section, and spatial memory built in one view carries
   into the next.

Rooms and elevator go further with local lighting: pools of light under each fitting, a
page brighter than the wall it hangs on, corridors that dim between doorways. A room lit
by one flat global lamp reads as a diagram of a room.

### Supporting mechanisms

- **Device profiles** — Quest 3, Quest Pro and Ray-Ban Meta glasses each carry their own
  comfort angles, viewing distance and text metrics. Views are gated by device capability;
  the room-scale views are hidden on glasses rather than shipped broken.
- **Graceful degradation** — a document under three pages falls back to simple page-flip
  rather than presenting one lonely card as a "field".
- **Performance** — only pages near the focus render as live 3D; distant ones become cheap
  imposter cards showing number and heading.
- **Tabs and navigation** — multi-tab browsing, in-world chrome, and link navigation that
  inherits the reader's chosen view, device and theme, so following a link doesn't dump
  you back into a default.
- **Accessibility** — the home screen's canvas launcher is mirrored by a real DOM layer
  (roving tabindex, screen-reader text, live region) over a contrast-audited palette.

---

## 4. Evaluation

Rather than claim the parser "works", there is a reproducible offline benchmark
(`npm run benchmark`) grounded in the segmentation and VR-legibility literature. It runs
the full pipeline in Node via jsdom, so results are produced without a headset.

**Three metric families:**

1. **Segmentation quality** — size-weighted BCubed precision/recall/F, following the
   evaluation methodology of Kiesel et al. (CIKM 2020). Our parser is compared against
   independent baselines: VIPS, Readability, text-density, block-fusion, and a flat
   control. One documented deviation from the paper: we weight atomic elements by text
   length rather than rendered pixel area, since we run DOM-only.
2. **XR spatial quality** — judges the *placed* 3D plan, not just the parse: cap-height
   visual angle per text primitive against a 0.29° legibility floor and 1.375° comfort
   target (IEEE VR 2020; ACM VRST 2025), comfort-envelope occupancy, information density,
   and navigation cost.
3. **IR-level metrics** — semantic richness, heading and landmark recall, text coverage,
   generic-node ratio, timing.

**Indicative results** (current corpus): the custom ARIA+structural parser leads on
semantic richness (58.3) with 100% landmark recall and 100% text coverage, ahead of
Readability, VIPS and a tags-only baseline; DOM-sectioning and heading-bounded
segmentation score F = 1.00 and 0.95 respectively. All placed text clears the legibility
floor.

**Honest caveats**, both documented in the benchmark's own README: the corpus is
currently three pages, and without hand-annotated gold labels the reference is a
semantic proxy oracle that degenerates to a single segment on div-soup pages — which
inflates the mean and cannot discriminate there. Expanding the corpus and adding gold
annotations is the clearest next step for making these numbers publishable.

---

## 5. Where it stands

**Working end to end:** URL → parse → 3D scene, in the browser preview and in an
immersive WebXR session, across six views and three device profiles, with tabs, link
navigation, in-world chrome, form controls, same-page fragment links, and an optional
AI classification layer.

**Scale:** roughly 26k lines of TypeScript across parser, mapper, layout engine,
renderer and evaluation harness.

**Next steps:**
- Expand the benchmark corpus and add gold segmentation annotations.
- User study on the views — the design rationale is argued from first principles and
  the legibility literature, but not yet validated with readers.
- Production CORS handling (the proxy is currently dev-only).
- Refresh the top-level README, which still lists the retired view names.

---

## 6. Suggested video captions

| Video | One-line caption |
|---|---|
| Standard | A reading desk: one page head-on, with section, page number and whole-document progress always visible. |
| Carousel | The same desk, with the neighbouring pages standing on an arc — what's next, in peripheral vision. |
| Elevator | The document as a building: one storey per section, ridden through an open well. |
| Wall | The outline as a board that opens in place — sections, then pages, then the page itself. |
| Deck | A card table: drag pages into your own order, then read the document that way. |
| Rooms | Walk a gallery of the document — one room per section, corridors hung with its links. |
