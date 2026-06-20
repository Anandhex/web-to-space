// ─────────────────────────────────────────────────────────────
// Mapping rules — landmarks
// ─────────────────────────────────────────────────────────────

import type { IRNode } from "../ir/types";
import { baseFrom } from "./mapper";
import type {
  MappingContext,
  XRContentPanel,
  XRNavigationBar,
  XRBanner,
  XRFooter,
  XRComplementary,
  MappingRule,
  XRFormPanel,
  XRSection,
  XRArticle,
  XRFormField,
  XRListItem,
  XRList,
  XRHeading,
  XRParagraph,
  XRCodeBlock,
  XRBlockQuote,
  XRSeparator,
  XRProgressBar,
  XRImage,
  XRFigure,
  XRMediaPlayer,
  XRTable,
  XRPrimitive,
  XRTableRow,
  XRTableCell,
  XRButton,
  XRLink,
  XRSearchBox,
  XRToggle,
  XRComboBox,
  XRSlider,
  XRDialog,
  XRAlert,
  XRTooltip,
  XRTabGroup,
  XRTab,
  XRTabPanel,
  XRMenu,
  XRMenuItem,
  XRTree,
  XRTreeItem,
  XRGenericPanel,
  XRText,
} from "./types";
import {
  resolveChildren,
  resolveLabel,
  extractState,
  computeDensity,
  resolveDescription,
  trackElision,
  warnPanelOverflow,
  registerPrimitive,
} from "./utils";

function mapMain(node: IRNode, ctx: MappingContext): XRContentPanel {
  const children = resolveChildren(node, ctx);
  warnPanelOverflow(node.id, children, ctx);
  const primitive: XRContentPanel = {
    ...baseFrom(node, "XRContentPanel"),
    type: "XRContentPanel",
    flowDirection: "column",
    children,
  };
  registerPrimitive(ctx, primitive, "landmark:main→XRContentPanel");
  return primitive;
}

function mapNavigation(
  node: IRNode,
  ctx: MappingContext,
): XRNavigationBar | null {
  const linkChildren = node.children
    .map((id) => ctx.ir.nodes[id])
    .filter((n): n is IRNode => !!n && n.role === "link")
    .map((n) => mapLink(n, ctx));

  if (linkChildren.length === 0) return null;

  const primitive: XRNavigationBar = {
    ...baseFrom(node, "XRNavigationBar"),
    type: "XRNavigationBar",
    items: [...linkChildren],
    children: linkChildren,
  };
  registerPrimitive(ctx, primitive, "landmark:navigation→XRNavigationBar");
  return primitive;
}

function mapBanner(node: IRNode, ctx: MappingContext): XRBanner {
  const primitive: XRBanner = {
    ...baseFrom(node, "XRBanner"),
    type: "XRBanner",
    children: resolveChildren(node, ctx),
  };
  registerPrimitive(ctx, primitive, "landmark:banner→XRBanner");
  return primitive;
}

function mapFooter(node: IRNode, ctx: MappingContext): XRFooter {
  const primitive: XRFooter = {
    ...baseFrom(node, "XRFooter"),
    type: "XRFooter",
    children: resolveChildren(node, ctx),
  };
  registerPrimitive(ctx, primitive, "landmark:contentinfo→XRFooter");
  return primitive;
}

function mapComplementary(node: IRNode, ctx: MappingContext): XRComplementary {
  const primitive: XRComplementary = {
    ...baseFrom(node, "XRComplementary"),
    type: "XRComplementary",
    children: resolveChildren(node, ctx),
  };
  registerPrimitive(ctx, primitive, "landmark:complementary→XRComplementary");
  return primitive;
}

function mapFormPanel(
  node: IRNode,
  ctx: MappingContext,
  rule: MappingRule = "landmark:form→XRFormPanel",
): XRFormPanel {
  const primitive: XRFormPanel = {
    ...baseFrom(node, "XRFormPanel"),
    type: "XRFormPanel",
    children: resolveChildren(node, ctx),
  };
  registerPrimitive(ctx, primitive, rule);
  return primitive;
}

// ─────────────────────────────────────────────────────────────
// Mapping rules — content structure
// ─────────────────────────────────────────────────────────────

