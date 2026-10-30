import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type {
  BetaContentBlock,
  BetaContentBlockParam,
  BetaMessage,
  BetaMessageParam,
  BetaToolUnion,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { z } from "zod";
import { LLMCapabilityError, LLMOutputError, LLMRefusalError } from "./errors";
import { taskSettings } from "./tasks";
import {
  addUsage,
  emptyUsage,
  type GenerateRequest,
  type GenerateResult,
  type LLMCapabilities,
  type LLMProvider,
  type LLMUsage,
  type StructuredRequest,
  type StructuredResult,
  type WebCitation,
} from "./types";

type Env = Record<string, string | undefined>;
type StreamParams = Parameters<Anthropic["beta"]["messages"]["stream"]>[0];

/** The slice of the SDK this provider uses. Tests pass a fake; production uses client.beta.messages. */
export interface MessagesStreamer {
  stream(params: StreamParams): { finalMessage(): Promise<BetaMessage> };
}

export interface AnthropicProviderOptions {
  env?: Env;
  client?: MessagesStreamer;
}

/** Server tools (web search) run a loop on Anthropic's side and may pause; we resume this many times. */
const MAX_CONTINUATIONS = 5;
const FALLBACK_BETA = "server-side-fallback-2026-07-01";

/**
 * Claude via the Anthropic API. The default provider during development.
 *
 * - Model, effort and output budget come from the task (src/lib/llm/tasks.ts).
 * - Thinking is left to the model's default (adaptive on Opus 5.5, which can't turn it off).
 * - Refusal fallback is on: if the model declines for policy reasons, the API re-runs the request
 *   on Anthropic's recommended substitute model. Set LLM_REFUSAL_FALLBACK=off to disable.
 * - Structured output uses the API's JSON-schema output format, then validates again with Zod.
 */
export class AnthropicProvider implements LLMProvider {
  readonly name = "anthropic";
  readonly capabilities: LLMCapabilities = { webSearch: true, structuredOutput: true };
  private readonly env: Env;
  private client: MessagesStreamer | undefined;

  constructor(opts: AnthropicProviderOptions = {}) {
    this.env = opts.env ?? process.env;
    this.client = opts.client;
  }

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    const tools = req.webSearch ? [this.webSearchTool(req.webSearch)] : undefined;
    const run = await this.run(req, { tools });
    return {
      text: textOf(run.blocks),
      citations: citationsOf(run.blocks),
      usage: run.usage,
      provenance: run.provenance,
    };
  }

  async generateStructured<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>> {
    const format = betaZodOutputFormat(req.schema as z.ZodType);
    const run = await this.run(req, { format: { type: "json_schema", schema: format.schema } });
    const text = textOf(run.blocks);
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new LLMOutputError("The model returned output that isn't valid JSON", text);
    }
    const parsed = req.schema.safeParse(json);
    if (!parsed.success) {
      throw new LLMOutputError(`The model's output didn't match the schema:\n${z.prettifyError(parsed.error)}`, text);
    }
    return { data: parsed.data, usage: run.usage, provenance: run.provenance };
  }

  private async run(
    req: GenerateRequest,
    extra: { tools?: BetaToolUnion[]; format?: { type: "json_schema"; schema: Record<string, unknown> } },
  ) {
    const settings = taskSettings(req.task, this.env);
    const fallbackOn = (this.env.LLM_REFUSAL_FALLBACK ?? "on") !== "off";
    const base: BetaMessageParam[] = req.messages.map((m) => ({ role: m.role, content: m.content }));
    const params: StreamParams = {
      model: settings.model,
      max_tokens: req.maxTokens ?? settings.maxTokens,
      messages: base,
      output_config: { effort: settings.effort, ...(extra.format ? { format: extra.format } : {}) },
      ...(req.system ? { system: [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }] } : {}),
      ...(extra.tools ? { tools: extra.tools } : {}),
      ...(fallbackOn ? { fallbacks: "default", betas: [FALLBACK_BETA] } : {}),
    };

    const blocks: BetaContentBlock[] = [];
    let usage = emptyUsage();
    let servedBy = settings.model;
    let servedByFallback = false;
    for (let turn = 0; ; turn++) {
      const messages: BetaMessageParam[] = blocks.length
        ? // A paused turn resumes from its own content, sent back unchanged (the API accepts response blocks).
          [...base, { role: "assistant", content: blocks as unknown as BetaContentBlockParam[] }]
        : base;
      const msg = await this.messages().stream({ ...params, messages }).finalMessage();
      usage = addUsage(usage, usageOf(msg));
      servedBy = msg.model;
      servedByFallback ||= (msg.usage.iterations ?? []).some((i) => i.type === "fallback_message");

      if (msg.stop_reason === "refusal") {
        throw new LLMRefusalError(msg.stop_details?.category ?? null, msg.stop_details?.explanation ?? null);
      }
      blocks.push(...msg.content);
      if (msg.stop_reason === "max_tokens") {
        throw new LLMOutputError(`The response hit the ${params.max_tokens}-token limit and was cut off`, textOf(blocks));
      }
      if (msg.stop_reason !== "pause_turn") break;
      if (turn >= MAX_CONTINUATIONS) {
        throw new LLMOutputError(`Web search didn't finish after ${MAX_CONTINUATIONS} continuations`, textOf(blocks));
      }
    }

    return {
      blocks,
      usage,
      provenance: {
        provider: this.name,
        model: servedBy,
        requestedModel: settings.model,
        servedByFallback,
        ...(req.prompt ? { prompt: req.prompt } : {}),
      },
    };
  }

  private webSearchTool(opts: NonNullable<GenerateRequest["webSearch"]>): BetaToolUnion {
    if (opts.allowedDomains?.length && opts.blockedDomains?.length) {
      throw new LLMCapabilityError("Web search takes allowedDomains or blockedDomains, not both");
    }
    return {
      type: "web_search_20260209",
      name: "web_search",
      ...(opts.maxUses ? { max_uses: opts.maxUses } : {}),
      ...(opts.allowedDomains?.length ? { allowed_domains: opts.allowedDomains } : {}),
      ...(opts.blockedDomains?.length ? { blocked_domains: opts.blockedDomains } : {}),
      // Bias results towards Australian sources; NZ accounts still surface through the query itself.
      user_location: { type: "approximate", country: "AU", timezone: this.env.APP_TIMEZONE ?? "Australia/Melbourne" },
    };
  }

  private messages(): MessagesStreamer {
    // Created on first use so importing this module never needs credentials.
    this.client ??= new Anthropic(this.env.ANTHROPIC_API_KEY ? { apiKey: this.env.ANTHROPIC_API_KEY } : {}).beta.messages;
    return this.client;
  }
}

function textOf(blocks: BetaContentBlock[]): string {
  return blocks
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");
}

function citationsOf(blocks: BetaContentBlock[]): WebCitation[] {
  const seen = new Set<string>();
  const out: WebCitation[] = [];
  for (const b of blocks) {
    if (b.type !== "text") continue;
    for (const c of b.citations ?? []) {
      if (c.type !== "web_search_result_location") continue;
      const key = `${c.url}\u0000${c.cited_text}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ url: c.url, title: c.title, citedText: c.cited_text });
    }
  }
  return out;
}

function usageOf(msg: BetaMessage): LLMUsage {
  return {
    inputTokens: msg.usage.input_tokens,
    outputTokens: msg.usage.output_tokens,
    cacheReadTokens: msg.usage.cache_read_input_tokens ?? 0,
    cacheWriteTokens: msg.usage.cache_creation_input_tokens ?? 0,
    webSearches: msg.usage.server_tool_use?.web_search_requests ?? 0,
  };
}
