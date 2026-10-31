import { describe, expect, it } from "vitest";
import { VoyageEmbeddingProvider } from "@/lib/llm/embeddings";
import { summariseChanges } from "@/lib/memory/changes";
import { chunkText } from "@/lib/memory/memory";

describe("chunkText", () => {
  it("keeps short text whole and splits long text on paragraph and sentence boundaries", () => {
    expect(chunkText("  short note ")).toEqual(["short note"]);
    expect(chunkText("")).toEqual([]);
    const para = "First sentence here. Second sentence here. Third one.";
    const chunks = chunkText(`${para}\n\n${para}\n\n${para}`, 60);
    expect(chunks.every((c) => c.length <= 60)).toBe(true);
    expect(chunks.join(" ")).toContain("Third one.");
  });

  it("hard-wraps a single unbroken run", () => {
    const chunks = chunkText("x".repeat(250), 100);
    expect(chunks.map((c) => c.length)).toEqual([100, 100, 50]);
  });
});

describe("what's changed", () => {
  const since = new Date("2026-10-20T00:00:00Z");
  const at = (d: number) => new Date(`2026-10-${d}T00:00:00Z`);

  it("puts high importance first, then newest, and folds brief sections into one line", () => {
    const res = summariseChanges(since, {
      signals: [
        { kind: "signal", at: at(28), title: "Low news", importance: "low" },
        { kind: "signal", at: at(22), title: "New CISO", importance: "high" },
      ],
      notes: [{ kind: "note", at: at(29), title: "meeting logged" }],
      briefs: [
        { kind: "brief", at: at(25), title: "Brief updated: profile" },
        { kind: "brief", at: at(25), title: "Brief updated: challenges" },
      ],
    });
    expect(res.items.map((i) => i.title)).toEqual(["New CISO", "meeting logged", "Low news", "Brief updated (2 sections)"]);
    expect(res.counts).toEqual({ signal: 2, note: 1, brief: 2 });
  });
});

describe("VoyageEmbeddingProvider", () => {
  it("sends documents and queries with the right input type, in order", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fakeFetch = (async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init!.body)) as { input: string[] };
      bodies.push(body as Record<string, unknown>);
      return new Response(JSON.stringify({ model: "voyage-3.5", data: body.input.map((_, i) => ({ index: body.input.length - 1 - i, embedding: [body.input.length - 1 - i] })) }));
    }) as unknown as typeof fetch;
    const v = new VoyageEmbeddingProvider({ VOYAGE_API_KEY: "k" }, fakeFetch);
    expect(await v.embed(["a", "b"], "query")).toEqual([[0], [1]]);
    expect(bodies[0]).toMatchObject({ model: "voyage-3.5", input_type: "query" });
  });
});
