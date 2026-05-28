const LABEL_MAX_CHARS = 280;

export type IRRole =
  | "main"
  | "navigation"
  | "banner"
  | "contentinfo"
  | "complementary"
  | "search"
  | "form"
  | "region"
  | "heading"
  | "paragraph"
  | "list"
  | "listitem"
  | "link"
  | "button"
  | "img"
  | "figure"
  | "blockquote"
  | "separator"
  | "code"
  | "table"
  | "row"
  | "cell"
  | "columnheader"
  | "rowheader"
  | "textbox"
  | "checkbox"
  | "radio"
  | "combobox"
  | "slider"
  | "spinbutton"
  | "switch"
  | "group"
  | "generic";

export type IRSource =
  | "explicit"
  | "structural"
  | "ai"
  | "ai-timeout"
  | "generic";

export interface IRNodeAttributes {
  expanded: string | null;
  required: string | null;
  controls: string | null;
  describedby: string | null;
  haspopup: string | null;
  alt: string | null;
  src: string | null;
  href: string | null;
}

export interface IRNode {
  id: string;
  role: IRRole;
  level: number | null;
  label: string | null;
  unlabelledYet: boolean;
  landmark: boolean;
  source: IRSource;
  parent: string | null;
  children: string[];
  attributes: IRNodeAttributes;
}

export interface IRMeta {
  url: string;
  title: string | null;
  lang: string | null;
  parsedAt: string;
}

export interface IRFallbackEntry {
  id: string;
  tag: string;
  reason: "ai-timeout";
}

export interface LandmarkTOCNode {
  id: string;
  label: string | null;
  children: LandmarkTOCNode[];
}

export interface PageIR {
  meta: IRMeta;
  landmarks: LandmarkTOCNode;
  root: string;
  fallbackLog: IRFallbackEntry[];
  nodes: Record<string, IRNode>;
}

const SKIP_TAGS = new Set([
  "script",
  "style",
  "noscript",
  "meta",
  "link",
  "head",
  // void/presentational inline elements — content lives in surrounding text nodes
  "br",
  "wbr",
  "svg",
  "canvas",
  "template",
]);

// picture is a pure media wrapper — always pierce it to reach the img inside
const WRAPPER_TAGS = new Set(["div", "span", "picture"]);

/**
 * Returns true if this element is a semantically inert wrapper that can be
 * skipped entirely — i.e. it's a div/span with no ARIA, no id, no label of
 * its own.  Does NOT look at child count; that decision is made at the call
 * site after piercing the chain.
 */
function isInertWrapper(element: Element): boolean {
  const tag = element.tagName.toLowerCase();
  if (!WRAPPER_TAGS.has(tag)) return false;
  if (element.hasAttribute("role")) return false;
  if (element.hasAttribute("aria-label")) return false;
  if (element.hasAttribute("id")) return false;

  // If the wrapper carries any ARIA attribute that makes it meaningful,
  // keep it so its attributes survive into the IR.
  const ariaAttrs = [
    "aria-expanded",
    "aria-required",
    "aria-controls",
    "aria-describedby",
    "aria-labelledby",
    "aria-haspopup",
  ];
  for (const attr of ariaAttrs) {
    if (element.hasAttribute(attr)) return false;
  }

  return true;
}

/**
 * Pierces any chain of inert wrappers and returns the first element that is
 * either non-inert or has more than one meaningful child (so it can't be
 * fully elided).  Lifts the id/ARIA attributes from every wrapper it passes
 * through onto a synthetic attribute bag — so references to those wrappers'
 * ids are preserved on the surviving ancestor node.
 *
 * Returns { element, liftedAttrs } where liftedAttrs should be merged over
 * the element's own attributes when building the IR node.
 */
