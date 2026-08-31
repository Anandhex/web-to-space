# Prior-art and novelty audit — Web-to-Space

Independent adversarial review, 2026-08-28. Companion to `docs/related-work.md`
(which is **stale in several places** — see §L).

**Verification key.** `[V]` = primary source read or abstract read directly in
this audit. `[S]` = secondary source (search summary, catalogue entry) only.
`[K]` = asserted from background knowledge, not re-verified here — treat as a
lead to check before citing.

---

## A. Executive conclusion

**Has the exact pipeline already been done? No — not as one system, and not
with accessibility semantics as the driving signal.** I could not find any
work that runs HTML5/ARIA extraction → a renderer-independent semantic IR →
automatic spatial restructuring → several fundamentally different spatial
compositions → semantic link-relation-to-direction mapping. But the chain is
not novel link-by-link, and three items come close enough to be quoted at you
in a defence. The most dangerous is **not a paper**: Magic Leap's patent
family (US10930076B2, "Matching content to a spatial 3D environment") already
claims *content → parser → logical structure (tree/graph/ordered array) →
per-element attributes → match score → surface placement* for web content in
MR `[V]`. The closest published system is **Xing et al., Applied Sciences
12(11):5600, 2022**, which splits a website into content / navigation /
scrollbar widgets and puts main content in front with the rest oblique above
and below `[V]` — the same landmark-to-slot intuition, but hand-designed in
Unreal, not derived from markup. The closest recent HCI work is
**Break the Window (CHI EA 2026)**, which spatially decomposes live webpages
into movable panels `[V]` — geometric decomposition, user-arranged, empirical
contribution. Separately, **SADIe/Dante (Harper & Yesilada)** already
established the whole *semantics → alternative rendering* move, for audio and
small screens rather than space `[V]` — this destroys any "nobody re-renders
pages from their semantics" framing, and is simultaneously your best
positioning asset. Your defensible ground is narrow and real: **the
accessibility tree of an unmodified page as the primary spatialisation signal,
a renderer-independent IR that three unlike spatial compositions consume, and
link-relation-as-direction with a reader-relative navigation lattice.** Of
those three, the link-direction work is the least contested and — judging by
the code — the part you are most underselling.

---

## B. Prior-art table

Ordered roughly by proximity to your pipeline. "IR?" means an explicit
representation between interpretation and rendering.

