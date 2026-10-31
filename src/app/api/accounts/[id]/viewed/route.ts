import { and, eq } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/auth/current-user";
import { isSameOrigin } from "@/lib/auth/http";
import { getDb } from "@/lib/db/client";
import * as t from "@/lib/db/schema";

/**
 * Marks an account as looked at. Called by the page after it renders, never on prefetch, so
 * "what's changed since you last looked" means what the seller actually saw.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!isSameOrigin(req)) return new NextResponse("Forbidden", { status: 403 });
  const user = await getCurrentUser();
  if (!user) return new NextResponse("Unauthorised", { status: 401 });
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return new NextResponse("Not found", { status: 404 });
  await getDb()
    .update(t.accounts)
    .set({ lastViewedAt: new Date() })
    .where(and(eq(t.accounts.id, id), eq(t.accounts.ownerUserId, user.id)));
  return new NextResponse(null, { status: 204 });
}
