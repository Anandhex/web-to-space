/**
 * links/classify.ts — which region a reference belongs to, and at what cost.
 *
 * This is the contribution the thesis can defend with a number attached
 * (docs/reference-neighbourhood.md §13F), so it is a pure function of what the
 * pipeline already recovers: the primitive tree, the href, and the page URL.
 * No DOM, no network, no renderer. `__tests__/gold-set.ts` scores it.
 *
 * ── Decision order, and the one place it departs from the build plan ──
 *
 * The plan's table tests `arrangement` first (`href` starts with `#`) and then
 * lists "`#cite`-style fragments" under `footing`. Those two rules overlap on
 * exactly the commonest citation on the web — the Wikipedia superscript — and
 * only one of them can win.
 *
 * Rule 5 of the model decides it: *a same-document reference gets no body.* A
 * `#cite_note-13` jump goes to a bibliography entry that is already an object
 * in this document; giving it a body in the footing would draw the same thing
 * twice, which is the exact failure rule 5 exists to prevent. So arrangement
 * wins, and the citation signal is preserved as a separate `citation` flag —
 * the renderer can still light the footing in citation colours, and the real
 * provenance link (the source URL inside that bibliography entry) is caught by
 * `footing` on the way past, which is where the evidence actually lives.
 */
import type { XRPrimitive } from "../mapper/types";
import type { Locus, Region } from "./types";

// ── Signals ──────────────────────────────────────────────────────────────

/**
 * Schemes that are an ACTION, not a place (§13C rule 4). Following one hands
 * off to another application; nothing in the neighbourhood could stand for it.
 */
const OPERATIONAL_SCHEMES = new Set([
  "mailto:",
  "tel:",
  "sms:",
  "callto:",
  "javascript:",
  "data:",
  "blob:",
  "file:",
]);

/**
 * Extensions that download rather than navigate. Deliberately excludes .html,
 * .htm, .php, .asp(x), .jsp and the extensionless case — those are pages.
 * Also excludes image extensions used as a page's own href only when the link
 * is a lightbox, which we cannot see from here; an image href IS a file, so it
 * stays operational and the false-positive rate is reported honestly.
 */
const FILE_EXTENSIONS = new Set([
  "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt", "ods", "odp",
  "zip", "gz", "tar", "tgz", "bz2", "7z", "rar",
  "csv", "tsv", "json", "xml", "rss", "atom",
  "mp3", "mp4", "wav", "ogg", "webm", "mov", "avi", "m4a", "flac",
  "png", "jpg", "jpeg", "gif", "svg", "webp", "avif", "ico", "bmp", "tiff",
  "exe", "dmg", "pkg", "deb", "rpm", "apk", "msi",
  "epub", "mobi", "ics", "vcf",
]);

/**
 * Section names that mark a bibliography. Matched against the heading text of
 * an ancestor section, which is the only citation signal that survives an
 * unmodified page — `role="doc-bibliography"` exists in DPUB-ARIA but is
 * vanishingly rare outside publishing, and it is not in the parser's IRRole
 * set, so a heading match is what the pipeline can actually offer.
 */
const BIBLIOGRAPHY_HEADINGS =
  /^\s*(references?|bibliograph(y|ies)|works?\s+cited|citations?|sources?|further\s+reading|notes?|end\s?notes?|foot\s?notes?|literature)\b/i;

/** `#cite_note-13`, `#ref-4`, `#fn2`, `#footnote-a`, `#note-x`, `#bib12`. */
const CITATION_FRAGMENT = /^#(cite[-_]?|cite_?note|cite_?ref|ref[-_]?|fn[-_]?|footnote[-_]?|note[-_]?|bib[-_]?|endnote[-_]?)\w*/i;

/**
 * Anchor text that can only be a citation marker: a bracketed number or letter,
 * or a footnote dagger. Strict on purpose — see BACKREF_MARKER below.
 */