| # | Work | Year | Venue | Input | Semantic extraction | ARIA/HTML5 | IR? | Spatial transformation | Multiple layouts | Hyperlink semantics | XR? | Evaluation | Sim. | Exact gap |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | Magic Leap, *Matching content to a spatial 3D environment* (US10930076B2 + continuations) `[V]` | 2018–25 | Patent | Web content | Parser identifies elements; attributes incl. priority, type-of-content, readability index, position type | No ARIA; "explicit indications in the content" + placement inference | **Yes** — "ordered array, hierarchical table, tree structure, or logical graph structure" | Match score per (element, surface); best surface wins | Environment-driven, not layout-family | Not claimed | MR | None (patent) | **High** | Attributes are geometric/presentational, not a11y-semantic; target is *physical room surfaces*; no landmark model; no link relations; no evaluation |
| 2 | Magic Leap, *Managing and displaying webpages in a virtual 3D space* (US12229898, cont. of 16/839,727) `[S]` | 2020–25 | Patent | Webpages | DOM parsing | Unclear | Likely tree | Webpage panels placed/managed in 3D | No | Window/tab management | MR | None | Med-High | Page-as-window management, not intra-page semantic restructuring |
| 3 | Xing, Shell, Fahy, Xie, Kwan, Xie — *Web XR UI Research: Design 3D Layout Framework in Static Websites* `[V]` | 2022 | Applied Sci. 12(11):5600 (+ IEEE 2022) | Static websites | Manual decomposition into content / navigation / scrollbar widgets | Functional roles, not markup-derived | No | One fixed arrangement: main front, others oblique above/below | No | No | HoloLens 2 (Unreal 4) | User study | **High (concept)** | Hand-designed guideline + prototype; not automatic from arbitrary HTML; no parser, no IR, no link model |
| 4 | Zhang, Wei, Yang, Gonzalez-Franco, Yang, Gonzalez — *Break the Window* `[V]` | 2026 | CHI EA (arXiv 2603.02471) | Live webpages | Geometric chunking; pages stay live web views | No | No | Movable panels, mid-air + surface-attached | User-arranged, not system-generated | No | XR | Formative + qualitative, n=15 | **High (goal)** | Decomposition is geometric and interactive, not semantic; contribution is empirical, not architectural |
| 5 | Harper, Yesilada, Stevens, Goble — *SADIe* / *Dante* `[V]` | 2006–08 | ISWC / TOCHI 14(2) / ASSETS | Real web pages | Upper+lower ontology over CSS; explicates *implicit visual structure* | Pre-ARIA structural semantics | **Yes** — ontology annotations | Transcoding to audio / small screen | Yes (multiple output modalities) | No | No | User evaluation, statistically significant | **High (method), Low (medium)** | Same move — semantics → alternative rendering — but the alternative is *audio*, never spatial. Your strongest lineage citation |
| 6 | Cai, Yu, Wen, Ma — *VIPS* `[K]` | 2003 | MSR-TR-2003-79 | Rendered page | Visual blocks + separators, DoC score | No | Block hierarchy | None (motivates "page adaptation") | No | No | No | Qualitative | Med | Segmentation only; no roles, no space. You use it as a baseline — correct |
| 7 | Kiesel et al. — *Web Page Segmentation Revisited* `[K]` | 2020 | CIKM | Pages + annotations | — | No | Partition over atomic elements | None | No | No | No | Size-weighted BCubed P/R/F | Med (method) | Supplies your scoring method, not a competing system |
| 8 | Mozilla Readability / Boilerpipe `[K]` | 2010s | Tool | HTML | Heuristic article extraction | No | Article object | None | No | Discards nav | No | Informal | Med | Deletes exactly the landmarks a spatial browser needs. Your cleanest baseline contrast |
| 9 | Snowdon et al. — *WWW3D* `[V]` | 1997 | VRU '97 | Browsed pages | None (page = atom) | No | Session graph | Pages as spheres, force-directed placement | No | **Yes — links as arrows between page spheres**, history trails | VR (desktop) | Demo | Med-High (links) | Inter-page graph layout; no intra-page semantics, no link *relation* typing, not egocentric |
| 10 | Snowdon et al. — *A 3D Collaborative Virtual Environment for Web Browsing* `[S]` | 1997–98 | VRST-era | Browsed pages | None | No | Region model | Shared 3D regions per page group | No | Awareness of others' traversal | VR | Demo | Med | Collaboration focus; page still atomic |
| 11 | Card, Robertson, York — *WebBook / Web Forager* `[V]` | 1996 | CHI | HTML pages | None (page = atom) | No | Book/workspace model | Book pages, 3D workspace tiers (focus/immediate/tertiary) | Yes-ish (book vs workspace) | Link colouring by within/outside book `[K]` | 3D desktop | Scenarios | Med | Page-as-object; the tiering is *attention*-driven, not document-semantics-driven |
| 12 | Cleary & O'Donoghue — *Creating a Semantic-web Interface with VR* (VR-Net) `[V]` | 2001 | SPIE 4528:138–146 | Search-engine results | Co-citation clustering: "all pages pointing to a common target site collectively form a web-page cluster" | No | Cluster model | VRML clusters per query sense | No | **Yes — link connectivity drives clustering** | VRML | Example queries | Low-Med | **Not what its title suggests.** Search-result disambiguation, not page→space. Correct your hypothesis list |
| 13 | Vilk et al. — *SurroundWeb* `[V]` | 2014–15 | NDSS / MSR | Web pages | None | No | Room skeleton, detection sandbox, satellite screens | Content onto detected room surfaces | Across ≤25 screens | No | 3D browser | 30fps perf. | Med | Contribution is *privacy* (least privilege); page content is not semantically restructured |
| 14 | JSAR / jsar-runtime `[V]` | 2023– | OSS engine | HTML/CSS/TS | Standard HTML parsing | Standard DOM only | DOM | **DOM elements *are* the 3D objects** — "position, rotation, scale, depth"; rendered as textured quads, batched | No | Standard | XR | Perf. benchmarks | Med | **Confirms your §7 claim.** Spatialises the DOM directly; no higher-level semantic layer, no alternative compositions |
| 15 | WebSpatial API (W3C TPAC 2025 breakout) `[V]` | 2025 | W3C | Author's HTML/CSS | None inferred | Extends CSS on Z axis | No | Author declares spatial properties | No | Standard | Spatial devices | — | Med | **Author-declared, not inferred.** Opposite direction from yours |
| 16 | kikoano — *Web2VR* `[V]` | 2020 | OSS (A-Frame) | Live DOM | `getBoundingClientRect` + `getComputedStyle` | No | None | px→metre, DOM nesting → z | No | Clickable | WebVR | None | Med | Pure geometric transcription. Was ported here as a baseline; **that port no longer exists in the repo** (§L) |
| 17 | DOM2AFrame `[V]` | 2017 | Web Perf. Calendar | Live DOM | Computed style diffing | No | None | DOM → A-Frame entities | No | Standard | WebVR | None | Med | Same family as #16 |
| 18 | Lee et al. — *Unified Representation for XR Content and its Rendering Method* `[V]` | 2020 | Web3D '20 | Authored XR markup | None inferred | New XML tags | **Yes — unified XR representation** | Same content renders in VR and AR | **Yes (VR vs AR modes)** | No | WebXR | Demo | Med | The IR is *authored*, not inferred; "multiple renderings" means VR-vs-AR device modes, not layout metaphors |
| 19 | Gal, Shapira, Ofek, Kohli — *FLARE* `[K]` | 2014 | ISMAR | Authored app components | None | No | Constraint spec | CSP solve over scene | Yes (per environment) | No | AR | Perf. | Med | Content is pre-authored and bounded; no web input |
| 20 | Lindlbauer, Feit, Hilliges — *Context-Aware Online Adaptation of MR Interfaces* `[K]` | 2019 | UIST | Authored apps | Task/cognitive load | No | Optimisation model | What/where/how-much to show | Yes (adaptive) | No | MR | Controlled study | Med | Adapts a known app set; not document semantics |
| 21 | Cheng et al. — *SemanticAdapt* `[K]` | 2021 | UIST | Authored UI elements | Semantics of the **physical room** | No | Optimisation model | Virtual-physical semantic matching | Yes (per room) | No | MR | Study | Med | Its "semantics" are about the desk and the wall, not the document. Do not conflate |
| 22 | *SituationAdapt* `[K]` | 2024 | UIST | Authored UI | LLM situation reasoning | No | Optimisation model | Context-aware placement | Yes | No | MR | Study | Low-Med | Social/environmental context; no web input |
| 23 | Ens, Hincapié-Ramos, Irani — *Ethereal Planes* `[K]` | 2014 | SUI | — | — | No | Design framework | 4 reference frames × 7 dimensions | Descriptive | No | MR | — | Low (vocabulary) | Gives you the vocabulary to describe wall/deck/rooms. Adopt it |
| 24 | Butcher, John, Ritsos — *VRIA* `[K]` | 2019–20 | CHI EA / TVCG | Declarative vis. spec | Author-declared | No | Declarative grammar | Grammar → immersive vis. | Yes | No | WebVR | Perf. + cases | Low-Med | Author opts in; no legacy page |
| 25 | Sons et al. — *XML3D*; X3D/VRML lineage `[K]` | 2010 / 1997– | Web3D | Authored 3D markup | — | DOM events | Scene graph | Declarative | No | Standard | Web3D | — | Low | 3D as web citizen — the inverse problem |
| 26 | Flotyński & Walczak — semantic/ontology-based 3D content `[K]` | 2014– | Springer/Web3D | Domain ontologies | Description logics | No | **Yes — semantic meta-scenes** | Ontology → 3D scene | Yes | No | Web3D | Cases | Med | Closest *formalism* analogue to your IR, but ontologies must be authored; ARIA already exists on real pages |
| 27 | *Web Pages as 3D Proxies in VR* `[K]` | 2026 | CHI EA | Pages | None | No | Proxy object | Physical-property proxies for many pages | No | Between-page | VR | Preliminary | Low-Med | One level above you: spatialises *collections*, page atomic |
| 28 | *Documents in Your Hands* `[K]` | 2025 | CHI | AR documents | None | No | — | Interaction techniques for arranging documents | No | No | AR | Study | Low | Interaction, not generation |
| 29 | ViPR — *Virtual Planning Rooms* `[S]` | ~2000s | Vis. | Hierarchical info | Hierarchy | No | — | Info on walls of octagonal rooms; **doorways to adjoining rooms** | No | Hierarchy → doors | VR | — | Med (metaphor) | Your rooms/doors metaphor has precedent, for hierarchical data not webpages |
| 30 | *Navigation in hypertext through virtual environments* `[S]` | 1993 | Int. J. Man-Machine Studies | Hypertext | — | No | — | 2D/3D schematic + spatial navigation aids | 4 aid types | **Yes — hypertext navigation in VE** | VE | Comparative | Med | Pre-web, hand-built environments; establishes the question is 30+ years old |
| 31 | Shipman et al. — spatial hypertext (VIKI, VKB) `[S]` | 1993–2004 | HT | User-placed objects | **Spatial parser** infers structure from layout | No | Implicit type recogniser | Space *is* the notation | No | Rejects explicit links | 2D | Studies | Med | **Inverse direction**: infers semantics from space. Your work infers space from semantics. Say this explicitly — it is a good sentence |
| 32 | W3C — *Web & Virtual Reality Workshop Report* `[V]` | 2016 | W3C | — | — | — | — | Named "turning Web pages into enjoyable Virtual Reality spaces" as a standardisation need | — | — | — | — | Low (motivation) | A workshop report, not a system. Cite as evidence the problem was named and left open |
| 33 | W3C — *Inclusive Design for Immersive Web Standards* report `[V]` | 2019 | W3C | — | — | ARIA discussed | — | — | — | — | XR | — | Low | States ARIA is "unlikely to be a scalable approach to annotate full 3D environments" — that is the **reverse** direction (annotating 3D with ARIA). Do not let an examiner read it as refuting you; pre-empt it |
| 34 | Akpınar & Yeşilada — *VIPS Extended and Perceived Success* `[K]` | 2013 | ICWE W. | Pages | Extended VIPS | No | Blocks | For small screens / audio | No | No | No | Online user eval | Med | Finding — finer granularity perceived as better — is a ready-made hypothesis for your user study |
| 35 | Wolvic / Firefox Reality / Quest Browser / visionOS Safari `[K]` | 2018– | Product | Live page | None | Preserved for AT | None | Flat quad | No | Standard | XR | — | Low (baseline) | The production baseline you must beat. Already implemented as your `flat` control |

