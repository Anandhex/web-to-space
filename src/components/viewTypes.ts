import type { HomeSettings } from "./HomeScreen";
import type { Axis, NavState } from "../links/memory";

/**
 * The three spatial concepts the browser offers. Each is a DIFFERENT kind of
 * spatial interaction, not a different configuration of the same one:
 *
 *   • rooms — you navigate the site as an environment you walk through.
 *   • wall  — you see the site as one spatial structure you survey at once.
 *   • deck  — you handle the page's parts as objects on a surface.
 *
 * All three are page views: the page SET is the spatial structure, so the
 * roster collapses to [main] and the renderer scatters the pages itself.
 */
export type ViewMode = "wall" | "deck" | "rooms";

export interface Tab {
  id: string;
  label: string;       // hostname or "New Tab"
  url: string;
  html: string;        // empty string = show home screen
  settings: HomeSettings;
  /**
   * Where this tab's reader has been (src/links/memory.ts).
   *
   * PER TAB, not global: a corridor is a reading session, and two tabs are two
   * readers. Null until the tab loads its first document — a home screen has
   * no session root to hang a corridor off.
   */
  nav: NavState | null;
  /**
   * A directional move in flight: the reader has taken a door and the document
   * behind it is being fetched.
   *
   * The document they are ON stays mounted and rendered throughout. Clearing
   * it the moment a door was taken swapped the whole scene for a DOM spinner,
   * which meant the one thing the reader needed to see — the board turning, the
   * table sliding, the direction they were actually going — was replaced by a
   * loading screen before it had drawn a frame. The move is the feedback; a
   * spinner is what you show when there is none.
   *
   * Null when nothing is in flight. `axis` is which way they went, so every
   * view can say so in its own geometry.
   */
  pending: { url: string; axis: Axis | null } | null;
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
