import {
  DEFAULT_CONFIG,
  INLINE_TAGS,
  INTERACTIVE_ROLES,
  LANDMARK_ROLES,
  SKIP_TAGS,
  WRAPPER_TAGS,
} from "./defaults";
import type {
  AIFallbackProvider,
  AIFallbackResponse,
  BuildContext,
  IRAnalytics,
  IRFallbackEntry,
  IRNode,
  IRNodeAttributes,
  IRRole,
  LandmarkRecord,
  LandmarkTOCNode,
  PageIR,
  ParserConfig,
} from "./types";
import {
  readNodeAttributes,
  assignIfDefined,
  directTextContent,
  resolveRoleFromElement,
  resolveNodeLabel,
  confidenceForSource,
  readNodeState,
  mergeAttributes,
  isAccessibilityHidden,
  createEmptyAttributes,
  isListCandidate,
  hydrateRelations,
  areStructurallySimilar,
  getSemanticSignature,
  createBaseNode,
  getValidChildren,
  collectSiblingRun,
} from "./utils";
import {
  shouldDecomposeContent,
  decomposeInlineContentRecursive,
  createInlineNodes,
} from "./inline-parser";

export class StubAIProvider implements AIFallbackProvider {
  async classify(
    _domSubtree: string,
    _nodeId: string,
  ): Promise<AIFallbackResponse | null> {
    return null;
  }
}

function serialiseDOMSubtree(
  element: Element,
  skipTags: Set<string>,
  maxDepth = 3,
): string {
  function walk(el: Element, depth: number): string {
    if (depth > maxDepth) return "";
    const tag = el.tagName.toLowerCase();
    const attrs = Array.from(el.attributes)
      .filter((a) => !["style", "class"].includes(a.name))
      .map((a) => ` ${a.name}="${a.value}"`)
      .join("");
    const children = Array.from(el.children)
      .filter((c) => !skipTags.has(c.tagName.toLowerCase()))
      .map((c) => walk(c, depth + 1))
      .join("");
    const directText = Array.from(el.childNodes)
      .filter((n) => n.nodeType === Node.TEXT_NODE)
      .map((n) => n.textContent?.trim() ?? "")
      .filter(Boolean)
      .join(" ");
    const inner = directText
      ? `${directText}${children ? " " + children : ""}`
      : children;
    return `<${tag}${attrs}>${inner}</${tag}>`;
  }
  return walk(element, 0);
}

function resolveSectionLabel(
  fallbackLabel: string,
  config: ParserConfig,
  element?: Element,
  doc?: Document,
): string {
  const cap = (s: string) => s.slice(0, config.labelMaxChars);
  if (config.useAriaLabels && element && doc) {
    const labelledby = element.getAttribute("aria-labelledby")?.trim();
    if (labelledby) {
      const text = labelledby
        .split(/\s+/)
        .map((id) => doc.getElementById(id)?.textContent?.trim() ?? "")
        .filter(Boolean)
        .join(" ");
      if (text) return cap(text);
    }
    const ariaLabel = element.getAttribute("aria-label")?.trim();
    if (ariaLabel) return cap(ariaLabel);
  }
  if (element) {
    for (let level = 1; level <= 6; level++) {
      const headings = Array.from(element.children).filter(
        (c) => c.tagName.toLowerCase() === `h${level}`,
      );
      const hasExactlyOneHeading = headings.length === 1;

      if (hasExactlyOneHeading) {
        const text = headings[0].textContent?.trim();
        if (text) return cap(text);
      }
    }
  }
  return fallbackLabel;
}

function isInertWrapper(element: Element, ctx: BuildContext): boolean {
  const isWrapperTag = ctx.wrapperTags.has(element.tagName.toLowerCase());
  if (!isWrapperTag) return false;

  const hasSemanticOrInteractiveIdentity =
    element.hasAttribute("role") ||
    element.hasAttribute("aria-label") ||
    element.hasAttribute("id") ||
    element.hasAttribute("tabindex");

  if (hasSemanticOrInteractiveIdentity) return false;

  const ariaAttrs = [
    "aria-expanded",
    "aria-checked",
    "aria-selected",
    "aria-disabled",
    "aria-pressed",
    "aria-current",
    "aria-hidden",
    "aria-busy",
    "aria-required",
    "aria-controls",
    "aria-describedby",
    "aria-labelledby",
    "aria-owns",
    "aria-details",
    "aria-errormessage",
    "aria-flowto",
    "aria-haspopup",
  ];
  const hasStateOrRelationAriaAttributes = ariaAttrs.some((attr) =>
    element.hasAttribute(attr),
  );

  return !hasStateOrRelationAriaAttributes;
}

function pierceWrapperChain(
  element: Element,
  ctx: BuildContext,
): { element: Element; liftedAttrs: Partial<IRNodeAttributes> } {
  if (!ctx.config.useWrapperPiercing) return { element, liftedAttrs: {} };

  const liftedAttrs: Partial<IRNodeAttributes> = {};
  let current = element;

  while (true) {
    const isWrapperTag = ctx.wrapperTags.has(current.tagName.toLowerCase());
    if (!isWrapperTag) break;

    const hasSemanticIdentity =
      current.hasAttribute("role") ||
      current.hasAttribute("aria-label") ||
      current.hasAttribute("id");

    if (hasSemanticIdentity) break;

    const snap = readNodeAttributes(current, { sourceUrl: ctx.pageUrl });
    for (const key of Object.keys(snap) as (keyof IRNodeAttributes)[]) {
      assignIfDefined(liftedAttrs, key, snap[key]);
    }

    const hasText = directTextContent(current).length > 0;
    const children = getValidChildren(current, ctx.skipTags);
    const hasMultipleOrZeroChildren = children.length !== 1;

    if (hasText || hasMultipleOrZeroChildren)
      return { element: current, liftedAttrs };
    current = children[0];
  }
  return { element: current, liftedAttrs };
}

function normaliseChildContent(
  element: Element,
  skipTags: Set<string>,
): Element[] {
  const isAlreadyNormalised = element.hasAttribute("data-ir-prose");
  if (isAlreadyNormalised) {
    return getValidChildren(element, skipTags);
  }

  const result: Element[] = [];
  let proseNodes: ChildNode[] = [];
  let hasBlockElements = false;

  const flushProse = (): void => {
    const hasVisibleText = proseNodes.some((n) =>
      n.nodeType === Node.TEXT_NODE
        ? (n.textContent ?? "").trim().length > 0
        : true,
    );

    if (!hasVisibleText) {
      proseNodes = [];
      return;
    }
    const wrapper = element.ownerDocument!.createElement("span");
    wrapper.setAttribute("data-ir-prose", "true");
    for (const n of proseNodes) wrapper.appendChild(n.cloneNode(true));
    result.push(wrapper);
    proseNodes = [];
  };

  for (const node of Array.from(element.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE) {
      proseNodes.push(node);
      continue;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) continue;

    const el = node as Element;
    const tag = el.tagName.toLowerCase();

    if (skipTags.has(tag)) continue;

    const isInlineTag = INLINE_TAGS.has(tag);
    if (isInlineTag) {
      proseNodes.push(el);
    } else {
      hasBlockElements = true;
      flushProse();
      result.push(el);
    }
  }
  flushProse();

  return hasBlockElements ? result : getValidChildren(element, skipTags);
}