function mapSection(
  node: IRNode,
  ctx: MappingContext,
  rule: MappingRule = "landmark:region→XRSection",
): XRSection {
  const looksLikeId = (s: string | null): boolean =>
    !s || /^[\w]+-\d+$/.test(s.trim()) || s.trim().length === 0;

  let title: string | null = looksLikeId(node.label) ? null : node.label;
  let titleLevel: number | null = null;

  const firstChildId = node.children[0];
  if (firstChildId) {
    const firstChild = ctx.ir.nodes[firstChildId];
    if (firstChild?.role === "heading") {
      title = firstChild.label ?? title;
      titleLevel = firstChild.level;
    }
  }

  const children = resolveChildren(node, ctx);
  warnPanelOverflow(node.id, children, ctx);

  const primitive: XRSection = {
    ...baseFrom(node, "XRSection"),
    type: "XRSection",
    title,
    titleLevel,
    flowDirection: "column",
    children,
  };
  registerPrimitive(ctx, primitive, rule);
  return primitive;
}

function mapArticle(node: IRNode, ctx: MappingContext): XRArticle {
  const primitive: XRArticle = {
    ...baseFrom(node, "XRArticle"),
    type: "XRArticle",
    flowDirection: "column",
    children: resolveChildren(node, ctx),
  };
  registerPrimitive(ctx, primitive, "article→XRArticle");
  return primitive;
}

function mapGroup(node: IRNode, ctx: MappingContext): XRFormField | XRSection {
  const formControlRoles = [
    "textbox",
    "searchbox",
    "checkbox",
    "radio",
    "combobox",
    "slider",
    "spinbutton",
    "switch",
  ] as const;
  type FormControlRole = (typeof formControlRoles)[number];

  const firstControlRole = node.children
    .map((id) => ctx.ir.nodes[id])
    .filter((n): n is IRNode => !!n)
    .find((n) => formControlRoles.includes(n.role as FormControlRole))?.role as
    | FormControlRole
    | undefined;

  if (firstControlRole !== undefined) {
    const controlType: XRFormField["controlType"] =
      firstControlRole === "radio"
        ? "radio"
        : firstControlRole === "checkbox"
          ? "checkbox"
          : firstControlRole === "switch"
            ? "switch"
            : "fieldset";

    const primitive: XRFormField = {
      ...baseFrom(node, "XRFormField"),
      type: "XRFormField",
      label: resolveLabel(node, ctx.ir) ?? node.label,
      controlType,
      state: extractState(node),
      placeholder: null,
      valueMin: null,
      valueMax: null,
      valueFraction: null,
      resolvedLabel: resolveLabel(node, ctx.ir),
      children: resolveChildren(node, ctx),
    };
    registerPrimitive(ctx, primitive, "group:fieldset→XRFormField");
    return primitive;
  }

  return mapSection(node, ctx, "group:generic→XRSection");
}

// ─────────────────────────────────────────────────────────────
// Mapping rules — lists
// ─────────────────────────────────────────────────────────────

/**
 * Attaches `columnCount: null` — Layout computes the actual column count
 * from card dimensions and panel geometry.
 */
function mapList(
  node: IRNode,
  ctx: MappingContext,
  rule: MappingRule = "list:generic→XRList",
): XRList | XRSection {
  const childNodes = node.children
    .map((id) => ctx.ir.nodes[id])
    .filter((n): n is IRNode => !!n);

  if (childNodes.length < ctx.config.minCardGridItems) {
    return mapSection(node, ctx, "landmark:region→XRSection");
  }

  // Structural uniformity check: all listitems must share the same child-role signature
  const itemNodes = childNodes.filter(
    (n) => n.role === "listitem" && Array.isArray(n.children),
  );
  const isUniform =
    itemNodes.length >= ctx.config.minCardGridItems &&
    (() => {
      const sig = (n: IRNode): string =>
        (n.children ?? [])
          .map((id) => ctx.ir.nodes[id]?.role ?? "")
          .sort()
          .join("|");
      const first = itemNodes[0] ? sig(itemNodes[0]) : "";
      return first !== "" && itemNodes.every((n) => sig(n) === first);
    })();

  if (!isUniform) {
    return mapSection(node, ctx, "landmark:region→XRSection");
  }

  const effectiveRule: MappingRule =
    node.attributes.listType === "ordered"
      ? "list:ordered→XRList"
      : "list:uniform→XRList";

  const primitive: XRList = {
    ...baseFrom(node, "XRList"),
    type: "XRList",
    listType: node.attributes.listType ?? null,
    children: resolveChildren(node, ctx),
  };
  registerPrimitive(ctx, primitive, effectiveRule, {
    heuristic: "uniform-list",
  });
  return primitive;
}