const CITATION_MARKER = /^(\[\s*\d{1,4}[a-z]?\s*\]|[†‡¶§]+|\*{1,3})$/i;

/**
 * The looser family: a bare number, a caret, a run of single letters
 * ("a b c" — Wikipedia's multi-use back-references). These are used ONLY to
 * confirm a citation that a `#cite`-style fragment has already identified, and
 * never on their own.
 *
 * They cannot stand alone because they are indistinguishable from ordinary
 * one-character page furniture. Measured on the census corpus, the bare-letter
 * form alone put 91 of Wikipedia's navbox controls — the "v · t · e"
 * view/talk/edit triple at the head of every template box — into the footing,
 * which is to say it filled the region reserved for evidence with the page's
 * own edit buttons.
 */
const BACKREF_MARKER = /^(\d{1,4}[a-z]?|\^|[a-z]( [a-z])*)$/i;

/**
 * Anchor text that identifies nothing. The stoplist half of degeneracy; the
 * word-count half lives in `isDegenerateAnchor`.
 */
const DEGENERATE_PHRASES = new Set([
  "read more", "readmore", "more", "click here", "here", "link", "this",
  "this link", "see here", "learn more", "find out more", "continue",
  "continue reading", "details", "more info", "more information", "go",
  "download", "view", "see more", "full story", "read the full story",
  "next", "previous", "back", "home", "info", "?", "…", "...",
]);

// ── Small pure helpers, shared with identity.ts and the census ────────────

export function normaliseText(s: string | null | undefined): string {
  return (s ?? "").replace(/\s+/g, " ").trim();
}

/** Resolve `href` against the page URL. Returns null when neither parses. */
export function resolveHref(href: string, pageUrl: string | null): URL | null {
  try {
    return new URL(href, pageUrl ?? undefined);
  } catch {
    try {
      return new URL(href);
    } catch {
      return null;
    }
  }
}

function isOperationalScheme(href: string): boolean {
  const h = href.trim().toLowerCase();
  for (const s of OPERATIONAL_SCHEMES) if (h.startsWith(s)) return true;
  return false;
}

/** The pathname's extension, lower-cased, or null. */
export function extensionOf(pathname: string): string | null {
  const last = pathname.split("/").pop() ?? "";
  const dot = last.lastIndexOf(".");
  if (dot <= 0 || dot === last.length - 1) return null;
  return last.slice(dot + 1).toLowerCase();
}