async function createNode(
  element: Element,
  parentId: string,
  landmarkParentId: string,
  ctx: BuildContext,
  liftedAttrs: Partial<IRNodeAttributes> = {},
  readingDepth = 0,
): Promise<string | string[]> {
  const id = `${parentId}-node-${ctx.counters.node++}`;
  ctx.elementToNodeId.set(element, id);

  let roleInfo = resolveRoleFromElement(element, ctx.config);
  let resolvedRole = roleInfo.role;
  let resolvedSource = roleInfo.source;
  let resolvedConfidence = confidenceForSource(roleInfo.source, ctx.config);

  const tag = element.tagName.toLowerCase();
  const isGenericWrapper = tag === "div" || tag === "span";
  const hasOnlyText = hasOnlyTextContent(element, ctx);

  const isPureTextWrapper =
    isGenericWrapper && hasOnlyText && resolvedRole === "generic";

  if (isPureTextWrapper) {
    const text = element.textContent?.trim() || "";
    if (text) {
      const textId = `${parentId}-text-${ctx.counters.node++}`;
      ctx.nodes[textId] = createBaseNode(textId, "text", parentId, ctx, {
        content: text,
        source: "inline",
        confidence: ctx.config.sourceConfidence["inline"],
        readingDepth,
        attributes: { ...createEmptyAttributes(), componentType: tag },
      });
      return textId;
    }
  }

  const isTransparentInlineContainer =
    isGenericWrapper &&
    !hasOnlyText &&
    resolvedRole === "generic" &&
    !hasPreservableWrapperAttrs(element) &&
    hasNoBlockDescendant(element, ctx);

  if (isTransparentInlineContainer) {
    const spliceChildren = getValidChildren(element, ctx.skipTags);
    const hasSpliceableChildren = spliceChildren.length > 0;

    if (hasSpliceableChildren) {
      const inlineCtx = {
        inlineTags: ctx.inlineTags,
        skipTags: ctx.skipTags,
        config: ctx.config,
        doc: ctx.doc,
        pageUrl: ctx.pageUrl,
      };

      const requiresInlineDecomposition = shouldDecomposeContent(
        element,
        inlineCtx,
      );

      if (requiresInlineDecomposition) {
        const runs = decomposeInlineContentRecursive(
          element,
          inlineCtx,
          parentId,
        );
        const result = createInlineNodes(runs, parentId, ctx, readingDepth);
        if (result.nodeIds.length > 0) return result.nodeIds;
      } else {
        const childIds = await buildChildrenFromSiblings(
          spliceChildren,
          parentId,
          landmarkParentId,
          ctx,
          readingDepth,
        );
        if (childIds.length > 0) return childIds;
      }
    }
  }

  const figureResult = handleFigureSythenticCreation(
    element,
    parentId,
    ctx,
    readingDepth,
  );
  if (figureResult) return figureResult;

  const childElements = getValidChildren(element, ctx.skipTags);
  const hasBlockChildren = childElements.some(
    (child) => !ctx.inlineTags.has(child.tagName.toLowerCase()),
  );
  const children: string[] = [];
  let textNodes: string[] = [];
  let hasBlockChild = false;

  const isPureInlineContainer = !hasBlockChildren && childElements.length > 0;

  if (isPureInlineContainer) {
    const inlineCtx = {
      inlineTags: ctx.inlineTags,
      skipTags: ctx.skipTags,
      config: ctx.config,
      doc: ctx.doc,
      pageUrl: ctx.pageUrl,
    };

    const requiresInlineDecomposition = shouldDecomposeContent(
      element,
      inlineCtx,
    );

    if (requiresInlineDecomposition) {
      const runs = decomposeInlineContentRecursive(element, inlineCtx, id);
      const result = createInlineNodes(runs, id, ctx, readingDepth + 1);
      children.push(...result.nodeIds);
      textNodes = result.textRuns;
    } else {
      children.push(
        ...(await buildChildrenFromSiblings(
          childElements,
          id,
          landmarkParentId,
          ctx,
          readingDepth,
        )),
      );
    }
  } else if (hasBlockChildren) {
    const normalisedChildren = normaliseChildContent(element, ctx.skipTags);
    children.push(
      ...(await buildChildrenFromSiblings(
        normalisedChildren,
        id,
        landmarkParentId,
        ctx,
        readingDepth,
      )),
    );
    hasBlockChild = true;
  }

  const label = resolveNodeLabelSmart(
    element,
    resolvedRole,
    ctx.config,
    ctx.doc,
  );
  const hasContent =
    children.length > 0 || textNodes.length > 0 || element.textContent?.trim();

  const needsAIFallback =
    ctx.config.useAIFallback &&
    resolvedConfidence < ctx.config.aiFallbackThreshold &&
    resolvedRole === "generic" &&
    hasContent &&
    !isGenericWrapper;

  if (needsAIFallback) {
    const subtree = serialiseDOMSubtree(element, ctx.skipTags);
    try {
      const aiResult = await ctx.fallbackProvider.classify(subtree, id);

      const isAIConfident =
        aiResult &&
        aiResult.confidence >= ctx.config.aiFallbackThreshold &&
        aiResult.confidence > confidenceForSource(resolvedSource, ctx.config);

      if (isAIConfident) {
        resolvedRole = aiResult.role;
        resolvedSource = "ai";
        resolvedConfidence = aiResult.confidence;
      } else {
        ctx.fallbackLog.push({ id, tag, reason: "ai-timeout" });
        resolvedSource = "ai-timeout";
        resolvedConfidence = confidenceForSource("ai-timeout", ctx.config);
      }
    } catch {
      ctx.fallbackLog.push({ id, tag, reason: "ai-timeout" });
      resolvedSource = "ai-timeout";
      resolvedConfidence = confidenceForSource("ai-timeout", ctx.config);
    }
  }
  // ---- SYNTHESIS OF TEXT CHILD FOR LEAF TEXT NODES ----
  // If we have no children at all, no textNodes (i.e. no inline decomposition),
  // and this node is a text-bearing role, and it has direct text content,
  // create a synthetic "text" child so that the mapper always sees a child.
  const textBearingRoles = new Set([
    "paragraph",
    "heading",
    "link",
    "button",
    "blockquote",
    "note",
    "code",
    "listitem",
    "cell",
    "columnheader",
  ]);

  if (
    children.length === 0 &&
    textNodes.length === 0 &&
    textBearingRoles.has(resolvedRole) &&
    resolvedRole !== "text" // don't create a child for a text node itself
  ) {
    const rawText = element.textContent?.trim() || "";
    if (rawText) {
      const textId = `${id}-synth-text-${ctx.counters.node++}`;
      ctx.nodes[textId] = createBaseNode(textId, "text", id, ctx, {
        content: rawText,
        label: rawText,
        source: "inline",
        confidence: ctx.config.sourceConfidence["inline"],
        readingDepth: readingDepth + 1,
        attributes: { ...createEmptyAttributes() },
      });
      children.push(textId);
      // We will clear the parent's content below to avoid duplication.
    }
  }

  ctx.nodes[id] = createBaseNode(id, resolvedRole, parentId, ctx, {
    level: roleInfo.level,
    label,
    content: (() => {
      // If we just added a synthetic text child, don't duplicate text on the parent.
      if (children.length > 0 && children[0].startsWith(id + "-synth-text-")) {
        return null;
      }
      return !hasBlockChild
        ? textNodes.length > 0
          ? textNodes.join(" ")
          : (element.textContent?.trim() ?? null)
        : null;
    })(),
    source: resolvedSource,
    confidence: resolvedConfidence,
    children,
    state: readNodeState(element),
    attributes: mergeAttributes(
      readNodeAttributes(element, { sourceUrl: ctx.pageUrl }),
      liftedAttrs,
    ),
    readingDepth,
  });

  return id;
}

