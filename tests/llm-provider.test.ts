import type { BetaMessage } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { AnthropicProvider, type MessagesStreamer } from "@/lib/llm/anthropic";
import { ConverProvider } from "@/lib/llm/conver";
import { LLMCapabilityError, LLMNotConfiguredError, LLMOutputError, LLMRefusalError } from "@/lib/llm/errors";
import { MockEmbeddingProvider, MockProvider } from "@/lib/llm/mock";
import { createEmbeddingProvider, createLLMProvider } from "@/lib/llm/registry";
import { taskSettings } from "@/lib/llm/tasks";

type Params = Parameters<MessagesStreamer["stream"]>[0];

/** A stand-in for client.beta.messages that returns scripted responses and records requests. */
function fakeClient(responses: Array<Partial<BetaMessage>>) {
  const requests: Params[] = [];
  const client: MessagesStreamer = {
    stream(params) {
      requests.push(structuredClone(params));
      const next = responses.shift();
      if (!next) throw new Error("no scripted response left");
      return {
        finalMessage: async () =>
          ({
            id: "msg_test",
            type: "message",
            role: "assistant",
            model: params.model,
            stop_reason: "end_turn",
            stop_details: null,
            content: [],
            usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, server_tool_use: null, iterations: null },
            ...next,
          }) as unknown as BetaMessage,
      };
    },
  };
  return { client, requests };
}

const text = (t: string, citations: unknown[] | null = null) => ({ type: "text", text: t, citations }) as never;

describe("AnthropicProvider", () => {
  it("uses the task's model and effort, caches the system prompt, and opts into refusal fallback", async () => {
    const { client, requests } = fakeClient([{ content: [text("hello")] }]);
    const p = new AnthropicProvider({ env: {}, client });
    const res = await p.generate({
      task: "classify",
      system: "rules",
      messages: [{ role: "user", content: "hi" }],
      prompt: { id: "x.y", version: 2 },
    });

    expect(res.text).toBe("hello");
    expect(res.provenance).toMatchObject({ provider: "anthropic", model: "claude-opus-5-5", servedByFallback: false, prompt: { id: "x.y", version: 2 } });
    const req = requests[0]!;
    expect(req.model).toBe("claude-opus-5-5");
    expect(req.output_config).toEqual({ effort: "low" });
    expect(req.max_tokens).toBe(4000);
    expect(req.system).toEqual([{ type: "text", text: "rules", cache_control: { type: "ephemeral" } }]);
    expect(req.fallbacks).toBe("default");
    expect(req.betas).toEqual(["server-side-fallback-2026-07-01"]);
    expect(req).not.toHaveProperty("thinking");
    expect(req).not.toHaveProperty("temperature");
  });

  it("lets env override the model per task and turn the fallback off", async () => {
    const { client, requests } = fakeClient([{ content: [text("ok")] }]);
    const env = { LLM_MODEL_CLASSIFY: "claude-haiku-5-5", LLM_EFFORT_CLASSIFY: "medium", LLM_REFUSAL_FALLBACK: "off" };
    await new AnthropicProvider({ env, client }).generate({ task: "classify", messages: [{ role: "user", content: "x" }] });
    expect(requests[0]!.model).toBe("claude-haiku-5-5");
    expect(requests[0]!.output_config).toEqual({ effort: "medium" });
    expect(requests[0]).not.toHaveProperty("fallbacks");
    expect(requests[0]).not.toHaveProperty("betas");
  });

  it("adds the web search tool and returns deduplicated web citations", async () => {
    const cite = { type: "web_search_result_location", url: "https://example.com/a", title: "A", cited_text: "fact", encrypted_index: "e" };
    const { client, requests } = fakeClient([{ content: [text("Fact one.", [cite]), text(" Again.", [cite])] }]);
    const res = await new AnthropicProvider({ env: {}, client }).generate({
      task: "research",
      messages: [{ role: "user", content: "q" }],
      webSearch: { maxUses: 3, allowedDomains: ["example.com"] },
    });
    expect(requests[0]!.tools).toEqual([
      {
        type: "web_search_20260209",
        name: "web_search",
        max_uses: 3,
        allowed_domains: ["example.com"],
        user_location: { type: "approximate", country: "AU", timezone: "Australia/Melbourne" },
      },
    ]);
    expect(res.text).toBe("Fact one. Again.");
    expect(res.citations).toEqual([{ url: "https://example.com/a", title: "A", citedText: "fact" }]);
  });

  it("rejects allowed and blocked domains together", async () => {
    const { client } = fakeClient([]);
    await expect(
      new AnthropicProvider({ env: {}, client }).generate({
        task: "research",
        messages: [{ role: "user", content: "q" }],
        webSearch: { allowedDomains: ["a.example"], blockedDomains: ["b.example"] },
      }),
    ).rejects.toBeInstanceOf(LLMCapabilityError);
  });

  it("resumes a paused server-tool turn by sending the paused content back, and sums usage", async () => {
    const { client, requests } = fakeClient([
      { stop_reason: "pause_turn", content: [text("Part one. ")] },
      { content: [text("Part two.")] },
    ]);
    const res = await new AnthropicProvider({ env: {}, client }).generate({
      task: "research",
      messages: [{ role: "user", content: "q" }],
      webSearch: {},
    });
    expect(res.text).toBe("Part one. Part two.");
    expect(requests[1]!.messages).toEqual([
      { role: "user", content: "q" },
      { role: "assistant", content: [{ type: "text", text: "Part one. ", citations: null }] },
    ]);
    expect(res.usage.inputTokens).toBe(20);
  });

  it("throws a typed error when the model declines", async () => {
    const { client } = fakeClient([{ stop_reason: "refusal", stop_details: { type: "refusal", category: "cyber", explanation: "no" } as never }]);
    const err = await new AnthropicProvider({ env: {}, client })
      .generate({ task: "smoke", messages: [{ role: "user", content: "x" }] })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LLMRefusalError);
    expect((err as LLMRefusalError).category).toBe("cyber");
  });

  it("reports when a fallback model served the response", async () => {
    const { client } = fakeClient([
      {
        model: "claude-opus-4-8",
        content: [text("ok")],
        usage: { input_tokens: 1, output_tokens: 1, iterations: [{ type: "fallback_message" }] } as never,
      },
    ]);
    const res = await new AnthropicProvider({ env: {}, client }).generate({ task: "smoke", messages: [{ role: "user", content: "x" }] });
    expect(res.provenance).toMatchObject({ model: "claude-opus-4-8", requestedModel: "claude-opus-5-5", servedByFallback: true });
  });

  it("treats a truncated response as an error rather than a partial answer", async () => {
    const { client } = fakeClient([{ stop_reason: "max_tokens", content: [text("half")] }]);
    await expect(
      new AnthropicProvider({ env: {}, client }).generate({ task: "smoke", messages: [{ role: "user", content: "x" }] }),
    ).rejects.toBeInstanceOf(LLMOutputError);
  });

  describe("structured output", () => {
    const schema = z.object({ name: z.string(), fictional: z.boolean() });

    it("sends a JSON schema output format and validates the result", async () => {
      const { client, requests } = fakeClient([{ content: [text('{"name":"Bellbird","fictional":true}')] }]);
      const res = await new AnthropicProvider({ env: {}, client }).generateStructured({
        task: "smoke",
        messages: [{ role: "user", content: "x" }],
        schema,
      });
      expect(res.data).toEqual({ name: "Bellbird", fictional: true });
      const format = requests[0]!.output_config?.format;
      expect(format?.type).toBe("json_schema");
      expect(format?.schema).toMatchObject({ type: "object", properties: { name: { type: "string" } } });
    });

    it("fails loudly on output that doesn't match the schema", async () => {
      const { client } = fakeClient([{ content: [text('{"name":42}')] }]);
      const err = await new AnthropicProvider({ env: {}, client })
        .generateStructured({ task: "smoke", messages: [{ role: "user", content: "x" }], schema })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(LLMOutputError);
      expect((err as LLMOutputError).rawText).toBe('{"name":42}');
    });

    it("fails loudly on output that isn't JSON", async () => {
      const { client } = fakeClient([{ content: [text("Sure! Here you go")] }]);
      await expect(
        new AnthropicProvider({ env: {}, client }).generateStructured({ task: "smoke", messages: [{ role: "user", content: "x" }], schema }),
      ).rejects.toThrow(/isn't valid JSON/);
    });
  });
});

