/**
 * eval/gold/align.ts — join a system's output to the hand-annotated units.
 *
 * The gold standard is keyed on DOM elements (`data-eval-id`); `PageIR` carries
 * no DOM linkage, and adding one would mean editing the parser to serve its own
 * evaluation. So the join is by TEXT, the same device the existing structural
 * metrics use (`deriveStructuralFidelity` aligns reading order this way).
 *
 * Three things make it behave:
 *
 *   1. **Whitespace is removed, not collapsed.** The two sides build their text
 *      differently — the DOM concatenates child text with no separator, the IR
 *      joins node content with spaces — so any normalisation that keeps
 *      whitespace makes every container mismatch, and containers are the labels
 *      this evaluation is about.
 *   2. **Text is emitted at leaves only.** Both trees store a container's text
 *      on the container *and* on the children it was decomposed into; adding
 *      the two together doubles the signature and nothing matches. Emitting at
 *      leaves and reading interior nodes as the RANGE their subtree spans gives
 *      each node exactly the text under it, once.
 *   3. **Ranges, not strings.** A signature per node, stored as a string, is
 *      O(depth × page) memory — a 2 MB specification exhausts the heap before
 *      it finishes. One character stream per tree plus two prefix-hash arrays
 *      makes every node's signature a pair of integer lookups.
 *
 * A gold unit with no counterpart is predicted `absent`. That is not a scoring
 * convenience: content extractors delete whole subtrees, and folding those into
 * a residual label would hide the largest difference between the families under
 * comparison.
 */
import type { IRGrouping, PageIR } from "../../ir/types";
import { goldFromIRNode, isMarkupDeclared, ABSENT, type GoldLabel, type PredictedLabel } from "./labels";
import { EVAL_ID_ATTR } from "./stamp";

/** How much of a signature the fuzzy pass compares. */
const PREFIX_LEN = 60;
/** Below this, a text is too short for the fuzzy pass to identify anything. */
const MIN_SIGNATURE = 8;

/**
 * How far a candidate may sit from where the ANCHOR MAP expects it, as a
 * fraction of the system's stream, before the match is refused.
 *
 * Judged against the map rather than against the raw normalised offset. The two
 * streams differ by whatever a system omits, and omissions are not spread
 * evenly — dropping a masthead moves everything after it. Bounding the raw
 * offset therefore punishes exactly the systems that correctly drop a large
 * block at the top: at 0.25 it cut the GitHub page's alignment from 97% to 59%
 * and excluded a Wikipedia page outright. Against the map, the same bound
 * measures displacement relative to where the rest of the document actually
 * landed.
 */
const MAX_DISPLACEMENT = 0.25;

/** Shortest text that may serve as an anchor. Short strings repeat. */
const ANCHOR_MIN_TEXT = 24;

export function normaliseText(s: string): string {
  return s.replace(/\s+/g, "").toLowerCase();
}

/**
 * A signature for an element that carries no text.
 *
 * Images, video, audio and empty inputs have nothing to match on, so a purely
 * textual join scored EVERY system as having dropped every one of them —
 * silently, and worst on exactly the labels the spatial mapper branches on
 * (`figure`, `media`, `control`). The resource identifier plus the alt text is
 * stable across every system here, because they all resolve `src` against the
 * same base URL.
 *
 * Prefixed so a media signature can never collide with a text one.
 */
