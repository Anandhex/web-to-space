# `src/eval` — Quantitative Parser Benchmark

A reproducible, offline benchmark that answers *"is the web→VR parser doing well?"*
with numbers grounded in the segmentation and XR-readability literature — not just
self-referential DOM recall.

```bash
npm run benchmark                 # runs src/eval/corpus/*.html
npm run benchmark -- some/dir     # runs *.html under a custom directory
```

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

- **Deviation from the paper:** Kiesel weights atomic elements by *rendered pixel
  area*. We run DOM-only (no CSSOM), so we weight by **text length** as a
  rendering-free proxy for visual mass. This is the single documented deviation.
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
