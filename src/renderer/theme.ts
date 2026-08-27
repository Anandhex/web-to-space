import { createContext, useContext } from "react";

export interface XRTheme {
  /** White backplate — base card fill for panels floating in XR space. */
  panelBg: string;
  /** Soft grey outline token — thin card border. */
  panelRim: string;
  /** Near-black on-surface — primary text. */
  headingCol: string;
  /** Grey on-surface-variant — secondary/body text. */
  bodyCol: string;
  /** Meta Horizon primary brand colour — buttons, links, active states. */
  accentCol: string;
  /** Emphasis spans (bold/italic) inside prose. */
  emphasisCol: string;
  /** Recessed surface — nav/sidebar panels recede behind white content cards. */
  navBg: string;
  /** Deepest surface — behind video/media. */
  mediaBg: string;
  /** Soft gradient tint along a card's top edge (MultiGradientUI-style). */
  rimHighlight: string;
  /** Emissive colour on panel materials — "#000000" for a flat matte look. */
  panelEmissive: string;
  /** Fill for individual list-item tiles — a shade distinct from panelBg so tiles read against their container. */
  listItemBg: string;
  /**
   * Fill for a section's own card — one quiet step off panelBg.
   *
   * Deliberately a small step: a section sits ON the content panel, so the two
   * surfaces are near-coplanar and a strong contrast between them reads as two
   * competing cards rather than as one card holding a group. The grouping is
   * carried by the rhythm gaps and the card's padding; this only has to make
   * the card's edge findable.
   */
  sectionBg: string;
  /** Text/search input field fill — also the code block's ground. */
  inputBg: string;
  /**
   * Ink for code-block text, on `inputBg`.
   *
   * A light mint, NOT the GitHub light-theme green (#116329) this replaces:
   * that green on the #444444 code ground measured 1.32:1, which is not a low
   * contrast ratio so much as invisible text. Every code block on the test page
   * rendered as a dark bar with nothing readable in it. This value clears
   * 6.6:1, well past AA, which is the floor worth holding in a headset where
   * the glyphs are already near the resolution limit.
   */
  codeCol: string;
  /** Fill for disabled buttons/chips. */
  disabledBg: string;
  /** Tertiary text — placeholders, disabled labels, muted captions. */
  mutedTextCol: string;
  /** Top stop of the subtle vertical gradient applied to main panel backings. */
  panelGradientTop: string;
  /** Bottom stop of the subtle vertical gradient applied to main panel backings. */
  panelGradientBottom: string;
  /** Text on the fixed pastel "polite" alert/status surface — that surface stays a fixed light tint in both themes, so this must too (not bodyCol, which is meant to sit on the theme's panelBg). */
  infoTextCol: string;
}

// Sampled directly from an in-headset Quest Design System screenshot and
// refined against a precise user-supplied palette: neutral charcoal, not
// the navy-tinted grey an earlier guess used.
export const DARK_THEME: XRTheme = {
  panelBg: "#323232",
  panelRim: "#5B5B5B",
  headingCol: "#F5F5F5",
  bodyCol: "#D8D8D8",
  accentCol: "#0082FB",
  emphasisCol: "#F5F5F5",
  // Nav/sidebar surface — kept in the same charcoal family as panelBg (only a
  // hair lighter) so the TOC/nav panels read as the same material as the main
  // content panel rather than a distinct, lighter, blue-tinted surface.
  navBg: "#3A3A3A",
  mediaBg: "#0B0C0F",
  rimHighlight: "#5B9BFF",
  panelEmissive: "#000000",
  listItemBg: "#525256",
  sectionBg: "#3A3A3D",
  inputBg: "#444444",
  codeCol: "#9BE6B0",
  disabledBg: "#6A6A6A",
  mutedTextCol: "#AFAFAF",
  panelGradientTop: "#373737",
  panelGradientBottom: "#323232",
  infoTextCol: "#1B4C8C",
};

export const ThemeContext = createContext<XRTheme>(DARK_THEME);

export function useTheme(): XRTheme {
  return useContext(ThemeContext);
}
