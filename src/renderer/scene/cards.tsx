/**
 * scene/cards.tsx
 *
 * Section-cards view: derive one card per top-level section, lay them out in a
 * grid, and render the card tiles / grid mesh used when the user "zooms out".
 */
import React from "react";
import { RoundedBox, Text } from "@react-three/drei";

import type {
  SemanticScene,
  XRPrimitive,
} from "../../mapper/types";
import type { LayoutPlan } from "../../layout/types";
import { useTheme } from "../theme";
import { FontContext } from "./contexts";
import {
  CARD_W,
  CARD_H,
  CARD_GAP_X,
  CARD_GAP_Y,
  CARD_COLS,
  CARD_Z,
  CARD_EYE_Y,
} from "./config";


// ─────────────────────────────────────────────────────────────
// Cards zoom system
// ─────────────────────────────────────────────────────────────

export type CardsZoomLevel = 0 | 1;

export interface SectionCardInfo {
  id: string;
  label: string;
  pageIndex: number; // absolute start page in the content panel
  endPage: number; // absolute end page (inclusive); equals startPage when unknown
  hasSubSections: boolean;
}


export function getSectionCards(
  scene: SemanticScene,
  plan: LayoutPlan,
  parentId: string | null,
): SectionCardInfo[] {
  // Sub-sections: always enumerate from the parent section's children directly
  if (parentId) {
    const parent = scene.primitives[parentId];
    if (!parent) return [];
    const children = parent.children.filter(
      (c) => c.type === "XRSection" || c.type === "XRArticle",
    );
    const endPages = computeEndPages(children, plan, Infinity);
    return children.map((child, i) => {
      const heading = child.children.find((c) => c.type === "XRHeading");
      const label = heading?.label ?? child.label ?? "";
      const pageIndex = plan.entries[child.id]?.pageIndex ?? 0;
      const hasSubSections = child.children.some(
        (c) => c.type === "XRSection" || c.type === "XRArticle",
      );
      return {
        id: child.id,
        label,
        pageIndex,
        endPage: endPages[i],
        hasSubSections,
      };
    });
  }

  // Top-level: prefer TOC nodes for labels so cards match the page's own navigation
  const mainPanel = scene.root.children.find(
    (p) => p.type === "XRContentPanel",
  );
  if (!mainPanel) return [];

  const totalPages =
    (plan.entries[mainPanel.id]?.pagination?.pageCount ?? 1) - 1; // max page index

  const sections = mainPanel.children.filter(
    (c) => c.type === "XRSection" || c.type === "XRArticle",
  );

  // Build a sorted end-page map for all sections by document order
  const sectionEndPageMap = buildSectionEndPageMap(sections, plan, totalPages);

  // Build label → section primitive so we can look up pageIndex and sub-sections
  const sectionByLabel = new Map<string, XRPrimitive>();
  for (const sec of sections) {
    const heading = sec.children.find((c) => c.type === "XRHeading");
    const key = (heading?.label ?? sec.label ?? "").toLowerCase().trim();
    if (key) sectionByLabel.set(key, sec);
  }

  const tocNav = scene.root.children.find((p) => p.type === "XRNavigationBar");
  if (tocNav && tocNav.children.length > 0) {
    const result: SectionCardInfo[] = [];
    for (const link of tocNav.children) {
      const label = link.label ?? "";
      if (!label) continue;
      const matched = sectionByLabel.get(label.toLowerCase().trim());
      const id = matched?.id ?? link.id;
      const pageIndex = matched
        ? (plan.entries[matched.id]?.pageIndex ?? 0)
        : 0;
      const endPage = matched
        ? (sectionEndPageMap.get(matched.id) ?? totalPages)
        : totalPages;
      const hasSubSections = matched
        ? matched.children.some(
            (c) => c.type === "XRSection" || c.type === "XRArticle",
          )
        : false;
      result.push({ id, label, pageIndex, endPage, hasSubSections });
    }
    if (result.length > 0) return result;
  }

  // Fallback: enumerate sections directly
  const endPages = computeEndPages(sections, plan, totalPages);
  return sections.map((child, i) => {
    const heading = child.children.find((c) => c.type === "XRHeading");
    const label = heading?.label ?? child.label ?? "";
    const pageIndex = plan.entries[child.id]?.pageIndex ?? 0;
    const hasSubSections = child.children.some(
      (c) => c.type === "XRSection" || c.type === "XRArticle",
    );
    return {
      id: child.id,
      label,
      pageIndex,
      endPage: endPages[i],
      hasSubSections,
    };
  });
}

