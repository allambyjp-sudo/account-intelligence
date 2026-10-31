import { eq } from "drizzle-orm";
import { z } from "zod";
import { meetings } from "@/lib/db/schema";
import { getEmbeddingProvider, getLLMProvider } from "@/lib/llm/registry";
import { generateMeetingPrep } from "@/lib/meetings/prep";
import { memorySyncJob } from "./advisor";
import { defineJob } from "./types";

export const meetingPrepJob = defineJob({
  name: "meeting-prep",
  schema: z.object({ meetingId: z.uuid() }),
  retryLimit: 0,
  async handle({ meetingId }, ctx) {
    try {
      const prep = await generateMeetingPrep(ctx.db, getLLMProvider(), getEmbeddingProvider(), meetingId);
      ctx.log(`meeting prep ${meetingId}: ${prep.openingAngles.length} openers, ${prep.evidence.length} evidence items`);
      const [m] = await ctx.db.select({ accountId: meetings.accountId }).from(meetings).where(eq(meetings.id, meetingId)).limit(1);
      if (m) await ctx.queue.send(memorySyncJob, { accountId: m.accountId }, { singletonKey: m.accountId, startAfterSeconds: 5 });
    } catch (err) {
      await ctx.db.update(meetings).set({ prepError: err instanceof Error ? err.message : String(err) }).where(eq(meetings.id, meetingId));
    }
  },
});
