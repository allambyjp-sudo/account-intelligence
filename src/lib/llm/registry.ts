import { AnthropicProvider } from "./anthropic";
import { ConverProvider } from "./conver";
import { LLMNotConfiguredError } from "./errors";
import { MockEmbeddingProvider, MockProvider } from "./mock";
import type { EmbeddingProvider, LLMProvider } from "./types";

type Env = Record<string, string | undefined>;

export const LLM_PROVIDERS = ["anthropic", "conver", "mock"] as const;

/** Picks the provider from LLM_PROVIDER. This is the only place application code learns which one. */
export function createLLMProvider(env: Env = process.env): LLMProvider {
  const name = env.LLM_PROVIDER ?? "anthropic";
  switch (name) {
    case "anthropic":
      return new AnthropicProvider({ env });
    case "conver":
      return new ConverProvider(env);
    case "mock":
      if (env.NODE_ENV === "production") {
        throw new LLMNotConfiguredError("LLM_PROVIDER=mock is for development and tests, not production");
      }
      return new MockProvider();
    default:
      throw new LLMNotConfiguredError(`Unknown LLM_PROVIDER "${name}". Use one of: ${LLM_PROVIDERS.join(", ")}`);
  }
}

export function createEmbeddingProvider(env: Env = process.env): EmbeddingProvider {
  const name = env.EMBEDDING_PROVIDER ?? "mock";
  switch (name) {
    case "mock":
      return new MockEmbeddingProvider();
    case "local":
    case "voyage":
      throw new LLMNotConfiguredError(`EMBEDDING_PROVIDER=${name} arrives with account memory in Phase 4`);
    default:
      throw new LLMNotConfiguredError(`Unknown EMBEDDING_PROVIDER "${name}"`);
  }
}

let llm: LLMProvider | undefined;
let embeddings: EmbeddingProvider | undefined;

export function getLLMProvider(): LLMProvider {
  llm ??= createLLMProvider();
  return llm;
}

export function getEmbeddingProvider(): EmbeddingProvider {
  embeddings ??= createEmbeddingProvider();
  return embeddings;
}
