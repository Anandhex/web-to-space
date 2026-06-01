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
  labelledby: string | null;
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

function resolveNodeLabel(element: Element, doc?: Document): string | null {
  // 1. aria-labelledby — dereference to text content of referenced element(s)
  if (doc) {
    const labelledby = element.getAttribute("aria-labelledby")?.trim();
    if (labelledby) {
      const text = labelledby
        .split(/\s+/)
        .map((id) => doc.getElementById(id)?.textContent?.trim() ?? "")
        .filter(Boolean)
        .join(" ");
      if (text) return text;
    }
  }

  // 2. aria-label
  const ariaLabel = element.getAttribute("aria-label")?.trim() ?? "";
  if (ariaLabel) return ariaLabel;

  const tag = element.tagName.toLowerCase();

  // 3. img alt / src fallback
  if (tag === "img") {
    const alt = element.getAttribute("alt")?.trim() ?? "";
    if (alt) return alt;
    const src = element.getAttribute("src")?.trim() ?? "";
    if (src) {
      const fallback = src.split("/").pop() ?? src;
      return fallback;
    }
  }

  // 4. <label for="id"> association for form controls
  if (doc && (tag === "input" || tag === "textarea" || tag === "select")) {
    const id = element.getAttribute("id");
    if (id) {
      const labelEl = doc.querySelector(`label[for="${CSS.escape(id)}"]`);
      const labelText = labelEl?.textContent?.trim();
      if (labelText) return labelText;
    }
    // 5. Wrapping <label>
    const wrappingLabel = element.closest("label");
    if (wrappingLabel) {
      // Clone to avoid including the input's own value in the label text
      const clone = wrappingLabel.cloneNode(true) as Element;
      clone.querySelector("input,textarea,select")?.remove();
      const labelText = clone.textContent?.trim();
      if (labelText) return labelText;
    }
  }

  // For leaf-like elements (no element children) use full textContent.
  // For container elements use only direct text nodes to avoid subtree bleed.
  const hasElementChildren = Array.from(element.children).some(
    (c) =>
      !SKIP_TAGS.has(c.tagName.toLowerCase()) &&
      !WRAPPER_TAGS.has(c.tagName.toLowerCase()),
  );

  if (!hasElementChildren) {
    const text = element.textContent?.trim() ?? "";
    return text ? text : null;
  }

  const direct = directTextContent(element);
  return direct ? direct : null;
}

function resolveSectionLabel(fallbackLabel: string): string {
  return fallbackLabel;
}

