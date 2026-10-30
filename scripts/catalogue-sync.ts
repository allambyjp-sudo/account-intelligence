import { notInArray, sql } from "drizzle-orm";
import { loadCatalogue } from "@/lib/catalogue/catalogue";
import { connect } from "@/lib/db/client";
import { servicesCatalogueItems } from "@/lib/db/schema";
import { loadEnv } from "./env";

/** Copies data/services-catalogue.json into the database. Entries removed from the file are deactivated, not deleted. */
async function main() {
  loadEnv();
  const items = loadCatalogue();
  const { db, pool } = connect();
  try {
    await db.transaction(async (tx) => {
      for (const i of items) {
        const row = {
          slug: i.slug,
          kind: i.kind,
          name: i.name,
          summary: i.summary,
          painPoints: i.painPoints,
          vendors: i.vendors,
          keywords: i.keywords,
          url: i.url,
          isPlaceholder: i.placeholder,
          active: true,
        };
        await tx.insert(servicesCatalogueItems).values(row).onConflictDoUpdate({ target: servicesCatalogueItems.slug, set: row });
      }
      await tx
        .update(servicesCatalogueItems)
        .set({ active: false, updatedAt: sql`now()` })
        .where(notInArray(servicesCatalogueItems.slug, items.map((i) => i.slug)));
    });
    const placeholders = items.filter((i) => i.placeholder).length;
    console.log(`synced ${items.length} catalogue items${placeholders ? ` (${placeholders} still placeholders)` : ""}`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
