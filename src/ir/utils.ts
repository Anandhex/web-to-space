import { SKIP_TAGS, LANDMARK_ROLES, INTERACTIVE_ROLES } from "./defaults";
import type {
  IRNodeState,
  IRNodeAttributes,
  IRRole,
  IRNodeRelations,
  IRSource,
  ParserConfig,
  IRNode,
  ParseContext,
  BuildContext,
} from "./types";

export function getValidChildren(
  element: Element,
  skipTags: Set<string>,
): Element[] {
  return Array.from(element.children).filter(
    (c) => !skipTags.has(c.tagName.toLowerCase()),
  );
}

export function createBaseNode(
  id: string,
  role: IRRole,
  parentId: string | null,
  ctx: BuildContext,
  overrides: Partial<IRNode> = {},
): IRNode {
  const source = overrides.source || "structural";
  return {
    id,
    role,
    level: overrides.level ?? null,
    label: overrides.label ?? null,
    content: overrides.content ?? null,
    unlabelledYet: overrides.label === undefined || overrides.label === null,
    landmark: overrides.landmark ?? false,
    source,
    confidence: overrides.confidence ?? confidenceForSource(source, ctx.config),
    readingIndex: overrides.readingIndex ?? ctx.counters.reading++,
    readingDepth: overrides.readingDepth ?? 0,
    parent: parentId,
    children: overrides.children ?? [],
    relations: overrides.relations ?? createEmptyRelations(),
    state: overrides.state ?? createEmptyState(),
    attributes: overrides.attributes ?? createEmptyAttributes(),
    ...overrides,
  };
}

export function collectSiblingRun(
  siblings: Element[],
  startIndex: number,
  ctx: BuildContext,
  peelWrapper: (el: Element, ctx: BuildContext) => { element: Element },
  predicate: (el: Element) => boolean,
): { run: Element[]; endIndex: number } {
  const run: Element[] = [];
  let scan = startIndex;

  while (scan < siblings.length) {
    const candidate = peelWrapper(siblings[scan], ctx).element;
    if (!predicate(candidate)) break;
    run.push(candidate);
    scan += 1;
  }

  return { run, endIndex: scan };
}

export function readNodeState(element: Element): IRNodeState {
  return {
    expanded: element.getAttribute("aria-expanded") ?? null,
    checked: element.getAttribute("aria-checked") ?? null,
    selected: element.getAttribute("aria-selected") ?? null,
    disabled:
      element.getAttribute("aria-disabled") ??
      (element.hasAttribute("disabled") ? "true" : null),
    pressed: element.getAttribute("aria-pressed") ?? null,
    current: element.getAttribute("aria-current") ?? null,
    hidden:
      element.getAttribute("aria-hidden") ??
      (element.hasAttribute("hidden") ? "true" : null),
    busy: element.getAttribute("aria-busy") ?? null,
    required: element.getAttribute("aria-required") ?? null,
    live: element.getAttribute("aria-live") ?? null,
    invalid: element.getAttribute("aria-invalid") ?? null,
    readonly: element.getAttribute("aria-readonly") ?? null,
    modal: element.getAttribute("aria-modal") ?? null,
    multiselectable: element.getAttribute("aria-multiselectable") ?? null,
    orientation: element.getAttribute("aria-orientation") ?? null,
    valueNow: element.getAttribute("aria-valuenow") ?? null,
    valueMin: element.getAttribute("aria-valuemin") ?? null,
    valueMax: element.getAttribute("aria-valuemax") ?? null,
  };
}