---

## C. Top 10 closest prior works

| Rank | Work | Sim. | Why similar | Why not the same | Threat |
|---|---|---:|---|---|---|
| 1 | Magic Leap US10930076B2 family | **72** | Literally *content → parser → logical structure → attributes → spatial placement*. The IR is named and enumerated (tree/graph/ordered array) | Attributes are presentational/geometric (aspect ratio, readability index, priority), never ARIA roles or landmarks. Placement target is detected physical surfaces, not layout metaphors. No link relations. No evaluation, no research claim | **Severe on architecture, mild on research.** A supervisor who searches patents will find it. Cite it yourself, first |
| 2 | Xing et al. 2022 (Appl. Sci. 12:5600) | **62** | Same target intuition: main content front, navigation and secondary content displaced to oblique slots. Web-specific, XR-specific, user-evaluated | Not automatic. No parser, no markup analysis, no IR. Prototype hand-built in Unreal 4; contribution is *design principles* | **High on the "landmark→slot is novel" claim.** Kills any wording like "first to place navigation peripherally" |
| 3 | Break the Window (CHI EA 2026) | **58** | Same problem statement, almost the same opening sentence you would write. Decomposes a real webpage into spatial panels in XR | Chunks are live web views placed geometrically and moved *by the user*; no semantic model, no IR, no generated layout family. Poster/EA, empirical | **High on framing.** Your intro must not read as its abstract. Also: it is the honest source for "spatial decomposition helps" |
| 4 | SADIe / Dante | **55** | The exact epistemic move: recover implicit structure from an ordinary page, then re-render in an alternative modality. Ontology as IR. Multiple output modalities | Modality is audio and small-screen; nothing spatial, nothing 3D. Requires authored ontology annotations tied to CSS | **Low as a competitor, high as a corrective.** Use it to establish the lineage — then your contribution is "the spatial member of this family" |
| 5 | WWW3D | **48** | Hyperlinks become geometry; browsing history becomes navigable space; incremental layout | Page is an atom (a sphere). No intra-page structure, no link *typing*, layout is force-directed graph, not reader-relative direction | **Medium on the hyperlink claim.** Prevents "nobody spatialised hyperlinks" |
| 6 | JSAR | **45** | A working spatial web browser engine consuming real HTML in XR | Spatialises DOM elements directly as textured quads. No semantic inference layer, no IR above the DOM, one composition | **Low, and useful.** It is the clean empirical proof of the DOM-vs-semantic-IR distinction you want to draw |
| 7 | Flotyński & Walczak, semantic 3D / meta-scenes | **42** | Explicit semantic representation → generated 3D content; formalism-first | Ontologies are authored for the 3D domain; no web document input; not about re-presenting existing pages | Medium on the "semantic IR → 3D" claim. Forces you to say *which* semantics |
| 8 | VIPS (+ Kiesel evaluation) | **38** | Structural decomposition of a real page, explicitly motivated by "automatic page adaptation" | Produces blocks, not roles; stops before any rendering | Low — you already use it as a baseline, which is the right relationship |
| 9 | SemanticAdapt | **34** | "Semantic" + adaptive XR layout, optimisation-based | Its semantics describe the *physical room*. Content is pre-authored UI, not a document | Low, but examiners conflate the words. Pre-empt in one sentence |
| 10 | Web Forager / WebBook | **30** | Web content in a 3D workspace with attention tiers; link colouring by scope | 1996 desktop 3D, page atomic, manual book assembly | Low. Historical anchor; cite for the tiering idea |

