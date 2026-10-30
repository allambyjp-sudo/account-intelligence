import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { CATALOGUE_KIND } from "@/lib/domain/enums";

export const CATALOGUE_FILE = path.join(process.cwd(), "data/services-catalogue.json");

const itemSchema = z
  .object({
    slug: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/),
    kind: z.enum(CATALOGUE_KIND),
    name: z.string().min(1),
    summary: z.string().min(1),
    painPoints: z.array(z.string().min(1)).default([]),
    vendors: z.array(z.string().min(1)).default([]),
    keywords: z.array(z.string().min(1)).default([]),
    url: z.url({ protocol: /^https?$/ }).nullable().default(null),
    placeholder: z.boolean().default(false),
  })
  .strict();

const fileSchema = z.object({ $comment: z.string().optional(), items: z.array(itemSchema) }).strict();

export type CatalogueItem = z.infer<typeof itemSchema>;

export function parseCatalogue(json: unknown): CatalogueItem[] {
  const parsed = fileSchema.safeParse(json);
  if (!parsed.success) throw new Error(`services catalogue is invalid:\n${z.prettifyError(parsed.error)}`);
  const seen = new Set<string>();
  for (const item of parsed.data.items) {
    if (seen.has(item.slug)) throw new Error(`services catalogue: duplicate slug "${item.slug}"`);
    seen.add(item.slug);
  }
  return parsed.data.items;
}

export function loadCatalogue(file = CATALOGUE_FILE): CatalogueItem[] {
  return parseCatalogue(JSON.parse(readFileSync(file, "utf8")));
}