function resolveNodeLabelSmart(
  element: Element,
  role: IRRole,
  config: ParserConfig,
  doc?: Document,
): string | null {
  const tag = element.tagName.toLowerCase();
  const isGenericContainer =
    (tag === "div" || tag === "span") && role === "generic";

  if (isGenericContainer) {
    const hasVisibleChildren = Array.from(element.children).some(
      (child) =>
        !["script", "style", "noscript"].includes(child.tagName.toLowerCase()),
    );
    if (!hasVisibleChildren) return null;
  }

  const isTextBearingNode = new Set([
    "paragraph",
    "heading",
    "text",
    "caption",
  ]).has(role);
  const shouldSkipTextLabels = isTextBearingNode && !config.useTextLabels;
  if (shouldSkipTextLabels) return null;

  const SEMANTIC_CONTAINERS = new Set([
    "main",
    "navigation",
    "banner",
    "contentinfo",
    "complementary",
    "search",
    "form",
    "region",
    "article",
    "section",
    "dialog",
    "tabpanel",
  ]);

  const isSemanticContainerConfiguredForLabels =
    SEMANTIC_CONTAINERS.has(role) && config.useSemanticLabels;

  if (isSemanticContainerConfiguredForLabels) {
    const label = resolveNodeLabel(element, config, doc);
    if (label) return label;

    const isHeadingContainer = role === "region";
    if (isHeadingContainer) {
      for (const heading of Array.from(
        element.querySelectorAll("h1, h2, h3, h4, h5, h6"),
      )) {
        const headingText = heading.textContent?.trim();
        if (headingText) return headingText.slice(0, config.labelMaxChars);
      }
    }
    return `${role}`;
  }

  const isInteractiveRequiringAria =
    config.useAriaLabels && INTERACTIVE_ROLES.has(role);
  if (isInteractiveRequiringAria) return resolveNodeLabel(element, config, doc);

  const isGenericLandmark = role === "generic" && LANDMARK_ROLES.has(role);
  if (isGenericLandmark) return resolveNodeLabel(element, config, doc);

  const label = resolveNodeLabel(element, config, doc);
  const isRedundantGenericLabel =
    role === "generic" && label === element.textContent?.trim();

  if (isRedundantGenericLabel) return null;
  return label || null;
}

function hasNoBlockDescendant(element: Element, ctx: BuildContext): boolean {
  for (const child of Array.from(element.childNodes)) {
    if (child.nodeType !== Node.ELEMENT_NODE) continue;
    const tag = (child as Element).tagName.toLowerCase();

    const isSkippedElement = ctx.skipTags.has(tag);
    if (isSkippedElement) continue;

    const isBlockElementOrHasBlockDescendants =
      !ctx.inlineTags.has(tag) || !hasNoBlockDescendant(child as Element, ctx);
    if (isBlockElementOrHasBlockDescendants) return false;
  }
  return true;
}

function hasPreservableWrapperAttrs(element: Element): boolean {
  const hasGlobalPreservableAttrs =
    element.hasAttribute("title") || element.hasAttribute("lang");
  if (hasGlobalPreservableAttrs) return true;

  for (const attr of Array.from(element.attributes)) {
    const isId = attr.name === "id";
    const isAria = attr.name.startsWith("aria-");
    const isCustomData =
      attr.name.startsWith("data-") && attr.name !== "data-ir-prose";

    const shouldPreserve = isId || isAria || isCustomData;
    if (shouldPreserve) return true;
  }
  return false;
}

function hasOnlyTextContent(element: Element, ctx: BuildContext): boolean {
  let hasText = false;
  for (const child of Array.from(element.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      const isVisibleText = (child.textContent ?? "").trim().length > 0;
      if (isVisibleText) hasText = true;
    } else if (child.nodeType === Node.ELEMENT_NODE) {
      const tag = (child as Element).tagName.toLowerCase();
      const isSkippedElement = ctx.skipTags.has(tag);

      const containsBlockOrNonTextElements =
        !isSkippedElement &&
        (!ctx.inlineTags.has(tag) ||
          !hasOnlyTextContent(child as Element, ctx));

      if (containsBlockOrNonTextElements) return false;
    }
  }
  return hasText;
}

function peelSibling(
  el: Element,
  ctx: BuildContext,
): { element: Element; liftedAttrs: Partial<IRNodeAttributes> } {
  const isWrapper = isInertWrapper(el, ctx);
  return isWrapper
    ? pierceWrapperChain(el, ctx)
    : { element: el, liftedAttrs: {} };
}

// ─────────────────────────────────────────────────────────────
// Layout table detection
// ─────────────────────────────────────────────────────────────

function getTableMaxColumnCount(table: Element): number {
  let max = 0;
  for (const child of Array.from(table.children)) {
    const tag = child.tagName.toLowerCase();
    const rows =
      tag === "tbody" || tag === "thead" || tag === "tfoot"
        ? Array.from(child.children)
        : tag === "tr"
          ? [child]
          : [];
    for (const row of rows) {
      if (row.tagName.toLowerCase() !== "tr") continue;
      const count = Array.from(row.children).filter(
        (c) =>
          c.tagName.toLowerCase() === "td" || c.tagName.toLowerCase() === "th",
      ).length;
      max = Math.max(max, count);
    }
  }
  return max;
}

