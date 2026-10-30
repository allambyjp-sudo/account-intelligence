import { eq } from "drizzle-orm";
import { connect } from "@/lib/db/client";
import { users } from "@/lib/db/schema";
import { seedFictionalAccounts } from "@/lib/demo/seed";
import { DEV_IDENTITY, upsertUser } from "@/lib/users";
import { loadEnv } from "./env";

/**
 * Loads the fictional demo accounts.
 *   npm run db:seed                         for the development sign-in user
 *   npm run db:seed -- --owner you@org.com  for a user who has already signed in with Entra
 */
async function main() {
  loadEnv();
  const { db, pool } = connect();
  try {
    const i = process.argv.indexOf("--owner");
    const email = i > -1 ? process.argv[i + 1] : undefined;
    let ownerId: string;
    if (email) {
      const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
      if (!user) throw new Error(`No user with email ${email}. Sign in once first, then re-run.`);
      ownerId = user.id;
    } else {
      ownerId = (await upsertUser(db, DEV_IDENTITY)).id;
    }
    const ids = await seedFictionalAccounts(db, ownerId);
    console.log(`seeded ${ids.length} fictional accounts for ${email ?? DEV_IDENTITY.email}`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
