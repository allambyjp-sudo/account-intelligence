import { createHash } from "node:crypto";
import { LLMCapabilityError, LLMOutputError } from "./errors";
import {
  emptyUsage,
  type EmbeddingProvider,
  type EmbeddingPurpose,
  type GenerateRequest,
  type GenerateResult,
  type LLMCapabilities,
  type LLMProvider,
  type StructuredRequest,
  type StructuredResult,
} from "./types";

export type MockResponder = (req: GenerateRequest | StructuredRequest<unknown>) => unknown;

/**
 * Deterministic provider for tests and for running the UI without an API key. It never touches the
 * network and records every call so tests can assert on prompts.
 */
export class MockProvider implements LLMProvider {
  readonly name = "mock";
  readonly calls: Array<GenerateRequest | StructuredRequest<unknown>> = [];

  constructor(
    private readonly respond: MockResponder = (req) => `[mock ${req.task} response]`,
    readonly capabilities: LLMCapabilities = { webSearch: false, structuredOutput: true },
  ) {}

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    if (req.webSearch && !this.capabilities.webSearch) {
      throw new LLMCapabilityError("This provider can't search the web");
    }
    this.calls.push(req);
    const out = this.respond(req);
    return { text: typeof out === "string" ? out : JSON.stringify(out), citations: [], usage: emptyUsage(), provenance: this.provenance(req) };
  }

  async generateStructured<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>> {
    this.calls.push(req as StructuredRequest<unknown>);
    const parsed = req.schema.safeParse(this.respond(req as StructuredRequest<unknown>));
    if (!parsed.success) throw new LLMOutputError("Mock response didn't match the schema");
    return { data: parsed.data, usage: emptyUsage(), provenance: this.provenance(req) };
  }

  private provenance(req: GenerateRequest) {
    return { provider: this.name, model: "mock", requestedModel: "mock", servedByFallback: false, ...(req.prompt ? { prompt: req.prompt } : {}) };
  }
}

/**
 * Hash-based vectors: same text, same vector; no semantic meaning. For tests and wiring only.
 * The real embedding provider (local model or Voyage) arrives with account memory in Phase 4.
 */
export class MockEmbeddingProvider implements EmbeddingProvider {
  readonly name = "mock";
  readonly model = "mock-hash-v1";
  constructor(readonly dimensions = 384) {}

  async embed(texts: string[], _purpose: EmbeddingPurpose): Promise<number[][]> {
    return texts.map((text) => {
      const out: number[] = [];
      for (let block = 0; out.length < this.dimensions; block++) {
        const digest = createHash("sha256").update(`${block}:${text}`).digest();
        for (const byte of digest) {
          if (out.length < this.dimensions) out.push(byte / 127.5 - 1);
        }
      }
      const norm = Math.hypot(...out) || 1;
      return out.map((v) => v / norm);
    });
  }
}