function mediaSignature(src: string | null, alt: string | null): string | null {
  const s = (src ?? "").trim();
  const a = normaliseText(alt ?? "");
  if (!s && !a) return null;
  // The file name alone. Keeping a directory segment as well looked more
  // discriminating and was in fact fatal: the parser resolves `setup.png`
  // against the page URL, so the gold side signed `setup.png` while the IR side
  // signed `example.com/setup.png` and no image on any page could ever align.
  // Two assets that share a file name are separated by `alt` below, and failing
  // that by position in `choose`.
  const tail = s.split(/[?#]/)[0].split("/").filter(Boolean).slice(-1).join("/").toLowerCase();
  return `@media:${tail}|${a}`;
}

/**
 * A signature for a text-free INTERACTIVE element, built from its accessible
 * name.
 *
 * `mediaSignature` rescues text-free elements that carry a `src`/`alt`. Nothing
 * rescued the other kind: an `<input type="radio">`, an icon-only `<a>`, a
 * `<button>` labelled by `aria-label`. Those got a zero-length key on the gold
 * side and were skipped outright on the prediction side, so they could not be
 * aligned by construction — 93 units on one app-like page, and almost certainly
 * why `control` recall sat at 0.38.
 *
 * The accessible name is the right signature because for a control it IS the
 * content: "Search" is what the reader sees on that box, and it is what every
 * system has to recover in order to render the thing at all. Both sides compute
 * it the same way on purpose — this is a JOIN KEY, not a label, and it decides
 * nothing about the score. Every system produces a `PageIR`, so every system is
 * signed by the same rule.
 */
function controlSignature(tag: string, name: string | null): string | null {
  const n = normaliseText(name ?? "");
  if (!n) return null;
  // Tag and name only. The input's `type` would discriminate better and is not
  // available on both sides — the IR does not carry it — so signing on it would
  // guarantee a mismatch rather than a match. Two controls that end up sharing a
  // signature are separated by `choose`, the same as any other duplicate.
  return `@ctrl:${tag.toLowerCase()}|${n.slice(0, 80)}`;
}

/** Tags that stand for something without containing text. */
const TEXT_FREE_CONTROL_TAGS = new Set([
  "INPUT", "SELECT", "TEXTAREA", "BUTTON", "A", "SPAN", "LABEL", "SUMMARY",
]);

/**
 * The accessible name of an element, near enough for a join key: the sources a
 * browser consults, in the order it consults them. Deliberately small — this is
 * not an ARIA name computation, it is the shortest rule that makes the two sides
 * of the join agree.
 */
function domAccessibleName(el: Element): string | null {
  const attr = (k: string): string | null => el.getAttribute(k);
  const aria = attr("aria-label");
  if (aria?.trim()) return aria;

  const id = attr("id");
  if (id) {
    const doc = el.ownerDocument;
    const labelled = doc?.querySelector(
      `label[for="${id.replace(/(["\\])/g, "\\$1")}"]`,
    );
    const t = labelled?.textContent?.trim();
    if (t) return t;
  }
  const wrapping = el.closest?.("label");
  if (wrapping) {
    const t = wrapping.textContent?.trim();
    if (t) return t;
  }
  for (const k of ["placeholder", "title", "alt", "value", "name"]) {
    const v = attr(k);
    if (v?.trim()) return v;
  }
  return null;
}

/** Tags whose text is not content. `textContent` includes all of it. */
const NON_CONTENT_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "HEAD", "TITLE"]);

// ─────────────────────────────────────────────────────────────
// Character stream with range hashing
// ─────────────────────────────────────────────────────────────

const MOD1 = 1_000_000_007;
const MOD2 = 998_244_353;
const BASE1 = 131;
const BASE2 = 137;

/** (a·b) mod m for a,b < 2^31, without leaving the safe-integer range. */
function mulmod(a: number, b: number, m: number): number {
  const hi = Math.floor(b / 65536);
  const lo = b % 65536;
  return (((a * hi) % m) * 65536 + a * lo) % m;
}

/**
 * A normalised character stream plus the machinery to hash any sub-range of it
 * in constant time. One is built per tree; a node's signature is the range its
 * subtree occupies.
 */
class TextStream {
  private chunks: string[] = [];
  length = 0;
  private text = "";
  private h1: Int32Array | null = null;
  private h2: Int32Array | null = null;
  private p1: Int32Array | null = null;
  private p2: Int32Array | null = null;

  /** Append raw text; returns nothing. Normalisation happens here. */
  push(raw: string): void {
    if (!raw) return;
    const n = normaliseText(raw);
    if (n.length === 0) return;
    this.chunks.push(n);
    this.length += n.length;
  }

  /** Freeze the stream and build the prefix hashes. Call once. */
  seal(): void {
    this.text = this.chunks.join("");
    this.chunks = [];
    const n = this.text.length;
    this.h1 = new Int32Array(n + 1);
    this.h2 = new Int32Array(n + 1);
    this.p1 = new Int32Array(n + 1);
    this.p2 = new Int32Array(n + 1);
    this.p1[0] = 1;
    this.p2[0] = 1;
    for (let i = 0; i < n; i++) {
      const c = this.text.charCodeAt(i);
      this.h1[i + 1] = (this.h1[i] * BASE1 + c) % MOD1;
      this.h2[i + 1] = (this.h2[i] * BASE2 + c) % MOD2;
      this.p1[i + 1] = mulmod(this.p1[i], BASE1, MOD1);
      this.p2[i + 1] = mulmod(this.p2[i], BASE2, MOD2);
    }
  }

