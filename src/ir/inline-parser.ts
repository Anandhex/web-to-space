import type { ParserConfig, IRRole } from "./types";
import {
  createEmptyState,
  createEmptyAttributes,
  createEmptyRelations,
  resolveNodeLabel,
} from "./utils";

export interface InlineRun {
  type: "text" | "element";
  text?: string;
  element?: Element;
  nodeId?: string;
  children?: InlineRun[]; // For recursive processing
}

export interface InlineContext {
  inlineTags: Set<string>;
  skipTags: Set<string>;
  config: ParserConfig;
  doc?: Document;
  pageUrl: string;
}

/**
 * Determines if a node should have its content decomposed into text/inline nodes
 * ONLY applies to leaf nodes that contain mixed content (text + inline elements)
 * A leaf node is one that has no block children
 */
export function shouldDecomposeContent(
  element: Element,
  ctx: InlineContext,
): boolean {
  const tag = element.tagName.toLowerCase();

  // Never decompose structural/skipped tags
  if (
    [
      "script",
      "style",
      "noscript",
      "meta",
      "link",
      "head",
      "template",
    ].includes(tag)
  ) {
    return false;
  }

  // If it's a div or span with ONLY text content, don't decompose
  // It should become a text node instead
  const hasElementChildren = Array.from(element.children).some(
    (child) => !ctx.skipTags.has(child.tagName.toLowerCase()),
  );

  if (!hasElementChildren) {
    // Only text nodes - this will be handled as a text node
    return false;
  }

  // Check if this node has any block children - if so, this is NOT a leaf
  let hasBlockChild = false;
  let hasText = false;
  let hasInlineElement = false;

  for (const child of Array.from(element.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      const text = (child.textContent ?? "").trim();
      if (text) {
        hasText = true;
      }
      continue;
    }

    if (child.nodeType === Node.ELEMENT_NODE) {
      const el = child as Element;
      const childTag = el.tagName.toLowerCase();

      // Skip tags that should be ignored
      if (ctx.skipTags.has(childTag)) continue;

      // Check if this is a block element
      if (!ctx.inlineTags.has(childTag)) {
        // This is a block element - this node is NOT a leaf
        hasBlockChild = true;
        break;
      } else {
        // This is an inline element
        hasInlineElement = true;
      }
    }
  }

  // Only decompose if:
  // 1. No block children (this is a leaf node in the semantic tree)
  // 2. Has both text and inline elements (mixed content)
  // 3. Has actual inline elements (not just text)
  return !hasBlockChild && hasText && hasInlineElement;
}

/**
 * Recursively decomposes inline content, handling nested inline elements
 *
 * Example:
 * <p>Hello <a href="#">Click <strong>here</strong> now</a>!</p>
 * → [
 *   { type: 'text', text: 'Hello ' },
 *   { type: 'element', element: <a>,
 *     children: [
 *       { type: 'text', text: 'Click ' },
 *       { type: 'element', element: <strong>, children: [{ type: 'text', text: 'here' }] },
 *       { type: 'text', text: ' now' }
 *     ]
 *   },
 *   { type: 'text', text: '!' }
 * ]
 */
