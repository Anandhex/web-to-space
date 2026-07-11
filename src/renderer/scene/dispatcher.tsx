/**
 * scene/dispatcher.tsx
 *
 * <PrimitiveDispatcher> — the per-primitive switch that maps each XRPrimitive
 * to its mesh, gating on page visibility and routing paginated containers,
 * inline-flow owners, and block-child containers to the correct render path.
 */
import React, { useCallback } from "react";

import type {
  XRPrimitive,
  XRHeading,
  XRParagraph,
  XRNavigationBar,
  XRMediaPlayer,
  XRCodeBlock,
  XRBlockQuote,
  XRSeparator,
  XRProgressBar,
  XRImage,
  XRButton,
  XRAlert,
  XRFormField,
  XRSection,
  XRListItem,
  XRTable,
  XRTabGroup,
} from "../../mapper/types";
import type { LayoutEntry, LayoutPlan } from "../../layout/types";
import { useTheme } from "../theme";
import {
  flattenInlineWrappers,
  isInlinePrimitive,
  mergeAdjacentTextRuns,
} from "../../layout/utils";
import {
  XRHeadingMesh,
  XRParagraphMesh,
  XRSectionMesh,
  XRNavigationMesh,
  XRMediaMesh,
  XRCodeBlockMesh,
  XRTextMesh,
  XRLinkMesh,
  XRBlockQuoteMesh,
  XRSeparatorMesh,
  XRProgressBarMesh,
  XRImageMesh,
  XRListItemMesh,
  XRButtonMesh,
  XRAlertMesh,
  XRTableMesh,
  XRFormFieldMesh,
  XRToggleMesh,
  XRSliderMesh,
  XRComboBoxMesh,
  XRSearchBoxMesh,
  XRTabGroupMesh,
  ClipPlanesContext,
  PanelOriginYContext,
  CardSelfClipContext,
  PanelCurveContext,
  resolveCurveRadius,
  type PanelCurve,
  ClippedText,
  buildInlineRows,
  InlineProseRows,
  useRenderMetrics,
} from "../primitives";
import { AtPos } from "./AtPos";
import {
  CurrentPageContext,
  FontContext,
  entryOnPage,
  zeroedEntry,
  type PageState,
} from "./contexts";
import {
  DispatchChildren,
  WithSiblingChildren,
  hasDescendant,
} from "./dispatch-children";
import {
  PaginatingPanelRenderer,
  PanelBacking,
  GenericPanelMesh,
  buildPanelClipPlanes,
} from "./panels";

export interface DispatcherProps {
  primitive: XRPrimitive;
  plan: LayoutPlan;
  pageState: PageState;
  setPage: (id: string, page: number) => void;
  primitiveMap: Map<string, XRPrimitive>;
}

/**
 * Render an inline-owning container (XRCodeBlock, XRBlockQuote) that may wrap
 * either inline prose or block-level content. When it holds block children they
 * need real panel-absolute LayoutEntry positions and must be dispatched as true
 * siblings (mesh draws only its own chrome); otherwise the mesh flows its inline
 * children itself. `makeMesh(renderChild)` builds the backing mesh — pass a
 * no-op renderChild for the sibling-dispatch path, the real one otherwise.
 */
function renderInlineOwningContainer(args: {
  entry: LayoutEntry;
  children: XRPrimitive[];
  plan: LayoutPlan;
  pageState: PageState;
  setPage: (id: string, page: number) => void;
  primitiveMap: Map<string, XRPrimitive>;
  renderChild: (childId: string) => React.ReactNode;
  makeMesh: (renderChild: (childId: string) => React.ReactNode) => React.ReactNode;
}): React.ReactNode {
  const {
    entry,
    children,
    plan,
    pageState,
    setPage,
    primitiveMap,
    renderChild,
    makeMesh,
  } = args;
  const flat = flattenInlineWrappers(children as any[]);
  const hasInlineChild = flat.some((c: any) => isInlinePrimitive(c.type));
  const blockChildren = flat.filter((c: any) => !isInlinePrimitive(c.type));

  if (blockChildren.length > 0) {
    return (
      <WithSiblingChildren
        entry={entry}
        backing={makeMesh(() => null)}
        primitives={hasInlineChild ? blockChildren : children}
        plan={plan}
        pageState={pageState}
        setPage={setPage}
        primitiveMap={primitiveMap}
      />
    );
  }
  return <AtPos entry={entry}>{makeMesh(renderChild)}</AtPos>;
}