  /**
   * Signature key for [start, end). Two independent moduli: a single 30-bit
   * hash collides at corpus scale often enough to matter, and a collision here
   * silently credits one system with another's label.
   */
  key(start: number, end: number): string {
    if (!this.h1 || !this.h2 || !this.p1 || !this.p2) throw new Error("stream not sealed");
    const len = end - start;
    if (len <= 0) return "";
    const a = (this.h1[end] - mulmod(this.h1[start], this.p1[len], MOD1) + MOD1 * 2) % MOD1;
    const b = (this.h2[end] - mulmod(this.h2[start], this.p2[len], MOD2) + MOD2 * 2) % MOD2;
    return `${a}:${b}:${len}`;
  }

  prefix(start: number, end: number): string {
    return this.text.slice(start, Math.min(end, start + PREFIX_LEN));
  }

  excerpt(start: number, end: number, max = 60): string {
    return this.text.slice(start, Math.min(end, start + max));
  }
}

// ─────────────────────────────────────────────────────────────
// Gold side
// ─────────────────────────────────────────────────────────────

export interface GoldUnit {
  evalId: string;
  label: GoldLabel;
  /** Signature key — the join value, not readable text. */
  key: string;
  /** First few characters, for debugging and error messages. */
  excerpt: string;
  /** Length of the unit's text, in normalised characters. */
  textLength: number;
  /** Visual-mass weight: rendered pixel area if laid out, else text length. */
  weight: number;
  /** Document-order rank. */
  order: number;
  /** Start of the unit's text in the page's character stream. */
  start: number;
  /** Total length of that stream, so the offset can be normalised. */
  streamLength: number;
  /** Prefix used by the fuzzy pass. */
  prefix: string;
  /** Source tag, for reporting which markup the hidden units actually carry. */
  sourceTag: string;
  /**
   * False when the markup declares nothing about this unit's role — the HIDDEN
   * subset. @see isMarkupDeclared
   */
  declared: boolean;
}

/**
 * Collect the annotated elements out of a stamped document, in document order.
 * Ids present in the annotation but absent from the document are reported —
 * that means the snapshot changed after annotation, which invalidates the file.
 */
/**
 * One post-order walk of a document, producing the character stream and each
 * element's range within it. Shared by the gold units and by any DOM-side
 * system (the accessibility-tree baseline), so both sign identical text with
 * identical keys and the join between them is exact rather than fuzzy.
 */
export function buildDomRanges(body: Element): {
  stream: TextStream;
  ranges: Map<Element, [number, number]>;
} {
  const stream = new TextStream();
  const ranges = new Map<Element, [number, number]>();

  // Iterative — the div-soup stratum nests deeply enough that recursion is a
  // real stack-overflow risk.
  const stack: Array<{ node: Node; expanded: boolean; start: number }> = [
    { node: body, expanded: false, start: 0 },
  ];
  while (stack.length > 0) {
    const frame = stack[stack.length - 1];
    const node = frame.node;
    if (node.nodeType === 3) {
      stack.pop();
      stream.push(node.textContent ?? "");
      continue;
    }
    if (node.nodeType !== 1) {
      stack.pop();
      continue;
    }
    const el = node as Element;
    if (NON_CONTENT_TAGS.has(el.tagName)) {
      stack.pop();
      continue;
    }
    if (!frame.expanded) {
      frame.expanded = true;
      frame.start = stream.length;
      const kids = Array.from(el.childNodes);
      for (let i = kids.length - 1; i >= 0; i--) {
        stack.push({ node: kids[i], expanded: false, start: 0 });
      }
      continue;
    }
    stack.pop();
    ranges.set(el, [frame.start, stream.length]);
  }
  stream.seal();
  return { stream, ranges };
}

/**
 * Collect the annotated elements out of a stamped document, in document order.
 * Ids present in the annotation but absent from the document are reported —
 * that means the snapshot changed after annotation, which invalidates the file.
 */
