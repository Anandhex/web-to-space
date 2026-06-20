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
  IRSource,
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
  createEmptyRelations,
  readNodeState,
  mergeAttributes,
  isAccessibilityHidden,
  createEmptyState,
  createEmptyAttributes,
  isListCandidate,
  hydrateRelations,
} from "./utils";

import {
  shouldDecomposeContent,
  decomposeInlineContentRecursive,
  createInlineNodes,
  type InlineContext,
} from "./inline-parser";

/**
 * Stub provider — always returns null so the node stays "generic".
 * Replace with a real implementation for Layer 3 classification.
 */
export class StubAIProvider implements AIFallbackProvider {
  async classify(
    _domSubtree: string,
    _nodeId: string,
  ): Promise<AIFallbackResponse | null> {
    return null; // ai-fallback-value: no classification attempted
  }
}

/** Serialise a DOM subtree to a compact string for the AI prompt. */
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
  // Heading fallback is structural — active regardless of useAriaLabels.
  // Only direct children are considered — headings nested inside sub-sections
  // belong to those sub-sections, not to this one.
  // A heading level is only used as a label when exactly one direct-child
  // heading at that level exists — multiple siblings (e.g. h2, h2, h2)
  // indicate repeated items rather than a section title, so that level is
  // skipped and the search continues at the next level down.
  if (element) {
    for (let level = 1; level <= 6; level++) {
      const tag = `h${level}`;
      const headings = Array.from(element.children).filter(
        (c) => c.tagName.toLowerCase() === tag,
      );
      if (headings.length === 1) {
        const text = headings[0].textContent?.trim();
        if (text) return cap(text);
      }
      // headings.length === 0 → no direct-child headings at this level, try next
      // headings.length > 1  → repeated, not a section title, try next
    }
  }
  return fallbackLabel;
}

function isInertWrapper(element: Element, ctx: BuildContext): boolean {
  const tag = element.tagName.toLowerCase();
  if (!ctx.wrapperTags.has(tag)) return false;
  if (element.hasAttribute("role")) return false;
  if (element.hasAttribute("aria-label")) return false;
  if (element.hasAttribute("id")) return false;

  // FIX: Protect elements that developers have explicitly made focusable/interactive
  if (element.hasAttribute("tabindex")) return false;

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
  for (const attr of ariaAttrs) {
    if (element.hasAttribute(attr)) return false;
  }
  return true;
}

function pierceWrapperChain(
  element: Element,
  ctx: BuildContext,
): {
  element: Element;
  liftedAttrs: Partial<IRNodeAttributes>;
} {
  // When wrapper piercing is disabled return immediately
  if (!ctx.config.useWrapperPiercing) {
    return { element, liftedAttrs: {} };
  }

  const liftedAttrs: Partial<IRNodeAttributes> = {};
  let current = element;

  while (true) {
    const tag = current.tagName.toLowerCase();
    if (!ctx.wrapperTags.has(tag)) break;

    if (
      current.hasAttribute("role") ||
      current.hasAttribute("aria-label") ||
      current.hasAttribute("id")
    ) {
      break;
    }

    // Lift any ARIA attributes from this wrapper before piercing it
    const snap = readNodeAttributes(current, { sourceUrl: ctx.pageUrl });
    for (const key of Object.keys(snap) as (keyof IRNodeAttributes)[]) {
      assignIfDefined(liftedAttrs, key, snap[key]);
    }

    // FIX: Check if the element contains direct text nodes that would be lost
    const hasText = directTextContent(current).length > 0;

    const children = Array.from(current.children).filter(
      (child) => !ctx.skipTags.has(child.tagName.toLowerCase()),
    );

    // Stop piercing if there is text content OR if there isn't exactly one element child
    if (hasText || children.length !== 1) {
      return { element: current, liftedAttrs };
    }

    current = children[0];
  }

  return { element: current, liftedAttrs };
}

function childSignature(element: Element): string {
  return [
    element.tagName.toLowerCase(),
    element.getAttribute("role") ?? "",
    element.getAttribute("class") ?? "",
  ].join("|");
}

// ---------------------------------------------------------------------------
// Mixed-content normalisation
// ---------------------------------------------------------------------------

