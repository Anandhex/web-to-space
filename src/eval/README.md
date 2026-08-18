# `src/eval` — Quantitative Parser Benchmark

A reproducible, offline benchmark that answers *"is the web→VR parser doing well?"*
with numbers grounded in the segmentation and XR-readability literature — not just
self-referential DOM recall.

```bash
npm run benchmark                 # runs src/eval/corpus/*.html
npm run benchmark -- some/dir     # runs *.html under a custom directory
npm run verify:vips               # visual-VIPS checks on synthetic geometry
```

> **Read the report's "Run environment" table first.** The offline runner has no
> layout engine, which changes two things: BCubed weights fall back from pixel
> area to text length, and VIPS runs its rendering-free approximation instead of
> the real algorithm. Both are stated in the report and marked on the affected
> rows. For a fair head-to-head against VIPS, use the in-app comparison panel,
> which runs in a real browser.

Outputs land in `eval-out/`:

| file | contents |
|---|---|
| `report.md` | corpus-level means ± sample stddev, ranked |
| `per-page.csv` | every metric for every (page, backend) |
| `segmentation.csv` | BCubed P/R/F per (page, segmenter) |

## Three metric families

### 1. Segmentation quality — `segmentation.ts`
Implements the evaluation methodology of **Kiesel et al., *Web Page Segmentation
Revisited: Evaluation Framework and Dataset*, CIKM 2020**. A segmentation is a
partition of the page's **atomic elements**; two segmentations are compared with a
**size-weighted BCubed** precision/recall/F. Merges depress precision, splits
depress recall.

- **Weighting:** Kiesel weights atomic elements by *rendered pixel area*, and
  `extractAtomicUnitSet` does exactly that **whenever the document is laid out**
  (the in-app panel). The offline runner uses jsdom, which performs no layout, so
  there it falls back to **text length** as a rendering-free proxy for visual
  mass. The mode is auto-detected by probing for non-zero geometry and reported
  as `SegmentationRunInfo.weighting` — scores computed under different weightings
  are not comparable, so the report prints which one it used.
- **Chrome excluded:** `<header>`/`<footer>` (banner/contentinfo) subtrees are
  dropped from the atomic units, because the XR scene does not render that page
  chrome — so scores reflect main content only. (Div-soup pages that fake a
  header/footer with unmarked `<div>`s carry no banner signal and are not
  excluded.)
- **Reference (ground truth):** a supplied gold annotation (`SegmentationAnnotation`,
  CSS-selector → label) when available; otherwise an **HTML5-semantic proxy oracle**.
  The proxy rewards correct landmark/sectioning authoring and **degenerates to one
  segment on div-soup pages** — such pages cannot discriminate and inflate means, so
  use gold annotations for unsemantic corpora.
- **Confound fix:** every segmenter (`flat`, `dom-sectioning`, `heading-bounded`,
  `vips`, `readability`) is an **independent `Element → Segmentation` function**.
  None routes through `parsePageToIR`, so scores are attributable to the algorithm
  itself — unlike the pipeline backends, which share the semantic parser.
- **VIPS fidelity:** `segVips` runs the real algorithm (`ir/vips-visual.ts` —
  visual block extraction, separator detection and weighting over rendered
  geometry) when layout is available, and the rendering-free DOC recursion when
  it is not. VIPS is explicitly a *tag-tree independent* algorithm, so scoring
  the tag-tree stand-in and labelling the row "VIPS" understates it; the mode is
  reported as `SegmentationRunInfo.vipsMode` and marked on the row.

### Verifying the visual path — `verify-vips-visual.ts`
`npm run verify:vips` exercises `runVipsVisual` against **synthetic rendered
geometry**: jsdom hosts the DOM while `getBoundingClientRect` and
`getComputedStyle` are stubbed with hand-authored boxes. The algorithm under
test is unmodified, so the visual path stays covered without requiring a
headless browser.

