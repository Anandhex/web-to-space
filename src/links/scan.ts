/**
 * links/scan.ts — the cheap read of a document.
 *
 * A wing at depth 2 or 3 is a nameplate about 3° tall. It shows a title and
 * nothing else, and the only other thing it has to do is say which document
 * comes after it down the corridor. Running the whole pipeline for that would
 * cost between 60 ms and 2.8 s of main-thread DOM work (docs/neighbour-walls.md,
 * Part II) — for a plate — and a long block inside an XR frame is not a slow
 * feature, it is a dead session.
 *
 * So this is the degraded read: one `DOMParser` pass, a title, a few headings,
 * and an anchor histogram. It is deliberately NOT the classifier — it has no
 * IR, no layout, no pages, and therefore no `pageSpread` and no idea which
 * anchors survived `prunePageChrome`. What it can still see is the one signal
 * the ranking mostly rests on: how often a document points at a place.
 *
 * **This is a stated limitation, not a hidden one.** A depth-3 wing is chosen
 * on weaker evidence than a depth-1 wing, which is why `Neighbour.why` carries
 * `"scan"` for it: the renderer can mark it and the thesis can report it.
 */

/** What a cheap read yields. Everything a nameplate or a spine card draws. */
export interface DocScan {
  url: string;
  title: string;
  /** First few headings, for a spine card's section bars. */
  headings: string[];
  /** Destinations this document points at, most-pointed-at first. */
  candidates: ScanCandidate[];
}

export interface ScanCandidate {
  url: string;
  label: string;
  occurrences: number;
  /** Document order of the first occurrence — the tie-break. */
  order: number;
}

/**
 * Anchor text that names a citation identifier rather than a destination.
 *
 * The full classifier does not need this list: `region: "footing"` already
 * carries citations, and `links/neighbours.ts` filters on the region. A scan
 * has no regions, so the same job has to be done by the only thing it can see.
 * Kept short and literal — this is a stopgap for a plate, not a taxonomy.
 */
const IDENTIFIER_ANCHORS = new Set([
  "doi", "isbn", "issn", "pmid", "pmc", "oclc", "bibcode", "s2cid", "jstor",
  "arxiv", "citation needed", "edit", "^", "permalink",
]);

const SKIP_PROTOCOLS = ["mailto:", "tel:", "javascript:", "data:", "blob:"];

/** Collapse whitespace; the same normalisation `classify.ts` applies. */
function tidy(s: string | null | undefined): string {
  return (s ?? "").replace(/\s+/g, " ").trim();
}

/**
 * Read a document cheaply.
 *
 * `sameSiteOnly` is on for lateral corridors and off for a corridor that has
 * already left the site: once the reader is on another host, that host's own
 * pages are the siblings, so "same site" means same as THIS document.
 */
export function scanDocument(html: string, url: string): DocScan {
  const empty: DocScan = { url, title: "", headings: [], candidates: [] };
  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(html, "text/html");
  } catch {
    return empty;
  }
  if (!doc?.body) return empty;

  const title =
    tidy(doc.querySelector("h1")?.textContent) ||
    tidy(doc.querySelector("title")?.textContent) ||
    tidy(url.replace(/^https?:\/\//, ""));

  const headings: string[] = [];
  for (const h of Array.from(doc.querySelectorAll("h2, h3")).slice(0, 12)) {
    const t = tidy(h.textContent);
    if (t) headings.push(t.slice(0, 80));
  }

  let origin = "";
  try {
    origin = new URL(url).origin;
  } catch {
    /* a file:// fixture — every href will resolve off-site and that is fine */
  }

  const counts = new Map<string, ScanCandidate>();
  let order = 0;
  for (const a of Array.from(doc.querySelectorAll("a[href]"))) {
    const href = a.getAttribute("href") ?? "";
    if (!href || href.startsWith("#")) continue;
    if (SKIP_PROTOCOLS.some((p) => href.toLowerCase().startsWith(p))) continue;

    const text = tidy(a.textContent);
    if (!text) continue;
    if (IDENTIFIER_ANCHORS.has(text.toLowerCase())) continue;

    let resolved: URL;
    try {
      resolved = new URL(href, url);
    } catch {
      continue;
    }
    if (resolved.protocol !== "http:" && resolved.protocol !== "https:") continue;
    // Same document, reached the long way round.
    resolved.hash = "";
    if (resolved.href === url.split("#")[0]) continue;
    // A scan cannot tell a body link from a chrome link, so it takes the
    // safest available proxy for "this is the document's own neighbourhood"
    // and stays on the host it is reading.
    if (origin && resolved.origin !== origin) continue;

    const key = resolved.href;
    const seen = counts.get(key);
    if (seen) seen.occurrences++;
    else counts.set(key, { url: key, label: text.slice(0, 80), occurrences: 1, order: order++ });
  }

  const candidates = [...counts.values()].sort(
    (a, b) => b.occurrences - a.occurrences || a.order - b.order || (a.url < b.url ? -1 : 1),
  );
  return { url, title, headings, candidates };
}

/** The next document down a corridor, from a cheap read. */
export function scanBest(scan: DocScan, exclude: ReadonlySet<string>): ScanCandidate | null {
  for (const c of scan.candidates) if (!exclude.has(c.url)) return c;
  return null;
}
