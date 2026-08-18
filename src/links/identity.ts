/**
 * links/identity.ts — what to call a destination.
 *
 * A body in the field is two square centimetres of wall with a name on it, so
 * the name is most of the design. The rule the build plan sets is that the
 * DEFAULT PATH NEVER TOUCHES THE NETWORK: a page's neighbourhood must stand up
 * the instant the page is parsed, offline, with no title fetch and nothing
 * leaving the browser. Title resolution is a Phase-4 enrichment layered over
 * this (see `providers/`), never a precondition for drawing.
 *
 * Priority, per the plan:
 *   1. the accessible name (aria-label / title / labelledby) when it is real
 *   2. the anchor's own text, when it identifies anything at all
 *   3. the target fragment's own name
 *   4. the URL slug — the last path segment, de-slugged
 *   5. the host
 *
 * Only 3–5 count as SYNTHESIS. Steps 1 and 2 are the page's own words, which
 * is what the reader will have read; replacing them would be an improvement
 * the reader did not ask for.
 */
import {
  anchorIdentifiesNothing,
  normaliseText,
  resolveHref,
  extensionOf,
} from "./classify";

/** Ceiling on a body's name. Two lines at the wall's body size. */
export const LABEL_MAX_CHARS = 42;

export interface IdentityInput {
  href: string;
  /** The primitive's accessible name — already aria-label ∨ title ∨ text. */
  accessibleName: string | null;
  /** The anchor's visible text, when it differs from the accessible name. */
  anchorText: string | null;
  /** The document's URL, for resolving relative hrefs. */
  pageUrl: string | null;
  /** For a same-document reference: the heading of whatever it points at. */
  targetLabel?: string | null;
}

export interface Identity {
  label: string;
  host: string | null;
  /** True when the name came from steps 3–5, not from the page's own words. */
  synthesised: boolean;
  source: "accessible-name" | "anchor-text" | "target" | "slug" | "host" | "href";
}

/**
 * `words-with-hyphens_and_underscores` → `Words with hyphens and underscores`.
 * Percent-decoding first, because a real URL slug is where a title with spaces
 * goes to be encoded, and `Decline%20and%20fall` should come back as prose.
 * Leaves an ALLCAPS or CamelCase segment alone: those are names already
 * ("RFC2119", "getUserMedia"), and lower-casing them destroys information.
 */
export function deslug(segment: string): string {
  let s = segment;
  try {
    s = decodeURIComponent(s);
  } catch {
    /* a stray % is not worth failing over */
  }
  s = s.replace(/\.(html?|php|aspx?|jsp|md)$/i, "");
  s = s.replace(/[-_+]+/g, " ").replace(/\s+/g, " ").trim();
  if (s === "") return "";
  // Sentence case only when the segment is plainly a slug: all lower-case.
  if (s === s.toLowerCase()) return s.charAt(0).toUpperCase() + s.slice(1);
  return s;
}

/** Host without a leading `www.`, or null when the href has no host. */
export function hostOf(href: string, pageUrl: string | null): string | null {
  const u = resolveHref(href, pageUrl);
  if (!u || !u.host) return null;
  return u.host.replace(/^www\./i, "");
}

/** The last meaningful path segment of a URL, or "" when there is none. */
export function slugOf(href: string, pageUrl: string | null): string {
  const u = resolveHref(href, pageUrl);
  const path = u ? u.pathname : href.split(/[?#]/)[0];
  const parts = path.split("/").filter((p) => p !== "");
  for (let i = parts.length - 1; i >= 0; i--) {
    const seg = parts[i];
    // Skip an index file and pure-numeric ids — neither names anything, and a
    // date path (/2024/03/12/the-title) should fall through to the title.
    if (/^index\.(html?|php|aspx?|jsp)$/i.test(seg)) continue;
    if (/^\d+$/.test(seg)) continue;
    const name = deslug(seg);
    if (name !== "") return name;
  }
  // No usable segment: a bare host, or a query-only URL. Try the query.
  if (u && u.search) {
    for (const [, v] of u.searchParams) {
      const name = deslug(v);
      if (name.length > 2) return name;
    }
  }
  return "";
}

export function truncate(s: string, max = LABEL_MAX_CHARS): string {
  const t = normaliseText(s);
  if (t.length <= max) return t;
  // Break on a word boundary when one is near enough that the cut is not ugly.
  const cut = t.slice(0, max - 1);
  const sp = cut.lastIndexOf(" ");
  return (sp > max * 0.6 ? cut.slice(0, sp) : cut).trimEnd() + "…";
}

/**
 * The name to put on the body. Never empty, never a network call.
 */
export function synthesiseIdentity(input: IdentityInput): Identity {
  const { href, pageUrl } = input;
  const host = hostOf(href, pageUrl);

  const name = normaliseText(input.accessibleName);
  const text = normaliseText(input.anchorText);

  // 1–2. The page's own words, when they say anything.
  if (name !== "" && !anchorIdentifiesNothing(name)) {
    return { label: truncate(name), host, synthesised: false, source: "accessible-name" };
  }
  if (text !== "" && !anchorIdentifiesNothing(text)) {
    return { label: truncate(text), host, synthesised: false, source: "anchor-text" };
  }

  // 3. A same-document reference names itself by what it points at.
  const target = normaliseText(input.targetLabel);
  if (target !== "") {
    return { label: truncate(target), host, synthesised: true, source: "target" };
  }
  const frag = href.trim().startsWith("#") ? deslug(href.trim().slice(1)) : "";
  if (frag !== "") {
    return { label: truncate(frag), host, synthesised: true, source: "target" };
  }

  // 4. The URL slug.
  const slug = slugOf(href, pageUrl);
  if (slug !== "") {
    return { label: truncate(slug), host, synthesised: true, source: "slug" };
  }

  // 5. The host — the weakest name that is still a name.
  if (host) {
    return { label: truncate(host), host, synthesised: true, source: "host" };
  }

  // Nothing resolved: a file: href, or a scheme with no host. Say what it is
  // rather than drawing an unnamed body.
  const ext = extensionOf(href.split(/[?#]/)[0]);
  const fallback = ext ? `${ext.toUpperCase()} file` : normaliseText(href) || "Link";
  return { label: truncate(fallback), host, synthesised: true, source: "href" };
}
