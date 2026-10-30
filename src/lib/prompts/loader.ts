import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { LLM_TASKS, type LLMTask, type PromptRef } from "@/lib/llm/types";

/**
 * Every LLM prompt lives in /prompts as a Markdown file with YAML front matter, so prompts can be
 * versioned, reviewed and tuned without touching code. See prompts/README.md for the format.
 */
export const PROMPTS_DIR = path.join(process.cwd(), "prompts");

const frontMatterSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9_]+(\.[a-z0-9_]+)+$/, "ids look like 'folder.name'"),
    version: z.number().int().positive(),
    task: z.enum(LLM_TASKS),
    description: z.string().min(1),
    variables: z.array(z.string().regex(/^[a-z][a-z0-9_]*$/)).default([]),
  })
  .strict();

export interface Prompt extends PromptRef {
  task: LLMTask;
  description: string;
  variables: string[];
  template: string;
  file: string;
}

const PLACEHOLDER = /\{\{\s*([a-z][a-z0-9_]*)\s*\}\}/g;

export function parsePrompt(source: string, file: string): Prompt {
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(source.replace(/\r\n/g, "\n"));
  if (!m) throw new Error(`${file}: missing YAML front matter between --- lines`);
  const fm = frontMatterSchema.safeParse(parseYaml(m[1]!));
  if (!fm.success) throw new Error(`${file}: invalid front matter\n${z.prettifyError(fm.error)}`);
  const template = m[2]!.trim();

  const used = new Set([...template.matchAll(PLACEHOLDER)].map((p) => p[1]!));
  const declared = new Set(fm.data.variables);
  const undeclared = [...used].filter((v) => !declared.has(v));
  const unused = [...declared].filter((v) => !used.has(v));
  if (undeclared.length) throw new Error(`${file}: uses undeclared variables: ${undeclared.join(", ")}`);
  if (unused.length) throw new Error(`${file}: declares variables it never uses: ${unused.join(", ")}`);

  return { ...fm.data, template, file };
}

/** Fills {{placeholders}}. Missing or unexpected variables are errors, never silent blanks. */
export function renderPrompt(prompt: Prompt, vars: Record<string, string> = {}): string {
  const missing = prompt.variables.filter((v) => !(v in vars));
  const extra = Object.keys(vars).filter((v) => !prompt.variables.includes(v));
  if (missing.length) throw new Error(`${prompt.id}: missing variables: ${missing.join(", ")}`);
  if (extra.length) throw new Error(`${prompt.id}: unexpected variables: ${extra.join(", ")}`);
  return prompt.template.replace(PLACEHOLDER, (_, name: string) => vars[name]!);
}

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return walk(full);
    return e.name.endsWith(".md") && e.name !== "README.md" ? [full] : [];
  });
}

/** The id must match the file's path: prompts/research/profile.md is "research.profile". */
export function expectedId(file: string, root = PROMPTS_DIR): string {
  return path.relative(root, file).replace(/\.md$/, "").split(path.sep).join(".");
}

export function loadAllPrompts(root = PROMPTS_DIR): Map<string, Prompt> {
  const out = new Map<string, Prompt>();
  for (const file of walk(root)) {
    const rel = path.relative(process.cwd(), file);
    const prompt = parsePrompt(readFileSync(file, "utf8"), rel);
    const want = expectedId(file, root);
    if (prompt.id !== want) throw new Error(`${rel}: id is "${prompt.id}" but its path says "${want}"`);
    out.set(prompt.id, prompt);
  }
  return out;
}

let cache: Map<string, Prompt> | undefined;

export function getPrompt(id: string): Prompt {
  cache ??= loadAllPrompts();
  const p = cache.get(id);
  if (!p) throw new Error(`No prompt with id "${id}" in /prompts`);
  return p;
}