function pierceWrapperChain(element: Element): {
  element: Element;
  liftedAttrs: Partial<IRNodeAttributes>;
} {
  const liftedAttrs: Partial<IRNodeAttributes> = {};

  let current = element;

  while (true) {
    const tag = current.tagName.toLowerCase();
    if (!WRAPPER_TAGS.has(tag)) break;

    // If this wrapper carries semantics, stop — it becomes a real node.
    if (
      current.hasAttribute("role") ||
      current.hasAttribute("aria-label") ||
      current.hasAttribute("id")
    ) {
      // Lift its id for downstream ARIA referencing — the node at this level
      // will capture it via readNodeAttributes anyway, so just stop.
      break;
    }

    // Collect any ARIA on this wrapper before deciding to pierce it.
    const snap = readNodeAttributes(current);
    for (const key of Object.keys(snap) as (keyof IRNodeAttributes)[]) {
      if (snap[key] !== null && liftedAttrs[key] == null) {
        liftedAttrs[key] = snap[key];
      }
    }

    // Count non-skip element children.
    const meaningfulChildren = Array.from(current.children).filter(
      (c) => !SKIP_TAGS.has(c.tagName.toLowerCase()),
    );

    if (meaningfulChildren.length === 0) {
      // No element children — wrapper contains only text nodes.
      // Stop here; the caller will emit this as a paragraph/generic node
      // so the text content is preserved.
      return { element: current, liftedAttrs };
    }

    if (meaningfulChildren.length > 1) {
      // Multiple real children: can't pierce further — the wrapper is elided
      // and its children are promoted directly to the parent.
      return { element: current, liftedAttrs };
    }

    // Exactly one real child: descend.
    current = meaningfulChildren[0];
  }

  return { element: current, liftedAttrs };
}

function directTextContent(element: Element): string {
  let text = "";
  for (const node of Array.from(element.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE) {
      text += node.textContent ?? "";
    }
  }
  return text.trim();
}

function resolveNodeLabel(element: Element): string | null {
  const ariaLabel = element.getAttribute("aria-label")?.trim() ?? "";
  if (ariaLabel) return ariaLabel.slice(0, LABEL_MAX_CHARS);

  const tag = element.tagName.toLowerCase();

  if (tag === "img") {
    const alt = element.getAttribute("alt")?.trim() ?? "";
    if (alt) return alt.slice(0, LABEL_MAX_CHARS);
    const src = element.getAttribute("src")?.trim() ?? "";
    if (src) {
      const fallback = src.split("/").pop() ?? src;
      return fallback.slice(0, LABEL_MAX_CHARS);
    }
  }

  // For leaf-like elements (no element children) use full textContent.
  // For container elements use only direct text nodes to avoid subtree bleed —
  // children will produce their own labelled IR nodes.
  const hasElementChildren = Array.from(element.children).some(
    (c) =>
      !SKIP_TAGS.has(c.tagName.toLowerCase()) &&
      !WRAPPER_TAGS.has(c.tagName.toLowerCase()),
  );

  if (!hasElementChildren) {
    const text = element.textContent?.trim() ?? "";
    return text ? text.slice(0, LABEL_MAX_CHARS) : null;
  }

  // Container: only harvest text that lives directly on this element,
  // not text belonging to children.
  const direct = directTextContent(element);
  return direct ? direct.slice(0, LABEL_MAX_CHARS) : null;
}

function findSectionLabelHeading(section: Element): HTMLElement | null {
  for (let level = 1; level <= 6; level++) {
    const heading = section.querySelector(`h${level}`) as HTMLElement | null;
    const text = heading?.textContent?.trim() ?? "";
    if (text) return heading;
  }
  return null;
}

function resolveSectionLabel(
  section: Element,
  fallbackLabel: string,
  heading: HTMLElement | null = findSectionLabelHeading(section),
): string {
  const text = heading?.textContent?.trim() ?? "";
  if (text) return text.slice(0, LABEL_MAX_CHARS);
  return fallbackLabel;
}

function readNodeAttributes(element: Element): IRNodeAttributes {
  return {
    expanded: element.getAttribute("aria-expanded") ?? null,
    required: element.getAttribute("aria-required") ?? null,
    controls: element.getAttribute("aria-controls") ?? null,
    describedby: element.getAttribute("aria-describedby") ?? null,
    haspopup: element.getAttribute("aria-haspopup") ?? null,
    alt: element.getAttribute("alt") ?? null,
    src: element.getAttribute("src") ?? null,
    href: element.getAttribute("href") ?? null,
  };
}

