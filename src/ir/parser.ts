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
]);

function resolveNodeLabel(element: Element): string | null {
  const ariaLabel = element.getAttribute("aria-label")?.trim() ?? "";
  if (ariaLabel) return ariaLabel.slice(0, LABEL_MAX_CHARS);

  if (element.tagName.toLowerCase() === "img") {
    const alt = element.getAttribute("alt")?.trim() ?? "";
    if (alt) return alt.slice(0, LABEL_MAX_CHARS);

    const src = element.getAttribute("src")?.trim() ?? "";
    if (src) {
      const fallback = src.split("/").pop() ?? src;
      return fallback.slice(0, LABEL_MAX_CHARS);
    }
  }

  const text = element.textContent?.trim() ?? "";
  return text ? text.slice(0, LABEL_MAX_CHARS) : null;
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
  sectionLabelHeading: HTMLElement | null,
  nodes: Record<string, IRNode>,
  counters: TreeCounters,
  landmarkRecords: LandmarkRecord[],
): string[] {
  const childIds: string[] = [];

  for (const child of Array.from(element.children)) {
    if (sectionLabelHeading && child === sectionLabelHeading) continue;

    const tag = child.tagName.toLowerCase();
    if (SKIP_TAGS.has(tag)) continue;

    if (tag === "section") {
      const sectionId = `${sectionScopeId}-section-${counters.section++}`;
      const childLabelHeading = findSectionLabelHeading(child);
      const sectionLabel = resolveSectionLabel(
        child,
        sectionId,
        childLabelHeading,
      );
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
        childLabelHeading,
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
        attributes: readNodeAttributes(child),
      };

      childIds.push(sectionId);
      continue;
    }

    const id = `${sectionScopeId}-node-${counters.node++}`;
    const label = resolveNodeLabel(child);
    const resolved = resolveRoleFromTag(tag);
    const nestedChildIds = buildDescendantTree(
      child,
      sectionIndex,
      sectionScopeId,
      id,
      landmarkParentId,
      sectionLabelHeading,
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
      attributes: readNodeAttributes(child),
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
    for (const child of node.children) {
      walk(child);
    }
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

  sections.forEach((section, index) => {
    const sectionId = `section-${index}`;
    const sectionCounters = { node: 0, section: 0 };
    const sectionLabelHeading = findSectionLabelHeading(section);
    const sectionLabel = resolveSectionLabel(
      section,
      sectionId,
      sectionLabelHeading,
    );
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
      sectionLabelHeading,
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

  sections.forEach((section, index) => {
    const sectionId = `section-${index}`;
    const itemId = `toc-item-${index}`;
    const sectionLabel = resolveSectionLabel(section, sectionId);

    tocChildren.push(itemId);
    landmarkRecords.push({
      id: itemId,
      label: sectionLabel,
      parentId: "toc",
    });

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
