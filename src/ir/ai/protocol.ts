/**
 * ir/ai/protocol.ts
 *
 * The one prompt, the one schema, and the one parser every adapter shares.
 *
 * Four providers, four request shapes — but if each also had its own prompt
 * and its own idea of what a good answer looks like, swapping providers would
 * change the PARSE, not just the vendor. So the wire format is defined once
 * here: the same instructions, the same JSON schema, and the same tolerant
 * reader for whatever comes back. An adapter's whole job is to carry this
 * across its provider's HTTP surface.
 *
 * The unit is a BATCH. One request carries many nodes and the answer comes
 * back keyed by node id, which is what makes layer 3 affordable — see
 * `AIFallbackProvider.classifyBatch`.
 */
import type { AIClassifyRequest, AIFallbackResponse } from "../types";
import { AI_CLASSIFIABLE_ROLES, isClassifiableRole } from "./types";

/**
 * How much of a node's serialised subtree goes in the prompt.
 *
 * A div's role is decided by its first screenful — the tag names, the class
 * hints, the shape of the first few children. Sending the whole subtree of a
 * page-sized wrapper would spend most of the request on content that argues
 * for nothing.
 */
const SUBTREE_CHAR_CAP = 1400;

export const AI_SYSTEM_PROMPT = `You classify unlabelled HTML elements for a screen-reader-style accessibility tree. Each item is an element whose role could not be determined from ARIA attributes or from its tag, given with a trimmed serialisation of its subtree.

For each item, answer with the ARIA-style role that a screen reader user would find most useful for that element, chosen from the allowed list. Judge the element by what it contains and what a reader would do with it, not by its class names alone — class names are a hint, not evidence.

Answer "generic" when the element is a layout wrapper with no meaning of its own, and give it a low confidence. A wrong specific role is worse than an honest "generic": the caller keeps its own answer whenever your confidence is low, so an uncertain guess costs nothing and a confident wrong one corrupts the page.

Confidence is your own probability that the role is right, from 0 to 1. Keep the reasoning to one short clause naming the evidence you used.

Return one entry for every item you are given, using the id exactly as supplied, and nothing else.`;

/**
 * JSON schema for the batch answer.
 *
 * Every provider here can constrain output to a schema, and each wants it in
 * a slightly different envelope — so the schema itself is shared and the
 * adapters wrap it. `additionalProperties: false` plus a full `required` list
 * is what Anthropic's and OpenAI's strict modes need; the others treat it as
 * a strong hint.
 */
export const AI_BATCH_SCHEMA = {
  type: "object",
  properties: {
    results: {
      type: "array",
      description: "One entry per item, in any order.",
      items: {
        type: "object",
        properties: {
          id: { type: "string", description: "The item id, copied verbatim." },
          role: { type: "string", enum: [...AI_CLASSIFIABLE_ROLES] },
          confidence: { type: "number", description: "0 to 1." },
          reasoning: { type: "string", description: "One short clause." },
        },
        required: ["id", "role", "confidence", "reasoning"],
        additionalProperties: false,
      },
    },
  },
  required: ["results"],
  additionalProperties: false,
} as const;

/** The user-turn payload: the items, as compact JSON. */
export function buildBatchPrompt(items: AIClassifyRequest[]): string {
  const payload = items.map((it) => ({
    id: it.nodeId,
    tag: it.tag,
    html: it.subtree.slice(0, SUBTREE_CHAR_CAP),
  }));
  return `Classify these ${items.length} elements. Allowed roles: ${AI_CLASSIFIABLE_ROLES.join(", ")}.\n\n${JSON.stringify(payload)}`;
}

/**
 * Pull the results array out of whatever the model actually sent.
 *
 * Structured outputs make a clean `{"results": [...]}` the norm, but this runs
 * against four providers and a local model of the reader's choosing, and the
 * failure that matters is the one where a good answer is thrown away over a
 * wrapper: a bare array, a fenced code block, a sentence of preamble. So the
 * reader is deliberately forgiving about the envelope and strict about the
 * contents — an entry with an unknown role or an unparseable confidence is
 * dropped, not coerced into something the mapper will act on.
 */
export function parseBatchResponse(
  raw: string,
): Map<string, AIFallbackResponse> {
  const out = new Map<string, AIFallbackResponse>();
  const parsed = looseParseJSON(raw);
  if (!parsed) return out;

  const list = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as { results?: unknown }).results)
      ? (parsed as { results: unknown[] }).results
      : null;
  if (!list) return out;

  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const id = typeof e.id === "string" ? e.id : null;
    if (!id || !isClassifiableRole(e.role)) continue;
    const confidence = Number(e.confidence);
    if (!Number.isFinite(confidence)) continue;
    out.set(id, {
      role: e.role,
      // A model that answers 95 rather than 0.95 means the same thing; a model
      // that answers 4 does not, so only the percentage reading is rescued.
      confidence: clamp01(confidence > 1 && confidence <= 100 ? confidence / 100 : confidence),
      reasoning:
        typeof e.reasoning === "string" ? e.reasoning.slice(0, 240) : "",
    });
  }
  return out;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * JSON.parse, then — only if that fails — the first balanced `{...}` or
 * `[...]` in the text. Fenced blocks and one-line preambles are the two ways a
 * model that was asked for JSON still sends prose around it.
 */
function looseParseJSON(raw: string): unknown {
  const text = raw.trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    /* fall through to the scan */
  }
  const start = text.search(/[[{]/);
  if (start < 0) return null;
  const open = text[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}
