/**
 * ir/ai — layer 3's provider side.
 *
 * The parser's contract is `AIFallbackProvider` in `ir/types.ts`; everything
 * here is one implementation of it that can talk to several services.
 */
export * from "./types";
export { createAIProvider, testAIConnection } from "./provider";
export type { AIBatchReport, AIProviderHooks } from "./provider";
export { AIAdapterError } from "./adapters";
export { AI_SYSTEM_PROMPT, AI_BATCH_SCHEMA } from "./protocol";