export function collectGoldUnits(
  doc: Document,
  labels: Record<string, GoldLabel>,
): { units: GoldUnit[]; missing: string[] } {
  const body = doc.body;
  if (!body) return { units: [], missing: Object.keys(labels) };
  const { stream, ranges } = buildDomRanges(body);

  const units: GoldUnit[] = [];
  const missing: string[] = [];
  const seen = new Set<string>();
  let order = 0;
  for (const el of Array.from(body.querySelectorAll(`[${EVAL_ID_ATTR}]`))) {
    const id = el.getAttribute(EVAL_ID_ATTR);
    if (!id) continue;
    const label = labels[id];
    if (!label) continue;
    seen.add(id);
    const range = ranges.get(el) ?? [0, 0];
    const textLength = range[1] - range[0];
    // Text-free elements fall back to a media signature; without it they are
    // unmatched by construction and every system looks like it deleted them.
    const media =
      textLength === 0
        ? mediaSignature(
            el.getAttribute("src") ?? el.querySelector?.("source")?.getAttribute("src") ?? null,
            el.getAttribute("alt"),
          ) ??
          (TEXT_FREE_CONTROL_TAGS.has(el.tagName)
            ? controlSignature(el.tagName, domAccessibleName(el))
            : null)
        : null;
    const rect = (el as Element & { getBoundingClientRect?: () => DOMRect }).getBoundingClientRect?.();
    const area = rect ? rect.width * rect.height : 0;
    units.push({
      evalId: id,
      label,
      key: media ?? stream.key(range[0], range[1]),
      excerpt: media ?? stream.excerpt(range[0], range[1]),
      textLength,
      weight: area > 0 ? area : Math.max(textLength, 1),
      order: order++,
      start: range[0],
      streamLength: stream.length,
      prefix: stream.prefix(range[0], range[1]),
      sourceTag: el.tagName.toLowerCase(),
      declared: isMarkupDeclared(el.tagName, el.getAttribute("role"), label),
    });
  }
  for (const id of Object.keys(labels)) if (!seen.has(id)) missing.push(id);
  return { units, missing };
}

// ─────────────────────────────────────────────────────────────
// System side
// ─────────────────────────────────────────────────────────────

/** One labelled thing a system produced, signed by the text under it. */
export interface Prediction {
  key: string;
  prefix: string;
  textLength: number;
  label: GoldLabel;
  /**
   * Set when the node exists because a run of siblings was grouped rather than
   * because the author wrote the container. Carried through so a disagreement
   * can be attributed to the grouping rather than to classification.
   */
  grouping: IRGrouping | null;
  /** The DOM tag the node was built from; `null` for a synthesised node. */
  sourceTag: string | null;
  /** Containment depth — smaller is more outer. */
  depth: number;
  /** Position in the system's reading order. */
  order: number;
  /** Start of the node's text in the system's own character stream. */
  start: number;
}

/**
 * Project a `PageIR` into predictions.
 *
 * Text is emitted at LEAF nodes only. The parser stores a container's text on
 * the container as well as on the children it decomposed that text into — a
 * `listitem` carrying "html — the raw document source." also holds a `code` and
 * a `text` child spelling out the same words — so emitting at every level would
 * double the signature of every interior node. A container whose own text
 * appears in no child is therefore not indexed; in this parser that does not
 * occur, and if it began to, the symptom would be a drop in alignment coverage,
 * which every report prints.
 */
export function predictionsFromIR(ir: PageIR): Prediction[] {
  const stream = new TextStream();
  const ranges = new Map<string, [number, number]>();

  // Containment depth is measured HERE rather than read off `readingDepth`.
  // That field is 0 for a `list`, its `listitem` and the `code` inside that
  // item alike, so ranking nested nodes by it fell through to an arbitrary
  // tiebreak — and on the ARIA specification that put 2,057 gold `code` units
  // into `list` and 2,213 gold `list` units into `code`, a near-symmetric swap
  // that is the signature of a rank inversion rather than of a parser error.
  const depths = new Map<string, number>();

  const stack: Array<{ id: string; expanded: boolean; start: number; depth: number }> = [
    { id: ir.root, expanded: false, start: 0, depth: 0 },
  ];
  while (stack.length > 0) {
    const frame = stack[stack.length - 1];
    const node = ir.nodes[frame.id];
    if (!node) {
      stack.pop();
      continue;
    }
    if (!frame.expanded) {
      frame.expanded = true;
      frame.start = stream.length;
      depths.set(node.id, frame.depth);
      if (node.children.length === 0) {
        // `label` is deliberately not used: it is frequently a copy of the
        // content, and an aria-label is text that exists nowhere in the
        // document, so either would invent or double the signature.
        stream.push(
          node.content ??
            (node.inlineRuns ? node.inlineRuns.map((r) => r.text).join(" ") : ""),
        );
      } else {
        for (let i = node.children.length - 1; i >= 0; i--) {
          stack.push({
            id: node.children[i],
            expanded: false,
            start: 0,
            depth: frame.depth + 1,
          });
        }
        continue;
      }
    }
    stack.pop();
    ranges.set(node.id, [frame.start, stream.length]);
  }
  stream.seal();

  const preds: Prediction[] = [];
  for (const node of Object.values(ir.nodes)) {
    const range = ranges.get(node.id);
    if (!range) continue;
    const len = range[1] - range[0];
    const media =
      len === 0
        ? mediaSignature(node.attributes.src, node.attributes.alt) ??
          (node.sourceTag &&
          TEXT_FREE_CONTROL_TAGS.has(node.sourceTag.toUpperCase())
            ? controlSignature(
                node.sourceTag,
                node.label ?? node.attributes.placeholder ?? node.attributes.title,
              )
            : null)
        : null;
    if (len === 0 && !media) continue;
    preds.push({
      key: media ?? stream.key(range[0], range[1]),
      prefix: media ?? stream.prefix(range[0], range[1]),
      textLength: len,
      label: goldFromIRNode(node),
      grouping: node.grouping,
      sourceTag: node.sourceTag,
      depth: depths.get(node.id) ?? node.readingDepth,
      order: node.readingIndex,
      start: range[0],
    });
  }
  return preds;
}