function isFileHref(href: string, pageUrl: string | null): boolean {
  const u = resolveHref(href, pageUrl);
  const path = u ? u.pathname : href.split(/[?#]/)[0];
  const ext = extensionOf(path);
  return ext !== null && FILE_EXTENSIONS.has(ext);
}

/**
 * The census's degeneracy test, as specified in the build plan: the stoplist,
 * or two words or fewer. Broader than what `identity.ts` acts on, because a
 * two-word proper noun ("Andrew Choi") identifies its destination perfectly
 * well and must not be replaced by a URL slug. Kept as its own function so the
 * reported metric is not quietly redefined by a rendering decision.
 */
export function isDegenerateAnchor(text: string): boolean {
  const t = normaliseText(text).toLowerCase().replace(/[.,;:!?]+$/, "");
  if (t === "") return true;
  if (DEGENERATE_PHRASES.has(t)) return true;
  return t.split(" ").filter(Boolean).length <= 2;
}

/** The stricter test: text that identifies NOTHING, so a name must be found. */
export function anchorIdentifiesNothing(text: string): boolean {
  const t = normaliseText(text).toLowerCase().replace(/[.,;:!?]+$/, "");
  if (t === "") return true;
  if (DEGENERATE_PHRASES.has(t)) return true;
  if (CITATION_MARKER.test(t) || BACKREF_MARKER.test(t)) return true;
  // A bare URL is not a name — it is the thing a name would have replaced.
  if (/^(https?:\/\/|www\.)/i.test(t)) return true;
  return false;
}

/** Text that is a citation marker on its own evidence. */
function isCitationMarker(text: string): boolean {
  const t = normaliseText(text).replace(/[.,;:]+$/, "");
  return t !== "" && CITATION_MARKER.test(t);
}

/** Text that confirms a citation a fragment has already identified. */
function isBackrefMarker(text: string): boolean {
  const t = normaliseText(text).replace(/[.,;:]+$/, "");
  return t !== "" && (CITATION_MARKER.test(t) || BACKREF_MARKER.test(t));
}

function isCitationFragment(href: string): boolean {
  return CITATION_FRAGMENT.test(href.trim());
}

function isBibliographyHeading(title: string | null): boolean {
  return title !== null && BIBLIOGRAPHY_HEADINGS.test(normaliseText(title));
}

// ── Ancestry ─────────────────────────────────────────────────────────────

/** What the walk in collect.ts hands the classifier about a link's setting. */
interface LinkContext {
  /** Ancestors of the anchor, ROOT FIRST, not including the anchor itself. */
  ancestors: XRPrimitive[];
  /** The document's own URL, for the origin comparison. Null → same-site. */
  pageUrl: string | null;
  /**
   * Primitive ids the MAPPER produced from a `navigation` landmark, whatever
   * type it gave them.
   *
   * This is not redundant with the type test below. A navigation landmark
   * whose links are not all same-page anchors is mapped to an **XRList** of
   * cards (`landmark:navigation→XRList`, mapper/nodeMapper.ts), not to an
   * XRNavigationBar — so on every page in the census corpus except the
   * synthesised table of contents, checking the ancestor's TYPE finds no
   * navigation at all and the whole site menu lands in the field. The scene
   * already records what each primitive was made from, in
   * `diagnostics.appliedRules`; collect.ts reads it and passes it here.
   */
  navIds?: ReadonlySet<string>;
}

const NAV_TYPES = new Set<string>(["XRNavigationBar", "XRMenu", "XRTabGroup"]);
const FOOT_TYPES = new Set<string>(["XRFooter"]);

/** True when a navigation landmark encloses the anchor. */
function inNavigation(
  ancestors: XRPrimitive[],
  navIds?: ReadonlySet<string>,
): boolean {
  return ancestors.some((a) => NAV_TYPES.has(a.type) || navIds?.has(a.id) === true);
}

/** True when the anchor sits in a bibliography — by landmark or by heading. */
function inBibliography(ancestors: XRPrimitive[]): boolean {
  for (const a of ancestors) {
    if (a.type === "XRSection") {
      // A section carries its heading twice: as `title` (set by the mapper from
      // the heading it consumed) and as `label`. Either will do.
      if (isBibliographyHeading(a.title) || isBibliographyHeading(a.label)) return true;
    }
    if (a.type === "XRList" && isBibliographyHeading(a.label)) return true;
  }
  return false;
}

function inFooter(ancestors: XRPrimitive[]): boolean {
  return ancestors.some((a) => FOOT_TYPES.has(a.type));
}

// ── The decision ─────────────────────────────────────────────────────────

interface Classification {
  region: Region;
  locus: Locus;
  citation: boolean;
  /** Which rule fired. Carried into the gold-set report so misses are legible. */
  reason: string;
  /** Fragment name, when the href is a same-document reference. */
  fragment?: string;
}

export function classifyLink(
  href: string,
  anchorText: string,
  ctx: LinkContext,
): Classification {
  const raw = (href ?? "").trim();
  const text = normaliseText(anchorText);
  const citationSignal =
    isCitationFragment(raw) || (raw.startsWith("#") && isBackrefMarker(text));

  // ── 0. An href that goes nowhere is an action on the page ──
  if (raw === "" || raw === "#") {
    return { region: "page", locus: "operational", citation: false, reason: "empty-href" };
  }

  // ── 1. Operational: an action is not a place (rule 4) ──
  if (isOperationalScheme(raw)) {
    return {
      region: "page",
      locus: "operational",
      citation: false,
      reason: `scheme:${raw.split(":")[0].toLowerCase()}`,
    };
  }

  // ── 2. Same-document: no body at all (rule 5) ──
  //
  // Both the bare `#fragment` form and the absolute form that happens to
  // resolve to this very page — the second is what a server-rendered
  // table of contents emits, and treating it as a destination would put a
  // body in the field for a section already on the wall.
  const frag = sameDocumentFragment(raw, ctx.pageUrl);
  if (frag !== null) {
    return {
      region: "arrangement",
      locus: "same-document",
      citation: citationSignal,
      reason: citationSignal ? "fragment:citation" : "fragment",
      fragment: frag,
    };
  }

  // ── 3. A file is a download, which is an action ──
  if (isFileHref(raw, ctx.pageUrl)) {
    return {
      region: "page",
      locus: "operational",
      citation: false,
      reason: `file:${extensionOf(resolveHref(raw, ctx.pageUrl)?.pathname ?? raw) ?? "?"}`,
    };
  }

  const locus = locusOf(raw, ctx.pageUrl);

  // ── 4. Footing: citations and provenance ──
  //
  // Tested BEFORE ascent, because a bibliography sitting inside a <footer> is
  // common and its entries are evidence, not site navigation. Tested after
  // same-document so rule 5 keeps its priority.
  if (inBibliography(ctx.ancestors)) {
    return { region: "footing", locus, citation: true, reason: "in-bibliography" };
  }
  if (citationSignal || isCitationMarker(text)) {
    return { region: "footing", locus, citation: true, reason: "citation-marker" };
  }

  // ── 5. Ascent: the level above, reached deliberately and rarely ──
  if (inNavigation(ctx.ancestors, ctx.navIds)) {
    return { region: "ascent", locus, citation: false, reason: "in-navigation" };
  }
  if (inFooter(ctx.ancestors)) {
    // A footer's link run is site navigation wearing a different hat: "About",
    // "Privacy", "Contact". It is the level up, not evidence.
    return { region: "ascent", locus, citation: false, reason: "in-footer" };
  }

  // ── 6. Field: everything that leads away. Radius is the locus. ──
  return { region: "field", locus, citation: false, reason: "default-field" };
}

/**
 * The fragment this href names IN THIS DOCUMENT, or null when it leads away.
 * Handles `#x`, `?q=1#x` against the same path, and the absolute form of the
 * page's own URL. An href of `#` alone was already taken as an action.
 */
function sameDocumentFragment(
  href: string,
  pageUrl: string | null,
): string | null {
  const raw = href.trim();
  if (raw.startsWith("#")) {
    const f = decodeURIComponent(raw.slice(1));
    return f === "" ? null : f;
  }
  if (!pageUrl) return null;
  const target = resolveHref(raw, pageUrl);
  const page = resolveHref(pageUrl, null);
  if (!target || !page) return null;
  if (target.hash === "" || target.hash === "#") return null;
  if (target.origin !== page.origin || target.pathname !== page.pathname) return null;
  const f = decodeURIComponent(target.hash.slice(1));
  return f === "" ? null : f;
}

/**
 * Same site or not. A page loaded from a `file:` URL or with no URL at all has
 * no origin to compare against, so every absolute http(s) href is off-site and
 * every relative one is same-site — which is the right answer for the offline
 * corpus and for a pasted HTML fragment alike.
 */
function locusOf(href: string, pageUrl: string | null): Locus {
  const raw = href.trim();
  const absolute = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) || raw.startsWith("//");
  if (!absolute) return "same-site";
  const target = resolveHref(raw, pageUrl);
  if (!target) return "unknown";
  const page = pageUrl ? resolveHref(pageUrl, null) : null;
  if (!page || page.protocol === "file:") return "off-site";
  return target.host === page.host ? "same-site" : "off-site";
}
