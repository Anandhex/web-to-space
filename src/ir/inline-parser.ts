import type { ParserConfig, IRRole } from "./types";
import {
  createEmptyState,
  createEmptyAttributes,
  createEmptyRelations,
  resolveNodeLabel,
  isAccessibilityHidden,
  readNodeAttributes,
} from "./utils";

// Text-extraction fallback used when an inline element turns out to have no
// rich structure worth preserving as its own node (see the "flatten to text"
// branches below). A raw `el.textContent` read walks straight through any
// accessibility-hidden descendant — e.g. Wikipedia mirrors every rendered
// math formula as visible `<img alt="{\displaystyle ...}">` right next to a
// `style="display: none"` MathML copy of the same formula for screen
// readers. Reading `.textContent` on the wrapper wants to pick up the
// image's neighbouring markup but also picks up that hidden MathML's symbol
// text *and* its raw TeX annotation, which is what surfaced as garbled
// fragments in the scene. `<math>` itself is also treated as opaque here,
// mirroring parser.ts's block-level handling of the same tag.
function visibleTextContent(element: Element): string {
  if (isAccessibilityHidden(element)) return "";
  let text = "";
  for (const child of Array.from(element.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      text += child.textContent ?? "";
    } else if (child.nodeType === Node.ELEMENT_NODE) {
      const el = child as Element;
      if (el.tagName.toLowerCase() === "math") continue;
      text += visibleTextContent(el);
    }
  }
  return text;
}