export function decomposeInlineContentRecursive(
  element: Element,
  ctx: InlineContext,
  parentId: string,
): InlineRun[] {
  const runs: InlineRun[] = [];
  let currentText = "";

  const flushText = (): void => {
    if (currentText) {
      runs.push({ type: "text", text: currentText });
      currentText = "";
    }
  };

  for (const child of Array.from(element.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      const text = child.textContent ?? "";
      currentText += text;
      continue;
    }

    if (child.nodeType === Node.ELEMENT_NODE) {
      const el = child as Element;
      const tag = el.tagName.toLowerCase();

      // Skip tags that should be ignored
      if (ctx.skipTags.has(tag)) continue;

      // Check if this is an inline element
      if (ctx.inlineTags.has(tag)) {
        flushText();

        // Check if this inline element has rich structure (contains other inline elements)
        const hasInlineChildren = Array.from(el.children).some(
          (childEl) =>
            ctx.inlineTags.has(childEl.tagName.toLowerCase()) &&
            !ctx.skipTags.has(childEl.tagName.toLowerCase()),
        );

        // Check if this element has text + inline children (mixed content)
        const hasTextAndChildren = hasTextAndInlineChildren(el, ctx);

        if (hasTextAndChildren || hasInlineChildren) {
          // This inline element has rich structure - recursively decompose it
          const childRuns = decomposeInlineContentRecursive(el, ctx, parentId);
          runs.push({
            type: "element",
            element: el,
            children: childRuns,
          });
        } else {
          // Simple inline element - just capture it as a single element
          // But check if it's an interactive element that needs special handling
          if (["a", "button", "summary"].includes(tag)) {
            runs.push({ type: "element", element: el });
          } else {
            // For non-interactive inline elements, extract their text
            const text = el.textContent?.trim() ?? "";
            if (text) {
              // Preserve the semantic type in the text node's attributes
              runs.push({
                type: "text",
                text: text,
                element: el, // Store reference for semantic preservation
              });
            }
          }
        }
        continue;
      }

      // If we hit a block element (shouldn't happen in leaf nodes, but just in case)
      flushText();
      break;
    }
  }

  // Flush any remaining text
  flushText();

  return runs;
}

/**
 * Helper to check if an element has both text and inline children
 */
function hasTextAndInlineChildren(
  element: Element,
  ctx: InlineContext,
): boolean {
  let hasText = false;
  let hasInlineChild = false;

  for (const child of Array.from(element.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      const text = (child.textContent ?? "").trim();
      if (text) {
        hasText = true;
      }
    } else if (child.nodeType === Node.ELEMENT_NODE) {
      const tag = (child as Element).tagName.toLowerCase();
      if (ctx.inlineTags.has(tag) && !ctx.skipTags.has(tag)) {
        hasInlineChild = true;
      }
    }
  }

  return hasText && hasInlineChild;
}

/**
 * Flattens a recursive inline structure into a flat list of nodes
 * This is useful when we want to preserve the semantic structure but
 * keep the DOM order for reading purposes
 */
