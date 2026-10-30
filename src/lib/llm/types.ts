import type { z } from "zod";

/**
 * The swappable model layer. Every LLM call in the app goes through LLMProvider, so moving from a
 * personal Claude API key to Datacom's Conver platform is a configuration change (LLM_PROVIDER),
 * not a code change. Embeddings sit behind their own interface because the Claude API has no
 * embeddings endpoint.
 */

/** What a call is for. Each task gets its own model, effort and output budget (see tasks.ts). */
export const LLM_TASKS = [
  "research",
  "classify",
  "advisor",
  "meeting_prep",
  "email_match",
  "email_summary",
  "smoke",
] as const;
export type LLMTask = (typeof LLM_TASKS)[number];

export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];

export interface LLMMessage {
  role: "user" | "assistant";
  content: string;
}

export interface WebSearchOptions {
  maxUses?: number;
  /** Restrict results to these hosts. Mutually exclusive with blockedDomains. */
  allowedDomains?: string[];
  blockedDomains?: string[];
}

/** Which prompt in /prompts produced a call, so its output can be traced and re-run. */
export interface PromptRef {
  id: string;
  version: number;
}

export interface GenerateRequest {
  task: LLMTask;
  system?: string;
  messages: LLMMessage[];
  prompt?: PromptRef;
  /** Overrides the task's default output budget. */
  maxTokens?: number;
  /** Server-side web search. Only on providers whose capabilities.webSearch is true. */
  webSearch?: WebSearchOptions;
}

export interface StructuredRequest<T> extends Omit<GenerateRequest, "webSearch"> {
  /** The output must parse against this schema or the call fails. */
  schema: z.ZodType<T>;
}

export interface WebCitation {
  url: string;
  title: string | null;
  citedText: string;
}

export interface LLMUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  webSearches: number;
}

/** Recorded alongside anything the model produces (brief sections, recommendations, summaries). */
export interface Provenance {
  provider: string;
  /** The model that actually served the response, which differs from the requested one after a fallback. */
  model: string;
  requestedModel: string;
  servedByFallback: boolean;
  prompt?: PromptRef;
}

export interface GenerateResult {
  text: string;
  citations: WebCitation[];
  usage: LLMUsage;
  provenance: Provenance;
}

export interface StructuredResult<T> {
  data: T;
  usage: LLMUsage;
  provenance: Provenance;
}

export interface LLMCapabilities {
  /** Can search and cite the public web itself. When false, research relies on source adapters only. */
  webSearch: boolean;
  structuredOutput: boolean;
}

export interface LLMProvider {
  readonly name: string;
  readonly capabilities: LLMCapabilities;
  generate(req: GenerateRequest): Promise<GenerateResult>;
  generateStructured<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>>;
}

export type EmbeddingPurpose = "document" | "query";

export interface EmbeddingProvider {
  readonly name: string;
  /** Stored with every vector, so changing models is a re-embed job rather than a schema change. */
  readonly model: string;
  readonly dimensions: number;
  embed(texts: string[], purpose: EmbeddingPurpose): Promise<number[][]>;
}

export const emptyUsage = (): LLMUsage => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  webSearches: 0,
});

export function addUsage(a: LLMUsage, b: LLMUsage): LLMUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    webSearches: a.webSearches + b.webSearches,
  };
}
