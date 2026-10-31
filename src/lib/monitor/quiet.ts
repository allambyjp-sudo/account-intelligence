import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import * as t from "@/lib/db/schema";
import { scoreUrgency } from "@/lib/accounts/urgency";

/** Raises one open quiet-customer alert per key account that has gone quiet (brief, section 4.8). */
export async function raiseQuietAlerts(db: Db, now = new Date()): Promise<number> {
  const keyAccounts = await db.select().from(t.accounts).where(eq(t.accounts.isKeyAccount, true));
  let raised = 0;
  for (const a of keyAccounts) {
    if (a.status === "dormant") continue;
    const u = scoreUrgency({ openAlerts: { high: 0, medium: 0, low: 0 }, isKeyAccount: true, lastContactAt: a.lastContactAt, quietAfterDays: a.quietAfterDays, now });
    if (!u.isQuiet) continue;
    const [open] = await db
      .select({ id: t.alerts.id })
      .from(t.alerts)
      .where(and(eq(t.alerts.accountId, a.id), eq(t.alerts.kind, "quiet_customer"), isNull(t.alerts.dismissedAt)))
      .limit(1);
    if (open) continue;
    await db.insert(t.alerts).values({
      userId: a.ownerUserId,
      accountId: a.id,
      kind: "quiet_customer",
      importance: "medium",
      title: u.daysSinceContact === null ? `No contact on record with ${a.name}` : `${a.name} has been quiet for ${u.daysSinceContact} days`,
      body: `Key account with no logged contact for ${a.quietAfterDays}+ days.`,
    });
    raised++;
  }
  return raised;
}
