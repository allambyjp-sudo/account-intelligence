import { sql } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { users, type User } from "@/lib/db/schema";
import type { EntraIdentity } from "@/lib/auth/entra";

/** The identity the dev sign-in uses. Seed data attaches to this user by default. */
export const DEV_IDENTITY: EntraIdentity = {
  tenantId: "dev-bypass",
  objectId: "dev-seller",
  email: "dev.seller@example.com",
  displayName: "Dev Seller",
};

export async function upsertUser(db: Db, identity: EntraIdentity): Promise<User> {
  const [user] = await db
    .insert(users)
    .values({
      entraTenantId: identity.tenantId,
      entraObjectId: identity.objectId,
      email: identity.email,
      displayName: identity.displayName,
      lastSignInAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [users.entraTenantId, users.entraObjectId],
      set: { email: identity.email, displayName: identity.displayName, lastSignInAt: sql`now()` },
    })
    .returning();
  return user!;
}