describe("provider registry", () => {
  it("defaults to Anthropic and can switch by configuration alone", () => {
    expect(createLLMProvider({}).name).toBe("anthropic");
    expect(createLLMProvider({ LLM_PROVIDER: "conver" }).name).toBe("conver");
    expect(createLLMProvider({ LLM_PROVIDER: "mock" }).name).toBe("mock");
  });

  it("refuses the mock provider in production and unknown names everywhere", () => {
    expect(() => createLLMProvider({ LLM_PROVIDER: "mock", NODE_ENV: "production" })).toThrow(LLMNotConfiguredError);
    expect(() => createLLMProvider({ LLM_PROVIDER: "openai" })).toThrow(/Unknown LLM_PROVIDER/);
  });

  it("picks the embedding provider, and says what's missing", () => {
    expect(createEmbeddingProvider({}).name).toBe("mock");
    expect(createEmbeddingProvider({ EMBEDDING_PROVIDER: "local" }).name).toBe("local");
    expect(() => createEmbeddingProvider({ EMBEDDING_PROVIDER: "voyage" })).toThrow(/VOYAGE_API_KEY/);
    expect(createEmbeddingProvider({ EMBEDDING_PROVIDER: "voyage", VOYAGE_API_KEY: "k" }).model).toBe("voyage-3.5");
  });
});

describe("ConverProvider stub", () => {
  it("declares no web search, so research degrades to source adapters", () => {
    expect(new ConverProvider({}).capabilities.webSearch).toBe(false);
  });

  it("fails with a clear message until implemented", async () => {
    await expect(new ConverProvider({}).generate({ task: "smoke", messages: [] })).rejects.toThrow(/stub/);
  });
});

describe("MockProvider", () => {
  it("records calls and validates structured responses", async () => {
    const p = new MockProvider(() => ({ ok: true }));
    const res = await p.generateStructured({ task: "smoke", messages: [{ role: "user", content: "x" }], schema: z.object({ ok: z.boolean() }) });
    expect(res.data.ok).toBe(true);
    expect(p.calls).toHaveLength(1);
  });

  it("refuses web search it doesn't have", async () => {
    await expect(new MockProvider().generate({ task: "research", messages: [], webSearch: {} })).rejects.toBeInstanceOf(LLMCapabilityError);
  });
});

describe("MockEmbeddingProvider", () => {
  it("returns stable unit vectors of the declared size", async () => {
    const e = new MockEmbeddingProvider(16);
    const [a, b] = await e.embed(["same", "same"], "document");
    expect(a).toHaveLength(16);
    expect(a).toEqual(b);
    expect(Math.hypot(...a!)).toBeCloseTo(1, 6);
  });
});

describe("taskSettings", () => {
  it("rejects an invalid effort value instead of passing it through", () => {
    expect(() => taskSettings("advisor", { LLM_EFFORT_ADVISOR: "turbo" })).toThrow(/LLM_EFFORT_ADVISOR/);
  });
});
