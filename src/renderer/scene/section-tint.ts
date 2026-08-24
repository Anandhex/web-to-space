/**
 * scene/section-tint.ts
 *
 * The palette a section owns, plus the sRGB colour helpers the spatial views
 * mix with. Lifted out of wall-field.tsx when the deck grew lanes: a section's
 * hue has to be the SAME colour on the board and on the table, or the two
 * views' spatial memory disagrees about which section is which.
 *
 * Six hues, walked in order and wrapped. Six because that is about as many as
 * stay tellable apart at a glance (and a document with more top-level sections
 * than that has bigger problems than colour); walked in order rather than
 * hashed from the label so neighbouring sections are always adjacent hues — a
 * view that reads through the spectrum, not a bag of confetti.
 *
 * Every colour here is mixed in sRGB, explicitly.
 *
 * three's default working space is LINEAR sRGB, so `setHSL(h, s, 0.19)` and
 * `offsetHSL(0, 0, -0.07)` operate on linear values — and a lightness step
 * that reads as a nudge on paper is enormous down there. Left implicit, the
 * wall's backing came out PURE BLACK in the dark theme (panelBg #323232 is
 * linear-lightness 0.033; subtracting 0.07 clamps at zero) and every section
 * tint landed a good two stops brighter than asked for. Both were caught by
 * the offline palette audit, not by looking, which is the only way this kind
 * of bug gets caught at all — so the colour space is spelled out at every
 * call, and the numbers below mean what they say.
 */
import * as THREE from "three";

import type { XRTheme } from "../theme";

const SECTION_HUES = [212, 168, 268, 36, 344, 104];

/** Set a colour's saturation and lightness outright, keeping only its hue. */
function atLightness(hue: number, s: number, l: number): string {
  const c = new THREE.Color();
  c.setHSL(hue / 360, s, l, THREE.SRGBColorSpace);
  return `#${c.getHexString()}`;
}

/** Move a colour up or down in sRGB lightness, keeping hue and saturation. */
export function shade(hex: string, delta: number): string {
  const c = new THREE.Color(hex);
  const hsl = { h: 0, s: 0, l: 0 };
  c.getHSL(hsl, THREE.SRGBColorSpace);
  c.setHSL(
    hsl.h,
    hsl.s,
    Math.max(0, Math.min(1, hsl.l + delta)),
    THREE.SRGBColorSpace,
  );
  return `#${c.getHexString()}`;
}

export function isDarkTheme(theme: XRTheme): boolean {
  const hsl = { h: 0, s: 0, l: 0 };
  new THREE.Color(theme.panelBg).getHSL(hsl, THREE.SRGBColorSpace);
  return hsl.l < 0.5;
}

/**
 * A section's palette: the saturated accent that carries its identity (spine,
 * badge, rail), and the two quiet surface tints its tile and its pages' mounts
 * are made of. Lightnesses are set outright rather than nudged from the hue,
 * so all six sections sit at exactly the same value and only the hue varies —
 * anything else and one section reads as "highlighted".
 */
export interface SectionTint {
  accent: string;
  /** Fill for the section's own tile, closed and open. */
  tile: string;
  tileOpen: string;
  /** Mount around each of the section's page cells. */
  mount: string;
  /** Ink that reads on `accent` — a badge's number. */
  onAccent: string;
}

/** WCAG relative luminance of an sRGB hex. */
function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const u = v / 255;
    return u <= 0.03928 ? u / 12.92 : ((u + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}

const INK_DARK = "#141414";
const INK_LIGHT = "#F7F7F7";

/** WCAG contrast ratio between two sRGB hexes. */
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Whichever ink reads better on a given fill. Fixed per THEME instead, the
 * badge numbers on the teal and green sections came out at 3:1 — those hues
 * are far more luminous than blue at the same nominal lightness, so hue by
 * hue there is no one ink that works. The accent lightnesses below are then
 * chosen to keep the WORST hue clear of 4.5:1 with the ink it picks (the
 * break-even between the two inks is the low point, so a lightness that sits
 * on it is the one thing to avoid).
 */
function inkOn(fill: string): string {
  return contrast(INK_LIGHT, fill) >= contrast(INK_DARK, fill)
    ? INK_LIGHT
    : INK_DARK;
}

export function sectionTint(index: number, dark: boolean): SectionTint {
  const hue = SECTION_HUES[index % SECTION_HUES.length];
  // Accent lightness is picked so the WORST of the six hues still clears
  // 4.5:1 against whichever ink `inkOn` gives it — see there.
  const accent = dark
    ? atLightness(hue, 0.62, 0.64)
    : atLightness(hue, 0.58, 0.3);
  return {
    accent,
    tile: dark ? atLightness(hue, 0.14, 0.19) : atLightness(hue, 0.16, 0.8),
    tileOpen: dark ? atLightness(hue, 0.22, 0.27) : atLightness(hue, 0.26, 0.72),
    // The light mount sits at the tile's own level rather than nearer the
    // wall: held any lower it separated from the backing by hue alone, at
    // 1.06:1, and a mount you cannot see is not a mount.
    mount: dark ? atLightness(hue, 0.2, 0.23) : atLightness(hue, 0.18, 0.79),
    onAccent: inkOn(accent),
  };
}

/**
 * The palette for a lane the READER made (the deck's shelf), which stands for
 * no section and so owns no hue: the theme's own neutral, at the same values
 * the tinted lanes use so it sits in the same material family.
 */
export function neutralTint(theme: XRTheme, dark: boolean): SectionTint {
  const accent = theme.mutedTextCol;
  return {
    accent,
    tile: shade(theme.panelBg, dark ? -0.04 : -0.03),
    tileOpen: shade(theme.panelBg, dark ? 0.02 : -0.01),
    mount: shade(theme.panelBg, dark ? -0.02 : -0.02),
    onAccent: inkOn(accent),
  };
}