---

## D. HTML5 + ARIA investigation

**Question: has HTML5 semantic markup + WAI-ARIA been used to automatically
derive spatial webpage layouts for VR/XR?**

**I found no such work.** Verdict: **strongly underexplored**, with one
important qualification.

What exists, and why none of it is this:

- ARIA in XR is discussed almost exclusively in the **reverse direction** —
  can ARIA annotate a 3D scene for assistive technology? The W3C Inclusive XR
  workshop report `[V]` concludes it cannot scale for that purpose. This is a
  statement about *describing 3D with ARIA*, not about *deriving 3D from
  ARIA*. Quote it and draw the distinction yourself; otherwise someone else
  will quote it at you as if it settled the matter.
- ARIA landmarks are used as an input signal in **non-spatial** adaptation:
  screen-reader navigation, reader modes, and — closest — SADIe's ontology
  transcoding `[V]`. The signal-to-alternative-rendering move is established;
  the spatial target is not.
- The accessibility tree is having a moment as a **page representation for LLM
  agents** (filtering HTML into AX-tree-like form improves web-agent
  performance) `[S]`. This is the same underlying claim you are making — the
  a11y tree is a good compressed semantic view of a page — arriving from a
  completely different community. **Cite it.** It converts your architectural
  choice from an idiosyncrasy into a convergent finding.
