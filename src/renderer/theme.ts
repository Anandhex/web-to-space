/**
 * theme.ts
 *
 * Runtime-configurable colour palette for XR primitives — Meta Horizon UI Set
 * look, light theme by default. Every primitive mesh in primitives.tsx reads
 * its colours from useTheme() instead of hardcoded constants, so the
 * HomeScreen Settings panel (or any other UI) can swap the palette live via
 * ThemeContext.Provider.
 *
 * Brightness bounds (per Meta's public immersive-design guidance, since the
 * actual Figma UI Set token values are gated behind login and not otherwise
 * published): pure #FFFFFF/#000000 should not be used for surfaces in
 * headset viewing — light surfaces should be no brighter than #DADADA, dark
 * surfaces no darker than #1A1A1A. Both LIGHT_THEME and DARK_THEME below
 * keep panel/nav/tile fills within that range.
 */

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
  /** Text/search input field fill. */
  inputBg: string;
  /** Fill for disabled buttons/chips. */
  disabledBg: string;
  /** Tertiary text — placeholders, disabled labels, muted captions. */
  mutedTextCol: string;
  /** Top stop of the subtle vertical gradient applied to main panel backings. */
  panelGradientTop: string;
  /** Bottom stop of the subtle vertical gradient applied to main panel backings. */
  panelGradientBottom: string;
}

export const LIGHT_THEME: XRTheme = {
  panelBg: "#DADADA",
  panelRim: "#C4C4C8",
  headingCol: "#1C1B1F",
  bodyCol: "#49454F",
  accentCol: "#0082FB",
  emphasisCol: "#1A1A1A",
  navBg: "#CACACE",
  mediaBg: "#0B0C0F",
  rimHighlight: "#5FA8FF",
  panelEmissive: "#000000",
  listItemBg: "#C2C2C7",
  inputBg: "#C8C8CC",
  disabledBg: "#B5B5BA",
  mutedTextCol: "#79747E",
  panelGradientTop: "#E2E2E2",
  panelGradientBottom: "#DADADA",
};

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
  navBg: "#4B4B4B",
  mediaBg: "#0B0C0F",
  rimHighlight: "#5B9BFF",
  panelEmissive: "#000000",
  listItemBg: "#525256",
  inputBg: "#444444",
  disabledBg: "#6A6A6A",
  mutedTextCol: "#AFAFAF",
  panelGradientTop: "#373737",
  panelGradientBottom: "#323232",
};

export const THEME_FIELD_LABELS: Record<keyof XRTheme, string> = {
  panelBg: "Panel background",
  panelRim: "Panel border",
  headingCol: "Heading / primary text",
  bodyCol: "Body / secondary text",
  accentCol: "Accent (buttons, links)",
  emphasisCol: "Emphasis (bold/italic)",
  navBg: "Nav / sidebar background",
  mediaBg: "Media background",
  rimHighlight: "Top-edge highlight",
  panelEmissive: "Panel glow (emissive)",
  listItemBg: "List item tile",
  inputBg: "Input field background",
  disabledBg: "Disabled element background",
  mutedTextCol: "Muted / placeholder text",
  panelGradientTop: "Panel gradient (top)",
  panelGradientBottom: "Panel gradient (bottom)",
};

export const ThemeContext = createContext<XRTheme>(LIGHT_THEME);

export function useTheme(): XRTheme {
  return useContext(ThemeContext);
}