Each fixture is built so a tag-tree reading and a visual reading *disagree* —
identical markup that must split one way and not the other. Two are negative
controls (no gutter, no colour change ⇒ must **not** split), because the DOM-only
fallback is a legitimate code path and "it returned some blocks" is not evidence
that the visual one ran.

### 2. XR spatial quality — `xr-quality.ts`
Judges the *placed* `LayoutPlan`, not just the IR. Metres throughout; head modelled
at `(0, eyeLevel, 0)` facing −Z.

- **Angular legibility:** cap-height visual angle `θ = 2·atan(h/2d)` per text
  primitive. Thresholds: **legibility floor 0.29°** (~17 arcmin) and **comfort target
  1.375°**, from VR text-legibility studies (IEEE VR 2020; ACM VRST 2025). Reports
  mean/min angular size and the char-weighted fraction meeting each threshold.
- **Comfort-envelope occupancy:** fraction of top-level panel area within
  ±`comfortHalfAngleDeg`, count of peripheral panels needing a head turn, area-weighted
  mean azimuth.
- **Information density:** main-panel area ÷ comfort-viewport area at the viewing
  distance (`mainPanelFovFill`).
- **Navigation cost:** total pages, sequential page-turns to read all, reading-distance
  error vs the profile's viewing distance, panels outside the 0.5–20 m window.

### 3. IR-level metrics — reused from `src/components/compare/`
`semanticRichness`, heading/landmark recall, text coverage, generic ratio, timing —
the existing end-to-end pipeline metrics, aggregated across the corpus.

## Architecture notes
- `dom-bootstrap.ts` installs a jsdom `DOMParser` on `globalThis` so the browser
  pipeline runs unmodified under Node.
- `harness.ts` (`benchmarkPage`) is browser-safe and can also be called from the
  React compare panel.
- `web2vr` is excluded from the offline run — it needs a real rendered iframe.

## Extending
- **Add pages:** drop `.html` files in `corpus/` (or point the CLI at any directory).
- **Gold annotations:** pass a `SegmentationAnnotation` to `scoreSegmentation` /
  `proxyGroundTruth` to replace the proxy oracle with a real ground truth.
- **New segmenter:** add an entry to `SEGMENTERS` in `segmentation.ts`.

## Citations
- Kiesel, Kneist, Meyer, Komlossy, Stein, Potthast. *Web Page Segmentation Revisited:
  Evaluation Framework and Dataset.* CIKM 2020, 3047–3054.
- Cai, Yu, Wen, Ma. *VIPS: a Vision-based Page Segmentation Algorithm.* MSR-TR-2003-79.
- *The influence of text rotation, font and distance on legibility in VR.* IEEE VR 2020.
- *Perceiving Multilingual Text in Virtual Reality.* ACM VRST 2025.

---

## Link census (`npm run census`)

Phase 0 of `docs/link-build-plan.md`. Measures how many references a rendered
page carries, so the reference-neighbourhood's capacity claim — roughly 16–24
destinations of lateral room — can be checked against real documents before any
of the geometry is built.

```bash
npm run census          # the hand-written fixtures in ./corpus
npm run census:fetch    # download the real-page corpus (see link-corpus.urls)
npm run census:real     # measure it
```

`census:fetch` writes into `./link-corpus/` (gitignored) plus a `sources.json`
recording the URL each file came from. The census reads that map, and it
matters: `same-site` vs `off-site` is an origin comparison, and a page measured
at the `file://` path it happens to be saved at has no origin — every absolute
href would come back off-site and the entire near field would move out into the
far field.

The fixtures in `./corpus` are for the segmentation benchmark. Between them
they carry fourteen anchors, all table-of-contents fragments, so a census over
them reports a median of zero and passes the gate on no evidence. Run
`census:real` for a number worth quoting.

Both runs write `eval-out/link-census*.{csv,md}`. The `.md` carries the G0
verdict, the distribution weighted three ways, and the per-document table —
pooling every rendered page lets one 745-page specification cast 745 votes, so
the pooled median is reported beside an equal-weight roll-up rather than alone.