- Xing et al. `[V]` reach a landmark-like decomposition (content / navigation)
  but by hand, not from markup.

**How confidently can you say this is underexplored?** Reasonably, if you
scope it precisely. Say: *"In the literature surveyed, no system was found
that uses HTML5 sectioning elements and WAI-ARIA roles as the primary input to
an automatic spatial layout process."* Do not say "no one has ever." The
searched space is listed in §I.

---

## E. Semantic IR investigation

**Question: has anyone put a semantic intermediate representation between
webpage interpretation and spatial rendering?**

Yes — three times, none of them with your semantics:

1. **Magic Leap US10930076B2** `[V]` is the real one. The parser "may identify
   and subsequently organize and store the content elements in logical
   structures", and the claim enumerates "an ordered array, a hierarchical
   table, a tree structure, or a logical graph structure". Attributes attached
   per element include priority, type-of-content, position type, readability
   index. That **is** an IR between parsing and placement. **Your difference is
   the vocabulary, not the existence of the layer**: their attributes are
   presentational and geometric so that elements can be scored against physical
   surfaces; yours are accessibility roles and landmark relations so that
   elements can be scored against *document* structure. Argue on the
   vocabulary, and stop claiming the layer itself is new.
2. **SADIe** `[V]` — an ontology over CSS as the IR, feeding multiple output
   transcodings. Same shape, non-spatial target.
3. **Flotyński's semantic meta-scenes** `[K]` — explicit semantic layer → 3D,
   but authored ontologies, no web document.

Against A-vs-B in your §9: **B exists, but only with non-accessibility
semantics.** The distinction that survives is not "IR vs DOM" in the abstract —
it is *which* semantics the IR encodes, and whether the IR is
renderer-independent enough that unlike renderers consume it unchanged. Your
code supports the second half strongly: `mapper/` extracts facts and is
forbidden from assigning positions, `layout/engine.ts` owns all placement, and
`links/` is renderer-free and three.js-free by construction so it runs in Node
under the census. That enforced separation is checkable, unusual, and worth a
paragraph.

---

## F. Multiple spatial representations

**Question: one semantic representation → several fundamentally different
spatial compositions of the same page?**

**No prior instance found.** Verdict: **likely underexplored** — with the
caveat that this is also the claim most vulnerable to a "so what?" attack.

- Optimisation systems (FLARE, SemanticAdapt, Lindlbauer) produce different
  layouts, but as a function of a *different physical environment*, from one
  cost model — not as distinct authored spatial idioms `[K]`.
- *Unified Representation for XR Content* `[V]` renders one representation in
  both VR and AR — device modes, not composition metaphors.
- Xing et al. `[V]` and Break the Window `[V]` each have exactly one
  arrangement.

Your `rooms` / `wall` / `deck` are genuinely three different spatial concepts —
the code says so explicitly and means it (walk-through environment / survey at
once / handle as objects on a surface), and all three consume the same
`SemanticScene` through one `Arrangement` parameter. That is a real
architectural demonstration. **But three metaphors is a demonstration, not a
finding.** The claim only becomes research if you show something *differential*:
that the same IR yields measurably different XR-quality scores per metaphor, or
that a metaphor suits some page classes and not others. Your `eval/xr-quality.ts`
already computes per-layout comfort coverage, FOV fill and page-turn cost — run
it across all three metaphors on the same corpus and the claim acquires a number.
Right now it is an assertion.

---

## G. Hyperlink investigation

**Question: has semantic link relation → spatial relation/navigation been done
for automatically generated spatial webpages?**

**Not in the form your code implements.** Verdict: **strongly underexplored** —
and this is your strongest and most under-described contribution.

What exists:
- **WWW3D** `[V]`: links → arrows between page spheres, force-directed. Graph
  topology, untyped, exocentric.
- **Cleary & O'Donoghue (VR-Net)** `[V]`: link co-citation → clusters in VRML.
  Inter-*site*, and about query disambiguation, not page structure.
- **WebBook** `[K]`: link colouring by within-book vs outside-book — a
  two-valued relation type mapped to a *visual* channel, not a spatial one.
- **Spatial hypertext (VIKI/VKB)** `[S]`: the inverse — infers meaning from
  user-chosen spatial arrangement.
- **Automatic hypertext link typing** `[S]`: link relations classified, but for
  retrieval, never mapped to geometry.