export function flattenInlineRuns(
  runs: InlineRun[],
  parentId: string,
  ctx: BuildContext,
  readingDepth: number,
): { nodeIds: string[]; textRuns: string[] } {
  const nodeIds: string[] = [];
  const textRuns: string[] = [];

  for (const run of runs) {
    if (run.type === "text" && run.text) {
      // Create a text node
      const id = `${parentId}-text-${ctx.counters.node++}`;
      const text = run.text;

      // Preserve semantic information if available
      const attrs = createEmptyAttributes();
      if (run.element) {
        const tag = run.element.tagName.toLowerCase();
        // Preserve semantic type for text-level semantics
        // For generic wrappers, we don't need to preserve them
        if (!["div", "span"].includes(tag)) {
          attrs.componentType = tag;
        }
        // Preserve any styling or semantic attributes
        if (run.element.hasAttribute("class")) {
          attrs.title = run.element.getAttribute("class") || null;
        }
      }

      ctx.nodes[id] = {
        id,
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
        attributes: attrs,
      };

      nodeIds.push(id);
      textRuns.push(text);
    } else if (run.type === "element" && run.element) {
      const el = run.element;
      const tag = el.tagName.toLowerCase();

      // ── Handle generic wrappers ──────────────────────────────────────────
      // If this is a div/span with only text, flatten it
      if (["div", "span"].includes(tag)) {
        const hasOnlyText = !Array.from(el.children).some(
          (child) => !ctx.skipTags.has(child.tagName.toLowerCase()),
        );

        if (hasOnlyText) {
          // Flatten to text
          const text = el.textContent?.trim() ?? "";
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
              attributes: createEmptyAttributes(),
            };
            nodeIds.push(textId);
            textRuns.push(text);
          }
          continue;
        }
      }
      // Check if this inline element has children (rich structure)
      if (run.children && run.children.length > 0) {
        // Create a node for the container inline element
        const el = run.element;
        const id = `${parentId}-inline-${ctx.counters.node++}`;
        const tag = el.tagName.toLowerCase();

        // Determine role
        let role: IRRole = "generic";
        if (tag === "a") role = "link";
        else if (["button", "summary"].includes(tag)) role = "button";
        else if (["em", "i"].includes(tag)) role = "generic";
        else if (["strong", "b"].includes(tag)) role = "generic";
        else role = "generic";

        // Recursively process children
        const childResult = flattenInlineRuns(
          run.children,
          id,
          ctx,
          readingDepth + 1,
        );

        const label = shouldHaveLabelForElement(el, role, ctx.config)
          ? resolveNodeLabel(el, ctx.config, ctx.doc) ||
            el.textContent?.trim() ||
            null
          : null;

        ctx.elementToNodeId.set(el, id);

        ctx.nodes[id] = {
          id,
          role,
          level: null,
          label,
          content: el.textContent?.trim() || null,
          unlabelledYet: label === null,
          landmark: false,
          source: "structural",
          confidence: ctx.config.sourceConfidence["structural"] || 0.75,
          readingIndex: ctx.counters.reading++,
          readingDepth,
          parent: parentId,
          children: childResult.nodeIds,
          relations: createEmptyRelations(),
          state: createEmptyState(),
          attributes: {
            ...createEmptyAttributes(),
            componentType: tag,
            href: tag === "a" ? el.getAttribute("href") : null,
          },
        };

        nodeIds.push(id);
        textRuns.push(...childResult.textRuns);
      } else {
        // Simple inline element - create a single node
        const el = run.element;
        const id = `${parentId}-inline-${ctx.counters.node++}`;
        const tag = el.tagName.toLowerCase();

        // Determine role based on tag
        let role: IRRole = "generic";
        if (tag === "a") role = "link";
        else if (["button", "summary"].includes(tag)) role = "button";

        // For interactive elements, create a proper node
        if (["a", "button", "summary"].includes(tag)) {
          const content = el.textContent?.trim() ?? null;
          const label = shouldHaveLabelForElement(el, role, ctx.config)
            ? resolveNodeLabel(el, ctx.config, ctx.doc) || content
            : null;

          ctx.elementToNodeId.set(el, id);

          ctx.nodes[id] = {
            id,
            role,
            level: null,
            label,
            content: content || el.innerHTML || null,
            unlabelledYet: label === null,
            landmark: false,
            source: "structural",
            confidence: ctx.config.sourceConfidence["structural"] || 0.75,
            readingIndex: ctx.counters.reading++,
            readingDepth,
            parent: parentId,
            children: [],
            relations: createEmptyRelations(),
            state: createEmptyState(),
            attributes: {
              ...createEmptyAttributes(),
              componentType: tag,
              href: tag === "a" ? el.getAttribute("href") : null,
            },
          };

          nodeIds.push(id);
        } else {
          // Non-interactive inline elements - flatten to text
          const text = el.textContent?.trim() ?? "";
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
            nodeIds.push(textId);
            textRuns.push(text);
          }
        }
      }
    }
  }

  return { nodeIds, textRuns };
}

/**
 * Simplified version for cases where we don't need recursive preservation
 * Creates nodes directly without preserving rich structure
 */
export function createInlineNodes(
  runs: InlineRun[],
  parentId: string,
  ctx: BuildContext,
  readingDepth: number,
): { nodeIds: string[]; textRuns: string[] } {
  return flattenInlineRuns(runs, parentId, ctx, readingDepth);
}

/**
 * Determines if an inline element should have a label
 */
function shouldHaveLabelForElement(
  element: Element,
  role: IRRole,
  config: ParserConfig,
): boolean {
  const INTERACTIVE_ROLES = new Set([
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

  if (INTERACTIVE_ROLES.has(role)) {
    return true;
  }

  return false;
}

// Helper type for build context
import type { BuildContext } from "./types";
