import { eq } from "drizzle-orm";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getDb } from "@/lib/db/client";
import { users, type User } from "@/lib/db/schema";
import { readAuthConfig } from "./config";
import { readSessionToken, SESSION_COOKIE } from "./session";

/** The signed-in user for this request, or null. For server components and route handlers. */
export async function getCurrentUser(): Promise<User | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const session = readSessionToken(readAuthConfig(), token);
  if (!session) return null;
  const [user] = await getDb().select().from(users).where(eq(users.id, session.uid)).limit(1);
  return user ?? null;
}

/** Use at the top of every page that shows account data. Checked per request, not in middleware. */
export async function requireUser(returnTo = "/"): Promise<User> {
  const user = await getCurrentUser();
  if (!user) redirect(`/signin?returnTo=${encodeURIComponent(returnTo)}`);
  return user;
}
