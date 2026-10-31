import { sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb } from "@/lib/db/client";
import { workerHeartbeats } from "@/lib/db/schema";

export const dynamic = "force-dynamic";

/** Liveness for the hosting platform: database reachable, and when the worker last checked in. */
export async function GET() {
  try {
    const db = getDb();
    const [row] = await db.select({ at: sql<Date | null>`max(${workerHeartbeats.lastBeatAt})` }).from(workerHeartbeats);
    const last = row?.at ? new Date(row.at) : null;
    const workerAgeSeconds = last ? Math.round((Date.now() - last.getTime()) / 1000) : null;
    return NextResponse.json({ ok: true, database: "up", workerAgeSeconds, workerHealthy: workerAgeSeconds !== null && workerAgeSeconds < 300 });
  } catch {
    return NextResponse.json({ ok: false, database: "down" }, { status: 503 });
  }
}