What your code does that none of these do — and which **your prompt described
inaccurately**: `links/classify.ts` assigns each reference exactly one of five
*regions* (`page`, `footing`, `field`, `ascent`, `arrangement`) plus a `locus`,
scored against a gold set; `links/direction.ts` re-projects those onto five
*egocentric directions* (`up`/`lateral`/`here`/`down`/`inline`) that are
identical across all views so the reader learns one legend; and
`links/memory.ts` maintains **reader-relative corridors** over a
non-commutative navigation lattice, with an explicit argument for why absolute
axes from a session origin cannot represent a turn. The code also documents a
measured negative result — 49.8% of anchors share a block with another anchor,
so spatial alignment alone cannot disambiguate which sentence a door came from,
which is why the anchor keeps an orientation mark.

That is a fuller, better-evidenced contribution than "link relation → spatial
relation". **Write it up as the second contribution of the thesis, not as a
subsection.**

---

## H. Novelty attack — what an examiner will actually say

| Claim | Verdict | Why |
|---|---|---|
| **A.** No one has built a spatial web browser | **False** | SurroundWeb, JSAR, WWW3D, Wolvic, Web Forager. Never write this |
| **B.** No one has converted HTML pages into 3D | **False** | Web2VR, DOM2AFrame, JSAR, Break the Window, Magic Leap patents |
| **C.** No one has used semantic information for VR | **False** | SemanticAdapt, Flotyński, VRIA. Also ambiguous — "semantic" means four different things across these |
| **D.** No one has used HTML5 + ARIA to derive a semantic representation for spatial rendering | **Likely / strongly underexplored** | Nothing found. ARIA-in-XR literature runs the other direction. Nearest miss is Xing et al., which is hand-designed |
| **E.** No one has used a semantic IR to generate multiple spatial layouts of conventional webpages | **Partially supported** | The IR layer itself is claimed in Magic Leap US10930076B2. The *multiple unlike compositions from one IR* part: nothing found |
| **F.** No one has systematically mapped semantic link relations to spatial navigation in a generated page representation | **Likely underexplored** | Untyped link→geometry is old (WWW3D); relation-typed link→egocentric direction with a reader-relative lattice, not found |
| **G.** No prior system evaluates webpage semantic extraction for downstream spatialisation suitability | **Likely underexplored** | Segmentation evaluation exists (Kiesel BCubed); XR legibility/comfort metrics exist (IEEE VR/VRST); **the two combined in one harness over the same corpus** — nothing found. This is a genuine methods contribution and is currently your least-argued one |

**The four attacks to prepare for, verbatim:**

1. *"This is Magic Leap US10930076B2 with ARIA substituted for the attribute
   set."* — Answer: their attribute vocabulary is presentational and their
   matching target is physical surfaces; they neither recover nor use document
   role structure, and there is no evaluation of extraction quality. Then
   concede the IR layer is not itself novel. **Do not let this be discovered
   during the defence rather than in your related-work chapter.**
2. *"Xing et al. already put main content in front and navigation above and
   below."* — Answer: yes, as a hand-authored design guideline validated in a
   user study. The contribution here is deriving that assignment automatically
   from markup for an arbitrary URL, and measuring how often the markup
   supports it. Cite them as motivating evidence that the assignment is a good
   one.
3. *"Break the Window did spatial decomposition of webpages in XR last year."*
   — Answer: geometric decomposition of live web views, user-arranged, no
   semantic model, contribution is a qualitative study. Different layer.
4. *"The three views are a UI demo, not a research result."* — This is the one
   you cannot currently answer. Fix it with §F's differential evaluation before
   submission.

---

## I. Search record (for the "negative evidence" requirement)

Databases and surfaces reached in this audit: Google Scholar-indexed results
via web search, ACM DL (metadata + one 403 on full text), IEEE Xplore
(metadata; 418 on PDF), MDPI, SpringerLink, arXiv, Google Patents (full text),
USPTO full-text PDFs, W3C (workshop reports, TR, TPAC minutes), GitHub,
ResearchGate/Academia (metadata), institutional repositories (Maynooth MURAL —
full text retrieved), university eprints (Nottingham).

Query families run (≈24 distinct queries, several hundred results screened at
title/snippet level, ~14 sources opened): spatial decomposition of webpages in
XR; web page to VR conversion via DOM geometry; accessibility tree / ARIA roles
→ 3D spatial layout; ARIA landmarks + automatic VR placement; semantic HTML +
immersive layout generation; spatial web browser engine architecture; semantic
IR between webpage interpretation and spatial rendering; hyperlink relation →
spatial direction; typed links + 3D navigation; spatial hypertext + automatic
generation; site structure → rooms/doors metaphor; semantic transcoding for
alternative rendering; webpage segmentation evaluation metrics + spatial
suitability; LLM-driven 2D-UI → 3D layout; Magic Leap webpage-in-3D patents;
theses on spatial web browsers.

**Known limits of this search.** No paywalled full texts were read (ACM DL 403,
IEEE 418, MDPI 403) — the Xing et al. and Break the Window characterisations
rest on abstracts and search summaries, and Xing in particular should be read
in full before you rely on the "hand-designed, not automatic" distinction. No
non-English literature. **The thesis/dissertation sweep in your §15 was not
completed** — targeted repository searches (TU Dresden Qucosa, ETH Research
Collection, RWTH, DiVA, EThOS) returned nothing usable through general web
search, and those repositories need to be queried through their own interfaces.
Treat the thesis layer as **unsearched**, not as clear. Given a WebXR master's
thesis is exactly where an unpublished near-duplicate would live, do that sweep
yourself before finalising.