export function PrimitiveDispatcher({
  primitive,
  plan,
  pageState,
  setPage,
  primitiveMap,
}: DispatcherProps) {
  const entry = plan.entries[primitive.id];
  const currentPage = React.useContext(CurrentPageContext);
  const fontType = React.useContext(FontContext);
  const theme = useTheme();
  const metrics = useRenderMetrics();

  const renderChild = useCallback(
    (childId: string) => {
      const childPrim = primitiveMap.get(childId);
      if (!childPrim || !plan.entries[childId]) {
        console.warn(`[RENDER] Child ${childId} not found in map or entries`);
        return null;
      }
      return (
        <PrimitiveDispatcher
          key={childId}
          primitive={childPrim}
          plan={plan}
          pageState={pageState}
          setPage={setPage}
          primitiveMap={primitiveMap}
        />
      );
    },
    [primitiveMap, plan, pageState, setPage],
  );

  if (!entry) return null;

  // ✅ Define hasVisibleDescendant FIRST before using it
  const hasVisibleDescendant = (node: XRPrimitive): boolean => {
    // FIRST: Check all children recursively (any depth)
    for (const child of node.children) {
      if (hasVisibleDescendant(child)) return true;
    }

    // SECOND: If no children are visible, check if this node itself is visible
    const nodeEntry = plan.entries[node.id];
    if (nodeEntry?.pageIndex !== undefined && currentPage !== -1) {
      return entryOnPage(nodeEntry, currentPage);
    }

    // Node has no pageIndex (not in paginated panel) and no visible children
    return false;
  };

  // ✅ If entry has NO pageIndex, it's not in a paginated panel
  // Render it (it's a top-level landmark or the content panel itself)
  if (entry.pageIndex === undefined) {
    // We still need to render children, but they'll filter themselves
    // Fall through to the switch statement
  } else {
    // ✅ Entry HAS a pageIndex - it's in a paginated panel
    const isContainer = primitive.children.length > 0;

    if (isContainer) {
      // For containers: check if they have visible descendants
      const hasVisible = hasVisibleDescendant(primitive);
      if (!hasVisible) {
        return null;
      }
    } else {
      // For leaf nodes: filter by page (honours a page range when present)
      if (!entryOnPage(entry, currentPage)) {
        return null;
      }
    }
  }
  // // In PrimitiveDispatcher, after getting entry:
  // console.log(
  //   `[POS] ${primitive.id} (${primitive.type}) position:`,
  //   entry.position,
  // );

  // ✅ If we get here, render this node
  // console.log(primitive.type, primitive, "on page", entry.pageIndex ?? "N/A");

  // Any container the engine paginated (XRContentPanel, XRSection, XRArticle,
  // XRFormPanel, XRGenericPanel at the top level) has panel-absolute child
  // positions and must render children inside its own positioned group.
  if (entry.paginatedByEngine) {
    return (
      <PaginatingPanelRenderer
        primitive={primitive}
        plan={plan}
        pageState={pageState}
        setPage={setPage}
        primitiveMap={primitiveMap}
        entry={entry}
      />
    );
  }

  switch (primitive.type) {
    case "XRHeading":
      return (
        <AtPos entry={entry}>
          <XRHeadingMesh
            primitive={primitive as XRHeading}
            entry={zeroedEntry(entry)}
            renderChild={renderChild}
          />
        </AtPos>
      );
    case "XRParagraph":
      return (
        <AtPos entry={entry}>
          <XRParagraphMesh
            primitive={primitive as XRParagraph}
            entry={zeroedEntry(entry)}
            renderChild={renderChild}
            getChildEntry={(childId: string) => plan.entries[childId] ?? null}
          />
        </AtPos>
      );
    case "XRText":
      return (
        <AtPos entry={entry}>
          <XRTextMesh
            primitive={primitive as import("../../mapper/types").XRText}
            entry={zeroedEntry(entry)}
          />
        </AtPos>
      );
    case "XRLink": {
      const linkPrimitive = primitive as import("../../mapper/types").XRLink;
      return (
        <AtPos entry={entry}>
          <XRLinkMesh
            primitive={linkPrimitive}
            entry={zeroedEntry(entry)}
            renderChild={renderChild}
          />
        </AtPos>
      );
    }
    case "XRNavigationBar": {
      const onNavigate = (href: string) => {
        const sectionId = href.startsWith("#") ? href.slice(1) : href;
        const sectionEntry = plan.entries[sectionId];
        if (!sectionEntry || sectionEntry.pageIndex === undefined) return;
        for (const [, p] of primitiveMap) {
          if (p.type === "XRContentPanel" && hasDescendant(p, sectionId)) {
            setPage(p.id, sectionEntry.pageIndex);
            return;
          }
        }
      };
      return (
        <AtPos entry={entry}>
          <XRNavigationMesh
            primitive={primitive as XRNavigationBar}
            entry={zeroedEntry(entry)}
            onNavigate={onNavigate}
          />
        </AtPos>
      );
    }
    case "XRMediaPlayer":
      return (
        <AtPos entry={entry}>
          <XRMediaMesh
            primitive={primitive as XRMediaPlayer}
            entry={zeroedEntry(entry)}
          />
        </AtPos>
      );
    // XRCodeBlock and XRBlockQuote share one behaviour: the mesh flows inline
    // children itself, but block-level children (e.g. a <p> inside a blockquote)
    // need real panel-absolute positions and must be dispatched as siblings —
    // otherwise they're silently dropped. See renderInlineOwningContainer.
    case "XRCodeBlock":
      return renderInlineOwningContainer({
        entry,
        children: primitive.children,
        plan,
        pageState,
        setPage,
        primitiveMap,
        renderChild,
        makeMesh: (rc) => (
          <XRCodeBlockMesh
            primitive={primitive as XRCodeBlock}
            entry={zeroedEntry(entry)}
            renderChild={rc}
          />
        ),
      });
    case "XRBlockQuote":
      return renderInlineOwningContainer({
        entry,
        children: primitive.children,
        plan,
        pageState,
        setPage,
        primitiveMap,
        renderChild,
        makeMesh: (rc) => (
          <XRBlockQuoteMesh
            primitive={primitive as XRBlockQuote}
            entry={zeroedEntry(entry)}
            renderChild={rc}
          />
        ),
      });
    case "XRSeparator":
      return (
        <AtPos entry={entry}>
          <XRSeparatorMesh
            primitive={primitive as XRSeparator}
            entry={zeroedEntry(entry)}
          />
        </AtPos>
      );
    case "XRProgressBar":
      return (
        <AtPos entry={entry}>
          <XRProgressBarMesh
            primitive={primitive as XRProgressBar}
            entry={zeroedEntry(entry)}
          />
        </AtPos>
      );
    case "XRImage":
      return (
        <AtPos entry={entry}>
          <XRImageMesh
            primitive={primitive as XRImage}
            entry={zeroedEntry(entry)}
          />
        </AtPos>
      );
    case "XRFigure": {
      return (
        <WithSiblingChildren
          entry={entry}
          backing={<PanelBacking entry={zeroedEntry(entry)} />}
          primitives={primitive.children}
          plan={plan}
          pageState={pageState}
          setPage={setPage}
          primitiveMap={primitiveMap}
        />
      );
    }
    case "XRButton":
      return (
        <AtPos entry={entry}>
          <XRButtonMesh
            primitive={primitive as XRButton}
            entry={zeroedEntry(entry)}
          />
        </AtPos>
      );
    case "XRAlert":
      return (
        <AtPos entry={entry}>
          <XRAlertMesh
            primitive={primitive as XRAlert}
            entry={zeroedEntry(entry)}
            renderChild={renderChild}
          />
        </AtPos>
      );
    case "XRFormField":
      return (
        <AtPos entry={entry}>
          <XRFormFieldMesh
            primitive={primitive as XRFormField}
            entry={zeroedEntry(entry)}
          />
        </AtPos>
      );

    case "XRSection": {
      const sectionChildEntries = primitive.children
        .map((c) => plan.entries[c.id])
        .filter((e): e is LayoutEntry => !!e && entryOnPage(e, currentPage));
      return (
        <WithSiblingChildren
          entry={entry}
          backing={
            <XRSectionMesh
              primitive={primitive as XRSection}
              entry={zeroedEntry(entry)}
              childEntries={sectionChildEntries}
              renderChild={() => null}
              isContinuation={false}
              hasMore={false}
            />
          }
          primitives={primitive.children}
          plan={plan}
          pageState={pageState}
          setPage={setPage}
          primitiveMap={primitiveMap}
        />
      );
    }

    case "XRBanner":
    case "XRFooter":
      // Intentionally hidden from the XR view — header/footer chrome is
      // not useful in an immersive spatial context.
      return null;

    case "XRArticle":
    case "XRFormPanel": {
      // Children have panel-absolute positions — render own backing then
      // dispatch children as siblings to avoid double-translating offsets.
      return (
        <WithSiblingChildren
          entry={entry}
          backing={<PanelBacking entry={zeroedEntry(entry)} />}
          primitives={primitive.children}
          plan={plan}
          pageState={pageState}
          setPage={setPage}
          primitiveMap={primitiveMap}
        />
      );
    }

    case "XRComplementary": {
      // Both hoisted (no pageIndex) and extracted (pageIndex set) complementaries
      // share the same rendering: backing + children wrapped in <AtPos> at the
      // slot's world position. Children carry LOCAL positions from stackChildrenSimple
      // relative to the complementary slot's top-left, so they must render INSIDE
      // this group — not as world-space siblings — for the slot offset to compose.
      //
      // The aside curves onto its own cylinder: its backing bends explicitly
      // around its centre, and PanelCurveContext bends every child (their <AtPos>
      // wrappers tangent-place them). The outer <AtPos> here only places the aside
      // at its world slot — it reads no ambient curve, so the aside itself stays
      // put while its contents wrap.
      const compRadius = resolveCurveRadius(entry.curveRadius);
      const compCurve: PanelCurve | null = compRadius
        ? { radius: compRadius, centerX: entry.size.width / 2 }
        : null;
      return (
        <AtPos entry={entry}>
          <PanelCurveContext.Provider value={compCurve}>
            <PanelBacking entry={zeroedEntry(entry)} curve={compCurve} />
            {/* Clip child content to the aside's own bounds, and expose the
                slot's world-Y origin — a landmark panel is not paginated, so
                nothing upstream provides these. Card self-clip is disabled
                because items here carry parent-relative (not panel-absolute) Y
                (see CardSelfClipContext). */}
            <ClipPlanesContext.Provider
              value={buildPanelClipPlanes(entry.position.y, entry.size.height)}
            >
              <PanelOriginYContext.Provider value={entry.position.y}>
                <CardSelfClipContext.Provider value={false}>
                  <DispatchChildren
                    primitives={primitive.children}
                    plan={plan}
                    pageState={pageState}
                    setPage={setPage}
                    primitiveMap={primitiveMap}
                  />
                </CardSelfClipContext.Provider>
              </PanelOriginYContext.Provider>
            </ClipPlanesContext.Provider>
          </PanelCurveContext.Provider>
        </AtPos>
      );
    }

    case "XRListItem": {
      // FIX: flatten transparent XRGenericPanel wrappers (e.g. a <span> or
      // <cite> node wrapping <a>…</a>) before deciding whether this item
      // has only block children.  Without flattening, a list item whose
      // entire prose run is wrapped in one XRGenericPanel (e.g. Wikipedia
      // citation items: listitem → generic → [XRLink, XRText, …]) reports
      // hasOnlyBlockChildren=true and goes to the WithSiblingChildren path,
      // which dispatches the XRGenericPanel via PrimitiveDispatcher.  That
      // dispatcher renders XRGenericPanel as a transparent container and
      // dispatches its children at their plan-absolute positions — producing
      // the overlapping / cascading text seen in the screenshot.
      //
      // After flattening, the wrapper is unwrapped and its inline children
      // surface here, so hasOnlyBlockChildren=false and the item takes the
      // correct "mesh owns child rendering" path.
      const flatEffectiveChildren = flattenInlineWrappers(
        primitive.children as any[],
      );
      const hasOnlyBlockChildren =
        flatEffectiveChildren.length > 0 &&
        flatEffectiveChildren.every((c: any) => !isInlinePrimitive(c.type));

      // Used by the mixed inline+block branch below: the non-inline subset
      // of this item's flattened children (e.g. the <div>/<section> wrapper
      // sitting alongside an inline icon link) — these must be dispatched
      // as true positioned siblings, never rendered through XRListItemMesh,
      // to avoid double-applying their already-absolute positions.
      const blockChildrenForDispatch = flatEffectiveChildren.filter(
        (c: any) => !isInlinePrimitive(c.type),
      );

      if (hasOnlyBlockChildren) {
        // Block-only card: backing at card position, children as siblings.
        return (
          <WithSiblingChildren
            entry={entry}
            backing={
              <XRListItemMesh
                primitive={primitive as XRListItem}
                entry={zeroedEntry(entry)}
                renderChild={() => null}
                panelRelativeY={entry.position.y}
              />
            }
            primitives={primitive.children}
            plan={plan}
            pageState={pageState}
            setPage={setPage}
            primitiveMap={primitiveMap}
          />
        );
      }

      // Inline-children case (e.g. a card whose direct children mix an
      // inline icon/link with a block wrapper — image+HTML/CSS/JS cards):
      // mesh draws its own backing/accent/label/inline-prose-row, but block
      // children must NOT be rendered through it.
      //
      // FIX: XRListItemMesh's <group position={pos}> sits at this item's
      // real absolute coordinates (needed so the backing panel lands in the
      // right spot). Previously blockChildren were rendered via
      // renderChild(child.id) called FROM INSIDE that same positioned group
      // — but renderChild resolves through PrimitiveDispatcher, which wraps
      // each block child in its OWN <AtPos> using that child's already-
      // absolute panel-space position. Nesting an absolutely-positioned
      // child inside an already-absolutely-positioned group double-applies
      // the translation (this is the same double-translation bug fixed for
      // XRSection/hasOnlyBlockChildren above, just one level deeper here).
      // The extra drift was each item's own absolute X added a second time,
      // so item 2's content landed in item 3's column, item 3's landed off
      // the grid entirely — reading as a "shift" rather than "exponential"
      // because the comparison point (each item's OWN slot) moves too.
      //
      // Fix mirrors the XRSection/block-only-XRListItem pattern exactly:
      // XRListItemMesh renders at a ZEROED entry (so it only draws its own
      // backing/accent/label/inline-icon-row, never anything carrying an
      // absolute child position), wrapped in a single outer <AtPos> for
      // the real position, and block children are dispatched as true
      // siblings via WithSiblingChildren — never nested inside the mesh's
      // own positioned group.
      return (
        <WithSiblingChildren
          entry={entry}
          backing={
            <XRListItemMesh
              primitive={primitive as XRListItem}
              entry={zeroedEntry(entry)}
              renderChild={() => null}
              panelRelativeY={entry.position.y}
            />
          }
          primitives={blockChildrenForDispatch}
          plan={plan}
          pageState={pageState}
          setPage={setPage}
          primitiveMap={primitiveMap}
        />
      );
    }

    case "XRList": {
      const listChildDispatch = (
        <DispatchChildren
          primitives={primitive.children}
          plan={plan}
          pageState={pageState}
          setPage={setPage}
          primitiveMap={primitiveMap}
        />
      );
      // Inside a landmark slot (e.g. XRComplementary) the list's items carry
      // positions relative to THIS list, not to the slot, so they must be
      // nested in a group at the list's own offset. Inside a paginated content
      // panel the items already carry panel-absolute positions and are
      // dispatched as flat siblings (no wrapping) so they compose with the
      // panel's single group.
      return entry.childrenParentRelative ? (
        <AtPos entry={entry}>{listChildDispatch}</AtPos>
      ) : (
        listChildDispatch
      );
    }

    case "XRTableRow":
    case "XRTableCell":
      // Children have panel-absolute positions — dispatch as siblings only.
      return (
        <DispatchChildren
          primitives={primitive.children}
          plan={plan}
          pageState={pageState}
          setPage={setPage}
          primitiveMap={primitiveMap}
        />
      );

    case "XRTable": {
      return (
        <WithSiblingChildren
          entry={entry}
          backing={
            <XRTableMesh
              primitive={primitive as XRTable}
              entry={zeroedEntry(entry)}
              renderChild={() => null}
            />
          }
          primitives={primitive.children}
          plan={plan}
          pageState={pageState}
          setPage={setPage}
          primitiveMap={primitiveMap}
        />
      );
    }

    case "XRTabGroup":
      return (
        <AtPos entry={entry}>
          <XRTabGroupMesh
            primitive={primitive as XRTabGroup}
            entry={zeroedEntry(entry)}
            renderChild={renderChild}
          />
        </AtPos>
      );

    case "XRTab":
    case "XRTabPanel":
    case "XRMenu":
    case "XRMenuItem":
    case "XRTree":
    case "XRTreeItem":
    case "XRDialog":
    case "XRTooltip":
    case "XRToggle":
      return (
        <AtPos entry={entry}>
          <XRToggleMesh
            primitive={primitive as import("../../mapper/types").XRToggle}
            entry={zeroedEntry(entry)}
          />
        </AtPos>
      );
    case "XRSlider":
      return (
        <AtPos entry={entry}>
          <XRSliderMesh
            primitive={primitive as import("../../mapper/types").XRSlider}
            entry={zeroedEntry(entry)}
          />
        </AtPos>
      );
    case "XRComboBox":
      return (
        <AtPos entry={entry}>
          <XRComboBoxMesh
            primitive={primitive as import("../../mapper/types").XRComboBox}
            entry={zeroedEntry(entry)}
          />
        </AtPos>
      );
    case "XRSearchBox":
      return (
        <AtPos entry={entry}>
          <XRSearchBoxMesh
            primitive={primitive as import("../../mapper/types").XRSearchBox}
            entry={zeroedEntry(entry)}
          />
        </AtPos>
      );

    default: {
      // XRGenericPanel is a transparent wrapper — no visual of its own.
      // Children already carry panel-absolute positions, so dispatch directly.
      // A childless GenericPanel (e.g. an unmapped leaf like a bare <time>
      // element with no ARIA role) carries its own text in content/label —
      // the engine already reserves height for that text, so it must be
      // rendered here or it becomes a dead, invisible gap.
      if (primitive.type === "XRGenericPanel") {
        const leafText =
          (primitive as unknown as { content?: string | null }).content ??
          primitive.label;
        if (primitive.children.length === 0 && leafText) {
          const w = Math.max(entry.size.width, 0.025);
          return (
            <AtPos entry={entry}>
              <ClippedText
                font={fontType}
                anchorX="left"
                anchorY="top"
                position={[0.008, -0.008, 0.004]}
                fontSize={0.018}
                color={theme.bodyCol}
                maxWidth={w - 0.016}
              >
                {leafText}
              </ClippedText>
            </AtPos>
          );
        }

        // A generic panel with no ARIA role that wraps pure inline content
        // (e.g. Wikipedia's <span class="mw-reference-text"><cite>…</cite>
        // </span> — no direct text of its own, so shouldDecomposeContent
        // never fires on it) is exactly the case the layout engine's
        // isInlineOwningNode (src/layout/engine.ts) already recognizes as
        // "inline-owning": it deliberately does NOT stamp positions for its
        // inline children, expecting them to be flowed as prose by this
        // panel rather than independently dispatched. This check MUST match
        // isInlineOwningNode exactly (all effective children inline, not
        // just some) — a mixed panel that engine treats as a normal
        // container gives its block children real per-child LayoutEntries,
        // and flowing them through InlineProseRows here instead of
        // DispatchChildren would discard those stamped positions.
        const flatForInline = flattenInlineWrappers(
          primitive.children as any[],
        );
        const isAllInlineChildren =
          flatForInline.length > 0 &&
          flatForInline.every((c: any) => isInlinePrimitive(c.type));
        if (isAllInlineChildren) {
          const merged = mergeAdjacentTextRuns(flatForInline as any[]);
          const rows = buildInlineRows(merged);
          const m = metrics.paragraph;
          const w = Math.max(entry.size.width, 0.025);
          return (
            <AtPos entry={entry}>
              <InlineProseRows
                rows={rows}
                startY={0}
                panelWidth={w}
                fontSize={m.fontSize}
                lineHeightRatio={m.lineHeightRatio}
                renderChild={renderChild}
              />
            </AtPos>
          );
        }

        return (
          <DispatchChildren
            primitives={primitive.children}
            plan={plan}
            pageState={pageState}
            setPage={setPage}
            primitiveMap={primitiveMap}
          />
        );
      }

      // Unknown container: render a debug backing, children as siblings.
      return (
        <WithSiblingChildren
          entry={entry}
          backing={
            <GenericPanelMesh
              primitive={primitive}
              entry={zeroedEntry(entry)}
            />
          }
          primitives={primitive.children}
          plan={plan}
          pageState={pageState}
          setPage={setPage}
          primitiveMap={primitiveMap}
        />
      );
    }
  }
}
// ─────────────────────────────────────────────────────────────
// Sub-components
// ─────────────────────────────────────────────────────────────

