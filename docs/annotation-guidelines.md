# Annotation guidelines — gold standard for parser evaluation

Version 1.0 (draft, pending pilot). Read this **before** opening the annotation
tool. Everything here exists to make two people produce the same labels; where it
is silent, two people will not, and the disagreement shows up as a low κ and
invalidates every number downstream.

Companion documents: `docs/evaluation-plan.md` (why), `src/eval/README.md`
(how to run the scoring).

---

## 0. Before you start

1. Read this whole document once. It is short on purpose.
2. `npm run gold:annotate` → open `eval-out/annotator/index.html`.
3. Put your name in the **annotator** field. It is the key the agreement table
   is computed on; two people using the same name silently become one.
4. **Do not look at any parser output** — not the IR, not a rendered scene, not
   another annotator's file. The gold standard exists to be independent of the
   thing being measured. If you have already seen how a page parses, hand it to
   the other annotator.
5. Label what you see in the **rendered page on the left**, not the markup. If
   the visual result and the tag disagree, the visual result wins: that
   disagreement is the phenomenon under study, and resolving it in favour of the
   tag would build the parser's own assumption into its ground truth.

Work through a page in order, top to bottom. Do not skip ahead and come back —
context from above is what makes the sidebar-versus-nav call obvious.

## 1. The three layers

| Layer | What you produce | Key |
|---|---|---|
| **A — role labels** | one label per unit | the 13 letter keys |
| **B — segments** | which coherent block each unit belongs to | `s` opens a new segment at the current unit |
| **C — reading order** | the order those segments should be read | the order in which you press `s` |

Layer A is the primary endpoint. If you are short of time, label A completely
and leave B/C — a page with A only still scores. A page with B but incomplete A
scores nothing.

Layer B: press `s` on the **first unit of each coherent block** — the thing you
would call a section if you were describing the page to someone over the phone.
Everything after it belongs to that segment until the next `s`. Aim for the
granularity of "the article body", "the table of contents", "the comment
thread" — not per paragraph, and not the whole page as one.

Layer C is free: it is the order you pressed `s` in. If a segment should be read
somewhere other than where it sits visually, press `s` on the segments in
**reading** order rather than visual order, and note it in the export.

## 2. The labels

| Key | Label | Use it for |
|---|---|---|
| `m` | `main-content` | the containers holding the page's substance — the article, the body of a spec, a `<section>` wrapping real content |
| `h` | `heading` | anything that titles the block below it, at any level |
| `p` | `prose` | paragraphs, pull quotes, standalone sentences, definition bodies |
| `l` | `list` | a list, and its items — bulleted, numbered, or a run of links that reads as a list of things rather than a menu |
| `n` | `navigation` | menus, breadcrumbs, tables of contents, pagination, "next/previous", a link that stands alone as an affordance |
| `a` | `complementary` | sidebars, related-links boxes, callouts, "see also" — content beside the main thread |
| `f` | `figure` | images, figures, captions, diagrams, charts |
| `v` | `media` | video, audio, embedded players |
| `t` | `table` | tables and their rows, cells and header cells |
| `c` | `control` | inputs, buttons, selects, search boxes, forms, labels |
| `k` | `code` | code blocks and inline code that stands alone as a unit |
| `b` | `chrome` | site banner, footer, cookie/consent bars, ad slots, newsletter interstitials, "we use cookies", social share rails |
| `o` | `other` | separators, dialogs, status/alert regions, anything that is genuinely none of the above |

Reach for `other` **last**. It is a residual, not an escape hatch: a page
labelled 30% `other` carries no information about any system.

## 3. Tie-break rules

These are the calls that destroy agreement when left to judgement. They are
decided here, once, and they are not negotiable per page.

1. **Innermost wins.** A unit takes the label of the closest thing it *is*, not
   of what contains it. A paragraph inside `<main>` is `prose`, not
   `main-content`.
2. **A `<nav>` inside `main` is still a navigation region.** Containment does
   not launder a role: it is not `main-content` just because `<main>` holds it.
   Whether it is `navigation` or `chrome` is then decided by rule 4 — a site
   menu that happens to sit inside `<main>` is still a site menu.
3. **Link-list rule.** A block that is mostly links: if links account for **≥60%
   of its text**, it is `navigation`; below that it is `complementary` (or
   `list`, if it reads as a list of *things* rather than a set of destinations).
   Count roughly — you do not need to measure.