---

## J. Recommended novelty claim

> This work presents Web-to-Space, a pipeline that derives a spatial
> representation of an unmodified web page from its accessibility semantics.
> Unlike existing approaches that spatialise the DOM geometrically or preserve
> the page as a flat surface, the system uses HTML5 sectioning elements and
> WAI-ARIA roles — augmented by structural inference where explicit semantics
> are absent — to construct a renderer-independent semantic intermediate
> representation, from which three distinct spatial compositions are generated
> without re-interpreting the document. References are classified by their
> relation to the current document and projected onto a fixed set of egocentric
> directions, giving cross-document navigation a consistent spatial legend. The
> extraction stage is evaluated against naive, Readability-based and VIPS
> baselines using size-weighted BCubed segmentation scores, and the resulting
> layouts are scored with angular-legibility and comfort-envelope metrics —
> combining, to our knowledge, two evaluation traditions that have not
> previously been applied to the same artefact.

Note what this does **not** claim: not the first spatial browser, not the first
webpage-in-3D, not the first semantic IR before a spatial renderer, not the
first to spatialise hyperlinks.

---

## K. Recommended Related Work structure

Your proposed seven sections are not wrong but they are organised by *topic*,
which makes the gap an assertion at the end. Reorganise by **what the system
takes as its decomposition signal** — then the gap is a hole in a table the
reader can see.

1. **Web content in immersive environments** — flat proxy (Wolvic, Quest
   Browser, visionOS), page-as-object (Web Forager, Web Pages as 3D Proxies),
   spatial decomposition (Break the Window, Xing et al.). Establishes the
   problem and the production baseline.
2. **Decomposition signals for automatic transformation** — the core section,
   as a table on one axis: *rendered geometry* (Web2VR, DOM2AFrame, JSAR),
   *visual structure* (VIPS, Kiesel), *text statistics* (Readability,
   Boilerpipe), *document semantics* (SADIe/Dante, ARIA/a11y-tree work,
   a11y-tree-as-LLM-representation), *physical-scene semantics* (FLARE,
   SemanticAdapt, SituationAdapt). Your row is the empty cell:
   document semantics → spatial output.
3. **Intermediate representations between interpretation and rendering** — the
   honest section. SADIe's ontology, Flotyński's meta-scenes, Magic Leap's
   logical structures, declarative Web3D (VRIA, XML3D, WebSpatial). Concede the
   layer is established; argue the vocabulary.
4. **Spatial composition of 2D information** — Ethereal Planes as vocabulary,
   ViPR, immersive analytics. Frames rooms/wall/deck as reference-frame choices
   rather than three demos.
5. **Hyperlinks, hypertext and spatial navigation** — WWW3D, VR-Net, WebBook
   link colouring, spatial hypertext (as the inverse move), automatic link
   typing, hypertext-in-VE (1993). Your second contribution lands here.
6. **Evaluating page decomposition and spatial legibility** — Kiesel BCubed,
   Akpınar & Yeşilada perceived quality, XR angular-legibility and comfort
   literature. Sets up §G's methods claim, which otherwise has no home.
7. **Summary: five gaps** — one short paragraph per gap, each pointing at a
   named row of §2's table.

Drop your separate "Semantic Web" section entirely, or reduce it to one
clarifying footnote. Mixing Semantic Web (RDF/OWL) with semantic HTML is the
single most common way this thesis could look confused, and your §16 instinct
is correct: **add a terminology paragraph in the background chapter** fixing
*Semantic Web* ≠ *semantic HTML* ≠ *accessibility semantics* ≠ *accessibility
tree* ≠ *page segmentation* ≠ *spatial hypertext*. One page, early. It will
save you in the viva.

---

## L. Where you differ from your own description — and where the repo docs are stale

**Ways the real system is stronger than your prompt described it:**

1. **The link model is not a six-way URL taxonomy.** You described "site nav /
   same-site / fragment / external / mailto / download". The code implements a
   five-region model (`page`, `footing`, `field`, `ascent`, `arrangement`) with
   an orthogonal `locus`, an explicit rule for the citation/fragment conflict,
   a `synthesised`/`degenerate` label-quality signal, and a documented rejected
   design (radius-as-cost) with the reason it failed. Your taxonomy is what a
   URL parser produces; the code's is a *document-relational* model. Describe
   the latter.
2. **Direction, not just relation.** `links/direction.ts` projects relations
   onto five egocentric directions held constant across all three views, with a
   deliberate no-colour, no-underline constraint. That is a design claim with a
   rationale — absent from your prompt.