/**
 * Predictions from a DOM-side system: one per element the system assigned a
 * role to. Used by the accessibility-tree baseline, which stamps its computed
 * role onto the live document and is then read back here.
 *
 * Unlike the IR side, the text is genuinely the element's subtree, so no leaf
 * emission rule is needed — the DOM does not store a container's text twice.
 */
export function predictionsFromDom(
  body: Element,
  labelOf: (el: Element) => GoldLabel | null,
): Prediction[] {
  const { stream, ranges } = buildDomRanges(body);
  const preds: Prediction[] = [];
  let order = 0;
  const walk = (el: Element, depth: number): void => {
    const label = labelOf(el);
    const range = ranges.get(el);
    // Text-free controls, signed the same way the gold side signs them, so the
    // DOM-side baseline is not the only system that cannot align a radio button.
    if (label && range && range[1] === range[0] && TEXT_FREE_CONTROL_TAGS.has(el.tagName)) {
      const key = controlSignature(el.tagName, domAccessibleName(el));
      if (key) {
        preds.push({
          key,
          prefix: key,
          textLength: 0,
          label,
          grouping: null,
          sourceTag: el.tagName.toLowerCase(),
          depth,
          order: order++,
          start: range[0],
        });
      }
    }
    if (label && range && range[1] > range[0]) {
      preds.push({
        key: stream.key(range[0], range[1]),
        prefix: stream.prefix(range[0], range[1]),
        textLength: range[1] - range[0],
        label,
        grouping: null,
        sourceTag: el.tagName.toLowerCase(),
        depth,
        order: order++,
        start: range[0],
      });
    }
    for (const child of Array.from(el.children)) walk(child, depth + 1);
  };
  for (const child of Array.from(body.children)) walk(child, 0);
  return preds;
}

// ─────────────────────────────────────────────────────────────
// The join
// ─────────────────────────────────────────────────────────────

interface PredictionIndex {
  exact: Map<string, Prediction[]>;
  prefix: Map<string, Prediction[]>;
  /** Length of the system's character stream, for normalising offsets. */
  span: number;
}

/**
 * Index every prediction under its signature — as a LIST, not a single winner.
 *
 * Text collisions are not an edge case. A table of contents repeats every
 * section title verbatim, so on any documentation page each heading's signature
 * matches at least twice; the fixtures do it too (a nav menu of section names
 * above the sections themselves). Keeping one winner per key made the gold
 * heading "Introduction" match the navigation link that happens to say
 * "Introduction", and the system was then scored as calling a heading
 * `navigation` when it had done nothing of the sort.
 */
function buildIndex(preds: Prediction[]): PredictionIndex {
  const exact = new Map<string, Prediction[]>();
  const prefix = new Map<string, Prediction[]>();
  let span = 1;
  const push = (m: Map<string, Prediction[]>, k: string, p: Prediction): void => {
    const list = m.get(k);
    if (list) list.push(p);
    else m.set(k, [p]);
  };
  for (const p of preds) {
    span = Math.max(span, p.start + p.textLength);
    push(exact, p.key, p);
    if (p.textLength < MIN_SIGNATURE) continue;
    push(prefix, p.prefix, p);
  }
  return { exact, prefix, span };
}

