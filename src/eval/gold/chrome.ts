/**
 * eval/gold/chrome.ts — what counts as site chrome.
 *
 * One definition, imported by the oracle, the lint and the re-annotation pass,
 * because three copies of a rule is three chances for them to disagree about
 * the same annotation. (The parser carries its own copy of the navigation test:
 * it is a different layer and must not import from the evaluation.)
 *
 * Guidelines §3 rule 4 in code.
 */

/** Sectioning elements that scope a `<header>`/`<footer>` to their own content. */
const SCOPING = "article, aside, main, nav, section";

/**
 * Is this `<header>`/`<footer>` the PAGE's, or a section's?
 *
 * HTML's accessibility mapping is explicit: `<header>` is `banner` and
 * `<footer>` is `contentinfo` **only** when they are not descendants of
 * `article`, `aside`, `main`, `nav` or `section`. Nested ones are just the head
 * and foot of the thing that contains them.
 *
 * Treating every `<header>` as chrome was wrong in a way that mattered. A forum
 * thread gives each post a `<header class="message-attribution">` carrying the
 * author and the timestamp, and a `<footer>` carrying the reactions — on the
 * corpus's forum page, 19 of 20 `<header>`/`<footer>` elements are per-post and
 * exactly one is the site masthead. Labelling all of them `chrome` deleted most
 * of the page's actual content from the scored set and then reported that the
 * parser had failed to reject it.
 */
export function isPageLevelLandmark(el: Element): boolean {
  const tag = el.tagName.toLowerCase();
  if (tag !== "header" && tag !== "footer") return true;
  return !el.parentElement?.closest(SCOPING);
}

/**
 * Is this navigation region about the document, or about the site?
 *
 * Guidelines §3 rule 4: navigation that takes you to another page of the site is
 * chrome wherever it sits; navigation within this document — a table of
 * contents, a section index — is `navigation`. The mechanical tie-break is where
 * the links point, and over this corpus the two groups do not overlap: tables of
 * contents run at 100% same-page links, site menus at 0–6%.
 */
export function isDocumentNavigation(nav: Element): boolean {
  const links = Array.from(nav.querySelectorAll("a[href]"));
  if (links.length < 2) return false;
  let fragments = 0;
  for (const a of links) {
    const href = a.getAttribute("href") ?? "";
    if (href.startsWith("#") && href.length > 1) fragments++;
  }
  return fragments / links.length >= 0.5;
}

/**
 * The site-chrome region containing this element, or null. Chrome is
 * subtractive: when this returns a region, the element is `chrome` whatever it
 * is in itself, and so is everything else inside that region.
 */
export function siteChromeRegion(el: Element): { region: Element; why: string } | null {
  const explicit = el.closest?.('[role="banner"], [role="contentinfo"]');
  if (explicit) {
    return { region: explicit, why: "explicit banner/contentinfo role" };
  }

  // Walk out through every enclosing header/footer: the nearest one may be a
  // post's own header while an outer one is the page masthead.
  let cursor: Element | null = el.closest?.("header, footer") ?? null;
  while (cursor) {
    if (isPageLevelLandmark(cursor)) {
      return {
        region: cursor,
        why: `page ${cursor.tagName.toLowerCase()}`,
      };
    }
    cursor = cursor.parentElement?.closest("header, footer") ?? null;
  }

  const nav = el.closest?.('nav, [role="navigation"]');
  if (nav && !isDocumentNavigation(nav)) {
    const links = nav.querySelectorAll("a[href]").length;
    return {
      region: nav,
      why: `site menu (${links} link(s), few or none same-page)`,
    };
  }
  return null;
}