4. **Anything inside site chrome is `chrome`,** whatever it is in itself. A
   `<nav>` in the page footer is `chrome`, not `navigation`. A search box in the
   masthead is `chrome`, not `control`. Chrome is subtractive: the whole subtree
   goes.

   **"Header" and "footer" mean the PAGE's, not a section's.** Long-form pages
   and especially forums, comment threads and card feeds give every item its own
   head and foot — the author line and timestamp above a post, the reactions bar
   below it. Those are the item's content, not the site's furniture, and they are
   `prose`, `list`, `figure` and so on like anything else. On the corpus's forum
   page 19 of 20 `<header>`/`<footer>` elements are per-post and exactly one is
   the masthead.

   In markup terms — this is HTML's own rule, not one invented here — a
   `<header>` or `<footer>` is the page's only when it is **not** inside an
   `<article>`, `<aside>`, `<main>`, `<nav>` or `<section>`. In the rendered page
   you already know the difference: the masthead is the band at the very top that
   is the same on every page of the site.

   **Site chrome is not only the header and the footer.** A site menu is site
   chrome wherever it sits in the markup — a primary navigation bar that is a
   sibling of `<main>` rather than a child of `<header>` is still the same menu
   on every page of the site, and the scene does not render it.

   The question to ask is **where the links go**:

   | The navigation takes you… | Label |
   |---|---|
   | to another page of the site — menus, breadcrumbs, utility bars, "related articles" rails | `chrome` |
   | to somewhere in **this** document — a table of contents, a section index, "back to top" | `navigation` |

   The mechanical tie-break, used by the tooling and available to you when a
   block is genuinely ambiguous: if **most of its links are same-page `#`
   links**, it is `navigation`; otherwise it is `chrome`. Measured over this
   corpus the two groups do not overlap — tables of contents run at 100%
   same-page links and site menus at 0–6% — so in practice you will not need to
   count.

   Note what this rule does **not** say. It is about *navigation regions*, not
   about links. A link inside a paragraph is part of that paragraph's prose
   (rule 1), and a linked section title is still a `heading` (rule 6).
5. **In-body advertising and consent UI is `chrome`** even when it sits in the
   middle of the article. It is not the document.
6. **A heading is `heading` even when it is a link.** The `navigation` label is
   for things whose job is to take you elsewhere; a linked section title's job
   is to title the section.
7. **A caption is `figure`,** not `prose` — it belongs to the figure it names.
8. **A code block is `code`; a code *listing with a caption* is `code` plus a
   `figure` caption.** Do not relabel the code.
9. **A definition list is `list`.** Terms and definitions are both `list`.
10. **A section that contains only paragraphs is still `main-content`** if it is
    a container. Label the container `main-content` and its paragraphs `prose` —
    do not collapse them.
11. **A form is `control`,** and so is everything in it, including its labels.
    A heading *above* a form is `heading`.
12. **Empty or decorative units** — spacer divs, icon-only spans, rules —
    are `other`.
13. **When two labels are genuinely equally right,** pick the one earlier in the
    table above, and note the unit id in the export's `notes`. Those notes are
    what version 1.1 of this document is written from.

## 4. What to do when a page defeats you

- **The page is broken or empty** (paywall, JS-only shell, consent wall with no
  content behind it): stop, do not label it, and record it in
  `eval-out/annotator/rejects.md` with the reason. It leaves the corpus and is
  reported as a rejection. Do not label a paywall as if it were the article.
- **The page is enormous** (a full specification): label it completely anyway if
  it is in the sample. The tool is keyboard-driven for exactly this case. Do not
  label the first 200 units and stop — a truncated page biases every score on it
  toward whatever is at the top of the document.
- **You cannot tell what a block is for.** Look at the rendered page, not the
  list. If it is still unclear after ten seconds, it is `other`, and it goes in
  `notes`.

## 5. Pace, breaks and quality

Budget ~25 minutes per page. Take a break every 45 minutes — label quality
decays measurably before you notice it, and the last twenty units of a long
session are the ones that show up in the disagreement set.

Do not go back and "tidy" a page after learning something on a later page. If a
rule genuinely needs to change, change it **here**, then re-annotate every
affected page from the start. Silently applying a new rule to later pages only
makes the corpus internally inconsistent in a way nothing will detect.

## 6. Agreement and adjudication

- 20% of pages are annotated by both people, independently. You will not be told
  which — assume every page is one of them.
- `npm run gold:agreement` computes Cohen's κ, overall and per label, and writes
  the disagreement list.
- **Gate: κ ≥ 0.67 overall.** Below that, the fault is assumed to be in this
  document, not in the annotators: the per-label κ table names the ambiguous
  distinction, a rule for it goes into §3, and the affected pages are
  re-annotated.
- Disagreements are resolved in a third pass by an adjudicator, whose file is
  named `*.adjudicated.json` and which the scoring prefers automatically.
- **Keep the pre-adjudication files.** The disagreement set is a finding in its
  own right: it says which distinctions this vocabulary does not really make.

## 7. Exporting

`Export JSON` writes `<page>.<annotator>.json`. Move it into
`src/eval/gold-annotations/`. Nothing else needs to change — the scoring picks
up any valid file it finds there, and `npm run evaluate` reports any file that
fails validation rather than silently scoring against a broken one.

Delete the provisional files (`*.provisional.json`) once a page has real
annotation. They are tag-derived placeholders, they exist only to keep the
pipeline runnable before the labelling is done, and every artefact generated
while one is present is stamped as not-a-result.