export function readNodeAttributes(
  element: Element,
  context?: ParseContext,
): IRNodeAttributes {
  const resolveUrl = (url: string | null) => {
    if (!url) return null;
    if (!context?.sourceUrl) return url;
    return new URL(url, context.sourceUrl).href;
  };

  return {
    expanded: element.getAttribute("aria-expanded") ?? null,
    checked: element.getAttribute("aria-checked") ?? null,
    selected: element.getAttribute("aria-selected") ?? null,
    disabled:
      element.getAttribute("aria-disabled") ??
      (element.hasAttribute("disabled") ? "true" : null),
    pressed: element.getAttribute("aria-pressed") ?? null,
    current: element.getAttribute("aria-current") ?? null,
    hidden:
      element.getAttribute("aria-hidden") ??
      (element.hasAttribute("hidden") ? "true" : null),
    busy: element.getAttribute("aria-busy") ?? null,
    required: element.getAttribute("aria-required") ?? null,
    controls: element.getAttribute("aria-controls") ?? null,
    describedby: element.getAttribute("aria-describedby") ?? null,
    labelledby: element.getAttribute("aria-labelledby") ?? null,
    owns: element.getAttribute("aria-owns") ?? null,
    details: element.getAttribute("aria-details") ?? null,
    errormessage: element.getAttribute("aria-errormessage") ?? null,
    flowto: element.getAttribute("aria-flowto") ?? null,
    haspopup: element.getAttribute("aria-haspopup") ?? null,
    alt: element.getAttribute("alt") ?? null,
    src: resolveUrl(element.getAttribute("src")),
    href: element.getAttribute("href"),
    live: element.getAttribute("aria-live") ?? null,
    rowspan: element.getAttribute("rowspan") ?? null,
    colspan: element.getAttribute("colspan") ?? null,
    listType:
      element.tagName.toLowerCase() === "ol"
        ? "ordered"
        : element.tagName.toLowerCase() === "ul"
          ? "unordered"
          : null,
    placeholder: element.getAttribute("placeholder") ?? null,
    title: element.getAttribute("title") ?? null,
    valueNow: element.getAttribute("aria-valuenow") ?? null,
    valueMin: element.getAttribute("aria-valuemin") ?? null,
    valueMax: element.getAttribute("aria-valuemax") ?? null,
    orientation: element.getAttribute("aria-orientation") ?? null,
    invalid: element.getAttribute("aria-invalid") ?? null,
    readonly: element.getAttribute("aria-readonly") ?? null,
    modal: element.getAttribute("aria-modal") ?? null,
    multiselectable: element.getAttribute("aria-multiselectable") ?? null,
    captions: (() => {
      const tracks = Array.from(
        element.querySelectorAll("track[kind='captions']"),
      );
      return tracks.map((t) => t.getAttribute("src") ?? "").filter(Boolean);
    })(),
    componentType: null,
    autoplay: element.getAttribute("autoplay") ?? null,
    content: element.textContent?.trim() ?? null,
    styleTags: [],
  };
}

export const ARIA_ROLE_MAP: Partial<Record<string, IRRole>> = {
  main: "main",
  navigation: "navigation",
  banner: "banner",
  contentinfo: "contentinfo",
  complementary: "complementary",
  search: "search",
  form: "form",
  region: "region",
  heading: "heading",
  dialog: "dialog",
  tablist: "tablist",
  tabpanel: "tabpanel",
  menu: "menu",
  menubar: "menubar",
  menuitem: "menuitem",
  grid: "grid",
  tree: "tree",
  treeitem: "treeitem",
  progressbar: "progressbar",
  status: "status",
  alert: "alert",
  tooltip: "tooltip",
  feed: "feed",
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
  searchbox: "searchbox",
  checkbox: "checkbox",
  radio: "radio",
  combobox: "combobox",
  slider: "slider",
  spinbutton: "spinbutton",
  switch: "switch",
  tab: "tab",
  group: "group",
  menuitemcheckbox: "menuitemcheckbox",
  menuitemradio: "menuitemradio",
  option: "option",
  application: "application",
  article: "article",
  document: "document",
  note: "note",
  log: "log",
  marquee: "marquee",
  timer: "timer",
  toolbar: "toolbar",
  presentation: "presentation",
  none: "none",
};

export function parseIdRefs(value: string | null): string[] {
  return value?.trim() ? value.trim().split(/\s+/) : [];
}

