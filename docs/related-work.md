# Related Work: Approaches to Converting Web Pages into VR/XR Spaces

A survey of the research literature on transforming 2D web content into spatial 3D
environments, and a comparison against the **Web-to-Space** pipeline in this repo
(`HTML → Parser → IR → Mapper → Layout Engine → Renderer`).

> Scope note: the field has no single canonical thread. Work relevant to this project
> sits in five loosely-connected literatures that rarely cite each other — web page
> segmentation (IR/data-mining), 2D-in-3D window management (HCI/SUI), computational
> XR layout optimisation (UIST/ISMAR), declarative Web3D/immersive analytics
> (Web3D/TVCG), and XR text legibility (IEEE VR/VRST). This document maps each onto
> the corresponding stage of our pipeline.

---

## 1. Taxonomy of Approaches

Every system that puts a web page in a headset makes two independent choices:
**what unit of content becomes a spatial object** (the *decomposition* axis), and
**how that unit is placed in 3D** (the *placement* axis). The taxonomy below is
organised on the decomposition axis, because that is where this project's
contribution sits.

| Family | Decomposition unit | Placement strategy | Representative work |
|---|---|---|---|
| **A. Flat proxy** | The whole page (one texture) | Single billboard at a comfortable distance | Firefox Reality / Wolvic, Quest Browser, Vision Pro Safari |
| **B. Geometric/visual decomposition** | Rendered CSS boxes (`getBoundingClientRect`) | Direct px→metre mapping, depth from DOM nesting | Web2VR, Break-the-Window (BTW) |
| **C. Vision-based segmentation** | Visually coherent blocks derived from rendered layout | Blocks become panels; layout usually re-flowed | VIPS (Cai et al.), Kiesel et al. evaluation framework |
| **D. Content extraction** | The "article" (boilerplate stripped) | Single reading panel, reflowed | Readability, Boilerpipe |
| **E. Semantic/role-driven** | ARIA roles + landmarks + accessibility tree | Role determines primitive type *and* spatial slot | **This project**; partially SemanticAdapt |
| **F. Computational optimisation** | Pre-authored UI elements (not web-derived) | Solve a constraint/cost model over the physical scene | FLARE, Lindlbauer et al., SemanticAdapt, SituationAdapt, Active Follow |
| **G. Declarative Web3D** | Author-specified visualisation grammar | Grammar-driven; no legacy page involved | VRIA, XML3D, X3D/VRML |
| **H. Page-as-object management** | The page as an atomic 3D "thing" | Physics/proxy metaphors for organising many pages | Web Pages as 3D Proxies (CHI EA '26) |

**The gap this project occupies:** families B–D decompose without understanding
*meaning*; family F understands meaning but assumes a hand-authored UI, not an
arbitrary URL; family G requires the author to opt in. Family E — deriving spatial
structure from the **accessibility tree of an unmodified page** — is thinly
populated, and that is where Web-to-Space sits.

---

## 2. Family-by-Family Review and Comparison

### A. Flat proxy (the production baseline)

**What the literature/systems do.** Every shipping XR browser — Firefox Reality,
its successor Wolvic (Igalia), Meta's Quest Browser, visionOS Safari — renders the
page to a texture on a curved or flat quad. Mozilla invested heavily in R&D on
designing a browser for VR before handing stewardship to Igalia; the design
conclusion was to "move seamlessly between the 2D web and the immersive web"
rather than to spatialise 2D pages.

**Why it persists.** Perfect fidelity, zero risk of misinterpreting the page, and
full JS/CSS interactivity. Its cost is that it inherits desktop design
assumptions — a critique made explicitly by the Break-the-Window authors:
*"Most XR web browsers still present webpages as a single floating window,
carrying over desktop design assumptions into immersive space."*

**Comparison.** This repo implements the flat proxy as the `flat` parser backend
(`ir/backends.ts`, label `"Browser Panel"`), explicitly as a control condition in
the comparison panel. That is the right framing: the flat panel is the baseline
any spatialisation must beat, not a competitor to be ignored.

---

### B. Geometric / visual decomposition

**Web2VR** takes the rendered DOM and reads each visible element's
`getBoundingClientRect()` and `getComputedStyle()`, mapping CSS pixels to world
units at a fixed scale and using DOM nesting depth as a z-offset ("layers"). It is
faithful to visual appearance and requires no semantic understanding.

**Break-the-Window (BTW)** (arXiv 2603.02471) is the closest recent research
analogue to what this project does at the *presentation* level. BTW "breaks the
browser window and distributes a webpage into spatial UI chunks within a
mixed-reality workspace" — movable panels supporting mid-air and surface-attached
placement, with direct-touch and ray interaction. Critically, BTW keeps the pages
**live and fully functional** (the chunks are still real web views), and its
contribution is empirical: a formative study with XR practitioners plus a
qualitative study with 15 participants. Findings: spatial decomposition supports
distributed attention and spatial meaning-making, but costs coordination effort,
interaction precision, and suffers from the absence of shared spatial UI
conventions.

**Comparison.**

| | Web2VR / BTW | Web-to-Space |
|---|---|---|
| Decomposition signal | Rendered geometry (CSS boxes) | ARIA roles + landmarks + structural inference |
| Interactivity | Live DOM preserved (BTW) | Re-rendered as native 3D primitives; JS behaviour not preserved |
| Fidelity to original design | High (colours, fonts, positions) | Low by design — page is re-laid-out for XR |
| Depth semantics | DOM nesting → z | Semantic slot (`main`/`nav`/`aside`) → world position |
| Reflow for XR ergonomics | None (px scale is fixed) | Full — metres, device profiles, pagination |

The repo has **ported Web2VR** (`ir/web2vr.ts`, `SCALE = 600`, i.e. 1 CSS px =
1/600 world units, matching Web2VR's default) and runs it as a comparison backend
via `Web2VRScene.tsx`. The documented limitation is honest: external CSS/fonts
can't load in the sandboxed opaque-origin iframe, so computed styles reflect
inline/default styles only — meaning the port under-represents Web2VR's real
fidelity. Worth stating in any write-up.

**Gap vs. BTW.** BTW's panels are *user-movable* and support surface attachment.
Web-to-Space's layout is engine-computed and, as far as the layout engine is
concerned, static per view mode (`Standard`/`Carousel`/`Cards`/`Door`/`Theatre`).
BTW's empirical finding that users need to *re-arrange* chunks to make spatial
meaning is a direct argument for adding user-driven repositioning with persistence.

---

### C. Vision-based segmentation

**VIPS** (Cai, Yu, Wen, Ma — MSR-TR-2003-79, 2003) is the canonical algorithm: a
top-down, **tag-tree-independent** segmentation that combines DOM structure with
visual cues in three steps — block extraction, separator detection, content
structure construction — producing a hierarchy of visual blocks scored by a
*Degree of Coherence* (DoC). The paper's stated motivation includes "automatic page
adaptation," which is precisely the web→XR use case, twenty years early.

**Kiesel et al., *Web Page Segmentation Revisited: Evaluation Framework and
Dataset*, CIKM 2020** supplies the missing evaluation methodology: treat a
segmentation as a partition over **atomic elements** and compare two segmentations
with **size-weighted BCubed** precision/recall/F. Merges depress precision, splits
depress recall.

**Comparison.** This is the strongest part of the repo's grounding, and it was
rebuilt after the first draft of this survey identified it as the weakest claim in
the eval.

`ir/vips-visual.ts` now implements the algorithm as the paper describes it, over a
genuinely rendered page: all three phases (visual block extraction, the separator
sweep with the paper's split/update/remove rules, and weighting by gap width,
`<hr>` coincidence, background change, font shift and tag change), driven by real
`getBoundingClientRect()` / `getComputedStyle()` data. `ir/render-frame.ts` supplies
the rendered document via an off-screen frame sandboxed `allow-same-origin` without
`allow-scripts` — same-origin so the layout is readable, script-free so arbitrary
remote HTML cannot execute — with external stylesheets fetched through the dev
proxy and inlined, since a frame with no CSS has no visual signal to read.

`eval/segmentation.ts` weights atomic elements by **rendered pixel area** (Kiesel's
definition) whenever layout is available, falling back to text length only where it
is not.

**What remains, and why.** The offline benchmark runs under jsdom, which implements
the DOM but performs no layout, so *there* both fallbacks still engage. That is now
a reported condition rather than a silent one: `parsePageWithVIPSDetailed` returns
`mode` and `fallbackReason`, `scoreSegmentationRun` returns the weighting and VIPS
fidelity actually used, the generated `report.md` opens with a "Run environment"
table and marks every affected row, and the in-app comparison panel shows a banner
directly beneath the verdict cards when any baseline ran degraded. The claim
"custom parser beats VIPS" can now only be made where it is true — in the browser,
against the real algorithm.

**Verification without a browser.** `npm run verify:vips` drives the unmodified
visual algorithm with synthetic geometry (jsdom hosting the DOM; `getBoundingClientRect`
and `getComputedStyle` stubbed with authored boxes). Fixtures are constructed so
a tag-tree reading and a visual reading disagree — identical markup that must split
on a 40px gutter, must split on a background change alone, and must **not** split
when columns are flush with no colour change. The negative controls matter: the
DOM-only fallback is a legitimate path, so "it returned blocks" would not have
shown that the visual one ran. Writing them caught a real bug — phase 1 was
refusing to divide single-child containers, collapsing every page to one block.

**Remaining gap:** `eval/README.md` notes the proxy ground-truth oracle
"degenerates to one segment on div-soup pages," which inflates means on exactly the
pages where segmentation matters most. Gold annotations for the div-soup corpus
would fix this.

**A directly transferable finding.** Akpınar and Yeşilada (ICWE 2013) re-implemented
and extended VIPS in Java and ran an online user evaluation on *perceived*
segmentation quality. Their motivation is notably close to this project's — properly
displaying pages "on small screen devices and in alternative forms such as audio for
screen reader users" — and their headline result is that **people perceive
higher-granularity segmentation as better, regardless of page complexity.** If that
transfers to XR, it argues against coarse landmark-level panels and in favour of the
finer primitive decomposition this pipeline already produces. It is also a
ready-made hypothesis for the user study identified as gap #1.

---

### D. Content extraction

Readability (Mozilla) and Boilerpipe strip navigation, ads, and chrome to leave the
article. This is the dominant real-world approach to "make a page readable
elsewhere" (reader modes, Pocket, e-readers).

**Comparison.** Implemented as the `readability` backend using `@mozilla/readability`.
It is a strong baseline for *article* pages and a weak one for everything else —
it deletes the navigation and forms that a spatial browser most wants to place in
the periphery. The comparison panel's landmark-recall and interactive-affordance
metrics should show this clearly; it's the cleanest empirical argument for the
semantic approach.

---

### E. Semantic / role-driven (this project's family)

**Prior art is sparse.** ARIA and the accessibility tree are well-specified
(WAI-ARIA 1.2/1.3), and there is applied work on XR accessibility (RAVEN, for
blind/low-vision users in virtual environments; and reviews of accessibility in
VR/AR/metaverse). **SemanticAdapt** (Cheng, Yan, Yi, Shi, Lindlbauer — UIST 2021)
is the closest in spirit: it exploits "the semantic association between virtual
interface elements and physical objects" to decide placement. But its semantics
describe the *physical room* (this is a desk, that is a wall), not the *document*.

There does not appear to be a prominent published system that treats **the
accessibility tree of an arbitrary URL** as the primary structural signal for
generating a spatial layout. That is a defensible novelty claim for this work.

**What this project does, concretely.**

1. **Three-layer classification** (`ir/parser.ts`): explicit ARIA `role=` →
   structural inference (heading-bounded sections, link-runs → nav, paragraph-runs
   → article) → AI fallback (`AIFallbackProvider`, currently `StubAIProvider`).
   Each node records its `IRSource` (`explicit | structural | ai | inline | generic`)
   and a confidence, so the eval can report *how much* of a page was recovered
   semantically vs. guessed.
2. **66 IR roles → 42 typed XR primitives** with a total mapping (`mapper/types.ts`).
   The no-drop invariant (unmapped → `XRGenericPanel`) means the scene is a
   *complete* representation of the page — a property none of families B–D
   guarantee.
3. **Separation of semantics from placement.** The mapper never assigns positions;
   it only extracts semantic facts (ARIA relations, state, counts). All placement
   lives in `layout/engine.ts`.

**Why the separation matters academically.** It makes the system a clean testbed:
you can swap the segmenter (custom / VIPS / Readability / naive) while holding the
layout engine fixed, or swap the device profile while holding the semantics fixed.
Most prior systems fuse extraction and presentation, which is why their evaluations
can't attribute a result to either half. The repo's `eval/segmentation.ts` already
recognises this — it deliberately routes each segmenter through an independent
`Element → Segmentation` function so scores are "attributable to the algorithm
itself."

**Gaps in this family.**

- **The AI layer is a stub.** `StubAIProvider` means the third classification layer
  is unexercised. Given that modern LLMs are extremely good at labelling div-soup,
  this is the single highest-leverage unimplemented feature — and it is the part
  most likely to differentiate the results on real-world (unsemantic) pages, which
  are the majority. Relevant precedent: SituationAdapt (UIST 2024) uses LLM
  reasoning for situation-aware XR UI optimisation, showing LLM-in-the-loop
  adaptation is now a mainstream method.
- **No user study.** Every paper in families B, E, F, H validates with participants.
  BTW ran 15; SemanticAdapt and Lindlbauer et al. ran controlled studies. This repo
  has strong *computational* metrics and zero *human* ones. For a publication this
  is the binding constraint, not more metrics.

---

### F. Computational layout optimisation

**FLARE** (Gal, Shapira, Ofek, Kohli — ISMAR 2014) is the origin point: a rule-based
framework where the developer specifies constraints for **self-consistency**
(relations among app components) and **scene-consistency** (fit with the physical
environment), solved as a constraint-satisfaction problem via a domain-aware
stochastic move-making algorithm.

**Lindlbauer, Feit, Hilliges — *Context-Aware Online Adaptation of Mixed Reality
Interfaces* (UIST 2019)** optimises *when* and *where* applications appear and
*how much information* each shows, driven by the user's cognitive load and task.

**SemanticAdapt** (UIST 2021) formulates placement as combinatorial optimisation
over element utility, layout factors, and spatio-temporal consistency with previous
environments.

**SituationAdapt** (UIST 2024) adds LLM-based situation awareness (social context,
environment) to the objective.

**Active Follow** (2026) is a multi-objective optimisation for *dynamic* XR
scenarios, with terms for ergonomic cost, field-of-view constraints, occlusion
avoidance, and interaction history. **Fatigue-aware VR interfaces** (arXiv 2603.26031)
optimise layouts against a biomechanical muscle-fatigue model.

**Comparison — this is the clearest gap.** Web-to-Space's layout engine is
**rule-and-template-based, not optimisation-based**: `selectLayoutTemplate()`
classifies the scene (`document | landing | generic | carousel`) via simple
thresholds (banner present, `sectionCount <= 3`, `totalWordCount < 600`), then
slots landmarks deterministically. There is no cost function and no solver.

| | Optimisation family | Web-to-Space |
|---|---|---|
| Placement decision | Minimise a cost model (ergonomics, FOV, occlusion, consistency) | Deterministic template + slot rules |
| Physical environment | First-class input (plane detection, semantic objects) | Not used — placement is egocentric only |
| Adaptivity | Online, re-optimises as context changes | Static per view mode |
| Reproducibility / debuggability | Lower (stochastic solvers) | High (pure functions, no shared state) |
| Latency | Solver-bound | Sub-frame |

**Fair defence of the current design.** Rule-based templates are deterministic,
inspectable, and fast — and unlike FLARE-style systems, the *content* here is
unbounded (any URL), so the number of elements to place is not fixed in advance.
The optimisation literature almost universally assumes a small, known set of
pre-authored panels.

**Concrete gaps worth adopting:**

1. **Ergonomic cost terms.** The repo already computes the right quantities in
   `eval/xr-quality.ts` — angular legibility (θ = 2·atan(h/2d), floor 0.29°, comfort
   target 1.375°), comfort-envelope occupancy against `comfortHalfAngleDeg = 30`,
   `mainPanelFovFill`, page-turn cost. These are currently used only *post hoc* to
   score a layout. Turning them into an objective and running even a greedy or
   simulated-annealing pass over slot assignments would move this project into
   family F with minimal new machinery. **This is the single most publishable
   upgrade available.**
2. **Environment awareness.** No plane detection / surface anchoring. BTW found
   surface-attached placement valuable; FLARE and SemanticAdapt make it central.
   WebXR exposes hit-test and plane detection APIs, so this is reachable.
3. **Ethereal Planes framing.** Ens, Hincapié-Ramos, Irani (SUI 2014) give the
   standard vocabulary for 2D-in-3D: four reference frames — *fixed-egocentric,
   fixed-exocentric, movable-egocentric, movable-exocentric* — plus seven design
   dimensions. The repo's five view modes map onto this cleanly (Carousel and Cards
   are fixed-egocentric; Door and Theatre lean exocentric) but the doc never says
   so. Adopting this vocabulary would cost a paragraph and buy a lot of legibility
   to an HCI audience. It also exposes an absence: **nothing in the system is
   *movable*.**

---

### G. Declarative Web3D and immersive analytics

**VRIA** (Butcher, John, Ritsos — TVCG 2020; CHI EA 2019) builds immersive analytics
on WebVR/A-Frame/React/D3 with a **declarative configuration format** for
visualisation type, data binding, and interaction. **XML3D** and the X3D/VRML
lineage pursued the same goal — 3D as a first-class web citizen with DOM event
compatibility — going back to the 1990s dream of VRML as "the 3D equivalent of HTML."

**Comparison.** These are the opposite direction: the *author* declares 3D
structure, rather than a system *inferring* it from 2D. Web-to-Space is
inference-first and works on unmodified pages, which is a strictly harder problem
and the reason its output can be wrong in ways VRIA's cannot.

**Gap / opportunity.** VRIA's declarative spec is a useful model for an **escape
hatch**: a `<meta name="xr-layout">` or JSON-LD block that lets a site author
*override* the inferred layout. That would make the system a spectrum
(infer → hint → declare) rather than an all-or-nothing inference, and it is a
natural "future work" claim.

Also of note: the **on-demand generation of 3D content from semantic meta-scenes**
and **ontology-based 3D content modelling** literature (Flotyński et al.) attacks
the same "semantics → 3D" mapping problem with description logics and
domain ontologies rather than ARIA. Worth a citation as an alternative formalism —
the practical trade-off is that ARIA already exists on real pages, while ontologies
must be authored.

---

### H. Page-as-object management

**Web Pages as 3D Proxies in VR** (CHI EA 2026) represents each page as a virtual
3D proxy with **physical properties**, building a 3D workspace where pages are
organised through everyday physical interactions. **Documents in Your Hands**
(CHI 2025) studies interaction techniques for spatially arranging AR documents.
**An Immersive Layout Framework for Web Design in VR** (CHI EA 2023) proposes a
**fan-shaped layout** and analyses spatial layout of site hierarchy, multimedia
presentation, and interaction modes.

**Comparison.** This family operates one level *above* Web-to-Space: it spatialises
*collections of pages*, treating each page as atomic. The repo's `TabBar.tsx` and
Carousel view ("pages arc around the user in a cylinder") are the seed of the same
idea — and the Carousel is essentially the CHI EA 2023 fan-shaped layout, arrived
at independently. Citing that paper would let you claim the design is
literature-supported rather than ad hoc.

---

## 3. Summary: Novelty and Gaps

### What is defensibly novel here

1. **Accessibility tree as the primary spatialisation signal.** Families B–D use
   geometry or text statistics; family F uses physical-scene semantics. Using ARIA
   roles, landmarks, and label resolution to drive both *primitive selection* and
   *spatial slotting* of an arbitrary URL is, on this survey, largely unoccupied
   ground. The accessibility-first framing also carries a genuine secondary
   argument: it rewards well-authored pages and makes semantic HTML pay off in a
   new medium.
2. **A total, no-drop mapping.** 66 IR roles → 42 XR primitives with
   `XRGenericPanel` as a guaranteed fallback. Extraction-based approaches
   (Readability) and segmentation approaches (VIPS) both discard content by
   construction. "Every node survives to the scene" is a checkable invariant and a
   real distinction.
3. **Strict five-stage purity with a swappable-backend evaluation.** Because
   parser, mapper, and layout are independent pure functions, the repo can hold two
   of three fixed and vary the third. `eval/segmentation.ts` explicitly routes each
   segmenter around `parsePageToIR` to avoid the shared-parser confound. This kind
   of ablation discipline is rare in the XR-layout literature and is a methods
   contribution in its own right.
4. **Literature-grounded spatial metrics applied to web-derived scenes.** Angular
   legibility thresholds (0.29° floor, 1.375° comfort target), comfort-cone
   occupancy, FOV fill, and page-turn cost are standard in XR text research but are
   not, as far as this survey found, routinely applied to evaluate *automatically
   generated* web-derived layouts. Combining Kiesel's BCubed segmentation scoring
   with XR spatial-quality scoring in one harness is a novel evaluation package.
5. **Device profiles as first-class.** Quest 3 / Quest Pro / Ray-Ban Meta profiles
   with `RenderMetrics` as the single source of dimensional truth means the same
   scene retargets across form factors. Most research prototypes hard-code one
   device.

### Gaps, ranked by leverage

| # | Gap | Prior art to draw on | Effort |
|---|---|---|---|
| 1 | **No user study.** All computational metrics, no human validation. | BTW (15 participants), SemanticAdapt, Lindlbauer et al. | High, unavoidable for publication |
| 2 | **Layout is rule-based, not optimised.** The cost terms already exist in `xr-quality.ts` but only score, never drive. | FLARE, Lindlbauer '19, SemanticAdapt, Active Follow | Medium — highest ratio of novelty to work |
| 3 | **AI fallback layer is a stub.** Third classification layer unexercised; div-soup pages are where it matters and where the corpus is weakest. | SituationAdapt (LLM-in-the-loop) | Medium |
| ~~4~~ | ~~**VIPS baseline is handicapped (no CSSOM).**~~ **Done** — `ir/vips-visual.ts` implements the full algorithm over a rendered frame; BCubed weights by pixel area when layout exists; degraded runs are reported in the report, the CSV rows and the in-app panel. | Cai et al. 2003; Kiesel et al. 2020 | — |
| 5 | **Nothing is user-movable or persistent.** BTW's core finding is that spatial meaning-making requires re-arrangement. | BTW, Documents in Your Hands, Ethereal Planes | Medium |
| 6 | **No physical-environment awareness.** No plane detection, no surface anchoring; placement is purely egocentric. | FLARE, SemanticAdapt, BTW | Medium |
| 7 | **No authoring escape hatch.** Inference is all-or-nothing; a site author cannot correct it. | VRIA declarative spec; semantic meta-scenes | Low |
| 8 | **Interactivity is lost.** Primitives are re-rendered; JS behaviour does not survive. BTW keeps pages live. | BTW | High (architectural) |
| 9 | **Design vocabulary not adopted.** The five view modes are unframed; Ethereal Planes' reference frames describe them exactly. | Ens et al., SUI 2014 | Trivial |
| 10 | **Segmentation ground truth is a proxy oracle** that degenerates on div-soup — inflating means on the hardest pages. | Kiesel et al. gold annotations | Low–Medium |

### One-paragraph positioning statement

> Prior approaches to bringing web content into XR either preserve the page as a
> flat texture (Wolvic, Quest Browser), decompose it geometrically from rendered CSS
> boxes (Web2VR, Break-the-Window), segment it visually (VIPS), or strip it to an
> article (Readability) — none of which recover *what the content means*.
> Separately, a mature computational-layout literature (FLARE, Lindlbauer et al.,
> SemanticAdapt) optimises XR placement, but assumes a small set of pre-authored
> panels rather than an arbitrary URL. Web-to-Space bridges the two: it derives a
> complete semantic representation of an unmodified page from its accessibility
> tree, maps every node to a typed 3D primitive with no drops, and places those
> primitives with device-specific ergonomic metrics — evaluated with both
> BCubed segmentation scores (Kiesel et al., CIKM 2020) and XR angular-legibility
> and comfort-envelope measures.

---

## 4. Sources

**Web page segmentation and extraction**

- Cai, D., Yu, S., Wen, J.-R., Ma, W.-Y. *VIPS: a Vision-based Page Segmentation Algorithm.* Microsoft Research Technical Report MSR-TR-2003-79, 2003. — [MSR page](https://www.microsoft.com/en-us/research/publication/vips-a-vision-based-page-segmentation-algorithm/) · [PDF](https://www.microsoft.com/en-us/research/wp-content/uploads/2016/02/tr-2003-79.pdf)
- Kiesel, J., Kneist, F., Meyer, L., Komlossy, K., Stein, B., Potthast, M. *Web Page Segmentation Revisited: Evaluation Framework and Dataset.* CIKM 2020, 3047–3054.
- Akpınar, M. E., Yeşilada, Y. *Vision Based Page Segmentation Algorithm: Extended and Perceived Success.* ICWE 2013 Workshops, LNCS 8295, Springer. — [Springer](https://link.springer.com/chapter/10.1007/978-3-319-04244-2_22) · [PDF](https://link.springer.com/content/pdf/10.1007/978-3-319-04244-2_22.pdf) · [ACM DL](https://dl.acm.org/doi/10.1007/978-3-319-04244-2_22)
- Mozilla Readability (`@mozilla/readability`) — the content-extraction baseline used in this repo.

**Web pages in XR**

- *Break the Window: Exploring Spatial Decomposition of Webpages in XR.* arXiv:2603.02471. — [arXiv](https://arxiv.org/abs/2603.02471) · [PDF](https://arxiv.org/pdf/2603.02471)
- *Web Pages as 3D Proxies in VR: A Design Framing and Preliminary Exploration.* CHI EA 2026. — [ACM DL](https://dl.acm.org/doi/10.1145/3772363.3798605)
- *An Immersive Layout Framework for Web Design in Virtual Reality.* CHI EA 2023. — [ACM DL](https://dl.acm.org/doi/abs/10.1145/3544549.3585889)
- *Documents in Your Hands: Exploring Interaction Techniques for Spatial Arrangement of Augmented Reality Documents.* CHI 2025. — [ACM DL](https://dl.acm.org/doi/abs/10.1145/3706598.3713518)
- Wolvic / Firefox Reality — [Igalia announcement](https://www.igalia.com/2022/02/03/Introducing-Wolvic.html) · [Wolvic repo](https://github.com/Igalia/wolvic) · [Mozilla Firefox Reality launch](https://blog.mozilla.org/en/firefox/firefox-reality-now-available/)
- kikoano/web2vr — the geometric-decomposition approach ported in `src/ir/web2vr.ts`.

**Computational XR layout**

- Gal, R., Shapira, L., Ofek, E., Kohli, P. *FLARE: Fast Layout for Augmented Reality Applications.* ISMAR 2014, 207–212. — [Microsoft Research](https://www.microsoft.com/en-us/research/publication/flare-fast-layout-for-augmented-reality-applications/)
- Lindlbauer, D., Feit, A. M., Hilliges, O. *Context-Aware Online Adaptation of Mixed Reality Interfaces.* UIST 2019. — [ACM DL](https://dl.acm.org/doi/10.1145/3332165.3347945) · [Project page](https://ait.ethz.ch/computationalmr) · [Code](https://github.com/eth-ait/ComputationalMR)
- Cheng, Y., Yan, Y., Yi, X., Shi, Y., Lindlbauer, D. *SemanticAdapt: Optimization-based Adaptation of Mixed Reality Layouts Leveraging Virtual-Physical Semantic Connections.* UIST 2021. — [ACM DL](https://dl.acm.org/doi/10.1145/3472749.3474750) · [Code](https://github.com/ycheng14799/SemanticAdapt)
- *SituationAdapt: Contextual UI Optimization in Mixed Reality with Situation Awareness via LLM Reasoning.* UIST 2024. — [ACM DL](https://dl.acm.org/doi/10.1145/3654777.3676470) · [arXiv](https://arxiv.org/pdf/2409.12836)
- *Active Follow: Optimizing User Interface Placement in Dynamic Extended Reality Environments.* — [ScienceDirect](https://www.sciencedirect.com/science/article/abs/pii/S014193822600168X)
- *Designing Fatigue-Aware VR Interfaces via Biomechanical Models.* arXiv:2603.26031. — [arXiv](https://arxiv.org/html/2603.26031)
- Jiang, Y. et al. *ORCSolver: An Efficient Solver for Adaptive GUI Layout with OR-Constraints.* — [arXiv](https://arxiv.org/pdf/2002.09925)

**2D-in-3D design frameworks**

- Ens, B., Hincapié-Ramos, J. D., Irani, P. *Ethereal Planes: A Design Framework for 2D Information Spaces in 3D Mixed Reality Environments.* SUI 2014. — [ACM DL](https://dl.acm.org/doi/10.1145/2659766.2659769) · [PDF](http://hci.cs.umanitoba.ca/assets/publication_files/EP-SUI-CR__website_version.pdf)

**Declarative Web3D / semantic 3D**

- Butcher, P. W. S., John, N. W., Ritsos, P. D. *VRIA: A Web-Based Framework for Creating Immersive Analytics Experiences.* IEEE TVCG, 2020. — [DOI](https://dl.acm.org/doi/abs/10.1109/TVCG.2020.2965109) · [Code](https://github.com/vriajs/vria)
- Sons, K. et al. *XML3D: Interactive 3D Graphics for the Web.* — [ResearchGate](https://researchgate.net/publication/221010946_XML3D_interactive_3D_graphics_for_the_web)
- Flotyński, J., Walczak, K. *The Semantic Web3D: Towards Comprehensive Representation of 3D Content on the Semantic Web* and *On-Demand Generation of 3D Content Based on Semantic Meta-Scenes.* — [Springer](https://link.springer.com/chapter/10.1007/978-3-319-13969-2_24)

**Accessibility and XR text**

- W3C. *Accessible Rich Internet Applications (WAI-ARIA) 1.2.* — [W3C TR](https://www.w3.org/TR/wai-aria-1.2/)
- *RAVEN: Realtime Accessibility in Virtual ENvironments for Blind and Low-Vision People.* arXiv:2510.06573. — [arXiv](https://arxiv.org/pdf/2510.06573)
- *Inclusive Immersion: a review of efforts to improve accessibility in virtual reality, augmented reality and the metaverse.* Virtual Reality, Springer, 2023. — [Springer](https://link.springer.com/article/10.1007/s10055-023-00850-8)
- *The influence of text rotation, font and distance on legibility in VR.* IEEE VR 2020. (source of the 0.29° legibility floor used in `eval/xr-quality.ts`)
- *Perceiving Multilingual Text in Virtual Reality.* ACM VRST 2025. (source of the 1.375° comfort target)

**WebXR platform**

- MDN. *WebXR Device API — Fundamentals.* — [MDN](https://developer.mozilla.org/en-US/docs/Web/API/WebXR_Device_API/Fundamentals)
- Immersive Web Working Group. — [immersiveweb.dev](https://immersiveweb.dev/)