function mapListItem(node: IRNode, ctx: MappingContext): XRListItem {
  const primitive: XRListItem = {
    ...baseFrom(node, "XRListItem"),
    type: "XRListItem",
    children: resolveChildren(node, ctx),
  };
  registerPrimitive(ctx, primitive, "listitem→XRListItem");
  return primitive;
}

// ─────────────────────────────────────────────────────────────
// Mapping rules — typography
// ─────────────────────────────────────────────────────────────

function mapHeading(node: IRNode, ctx: MappingContext): XRHeading {
  const resolvedChildren = resolveChildren(node, ctx);
  const primitive: XRHeading = {
    ...baseFrom(node, "XRHeading"),
    type: "XRHeading",
    level: node.level ?? 2,
    children: resolvedChildren,
  };
  registerPrimitive(ctx, primitive, "heading→XRHeading");
  return primitive;
}

function mapParagraph(node: IRNode, ctx: MappingContext): XRParagraph {
  const resolvedChildren = resolveChildren(node, ctx);
  const { wordCount, estimatedReadingTimeSec, densityScore } = computeDensity(
    node,
    ctx.ir,
  );
  const primitive: XRParagraph = {
    ...baseFrom(node, "XRParagraph"),
    type: "XRParagraph",
    wordCount,
    estimatedReadingTimeSec,
    densityScore,
    children: resolvedChildren,
  };
  registerPrimitive(ctx, primitive, "paragraph→XRParagraph");
  return primitive;
}

// ─────────────────────────────────────────────────────────────
// Mapping rules — text nodes
// ─────────────────────────────────────────────────────────────

function mapText(node: IRNode, ctx: MappingContext): XRText {
  const primitive: XRText = {
    ...baseFrom(node, "XRText"),
    type: "XRText",
    text: node.content || node.label || "",
    componentType: node.attributes?.componentType || null,
    isProseRun: true,
    children: [], // Text nodes are always leaves
  };
  registerPrimitive(ctx, primitive, "text→XRText");
  return primitive;
}

function mapCodeBlock(node: IRNode, ctx: MappingContext): XRCodeBlock {
  const primitive: XRCodeBlock = {
    ...baseFrom(node, "XRCodeBlock"),
    type: "XRCodeBlock",
    children: [],
  };
  registerPrimitive(ctx, primitive, "code→XRCodeBlock");
  return primitive;
}

function mapBlockQuote(node: IRNode, ctx: MappingContext): XRBlockQuote {
  const primitive: XRBlockQuote = {
    ...baseFrom(node, "XRBlockQuote"),
    type: "XRBlockQuote",
    children: resolveChildren(node, ctx),
  };
  registerPrimitive(ctx, primitive, "blockquote→XRBlockQuote");
  return primitive;
}

function mapSeparator(node: IRNode, ctx: MappingContext): XRSeparator {
  const primitive: XRSeparator = {
    ...baseFrom(node, "XRSeparator"),
    type: "XRSeparator",
    // Semantic orientation fact — Layout may use it for axis alignment
    orientation:
      node.attributes.orientation === "vertical" ? "vertical" : "horizontal",
    children: [],
  };
  registerPrimitive(ctx, primitive, "separator→XRSeparator");
  return primitive;
}

function mapProgressBar(node: IRNode, ctx: MappingContext): XRProgressBar {
  const state = extractState(node);
  const primitive: XRProgressBar = {
    ...baseFrom(node, "XRProgressBar"),
    type: "XRProgressBar",
    valueFraction: state.valueFraction,
    children: [],
  };
  registerPrimitive(ctx, primitive, "progressbar→XRProgressBar");
  return primitive;
}

// ─────────────────────────────────────────────────────────────
// Mapping rules — media
// ─────────────────────────────────────────────────────────────

function mapImg(node: IRNode, ctx: MappingContext): XRImage {
  const primitive: XRImage = {
    ...baseFrom(node, "XRImage"),
    type: "XRImage",
    src: node.attributes.src,
    alt: node.attributes.alt ?? node.label,
    children: [],
  };
  registerPrimitive(ctx, primitive, "img→XRImage");
  return primitive;
}