export function createEmptyAttributes(): IRNodeAttributes {
  return {
    expanded: null,
    checked: null,
    selected: null,
    disabled: null,
    pressed: null,
    current: null,
    hidden: null,
    busy: null,
    required: null,
    controls: null,
    describedby: null,
    labelledby: null,
    owns: null,
    details: null,
    errormessage: null,
    flowto: null,
    haspopup: null,
    alt: null,
    src: null,
    href: null,
    live: null,
    rowspan: null,
    colspan: null,
    listType: null,
    placeholder: null,
    title: null,
    valueNow: null,
    valueMin: null,
    valueMax: null,
    orientation: null,
    invalid: null,
    readonly: null,
    modal: null,
    multiselectable: null,
    captions: [],
    componentType: null,
    autoplay: null,
    content: null,
    styleTags: [],
  };
}

export function createEmptyState(): IRNodeState {
  return {
    expanded: null,
    checked: null,
    selected: null,
    disabled: null,
    pressed: null,
    current: null,
    hidden: null,
    busy: null,
    required: null,
    live: null,
    invalid: null,
    readonly: null,
    modal: null,
    multiselectable: null,
    orientation: null,
    valueNow: null,
    valueMin: null,
    valueMax: null,
  };
}

export function createEmptyRelations(): IRNodeRelations {
  return {
    controls: [],
    labelledBy: [],
    describedBy: [],
    owns: [],
    details: [],
    errorMessage: [],
    flowTo: [],
    figureCaption: [],
    headers: [],
  };
}

export function assignIfDefined<T extends Record<string, any>>(
  target: T,
  key: keyof T,
  value: any,
): void {
  if (value !== undefined && value !== null && target[key] == null) {
    target[key] = value as any;
  }
}

export function confidenceForSource(
  source: IRSource,
  config: ParserConfig,
): number {
  return config.sourceConfidence[source];
}

export function isAccessibilityHidden(element: Element): boolean {
  const html = element as HTMLElement;
  return (
    element.getAttribute("aria-hidden") === "true" ||
    element.hasAttribute("hidden") ||
    element.hasAttribute("inert") ||
    html.style?.display === "none" ||
    html.style?.visibility === "hidden"
  );
}

export function mergeAttributes(
  base: IRNodeAttributes,
  lifted: Partial<IRNodeAttributes>,
): IRNodeAttributes {
  const result = { ...base };
  for (const key of Object.keys(lifted) as (keyof IRNodeAttributes)[]) {
    assignIfDefined(result, key, lifted[key]);
  }
  return result;
}

export function directTextContent(element: Element): string {
  let text = "";
  for (const node of Array.from(element.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE) text += node.textContent ?? "";
  }
  return text.trim();
}

export function resolveNodeLabel(
  element: Element,
  config: ParserConfig,
  doc?: Document,
): string | null {
  const cap = (s: string) => s.slice(0, config.labelMaxChars) || null;

  if (config.useAriaLabels) {
    if (doc) {
      const labelledby = element.getAttribute("aria-labelledby")?.trim();
      if (labelledby) {
        const text = labelledby
          .split(/\s+/)
          .map((id) => doc.getElementById(id)?.textContent?.trim() ?? "")
          .filter(Boolean)
          .join(" ");
        if (text) return cap(text);
      }
    }

    const ariaLabel = element.getAttribute("aria-label")?.trim() ?? "";
    if (ariaLabel) return cap(ariaLabel);

    const tag = element.tagName.toLowerCase();
    if (tag === "img") {
      const alt = element.getAttribute("alt")?.trim() ?? "";
      if (alt) return cap(alt);
      const src = element.getAttribute("src")?.trim() ?? "";
      if (src) return cap(src.split("/").pop() ?? src);
    }

    if (doc && (tag === "input" || tag === "textarea" || tag === "select")) {
      const id = element.getAttribute("id");
      if (id) {
        const labelEl = doc.querySelector(`label[for="${CSS.escape(id)}"]`);
        const labelText = labelEl?.textContent?.trim();
        if (labelText) return cap(labelText);
      }
      const wrappingLabel = element.closest("label");
      if (wrappingLabel) {
        const clone = wrappingLabel.cloneNode(true) as Element;
        clone.querySelector("input,textarea,select")?.remove();
        const labelText = clone.textContent?.trim();
        if (labelText) return cap(labelText);
      }
    }
    if (tag === "fieldset") {
      const legend = element.querySelector("legend")?.textContent?.trim();
      if (legend) return cap(legend);
    }

    if (tag === "figure") {
      const figcaption = element
        .querySelector("figcaption")
        ?.textContent?.trim();
      if (figcaption) return cap(figcaption);
    }

    if (tag === "svg" && config.includeSvg) {
      const title = element.querySelector("title")?.textContent?.trim();
      if (title) return cap(title);
    }

    if (tag === "button" || tag === "summary" || tag === "a") {
      const text = element.textContent?.trim() ?? "";
      if (text) return cap(text);
    }

    const titleAttr = element.getAttribute("title")?.trim();
    if (titleAttr) return cap(titleAttr);

    if (tag === "input" || tag === "textarea") {
      const placeholder = element.getAttribute("placeholder")?.trim();
      if (placeholder) return cap(placeholder);
    }
  }

  const hasElementChildren = Array.from(element.children).some(
    (child) => !SKIP_TAGS.has(child.tagName.toLowerCase()),
  );

  if (!hasElementChildren) {
    const text = element.textContent?.trim() ?? "";
    return text ? cap(text) : null;
  }

  const direct = directTextContent(element);
  return direct ? cap(direct) : null;
}

