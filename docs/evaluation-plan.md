# Evaluation plan

**One month. This is a doing document, not a defending document.**

## The claim

> **Semantic web pages create better spatial spaces.**
>
> A page's markup determines how good an XR environment can be built from it.
> Where the markup declares structure, the pipeline recovers it and produces
> coherent spatial regions. Where it does not, inference cannot substitute, and
> the space degrades.

The consequence, and the point of the thesis: **accessibility markup has a
spatial dividend.** Authors write it today for screen-reader users. It pays a
second time in XR.

### The obvious objection, and the answer

*"Good input gives good output — isn't that trivial?"* No, because the thesis
supplies three things a reader does not have without it:

1. **How much** — a 4× gap, measured against human annotation.
2. **Why inference does not close it** — with a working implementation of the
   alternative, switched off as a control. That is a result, not an assumption.
3. **What follows for authoring** — a reason to write semantic HTML that has
   nothing to do with screen readers.

## Status

| | | |
|---|---|---|
| The system | built | — |
| **6a** markup quality → structural recovery | ✅ computed | write it up |
| **6b** link classification | ✅ done, 94.1% | write it up |
| **6c** user study | not started | 4 participants, 2 days |

---

## 6a — Does markup quality determine what can be recovered?

`npm run evaluate` → `eval-out/sanity/`. Shipped parser, `useAIFallback: false`.

Every annotated unit is split in two. A unit is **declared** when its tag or its
`role=` yields the annotator's label; **hidden** when it does not, so only
inference can reach it.

| | macro-F1 |
|---|---:|
| Declared units | **0.880** |
| Hidden units | **0.225** |

**The control for the hidden subset is the parser's own L1 configuration** —
the same parser with `useStructuralInference` off — not a tags-only baseline.
"Hidden" is *defined* as "the tag does not yield the label", so a tag reader
scores zero there by construction and quoting that would be a tautology.

Result: **structural inference contributes nothing measurable.** Identical scores
with and without it on **16 of 19 pages**; −0.045 on `divsoup-blog`, +0.013 on
`mangadex`. Report this as a finding, not an omission: the inference layer was
built, measured against its own control, and did not extend the pipeline past
what the markup declares.

Keep human gold apart from the placeholder oracle throughout. The parser reads
the same tags the oracle was built from, so oracle numbers are a smoke test.
`sanity.md` already splits them.

**Annotation:** `divsoup-blog` and `mangadex` are done. One more page for
context, ~25 min. Report the `unreviewed` provenance rate — an unreviewed label
is the seed speaking, not a human.

---

## 6b — Links: does it classify connections correctly?

`npm run test:links`. **Already passing at 94.1%.** Five annotated documents,
per-region precision/recall/F1, confusion matrix.

**Retention** (did the anchor reach the scene) stays separate from **accuracy**
(over anchors that arrived) — the code already does this. An anchor the parser
dropped cannot be classified right or wrong.

Nothing to run. Write it up.

---

## 6c — User study: 4 participants, formative

**Not an experiment.** Four participants surface usability problems and
preferences. They cannot support a comparative performance claim, and none is
made. **No inferential statistic appears in this chapter** — say so in the method
rather than leaving its absence to be noticed.

### The manipulation is the PAGE, not the system

|  | spatial | flat panel |
|---|---|---|
| **well-authored page** | | |
| **div-soup page** | | |

Four trials, ~30 min. Same system throughout; the rows test the claim, the flat
column keeps the "better than today's VR browser" comparison. **If sessions run
long, drop the flat column and keep the rows** — the rows are the thesis.

Prediction to state in advance: the div-soup page produces a worse experience,
and participants should be able to say *why* — regions that do not cohere,
content that lands in the wrong place.

Pick the two pages from the annotated set, so each carries a measured 6a score
that goes beside what participants said about it.

**Never use Readability or VIPS as a condition.** They discard 48% and 34% of the
content, so the study would measure deletion, not structure.

### Practicalities

- Think aloud throughout. Order alternated across the four participants.
- **Rehearse with a colleague first** — uncounted, unconsented. You cannot spare
  a pilot from four, and losing one to a broken question is 25% of the data.
- Consent → headset fit → training page → 4 trials → SUS per condition →
  preference → short exit interview. Sickness check between blocks; withdrawal
  any time.

### Measures

1. **Think-aloud** — thematic coding of usability problems. *This is the chapter.*
2. Preference — counts. *"3 of 4 preferred the well-authored page."*
3. Task success — counts, never rates.
4. SUS — **individual scores, not a mean.** A mean of four implies precision that
   is not there.

### Ethics

Approval must be granted **before** the first session. If it is not already in
place, **the study does not happen** — do not start an application now. Chapter 6
then runs on 6a + 6b, which already support the claim, and Chapter 7 names the
missing study as the primary limitation and first future-work item.

---

## Threats — state them, don't wait to be asked

1. **Two human-annotated pages, 221 hidden units.** `divsoup-blog` is 18 units
   and a fixture written by the author. The 4× gap is directional evidence, not a
   precise effect.
2. **Four participants.** Formative only.
3. **The author built the system and runs the study.** At n = 4 one leading
   prompt shifts a quarter of the data. Fixed script and questions, written
   before session one. Participants cannot be blinded.
4. **Novelty.** Most participants have never read a document in VR before.
5. **One device profile** (`QUEST_3_PROFILE`). Conclusions do not generalise
   across FOV/PPD.
6. **The declared/hidden split is an operationalisation, not a natural kind.** It
   rests on a tag→label table (`TAG_IMPLIES_GOLD` in `gold/labels.ts`); publish
   the table. `<a>` is deliberately counted as hidden — whether a link is
   navigation or running prose is exactly the contextual judgement at issue.
7. **Single annotator**, no inter-annotator agreement. Fine for a validity check;
   would not be fine if the labels carried a comparative claim. They do not.
8. **The AI fallback is excluded, and that is a finding.** Its gate admits only
   non-wrapper nodes (`src/ir/parser.ts:558`), and on a div-heavy page every
   unclassified node *is* a wrapper — so it receives nothing on exactly the pages
   it was built for. `divsoup-blog` queues 0 of 5. It is the same shape as the
   structural-inference result: neither fallback reaches the hard case.

---

## Not doing

- Multimedia / The Guardian — supervisor's suggestion, goes in future work
- More corpus pages, more baselines, more metrics, any new feature

The system is finished. Everything from here is writing.
