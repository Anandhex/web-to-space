/**
 * ir/ai/provider.ts
 *
 * The batching provider the parser actually holds.
 *
 * `classifyBatch` is handed every node a page could not classify — often
 * dozens — and turns them into a handful of requests instead of one per node.
 * That is the whole point of the interface: the parser's walk is sequential,
 * so a per-node provider serialises the network end to end (forty nodes at a
 * second each is forty seconds of blank screen) and re-sends the same system
 * prompt forty times. Chunked and run a few at a time, the same page costs two
 * or three round trips.
 *
 * Three properties the parser depends on, and which the failure paths here
 * exist to preserve:
 *
 *  • POSITIONAL. `out[i]` answers `items[i]`. Always the same length.
 *  • PARTIAL. A chunk that fails takes only its own nodes down with it — the
 *    rest of the page still gets its answers, and a node with no answer just
 *    keeps the role layers 1–2 gave it. Layer 3 is a fallback; it is never
 *    allowed to be the reason a page fails to parse.
 *  • BOUNDED. Every request has a timeout, retries are capped, and the page as
 *    a whole has a node ceiling, so a bad provider costs a wait, not a hang.
 */
import type {
  AIClassifyRequest,
  AIFallbackProvider,
  AIFallbackResponse,
} from "../types";
import { AI_ADAPTERS, AIAdapterError } from "./adapters";
import { parseBatchResponse } from "./protocol";
import type { AIProviderSettings } from "./types";
import { aiProviderMeta, aiSettingsReady } from "./types";

/** What happened on one batch — for the diagnostics line, not for control flow. */
export interface AIBatchReport {
  chunks: number;
  requested: number;
  answered: number;
  /** Chunk failures, already de-duplicated by message. */
  errors: string[];
  elapsedMs: number;
}

interface AIProviderHooks {
  /** Called once per `classifyBatch`. */
  onReport?: (report: AIBatchReport) => void;
}

/** Attempts per chunk, first try included. */
const MAX_ATTEMPTS = 3;
/** Backoff before retry n (0-based), in ms. */
const backoffMs = (attempt: number) => 600 * 2 ** attempt;

export function createAIProvider(
  settings: AIProviderSettings,
  hooks: AIProviderHooks = {},
): AIFallbackProvider {
  const adapter = AI_ADAPTERS[settings.provider];

  async function runChunk(
    chunk: AIClassifyRequest[],
  ): Promise<Map<string, AIFallbackResponse>> {
    let lastError: unknown = null;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      // A fresh controller per attempt: an aborted signal stays aborted, so
      // reusing one would fail every retry before it left the building.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), settings.timeoutMs);
      try {
        const raw = await adapter(chunk, settings, controller.signal);
        return parseBatchResponse(raw);
      } catch (err) {
        lastError = err;
        const retryable = !(err instanceof AIAdapterError) || err.retryable;
        if (!retryable || attempt === MAX_ATTEMPTS - 1) break;
        await sleep(backoffMs(attempt));
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error(String(lastError ?? "unknown provider error"));
  }

  async function classifyBatch(
    items: AIClassifyRequest[],
  ): Promise<(AIFallbackResponse | null)[]> {
    const started = Date.now();
    const out: (AIFallbackResponse | null)[] = items.map(() => null);
    if (items.length === 0 || !aiSettingsReady(settings)) return out;

    // The ceiling applies to what is SENT, not to what is answered: the nodes
    // past it keep their structural role, exactly as if the provider had had
    // nothing to say about them.
    const sent = items.slice(0, Math.max(0, settings.maxNodes));
    const index = new Map(sent.map((it, i) => [it.nodeId, i]));

    const chunks: AIClassifyRequest[][] = [];
    const size = Math.max(1, settings.batchSize);
    for (let i = 0; i < sent.length; i += size)
      chunks.push(sent.slice(i, i + size));

    const errors = new Set<string>();
    let answered = 0;
    let next = 0;

    // A fixed pool of workers pulling from one queue: this is the rate limit.
    // Firing every chunk at once is how a 40-node page earns a 429 and then
    // spends its retry budget discovering that.
    const worker = async () => {
      for (;;) {
        const i = next++;
        if (i >= chunks.length) return;
        try {
          const answers = await runChunk(chunks[i]);
          for (const [id, answer] of answers) {
            const at = index.get(id);
            // An id we did not ask about — a hallucinated or mangled key — is
            // dropped rather than written to whichever node sits at that slot.
            if (at === undefined || out[at]) continue;
            out[at] = answer;
            answered++;
          }
        } catch (err) {
          errors.add((err as Error).message);
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.max(1, Math.min(settings.maxConcurrent, chunks.length)) }, worker),
    );

    hooks.onReport?.({
      chunks: chunks.length,
      requested: sent.length,
      answered,
      errors: [...errors],
      elapsedMs: Date.now() - started,
    });
    return out;
  }

  return {
    classifyBatch,
    async classify(domSubtree, nodeId) {
      const [only] = await classifyBatch([
        { nodeId, tag: "div", subtree: domSubtree, currentRole: "generic" },
      ]);
      return only;
    },
  };
}

/**
 * One tiny real request, for the Home screen's "Test" button.
 *
 * It classifies a synthetic `<nav>`-shaped element rather than pinging some
 * health endpoint, because what the reader needs to know is not "is the host
 * up" but "does this key, this model and this browser's CORS policy actually
 * produce an answer" — which only a real call can settle.
 */
export async function testAIConnection(
  settings: AIProviderSettings,
): Promise<{ ok: boolean; detail: string; elapsedMs: number }> {
  const started = Date.now();
  if (!aiSettingsReady(settings)) {
    const meta = aiProviderMeta(settings.provider);
    return {
      ok: false,
      detail: meta.needsKey ? "Add an API key and a model first." : "Add a model and a base URL first.",
      elapsedMs: 0,
    };
  }
  let report: AIBatchReport | null = null;
  const provider = createAIProvider(settings, {
    onReport: (r) => {
      report = r;
    },
  });
  const [answer] = await provider.classifyBatch([
    {
      nodeId: "probe-1",
      tag: "div",
      currentRole: "generic",
      subtree:
        '<div class="site-links"><a href="/">Home</a><a href="/docs">Docs</a><a href="/about">About</a></div>',
    },
  ]);
  const elapsedMs = Date.now() - started;
  const failed = (report as AIBatchReport | null)?.errors ?? [];
  if (failed.length > 0) return { ok: false, detail: failed[0], elapsedMs };
  if (!answer)
    return {
      ok: false,
      detail: "Connected, but the model's answer could not be read.",
      elapsedMs,
    };
  return {
    ok: true,
    detail: `Answered "${answer.role}" at ${(answer.confidence * 100).toFixed(0)}% confidence.`,
    elapsedMs,
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