const LANDMARK_SCOPE_SELECTOR =
  "main, article, section, nav, aside, " +
  '[role="main"], [role="article"], [role="region"], ' +
  '[role="navigation"], [role="complementary"]';

export function resolveRoleFromElement(
  element: Element,
  config: ParserConfig,
): {
  role: IRRole;
  level: number | null;
  source: Extract<IRSource, "explicit" | "structural">;
} {
  if (config.useExplicitSemantics) {
    const ariaRole = element.getAttribute("role")?.trim().toLowerCase();
    if (ariaRole) {
      const mapped = ARIA_ROLE_MAP[ariaRole] ?? "generic";
      const level =
        ariaRole === "heading"
          ? Number.parseInt(element.getAttribute("aria-level") ?? "2", 10) || 2
          : null;

      if (
        (mapped === "banner" || mapped === "contentinfo") &&
        element.closest(LANDMARK_SCOPE_SELECTOR)
      ) {
        return { role: "generic", level: null, source: "explicit" };
      }
      return { role: mapped, level, source: "explicit" };
    }
  }

  const tag = element.tagName.toLowerCase();
  let tagResolved = resolveRoleFromTag(tag, element);
  if (tagResolved.role === "generic" && element.hasAttribute("aria-live")) {
    const liveValue = element.getAttribute("aria-live")?.toLowerCase();
    tagResolved = {
      role: liveValue === "assertive" ? "alert" : "status",
      level: null,
    };
  }

  if (
    tagResolved.role === "generic" &&
    element.getAttribute("tabindex") === "0"
  ) {
    tagResolved = { role: "button", level: null };
  }

  return { ...tagResolved, source: "structural" };
}

