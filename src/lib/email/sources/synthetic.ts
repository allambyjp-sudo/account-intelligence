import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { MailMessage, MailSource, SyncState } from "../types";

/**
 * A fictional mailbox for development and demos (brief: synthetic or anonymised email only until
 * Conver). Messages come from data/synthetic-mailbox.json; dates are relative to "now" so the
 * inbox always looks current. Each sync returns the messages not yet delivered.
 */
const fileSchema = z.object({
  $comment: z.string().optional(),
  messages: z.array(
    z.object({
      id: z.string(),
      thread: z.string(),
      daysAgo: z.number(),
      direction: z.enum(["inbound", "outbound"]),
      from: z.string(),
      to: z.array(z.string()),
      cc: z.array(z.string()).default([]),
      subject: z.string(),
      body: z.string(),
    }),
  ),
});

export const SYNTHETIC_FILE = path.join(process.cwd(), "data/synthetic-mailbox.json");

export function loadSyntheticMessages(file = SYNTHETIC_FILE, now = new Date()): MailMessage[] {
  const raw = fileSchema.parse(JSON.parse(readFileSync(file, "utf8")));
  return raw.messages.map((m) => ({
    providerMessageId: m.id,
    threadId: m.thread,
    subject: m.subject,
    from: { address: m.from },
    to: m.to.map((address) => ({ address })),
    cc: m.cc.map((address) => ({ address })),
    receivedAt: new Date(now.getTime() - m.daysAgo * 86_400_000),
    direction: m.direction,
    preview: m.body.slice(0, 240),
    bodyText: m.body,
  }));
}

export class SyntheticMailSource implements MailSource {
  readonly provider = "synthetic" as const;
  constructor(
    private readonly file = SYNTHETIC_FILE,
    private readonly now = () => new Date(),
  ) {}

  async fetchChanges(state: SyncState) {
    const delivered = new Set(Array.isArray(state.delivered) ? (state.delivered as string[]) : []);
    const messages = loadSyntheticMessages(this.file, this.now()).filter((m) => !delivered.has(m.providerMessageId));
    return { messages, state: { delivered: [...delivered, ...messages.map((m) => m.providerMessageId)] } };
  }
}