/**
 * Normalise the direct children of `element` for parser consumption.
 *
 * The DOM distinguishes element nodes from text nodes, but `element.children`
 * only returns the former. This means mixed content like:
 *
 *   "Get up to speed with <a href="/baseline">Baseline</a>."
 *
 * loses the surrounding text entirely when we iterate `element.children`.
 *
 * This function walks `element.childNodes` and:
 * 1. Collects consecutive non-empty text nodes and inline elements into a
 *    "prose run".
 * 2. When a block-level element is encountered it flushes the current prose
 *    run (if any) as a synthetic `<span data-ir-prose>` element, then emits
 *    the block element directly.
 * 3. Any remaining prose run after the last block element is also flushed.
 *
 * The resulting array is a flat list of Elements that `buildChildrenFromSiblings`
 * can process as normal siblings — prose runs become `generic`/`paragraph`
 * nodes whose label resolves from their full text content, and block elements
 * are parsed as usual.
 *
 * If the element has no text nodes and no inline elements mixed with blocks
 * (i.e. pure block content) the output is identical to `Array.from(element.children)`.
 */
function normaliseChildContent(
  element: Element,
  skipTags: Set<string>,
): Element[] {
  if (element.hasAttribute("data-ir-prose")) {
    return Array.from(element.children).filter(
      (child) => !skipTags.has(child.tagName.toLowerCase()),
    );
  }

  const result: Element[] = [];
  let proseNodes: ChildNode[] = [];

  // FIX: Track if we actually need to split mixed content
  let hasBlockElements = false;

  const flushProse = (): void => {
    const hasContent = proseNodes.some((n) => {
      if (n.nodeType === Node.TEXT_NODE)
        return (n.textContent ?? "").trim().length > 0;
      return true;
    });

    if (!hasContent) {
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

    if (INLINE_TAGS.has(tag)) {
      proseNodes.push(el);
    } else {
      hasBlockElements = true; // Block element found!
      flushProse();
      result.push(el);
    }
  }

  flushProse();

  // FIX: If there are no block elements, the parent itself is the prose container.
  // Do not emit synthetic wrappers. Just return the standard element children (e.g., inline <a> tags).
  if (!hasBlockElements) {
    return Array.from(element.children).filter(
      (child) => !skipTags.has(child.tagName.toLowerCase()),
    );
  }

  return result;
}

// parser.ts - Updated createNode with proper ordering

async function createNode(
  element: Element,
  parentId: string,
  landmarkParentId: string,
  ctx: BuildContext,
  liftedAttrs: Partial<IRNodeAttributes> = {},
  readingDepth = 0,
): Promise<string> {
  const id = `${parentId}-node-${ctx.counters.node++}`;
  const readingIndex = ctx.counters.reading++;

  ctx.elementToNodeId.set(element, id);

  // ── STEP 1: Determine base role from element ──────────────────────────
  // This includes explicit role attributes and structural tag mapping
  let roleInfo = resolveRoleFromElement(element, ctx.config);
  let resolvedRole = roleInfo.role;
  let resolvedSource: IRSource = roleInfo.source;
  let resolvedConfidence = confidenceForSource(roleInfo.source, ctx.config);

  // ── STEP 2: Check if this is a generic div/span with only text ────────
  // If it's a generic wrapper with only text content, treat it as a text node
  const tag = element.tagName.toLowerCase();
  const isGenericWrapper = tag === "div" || tag === "span";
  const hasOnlyText = hasOnlyTextContent(element, ctx);

  if (isGenericWrapper && hasOnlyText && resolvedRole === "generic") {
    // This is just a text container - create a text node directly
    const text = element.textContent?.trim() || "";
    if (text) {
      const textId = `${parentId}-text-${ctx.counters.node++}`;
      ctx.nodes[textId] = {
        id: textId,
        role: "text",
        level: null,
        label: null,
        content: text,
        unlabelledYet: true,
        landmark: false,
        source: "inline",
        confidence: ctx.config.sourceConfidence["inline"] || 0.9,
        readingIndex: ctx.counters.reading++,
        readingDepth,
        parent: parentId,
        children: [],
        relations: createEmptyRelations(),
        state: createEmptyState(),
        attributes: {
          ...createEmptyAttributes(),
          componentType: tag,
        },
      };
      return textId;
    }
  }

  // ── STEP 3: Process children (build the tree) ──────────────────────────
  // This must happen BEFORE AI fallback because AI should only run on
  // nodes that have been fully processed structurally

  // Check if this node has block children
  const childElements = Array.from(element.children).filter(
    (child) => !ctx.skipTags.has(child.tagName.toLowerCase()),
  );

  const hasBlockChildren = childElements.some(
    (child) => !ctx.inlineTags.has(child.tagName.toLowerCase()),
  );

  const children: string[] = [];
  let textNodes: string[] = [];
  let hasBlockChild = false;

  if (!hasBlockChildren && childElements.length > 0) {
    // Leaf node with only inline children - check for mixed content
    const shouldDecompose = shouldDecomposeContent(element, {
      inlineTags: ctx.inlineTags,
      skipTags: ctx.skipTags,
      config: ctx.config,
      doc: ctx.doc,
      pageUrl: ctx.pageUrl,
    });

    if (shouldDecompose) {
      // Decompose mixed content
      const runs = decomposeInlineContentRecursive(
        element,
        {
          inlineTags: ctx.inlineTags,
          skipTags: ctx.skipTags,
          config: ctx.config,
          doc: ctx.doc,
          pageUrl: ctx.pageUrl,
        },
        id,
      );

      const result = createInlineNodes(runs, id, ctx, readingDepth + 1);
      children.push(...result.nodeIds);
      textNodes = result.textRuns;
      hasBlockChild = false;
    } else {
      // No mixed content - normal processing
      const childIds = await buildChildrenFromSiblings(
        childElements,
        id,
        landmarkParentId,
        ctx,
        readingDepth,
      );
      children.push(...childIds);
      hasBlockChild = false;
    }
  } else if (hasBlockChildren) {
    // Has block children - process normally
    const normalisedChildren = normaliseChildContent(element, ctx.skipTags);
    const childIds = await buildChildrenFromSiblings(
      normalisedChildren,
      id,
      landmarkParentId,
      ctx,
      readingDepth,
    );
    children.push(...childIds);
    hasBlockChild = true;
  }

  // ── STEP 4: Label resolution (after structural processing) ─────────────
  // Only resolve labels for nodes that need them
  const label = resolveNodeLabelSmart(
    element,
    resolvedRole,
    ctx.config,
    ctx.doc,
  );

  // ── STEP 5: AI Fallback (ABSOLUTELY LAST) ──────────────────────────────
  // Only run AI fallback if:
  // 1. AI fallback is enabled in config
  // 2. The node is still 'generic' (or low confidence)
  // 3. The node has meaningful content (not just a wrapper)
  // 4. The node has children or content to classify
  const hasContent =
    children.length > 0 || textNodes.length > 0 || element.textContent?.trim();

  if (
    ctx.config.useAIFallback &&
    resolvedConfidence < ctx.config.aiFallbackThreshold &&
    resolvedRole === "generic" &&
    hasContent &&
    !isGenericWrapper // Don't run AI on generic wrappers - they're just text containers
  ) {
    const subtree = serialiseDOMSubtree(element, ctx.skipTags);
    const tag = element.tagName.toLowerCase();

    try {
      const aiResult = await ctx.fallbackProvider.classify(subtree, id);
      if (
        aiResult !== null &&
        aiResult.confidence >= ctx.config.aiFallbackThreshold
      ) {
        // Only apply AI result if it improves the role
        const currentConfidence = confidenceForSource(
          resolvedSource,
          ctx.config,
        );
        if (aiResult.confidence > currentConfidence) {
          resolvedRole = aiResult.role;
          resolvedSource = "ai";
          resolvedConfidence = aiResult.confidence;
        }
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

  // ── STEP 6: Determine content ────────────────────────────────────────────
  let content = null;
  if (!hasBlockChild) {
    content =
      textNodes.length > 0
        ? textNodes.join(" ")
        : (element.textContent?.trim() ?? null);
  }

  // ── STEP 7: Store the node ──────────────────────────────────────────────
  ctx.nodes[id] = {
    id,
    role: resolvedRole,
    level: roleInfo.level,
    label,
    unlabelledYet: label === null,
    landmark: LANDMARK_ROLES.has(resolvedRole),
    source: resolvedSource,
    confidence: resolvedConfidence,
    readingIndex,
    parent: parentId,
    children,
    relations: createEmptyRelations(),
    state: readNodeState(element),
    attributes: mergeAttributes(
      readNodeAttributes(element, { sourceUrl: ctx.pageUrl }),
      liftedAttrs,
    ),
    content,
    readingDepth,
  };

  return id;
}

// parser.ts - Updated smart label resolution

function resolveNodeLabelSmart(
  element: Element,
  role: IRRole,
  config: ParserConfig,
  doc?: Document,
): string | null {
  // ── Case 1: Generic wrappers with text content ──────────────────────────
  // Div/span with only text should NOT have labels
  const tag = element.tagName.toLowerCase();
  const isGenericWrapper = tag === "div" || tag === "span";
  if (isGenericWrapper && role === "generic") {
    // Check if it has only text content
    const hasOnlyText = !Array.from(element.children).some(
      (child) =>
        !["script", "style", "noscript"].includes(child.tagName.toLowerCase()),
    );
    if (hasOnlyText) {
      return null; // No label for generic text containers
    }
  }

  // ── Case 2: Text-bearing nodes ──────────────────────────────────────────
  const TEXT_BEARING = new Set(["paragraph", "heading", "text", "caption"]);

  if (TEXT_BEARING.has(role) && !config.useTextLabels) {
    return null;
  }

  // ── Case 3: Semantic containers ──────────────────────────────────────────
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

  if (SEMANTIC_CONTAINERS.has(role) && config.useSemanticLabels) {
    // Try to resolve a meaningful label
    const label = resolveNodeLabel(element, config, doc);
    if (label) return label;

    // For sections, try to find a heading
    if (role === "region" || role === "section") {
      const headings = Array.from(
        element.querySelectorAll("h1, h2, h3, h4, h5, h6"),
      );
      for (const heading of headings) {
        const headingText = heading.textContent?.trim();
        if (headingText) {
          return headingText.slice(0, config.labelMaxChars);
        }
      }
    }

    // Fallback to role-based label
    return `${role}`;
  }

  // ── Case 4: Interactive elements ──────────────────────────────────────────
  if (config.useAriaLabels) {
    const INTERACTIVE = new Set([
      "link",
      "button",
      "textbox",
      "searchbox",
      "checkbox",
      "radio",
      "combobox",
      "slider",
      "spinbutton",
      "switch",
      "tab",
      "menuitem",
      "option",
    ]);

    if (INTERACTIVE.has(role)) {
      return resolveNodeLabel(element, config, doc);
    }
  }

  // ── Case 5: Generic nodes with landmark status ────────────────────────────
  if (role === "generic" && LANDMARK_ROLES.has(role)) {
    return resolveNodeLabel(element, config, doc);
  }

  // ── Case 6: Default - try to resolve but be conservative ──────────────────
  // Only return label if it's meaningful (not just text content)
  const label = resolveNodeLabel(element, config, doc);

  // If the label is just the text content and it's a generic node, skip it
  if (role === "generic" && label === element.textContent?.trim()) {
    return null;
  }

  return label || null;
}

// Helper: Check if an element has ONLY text content (no elements)
function hasOnlyTextContent(element: Element, ctx: BuildContext): boolean {
  let hasText = false;

  for (const child of Array.from(element.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      const text = (child.textContent ?? "").trim();
      if (text) {
        hasText = true;
      }
    } else if (child.nodeType === Node.ELEMENT_NODE) {
      const el = child as Element;
      const tag = el.tagName.toLowerCase();
      // If it's not a skip tag and not an inline tag, it's a block element
      if (!ctx.skipTags.has(tag) && !ctx.inlineTags.has(tag)) {
        return false; // Has block child
      }
      // If it's an inline element, recursively check
      if (ctx.inlineTags.has(tag)) {
        // Recursively check if this inline element has only text
        const hasOnlyTextInInline = hasOnlyTextContent(el, ctx);
        if (!hasOnlyTextInInline) {
          return false;
        }
      }
    }
  }

  return hasText;
}

// ---------------------------------------------------------------------------
// buildChildrenFromSiblings — refactored
//
// The original single function is split into six focused handlers, each
// responsible for exactly one pattern-match case. The main loop becomes a
// dispatcher that tries each handler in priority order.
//
// Changes vs original:
//   1. peelSibling() helper deduplicates the isInertWrapper/pierceWrapperChain
//      pattern that appeared 8 times inline
//   2. handleLinkRun: label is now taken from ctx.nodes[parentId]?.label
//      rather than child.parentElement — the original always resolved to the
//      grandparent container, not a meaningful nav title
//   3. handleHeadingSection: uses siblings.slice() + map instead of a manual
//      index loop — cleaner and eliminates the sectionNodePromises array
// ---------------------------------------------------------------------------

// ── Shared peel helper ───────────────────────────────────────────────────────

function peelSibling(
  el: Element,
  ctx: BuildContext,
): { element: Element; liftedAttrs: Partial<IRNodeAttributes> } {
  return isInertWrapper(el, ctx)
    ? pierceWrapperChain(el, ctx)
    : { element: el, liftedAttrs: {} };
}

// ── Handler 1: SVG / canvas → img leaf ──────────────────────────────────────

function handleMediaLeaf(
  child: Element,
  liftedAttrs: Partial<IRNodeAttributes>,
  parentId: string,
  ctx: BuildContext,
  readingDepth: number,
): string {
  const id = `${parentId}-node-${ctx.counters.node++}`;
  const readingIndex = ctx.counters.reading++;
  const label = resolveNodeLabel(child, ctx.config, ctx.doc);
  ctx.elementToNodeId.set(child, id);
  ctx.nodes[id] = {
    id,
    role: "img",
    level: null,
    label,
    content: null,
    unlabelledYet: label === null,
    landmark: false,
    source: "structural",
    confidence: confidenceForSource("structural", ctx.config),
    readingIndex,
    parent: parentId,
    children: [],
    relations: createEmptyRelations(),
    state: createEmptyState(),
    attributes: mergeAttributes(
      readNodeAttributes(child, { sourceUrl: ctx.pageUrl }),
      liftedAttrs,
    ),
    readingDepth,
  };
  return id;
}

// ── Handler 2: landmark element → section node ──────────────────────────────

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
  const readingIndex = ctx.counters.reading++;

  // Register before descending so aria-controls/labelledby can resolve here
  ctx.elementToNodeId.set(child, landmarkId);

  const nestedChildren = await buildChildrenFromSiblings(
    Array.from(child.children).filter(
      (c) => !ctx.skipTags.has(c.tagName.toLowerCase()),
    ),
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

  ctx.nodes[landmarkId] = {
    id: landmarkId,
    role: roleInfo.role,
    level: roleInfo.level,
    label,
    content: child.textContent?.trim() ?? null,
    unlabelledYet: label === null,
    landmark: true,
    source: roleInfo.source,
    confidence: confidenceForSource(roleInfo.source, ctx.config),
    readingIndex,
    parent: parentId,
    children: nestedChildren,
    relations: createEmptyRelations(),
    state: readNodeState(child),
    attributes: mergeAttributes(
      readNodeAttributes(child, { sourceUrl: ctx.pageUrl }),
      liftedAttrs,
    ),
    readingDepth,
  };

  return landmarkId;
}

// ── Handler 3: heading + following siblings → inferred region ────────────────
//
// Returns { id, endIndex } if the heading has content to group, null if it
// stands alone (falls through to leaf node handling).

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
    if (
      lookaheadRole.role === "heading" &&
      (lookaheadRole.level ?? 0) <= headingLevel
    )
      break;

    if (
      lookahead.tagName.toLowerCase() === "section" ||
      LANDMARK_ROLES.has(lookaheadRole.role)
    )
      break; // ← add this

    endIndex += 1;
  }

  if (endIndex === index + 1) return null; // heading stands alone

  const headingCount = siblings.reduce((count, sib) => {
    const role = resolveRoleFromElement(
      peelSibling(sib, ctx).element,
      ctx.config,
    );

    return count + (role.role === "heading" ? 1 : 0);
  }, 0);

  if (parentIsLandmark && headingCount <= 1) {
    return null;
  }

  const sectionId = `${parentId}-section-${ctx.counters.section++}`;
  const readingIndex = ctx.counters.reading++;

  const sectionChildren = await Promise.all(
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
  );

  const label =
    resolveNodeLabel(child, ctx.config, ctx.doc) ??
    child.textContent?.trim() ??
    sectionId;

  ctx.landmarkRecords.push({
    id: sectionId,
    label,
    parentId: landmarkParentId,
  });

  ctx.nodes[sectionId] = {
    id: sectionId,
    role: "region",
    level: null,
    label,
    content: null,
    unlabelledYet: label === null,
    landmark: true,
    source: "structural",
    confidence: confidenceForSource("structural", ctx.config),
    readingIndex,
    parent: parentId,
    children: sectionChildren,
    relations: createEmptyRelations(),
    state: createEmptyState(),
    attributes: createEmptyAttributes(),
    readingDepth,
  };

  return { id: sectionId, endIndex };
}

// ── Handler 4: homogeneous run → inferred list ───────────────────────────────

async function handleListRun(
  siblings: Element[],
  index: number,
  parentId: string,
  landmarkParentId: string,
  ctx: BuildContext,
  readingDepth: number,
): Promise<{ id: string; endIndex: number } | null> {
  const first = peelSibling(siblings[index], ctx).element;
  if (!isListCandidate(first, ctx.config)) return null;

  const signature = childSignature(first);
  const run: Element[] = [];
  let scan = index;

  while (scan < siblings.length) {
    const candidate = peelSibling(siblings[scan], ctx).element;
    if (!isListCandidate(candidate, ctx.config)) break;
    if (childSignature(candidate) !== signature) break;
    run.push(candidate);
    scan += 1;
  }

  if (run.length < ctx.config.minListRun) return null;

  const listId = `${parentId}-list-${ctx.counters.section++}`;
  const readingIndex = ctx.counters.reading++;

  const listChildren = await Promise.all(
    run.map((item) =>
      createNode(item, listId, landmarkParentId, ctx, {}, readingDepth + 1),
    ),
  );

  ctx.nodes[listId] = {
    id: listId,
    role: "list",
    level: null,
    label: null,
    unlabelledYet: true,
    content: null,
    landmark: false,
    source: "structural",
    confidence: confidenceForSource("structural", ctx.config),
    readingIndex,
    parent: parentId,
    children: listChildren,
    relations: createEmptyRelations(),
    state: createEmptyState(),
    attributes: { ...createEmptyAttributes(), listType: "unordered" },
    readingDepth,
  };

  return { id: listId, endIndex: scan };
}

// ── Handler 5: <a>-run → inferred navigation landmark ────────────────────────
//
// FIX: label is resolved from the already-built parent node's own label rather
// than child.parentElement. The original used child.parentElement which is the
// same container element every time — it never contained a meaningful title.

async function handleLinkRun(
  siblings: Element[],
  index: number,
  parentId: string,
  landmarkParentId: string,
  ctx: BuildContext,
  readingDepth: number,
): Promise<{ id: string; endIndex: number } | null> {
  const run: Element[] = [];
  let scan = index;

  while (scan < siblings.length) {
    const candidate = peelSibling(siblings[scan], ctx).element;
    if (candidate.tagName.toLowerCase() !== "a") break;
    run.push(candidate);
    scan += 1;
  }

  if (run.length < ctx.config.minLinkRun) return null;

  const navId = `${parentId}-nav-${ctx.counters.section++}`;
  const readingIndex = ctx.counters.reading++;

  const navChildren = await Promise.all(
    run.map((item) =>
      createNode(item, navId, landmarkParentId, ctx, {}, readingDepth + 1),
    ),
  );

  const inferredLabel = ctx.nodes[parentId]?.label ?? "Navigation";

  ctx.landmarkRecords.push({
    id: navId,
    label: inferredLabel,
    parentId: landmarkParentId,
  });

  ctx.nodes[navId] = {
    id: navId,
    role: "navigation",
    level: null,
    label: inferredLabel,
    unlabelledYet: false,
    landmark: true,
    content: null,
    source: "structural",
    confidence: confidenceForSource("structural", ctx.config),
    readingIndex,
    parent: parentId,
    children: navChildren,
    relations: createEmptyRelations(),
    state: createEmptyState(),
    attributes: createEmptyAttributes(),
    readingDepth,
  };

  return { id: navId, endIndex: scan };
}

// ── Handler 6: <p>-run → inferred article body ───────────────────────────────

async function handleParagraphRun(
  siblings: Element[],
  index: number,
  parentId: string,
  landmarkParentId: string,
  ctx: BuildContext,
  readingDepth: number,
): Promise<{ id: string; endIndex: number } | null> {
  const run: Element[] = [];
  let scan = index;

  while (scan < siblings.length) {
    const candidate = peelSibling(siblings[scan], ctx).element;
    if (candidate.tagName.toLowerCase() !== "p") break;
    run.push(candidate);
    scan += 1;
  }

  if (run.length < ctx.config.minParagraphRun) return null;

  const articleId = `${parentId}-article-${ctx.counters.section++}`;
  const readingIndex = ctx.counters.reading++;

  const articleChildren = await Promise.all(
    run.map((item) =>
      createNode(item, articleId, landmarkParentId, ctx, {}, readingDepth + 1),
    ),
  );

  ctx.nodes[articleId] = {
    id: articleId,
    role: "article",
    level: null,
    label: null,
    content: null,
    unlabelledYet: true,
    landmark: false,
    source: "structural",
    confidence: confidenceForSource("structural", ctx.config),
    readingIndex,
    parent: parentId,
    children: articleChildren,
    relations: createEmptyRelations(),
    state: createEmptyState(),
    attributes: createEmptyAttributes(),
    readingDepth,
  };

  return { id: articleId, endIndex: scan };
}

// ── Main dispatcher ──────────────────────────────────────────────────────────

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

    if (ctx.config.excludeHiddenContent && isAccessibilityHidden(child)) {
      index += 1;
      continue;
    }
    if (ctx.skipTags.has(tag)) {
      index += 1;
      continue;
    }

    // Media short-circuit
    if (tag === "svg" || tag === "canvas") {
      childIds.push(
        handleMediaLeaf(child, liftedAttrs, parentId, ctx, readingDepth),
      );
      index += 1;
      continue;
    }

    // Landmark
    const roleInfo = resolveRoleFromElement(child, ctx.config);

    if (roleInfo.role === "main") {
      // The <main> element is owned by the synthetic root node in parsePageToIR.
      // Descend into it transparently without creating a new landmark node.
      const mainChildren = await buildChildrenFromSiblings(
        Array.from(child.children).filter(
          (c) => !ctx.skipTags.has(c.tagName.toLowerCase()),
        ),
        parentId, // keep current parent context
        landmarkParentId, // keep current landmark context
        ctx,
        readingDepth,
      );
      childIds.push(...mainChildren);
      index += 1;
      continue;
    }

    if (tag === "section" || LANDMARK_ROLES.has(roleInfo.role)) {
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

    // Heading-inferred section
    if (ctx.config.useStructuralInference && roleInfo.role === "heading") {
      // if (!parentIsLandmark) {
      const result = await handleHeadingSection(
        siblings,
        index,
        parentId,
        landmarkParentId,
        ctx,
        readingDepth,
        parentIsLandmark,
      );
      if (result) {
        childIds.push(result.id);
        index = result.endIndex;
        continue;
      }
      // }
      // else: heading stands alone — fall through to leaf
    }

    // Homogeneous run → list
    if (ctx.config.useStructuralInference) {
      const result = await handleListRun(
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

    // <a>-run → navigation
    if (ctx.config.useStructuralInference && tag === "a") {
      const result = await handleLinkRun(
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

    // <p>-run → article
    if (ctx.config.useStructuralInference && tag === "p") {
      const result = await handleParagraphRun(
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

    // Leaf
    childIds.push(
      await createNode(
        child,
        parentId,
        landmarkParentId,
        ctx,
        liftedAttrs,
        readingDepth,
      ),
    );
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

export const parsePageToIR = async (
  htmlString: string,
  url: string,
  fallbackProvider: AIFallbackProvider = new StubAIProvider(),
  config: ParserConfig = DEFAULT_CONFIG,
): Promise<PageIR> => {
  const parser = new DOMParser();
  const parsedDoc = parser.parseFromString(htmlString, "text/html");

  const inlineTags = new Set(INLINE_TAGS);

  // Build effective skip/wrapper sets from config
  const skipTags = new Set(SKIP_TAGS);
  if (config.includeSvg) skipTags.delete("svg");
  if (config.includeCanvas) skipTags.delete("canvas");

  const wrapperTags = new Set([
    ...WRAPPER_TAGS,
    ...config.extraWrapperTags.map((t) => t.toLowerCase()),
  ]);

  const nodes: Record<string, IRNode> = {};
  const fallbackLog: IRFallbackEntry[] = [];
  const landmarkRecords: LandmarkRecord[] = [];
  // Reserve reading indices for the fixed structural nodes:
  // 0 = body, 1 = toc, 2 = main
  // Traversal-generated nodes start at 3.
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
    inlineTags,
    pageUrl: url,
  };

  // Register body so aria refs pointing at it can resolve
  ctx.elementToNodeId.set(parsedDoc.body, "main");

  const bodyChildren = Array.from(parsedDoc.body.children).filter(
    (child) => !skipTags.has(child.tagName.toLowerCase()),
  );

  const mainChildIds = await buildChildrenFromSiblings(
    bodyChildren,
    "main",
    "main",
    ctx,
  );
  const parsedTitle = parsedDoc.title?.trim() || null;

  landmarkRecords.push({
    id: "main",
    label: parsedTitle ?? "main",
    parentId: "landmarks",
  });

  nodes["toc"] = {
    id: "toc",
    role: "navigation",
    level: null,
    label: "Table of contents",
    content: null,
    unlabelledYet: false,
    landmark: true,
    source: "structural",
    confidence: confidenceForSource("structural", ctx.config),
    readingIndex: READING_TOC,
    parent: "main", // toc lives inside main, not at landmark root level
    children: [], // no generated link items — TOC is a structural shell
    relations: createEmptyRelations(),
    state: createEmptyState(),
    attributes: createEmptyAttributes(),
    readingDepth: 0,
  };

  nodes["main"] = {
    id: "main",
    role: "main",
    level: null,
    label: parsedTitle ?? "main",
    content: null,
    unlabelledYet: parsedTitle === null,
    landmark: true,
    source: "structural",
    confidence: confidenceForSource("structural", ctx.config),
    readingIndex: READING_MAIN,
    parent: "landmarks",
    children: ["toc", ...mainChildIds],
    relations: createEmptyRelations(),
    state: createEmptyState(),
    attributes: createEmptyAttributes(),
    readingDepth: 0,
  };

  hydrateRelations(nodes, parsedDoc, ctx.elementToNodeId);

  const allNodes = Object.values(nodes);

  let orderedNodes: IRNode[];
  if (config.readingOrderStrategy === "landmark-first") {
    // Landmarks sorted before non-landmarks within each DOM-order tier.
    // Within each tier, DOM order (readingIndex) is preserved.
    const landmarks = allNodes
      .filter((n) => n.landmark)
      .sort((a, b) => a.readingIndex - b.readingIndex);
    const content = allNodes
      .filter((n) => !n.landmark)
      .sort((a, b) => a.readingIndex - b.readingIndex);
    orderedNodes = [...landmarks, ...content];
  } else if (config.readingOrderStrategy === "flowto-aware") {
    // Graph traversal following aria-flowto edges where present.
    const nodeMap = new Map(Object.values(nodes).map((n) => [n.id, n]));
    const domOrdered = [...allNodes].sort(
      (a, b) => a.readingIndex - b.readingIndex,
    );
    const visited = new Set<string>();
    const result: IRNode[] = [];

    const visit = (node: IRNode): void => {
      if (visited.has(node.id)) return;
      visited.add(node.id);
      result.push(node);
      for (const targetId of node.relations.flowTo) {
        const target = nodeMap.get(targetId);
        if (target) visit(target);
      }
    };

    for (const node of domOrdered) {
      visit(node);
    }
    orderedNodes = result;
  } else {
    // "dom" — strict DOM traversal order
    orderedNodes = allNodes.sort((a, b) => a.readingIndex - b.readingIndex);
  }

  const readingOrder = orderedNodes.map((node) => node.id);

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

  const landmarks = buildLandmarkTree(parsedTitle, landmarkRecords);

  return {
    meta: {
      url,
      title: parsedTitle,
      lang: parsedDoc.documentElement.getAttribute("lang") || null,
      parsedAt: new Date().toISOString(),
      config,
    },
    landmarks,
    root: "main",
    fallbackLog,
    analytics,
    readingOrder,
    nodes,
  };
};
