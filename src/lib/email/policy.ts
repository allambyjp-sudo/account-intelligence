type Env = Record<string, string | undefined>;

/**
 * The brief's rule (section 4.8): no real mailbox is connected until the model layer runs through
 * Conver and IT has approved it. Both switches are deliberate and visible in the environment:
 *   MAILBOX_CONNECT_APPROVED=true   IT has approved connecting real mailboxes
 *   LLM_PROVIDER=conver             email content goes to Datacom's own AI platform
 * ALLOW_MAILBOX_WITHOUT_CONVER=true lifts the second check for a personal test mailbox only.
 * The synthetic mailbox is always allowed.
 */
export function realMailboxPolicy(env: Env = process.env): { allowed: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (env.MAILBOX_CONNECT_APPROVED !== "true") reasons.push("Real mailboxes stay disconnected until IT has approved it (MAILBOX_CONNECT_APPROVED=true).");
  if ((env.LLM_PROVIDER ?? "anthropic") !== "conver" && env.ALLOW_MAILBOX_WITHOUT_CONVER !== "true") {
    reasons.push("Email content is only processed through Conver (LLM_PROVIDER=conver). For a personal test mailbox, set ALLOW_MAILBOX_WITHOUT_CONVER=true.");
  }
  return { allowed: reasons.length === 0, reasons };
}

/** The seller's own organisation's email domains. Mail only among these is skipped. */
export const ownDomains = (env: Env = process.env) =>
  (env.ORG_EMAIL_DOMAINS ?? "")
    .split(",")
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);