/**
 * Returns true for tables that are purely presentational layout containers:
 * - explicit role="presentation" or role="none"
 * - OR: no semantic data-table signals (no caption, thead, th) AND single column
 *
 * Single-column tables are overwhelmingly used as page-layout wrappers
 * (e.g. HN's outer table, email-style layouts) where the entire page
 * content lives in one <td> per row. Piercing them lets the parser see
 * the actual semantic content inside.
 */
function isLayoutTable(table: Element): boolean {
  const role = table.getAttribute("role")?.toLowerCase();
  if (role === "presentation" || role === "none") return true;

  // Explicit data-table signals — never pierce these
  if (
    table.getAttribute("summary") ||
    table.getAttribute("aria-label") ||
    table.getAttribute("aria-labelledby")
  )
    return false;

  // Check for caption / thead / any th in the first two levels
  for (const child of Array.from(table.children)) {
    const tag = child.tagName.toLowerCase();
    if (tag === "caption" || tag === "thead") return false;
    const rows =
      tag === "tbody" || tag === "tfoot"
        ? Array.from(child.children)
        : tag === "tr"
          ? [child]
          : [];
    for (const row of rows) {
      if (row.tagName.toLowerCase() !== "tr") continue;
      for (const cell of Array.from(row.children)) {
        if (cell.tagName.toLowerCase() === "th") return false;
      }
    }
  }

  return getTableMaxColumnCount(table) <= 1;
}

/**
 * Collect the direct element children from every <td>/<th> in the table.
 * Used to "pierce" a layout table and treat its cell content as flat siblings.
 */
function getLayoutTableCellContents(
  table: Element,
  skipTags: Set<string>,
): Element[] {
  const contents: Element[] = [];
  for (const child of Array.from(table.children)) {
    const tag = child.tagName.toLowerCase();
    const rows =
      tag === "tbody" || tag === "tfoot"
        ? Array.from(child.children)
        : tag === "tr"
          ? [child]
          : [];
    for (const row of rows) {
      if (row.tagName.toLowerCase() !== "tr") continue;
      for (const cell of Array.from(row.children)) {
        const cellTag = cell.tagName.toLowerCase();
        if (cellTag !== "td" && cellTag !== "th") continue;
        contents.push(...getValidChildren(cell as Element, skipTags));
      }
    }
  }
  return contents;
}

function handleMediaLeaf(
  child: Element,
  liftedAttrs: Partial<IRNodeAttributes>,
  parentId: string,
  ctx: BuildContext,
  readingDepth: number,
): string {
  const id = `${parentId}-node-${ctx.counters.node++}`;
  const label = resolveNodeLabel(child, ctx.config, ctx.doc);
  ctx.elementToNodeId.set(child, id);

  ctx.nodes[id] = createBaseNode(id, "img", parentId, ctx, {
    label,
    attributes: mergeAttributes(
      readNodeAttributes(child, { sourceUrl: ctx.pageUrl }),
      liftedAttrs,
    ),
    readingDepth,
  });
  return id;
}

async function handleLandmark(
  child: Element,
  liftedAttrs: Partial<IRNodeAttributes>,
  parentId: string,
  landmarkParentId: string,
  ctx: BuildContext,
  readingDepth: number,
): Promise<string> {
  const roleInfo = resolveRoleFromElement(child, ctx.config);
  const landmarkId = `${parentId}-section-${ctx.counters.section++}`;
  ctx.elementToNodeId.set(child, landmarkId);

  const nestedChildren = await buildChildrenFromSiblings(
    getValidChildren(child, ctx.skipTags),
    landmarkId,
    landmarkId,
    ctx,
    readingDepth + 1,
    true,
  );
  const label =
    resolveNodeLabel(child, ctx.config, ctx.doc) ??
    resolveSectionLabel(landmarkId, ctx.config, child, ctx.doc);

  ctx.landmarkRecords.push({
    id: landmarkId,
    label,
    parentId: landmarkParentId,
  });

  ctx.nodes[landmarkId] = createBaseNode(
    landmarkId,
    roleInfo.role,
    parentId,
    ctx,
    {
      level: roleInfo.level,
      label,
      content: child.textContent?.trim() ?? null,
      landmark: true,
      source: roleInfo.source,
      children: nestedChildren,
      state: readNodeState(child),
      attributes: mergeAttributes(
        readNodeAttributes(child, { sourceUrl: ctx.pageUrl }),
        liftedAttrs,
      ),
      readingDepth,
    },
  );
  return landmarkId;
}

async function handleHeadingSection(
  siblings: Element[],
  index: number,
  parentId: string,
  landmarkParentId: string,
  ctx: BuildContext,
  readingDepth: number,
  parentIsLandmark: boolean,
): Promise<{ id: string; endIndex: number } | null> {
  const child = peelSibling(siblings[index], ctx).element;
  const headingLevel = resolveRoleFromElement(child, ctx.config).level ?? 0;

  let endIndex = index + 1;
  while (endIndex < siblings.length) {
    const lookahead = peelSibling(siblings[endIndex], ctx).element;
    const lookaheadRole = resolveRoleFromElement(lookahead, ctx.config);

    const isSameOrHigherHeading =
      lookaheadRole.role === "heading" &&
      (lookaheadRole.level ?? 0) <= headingLevel;
    const isExplicitSection = lookahead.tagName.toLowerCase() === "section";
    const isLandmarkBoundary = LANDMARK_ROLES.has(lookaheadRole.role);

    const reachedSectionBoundary =
      isSameOrHigherHeading || isExplicitSection || isLandmarkBoundary;
    if (reachedSectionBoundary) break;

    endIndex += 1;
  }

  const noAdditionalSiblingsFound = endIndex === index + 1;
  if (noAdditionalSiblingsFound) return null;

  const headingCount = siblings
    .slice(index, endIndex)
    .reduce(
      (count, sib) =>
        count +
        (resolveRoleFromElement(peelSibling(sib, ctx).element, ctx.config)
          .role === "heading"
          ? 1
          : 0),
      0,
    );

  const isInvalidLandmarkSectioning = parentIsLandmark && headingCount <= 1;
  if (isInvalidLandmarkSectioning) return null;

  const sectionId = `${parentId}-section-${ctx.counters.section++}`;
  const sectionChildren = (
    await Promise.all(
      siblings.slice(index, endIndex).map((sib) => {
        const peeled = peelSibling(sib, ctx);
        return createNode(
          peeled.element,
          sectionId,
          sectionId,
          ctx,
          peeled.liftedAttrs,
          readingDepth + 1,
        );
      }),
    )
  ).flat();

  const label =
    resolveNodeLabel(child, ctx.config, ctx.doc) ??
    child.textContent?.trim() ??
    sectionId;
  ctx.landmarkRecords.push({
    id: sectionId,
    label,
    parentId: landmarkParentId,
  });

  ctx.nodes[sectionId] = createBaseNode(sectionId, "region", parentId, ctx, {
    label,
    landmark: true,
    children: sectionChildren,
    readingDepth,
  });
  return { id: sectionId, endIndex };
}

