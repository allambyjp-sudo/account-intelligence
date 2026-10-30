import { z } from "zod";
import { createLLMProvider } from "@/lib/llm/registry";
import { getPrompt, renderPrompt } from "@/lib/prompts/loader";
import { loadEnv } from "./env";

/** Two tiny real calls through the configured provider: plain text, then structured JSON. Costs well under a cent. */
async function main() {
  loadEnv();
  const llm = createLLMProvider();
  const system = getPrompt("system.base").template;

  const hello = getPrompt("smoke.hello");
  const text = await llm.generate({
    task: "smoke",
    system,
    prompt: { id: hello.id, version: hello.version },
    messages: [{ role: "user", content: renderPrompt(hello, { org_name: "Bellbird Logistics Group" }) }],
  });
  console.log(`[${llm.name}] text via ${text.provenance.model}: ${text.text.trim()}`);

  const structured = getPrompt("smoke.structured");
  const json = await llm.generateStructured({
    task: "smoke",
    system,
    prompt: { id: structured.id, version: structured.version },
    schema: z.object({ name: z.string(), country: z.enum(["AU", "NZ", "unknown"]), fictional: z.boolean() }),
    messages: [{ role: "user", content: renderPrompt(structured, { company_name: "Kōwhai Health Partners" }) }],
  });
  console.log(`[${llm.name}] structured via ${json.provenance.model}:`, json.data);
  const u = text.usage;
  console.log(`usage (text call): ${u.inputTokens} in, ${u.outputTokens} out, ${u.cacheReadTokens} cache read`);
}

main().catch((err) => {
  console.error(err instanceof Error ? `${err.name}: ${err.message}` : err);
  process.exit(1);
});
