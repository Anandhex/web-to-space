/**
 * ir/ai/types.ts
 *
 * What the reader configures on the Home screen for layer 3, and the registry
 * of providers that configuration can point at.
 *
 * The parser knows nothing about any of this — it holds an
 * `AIFallbackProvider` and calls `classifyBatch`. Everything here is about
 * which service that provider ends up talking to, which is a user decision,
 * not a parser one.
 */
import type { IRRole } from "../types";

export type AIProviderId = "anthropic" | "openai" | "gemini" | "ollama";

export interface AIProviderSettings {
  provider: AIProviderId;
  /**
   * The reader's own key. Held in memory and (opt-in) in localStorage on this
   * device; it is sent only to the provider's own endpoint. A key in a browser
   * page is readable by anything else running on this origin — see the note
   * each provider carries in the Home screen.
   */
  apiKey: string;
  /** Model id. Free text: the roster below only supplies a starting point. */
  model: string;
  /** Override the API host — required for `ollama`, optional elsewhere. */
  baseUrl: string;
  /** Nodes per request. The batching lever; see `classifyBatch`. */
  batchSize: number;
  /** Requests in flight at once. */
  maxConcurrent: number;
  /**
   * Hard ceiling on nodes sent per page. A pathological page can fall through
   * to layer 3 for hundreds of nodes; without a ceiling the reader's first
   * clue is the bill.
   */
  maxNodes: number;
  /** Per-request timeout. A slow provider must not hang the whole parse. */
  timeoutMs: number;
}

export interface AIProviderMeta {
  id: AIProviderId;
  label: string;
  /** Local models need no key; everything hosted does. */
  needsKey: boolean;
  defaultModel: string;
  defaultBaseUrl: string;
  /** Where the reader gets a key, shown next to the field. */
  keyHint: string;
  /**
   * What the reader is agreeing to by turning this on. Every adapter calls the
   * provider DIRECTLY from the browser — there is no server in this app to put
   * a key behind — so each entry says what that means for that provider.
   */
  note: string;
}

/**
 * The roster. Adding a provider is an entry here plus an adapter in
 * `adapters.ts`; nothing else in the codebase learns its name.
 *
 * `defaultModel` is a starting point, not a pin. Model ids move faster than
 * this file does, so the Home screen exposes the model as an editable field
 * and an unknown id surfaces as the provider's own error rather than as
 * something this app pretends to know better about.
 */
export const AI_PROVIDERS: AIProviderMeta[] = [
  {
    id: "anthropic",
    label: "Claude (Anthropic)",
    needsKey: true,
    defaultModel: "claude-opus-5",
    defaultBaseUrl: "",
    keyHint: "console.anthropic.com → API keys",
    note: "Calls api.anthropic.com from this page with your key. The official SDK is loaded on demand and sends the header that permits a direct browser call.",
  },
  {
    id: "openai",
    label: "OpenAI",
    needsKey: true,
    defaultModel: "gpt-4o-mini",
    defaultBaseUrl: "https://api.openai.com/v1",
    keyHint: "platform.openai.com → API keys",
    note: "Calls the Chat Completions endpoint from this page with your key. Any OpenAI-compatible gateway works — point the base URL at it.",
  },
  {
    id: "gemini",
    label: "Gemini (Google)",
    needsKey: true,
    defaultModel: "gemini-2.0-flash",
    defaultBaseUrl: "https://generativelanguage.googleapis.com/v1beta",
    keyHint: "aistudio.google.com → Get API key",
    note: "Calls generativelanguage.googleapis.com from this page. The key goes in a header, never in the URL, so it stays out of logs and referrers.",
  },
  {
    id: "ollama",
    label: "Ollama (local)",
    needsKey: false,
    defaultModel: "llama3.2",
    defaultBaseUrl: "http://localhost:11434",
    keyHint: "No key — runs on this machine",
    note: "Nothing leaves the machine. Ollama must allow this page's origin: start it with OLLAMA_ORIGINS=* (or this origin) or the browser blocks the request.",
  },
];

export function aiProviderMeta(id: AIProviderId): AIProviderMeta {
  return AI_PROVIDERS.find((p) => p.id === id) ?? AI_PROVIDERS[0];
}

export const DEFAULT_AI_SETTINGS: AIProviderSettings = {
  provider: "anthropic",
  apiKey: "",
  model: aiProviderMeta("anthropic").defaultModel,
  baseUrl: aiProviderMeta("anthropic").defaultBaseUrl,
  // Twenty-four nodes is a page's worth of stragglers in one round trip and
  // still a small enough prompt that a mistake is cheap to retry.
  batchSize: 24,
  maxConcurrent: 2,
  maxNodes: 120,
  timeoutMs: 45_000,
};

/** Whether these settings can actually be used to make a call. */
export function aiSettingsReady(s: AIProviderSettings): boolean {
  const meta = aiProviderMeta(s.provider);
  if (!s.model.trim()) return false;
  if (meta.needsKey && !s.apiKey.trim()) return false;
  if (!meta.needsKey && !s.baseUrl.trim()) return false;
  return true;
}

/** Switch provider, carrying that provider's own defaults in with it. */
export function withProvider(
  s: AIProviderSettings,
  id: AIProviderId,
): AIProviderSettings {
  const meta = aiProviderMeta(id);
  return {
    ...s,
    provider: id,
    model: meta.defaultModel,
    baseUrl: meta.defaultBaseUrl,
    // Keys are per-provider; carrying one across would send Anthropic's key to
    // OpenAI on the next parse.
    apiKey: "",
  };
}

/**
 * The roles layer 3 is allowed to return.
 *
 * Deliberately a fraction of `IRRole`. The full union is 60-odd values, most
 * of which describe things a `generic` div never turns out to be (`rowheader`,
 * `menuitemradio`, `timer`), and a long enum costs tokens in every request and
 * accuracy in every answer. What is left is the set that changes how the
 * mapper builds the scene: containers, the text-bearing leaves, and the few
 * structures worth their own primitive.
 */
export const AI_CLASSIFIABLE_ROLES = [
  "navigation",
  "banner",
  "contentinfo",
  "complementary",
  "search",
  "form",
  "region",
  "article",
  "list",
  "listitem",
  "table",
  "figure",
  "blockquote",
  "code",
  "heading",
  "paragraph",
  "note",
  "group",
  "toolbar",
  "dialog",
  "feed",
  "status",
  "generic",
] as const satisfies readonly IRRole[];

export type AIClassifiableRole = (typeof AI_CLASSIFIABLE_ROLES)[number];

const ROLE_SET: ReadonlySet<string> = new Set(AI_CLASSIFIABLE_ROLES);

/** Is this string one of the roles we asked for? */
export function isClassifiableRole(v: unknown): v is AIClassifiableRole {
  return typeof v === "string" && ROLE_SET.has(v);
}