function readNodeAttributes(element: Element): IRNodeAttributes {
  return {
    expanded: element.getAttribute("aria-expanded") ?? null,
    required: element.getAttribute("aria-required") ?? null,
    controls: element.getAttribute("aria-controls") ?? null,
    describedby: element.getAttribute("aria-describedby") ?? null,
    labelledby: element.getAttribute("aria-labelledby") ?? null,
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

// Maps ARIA role= attribute values to IR roles.
const ARIA_ROLE_MAP: Partial<Record<string, IRRole>> = {
  main: "main",
  navigation: "navigation",
  banner: "banner",
  contentinfo: "contentinfo",
  complementary: "complementary",
  search: "search",
  form: "form",
  region: "region",
  heading: "heading",
  list: "list",
  listitem: "listitem",
  link: "link",
  button: "button",
  img: "img",
  figure: "figure",
  separator: "separator",
  table: "table",
  row: "row",
  cell: "cell",
  columnheader: "columnheader",
  rowheader: "rowheader",
  textbox: "textbox",
  searchbox: "textbox",
  checkbox: "checkbox",
  radio: "radio",
  combobox: "combobox",
  slider: "slider",
  spinbutton: "spinbutton",
  switch: "switch",
  group: "group",
  // common widget aliases
  menuitem: "button",
  menuitemcheckbox: "checkbox",
  menuitemradio: "radio",
  option: "listitem",
  tab: "button",
  treeitem: "listitem",
};

/**
 * Resolves an element's IR role by first checking for an explicit ARIA role=
 * attribute (Layer 1 — explicit), then falling back to structural tag
 * inference (Layer 2 — structural).  Returns the resolved role, level, and
 * the source layer that produced it.
 */
function resolveRoleFromElement(element: Element): {
  role: IRRole;
  level: number | null;
  source: Extract<IRSource, "explicit" | "structural">;
} {
  // ── Layer 1: explicit ARIA role= always wins ─────────────────────────────
  const ariaRole = element.getAttribute("role")?.trim().toLowerCase();
  if (ariaRole && ARIA_ROLE_MAP[ariaRole] !== undefined) {
    const level =
      ariaRole === "heading"
        ? Number.parseInt(element.getAttribute("aria-level") ?? "2", 10) || 2
        : null;
    return { role: ARIA_ROLE_MAP[ariaRole]!, level, source: "explicit" };
  }

  // ── Layer 2: structural inference from HTML tag ──────────────────────────
  const tag = element.tagName.toLowerCase();
  return { ...resolveRoleFromTag(tag, element), source: "structural" };
}

function resolveRoleFromTag(
  tag: string,
  element?: Element,
): { role: IRRole; level: number | null } {
  // Landmark / sectioning elements
  if (tag === "main") return { role: "main", level: null };
  if (tag === "header") return { role: "banner", level: null };
  if (tag === "footer") return { role: "contentinfo", level: null };
  if (tag === "aside") return { role: "complementary", level: null };
  if (tag === "nav") return { role: "navigation", level: null };
  if (tag === "form") return { role: "form", level: null };
  if (tag === "section") return { role: "region", level: null };

  if (tag === "p") return { role: "paragraph", level: null };
  if (tag === "article") return { role: "group", level: null };
  if (tag === "img") return { role: "img", level: null };
  if (tag === "ul" || tag === "ol") return { role: "list", level: null };
  if (tag === "li") return { role: "listitem", level: null };
  if (tag === "a") return { role: "link", level: null };

  if (tag === "button") return { role: "button", level: null };

  if (tag === "input") {
    const type = element?.getAttribute("type")?.toLowerCase() ?? "text";
    if (type === "checkbox") return { role: "checkbox", level: null };
    if (type === "radio") return { role: "radio", level: null };
    if (type === "range") return { role: "slider", level: null };
    if (type === "number") return { role: "spinbutton", level: null };
    // text, email, password, search, tel, url, date, time, hidden, submit, etc.
    return { role: "textbox", level: null };
  }

  if (tag === "textarea") return { role: "textbox", level: null };
  if (tag === "select") return { role: "combobox", level: null };

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

// Tags that are HTML5 landmark elements and should be treated as landmark
// nodes in the IR (same promotion path as <section>).
const LANDMARK_TAGS = new Set(["main", "header", "footer", "aside", "nav"]);

function buildDescendantTree(
  element: Element,
  sectionIndex: number,
  sectionScopeId: string,
  parentId: string,
  landmarkParentId: string,
  nodes: Record<string, IRNode>,
  counters: TreeCounters,
  landmarkRecords: LandmarkRecord[],
  doc?: Document,
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

    // ── landmark elements and <section> — promoted to landmark nodes ──────
    // Covers <section>, <main>, <header>, <footer>, <aside>, <nav>, and any
    // element whose explicit role= maps to a landmark IR role.
    const isLandmarkTag = tag === "section" || LANDMARK_TAGS.has(tag);
    const explicitLandmarkRole =
      !isLandmarkTag && child.hasAttribute("role")
        ? (() => {
            const r = child.getAttribute("role")!.trim().toLowerCase();
            const mapped = ARIA_ROLE_MAP[r];
            return mapped &&
              [
                "main",
                "banner",
                "contentinfo",
                "complementary",
                "navigation",
                "search",
                "form",
                "region",
              ].includes(mapped)
              ? mapped
              : null;
          })()
        : null;

    if (isLandmarkTag || explicitLandmarkRole !== null) {
      const landmarkId = `${sectionScopeId}-section-${counters.section++}`;
      const { role, level, source } = resolveRoleFromElement(child);
      const landmarkLabel =
        resolveNodeLabel(child, doc) ?? resolveSectionLabel(landmarkId);

      landmarkRecords.push({
        id: landmarkId,
        label: landmarkLabel,
        parentId: landmarkParentId,
      });

      const nestedChildIds = buildDescendantTree(
        child,
        sectionIndex,
        landmarkId,
        landmarkId,
        landmarkId,
        nodes,
        { node: 0, section: 0 },
        landmarkRecords,
        doc,
      );

      nodes[landmarkId] = {
        id: landmarkId,
        role,
        level,
        label: landmarkLabel,
        unlabelledYet: landmarkLabel === null,
        landmark: true,
        source,
        parent: parentId,
        children: nestedChildIds,
        attributes: mergeAttributes(readNodeAttributes(child), liftedAttrs),
      };

      childIds.push(landmarkId);
      continue;
    }

    // ── regular node ─────────────────────────────────────────────────────
    const id = `${sectionScopeId}-node-${counters.node++}`;
    const label = resolveNodeLabel(child, doc);
    const { role, level, source } = resolveRoleFromElement(child);

    const nestedChildIds = buildDescendantTree(
      child,
      sectionIndex,
      sectionScopeId,
      id,
      landmarkParentId,
      nodes,
      counters,
      landmarkRecords,
      doc,
    );

    nodes[id] = {
      id,
      role,
      level,
      label,
      unlabelledYet: label === null,
      landmark: false,
      source,
      parent: parentId,
      children: nestedChildIds,
      attributes: mergeAttributes(readNodeAttributes(child), liftedAttrs),
    };

    childIds.push(id);
  }

  return childIds;
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

  const effectiveSections = [parsedDoc.body as HTMLElement];

  effectiveSections.forEach((section, index) => {
    const sectionId = `section-${index}`;
    const sectionCounters = { node: 0, section: 0 };
    const sectionLabel = resolveSectionLabel(sectionId);

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
    children: rootChildIds,
    attributes: {
      expanded: null,
      required: null,
      controls: null,
      describedby: null,
      labelledby: null,
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
      labelledby: null,
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
      labelledby: null,
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