export interface InlineRun {
  type: "text" | "element";
  text?: string;
  element?: Element;
  nodeId?: string;
  children?: InlineRun[]; // For recursive processing
  styleStack?: string[];
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
// Purely stylistic inline tags — carry no role, just visual/semantic styling
const STYLE_ONLY_TAGS = new Set([
  "i",
  "em",
  "b",
  "strong",
  "s",
  "u",
  "mark",
  "sub",
  "sup",
  "small",
  "code",
  "kbd",
  "samp",
  "var",
  "q",
  "abbr",
  "cite",
  "dfn",
]);
export function decomposeInlineContentRecursive(
  element: Element,
  ctx: InlineContext,
  parentId: string,
  styleStack: string[] = [],
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

      // Accessibility-hidden duplicates (aria-hidden, display:none, etc. —
      // see visibleTextContent above) and raw MathML must never surface as
      // visible text or a positioned node.
      if (ctx.config.excludeHiddenContent && isAccessibilityHidden(el)) {
        continue;
      }
      if (tag === "math") continue;

      // <img> isn't in INLINE_TAGS (it's a void element with no text-flow
      // role of its own), so without this it fell through to the "hit a
      // block element" branch at the bottom of this loop, which flushes and
      // BREAKS — dropping the image and every sibling after it in this run.
      // An inline image (e.g. a small figure or icon sitting mid-sentence)
      // is exactly the kind of leaf this function exists to preserve.
      if (tag === "img") {
        flushText();
        runs.push({ type: "element", element: el });
        continue;
      }

      // Check if this is an inline element
      if (ctx.inlineTags.has(tag)) {
        flushText();
        if (STYLE_ONLY_TAGS.has(tag)) {
          // Hoist children, accumulating the style stack
          const childRuns = decomposeInlineContentRecursive(el, ctx, parentId, [
            ...styleStack,
            tag,
          ]);
          // Inject the style stack onto any leaf text runs produced.
          // Only stamp runs that don't already carry a styleStack — a run
          // that already has one was set by a NESTED STYLE_ONLY_TAGS call
          // (e.g. <b> inside <i>) and its styleStack already includes this
          // tag's ancestors *and* this tag itself, from its own recursive
          // call. Overwriting it here with [...styleStack, tag] would drop
          // everything the inner call accumulated below this level (e.g.
          // collapsing ["i","b"] back down to just ["i"]).
          for (const run of childRuns) {
            if (run.type === "text" && !run.styleStack) {
              run.styleStack = [...styleStack, tag];
            }
          }
          runs.push(...childRuns);
          continue;
        }

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
            // An interactive wrapper around nothing but a single <img> (e.g.
            // Wikipedia's <a class="mw-file-description"><img .../></a> file
            // links, used on every image) is visually just a picture, not a
            // text link. Capturing the anchor itself sent it down
            // flattenInlineRuns' text-link path, which had no image content
            // to read and fell back to the img's raw outerHTML/alt text —
            // showing literal markup or a bare alt string like
            // "altN=4-simplex" in place of the actual image. Capture the
            // <img> directly so it flows through the same img handling as
            // any other inline image instead.
            const meaningfulChildren = Array.from(el.children).filter(
              (c) => !ctx.skipTags.has(c.tagName.toLowerCase()),
            );
            const hasDirectText = Array.from(el.childNodes).some(
              (n) =>
                n.nodeType === Node.TEXT_NODE &&
                (n.textContent ?? "").trim().length > 0,
            );
            if (
              !hasDirectText &&
              meaningfulChildren.length === 1 &&
              meaningfulChildren[0].tagName.toLowerCase() === "img"
            ) {
              runs.push({ type: "element", element: meaningfulChildren[0] });
            } else {
              runs.push({ type: "element", element: el });
            }
          } else {
            // For non-interactive inline elements, extract their text
            const text = visibleTextContent(el).trim();
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
      attrs.styleTags = run.styleStack ?? [];

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
          const text = visibleTextContent(el).trim();
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
        const el = run.element;
        const tag = el.tagName.toLowerCase();

        // Determine role
        let role: IRRole = "generic";
        if (tag === "a") role = "link";
        else if (["button", "summary"].includes(tag)) role = "button";
        else if (["em", "i"].includes(tag)) role = "generic";
        else if (["strong", "b"].includes(tag)) role = "generic";
        else role = "generic";

        // FIX: Transparent inline wrappers (non-interactive elements like
        // <span title="…">, <i>, etc. whose entire purpose is to carry
        // styling/metadata around an inline run) must not become a separate
        // IR container node. If they did, the run's text/link children would
        // sit one IR level deeper than their siblings — invisible to any
        // code that only inspects the immediate parent's children (e.g. the
        // renderer's decision of whether a list item / paragraph qualifies
        // for inline-flow layout). That mismatch is what causes runs like
        // "<span><a>saingeom</a></span>" to fall out of the prose flow and
        // get stacked as their own block, overlapping the line above.
        //
        // We splice this wrapper's children directly into the current
        // parent's run instead of wrapping them, as long as:
        //   1. The wrapper itself isn't independently interactive
        //      (a/button/summary keep their own node — they're real targets).
        //   2. Every immediate sub-run is itself a flat inline leaf — plain
        //      text, or a simple element run with no further `children`.
        //      decomposeInlineContentRecursive only attaches `children` to a
        //      run when that element has its own rich/mixed structure, so
        //      this check is purely structural and doesn't require building
        //      any IR nodes first. If a sub-run still carries `children`,
        //      there's a genuine nested container below us and we keep this
        //      node so that grandchild's position in the tree isn't
        //      ambiguous.
        const isInteractive = ["a", "button", "summary"].includes(tag);
        const allChildRunsAreLeaves = run.children.every(
          (childRun) => !childRun.children || childRun.children.length === 0,
        );

        if (!isInteractive && allChildRunsAreLeaves) {
          // Transparent splice: build children parented/depthed exactly as
          // if they were direct siblings of this run, in place of a
          // wrapper node.
          const childResult = flattenInlineRuns(
            run.children,
            parentId,
            ctx,
            readingDepth,
          );
          nodeIds.push(...childResult.nodeIds);
          textRuns.push(...childResult.textRuns);
        } else {
          // Genuine container — build a wrapper node as before.
          const id = `${parentId}-inline-${ctx.counters.node++}`;
          const childResult = flattenInlineRuns(
            run.children,
            id,
            ctx,
            readingDepth + 1,
          );

          const label = shouldHaveLabelForElement(el, role, ctx.config)
            ? resolveNodeLabel(el, ctx.config, ctx.doc) ||
              visibleTextContent(el).trim() ||
              null
            : null;

          ctx.elementToNodeId.set(el, id);

          ctx.nodes[id] = {
            id,
            role,
            level: null,
            label,
            content: visibleTextContent(el).trim() || null,
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
              styleTags: run.styleStack ?? [],
            },
          };

          nodeIds.push(id);
          textRuns.push(...childResult.textRuns);
        }
      } else {
        // Simple inline element - create a single node
        const el = run.element;
        const id = `${parentId}-inline-${ctx.counters.node++}`;
        const tag = el.tagName.toLowerCase();

        // Determine role based on tag
        let role: IRRole = "generic";
        if (tag === "a") role = "link";
        else if (["button", "summary"].includes(tag)) role = "button";
        else if (tag === "img") role = "img";

        // An inline image (see decomposeInlineContentRecursive's "img" case
        // and its <a><img></a>-unwrapping above) needs its own real node —
        // falling into the generic "flatten to text" branch below would read
        // an <img>'s empty textContent and drop it silently, and the
        // interactive-element branch has no image-specific attributes at
        // all. mapImg (nodeMapper.ts) reads src/alt/intrinsicWidth/Height
        // straight off node.attributes, so this only needs to populate those.
        if (tag === "img") {
          const label = el.getAttribute("alt") || null;
          ctx.elementToNodeId.set(el, id);
          ctx.nodes[id] = {
            id,
            role,
            level: null,
            label,
            content: null,
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
            attributes: readNodeAttributes(el, { sourceUrl: ctx.pageUrl }),
          };
          nodeIds.push(id);
        } else if (["a", "button", "summary"].includes(tag)) {
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
          const text = visibleTextContent(el).trim();
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
