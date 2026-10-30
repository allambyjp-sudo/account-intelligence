import { LLMNotConfiguredError } from "./errors";
import type {
  GenerateRequest,
  GenerateResult,
  LLMCapabilities,
  LLMProvider,
  StructuredRequest,
  StructuredResult,
} from "./types";

type Env = Record<string, string | undefined>;

/**
 * Datacom's internal AI platform. A stub until we know whether Conver exposes an API, how it
 * authenticates, and whether it is approved for mailbox data (brief, section 8).
 *
 * To implement: map GenerateRequest onto Conver's request format, return the served model in
 * provenance, and set capabilities honestly. If Conver has no web search, leave webSearch false
 * and the research agent falls back to the source adapters alone.
 */
export class ConverProvider implements LLMProvider {
  readonly name = "conver";
  readonly capabilities: LLMCapabilities = { webSearch: false, structuredOutput: false };
  private readonly baseUrl: string | undefined;

  constructor(env: Env = process.env) {
    this.baseUrl = env.CONVER_BASE_URL;
  }

  async generate(_req: GenerateRequest): Promise<GenerateResult> {
    throw this.notReady();
  }

  async generateStructured<T>(_req: StructuredRequest<T>): Promise<StructuredResult<T>> {
    throw this.notReady();
  }

  private notReady() {
    return new LLMNotConfiguredError(
      `ConverProvider is a stub${this.baseUrl ? ` (CONVER_BASE_URL is ${this.baseUrl})` : ""}. ` +
        "Implement it once Conver's API details are known, or set LLM_PROVIDER=anthropic.",
    );
  }
}