function mergeAttributes(
  base: IRNodeAttributes,
  lifted: Partial<IRNodeAttributes>,
): IRNodeAttributes {
  const result = { ...base };
  for (const key of Object.keys(lifted) as (keyof IRNodeAttributes)[]) {
    if (lifted[key] !== null && result[key] === null) {
      result[key] = lifted[key]!;
    }
  }
  return result;
}

type TreeCounters = {
  node: number;
  section: number;
};

type LandmarkRecord = {
  id: string;
  label: string;
  parentId: string;
};

function resolveRoleFromTag(tag: string): {
  role: IRRole;
  level: number | null;
} {
  if (tag === "p") return { role: "paragraph", level: null };
  if (tag === "article") return { role: "group", level: null };
  if (tag === "img") return { role: "img", level: null };
  if (tag === "ul" || tag === "ol") return { role: "list", level: null };
  if (tag === "li") return { role: "listitem", level: null };
  if (tag === "a") return { role: "link", level: null };

  if (tag === "button") return { role: "button", level: null };
  if (tag === "input") return { role: "textbox", level: null };
  if (tag === "textarea") return { role: "textbox", level: null };
  if (tag === "select") return { role: "combobox", level: null };

  if (tag === "nav") return { role: "navigation", level: null };
  if (tag === "form") return { role: "form", level: null };

  if (tag === "figure" || tag === "figcaption")
    return { role: "figure", level: null };
  if (tag === "blockquote") return { role: "blockquote", level: null };

  if (tag === "code" || tag === "pre") return { role: "code", level: null };
  if (tag === "hr") return { role: "separator", level: null };

  if (tag === "table") return { role: "table", level: null };
  if (tag === "tr") return { role: "row", level: null };
  if (tag === "td") return { role: "cell", level: null };
  if (tag === "th") return { role: "columnheader", level: null };
  if (tag === "thead" || tag === "tbody" || tag === "tfoot")
    return { role: "group", level: null };

  if (tag.length === 2 && tag[0] === "h") {
    const parsed = Number.parseInt(tag[1], 10);
    if (!Number.isNaN(parsed) && parsed >= 1 && parsed <= 6) {
      return { role: "heading", level: parsed };
    }
  }

  return { role: "generic", level: null };
}