/**
 * Simple figure (one img + optional caption) collapses to XRImage.
 * Rich figures (code, table, mixed) become XRFigure.
 */
function mapFigure(node: IRNode, ctx: MappingContext): XRImage | XRFigure {
  const childNodes = node.children
    .map((id) => ctx.ir.nodes[id])
    .filter((n): n is IRNode => !!n);
  const imgChildren = childNodes.filter((n) => n.role === "img");
  const captionChildren = childNodes.filter((n) => n.role === "caption");
  const otherChildren = childNodes.filter(
    (n) => n.role !== "img" && n.role !== "caption",
  );

  if (imgChildren.length === 1 && otherChildren.length === 0) {
    const imgNode = imgChildren[0];
    const captionText = captionChildren[0]?.label ?? null;
    const primitive: XRImage = {
      ...baseFrom(node, "XRImage"),
      id: node.id,
      type: "XRImage",
      label: captionText ?? node.label,
      sourceIds: [node.id, imgNode.id],
      src: imgNode.attributes.src,
      alt: imgNode.attributes.alt ?? captionText ?? node.label,
      children: [],
    };
    registerPrimitive(ctx, primitive, "figure:image-only→XRImage");
    ctx.diagnostics.mergedCount += 1;
    return primitive;
  }

  const primitive: XRFigure = {
    ...baseFrom(node, "XRFigure"),
    type: "XRFigure",
    captionId: captionChildren[0]?.id ?? null,
    children: resolveChildren(node, ctx),
  };
  registerPrimitive(ctx, primitive, "figure:mixed→XRFigure");
  return primitive;
}

/**
 * Attaches mediaType and autoplay as semantic facts.
 * Layout decides sizing strategy (compact-widget / large-panel / ambient).
 */
function mapMedia(node: IRNode, ctx: MappingContext): XRMediaPlayer {
  const mediaType = node.role === "audio" ? "audio" : "video";
  const primitive: XRMediaPlayer = {
    ...baseFrom(node, "XRMediaPlayer"),
    type: "XRMediaPlayer",
    mediaType,
    src: node.attributes.src,
    captions: node.attributes.captions,
    // sizingStrategy: absent — Layout's responsibility
    children: [],
  };
  const rule: MappingRule =
    mediaType === "audio" ? "audio→XRMediaPlayer" : "video→XRMediaPlayer";
  registerPrimitive(ctx, primitive, rule);
  return primitive;
}

// ─────────────────────────────────────────────────────────────
// Mapping rules — tables
// ─────────────────────────────────────────────────────────────

/**
 * Attaches rowCount and columnCount as semantic facts.
 * Layout decides layoutStrategy (flat-2d / curved-2d / scrollable / cards).
 */
function mapTable(node: IRNode, ctx: MappingContext): XRTable {
  const rowNodes = node.children
    .map((id) => ctx.ir.nodes[id])
    .filter(
      (n): n is IRNode => !!n && (n.role === "row" || n.role === "group"),
    );

  const flatRows: IRNode[] = [];
  for (const rowNode of rowNodes) {
    if (rowNode.role === "row") {
      flatRows.push(rowNode);
    } else {
      for (const subId of rowNode.children) {
        const sub = ctx.ir.nodes[subId];
        if (sub?.role === "row") flatRows.push(sub);
      }
    }
  }

  const rowCount = flatRows.length;
  let columnCount = 0;
  for (const r of flatRows) {
    columnCount = Math.max(columnCount, r.children.length);
  }

  const children: XRPrimitive[] = [];
  let rowIndex = 0;
  for (const childId of node.children) {
    const childNode = ctx.ir.nodes[childId];
    if (!childNode) continue;
    if (childNode.role === "row") {
      const row = mapTableRowIndexed(childNode, rowIndex, ctx);
      if (row) {
        children.push(row);
        rowIndex += 1;
      }
    } else if (childNode.role === "group") {
      const groupChildren: XRPrimitive[] = [];
      for (const subId of childNode.children) {
        const sub = ctx.ir.nodes[subId];
        if (!sub) continue;
        if (sub.role === "row") {
          const row = mapTableRowIndexed(sub, rowIndex, ctx);
          if (row) {
            groupChildren.push(row);
            rowIndex += 1;
          }
        } else {
          const p = mapNode(sub, ctx);
          if (p) groupChildren.push(p);
        }
      }
      const groupPrimitive: XRSection = {
        ...baseFrom(childNode, "XRSection"),
        type: "XRSection",
        title: null,
        titleLevel: null,
        flowDirection: "column",
        children: groupChildren,
      };
      registerPrimitive(ctx, groupPrimitive, "group:generic→XRSection");
      children.push(groupPrimitive);
    } else {
      const p = mapNode(childNode, ctx);
      if (p) children.push(p);
    }
  }

  const primitive: XRTable = {
    ...baseFrom(node, "XRTable"),
    type: "XRTable",
    columnCount,
    rowCount,
    // layoutStrategy: absent — Layout decides from columnCount + rowCount
    children,
  };
  registerPrimitive(ctx, primitive, "table→XRTable");
  return primitive;
}