function handleFigureSythenticCreation(
  element: Element,
  parentId: string,
  ctx: BuildContext,
  readingDepth: number,
): string | undefined {
  const promoted = promoteLinkedImageDeep(element, ctx);
  const isFigurePromotionFailed = !promoted;
  if (isFigurePromotionFailed) return;

  const figElement = promoted.element;
  const rawSrc = figElement.getAttribute("data-ir-src") || "";
  // promoteLinkedImageDeep reads img.getAttribute("src") straight off the DOM,
  // bypassing readNodeAttributes' resolveUrl — resolve it here so root-relative
  // paths (e.g. "/static/ssr/x.png") don't get requested against our own origin.
  const src = rawSrc ? new URL(rawSrc, ctx.pageUrl).href : rawSrc;
  const href = figElement.getAttribute("data-ir-figure-href") || null;
  const alt = figElement.getAttribute("alt") || null;
  const captionEl = figElement.querySelector(
    ".devsite-landing-row-item-description-content, figcaption, .caption",
  );
  const caption = captionEl?.textContent?.trim() || alt;

  const id = `${parentId}-figure-${ctx.counters.node++}`;
  const imgId = `${id}-img-${ctx.counters.node++}`;

  ctx.nodes[imgId] = createBaseNode(imgId, "img", id, ctx, {
    label: alt,
    attributes: { ...createEmptyAttributes(), src, href, alt },
    readingDepth: readingDepth + 1,
  });

  ctx.nodes[id] = createBaseNode(id, "figure", parentId, ctx, {
    label: caption,
    children: [imgId],
    attributes: { ...createEmptyAttributes(), src, href },
    readingDepth,
  });

  ctx.elementToNodeId.set(element, id);
  return id;
}

function promoteLinkedImageDeep(
  element: Element,
  ctx: BuildContext,
): { element: Element; isFigure: boolean } | null {
  const tag = element.tagName.toLowerCase();
  const isAlreadyFigure = tag === "figure";

  if (isAlreadyFigure) {
    const img = element.querySelector("img, picture > img");
    if (!img) return null;
    const fig = element.ownerDocument!.createElement("figure");
    fig.setAttribute(
      "data-ir-figure-href",
      element.querySelector("a")?.getAttribute("href") || "",
    );
    fig.setAttribute("data-ir-src", img.getAttribute("src") || "");
    if (img.getAttribute("alt"))
      fig.setAttribute("alt", img.getAttribute("alt")!);
    const caption = element.querySelector(
      "figcaption, .caption, .devsite-landing-row-item-description-content",
    );
    if (caption) fig.appendChild(caption.cloneNode(true) as Element);
    return { element: fig, isFigure: true };
  }

  const isWrapperDiv = tag === "div";
  const isAnchorTag = tag === "a";

  let anchor = isWrapperDiv
    ? Array.from(element.children).find((c) => c.tagName.toLowerCase() === "a")
    : isAnchorTag
      ? element
      : null;

  if (!anchor) return null;

  let imgEl =
    anchor.querySelector("img") || anchor.querySelector("picture > img");
  if (!imgEl) return null;

  const fig = anchor.ownerDocument!.createElement("figure");
  fig.setAttribute("data-ir-figure-href", anchor.getAttribute("href") || "");
  fig.setAttribute("data-ir-src", imgEl.getAttribute("src") || "");
  if (imgEl.getAttribute("alt"))
    fig.setAttribute("alt", imgEl.getAttribute("alt")!);

  const desc = element.querySelector(
    ".devsite-landing-row-item-description-content, figcaption, .caption",
  );
  if (desc) fig.appendChild(desc.cloneNode(true) as Element);
  return { element: fig, isFigure: true };
}

async function createListItem(
  element: Element,
  parentId: string,
  landmarkParentId: string,
  ctx: BuildContext,
  readingDepth: number,
): Promise<string> {
  const id = `${parentId}-item-${ctx.counters.node++}`;

  function pierceWrappers(el: Element): {
    content: Element;
    wrappers: Element[];
  } {
    const wrappers: Element[] = [];
    let current = el;
    while (true) {
      const tag = current.tagName.toLowerCase();
      const isMeaningfulTagOrHasRole =
        (tag !== "div" && tag !== "span") || current.hasAttribute("role");
      if (isMeaningfulTagOrHasRole) break;

      const children = getValidChildren(current, ctx.skipTags);
      const isNotSingleChildChain = children.length !== 1;
      if (isNotSingleChildChain) break;

      wrappers.push(current);
      current = children[0];
    }
    return { content: current, wrappers };
  }

  const { content: contentEl, wrappers } = pierceWrappers(element);
  const childIds = await buildChildrenFromSiblings(
    getValidChildren(contentEl, ctx.skipTags),
    id,
    landmarkParentId,
    ctx,
    readingDepth + 1,
    false,
  );

  // Synthesize a text child for plain-text list items (e.g. <li>Hello world</li>
  // with no element children). Mirrors what createNode does for text-bearing roles
  // so XRListItem always has children and the engine can treat it uniformly.
  let hasSynthTextChild = false;
  if (childIds.length === 0) {
    const rawText = contentEl.textContent?.trim() ?? "";
    if (rawText) {
      const textId = `${id}-synth-text-${ctx.counters.node++}`;
      ctx.nodes[textId] = createBaseNode(textId, "text", id, ctx, {
        content: rawText,
        label: rawText,
        source: "inline",
        confidence: ctx.config.sourceConfidence["inline"],
        readingDepth: readingDepth + 1,
        attributes: { ...createEmptyAttributes() },
      });
      childIds.push(textId);
      hasSynthTextChild = true;
    }
  }

  const mergedAttrs = readNodeAttributes(contentEl, { sourceUrl: ctx.pageUrl });
  for (const wrapper of wrappers) {
    const wrapperAttrs = readNodeAttributes(wrapper, {
      sourceUrl: ctx.pageUrl,
    });
    for (const key of Object.keys(wrapperAttrs) as (keyof IRNodeAttributes)[])
      assignIfDefined(mergedAttrs, key, wrapperAttrs[key]);
  }

  ctx.nodes[id] = createBaseNode(id, "listitem", parentId, ctx, {
    label:
      resolveNodeLabel(contentEl, ctx.config, ctx.doc) ||
      resolveNodeLabel(element, ctx.config, ctx.doc),
    content: hasSynthTextChild ? null : contentEl.textContent?.trim() || null,
    children: childIds,
    state: readNodeState(contentEl),
    attributes: mergedAttrs,
    readingDepth,
  });

  ctx.elementToNodeId.set(element, id);
  return id;
}

