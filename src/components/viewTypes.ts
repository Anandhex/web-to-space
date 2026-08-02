import type { HomeSettings } from "./HomeScreen";

export type ViewMode =
  // Legacy bespoke views (hand-tuned SlotMaps + renderer branches)
  | "standard"
  | "carousel"
  // Page views (content-only): the page set becomes the spatial structure
  | "elevator"
  | "wall"
  | "deck"
  | "rooms";

/** ViewModes that route through the arrangement (two-axis) path. */
export const ARRANGEMENT_VIEW_MODES: ReadonlySet<ViewMode> = new Set<ViewMode>([
  "elevator",
  "wall",
  "deck",
  "rooms",
]);

/** Page views: content-only mode with a spatialised page set. */
export const PAGE_VIEW_MODES: ReadonlySet<ViewMode> = new Set<ViewMode>([
  "elevator",
  "wall",
  "deck",
  "rooms",
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