function mapTableRowIndexed(
  node: IRNode,
  rowIndex: number,
  ctx: MappingContext,
): XRTableRow {
  const isHeader = node.children.some((id) => {
    const child = ctx.ir.nodes[id];
    return child?.role === "columnheader" || child?.role === "rowheader";
  });

  const cellChildren: XRPrimitive[] = [];
  let colIndex = 0;
  for (const cellId of node.children) {
    const cellNode = ctx.ir.nodes[cellId];
    if (!cellNode) continue;
    if (
      cellNode.role === "cell" ||
      cellNode.role === "columnheader" ||
      cellNode.role === "rowheader"
    ) {
      const cell = mapTableCellIndexed(cellNode, rowIndex, colIndex, ctx);
      cellChildren.push(cell);
      colIndex += cell.colspan;
    } else {
      const p = mapNode(cellNode, ctx);
      if (p) {
        cellChildren.push(p);
        colIndex += 1;
      }
    }
  }

  const primitive: XRTableRow = {
    ...baseFrom(node, "XRTableRow"),
    type: "XRTableRow",
    isHeader,
    children: cellChildren,
  };
  registerPrimitive(ctx, primitive, "row→XRTableRow");
  return primitive;
}

function mapTableCellIndexed(
  node: IRNode,
  rowIndex: number,
  columnIndex: number,
  ctx: MappingContext,
): XRTableCell {
  const isHeader = node.role === "columnheader" || node.role === "rowheader";
  const rule: MappingRule =
    node.role === "columnheader"
      ? "columnheader→XRTableCell"
      : node.role === "rowheader"
        ? "rowheader→XRTableCell"
        : "cell→XRTableCell";
  const colspan = parseInt(node.attributes.colspan ?? "1", 10) || 1;
  const rowspan = parseInt(node.attributes.rowspan ?? "1", 10) || 1;
  const primitive: XRTableCell = {
    ...baseFrom(node, "XRTableCell"),
    type: "XRTableCell",
    isHeader,
    colspan,
    rowspan,
    rowIndex,
    columnIndex,
    headers: node.relations.headers,
    children: resolveChildren(node, ctx),
  };
  registerPrimitive(ctx, primitive, rule);
  return primitive;
}

// Fallback entry points for orphaned rows/cells (e.g. mapNode dispatch)
function mapTableRow(node: IRNode, ctx: MappingContext): XRTableRow {
  return mapTableRowIndexed(node, 0, ctx);
}
function mapTableCell(node: IRNode, ctx: MappingContext): XRTableCell {
  return mapTableCellIndexed(node, 0, 0, ctx);
}

// ─────────────────────────────────────────────────────────────
// Mapping rules — interactive
// ─────────────────────────────────────────────────────────────

function mapButton(node: IRNode, ctx: MappingContext): XRButton {
  const primitive: XRButton = {
    ...baseFrom(node, "XRButton"),
    type: "XRButton",
    label: resolveLabel(node, ctx.ir) ?? node.label,
    state: extractState(node),
    hasPopup: node.attributes.haspopup,
    children: resolveChildren(node, ctx),
  };
  registerPrimitive(ctx, primitive, "button→XRButton");
  return primitive;
}

function mapLink(node: IRNode, ctx: MappingContext): XRLink {
  const primitive: XRLink = {
    ...baseFrom(node, "XRLink"),
    type: "XRLink",
    href: node.attributes.href,
    isCurrent: node.state.current !== null && node.state.current !== "false",
    children: resolveChildren(node, ctx),
  };
  registerPrimitive(ctx, primitive, "link→XRLink");
  return primitive;
}