3. **Cross-document spatial memory.** `links/memory.ts` implements
   reader-relative corridors on a non-commutative lattice, with a written
   argument for why the obvious absolute-axis design cannot represent a turn.
   Nothing in your prompt mentions navigation *across* pages persisting as
   space. This is arguably the most novel thing in the repository and it is
   missing from your own summary of your thesis.
4. **A measured negative result** (49.8% of anchors share a block, so alignment
   cannot disambiguate) — theses are strengthened, not weakened, by these.
5. **Enforced layer purity as a research instrument**, not just tidiness:
   `links/` and `mapper/` are renderer-free so they run in Node under the
   offline census, which is what lets you swap segmenters while holding layout
   fixed.

**Ways the real system is smaller than your prompt implied:**

6. `<nav>`, `<aside>`, `<header>` **no longer get their own spatial slots.**
   Per `CLAUDE.md`, the rails were removed 2026-08-19 and now fold into the
   content panel's flow; `selectSlots` offers exactly three — `main`, `alert`,
   `dialog`. Your prompt's diagram implies landmark→region placement that the
   current engine does not do. Either restore it, or describe what the system
   actually does and justify the fold. **Do not draw the old diagram in the
   thesis.**
7. **One device profile exists** (`QUEST_3_PROFILE`), hard-coded in
   `XRSceneRenderer`. The "device profiles as first-class / retargets across
   form factors" claim in `docs/related-work.md` is not currently supported.
8. **52 IR roles, not 66** (42 XR primitives is correct).

**`docs/related-work.md` is stale and will mislead you if you write from it:**

- It claims a Web2VR port at `src/ir/web2vr.ts` and a `Web2VRScene.tsx`
  comparison backend. **Neither exists.** The backends are Readability, Naive,
  VIPS, Custom. Every "we ported Web2VR" sentence must go, and Web2VR becomes a
  literature comparison only.
- It lists five view modes (Standard / Carousel / Cards / Door / Theatre). The
  code has three (`wall` / `deck` / `rooms`).
- It says the AI fallback is a `StubAIProvider` and unexercised; `CLAUDE.md`
  describes real batched Claude/OpenAI/Gemini/Ollama adapters. One of the two
  is wrong — check before citing either.
- It cites "66 IR roles" and three device profiles (see 7–8 above).

---

## M. Final verdict

| Dimension | Score | Reasoning |
|---|---:|---|
| Novelty of parser | **6/10** | Three-layer ARIA→structural→AI classification over unmodified pages is an unusual combination, but each layer is individually conventional. The no-drop invariant is a real, checkable distinction from Readability and VIPS |
| Novelty of semantic IR | **4/10** | The layer is claimed prior art (Magic Leap). The accessibility-role *vocabulary* and the enforced renderer-independence are what is yours |
| Novelty of semantic→spatial transformation | **6/10** | Automatic and markup-derived, which Xing et al. is not; but weakened by the removal of landmark rails, which was the clearest instance of it |
| Novelty of multiple spatial layouts | **5/10** | No prior instance found, but currently a demonstration rather than a finding. Rises to 7 with a differential per-metaphor evaluation |
| Novelty of hyperlink mapping | **8/10** | Relation-typed links → fixed egocentric directions + reader-relative corridors across documents: nothing comparable found. Your strongest single contribution |
| Novelty of complete integrated pipeline | **7/10** | The combination is not duplicated anywhere found; the individual links mostly are |
| Overall research contribution | **6.5/10** | Strong engineering, strong computational evaluation, genuinely unoccupied niche. Held back by no user study, and by the multiple-layout claim not yet being measured. Solid master's; needs the differential eval to be publishable |

**Emphasise these three:**

1. **The accessibility tree as the primary spatialisation signal for an
   arbitrary URL** — with the honest framing that this is the spatial member of
   the SADIe/Dante family, plus the convergent evidence from a11y-tree-as-LLM-
   page-representation work.
2. **Link relation → egocentric direction, and navigation memory as space** —
   under-described in your own account, least contested in the literature,
   already has gold-set numbers and a documented negative result.
3. **The evaluation package** — BCubed segmentation scoring and XR
   angular-legibility/comfort metrics applied to the *same* artefact, with the
   pipeline's layer purity making per-stage ablation possible. Nothing found
   combines these. Frame it as a methods contribution and give it its own
   related-work subsection.

**Never claim these as novel:**

1. **A spatial / 3D / VR web browser, or putting HTML in 3D.** Thirty years of
   prior art; you will be corrected in the first five minutes.
2. **A semantic intermediate representation between page interpretation and
   spatial rendering.** Magic Leap US10930076B2 enumerates exactly that. Cite it
   yourself and argue on vocabulary and evaluation instead.
3. **Spatialising hyperlinks, or "using semantics for VR" in the general
   sense.** WWW3D spatialised links in 1997; SemanticAdapt and Flotyński both
   have prior claim on "semantics" + 3D — with different meanings of the word,
   which is precisely why you must define your terms before you use them.