/**
 * Given a list of sibling sections (in document order), compute the end page
 * for each using next-section-boundary: endPage[i] = startPage[i+1] - 1.
 * The last section extends to `maxPage`.
 */
export function buildSectionEndPageMap(
  sections: XRPrimitive[],
  plan: LayoutPlan,
  maxPage: number,
): Map<string, number> {
  const sorted = sections
    .map((s) => ({ id: s.id, startPage: plan.entries[s.id]?.pageIndex ?? 0 }))
    .sort((a, b) => a.startPage - b.startPage);

  const result = new Map<string, number>();
  for (let i = 0; i < sorted.length; i++) {
    const nextStart = sorted[i + 1]?.startPage;
    // Guard: endPage must be >= startPage even when adjacent sections share a page.
    const endPage =
      nextStart !== undefined
        ? Math.max(sorted[i].startPage, nextStart - 1)
        : maxPage;
    result.set(sorted[i].id, endPage);
  }
  return result;
}

/** Compute end pages for a list of siblings ordered by their position in `children`. */
export function computeEndPages(
  sections: XRPrimitive[],
  plan: LayoutPlan,
  maxPage: number,
): number[] {
  const map = buildSectionEndPageMap(sections, plan, maxPage);
  return sections.map((s) => map.get(s.id) ?? maxPage);
}


export function SectionCardTile({
  cx,
  cy,
  label,
  isActive,
  onClick,
}: {
  cx: number;
  cy: number;
  label: string;
  isActive: boolean;
  onClick: () => void;
}) {
  const theme = useTheme();
  const [hovered, setHovered] = React.useState(false);
  const fontType = React.useContext(FontContext);
  const w = CARD_W;
  const h = CARD_H;

  return (
    <group
      position={[cx, cy, CARD_Z]}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      onPointerOver={(e) => {
        e.stopPropagation();
        setHovered(true);
      }}
      onPointerOut={() => setHovered(false)}
    >
      <RoundedBox args={[w, h, 0.008]} radius={0.012}>
        <meshStandardMaterial
          color={isActive ? "#EAF2FE" : hovered ? "#F3F3F6" : theme.panelBg}
          transparent
          opacity={0.97}
          roughness={0.6}
          metalness={0}
        />
      </RoundedBox>
      {/* top accent bar */}
      <mesh position={[0, h / 2 - 0.002, 0.006]}>
        <planeGeometry args={[w * 0.65, 0.003]} />
        <meshBasicMaterial
          color={isActive || hovered ? theme.accentCol : theme.panelRim}
        />
      </mesh>
      <Text
        font={fontType}
        position={[0, 0, 0.007]}
        fontSize={0.016}
        color={isActive ? theme.accentCol : theme.headingCol}
        anchorX="center"
        anchorY="middle"
        maxWidth={w - 0.04}
        textAlign="center"
      >
        {label.length > 48 ? label.slice(0, 46) + "…" : label}
      </Text>
    </group>
  );
}

export function CardsGridMesh({
  cards,
  focusedId,
  onCardClick,
  headerLabel,
}: {
  cards: SectionCardInfo[];
  focusedId: string | null;
  onCardClick: (id: string, pageIndex: number, hasSubSections: boolean) => void;
  headerLabel?: string;
}) {
  const theme = useTheme();
  const fontType = React.useContext(FontContext);
  const cols = CARD_COLS;
  const cw = CARD_W;
  const ch = CARD_H;
  const gx = CARD_GAP_X;
  const gy = CARD_GAP_Y;
  const rows = Math.ceil(cards.length / cols);
  const gridW = cols * cw + (cols - 1) * gx;
  const gridH = rows * ch + (rows - 1) * gy;
  const startX = -gridW / 2 + cw / 2;
  const startY = CARD_EYE_Y + gridH / 2 - ch / 2;

  return (
    <>
      {headerLabel && (
        <Text
          font={fontType}
          position={[0, startY + ch / 2 + 0.055, CARD_Z]}
          fontSize={0.014}
          color={theme.bodyCol}
          anchorX="center"
          anchorY="bottom"
          letterSpacing={0.08}
        >
          {headerLabel.toUpperCase()}
        </Text>
      )}
      {cards.map(({ id, label, pageIndex, hasSubSections }, i) => {
        const col = i % cols;
        const row = Math.floor(i / cols);
        const cx = startX + col * (cw + gx);
        const cy = startY - row * (ch + gy);
        return (
          <SectionCardTile
            key={id}
            cx={cx}
            cy={cy}
            label={label}
            isActive={focusedId === id}
            onClick={() => onCardClick(id, pageIndex, hasSubSections)}
          />
        );
      })}
    </>
  );
}