function mapTextbox(node: IRNode, ctx: MappingContext): XRFormField {
  const rule: MappingRule =
    node.role === "spinbutton"
      ? "spinbutton→XRFormField"
      : "textbox→XRFormField";
  const state = extractState(node);
  const resolvedLabel = resolveLabel(node, ctx.ir) ?? node.label;
  const primitive: XRFormField = {
    ...baseFrom(node, "XRFormField"),
    type: "XRFormField",
    label: resolvedLabel,
    controlType: node.role === "spinbutton" ? "spinbutton" : "textbox",
    state,
    placeholder: node.attributes.placeholder,
    valueMin: parseFloat(node.attributes.valueMin ?? "") || null,
    valueMax: parseFloat(node.attributes.valueMax ?? "") || null,
    valueFraction: state.valueFraction,
    resolvedLabel,
    children: [],
  };
  registerPrimitive(ctx, primitive, rule);
  return primitive;
}

function mapSearchBox(node: IRNode, ctx: MappingContext): XRSearchBox {
  const primitive: XRSearchBox = {
    ...baseFrom(node, "XRSearchBox"),
    type: "XRSearchBox",
    label: resolveLabel(node, ctx.ir) ?? node.label,
    state: extractState(node),
    placeholder: node.attributes.placeholder,
    children: [],
  };
  registerPrimitive(ctx, primitive, "searchbox→XRSearchBox");
  return primitive;
}

function mapToggle(node: IRNode, ctx: MappingContext): XRToggle {
  const toggleType =
    node.role === "switch"
      ? "switch"
      : node.role === "radio"
        ? "radio"
        : "checkbox";
  const rule: MappingRule =
    node.role === "switch"
      ? "switch→XRToggle"
      : node.role === "radio"
        ? "radio→XRToggle"
        : "checkbox→XRToggle";
  const primitive: XRToggle = {
    ...baseFrom(node, "XRToggle"),
    type: "XRToggle",
    toggleType,
    state: extractState(node),
    children: [],
  };
  registerPrimitive(ctx, primitive, rule);
  return primitive;
}

function mapComboBox(node: IRNode, ctx: MappingContext): XRComboBox {
  const primitive: XRComboBox = {
    ...baseFrom(node, "XRComboBox"),
    type: "XRComboBox",
    state: extractState(node),
    children: resolveChildren(node, ctx),
  };
  registerPrimitive(ctx, primitive, "combobox→XRComboBox");
  return primitive;
}

function mapSlider(node: IRNode, ctx: MappingContext): XRSlider {
  const state = extractState(node);
  const primitive: XRSlider = {
    ...baseFrom(node, "XRSlider"),
    type: "XRSlider",
    state,
    valueMin: parseFloat(node.attributes.valueMin ?? "") || null,
    valueMax: parseFloat(node.attributes.valueMax ?? "") || null,
    valueFraction: state.valueFraction,
    children: [],
  };
  registerPrimitive(ctx, primitive, "slider→XRSlider");
  return primitive;
}

// ─────────────────────────────────────────────────────────────
// Mapping rules — overlays
// ─────────────────────────────────────────────────────────────

function mapDialog(node: IRNode, ctx: MappingContext): XRDialog {
  const primitive: XRDialog = {
    ...baseFrom(node, "XRDialog"),
    type: "XRDialog",
    label: resolveLabel(node, ctx.ir) ?? node.label,
    isModal: node.state.modal === "true",
    state: extractState(node),
    children: resolveChildren(node, ctx),
  };
  registerPrimitive(ctx, primitive, "dialog→XRDialog");
  return primitive;
}

/**
 * Attaches liveRegion as a semantic fact.
 * Layout decides presentation (floating-notification vs inline-banner)
 * and placement from liveRegion.
 */
function mapAlert(
  node: IRNode,
  ctx: MappingContext,
  rule: MappingRule = "alert→XRAlert",
): XRAlert {
  const liveRegion: "assertive" | "polite" =
    node.role === "alert" ? "assertive" : "polite";
  const primitive: XRAlert = {
    ...baseFrom(node, "XRAlert"),
    type: "XRAlert",
    liveRegion,

    children: resolveChildren(node, ctx),
  };
  registerPrimitive(ctx, primitive, rule);
  return primitive;
}

