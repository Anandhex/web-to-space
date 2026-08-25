# `src/eval` — the parser sanity check, and the offline benchmark

Two unrelated things live here.

**1. The parser sanity check** (`npm run evaluate`). Scores the shipped parser's
node role labels against hand annotation and reports macro-F1, the per-label
breakdown and the confusion matrix. It is **not a comparison**: the thesis makes
no claim that the parser beats Readability, VIPS or a tag baseline, so nothing
measures one. Its only job is to show that the structure driving the user study's
*semantic spatial* condition is really there.

Design and rationale: `docs/evaluation-plan.md` §2.
Labelling rules: `docs/annotation-guidelines.md`.

**2. The offline benchmark** (`npm run benchmark`) — a regression gate for the
app, unrelated to the thesis. It runs the shipped backends over
`src/eval/corpus/*.html` and checks segmentation and XR legibility have not
regressed. Keep it green; do not quote it.

---

## Commands

```bash
# ── the sanity check ─────────────────────────────────────────
npm run gold:fetch              # freeze a page into gold-corpus/ + manifest.json
npm run gold:provisional        # seed an annotation from tags, to be reviewed
npm run gold:annotate           # the annotation pass itself
npm run gold:lint               # guideline conformance + provenance report
npm run evaluate                # score, and write eval-out/sanity/

# ── app regression gates ─────────────────────────────────────
npm run benchmark               # segmentation + XR legibility over src/eval/corpus/
npm run verify:vips             # visual-VIPS checks on synthetic geometry
npm run census                  # link classification over the fetched corpus
```

## Layout

| file | what it is |
|---|---|
| `run-evaluation.ts` | the sanity check: parser → align → score → report |
| `node-labels.ts` | the scorer — macro-F1, per-label P/R/F, confusion matrix |
| `gold/schema.ts` | the on-disk annotation format, its validator and loader |
| `gold/labels.ts` | the 13-label vocabulary and the `IRRole →` collapse map |
| `gold/units.ts` | which elements are annotatable at all |
| `gold/stamp.ts` | writes `data-eval-id` into a frozen snapshot |
| `gold/align.ts` | joins gold units to parser output by text signature |
| `gold/provisional.ts` | the tag-derived placeholder, for seeding |
| `gold/chrome.ts` | the one definition of "this is site chrome" |
| `gold/build-annotator.ts` | the annotation UI |
| `gold/lint.ts` | guideline conformance and provenance reporting |
| `gold/fetch-corpus.ts` | fetch and freeze a page |
| `figures/` | SVG primitives + the confusion-matrix heatmap |
| `segmentation.ts` | **used by the app's compare view**, not by the sanity check |
| `xr-quality.ts` | **used by the app's compare view**, not by the sanity check |
| `run-benchmark.ts`, `harness.ts` | the offline benchmark |
| `link-census.ts` | link classification census — a different subsystem |

## Reading the output

`eval-out/sanity/sanity.md` splits its numbers in two, and the split matters:

- **Against human annotation** — the number that counts.
- **Against the placeholder oracle** — a smoke test. The placeholder is derived
  from HTML5 tags and ARIA attributes, and the parser reads the same signals, so
  scoring against it is close to scoring the parser against a paraphrase of its
  own input. It says the pipeline runs. It does not say it is right.

Expect a large gap between the two. It is not a bug; it is the measure of how much
a tag-derived ground truth flatters a tag-reading parser.

## Annotation, briefly

Annotate against the **rendered** page with parser output hidden. Seed from
`gold:provisional`, then review unit by unit — provenance is recorded per unit
(`confirmed` / `changed` / `unreviewed`), and an `unreviewed` label is the seed
speaking, not a human. `gold:lint` reports the unreviewed rate; report it in the
thesis too.

Budget ~25 min/page.

## References

- Cai, Yu, Wen, Ma. *VIPS: a Vision-based Page Segmentation Algorithm.* MSR-TR-2003-79.
- Kiesel et al. *Web Page Segmentation Revisited: Evaluation Framework and Dataset.* CIKM 2020.
- Kohlschütter, Fankhauser, Nejdl. *Boilerplate Detection using Shallow Text Features.* WSDM 2010.