export function resolveRoleFromTag(
  tag: string,
  element?: Element,
): { role: IRRole; level: number | null } {
  if (tag === "main") return { role: "main", level: null };
  if (tag === "header") {
    if (!element || element.closest(LANDMARK_SCOPE_SELECTOR))
      return { role: "generic", level: null };
    return { role: "banner", level: null };
  }
  if (tag === "footer") {
    if (!element || element.closest(LANDMARK_SCOPE_SELECTOR))
      return { role: "generic", level: null };
    return { role: "contentinfo", level: null };
  }
  if (tag === "aside") return { role: "complementary", level: null };
  if (tag === "nav") return { role: "navigation", level: null };
  if (tag === "form") return { role: "form", level: null };
  if (tag === "section") return { role: "region", level: null };

  if (tag === "p") return { role: "paragraph", level: null };
  if (tag === "article") return { role: "article", level: null };
  if (tag === "img") return { role: "img", level: null };
  if (tag === "ul" || tag === "ol") return { role: "list", level: null };
  if (tag === "li") return { role: "listitem", level: null };
  if (tag === "a") return { role: "link", level: null };
  if (tag === "dialog") return { role: "dialog", level: null };
  if (tag === "details") return { role: "group", level: null };
  if (tag === "summary" || tag === "button")
    return { role: "button", level: null };
  if (tag === "progress" || tag === "meter")
    return { role: "progressbar", level: null };
  if (tag === "output") return { role: "status", level: null };

  if (tag === "input") {
    const type = element?.getAttribute("type")?.toLowerCase() ?? "text";
    if (type === "checkbox") return { role: "checkbox", level: null };
    if (type === "radio") return { role: "radio", level: null };
    if (type === "range") return { role: "slider", level: null };
    if (type === "number") return { role: "spinbutton", level: null };
    if (type === "search") return { role: "searchbox", level: null };
    if (["button", "submit", "reset", "image"].includes(type))
      return { role: "button", level: null };
    return { role: "textbox", level: null };
  }

  if (tag === "textarea") return { role: "textbox", level: null };
  if (tag === "select") return { role: "combobox", level: null };
  if (tag === "figure") return { role: "figure", level: null };
  if (tag === "figcaption") return { role: "caption", level: null };
  if (tag === "blockquote") return { role: "blockquote", level: null };
  if (tag === "code" || tag === "pre") return { role: "code", level: null };
  if (tag === "hr") return { role: "separator", level: null };

  if (tag === "table") return { role: "table", level: null };
  if (tag === "tr") return { role: "row", level: null };
  if (tag === "td") return { role: "cell", level: null };
  if (tag === "th") {
    const scope = element?.getAttribute("scope");
    return {
      role: scope === "row" ? "rowheader" : "columnheader",
      level: null,
    };
  }
  if (
    tag === "thead" ||
    tag === "tbody" ||
    tag === "tfoot" ||
    tag === "fieldset"
  ) {
    return { role: "group", level: null };
  }

  if (tag.length === 2 && tag[0] === "h") {
    const parsed = Number.parseInt(tag[1], 10);
    if (!Number.isNaN(parsed) && parsed >= 1 && parsed <= 6) {
      return { role: "heading", level: parsed };
    }
  }
  if (tag === "video") return { role: "video", level: null };
  if (tag === "audio") return { role: "audio", level: null };

  return { role: "generic", level: null };
}

export function isListCandidate(
  element: Element,
  config: ParserConfig,
): boolean {
  function unwrap(el: Element): Element {
    const tag = el.tagName.toLowerCase();
    if (
      (tag === "div" || tag === "span") &&
      !el.hasAttribute("role") &&
      !el.hasAttribute("aria-label") &&
      !el.hasAttribute("id")
    ) {
      const children = Array.from(el.children).filter(
        (c) => !SKIP_TAGS.has(c.tagName.toLowerCase()),
      );
      if (children.length === 1) return unwrap(children[0]);
    }
    return el;
  }

  const unwrapped = unwrap(element);
  const role = resolveRoleFromElement(unwrapped, config).role;

  if (
    LANDMARK_ROLES.has(role) ||
    INTERACTIVE_ROLES.has(role) ||
    role === "heading"
  )
    return false;

  const hasContent =
    unwrapped.textContent?.trim() || unwrapped.children.length > 0;
  if (!hasContent) return false;

  const tag = unwrapped.tagName.toLowerCase();
  return tag !== "ul" && tag !== "ol" && tag !== "li";
}

export function relationTargets(
  raw: string | null,
  doc: Document | undefined,
  elementToNodeId: WeakMap<Element, string>,
): string[] {
  if (!doc || !raw?.trim()) return [];
  const ids: string[] = [];
  for (const ref of parseIdRefs(raw)) {
    const element = doc.getElementById(ref);
    if (element) {
      const nodeId = elementToNodeId.get(element);
      if (nodeId) ids.push(nodeId);
    }
  }
  return ids;
}

