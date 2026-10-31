import { LLMNotConfiguredError } from "./errors";
import type { EmbeddingProvider, EmbeddingPurpose } from "./types";

type Env = Record<string, string | undefined>;

/**
 * Local embeddings with transformers.js, run in the worker. Free, and account memory never leaves
 * the machine. The package is optional (it pulls in an ONNX runtime): install it with
 *   npm install @huggingface/transformers
 * The model downloads from Hugging Face on first use, so huggingface.co must be reachable once.
 */
export class LocalEmbeddingProvider implements EmbeddingProvider {
  readonly name = "local";
  readonly model: string;
  readonly dimensions: number;
  private pipe: Promise<(texts: string[], opts: Record<string, unknown>) => Promise<{ tolist(): number[][] }>> | undefined;

  constructor(env: Env = process.env) {
    this.model = env.LOCAL_EMBEDDING_MODEL ?? "Xenova/all-MiniLM-L6-v2";
    this.dimensions = Number(env.LOCAL_EMBEDDING_DIMENSIONS ?? 384);
  }

  async embed(texts: string[], _purpose: EmbeddingPurpose): Promise<number[][]> {
    if (!texts.length) return [];
    this.pipe ??= (async () => {
      const moduleName = "@huggingface/transformers";
      let mod: { pipeline: (task: string, model: string) => Promise<unknown> };
      try {
        mod = (await import(/* webpackIgnore: true */ moduleName)) as typeof mod;
      } catch {
        throw new LLMNotConfiguredError("EMBEDDING_PROVIDER=local needs the optional package: npm install @huggingface/transformers");
      }
      return (await mod.pipeline("feature-extraction", this.model)) as (texts: string[], opts: Record<string, unknown>) => Promise<{ tolist(): number[][] }>;
    })();
    const extractor = await this.pipe;
    const out = await extractor(texts, { pooling: "mean", normalize: true });
    return out.tolist();
  }
}

interface VoyageResponse {
  data: Array<{ embedding: number[]; index: number }>;
  model: string;
}

/** Voyage AI, the embeddings provider Anthropic's docs recommend. Needs VOYAGE_API_KEY. */
export class VoyageEmbeddingProvider implements EmbeddingProvider {
  readonly name = "voyage";
  readonly model: string;
  readonly dimensions: number;
  private readonly key: string;

  constructor(
    env: Env = process.env,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    const key = env.VOYAGE_API_KEY?.trim();
    if (!key) throw new LLMNotConfiguredError("EMBEDDING_PROVIDER=voyage needs VOYAGE_API_KEY");
    this.key = key;
    this.model = env.VOYAGE_MODEL ?? "voyage-3.5";
    this.dimensions = Number(env.VOYAGE_DIMENSIONS ?? 1024);
  }

  async embed(texts: string[], purpose: EmbeddingPurpose): Promise<number[][]> {
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += 64) {
      const batch = texts.slice(i, i + 64);
      const res = await this.fetchImpl("https://api.voyageai.com/v1/embeddings", {
        method: "POST",
        headers: { authorization: `Bearer ${this.key}`, "content-type": "application/json" },
        body: JSON.stringify({ input: batch, model: this.model, input_type: purpose }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) throw new Error(`Voyage embeddings failed: ${res.status} ${await res.text().catch(() => "")}`.trim());
      const body = (await res.json()) as VoyageResponse;
      out.push(...body.data.sort((a, b) => a.index - b.index).map((d) => d.embedding));
    }
    return out;
  }
}
