/**
 * eval/gold/stamp.ts — stable element addressing for the gold corpus.
 *
 * Every element of a frozen snapshot gets `data-eval-id="eN"` in document
 * order. That attribute is the join key between the annotation files, the
 * segmentation reference and the annotation UI, and it is the reason the corpus
 * must be frozen BEFORE annotation begins: re-fetching a page renumbers it.
 *
 * The attribute is inert — no parser layer reads `data-*`, so a stamped page
 * parses identically to its unstamped original. `verifyStampIsInert()` is the
 * check that this stays true.
 */

const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "META", "LINK", "HEAD"]);

export const EVAL_ID_ATTR = "data-eval-id";

/** Stamp a live document in place. Returns the number of ids assigned. */
export function stampDocument(doc: Document): number {
  let n = 0;
  const walk = (el: Element): void => {
    if (SKIP.has(el.tagName)) return;
    el.setAttribute(EVAL_ID_ATTR, `e${n++}`);
    for (const child of Array.from(el.children)) walk(child);
  };
  const body = doc.body;
  if (!body) return 0;
  walk(body);
  return n;
}

/** Stamp an HTML string, returning the stamped serialisation. */
export function stampHtml(html: string): { html: string; count: number } {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const count = stampDocument(doc);
  const serialised = `<!DOCTYPE html>\n${doc.documentElement.outerHTML}`;
  return { html: serialised, count };
}

/**
 * Guard against the stamp changing what is parsed. Compares the normalised text
 * content and element count of a document before and after stamping — if these
 * diverge the snapshot is being mutated by the serialisation round-trip (an
 * unclosed tag being repaired, for instance) and the corpus entry is unsafe to
 * annotate.
 */
export function verifyStampIsInert(html: string): {
  ok: boolean;
  reason?: string;
} {
  const before = new DOMParser().parseFromString(html, "text/html");
  const beforeText = (before.body?.textContent ?? "").replace(/\s+/g, " ").trim();
  const beforeCount = before.body?.querySelectorAll("*").length ?? 0;

  const { html: stamped } = stampHtml(html);
  const after = new DOMParser().parseFromString(stamped, "text/html");
  const afterText = (after.body?.textContent ?? "").replace(/\s+/g, " ").trim();
  const afterCount = after.body?.querySelectorAll("*").length ?? 0;

  if (beforeText !== afterText) {
    return { ok: false, reason: "text content changed across the stamp round-trip" };
  }
  if (beforeCount !== afterCount) {
    return {
      ok: false,
      reason: `element count changed across the stamp round-trip (${beforeCount} → ${afterCount})`,
    };
  }
  return { ok: true };
}

/** The `data-eval-id` of an element, or of its nearest stamped ancestor. */
export function evalIdOf(el: Element): string | null {
  let cur: Element | null = el;
  while (cur) {
    const id = cur.getAttribute?.(EVAL_ID_ATTR);
    if (id) return id;
    cur = cur.parentElement;
  }
  return null;
}