export function hydrateRelations(
  nodes: Record<string, IRNode>,
  doc: Document | undefined,
  elementToNodeId: WeakMap<Element, string>,
): void {
  for (const node of Object.values(nodes)) {
    node.relations.controls = relationTargets(
      node.attributes.controls,
      doc,
      elementToNodeId,
    );
    node.relations.labelledBy = relationTargets(
      node.attributes.labelledby,
      doc,
      elementToNodeId,
    );
    node.relations.describedBy = relationTargets(
      node.attributes.describedby,
      doc,
      elementToNodeId,
    );
    node.relations.owns = relationTargets(
      node.attributes.owns,
      doc,
      elementToNodeId,
    );
    node.relations.details = relationTargets(
      node.attributes.details,
      doc,
      elementToNodeId,
    );
    node.relations.errorMessage = relationTargets(
      node.attributes.errormessage,
      doc,
      elementToNodeId,
    );
    node.relations.flowTo = relationTargets(
      node.attributes.flowto,
      doc,
      elementToNodeId,
    );

    if (node.role === "figure") {
      node.relations.figureCaption = node.children.filter(
        (id) => nodes[id]?.role === "caption",
      );
    }
  }

  if (doc) {
    for (const labelEl of Array.from(doc.querySelectorAll("label[for]"))) {
      const forId = labelEl.getAttribute("for");
      if (!forId) continue;
      const targetEl = doc.getElementById(forId);
      if (!targetEl) continue;
      const labelNodeId = elementToNodeId.get(labelEl);
      const targetNodeId = elementToNodeId.get(targetEl);
      if (!labelNodeId || !targetNodeId) continue;
      const targetNode = nodes[targetNodeId];
      if (
        targetNode &&
        !targetNode.relations.labelledBy.includes(labelNodeId)
      ) {
        targetNode.relations.labelledBy.push(labelNodeId);
      }
    }

    for (const tableEl of Array.from(doc.querySelectorAll("table"))) {
      for (const cellEl of Array.from(tableEl.querySelectorAll("td, th"))) {
        const headersAttr = cellEl.getAttribute("headers");
        if (!headersAttr?.trim()) continue;
        const cellNodeId = elementToNodeId.get(cellEl);
        if (!cellNodeId || !nodes[cellNodeId]) continue;
        const resolved = relationTargets(headersAttr, doc, elementToNodeId);
        for (const hId of resolved) {
          if (!nodes[cellNodeId].relations.headers.includes(hId)) {
            nodes[cellNodeId].relations.headers.push(hId);
          }
        }
      }

      const rows = Array.from(tableEl.querySelectorAll("tr"));
      const colHeaders: Map<number, string> = new Map();
      const rowHeadersByRow: Map<Element, string[]> = new Map();

      for (const rowEl of rows) {
        const cells = Array.from(rowEl.children).filter(
          (c) => c.tagName === "TD" || c.tagName === "TH",
        );
        const rowScopeIds: string[] = [];

        cells.forEach((cellEl, colIndex) => {
          if (cellEl.tagName !== "TH") return;
          const scope = cellEl.getAttribute("scope")?.toLowerCase();
          const nodeId = elementToNodeId.get(cellEl);
          if (!nodeId) return;

          const inThead = !!cellEl.closest("thead");
          if (scope === "col" || (!scope && inThead)) {
            colHeaders.set(colIndex, nodeId);
          } else if (scope === "row") {
            rowScopeIds.push(nodeId);
          }
        });

        if (rowScopeIds.length) rowHeadersByRow.set(rowEl, rowScopeIds);
      }

      for (const rowEl of rows) {
        const cells = Array.from(rowEl.children).filter(
          (c) => c.tagName === "TD" || c.tagName === "TH",
        );
        const rowScopeIds = rowHeadersByRow.get(rowEl) ?? [];

        cells.forEach((cellEl, colIndex) => {
          if (cellEl.getAttribute("headers")?.trim()) return;
          const cellNodeId = elementToNodeId.get(cellEl);
          if (!cellNodeId || !nodes[cellNodeId]) return;

          const toAdd: string[] = [];
          const colHeaderId = colHeaders.get(colIndex);
          if (colHeaderId && colHeaderId !== cellNodeId)
            toAdd.push(colHeaderId);
          for (const rId of rowScopeIds) {
            if (rId !== cellNodeId) toAdd.push(rId);
          }
          for (const hId of toAdd) {
            if (!nodes[cellNodeId].relations.headers.includes(hId)) {
              nodes[cellNodeId].relations.headers.push(hId);
            }
          }
        });
      }
    }
  }
}