async function handleListRun(
  siblings: Element[],
  index: number,
  parentId: string,
  landmarkParentId: string,
  ctx: BuildContext,
  readingDepth: number,
): Promise<{ id: string; endIndex: number } | null> {
  const first = peelSibling(siblings[index], ctx).element;

  const isInvalidListCandidate = !isListCandidate(first, ctx.config);
  if (isInvalidListCandidate) return null;

  const firstSig = getSemanticSignature(first, ctx);
  if (!firstSig) return null;

  const { run, endIndex } = collectSiblingRun(
    siblings,
    index,
    ctx,
    peelSibling,
    (candidate) => {
      const isNotListCandidate = !isListCandidate(candidate, ctx.config);
      if (isNotListCandidate) return false;

      const isStructurallyDifferent = !areStructurallySimilar(
        first,
        candidate,
        ctx,
      );
      if (isStructurallyDifferent) {
        const candidateSig = getSemanticSignature(candidate, ctx);
        if (!candidateSig) return false;
        if (candidateSig !== firstSig) {
          // Allow signatures that differ by at most one optional role —
          // e.g. "article" vs "article|paragraph" when some cards lack a
          // description paragraph. Symmetric difference > 1 means the
          // elements are genuinely different content types.
          const firstParts = firstSig.split("|");
          const candidateParts = candidateSig.split("|");
          const firstSet = new Set(firstParts);
          const candidateSet = new Set(candidateParts);
          const symmetricDiff =
            firstParts.filter((r) => !candidateSet.has(r)).length +
            candidateParts.filter((r) => !firstSet.has(r)).length;
          if (symmetricDiff > 1) return false;
        }
      }

      const hasMeaningfulContent = !!(
        candidate.textContent?.trim() || candidate.children.length > 0
      );
      return hasMeaningfulContent;
    },
  );

  const isBelowMinimumRunLength = run.length < ctx.config.minListRun;
  if (isBelowMinimumRunLength) return null;

  const listId = `${parentId}-list-${ctx.counters.section++}`;
  const listChildren = await Promise.all(
    run.map((item) =>
      createListItem(item, listId, landmarkParentId, ctx, readingDepth + 1),
    ),
  );

  ctx.nodes[listId] = createBaseNode(listId, "list", parentId, ctx, {
    children: listChildren,
    attributes: { ...createEmptyAttributes(), listType: "unordered" },
    readingDepth,
  });
  return { id: listId, endIndex };
}

async function handleLinkRun(
  siblings: Element[],
  index: number,
  parentId: string,
  landmarkParentId: string,
  ctx: BuildContext,
  readingDepth: number,
): Promise<{ id: string; endIndex: number } | null> {
  const { run, endIndex } = collectSiblingRun(
    siblings,
    index,
    ctx,
    peelSibling,
    (candidate) => candidate.tagName.toLowerCase() === "a",
  );

  const isBelowMinimumRunLength = run.length < ctx.config.minLinkRun;
  if (isBelowMinimumRunLength) return null;

  // Same-page anchor runs (href="#section") are in-article TOC fragments, not
  // site navigation. Grouping them into an XRNavigationBar causes them to land
  // inside the content panel at its full width and render as a horizontal chip
  // strip. Return null so each <a> falls through to individual XRLink nodes.
  const allSamePageAnchors = run.every((el) =>
    (el.getAttribute("href") ?? "").startsWith("#"),
  );
  if (allSamePageAnchors) return null;

  const navId = `${parentId}-nav-${ctx.counters.section++}`;
  const navChildren = (
    await Promise.all(
      run.map((item) =>
        createNode(item, navId, landmarkParentId, ctx, {}, readingDepth + 1),
      ),
    )
  ).flat();
  const inferredLabel = ctx.nodes[parentId]?.label ?? "Navigation";

  ctx.landmarkRecords.push({
    id: navId,
    label: inferredLabel,
    parentId: landmarkParentId,
  });
  ctx.nodes[navId] = createBaseNode(navId, "navigation", parentId, ctx, {
    label: inferredLabel,
    unlabelledYet: false,
    landmark: true,
    children: navChildren,
    readingDepth,
  });

  return { id: navId, endIndex };
}

async function handleParagraphRun(
  siblings: Element[],
  index: number,
  parentId: string,
  landmarkParentId: string,
  ctx: BuildContext,
  readingDepth: number,
): Promise<{ id: string; endIndex: number } | null> {
  const { run, endIndex } = collectSiblingRun(
    siblings,
    index,
    ctx,
    peelSibling,
    (candidate) => candidate.tagName.toLowerCase() === "p",
  );

  const isBelowMinimumRunLength = run.length < ctx.config.minParagraphRun;
  if (isBelowMinimumRunLength) return null;

  const articleId = `${parentId}-article-${ctx.counters.section++}`;
  const articleChildren = (
    await Promise.all(
      run.map((item) =>
        createNode(
          item,
          articleId,
          landmarkParentId,
          ctx,
          {},
          readingDepth + 1,
        ),
      ),
    )
  ).flat();

  ctx.nodes[articleId] = createBaseNode(articleId, "article", parentId, ctx, {
    children: articleChildren,
    readingDepth,
  });
  return { id: articleId, endIndex };
}