/**
 * Pick among candidates that share a signature.
 *
 * Position first, measured in CHARACTERS rather than in node index. Both sides
 * build a stream of the page's text in reading order, so a character offset
 * means the same thing in each — and, unlike a node index, it does not depend on
 * how many nodes either side chose to emit.
 *
 * That independence is the whole point. An annotator labels the units that
 * matter and skips the containers, so a page with 34 stamped elements can yield
 * 18 units; ranking those 18 against the parser's 54 nodes stretches the two
 * sequences by different amounts in different places. On `divsoup-blog` the
 * warp was large enough that the gold heading "Introduction" sat nearer, in
 * normalised node index, to the navigation link reading "Introduction" than to
 * itself — and all three section headings were scored as `navigation` for it.
 * Character offsets are unaffected: the annotation does not change where the
 * page's text lies.
 *
 * Then NESTING RANK, for candidates that position cannot separate at all.
 *
 * `<a href="#menu"><code>menu</code></a>` occurs 4,511 times in the ARIA
 * specification, and both elements are annotatable: the link is a navigation
 * affordance and the code is a role name. They cover exactly the same
 * characters, so they carry exactly the same signature, and a rule that returned
 * one node for that signature scored one of the two wrong every time — 1,838
 * gold `code` units read as `navigation` and 2,355 gold `navigation` units read
 * as `code`, the two largest error groups in the run and both artefacts.
 *
 * A signature identifies a *span of text*, not an element, so where several
 * elements share a span the only thing left to match on is how deeply each sits
 * inside it. Both sides are ranked outermost-first within the span and matched
 * rank to rank: the gold link takes the parser's outer node, the gold code takes
 * the inner one. Where one side nests deeper than the other the rank is clamped,
 * which is the honest outcome — the systems genuinely disagree about how many
 * things are there.
 *
 * With a single gold unit for the span this reduces to rank 0, the outermost
 * candidate, which is the right answer for the case that motivated the previous
 * rule: a `code` node and the synthesised `text` child holding its words are one
 * thing to an annotator, and the child is an artefact of how the parser stores
 * text.
 */
/**
 * A monotone map from positions in the gold stream to positions in a system's
 * stream, fitted from the units that can only mean one thing.
 *
 * Both sides carry the same text in the same order and differ only in what the
 * system left out, so the relationship between the two coordinate systems is
 * increasing but not linear: a page whose masthead is dropped has all its body
 * text shifted earlier, and by a different amount before and after each omission.
 *
 * The fit uses units with a long, unique signature — those cannot be anywhere
 * else, so they say exactly where the streams line up. The pairs are then
 * reduced to their longest non-decreasing subsequence, which throws out the few
 * that are themselves mismatches, and everything between anchors is linearly
 * interpolated.
 */
interface AnchorMap {
  gold: number[];
  pred: number[];
}

function buildAnchorMap(units: GoldUnit[], index: PredictionIndex): AnchorMap {
  const pairs: Array<[number, number]> = [];
  for (const u of units) {
    if (u.textLength < ANCHOR_MIN_TEXT || !u.key) continue;
    const hits = index.exact.get(u.key);
    if (!hits || hits.length === 0) continue;
    // Nested duplicates share a start; that is one position, not several.
    const starts = new Set(hits.map((h) => h.start));
    if (starts.size !== 1) continue;
    pairs.push([u.start, hits[0].start]);
  }
  pairs.sort((a, b) => a[0] - b[0]);

  // Longest non-decreasing subsequence of the prediction offsets (patience
  // sorting). An anchor that goes backwards is a bad pair, not a reordering.
  const tails: number[] = [];
  const tailIndex: number[] = [];
  const prev: number[] = new Array(pairs.length).fill(-1);
  for (let i = 0; i < pairs.length; i++) {
    const v = pairs[i][1];
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (tails[mid] <= v) lo = mid + 1;
      else hi = mid;
    }
    tails[lo] = v;
    tailIndex[lo] = i;
    prev[i] = lo > 0 ? tailIndex[lo - 1] : -1;
  }
  const keep: number[] = [];
  for (let i = tails.length > 0 ? tailIndex[tails.length - 1] : -1; i >= 0; i = prev[i]) {
    keep.push(i);
  }
  keep.reverse();

  return {
    gold: keep.map((i) => pairs[i][0]),
    pred: keep.map((i) => pairs[i][1]),
  };
}

/** Where in the system's stream a gold offset is expected to land. */
function expectedStart(map: AnchorMap, goldStart: number, scale: number): number {
  const n = map.gold.length;
  // Too few anchors to fit anything — fall back to proportional scaling, which
  // is what this did before the map existed.
  if (n < 2) return goldStart * scale;
  if (goldStart <= map.gold[0]) return map.pred[0] + (goldStart - map.gold[0]) * scale;
  if (goldStart >= map.gold[n - 1]) {
    return map.pred[n - 1] + (goldStart - map.gold[n - 1]) * scale;
  }
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (map.gold[mid] <= goldStart) lo = mid;
    else hi = mid;
  }
  const span = map.gold[hi] - map.gold[lo];
  if (span <= 0) return map.pred[lo];
  const t = (goldStart - map.gold[lo]) / span;
  return map.pred[lo] + t * (map.pred[hi] - map.pred[lo]);
}

