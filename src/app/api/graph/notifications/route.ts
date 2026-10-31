import { eq } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getDb } from "@/lib/db/client";
import { mailConnections } from "@/lib/db/schema";
import { mailSyncJob } from "@/lib/jobs/email";
import { getJobSender } from "@/lib/jobs/sender";

const notification = z.object({ value: z.array(z.object({ subscriptionId: z.string(), clientState: z.string().optional() })) });

/**
 * Microsoft Graph change notifications. Graph first validates the endpoint by sending a
 * validationToken that must be echoed as plain text. Notifications carry no mail content here:
 * each one only triggers a delta sync, and only if its clientState matches the connection's secret.
 */
export async function POST(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("validationToken");
  if (token) return new NextResponse(token, { status: 200, headers: { "content-type": "text/plain" } });

  const parsed = notification.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return new NextResponse(null, { status: 202 });
  const db = getDb();
  const queue = await getJobSender();
  for (const n of parsed.data.value) {
    const [conn] = await db.select().from(mailConnections).where(eq(mailConnections.subscriptionId, n.subscriptionId)).limit(1);
    if (!conn || !n.clientState || n.clientState !== conn.clientState) continue;
    await queue.send(mailSyncJob, { connectionId: conn.id }, { singletonKey: conn.id });
  }
  // Graph expects a quick 2xx; the sync runs in the worker.
  return new NextResponse(null, { status: 202 });
}