function buildDescendantTree(
  element: Element,
  sectionIndex: number,
  sectionScopeId: string,
  parentId: string,
  landmarkParentId: string,
  nodes: Record<string, IRNode>,
  counters: TreeCounters,
  landmarkRecords: LandmarkRecord[],
): string[] {
  const childIds: string[] = [];

  for (const rawChild of Array.from(element.children)) {
    const rawTag = rawChild.tagName.toLowerCase();
    if (SKIP_TAGS.has(rawTag)) continue;

    // ── pierce inert wrapper chains ──────────────────────────────────────
    // For a pure single-child inert chain (div>div>div>p), pierceWrapperChain
    // returns the real element at the bottom.
    // For a multi-child inert wrapper (div>p~p), it returns the wrapper
    // itself with liftedAttrs, and we iterate its children directly below.
    const { element: child, liftedAttrs } = isInertWrapper(rawChild)
      ? pierceWrapperChain(rawChild)
      : { element: rawChild, liftedAttrs: {} };

    const tag = child.tagName.toLowerCase();
    if (SKIP_TAGS.has(tag)) continue;

    // ── multi-child or text-only inert wrapper ───────────────────────────
    // pierceWrapperChain stopped because the wrapper has >1 element children
    // (promote them flat) or 0 element children (wrapper holds only text —
    // emit it as a paragraph so the content isn't silently dropped).
    if (isInertWrapper(child)) {
      const elementChildren = Array.from(child.children).filter(
        (c) => !SKIP_TAGS.has(c.tagName.toLowerCase()),
      );

      if (elementChildren.length === 0) {
        // Text-only wrapper: emit as a paragraph node.
        const text = child.textContent?.trim() ?? "";
        if (text) {
          const id = `${sectionScopeId}-node-${counters.node++}`;
          nodes[id] = {
            id,
            role: "paragraph",
            level: null,
            label: text.slice(0, LABEL_MAX_CHARS),
            unlabelledYet: false,
            landmark: false,
            source: "structural",
            parent: parentId,
            children: [],
            attributes: mergeAttributes(readNodeAttributes(child), liftedAttrs),
          };
          childIds.push(id);
        }
      } else {
        // Multi-child inert wrapper: promote children directly.
        const promotedIds = buildDescendantTree(
          child,
          sectionIndex,
          sectionScopeId,
          parentId,
          landmarkParentId,
          nodes,
          counters,
          landmarkRecords,
        );
        childIds.push(...promotedIds);
      }
      continue;
    }

    // ── nested <section> ─────────────────────────────────────────────────
    if (tag === "section") {
      const sectionId = `${sectionScopeId}-section-${counters.section++}`;
      const sectionLabel = resolveSectionLabel(child, sectionId);
      landmarkRecords.push({
        id: sectionId,
        label: sectionLabel,
        parentId: landmarkParentId,
      });

      const nestedChildIds = buildDescendantTree(
        child,
        sectionIndex,
        sectionId,
        sectionId,
        sectionId,
        nodes,
        { node: 0, section: 0 },
        landmarkRecords,
      );

      nodes[sectionId] = {
        id: sectionId,
        role: "region",
        level: null,
        label: sectionLabel,
        unlabelledYet: false,
        landmark: true,
        source: "structural",
        parent: parentId,
        children: nestedChildIds,
        attributes: mergeAttributes(readNodeAttributes(child), liftedAttrs),
      };

      childIds.push(sectionId);
      continue;
    }

    // ── regular node ─────────────────────────────────────────────────────
    const id = `${sectionScopeId}-node-${counters.node++}`;
    const label = resolveNodeLabel(child);
    const resolved = resolveRoleFromTag(tag);

    const nestedChildIds = buildDescendantTree(
      child,
      sectionIndex,
      sectionScopeId,
      id,
      landmarkParentId,
      nodes,
      counters,
      landmarkRecords,
    );

    nodes[id] = {
      id,
      role: resolved.role,
      level: resolved.level,
      label,
      unlabelledYet: label === null,
      landmark: false,
      source: "structural",
      parent: parentId,
      children: nestedChildIds,
      attributes: mergeAttributes(readNodeAttributes(child), liftedAttrs),
    };

    childIds.push(id);
  }

  return childIds;
}

function getTopLevelSections(parsedDoc: Document): HTMLElement[] {
  return Array.from(parsedDoc.body.querySelectorAll("section")).filter(
    (section) => section.parentElement?.closest("section") === null,
  ) as HTMLElement[];
}

function buildLandmarkTree(
  rootLabel: string | null,
  records: LandmarkRecord[],
): LandmarkTOCNode {
  const childrenByParent = new Map<string, LandmarkRecord[]>();

  for (const record of records) {
    const siblings = childrenByParent.get(record.parentId);
    if (siblings) siblings.push(record);
    else childrenByParent.set(record.parentId, [record]);
  }

  const buildChildren = (parentId: string): LandmarkTOCNode[] => {
    const recordsForParent = childrenByParent.get(parentId) ?? [];
    return recordsForParent.map((record) => ({
      id: record.id,
      label: record.label,
      children: buildChildren(record.id),
    }));
  };

  return {
    id: "landmarks",
    label: rootLabel ?? "main",
    children: buildChildren("landmarks"),
  };
}

export function collectLandmarkIds(tree: LandmarkTOCNode): string[] {
  const ids: string[] = [];
  const walk = (node: LandmarkTOCNode): void => {
    ids.push(node.id);
    for (const child of node.children) walk(child);
  };
  walk(tree);
  return ids;
}