function choose(
  candidates: Prediction[],
  unit: GoldUnit,
  nestRank: number,
  predSpan: number,
  map: AnchorMap,
  goldSpan: number,
): Prediction | null {
  const scale = predSpan / Math.max(1, goldSpan);
  const expected = expectedStart(map, unit.start, scale);
  const displaced = (c: Prediction): number =>
    Math.abs(c.start - expected) / Math.max(1, predSpan);

  // The single-candidate case gets the displacement check too. It is in fact the
  // commonest way the wrong match happens: the chrome copy is dropped, exactly
  // one copy of the text survives somewhere else, and with nothing to choose
  // between there is no collision to notice.
  if (candidates.length === 1) {
    return displaced(candidates[0]) > MAX_DISPLACEMENT ? null : candidates[0];
  }

  // Candidates that begin at the same character are one nest — a `<td>`, the
  // `<ul>` in it, the `<li>`, the `<a>` and the `<code>` all start where their
  // shared text starts.
  const nests = new Map<number, Prediction[]>();
  for (const c of candidates) {
    const nest = nests.get(c.start);
    if (nest) nest.push(c);
    else nests.set(c.start, [c]);
  }

  // Prefer a nest deep enough to answer for this rank. Position alone is not
  // reliable enough to choose between nests: the two streams differ in length
  // wherever a system drops content, so normalised offsets drift apart through
  // the document — by 0.003 in the middle of the ARIA specification, forty
  // times the 24-character tie band. A bare `<a>alertdialog</a>` elsewhere on
  // the page then sat NEARER the gold unit than the `<td><ul><li><a><code>`
  // nest it actually belongs to, and a rank-4 unit clamped onto a two-node nest
  // came back as the synthesised text leaf: `prose`. Requiring the nest to have
  // a rank 4 at all rules the decoy out, because the annotator saw five nested
  // things there and that place has two.
  const deep: Prediction[][] = [];
  for (const nest of nests.values()) if (nest.length > nestRank) deep.push(nest);
  const pool = deep.length > 0 ? deep : [...nests.values()];

  let best = pool[0];
  let bestDistance = Infinity;
  for (const nest of pool) {
    const d = displaced(nest[0]);
    if (d < bestDistance) {
      bestDistance = d;
      best = nest;
    }
  }

  // A match on the far side of the document is not a match.
  //
  // Signatures are text, and text repeats: a site menu's link labels reappear in
  // a sidebar, a specification's role names appear both in its contents rail and
  // in its body. When the system correctly DROPS the chrome copy, the surviving
  // body copy still carries the same signature, and the gold chrome unit binds
  // to it — so a system that did exactly the right thing is recorded as having
  // kept the boilerplate. On the MDN landmark-roles page that put
  // `boilerplateRejection` at 0.391 while the parser had in fact removed the
  // navigation; the gold unit at position 0.015 was bound to a node two-thirds
  // of the way down the page.
  //
  // Legitimate drift between the two streams is small — about 0.003 in the
  // middle of the largest document here, since both sides carry the same text in
  // the same order and differ only in what they omit. The bound below is nearly
  // two orders of magnitude looser than that, so it rejects only matches that
  // are somewhere else entirely, and an unmatched unit is `absent`, which is the
  // honest answer.
  if (bestDistance > MAX_DISPLACEMENT) return null;

  // Within the nest, outermost first, matched rank to rank.
  const ordered = [...best].sort((a, b) => a.depth - b.depth || a.order - b.order);
  return ordered[Math.min(nestRank, ordered.length - 1)];
}

/**
 * Rank each gold unit within its nest of same-signature siblings, outermost
 * first — the gold-side half of the rule above. Units sharing a signature but
 * lying elsewhere on the page (a heading and its table-of-contents entry) are
 * separate nests, each starting again at rank 0, so a repeated title is still
 * resolved by position rather than by nesting.
 */
