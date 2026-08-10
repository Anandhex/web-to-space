/**
 * ir/ai/adapters.ts
 *
 * One adapter per provider. Each takes a batch of unclassified nodes and
 * returns the model's raw answer as text; `protocol.ts` supplies the prompt
 * and reads the answer, so an adapter is only ever about this provider's HTTP
 * surface — its auth header, its request envelope, and where in the response
 * body the text lives.
 *
 * All four call the provider DIRECTLY from the browser. This app has no server
 * of its own to put a key behind (the dev CORS proxy is dev-only, see
 * vite.config.ts), so the reader's key is used from the page, which is why the
 * Home screen says so next to the field and why the key is never sent anywhere
 * except the provider's own endpoint.
 */
import type { AIClassifyRequest } from "../types";
import {
  AI_BATCH_SCHEMA,
  AI_SYSTEM_PROMPT,
  buildBatchPrompt,
} from "./protocol";
import type { AIProviderSettings } from "./types";
import { aiProviderMeta } from "./types";

/** A provider call that failed, with whether trying again could help. */
export class AIAdapterError extends Error {
  retryable: boolean;
  status?: number;
  constructor(message: string, retryable: boolean, status?: number) {
    super(message);
    this.name = "AIAdapterError";
    this.retryable = retryable;
    this.status = status;
  }
}

export type AIAdapter = (
  items: AIClassifyRequest[],
  settings: AIProviderSettings,
  signal: AbortSignal,
) => Promise<string>;

/**
 * Output ceiling for one batch. Each answer is an id, a role, a number and a
 * clause — roughly 60 tokens — so a full batch is well under this even before
 * the models that think first are accounted for.
 */
const maxOutputTokens = (items: number) =>
  Math.min(16_000, 1_000 + items * 120);

/**
 * Rate limits and 5xx are worth another go; a bad key or a bad model id is
 * not, and retrying those only spends the reader's time before showing them
 * the message that would have fixed it.
 */
const isRetryableStatus = (status: number) =>
  status === 408 || status === 409 || status === 429 || status >= 500;

async function postJSON(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  signal: AbortSignal,
  label: string,
): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if (signal.aborted) throw new AIAdapterError(`${label} timed out`, true);
    // fetch rejects rather than returning a status for CORS and DNS failures,
    // which for a browser-direct call is the single most likely first failure.
    throw new AIAdapterError(
      `${label} could not be reached (network or CORS): ${(err as Error).message}`,
      true,
    );
  }
  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 300);
    throw new AIAdapterError(
      `${label} ${res.status}: ${detail || res.statusText}`,
      isRetryableStatus(res.status),
      res.status,
    );
  }
  return res.json();
}

// ── Anthropic ────────────────────────────────────────────────
//
// The official SDK rather than hand-rolled fetch, imported dynamically so the
// bundle only pays for it when the reader actually picks Claude.

const anthropicAdapter: AIAdapter = async (items, settings, signal) => {
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic({
    apiKey: settings.apiKey,
    ...(settings.baseUrl ? { baseURL: settings.baseUrl } : {}),
    // This app IS the browser client — there is no server tier to move the
    // call to. The SDK sends the header that permits a direct browser call.
    dangerouslyAllowBrowser: true,
    // Retries and pacing are this module's job (see provider.ts), so the SDK
    // must not add a second, invisible retry policy underneath them.
    maxRetries: 0,
  });

  const message = await client.beta.messages.create(
    {
      model: settings.model,
      max_tokens: maxOutputTokens(items.length),
      system: AI_SYSTEM_PROMPT,
      messages: [{ role: "user", content: buildBatchPrompt(items) }],
      output_config: {
        // Classification wants a decision, not a deliberation — and the schema
        // below is what actually holds the answer's shape.
        effort: "low",
        format: { type: "json_schema", schema: AI_BATCH_SCHEMA },
      },
      // Safety classifiers can decline a request, and "classify this page's
      // markup" lands on pages about any subject at all. Without a fallback a
      // declined batch is simply lost; with it the request is re-run on
      // Anthropic's recommended substitute inside the same call.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    },
    { signal },
  );

  // Check the stop reason before reading content: on a refusal `content` is
  // empty or partial, and indexing it would read as an empty answer.
  if (message.stop_reason === "refusal") {
    throw new AIAdapterError(
      `Claude declined to classify this batch${
        message.stop_details && "category" in message.stop_details
          ? ` (${message.stop_details.category})`
          : ""
      }`,
      false,
    );
  }
  const text = message.content
    .map((b) => (b.type === "text" ? b.text : ""))
    .join("");
  if (message.stop_reason === "max_tokens" && !text.trim())
    throw new AIAdapterError("Claude hit max_tokens before answering", true);
  return text;
};

// ── OpenAI (and OpenAI-compatible gateways) ──────────────────

const openaiAdapter: AIAdapter = async (items, settings, signal) => {
  const base = settings.baseUrl || aiProviderMeta("openai").defaultBaseUrl;
  const json = (await postJSON(
    `${trimSlash(base)}/chat/completions`,
    { authorization: `Bearer ${settings.apiKey}` },
    {
      model: settings.model,
      max_completion_tokens: maxOutputTokens(items.length),
      messages: [
        { role: "system", content: AI_SYSTEM_PROMPT },
        { role: "user", content: buildBatchPrompt(items) },
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "role_classification",
          strict: true,
          schema: AI_BATCH_SCHEMA,
        },
      },
    },
    signal,
    "OpenAI",
  )) as {
    choices?: { message?: { content?: string | null } }[];
  };
  return json.choices?.[0]?.message?.content ?? "";
};