function mapTooltip(node: IRNode, ctx: MappingContext): XRTooltip {
  const resolvedDesc = resolveDescription(node, ctx.ir);
  const primitive: XRTooltip = {
    ...baseFrom(node, "XRTooltip"),
    type: "XRTooltip",
    label: node.label ?? resolvedDesc,
    children: [],
  };
  registerPrimitive(ctx, primitive, "tooltip→XRTooltip");
  return primitive;
}

// ─────────────────────────────────────────────────────────────
// Mapping rules — rich widgets
// ─────────────────────────────────────────────────────────────

function mapTabGroup(node: IRNode, ctx: MappingContext): XRTabGroup {
  const primitive: XRTabGroup = {
    ...baseFrom(node, "XRTabGroup"),
    type: "XRTabGroup",
    orientation:
      node.attributes.orientation === "vertical" ? "vertical" : "horizontal",
    children: resolveChildren(node, ctx),
  };
  registerPrimitive(ctx, primitive, "tablist→XRTabGroup");
  return primitive;
}

function mapTab(node: IRNode, ctx: MappingContext): XRTab {
  const primitive: XRTab = {
    ...baseFrom(node, "XRTab"),
    type: "XRTab",
    state: extractState(node),
    panelId: node.relations.controls[0] ?? null,
    children: [],
  };
  registerPrimitive(ctx, primitive, "tab→XRTab");
  return primitive;
}

function mapTabPanel(node: IRNode, ctx: MappingContext): XRTabPanel {
  const primitive: XRTabPanel = {
    ...baseFrom(node, "XRTabPanel"),
    type: "XRTabPanel",
    children: resolveChildren(node, ctx),
  };
  registerPrimitive(ctx, primitive, "tabpanel→XRTabPanel");
  return primitive;
}

function mapMenu(node: IRNode, ctx: MappingContext): XRMenu {
  const rule: MappingRule =
    node.role === "menubar" ? "menubar→XRMenu" : "menu→XRMenu";
  const primitive: XRMenu = {
    ...baseFrom(node, "XRMenu"),
    type: "XRMenu",
    menuType: node.role === "menubar" ? "menubar" : "menu",
    children: resolveChildren(node, ctx),
  };
  registerPrimitive(ctx, primitive, rule);
  return primitive;
}

function mapMenuItem(node: IRNode, ctx: MappingContext): XRMenuItem {
  const rule: MappingRule =
    node.role === "menuitemcheckbox"
      ? "menuitemcheckbox→XRMenuItem"
      : node.role === "menuitemradio"
        ? "menuitemradio→XRMenuItem"
        : "menuitem→XRMenuItem";
  const primitive: XRMenuItem = {
    ...baseFrom(node, "XRMenuItem"),
    type: "XRMenuItem",
    itemType:
      node.role === "menuitemcheckbox"
        ? "menuitemcheckbox"
        : node.role === "menuitemradio"
          ? "menuitemradio"
          : "menuitem",
    state: extractState(node),
    children: [],
  };
  registerPrimitive(ctx, primitive, rule);
  return primitive;
}

function mapTree(node: IRNode, ctx: MappingContext): XRTree {
  const primitive: XRTree = {
    ...baseFrom(node, "XRTree"),
    type: "XRTree",
    multiselectable: node.state.multiselectable === "true",
    children: resolveChildren(node, ctx),
  };
  registerPrimitive(ctx, primitive, "tree→XRTree");
  return primitive;
}

function mapTreeItem(node: IRNode, ctx: MappingContext): XRTreeItem {
  const primitive: XRTreeItem = {
    ...baseFrom(node, "XRTreeItem"),
    type: "XRTreeItem",
    state: extractState(node),
    children: resolveChildren(node, ctx),
  };
  registerPrimitive(ctx, primitive, "treeitem→XRTreeItem");
  return primitive;
}

// ─────────────────────────────────────────────────────────────
// Fallback
// ─────────────────────────────────────────────────────────────

function mapGeneric(node: IRNode, ctx: MappingContext): XRGenericPanel {
  const primitive: XRGenericPanel = {
    ...baseFrom(node, "XRGenericPanel"),
    type: "XRGenericPanel",
    irRole: node.role,
    children: resolveChildren(node, ctx),
  };
  if (!ctx.diagnostics.unmappedRoles.includes(node.role)) {
    ctx.diagnostics.unmappedRoles.push(node.role);
  }
  ctx.diagnostics.unmappedCount += 1;
  registerPrimitive(ctx, primitive, "generic→XRGenericPanel");
  return primitive;
}

