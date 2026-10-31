import type { EmailProvider } from "@/lib/domain/enums";

export interface Address {
  address: string;
  name?: string;
}

/** One message, normalised across Outlook (Graph), Gmail and the synthetic mailbox. */
export interface MailMessage {
  providerMessageId: string;
  /** Graph conversationId / Gmail threadId. */
  threadId: string;
  subject: string;
  from: Address;
  to: Address[];
  cc: Address[];
  receivedAt: Date;
  direction: "inbound" | "outbound";
  /** A short preview. Always present. */
  preview: string;
  /** Full plain text, when the provider gives it. Stored only if the seller opts in. */
  bodyText?: string;
}

export type SyncState = Record<string, unknown>;

/** A mailbox we can read changes from since the last sync. */
export interface MailSource {
  readonly provider: EmailProvider;
  fetchChanges(state: SyncState): Promise<{ messages: MailMessage[]; state: SyncState }>;
}

export const lower = (a: string) => a.trim().toLowerCase();
export const domainOf = (address: string) => lower(address).split("@")[1] ?? "";