// ── Google Gemini ────────────────────────────────────────────

const geminiAdapter: AIAdapter = async (items, settings, signal) => {
  const base = settings.baseUrl || aiProviderMeta("gemini").defaultBaseUrl;
  const json = (await postJSON(
    // The key goes in a header, not in the `?key=` query parameter the docs
    // reach for first: a URL is logged, cached, and sent on as a referrer.
    `${trimSlash(base)}/models/${encodeURIComponent(settings.model)}:generateContent`,
    { "x-goog-api-key": settings.apiKey },
    {
      systemInstruction: { parts: [{ text: AI_SYSTEM_PROMPT }] },
      contents: [{ role: "user", parts: [{ text: buildBatchPrompt(items) }] }],
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: toGeminiSchema(AI_BATCH_SCHEMA),
        maxOutputTokens: maxOutputTokens(items.length),
      },
    },
    signal,
    "Gemini",
  )) as {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
  };
  return (
    json.candidates?.[0]?.content?.parts
      ?.map((p) => p.text ?? "")
      .join("") ?? ""
  );
};

/**
 * Gemini takes an OpenAPI-flavoured subset of JSON Schema and rejects the
 * request outright on a key it does not know — `additionalProperties` being
 * the one this schema carries for the other two providers' strict modes.
 */
function toGeminiSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(toGeminiSchema);
  if (!schema || typeof schema !== "object") return schema;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === "additionalProperties") continue;
    out[key] = toGeminiSchema(value);
  }
  return out;
}

// ── Ollama (local) ───────────────────────────────────────────

const ollamaAdapter: AIAdapter = async (items, settings, signal) => {
  const base = settings.baseUrl || aiProviderMeta("ollama").defaultBaseUrl;
  const url = `${trimSlash(base)}/api/chat`;
  const body = (format: unknown) => ({
    model: settings.model,
    stream: false,
    format,
    options: { num_predict: maxOutputTokens(items.length) },
    messages: [
      { role: "system", content: AI_SYSTEM_PROMPT },
      { role: "user", content: buildBatchPrompt(items) },
    ],
  });
  type OllamaReply = { message?: { content?: string } };

  try {
    // Schema-constrained output, on the Ollama builds that support it.
    const json = (await postJSON(
      url,
      {},
      body(AI_BATCH_SCHEMA),
      signal,
      "Ollama",
    )) as OllamaReply;
    return json.message?.content ?? "";
  } catch (err) {
    // Older builds only understand `format: "json"` and reject a schema with a
    // 400. That is a version difference, not a broken setup, so it downgrades
    // rather than surfacing — the prompt still asks for the same shape.
    if (!(err instanceof AIAdapterError) || err.status !== 400) throw err;
    const json = (await postJSON(
      url,
      {},
      body("json"),
      signal,
      "Ollama",
    )) as OllamaReply;
    return json.message?.content ?? "";
  }
};

const trimSlash = (s: string) => s.replace(/\/+$/, "");

export const AI_ADAPTERS: Record<AIProviderSettings["provider"], AIAdapter> = {
  anthropic: anthropicAdapter,
  openai: openaiAdapter,
  gemini: geminiAdapter,
  ollama: ollamaAdapter,
};
