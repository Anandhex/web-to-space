/**
 * scene/use-neighbourhood.ts — the corridor of documents around this one.
 *
 * The one genuinely new layer in docs/neighbour-walls.md: nothing else in this
 * architecture has ever held more than one document. The pipeline is a pure
 * function of one page, the layout engine places one plan, and every view
 * draws one scene. A wing is a NEIGHBOURING document drawn as itself, so
 * something has to own fetching, parsing, caching and — most of all — NOT
 * doing those things when they would cost more than the wing is worth.
 *
 * It lives in the renderer rather than beside the tab because a wing is
 * presentation: it changes nothing about what the reader is reading, the same
 * way the page/panel transforms in `page-placements.ts` do not. The tab still
 * owns the document; this owns the pictures of its neighbours.
 *
 * ── The budget, and why it is not negotiable ──
 *
 * Measured (docs/neighbour-walls.md, Part II): a full parse costs 60 ms for a
 * small Wikipedia page, 559 ms for an 849 KB one and 2.8 s for the 1.4 MB
 * WAI-ARIA spec, with parsing beating layout by 10-20×. Filling every lane of
 * every axis with a real pipeline run is between 5 and 60 seconds of
 * main-thread work, and one long block inside an XR frame ends rendering
 * permanently. So:
 *
 *   · only what is DRAWN as a board (tier L0) gets a pipeline
 *   · at most `PIPELINE_BUDGET` of those per document, spent in score order
 *   · a document over `HEAVY_BYTES` is demoted rather than parsed
 *   · everything else is a `links/scan.ts` read: one DOMParser pass
 *   · nothing here is ever touched from a frame loop
 *
 * ── Cancellation ──
 *
 * Every await checks the generation it started in. A reader who takes a door
 * while eight fetches are in flight must not have the old document's wings
 * mount around the new one — and must not have the old document's PARSE run
 * either, which is the expensive half.
 */
import { useEffect, useMemo, useRef, useState } from "react";

import { parsePageToIR } from "../../ir/parser";
import { DEFAULT_CONFIG } from "../../ir/defaults";
import { mapIRToScene, DEFAULT_MAPPER_CONFIG } from "../../mapper/mapper";
import { computeLayoutPlan } from "../../layout/engine";
import { foldForArrangement } from "../../layout/content-only";
import { getArrangement } from "../../layout/placement";
import { QUEST_3_PROFILE } from "../../layout/profiles";
import { collectSpatialLinks } from "../../links/collect";
import {
  continueLane,
  neighbourKey,
  rankNeighbours,
  type Neighbour,
  type NeighbourLanes,
} from "../../links/neighbours";
import { scanBest, scanDocument, type DocScan } from "../../links/scan";
import { AXES, windowFor, type Axis, type NavState } from "../../links/memory";
import type { SpatialLink } from "../../links/types";
import type { LayoutPlan } from "../../layout/types";
import type { SemanticScene } from "../../mapper/types";

import { proxyUrl } from "../../proxy";

/**
 * How deep a corridor runs. Past this a card is smaller than the plate it
 * would replace, and the reader is better served by the plate.
 */
export const WING_MAX_DEPTH = 3;
/** What a card at this depth can be drawn as. */
export type WingTier = "L0" | "L1" | "L2";

/** Full pipelines per document. Four boards is already ~1 s of parsing. */
const PIPELINE_BUDGET = 4;
/** Past this a document is a nameplate, whatever depth it sits at. */
const HEAVY_BYTES = 500_000;
/** Documents kept across view switches and navigations. */
const CACHE_MAX = 24;
/** Fetches in flight at once. The proxy caches for an hour; this is politeness. */
const FETCH_CONCURRENCY = 3;
/**
 * How long the reader's OWN document gets to itself before any of this starts.
 *
 * Measured on the link-test hub: starting the walk on mount pushed first paint
 * from about three seconds to nine. The neighbours' parses are DOM work on the
 * same thread that is trying to lay out and mount the document the reader
 * actually asked for, and they win the race because they are started from an
 * effect that fires before the first troika glyph is uploaded.
 *
 * `requestIdleCallback` is the right instrument and this is its fallback, for
 * Safari and for a main thread so busy that idle never arrives.
 */
const NEIGHBOUR_DEFER_MS = 900;

