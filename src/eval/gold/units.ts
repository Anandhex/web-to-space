/**
 * eval/gold/units.ts — which elements an annotator is asked about.
 *
 * Shared by the annotation UI and the provisional oracle so the two never
 * disagree about the item set: κ, the confusion matrix and the BCubed reference
 * all key on the same units, and an annotation over a different set than the one
 * that gets scored is worse than none.
 *
 * Two kinds of element are in scope:
 *
 *   • **Structural containers** — always, whether or not they hold text of
 *     their own. `main`, `nav`, `aside`, `table`, `form` are the labels the
 *     evaluation is about; they carry no text and would drop out of a
 *     text-driven selection.
 *   • **Content blocks** — the smallest element that directly owns text, plus
 *     replaced and interactive elements. A `<div>` that exists only to wrap one
 *     `<p>` is not asked about: annotators cannot tell the two apart on the
 *     rendered page, and asking would manufacture disagreement.
 */
import { isAccessibilityHidden } from "../../ir/utils";

const STRUCTURAL = new Set([
  "MAIN", "NAV", "ASIDE", "HEADER", "FOOTER", "ARTICLE", "SECTION", "FORM",
  "TABLE", "THEAD", "TBODY", "TR", "FIGURE", "UL", "OL", "DL", "BLOCKQUOTE",
  "FIELDSET", "DIALOG", "DETAILS",
]);

const CONTENT_BLOCK = new Set([
  "P", "H1", "H2", "H3", "H4", "H5", "H6", "LI", "DT", "DD", "TD", "TH",
  "PRE", "CODE", "FIGCAPTION", "CAPTION", "LEGEND", "SUMMARY", "ADDRESS",
  "HR", "LABEL",
]);

const REPLACED = new Set(["IMG", "VIDEO", "AUDIO", "IFRAME", "OBJECT", "EMBED", "PICTURE"]);

const INTERACTIVE = new Set(["BUTTON", "INPUT", "SELECT", "TEXTAREA", "A"]);

const SKIP = new Set([
  "SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "META", "LINK", "HEAD", "BR", "WBR",
  "PATH", "SVG", "CANVAS",
]);

function ownText(el: Element): string {
  let s = "";
  for (const n of Array.from(el.childNodes)) {
    if (n.nodeType === 3) s += n.textContent ?? "";
  }
  return s.replace(/\s+/g, " ").trim();
}

/** Is this element a wrapper that adds nothing an annotator could see? */
function isPassthroughWrapper(el: Element): boolean {
  if (STRUCTURAL.has(el.tagName)) return false;
  if (ownText(el).length > 0) return false;
  return el.children.length === 1;
}

export interface AnnotatableElement {
  el: Element;
  evalId: string;
  tag: string;
  /** Normalised subtree text, truncated for display in the annotation UI. */
  preview: string;
  /** Nesting depth below <body>, for the UI's indentation. */
  depth: number;
  kind: "structural" | "block" | "replaced" | "interactive";
}

/** Tags that are a run inside a line rather than a block of their own. */
const INLINE_WHEN_EMBEDDED = new Set(["A", "CODE", "LABEL"]);

/** Every inline tag, for walking out of a nest of them to the enclosing block. */
const INLINE_TAGS = new Set([
  "A", "CODE", "LABEL", "SPAN", "EM", "STRONG", "B", "I", "U", "S",
  "SMALL", "SUB", "SUP", "ABBR", "CITE", "DFN", "KBD", "SAMP", "VAR",
  "MARK", "Q", "TIME", "BDI", "BDO", "WBR", "FONT",
]);

/**
 * The nearest ancestor that lays out as a block — the thing an annotator would
 * call the containing paragraph, cell or heading. Inline elements nest freely,
 * so stopping at the immediate parent answers "is this inline inside another
 * inline?" when the question is "is this inline inside a block of text?".
 */
function nearestBlockAncestor(el: Element): Element | null {
  let current = el.parentElement;
  while (current && INLINE_TAGS.has(current.tagName)) current = current.parentElement;
  return current;
}

export function selectAnnotatableElements(doc: Document): AnnotatableElement[] {
  const out: AnnotatableElement[] = [];
  const body = doc.body;
  if (!body) return out;

  const walk = (el: Element, depth: number): void => {
    if (SKIP.has(el.tagName)) return;
    // Nothing a reader cannot see is a unit, and that includes the subtree.
    // The WAI-ARIA specification carries 91 `hidden` `role="dialog"` panels;
    // the annotation tool renders the page, so they never appear in it, but the
    // provisional oracle labelled them anyway and every system was then scored
    // as having deleted 91 dialogs it was right to drop. `other` scored 0.00 F1
    // almost entirely on those.
    if (isAccessibilityHidden(el)) return;
    const evalId = el.getAttribute("data-eval-id");
    const text = (el.textContent ?? "").replace(/\s+/g, " ").trim();

    let kind: AnnotatableElement["kind"] | null = null;
    if (STRUCTURAL.has(el.tagName)) kind = "structural";
    else if (REPLACED.has(el.tagName)) kind = "replaced";
    else if (INTERACTIVE.has(el.tagName)) kind = "interactive";
    else if (CONTENT_BLOCK.has(el.tagName)) kind = "block";
    else if (el.hasAttribute("role")) kind = "structural";
    else if (ownText(el).length >= 3 && !isPassthroughWrapper(el)) kind = "block";

    // Inline runs are not units. A standalone <a> is a navigation affordance,
    // but an <a> inside a paragraph is part of that paragraph's prose; the same
    // is true of <code>, which a specification uses inline in almost every
    // sentence. Treating those as units asked the annotator about fragments of a
    // sentence and asked every system to produce a separate node for each — on
    // the HTML specification, 703 of 808 `code` units were inline spans.
    //
    // The comparison is against the nearest BLOCK ancestor, not the immediate
    // parent, because inline elements nest. `<a href="#menu"><code>menu</code></a>`
    // occurs 4,511 times in the ARIA specification: the <a> is correctly excluded
    // against the paragraph around it, but the <code> compared only against that
    // <a> and matched it exactly, so every one of them survived as a unit. The
    // parser flattens such a <code> into the link's text and has no `code` node
    // to offer, so those units scored as `navigation` — 1,838 of them, the
    // largest single error group in the run and an artefact of asking about a
    // fragment of a sentence.
    if (INLINE_WHEN_EMBEDDED.has(el.tagName)) {
      const block = nearestBlockAncestor(el);
      const blockText = (block?.textContent ?? "").replace(/\s+/g, " ").trim();
      if (blockText.length > text.length * 1.6) kind = null;
    }

    if (kind && evalId && (text.length > 0 || kind === "replaced" || kind === "interactive")) {
      out.push({
        el,
        evalId,
        tag: el.tagName.toLowerCase(),
        preview: text.slice(0, 140),
        depth,
        kind,
      });
    }
    for (const child of Array.from(el.children)) walk(child, depth + 1);
  };

  for (const child of Array.from(body.children)) walk(child, 0);
  return out;
}