async function buildChildrenFromSiblings(
  siblings: Element[],
  parentId: string,
  landmarkParentId: string,
  ctx: BuildContext,
  readingDepth = 0,
  parentIsLandmark = false,
): Promise<string[]> {
  const childIds: string[] = [];
  let index = 0;

  while (index < siblings.length) {
    const { element: child, liftedAttrs } = peelSibling(siblings[index], ctx);
    const tag = child.tagName.toLowerCase();

    const isHiddenAndExcluded =
      ctx.config.excludeHiddenContent && isAccessibilityHidden(child);
    const isSkippedTag = ctx.skipTags.has(tag);

    const shouldIgnoreNode = isHiddenAndExcluded || isSkippedTag;
    if (shouldIgnoreNode) {
      index += 1;
      continue;
    }

    const isMediaLeaf = tag === "svg" || tag === "canvas";
    if (isMediaLeaf) {
      childIds.push(
        handleMediaLeaf(child, liftedAttrs, parentId, ctx, readingDepth),
      );
      index += 1;
      continue;
    }

    const roleInfo = resolveRoleFromElement(child, ctx.config);

    const isMainLandmark = roleInfo.role === "main";
    if (isMainLandmark) {
      childIds.push(
        ...(await buildChildrenFromSiblings(
          getValidChildren(child, ctx.skipTags),
          parentId,
          landmarkParentId,
          ctx,
          readingDepth,
        )),
      );
      index += 1;
      continue;
    }

    const isExplicitSectionOrLandmarkRole =
      tag === "section" || LANDMARK_ROLES.has(roleInfo.role);
    if (isExplicitSectionOrLandmarkRole) {
      const isTopLevelPageLandmarkType =
        ["banner", "contentinfo"].includes(roleInfo.role) ||
        ["header", "footer"].includes(tag);

      if (isTopLevelPageLandmarkType) {
        index += 1;
        continue;
      }
      childIds.push(
        await handleLandmark(
          child,
          liftedAttrs,
          parentId,
          landmarkParentId,
          ctx,
          readingDepth,
        ),
      );
      index += 1;
      continue;
    }

    if (ctx.config.useStructuralInference) {
      let result = null;
      if (roleInfo.role === "heading")
        result = await handleHeadingSection(
          siblings,
          index,
          parentId,
          landmarkParentId,
          ctx,
          readingDepth,
          parentIsLandmark,
        );
      else if (tag === "p")
        result = await handleParagraphRun(
          siblings,
          index,
          parentId,
          landmarkParentId,
          ctx,
          readingDepth,
        );
      else if (tag === "a")
        result = await handleLinkRun(
          siblings,
          index,
          parentId,
          landmarkParentId,
          ctx,
          readingDepth,
        );
      else
        result = await handleListRun(
          siblings,
          index,
          parentId,
          landmarkParentId,
          ctx,
          readingDepth,
        );

      if (result) {
        childIds.push(result.id);
        index = result.endIndex;
        continue;
      }
    }

    // Layout table: pierce the table and process its cell contents as flat
    // block siblings. This handles pages (e.g. HN) that use single-column
    // <table> elements as page-layout wrappers rather than data tables.
    if (tag === "table" && isLayoutTable(child)) {
      const cellContents = getLayoutTableCellContents(child, ctx.skipTags);
      if (cellContents.length > 0) {
        const innerIds = await buildChildrenFromSiblings(
          cellContents,
          parentId,
          landmarkParentId,
          ctx,
          readingDepth,
        );
        childIds.push(...innerIds);
        index += 1;
        continue;
      }
    }

    const createdIds = await createNode(
      child,
      parentId,
      landmarkParentId,
      ctx,
      liftedAttrs,
      readingDepth,
    );
    Array.isArray(createdIds)
      ? childIds.push(...createdIds)
      : childIds.push(createdIds);
    index += 1;
  }

  return childIds;
}