export const parsePageToIR = async (
  htmlString: string,
  url: string,
): Promise<PageIR> => {
  const parser = new DOMParser();
  const parsedDoc = parser.parseFromString(htmlString, "text/html");

  const nodes: Record<string, IRNode> = {};
  const fallbackLog: IRFallbackEntry[] = [];
  const rootChildIds: string[] = [];
  const landmarkRecords: LandmarkRecord[] = [];
  const tocChildren: string[] = [];

  const sections = getTopLevelSections(parsedDoc);
  const effectiveSections = [parsedDoc.body as HTMLElement];

  effectiveSections.forEach((section, index) => {
    const sectionId = `section-${index}`;
    const sectionCounters = { node: 0, section: 0 };
    const sectionLabel = resolveSectionLabel(section, sectionId);

    landmarkRecords.push({
      id: sectionId,
      label: sectionLabel,
      parentId: "main",
    });

    const childIds = buildDescendantTree(
      section,
      index,
      sectionId,
      sectionId,
      sectionId,
      nodes,
      sectionCounters,
      landmarkRecords,
    );

    nodes[sectionId] = {
      id: sectionId,
      role: "region",
      level: null,
      label: sectionLabel,
      unlabelledYet: false,
      landmark: true,
      source: "structural",
      parent: "main",
      children: childIds,
      attributes: readNodeAttributes(section),
    };

    rootChildIds.push(sectionId);
  });

  effectiveSections.forEach((section, index) => {
    const sectionId = `section-${index}`;
    const itemId = `toc-item-${index}`;
    const sectionLabel = resolveSectionLabel(section, sectionId);

    tocChildren.push(itemId);
    landmarkRecords.push({ id: itemId, label: sectionLabel, parentId: "toc" });

    nodes[itemId] = {
      id: itemId,
      role: "link",
      level: null,
      label: sectionLabel,
      unlabelledYet: false,
      landmark: false,
      source: "structural",
      parent: "toc",
      children: [],
      attributes: {
        expanded: null,
        required: null,
        controls: sectionId,
        describedby: null,
        haspopup: null,
        alt: null,
        src: null,
        href: null,
      },
    };
  });

  const parsedTitle = parsedDoc.title?.trim() || null;
  landmarkRecords.push({
    id: "toc",
    label: "Table of contents",
    parentId: "landmarks",
  });
  landmarkRecords.push({
    id: "main",
    label: parsedTitle ?? "main",
    parentId: "landmarks",
  });

  const landmarks = buildLandmarkTree(parsedTitle, landmarkRecords);

  nodes.toc = {
    id: "toc",
    role: "navigation",
    level: null,
    label: "Table of contents",
    unlabelledYet: false,
    landmark: true,
    source: "structural",
    parent: "landmarks",
    children: tocChildren,
    attributes: {
      expanded: null,
      required: null,
      controls: null,
      describedby: null,
      haspopup: null,
      alt: null,
      src: null,
      href: null,
    },
  };

  nodes.main = {
    id: "main",
    role: "main",
    level: null,
    label: parsedTitle ?? "main",
    unlabelledYet: parsedTitle === null,
    landmark: true,
    source: "structural",
    parent: "landmarks",
    children: rootChildIds,
    attributes: {
      expanded: null,
      required: null,
      controls: null,
      describedby: null,
      haspopup: null,
      alt: null,
      src: null,
      href: null,
    },
  };

  nodes.body = {
    id: "body",
    role: "generic",
    level: null,
    label: parsedTitle,
    unlabelledYet: parsedTitle === null,
    landmark: false,
    source: "structural",
    parent: null,
    children: ["main"],
    attributes: {
      expanded: null,
      required: null,
      controls: null,
      describedby: null,
      haspopup: null,
      alt: null,
      src: null,
      href: null,
    },
  };

  return {
    meta: {
      url,
      title: parsedTitle,
      lang: parsedDoc.documentElement.getAttribute("lang") || null,
      parsedAt: new Date().toISOString(),
    },
    landmarks,
    root: "body",
    fallbackLog,
    nodes,
  };
};
