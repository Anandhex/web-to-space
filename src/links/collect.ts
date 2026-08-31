/**
 * links/collect.ts — walk a scene + plan and produce the page's references.
 *
 * The walk is the only place that knows how a link is bound to the page, and
 * it has to be a walk rather than a pass over `scene.primitives`, for two
 * reasons the codebase has already run into — the rooms view's own link
 * gathering hit both before this replaced it:
 *
 *  • An inline link HAS NO LAYOUT ENTRY. Pagination stamps the paragraph
 *    around it and the link is drawn as one of that paragraph's inline runs,
 *    so asking a link which page it is on only ever answers "none". Its page,
 *    and its height, are its nearest PLACED ancestor's — which is exactly the
 *    paragraph granularity §13C rule 3 settles for.
 *  • A walk visits in reading order. Iterating the primitive registry does
 *    not, and reading order is what orders bodies within a region (rule 6).
 */
import type { LayoutPlan } from "../layout/types";
import type { SemanticScene, Vec3, XRPrimitive } from "../mapper/types";
import { classifyLink, normaliseText, isDegenerateAnchor } from "./classify";
import { synthesiseIdentity } from "./identity";
import type { SpatialLink } from "./types";

/** Types that carry an href. XRGenericPanel is the mapper's "link card" form. */
function hrefOf(p: XRPrimitive): string | null {
  if (p.type === "XRLink") return p.href;
  if (p.type === "XRGenericPanel") return p.href ?? null;
  return null;
}

/**
 * Blocks whose text is worth quoting back as "the sentence it came from" (L3).
 * A section or a panel would quote the whole document, which is not a sentence.
 */
const SOURCE_TEXT_TYPES = new Set<string>([
  "XRParagraph",
  "XRListItem",
  "XRBlockQuote",
  "XRHeading",
  "XRTableCell",
]);

/** Longest source snippet kept. Enough for a sentence, not for a paragraph. */
const SOURCE_TEXT_MAX = 320;

interface CollectOptions {
  /** The document's own URL. Drives origin comparison and href resolution. */
  pageUrl?: string | null;
  /**
   * Restrict to references whose anchor sits on this page of the paginated
   * content panel. Omit for the whole document.
   */
  pageIndex?: number;
  /**
   * Drop duplicate destinations, keeping the first in reading order. On by
   * default: the same href appearing four times in a paragraph is one place,
   * and four bodies stacked at one height would spend the budget on nothing.
   */
  dedupe?: boolean;
}

/**
 * Every reference in the document, classified, in reading order.
 *
 * `pageIndex` is -1 for anchors outside the paginated panel (a top-level
 * navigation bar, a footer) — they are real references with a real region,
 * they simply do not belong to a page.
 */