export interface WingDoc {
  key: string;
  axis: Axis;
  lane: number;
  /** 1-based, out from the board. */
  depth: number;
  url: string;
  /** The anchor's own words until the document arrives, then its title. */
  label: string;
  why: Neighbour["why"];
  /** The anchor this came from, so a wing lights with its inline mark. */
  linkId: string | null;
  historyIndex?: number;
  state: "pending" | "ready" | "failed";
  tier: WingTier;
  /** L0 only, and only within the pipeline budget. */
  plan?: LayoutPlan;
  scene?: SemanticScene;
  pageCount?: number;
  /** L1/L2, and L0 that was demoted. */
  scan?: DocScan;
}

export type Neighbourhood = Record<Axis, WingDoc[]>;

const EMPTY: Neighbourhood = { up: [], down: [], left: [], right: [] };

// ── Document cache ───────────────────────────────────────────
//
// Module-level on purpose: it must survive a view switch and a navigation, so
// that walking into a wing and back does not re-fetch and re-parse the wall
// the reader just came from. Travelled documents are the cheap case the up
// axis depends on — `ascent` links are p90 = 0 in the census, so most vertical
// wings are history rather than links.

interface CacheEntry {
  html: string;
  scan: DocScan;
  parsed?: { scene: SemanticScene; plan: LayoutPlan; links: SpatialLink[]; pageCount: number };
  at: number;
  /**
   * The fetch failed, and asking again will not help.
   *
   * Failures are cached for the same reason successes are. The link-test page
   * carries a deliberately dead `https://example.com/a`, and without this the
   * corridor asked for it again on every re-run of the effect — six 404s for
   * one link that was never going to resolve. A reader gets the strip either
   * way; the network should not be told twice.
   */
  failed?: boolean;
}

const cache = new Map<string, CacheEntry>();

/**
 * Loads in flight, so two lanes that want the same document ask once.
 *
 * The cache alone does not prevent this: three workers walk three corridors at
 * the same time, and a document any two of them reach is requested twice
 * before either response lands to populate the cache. The link-test page made
 * it visible — one deliberately dead `https://example.com/a`, reachable from
 * several lanes, produced five 404s. Sharing the promise makes the second and
 * third arrivals free, and it is what stops two lanes parsing one document
 * twice, which is the expensive half of the same mistake.
 */
const inFlight = new Map<string, Promise<CacheEntry>>();

function cacheGet(url: string): CacheEntry | undefined {
  const e = cache.get(url);
  if (e) e.at = Date.now();
  return e;
}

function cachePut(url: string, e: CacheEntry): void {
  cache.set(url, e);
  if (cache.size > CACHE_MAX) {
    let oldest: string | null = null;
    let when = Infinity;
    for (const [k, v] of cache) if (v.at < when) ((when = v.at), (oldest = k));
    if (oldest) cache.delete(oldest);
  }
}

/** Same-origin skips the proxy, exactly as the tab's own loader does. */
async function fetchHtml(url: string, signal: AbortSignal): Promise<string> {
  const sameOrigin =
    typeof window !== "undefined" && url.startsWith(window.location.origin);
  const res = await fetch(sameOrigin ? url : proxyUrl(url), { signal });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.text();
}

/** The full pipeline, for a wing that will be drawn as a board. */
function runPipeline(html: string, url: string, viewMode: string) {
  return (async () => {
    const ir = await parsePageToIR(html, url, undefined, DEFAULT_CONFIG);
    const scene = mapIRToScene(ir, DEFAULT_MAPPER_CONFIG);
    const arrangement = getArrangement(viewMode);
    const laidOut = foldForArrangement(scene, arrangement);
    const plan = computeLayoutPlan(laidOut, QUEST_3_PROFILE, {}, undefined, arrangement);
    const links = collectSpatialLinks(laidOut, plan, { pageUrl: url, dedupe: false });
    const pageCount = Math.max(
      1,
      ...Object.values(plan.entries).map((e) => e.pagination?.pageCount ?? 1),
    );
    return { scene: laidOut, plan, links, pageCount };
  })();
}

interface Options {
  /** The document the reader is on. Null before the first load. */
  url: string | null;
  /**
   * The scope's references. The DOCUMENT's, or one section's — never one
   * rendered page: a wing is heavier than a strip and re-aiming it per page
   * would make the neighbourhood flicker as the reader turns pages.
   */
  links: readonly SpatialLink[];
  /** Changes when the scope does, so the corridor is rebuilt for a section. */
  scopeKey: string;
  nav: NavState | null;
  viewMode: string;
  /** How many lanes each axis may open, from `wingLanes`. */
  lanesFor: (axis: Axis) => number;
  /** Off while a view has no room for wings, so nothing is fetched at all. */
  enabled: boolean;
}