function buildLandmarkTree(
  rootLabel: string | null,
  records: LandmarkRecord[],
): LandmarkTOCNode {
  const childrenByParent = new Map<string, LandmarkRecord[]>();
  for (const record of records) {
    const bucket = childrenByParent.get(record.parentId);
    if (bucket) bucket.push(record);
    else childrenByParent.set(record.parentId, [record]);
  }

  const buildChildren = (parentId: string): LandmarkTOCNode[] =>
    (childrenByParent.get(parentId) ?? []).map((record) => ({
      id: record.id,
      label: record.label,
      children: buildChildren(record.id),
    }));

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

function pruneUIChrome(doc: Document): void {
  const PRUNE_SELECTORS = [
    ".mw-editsection",
    ".mw-editsection-bracket",
    ".mw-jump-link",
    ".mw-cite-backlink",
    ".reference",
    ".noprint",
    ".mw-ui-button",
    "#toc",
    "#catlinks",
    ".catlinks",
    ".navbox",
    ".sistersitebox",
    ".metadata",
    // Wikipedia Vector-2022 skin chrome that lives *inside* <main>, as
    // siblings of the real article body (#bodyContent) rather than outside
    // it — pruning the outer skip-to-main slice doesn't remove these, so
    // without this they get paginated ahead of the article as blank pages.
    ".vector-page-titlebar-toc",
    "#p-lang-btn",
    ".vector-page-toolbar",
    ".vector-column-end",
    "svg[aria-hidden='true']",
    "img[aria-hidden='true']",
    "span[aria-hidden='true']:empty",
    ".Z3988",
    "span[title^='ctx_ver=']",
    "style",
    "script",
  ];
  for (const sel of PRUNE_SELECTORS) {
    try {
      doc.querySelectorAll(sel).forEach((el) => el.parentNode?.removeChild(el));
    } catch {}
  }
}

function findSkipToMainTarget(doc: Document): string | null {
  const SKIP_TEXT = [
    /skip\s+(to\s+)?(main\s+)?content/i,
    /skip\s+navigation/i,
    /jump\s+to\s+(main\s+)?content/i,
    /skip\s+(to\s+)?content/i,
  ];
  const candidates = Array.from(doc.querySelectorAll('a[href^="#"]')).slice(
    0,
    8,
  );

  for (const a of candidates) {
    const hasSkipText = SKIP_TEXT.some((p) =>
      p.test(a.textContent?.trim() ?? ""),
    );
    const hasSkipClass = /skip[-_]?(link|nav|to|content)/i.test(
      a.getAttribute("class") ?? "",
    );

    const isMainSkipLinkTarget = hasSkipText || hasSkipClass;
    if (isMainSkipLinkTarget) {
      return (a.getAttribute("href") ?? "").slice(1) || null;
    }
  }
  return null;
}

async function buildExternalLinksSection(
  doc: Document,
  mainChildIds: string[],
  ctx: BuildContext,
): Promise<void> {
  const containers = Array.from(
    doc.querySelectorAll(
      'header, footer, [role="banner"], [role="contentinfo"]',
    ),
  );
  if (containers.length === 0) return;

  const seen = new Set<string>();
  const links: Element[] = [];

  for (const container of containers) {
    for (const a of Array.from(container.querySelectorAll("a[href]"))) {
      const text = a.textContent?.trim() ?? "";
      const href = a.getAttribute("href") ?? "";
      const key = `${href}|${text}`;
      if (text && !seen.has(key)) {
        seen.add(key);
        links.push(a as Element);
      }
    }
  }

  if (links.length === 0) return;

  const sectionId = `main-section-${ctx.counters.section++}`;
  const listId = `${sectionId}-list-${ctx.counters.section++}`;
  const listChildren = await Promise.all(
    links.map((link) => createListItem(link, listId, "main", ctx, 2)),
  );
  ctx.nodes[listId] = createBaseNode(listId, "list", sectionId, ctx, {
    children: listChildren,
    attributes: { ...createEmptyAttributes(), listType: "unordered" },
    readingDepth: 1,
  });
  const linkChildren = [listId];

  ctx.landmarkRecords.push({
    id: sectionId,
    label: "External Links",
    parentId: "main",
  });
  ctx.nodes[sectionId] = createBaseNode(sectionId, "region", "main", ctx, {
    label: "External Links",
    unlabelledYet: false,
    landmark: true,
    children: linkChildren,
  });

  mainChildIds.push(sectionId);
}

export const parsePageToIR = async (
  htmlString: string,
  url: string,
  fallbackProvider: AIFallbackProvider = new StubAIProvider(),
  config: ParserConfig = DEFAULT_CONFIG,
): Promise<PageIR> => {
  const parser = new DOMParser();
  const parsedDoc = parser.parseFromString(htmlString, "text/html");

  pruneUIChrome(parsedDoc);

  const skipTags = new Set(SKIP_TAGS);
  if (config.includeSvg) skipTags.delete("svg");
  if (config.includeCanvas) skipTags.delete("canvas");

  const wrapperTags = new Set([
    ...WRAPPER_TAGS,
    ...config.extraWrapperTags.map((t) => t.toLowerCase()),
  ]);
  const allBodyChildren = getValidChildren(parsedDoc.body, skipTags);

  let bodyChildren: Element[] = allBodyChildren;
  const skipTargetId = findSkipToMainTarget(parsedDoc);

  if (skipTargetId) {
    const skipTarget = parsedDoc.getElementById(skipTargetId);
    if (skipTarget) {
      let ancestor: Element | null = skipTarget;
      while (ancestor && ancestor.parentElement !== parsedDoc.body)
        ancestor = ancestor.parentElement;
      const sliceIndex = allBodyChildren.indexOf(
        (ancestor ?? skipTarget) as Element,
      );
      if (sliceIndex >= 0) bodyChildren = allBodyChildren.slice(sliceIndex);
    }
  } else {
    const mainEl = parsedDoc.querySelector('main, [role="main"]');
    if (mainEl && mainEl.parentElement === parsedDoc.body) {
      const sliceIndex = allBodyChildren.indexOf(mainEl as Element);
      if (sliceIndex >= 0) bodyChildren = allBodyChildren.slice(sliceIndex);
    } else if (mainEl) {
      // <main> isn't a direct child of <body> (e.g. MediaWiki's Vector skin
      // nests it several containers deep alongside sidebar/toolbar chrome
      // that are its own siblings, not body-level siblings we can slice
      // around). Descend into <main> itself so only its children — not the
      // surrounding page shell — become page content.
      bodyChildren = getValidChildren(mainEl, skipTags);
    }
  }

  const nodes: Record<string, IRNode> = {};
  const fallbackLog: IRFallbackEntry[] = [];
  const landmarkRecords: LandmarkRecord[] = [];

  const READING_BODY = 0;
  const READING_TOC = 1;
  const READING_MAIN = 2;

  const ctx: BuildContext = {
    nodes,
    landmarkRecords,
    doc: parsedDoc,
    counters: { node: 0, section: 0, reading: 3 },
    elementToNodeId: new WeakMap<Element, string>(),
    fallbackProvider,
    fallbackLog,
    config,
    skipTags,
    wrapperTags,
    inlineTags: new Set(INLINE_TAGS),
    pageUrl: url,
  };

  ctx.elementToNodeId.set(parsedDoc.body, "main");
  const mainChildIds = await buildChildrenFromSiblings(
    bodyChildren,
    "main",
    "main",
    ctx,
  );
  await buildExternalLinksSection(parsedDoc, mainChildIds, ctx);

  const parsedTitle = parsedDoc.title?.trim() || null;
  landmarkRecords.push({
    id: "main",
    label: parsedTitle ?? "main",
    parentId: "landmarks",
  });

  nodes["toc"] = createBaseNode("toc", "navigation", "main", ctx, {
    label: "Table of contents",
    unlabelledYet: false,
    landmark: true,
    readingIndex: READING_TOC,
  });

  nodes["main"] = createBaseNode("main", "main", "landmarks", ctx, {
    label: parsedTitle ?? "main",
    unlabelledYet: parsedTitle === null,
    landmark: true,
    readingIndex: READING_MAIN,
    children: ["toc", ...mainChildIds],
  });

  hydrateRelations(nodes, parsedDoc, ctx.elementToNodeId);

  const allNodes = Object.values(nodes);
  let orderedNodes: IRNode[];

  if (config.readingOrderStrategy === "landmark-first") {
    orderedNodes = [
      ...allNodes
        .filter((n) => n.landmark)
        .sort((a, b) => a.readingIndex - b.readingIndex),
      ...allNodes
        .filter((n) => !n.landmark)
        .sort((a, b) => a.readingIndex - b.readingIndex),
    ];
  } else if (config.readingOrderStrategy === "flowto-aware") {
    const nodeMap = new Map(allNodes.map((n) => [n.id, n]));
    const visited = new Set<string>();
    const result: IRNode[] = [];
    const visit = (node: IRNode): void => {
      if (visited.has(node.id)) return;
      visited.add(node.id);
      result.push(node);
      node.relations.flowTo.forEach((id) => {
        if (nodeMap.get(id)) visit(nodeMap.get(id)!);
      });
    };
    [...allNodes]
      .sort((a, b) => a.readingIndex - b.readingIndex)
      .forEach(visit);
    orderedNodes = result;
  } else {
    orderedNodes = allNodes.sort((a, b) => a.readingIndex - b.readingIndex);
  }

  const analytics: IRAnalytics = {
    headingCount: 0,
    landmarkCount: 0,
    controlCount: 0,
    sectionCount: 0,
    textDensity: 0,
    wordCount: 0,
    textLength: 0,
    childCount: 0,
    liveRegionCount: 0,
  };

  for (const node of orderedNodes) {
    if (node.role === "heading") analytics.headingCount += 1;
    if (node.landmark) analytics.landmarkCount += 1;
    if (INTERACTIVE_ROLES.has(node.role)) analytics.controlCount += 1;
    if (node.role === "region") analytics.sectionCount += 1;
    const text = node.label ?? "";
    analytics.textLength += text.length;
    analytics.wordCount += text ? text.split(/\s+/).filter(Boolean).length : 0;
    analytics.childCount += node.children.length;
    if (node.attributes.live) analytics.liveRegionCount += 1;
  }
  analytics.textDensity =
    orderedNodes.length > 0 ? analytics.textLength / orderedNodes.length : 0;
  return {
    meta: {
      url,
      title: parsedTitle,
      lang: parsedDoc.documentElement.getAttribute("lang") || null,
      parsedAt: new Date().toISOString(),
      config,
    },
    landmarks: buildLandmarkTree(parsedTitle, landmarkRecords),
    root: "main",
    fallbackLog,
    analytics,
    readingOrder: orderedNodes.map((node) => node.id),
    nodes,
  };
};