export function collectSpatialLinks(
  scene: SemanticScene,
  plan: LayoutPlan,
  opts: CollectOptions = {},
): SpatialLink[] {
  const pageUrl = opts.pageUrl ?? null;
  const dedupe = opts.dedupe !== false;

  // ── Fragment targets: which `#name`s exist in this document ──
  //
  // Built from BOTH the primitive registry and the tree, because the engine
  // injects synthetic continuation primitives after pagination that the tree
  // walk alone would not see.
  const byDomId = new Map<string, XRPrimitive>();
  const consider = (p: XRPrimitive) => {
    if (p.domId && !byDomId.has(p.domId)) byDomId.set(p.domId, p);
  };
  for (const p of Object.values(scene.primitives)) consider(p);
  walk(scene.root, consider);

  // Which primitives came from a `navigation` landmark — see LinkContext.navIds.
  const navIds = new Set<string>();
  for (const [id, rec] of Object.entries(scene.diagnostics?.appliedRules ?? {}))
    if (rec.rule.startsWith("landmark:navigation")) navIds.add(id);

  const links: SpatialLink[] = [];
  let order = 0;

  const visit = (
    p: XRPrimitive,
    ancestors: XRPrimitive[],
    page: number,
    anchorId: string | null,
    anchorPos: Vec3 | null,
    sourceText: string | null,
  ): void => {
    const entry = plan.entries[p.id];
    // A suppressed landmark is not drawn, so its links are not on the page.
    if (entry?.suppressed) return;

    // Inherit-or-refine: an entry with a position replaces the binding point,
    // which is how an inline link ends up bound to its paragraph.
    const nextPage = entry?.pageIndex ?? page;
    const nextAnchorId = entry?.position ? p.id : anchorId;
    const nextAnchorPos = entry?.position ?? anchorPos;
    const own = SOURCE_TEXT_TYPES.has(p.type) ? blockText(p) : null;
    const nextSourceText = own ?? sourceText;

    const href = hrefOf(p);
    if (href !== null && href !== undefined) {
      const anchorText = anchorTextOf(p);
      const cls = classifyLink(href, anchorText, { ancestors, pageUrl, navIds });

      let targetId: string | undefined;
      let targetPage: number | undefined;
      let targetLabel: string | null = null;
      if (cls.fragment !== undefined) {
        const t = byDomId.get(cls.fragment);
        if (t) {
          targetId = t.id;
          targetLabel = normaliseText(t.label ?? t.content);
          const te = plan.entries[t.id];
          if (te?.pageIndex !== undefined) targetPage = te.pageIndex;
        }
      }

      const id = synthesiseIdentity({
        href,
        accessibleName: p.label,
        anchorText,
        pageUrl,
        targetLabel,
      });

      links.push({
        id: p.id,
        href,
        region: cls.region,
        locus: cls.locus,
        label: id.label,
        host: id.host,
        resolved: absolute(href, pageUrl),
        synthesised: id.synthesised,
        degenerate: isDegenerateAnchor(anchorText),
        citation: cls.citation,
        pageIndex: nextPage,
        anchorId: nextAnchorId,
        anchorPos: nextAnchorPos,
        order: order++,
        sameBlock: false, // filled in below, once every sibling is known
        occurrences: 0, // ─┬─ filled in below, once the whole walk is done
        pageSpread: 0, //  ─┘
        sourceText: nextSourceText,
        targetId,
        targetPage,
      });
      // A link's own children are its label runs, never further references.
      return;
    }

    const nextAncestors = [...ancestors, p];
    for (const c of p.children ?? [])
      visit(c, nextAncestors, nextPage, nextAnchorId, nextAnchorPos, nextSourceText);
  };

  visit(scene.root, [], -1, null, null, null);

  // ── sameBlock: the honest residue of alignment (§7) ──
  const perBlock = new Map<string, number>();
  for (const l of links) {
    if (!l.anchorId) continue;
    perBlock.set(l.anchorId, (perBlock.get(l.anchorId) ?? 0) + 1);
  }
  for (const l of links)
    l.sameBlock = l.anchorId ? (perBlock.get(l.anchorId) ?? 0) > 1 : false;

  // ── Destination weight: how hard this document leans on a place ──
  //
  // Counted over EVERY occurrence and stamped onto every one of them, before
  // the dedupe below throws the repeats away. The deduper is right for a door
  // budget — four mentions of one page in a paragraph are one door — but the
  // count it discards is the whole signal `links/neighbours.ts` ranks on, and
  // recovering it afterwards would mean walking the document twice.
  const weight = new Map<string, { n: number; pages: Set<number> }>();
  for (const l of links) {
    const key = destinationKey(l);
    const w = weight.get(key);
    if (w) {
      w.n++;
      w.pages.add(l.pageIndex);
    } else weight.set(key, { n: 1, pages: new Set([l.pageIndex]) });
  }
  for (const l of links) {
    const w = weight.get(destinationKey(l));
    l.occurrences = w?.n ?? 1;
    l.pageSpread = w?.pages.size ?? 1;
  }

  let out = links;
  if (dedupe) {
    const seen = new Set<string>();
    out = out.filter((l) => {
      const key = `${l.region} ${l.resolved}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
  if (opts.pageIndex !== undefined)
    out = out.filter((l) => l.pageIndex === opts.pageIndex);
  return out;
}

// ── helpers ──────────────────────────────────────────────────────────────

/**
 * The identity a destination is WEIGHED under: the resolved URL with its
 * fragment dropped, since `guide#intro` and `guide#api` are one place to go.
 *
 * Same-document references keep their fragment — there the fragment IS the
 * destination, and collapsing them would make every `#…` on the page one
 * enormously weighted link to the page itself.
 */
function destinationKey(l: SpatialLink): string {
  if (l.region === "arrangement") return `${l.region} ${l.resolved}`;
  const hash = l.resolved.indexOf("#");
  return `${l.region} ${hash === -1 ? l.resolved : l.resolved.slice(0, hash)}`;
}

function walk(p: XRPrimitive, fn: (p: XRPrimitive) => void): void {
  fn(p);
  for (const c of p.children ?? []) walk(c, fn);
}

function absolute(href: string, pageUrl: string | null): string {
  try {
    return new URL(href, pageUrl ?? undefined).href;
  } catch {
    return href;
  }
}

/**
 * The anchor's visible text. The mapper puts the accessible name in `label`
 * and the element's own text in `content`, and falls back to the literal
 * string "Link" when it has neither — which is a placeholder, not text, and
 * must not be allowed to look like a two-word name to the degeneracy test.
 */
function anchorTextOf(p: XRPrimitive): string {
  const content = normaliseText(p.content);
  if (content !== "") return content;
  const label = normaliseText(p.label);
  if (label === "Link") return "";
  if (label !== "") return label;
  // A link card's text lives in its children, not on the card itself.
  const parts: string[] = [];
  walk(p, (n) => {
    if (n === p) return;
    const t = normaliseText(n.content ?? n.label);
    if (t !== "") parts.push(t);
  });
  return normaliseText(parts.join(" "));
}

function blockText(p: XRPrimitive): string | null {
  const parts: string[] = [];
  walk(p, (n) => {
    const t = normaliseText(n.content);
    if (t !== "") parts.push(t);
  });
  const joined = normaliseText(parts.join(" "));
  if (joined === "") {
    const label = normaliseText(p.label);
    return label === "" ? null : label.slice(0, SOURCE_TEXT_MAX);
  }
  return joined.length > SOURCE_TEXT_MAX
    ? joined.slice(0, SOURCE_TEXT_MAX - 1) + "…"
    : joined;
}
