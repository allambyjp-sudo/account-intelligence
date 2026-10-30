import { describe, expect, it } from "vitest";
import { loadAllPrompts, parsePrompt, renderPrompt } from "@/lib/prompts/loader";

const sample = (fm: string, body: string) => `---\n${fm}\n---\n${body}\n`;

describe("prompt library (/prompts)", () => {
  const prompts = loadAllPrompts();

  it("loads every prompt file, with ids that match their paths", () => {
    expect(prompts.size).toBeGreaterThanOrEqual(3);
    expect(prompts.has("system.base")).toBe(true);
    expect(prompts.has("smoke.hello")).toBe(true);
  });

  it("keeps the shared system prompt free of variables, so it stays cacheable", () => {
    expect(prompts.get("system.base")!.variables).toEqual([]);
  });

  it("carries the brief's citation and contact rules in the base system prompt", () => {
    const base = prompts.get("system.base")!.template;
    expect(base).toMatch(/Unconfirmed/);
    expect(base).toMatch(/work email/);
    expect(base).toMatch(/Never guess a phone number/);
  });
});

describe("parsePrompt", () => {
  it("rejects undeclared and unused variables", () => {
    expect(() => parsePrompt(sample("id: a.b\nversion: 1\ntask: smoke\ndescription: d", "Hi {{name}}"), "f")).toThrow(/undeclared/);
    expect(() =>
      parsePrompt(sample("id: a.b\nversion: 1\ntask: smoke\ndescription: d\nvariables: [name]", "Hi"), "f"),
    ).toThrow(/never uses/);
  });

  it("rejects unknown front-matter keys and tasks", () => {
    expect(() => parsePrompt(sample("id: a.b\nversion: 1\ntask: smoke\ndescription: d\nmodel: x", "Hi"), "f")).toThrow(/front matter/);
    expect(() => parsePrompt(sample("id: a.b\nversion: 1\ntask: dance\ndescription: d", "Hi"), "f")).toThrow(/front matter/);
  });
});

describe("renderPrompt", () => {
  const p = parsePrompt(sample("id: a.b\nversion: 1\ntask: smoke\ndescription: d\nvariables: [name]", "Hi {{ name }}."), "f");

  it("fills placeholders", () => {
    expect(renderPrompt(p, { name: "JP" })).toBe("Hi JP.");
  });

  it("never renders a silent blank", () => {
    expect(() => renderPrompt(p, {})).toThrow(/missing variables: name/);
    expect(() => renderPrompt(p, { name: "x", other: "y" })).toThrow(/unexpected variables: other/);
  });
});
