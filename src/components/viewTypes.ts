import type { HomeSettings } from "./HomeScreen";

export type ViewMode =
  // Legacy bespoke views (hand-tuned SlotMaps + renderer branches)
  | "standard"
  | "carousel"
  | "theatre"
  // Two-axis arrangement views (frame + distribution over the content template)
  | "cockpit"
  | "strata"
  | "dome"
  | "hud"
  | "exploded"
  | "constellation";

/** ViewModes that route through the arrangement (two-axis) path. */
export const ARRANGEMENT_VIEW_MODES: ReadonlySet<ViewMode> = new Set<ViewMode>([
  "cockpit",
  "strata",
  "dome",
  "hud",
  "exploded",
  "constellation",
]);

export interface Tab {
  id: string;
  label: string;       // hostname or "New Tab"
  url: string;
  html: string;        // empty string = show home screen
  settings: HomeSettings;
}

export function makeTabId(): string {
  return `tab-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

export function labelFromUrl(url: string): string {
  if (!url) return "New Tab";
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "New Tab";
  }
}