/**
 * Build the corridor for the current scope.
 *
 * Returns progressively: lane heads appear as `pending` the moment they are
 * ranked, so a view can draw the strip it already had and swap it for a wall
 * when the document lands, rather than showing a hole while the network works.
 */
export function useNeighbourhood(opts: Options): Neighbourhood {
  const { url, links, scopeKey, nav, viewMode, lanesFor, enabled } = opts;
  const [hood, setHood] = useState<Neighbourhood>(EMPTY);
  /** Bumped on every scope change; every await checks it before committing. */
  const generation = useRef(0);

  // ── Why `links` is not a dependency ──
  //
  // It is a pure function of (document, scope), and both of those are in `url`
  // and `scopeKey`. Its IDENTITY, however, changes for reasons that have
  // nothing to do with either: `PageLinksApi` is rebuilt whenever a view
  // publishes which hand its lateral doors took, which the wall does on its
  // first render. Depending on the array would re-rank and re-walk every
  // corridor on that publish — and, since walking a corridor can change what
  // the view draws, that is a loop with a network call in it.
  const linksRef = useRef(links);
  linksRef.current = links;

  // The ranking is cheap and synchronous; only the documents are not. Kept
  // separate so a re-render cannot re-trigger the fetching effect.
  const seeds = useMemo<NeighbourLanes>(() => {
    const none: NeighbourLanes = { up: [], down: [], left: [], right: [] };
    if (!enabled || !url) return none;
    const budget = windowFor(viewMode);
    const lanesPerAxis = Math.max(...AXES.map(lanesFor));
    const ranked = rankNeighbours({
      links: linksRef.current,
      nav,
      budget,
      lanesPerAxis,
      exclude: new Set([neighbourKey(url)]),
    });
    const out: NeighbourLanes = { up: [], down: [], left: [], right: [] };
    for (const axis of AXES) out[axis] = ranked[axis].slice(0, lanesFor(axis));
    return out;
    // `lanesFor` is a closure over the board; the scope key covers it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, url, scopeKey, nav, viewMode]);

  useEffect(() => {
    if (!enabled || !url) {
      setHood(EMPTY);
      return;
    }
    const gen = ++generation.current;
    const controller = new AbortController();
    const live = () => gen === generation.current && !controller.signal.aborted;

    /**
     * Wait until the reader's own document has had the thread.
     *
     * Everything below this line is a picture of somewhere the reader is not.
     * None of it may delay the page they ARE on.
     */
    const idle = (): Promise<void> =>
      new Promise((resolve) => {
        const ric = (globalThis as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number })
          .requestIdleCallback;
        if (ric) ric(() => resolve(), { timeout: NEIGHBOUR_DEFER_MS });
        else setTimeout(resolve, NEIGHBOUR_DEFER_MS);
      });

    // Seed the view immediately: every lane head as a pending plate, so the
    // reader sees the corridor exist before any of it has arrived.
    const initial: Neighbourhood = { up: [], down: [], left: [], right: [] };
    for (const axis of AXES)
      initial[axis] = seeds[axis].map((n) => ({
        key: `${axis}-${n.lane}-1`,
        axis,
        lane: n.lane,
        depth: 1,
        url: n.url,
        label: n.label,
        why: n.why,
        linkId: n.linkId,
        historyIndex: n.historyIndex,
        state: "pending" as const,
        tier: "L0" as WingTier,
      }));
    setHood(initial);

    /** Everything already standing, so a corridor never doubles back. */
    const corridor = new Set<string>([neighbourKey(url)]);
    for (const axis of AXES) for (const n of seeds[axis]) corridor.add(n.url);

    let pipelinesLeft = PIPELINE_BUDGET;

    const patch = (key: string, next: Partial<WingDoc>) => {
      if (!live()) return;
      setHood((prev) => {
        const out: Neighbourhood = { ...prev };
        for (const axis of AXES) {
          const i = out[axis].findIndex((w) => w.key === key);
          if (i === -1) continue;
          const copy = out[axis].slice();
          copy[i] = { ...copy[i], ...next };
          out[axis] = copy;
        }
        return out;
      });
    };

    const add = (doc: WingDoc) => {
      if (!live()) return;
      setHood((prev) => ({ ...prev, [doc.axis]: [...prev[doc.axis], doc] }));
    };

    /** Fetch + read a document, from the cache when we have been there. */
    async function load(target: string): Promise<CacheEntry | null> {
      const hit = cacheGet(target);
      if (hit) {
        if (hit.failed) throw new Error("cached failure");
        return hit;
      }
      const pending = inFlight.get(target);
      if (pending) return pending;

      // NOT this walk's AbortSignal: the request is shared, so a second lane
      // still waiting on it must not be cancelled because the first lane's
      // document changed. Cancellation is enforced by `live()` at every commit
      // instead, which is where it actually matters — nothing reaches the
      // scene without passing that check.
      const run = (async () => {
        try {
          const html = await fetchHtml(target, new AbortController().signal);
          const entry: CacheEntry = { html, scan: scanDocument(html, target), at: Date.now() };
          cachePut(target, entry);
          return entry;
        } catch (err) {
          cachePut(target, { html: "", scan: scanDocument("", target), at: Date.now(), failed: true });
          throw err;
        } finally {
          inFlight.delete(target);
        }
      })();
      inFlight.set(target, run);
      const entry = await run;
      return live() ? entry : null;
    }

    /** Walk one lane out to WING_MAX_DEPTH. */
    async function walkLane(seed: Neighbour): Promise<void> {
      let current = seed.url;
      let label = seed.label;
      let why = seed.why;
      let linkId = seed.linkId;

      for (let depth = 1; depth <= WING_MAX_DEPTH; depth++) {
        const key = `${seed.axis}-${seed.lane}-${depth}`;
        if (depth > 1)
          add({
            key,
            axis: seed.axis,
            lane: seed.lane,
            depth,
            url: current,
            label,
            why,
            linkId,
            state: "pending",
            tier: depth === 2 ? "L1" : "L2",
          });

        let entry: CacheEntry | null = null;
        try {
          entry = await load(current);
        } catch {
          patch(key, { state: "failed" });
          return;
        }
        if (!live() || !entry) return;

        // Depth 1 is the only tier drawn as a board, and only while the
        // pipeline budget lasts. Everything else lives off the cheap read.
        const wantsPipeline =
          depth === 1 && pipelinesLeft > 0 && entry.html.length <= HEAVY_BYTES;
        if (wantsPipeline && !entry.parsed) {
          pipelinesLeft--;
          // Space the parses out. Each one is an unbroken block of DOM work —
          // 60 ms for a small page, 559 ms for an 849 KB one — and four of them
          // back to back is a visible stall even when nothing else is wrong.
          await idle();
          if (!live()) return;
          try {
            entry.parsed = await runPipeline(entry.html, current, viewMode);
          } catch {
            /* a wing that will not parse is a plate; the reader loses nothing */
          }
        }
        if (!live()) return;

        patch(key, {
          state: "ready",
          label: entry.scan.title || label,
          scan: entry.scan,
          tier: depth === 1 ? (entry.parsed ? "L0" : "L1") : depth === 2 ? "L1" : "L2",
          plan: entry.parsed?.plan,
          scene: entry.parsed?.scene,
          pageCount: entry.parsed?.pageCount,
        });

        if (depth === WING_MAX_DEPTH) return;

        // Where the corridor goes next. A parsed document gets the real
        // ranker; a scanned one gets the cheap histogram, and says so.
        let next: { url: string; label: string; why: Neighbour["why"]; linkId: string | null } | null = null;
        if (entry.parsed) {
          const n = continueLane({
            links: entry.parsed.links,
            axis: seed.axis,
            lane: seed.lane,
            exclude: corridor,
          });
          if (n) next = { url: n.url, label: n.label, why: n.why, linkId: null };
        }
        if (!next) {
          const c = scanBest(entry.scan, corridor);
          if (c) next = { url: c.url, label: c.label, why: "scan", linkId: null };
        }
        if (!next) return;

        corridor.add(next.url);
        current = next.url;
        label = next.label;
        why = next.why;
        linkId = next.linkId;
      }
    }

    // Lanes are walked in score order and a few at a time: the highest-ranked
    // wing should be the one that resolves first, since it is the one most
    // likely to get a board out of the pipeline budget.
    const queue = AXES.flatMap((a) => seeds[a]).sort((a, b) => b.score - a.score);
    let cursor = 0;
    const workers = Array.from({ length: Math.min(FETCH_CONCURRENCY, queue.length) }, async () => {
      await idle();
      while (live() && cursor < queue.length) {
        const seed = queue[cursor++];
        try {
          await walkLane(seed);
        } catch {
          /* one bad lane must not stop the others */
        }
      }
    });
    void Promise.all(workers);

    return () => {
      generation.current++;
      controller.abort();
    };
  }, [seeds, enabled, url, viewMode]);

  return hood;
}