export function hasTextAndInlineChildren(
  element: Element,
  inlineTags: Set<string>,
): boolean {
  let hasText = false;
  let hasInlineChild = false;

  for (const child of Array.from(element.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      if ((child.textContent ?? "").trim()) hasText = true;
    } else if (child.nodeType === Node.ELEMENT_NODE) {
      const tag = (child as Element).tagName.toLowerCase();
      if (inlineTags.has(tag) && !SKIP_TAGS.has(tag)) hasInlineChild = true;
    }
  }
  return hasText && hasInlineChild;
}

export function isLeafNode(
  element: Element,
  inlineTags: Set<string>,
  skipTags: Set<string>,
): boolean {
  const tag = element.tagName.toLowerCase();
  const LEAF_TAGS = new Set([
    "p",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "a",
    "button",
    "summary",
    "label",
    "li",
  ]);

  if (LEAF_TAGS.has(tag)) {
    for (const child of Array.from(element.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE && (child.textContent ?? "").trim())
        return true;
      if (
        child.nodeType === Node.ELEMENT_NODE &&
        !skipTags.has((child as Element).tagName.toLowerCase())
      )
        return true;
    }
    return false;
  }

  for (const child of Array.from(element.children)) {
    const childTag = child.tagName.toLowerCase();
    if (!skipTags.has(childTag) && !inlineTags.has(childTag)) return false;
  }

  return Array.from(element.childNodes).some((node) => {
    if (node.nodeType === Node.TEXT_NODE)
      return (node.textContent ?? "").trim().length > 0;
    if (node.nodeType === Node.ELEMENT_NODE)
      return !skipTags.has((node as Element).tagName.toLowerCase());
    return false;
  });
}

export function getSemanticSignature(
  element: Element,
  ctx: BuildContext,
): string {
  function pierceWrappers(el: Element): Element[] {
    const result: Element[] = [];
    const tag = el.tagName.toLowerCase();

    if ((tag === "div" || tag === "span") && !el.hasAttribute("role")) {
      const children = getValidChildren(el, ctx.skipTags);
      if (children.length === 1) return pierceWrappers(children[0]);
      if (children.length > 1) {
        for (const child of children) result.push(...pierceWrappers(child));
        return result;
      }
    }
    return [el];
  }

  const elements = pierceWrappers(element);
  const roles: string[] = [];

  for (const el of elements) {
    const tag = el.tagName.toLowerCase();
    if (ctx.skipTags.has(tag)) continue;

    const roleInfo = resolveRoleFromElement(el, ctx.config);
    if (roleInfo.role !== "generic") {
      roles.push(roleInfo.role);
      if (roleInfo.level !== null) roles.push(`h${roleInfo.level}`);
    } else {
      roles.push(tag);
    }

    for (const child of Array.from(el.children)) {
      const childTag = child.tagName.toLowerCase();
      if (ctx.skipTags.has(childTag)) continue;
      const childRole = resolveRoleFromElement(child, ctx.config);
      if (childRole.role !== "generic") roles.push(childRole.role);
    }
  }

  return Array.from(new Set(roles)).sort().join("|");
}

export function areStructurallySimilar(
  el1: Element,
  el2: Element,
  ctx: BuildContext,
): boolean {
  if (getSemanticSignature(el1, ctx) !== getSemanticSignature(el2, ctx))
    return false;

  function getContentDepth(el: Element): number {
    let depth = 0;
    let current = el;
    while (current.children.length === 1) {
      const tag = current.children[0].tagName.toLowerCase();
      if (tag === "div" || tag === "span") {
        depth++;
        current = current.children[0];
      } else break;
    }
    return depth;
  }

  return Math.abs(getContentDepth(el1) - getContentDepth(el2)) <= 1;
}