function nestRanks(units: GoldUnit[]): Map<string, number> {
  const byNest = new Map<string, GoldUnit[]>();
  for (const u of units) {
    if (!u.key) continue;
    const nest = `${u.key}@${u.start}`;
    const list = byNest.get(nest);
    if (list) list.push(u);
    else byNest.set(nest, [u]);
  }
  const ranks = new Map<string, number>();
  for (const list of byNest.values()) {
    // Outermost first: the wider span contains the narrower, and among equal
    // spans the earlier element in document order is the parent.
    list.sort((a, b) => b.textLength - a.textLength || a.order - b.order);
    list.forEach((u, i) => ranks.set(u.evalId, i));
  }
  return ranks;
}

export interface AlignmentResult {
  /** evalId → the label the system assigned to the matching output node. */
  predicted: Map<string, PredictedLabel>;
  /** evalId → the position of the matching node in the system's reading order. */
  order: Map<string, number>;
  /** evalId → why the matched node has the role it has. */
  provenance: Map<string, { grouping: IRGrouping | null; sourceTag: string | null }>;
  /**
   * Fraction of SCORED gold units that found a counterpart at all (0–1).
   *
   * Page chrome is excluded, for the same reason it is excluded from the
   * labelling endpoints: the XR scene does not render a cookie bar, so a system
   * that drops one is behaving correctly and `boilerplateRejection` is where
   * that gets credit. Counting chrome here punished exactly that — 291 of the
   * 309 unmatched units on the GitHub page were chrome, which alone took its
   * coverage to 48% and put it within sight of the exclusion gate. Coverage is
   * meant to detect a snapshot and an annotation that describe different
   * documents; it should be computed over the units the score is computed over.
   */
  coverage: number;
  /** Coverage including chrome, for the report — the two differing is normal. */
  coverageWithChrome: number;
  matchedExact: number;
  matchedPrefix: number;
  unmatched: number;
  /** Units whose signature matched more than one node, resolved by position. */
  collisions: number;
}

/**
 * Align gold units to a system's predictions. Exact signature match first, then
 * a prefix match for systems that rewrite markup but preserve text (Readability
 * reflows into its own container tree; VIPS re-groups). Anything still
 * unmatched is `absent`.
 */
export function alignPredictions(
  units: GoldUnit[],
  preds: Prediction[],
): AlignmentResult {
  const index = buildIndex(preds);
  const predicted = new Map<string, PredictedLabel>();
  const order = new Map<string, number>();
  const provenance = new Map<
    string,
    { grouping: IRGrouping | null; sourceTag: string | null }
  >();
  const ranks = nestRanks(units);
  const map = buildAnchorMap(units, index);
  const goldSpan = units.reduce(
    (m, u) => Math.max(m, u.start + u.textLength),
    1,
  );
  let matchedExact = 0;
  let matchedPrefix = 0;
  let unmatched = 0;
  let collisions = 0;

  for (const u of units) {
    const exact = u.key ? index.exact.get(u.key) : undefined;
    if (exact) {
      const hit = choose(exact, u, ranks.get(u.evalId) ?? 0, index.span, map, goldSpan);
      if (hit) {
        if (exact.length > 1) collisions++;
        predicted.set(u.evalId, hit.label);
        order.set(u.evalId, hit.order);
        provenance.set(u.evalId, { grouping: hit.grouping, sourceTag: hit.sourceTag });
        matchedExact++;
        continue;
      }
    }
    // Short texts are not put through the fuzzy pass: a six-character prefix
    // matches half the page, and the resulting label would be a coin toss that
    // differs between systems for no reason attributable to either.
    const pre =
      u.textLength >= MIN_SIGNATURE ? index.prefix.get(u.prefix) : undefined;
    if (pre) {
      const hit = choose(pre, u, ranks.get(u.evalId) ?? 0, index.span, map, goldSpan);
      if (hit) {
        if (pre.length > 1) collisions++;
        predicted.set(u.evalId, hit.label);
        order.set(u.evalId, hit.order);
        provenance.set(u.evalId, { grouping: hit.grouping, sourceTag: hit.sourceTag });
        matchedPrefix++;
        continue;
      }
    }
    predicted.set(u.evalId, ABSENT);
    unmatched++;
  }

  const total = units.length || 1;
  let scored = 0;
  let scoredMatched = 0;
  for (const u of units) {
    if (u.label === "chrome") continue;
    scored++;
    if ((predicted.get(u.evalId) ?? ABSENT) !== ABSENT) scoredMatched++;
  }
  return {
    predicted,
    order,
    provenance,
    coverage: scoredMatched / (scored || 1),
    coverageWithChrome: (matchedExact + matchedPrefix) / total,
    matchedExact,
    matchedPrefix,
    unmatched,
    collisions,
  };
}