// ─────────────────────────────────────────────────────────────
// Central dispatch
// ─────────────────────────────────────────────────────────────

export function mapNode(node: IRNode, ctx: MappingContext): XRPrimitive | null {
  ctx.diagnostics.totalIRNodes += 1;

  if (node.state.hidden === "true") return null;

  if (
    ctx.config.elidePresentation &&
    (node.role === "none" || node.role === "presentation")
  ) {
    trackElision(ctx);
    return null;
  }

  switch (node.role) {
    // Landmarks
    case "main":
      return node.id === "main"
        ? mapMain(node, ctx)
        : mapSection(node, ctx, "landmark:region→XRSection");
    case "navigation":
      return mapNavigation(node, ctx);
    case "banner":
      return mapBanner(node, ctx);
    case "contentinfo":
      return mapFooter(node, ctx);
    case "complementary":
      return mapComplementary(node, ctx);
    case "form":
      return mapFormPanel(node, ctx, "landmark:form→XRFormPanel");
    case "search":
      return mapFormPanel(node, ctx, "landmark:search→XRFormPanel");
    case "region":
      return mapSection(node, ctx, "landmark:region→XRSection");

    case "text":
      return mapText(node, ctx);
    // Content structure
    case "heading":
      return mapHeading(node, ctx);
    case "paragraph":
      return mapParagraph(node, ctx);
    case "article":
      return mapArticle(node, ctx);
    case "group":
      return mapGroup(node, ctx);

    // Lists
    case "list":
      return mapList(node, ctx, "list:generic→XRList");
    case "listitem":
      return mapListItem(node, ctx);
    case "feed":
      return mapList(node, ctx, "feed→XRList");

    // Media
    case "img":
      return mapImg(node, ctx);
    case "figure":
      return mapFigure(node, ctx);
    case "caption":
      return mapParagraph(node, ctx);

    // Tables
    case "table":
      return mapTable(node, ctx);
    case "row":
      return mapTableRow(node, ctx);
    case "cell":
    case "columnheader":
    case "rowheader":
      return mapTableCell(node, ctx);

    // Interactive
    case "button":
      return mapButton(node, ctx);
    case "link":
      return mapLink(node, ctx);
    case "textbox":
    case "spinbutton":
      return mapTextbox(node, ctx);
    case "searchbox":
      return mapSearchBox(node, ctx);
    case "checkbox":
    case "radio":
    case "switch":
      return mapToggle(node, ctx);
    case "combobox":
      return mapComboBox(node, ctx);
    case "slider":
      return mapSlider(node, ctx);

    // Overlays
    case "dialog":
      return mapDialog(node, ctx);
    case "alert":
      return mapAlert(node, ctx, "alert→XRAlert");
    case "status":
      return mapAlert(node, ctx, "status→XRAlert");
    case "tooltip":
      return mapTooltip(node, ctx);

    // Rich widgets
    case "tablist":
      return mapTabGroup(node, ctx);
    case "tab":
      return mapTab(node, ctx);
    case "tabpanel":
      return mapTabPanel(node, ctx);
    case "menu":
    case "menubar":
      return mapMenu(node, ctx);
    case "menuitem":
    case "menuitemcheckbox":
    case "menuitemradio":
      return mapMenuItem(node, ctx);
    case "tree":
      return mapTree(node, ctx);
    case "treeitem":
      return mapTreeItem(node, ctx);

    // Media / AV
    case "video":
    case "audio":
      return mapMedia(node, ctx);

    // Typography / decoration
    case "code":
      return mapCodeBlock(node, ctx);
    case "blockquote":
      return mapBlockQuote(node, ctx);
    case "separator":
      return mapSeparator(node, ctx);
    case "progressbar":
      return mapProgressBar(node, ctx);

    // Delegated to section/alert
    case "grid":
    case "toolbar":
    case "application":
    case "document":
      return mapSection(node, ctx, "landmark:region→XRSection");
    case "log":
      return mapAlert(node, ctx, "alert→XRAlert");
    case "timer":
    case "marquee":
      return mapParagraph(node, ctx);
    case "note":
      return mapBlockQuote(node, ctx);
    case "option":
      return mapListItem(node, ctx);

    // Fallback
    case "generic":
    default:
      return mapGeneric(node, ctx);
  }
}
