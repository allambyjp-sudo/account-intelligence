import type { Address, MailMessage, MailSource, SyncState } from "../types";

/** Gmail (optional connector): read-only scope, incremental by date. */
export const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";

interface GmailPart {
  mimeType?: string;
  body?: { data?: string };
  parts?: GmailPart[];
}
interface GmailMessage {
  id: string;
  threadId: string;
  snippet?: string;
  internalDate?: string;
  labelIds?: string[];
  payload?: { headers?: Array<{ name: string; value: string }> } & GmailPart;
}

/** Parses "Name <a@b.c>, d@e.f" header values. */
export function parseAddressList(value: string | undefined): Address[] {
  if (!value) return [];
  return value
    .split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/)
    .map((part) => {
      const m = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(part);
      if (m) return { address: m[2]!.trim(), ...(m[1]!.trim() ? { name: m[1]!.trim() } : {}) };
      const bare = part.trim();
      return bare.includes("@") ? { address: bare } : null;
    })
    .filter((a): a is Address => Boolean(a));
}

const b64url = (s: string) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");

function plainText(part: GmailPart | undefined): string | undefined {
  if (!part) return undefined;
  if (part.mimeType === "text/plain" && part.body?.data) return b64url(part.body.data);
  for (const p of part.parts ?? []) {
    const t = plainText(p);
    if (t) return t;
  }
  return undefined;
}

export function normaliseGmailMessage(m: GmailMessage): MailMessage | null {
  const h = (name: string) => m.payload?.headers?.find((x) => x.name.toLowerCase() === name.toLowerCase())?.value;
  const from = parseAddressList(h("From"))[0];
  if (!from) return null;
  const body = plainText(m.payload);
  return {
    providerMessageId: m.id,
    threadId: m.threadId,
    subject: h("Subject") ?? "(no subject)",
    from,
    to: parseAddressList(h("To")),
    cc: parseAddressList(h("Cc")),
    receivedAt: new Date(Number(m.internalDate ?? Date.now())),
    direction: m.labelIds?.includes("SENT") ? "outbound" : "inbound",
    preview: m.snippet ?? "",
    ...(body ? { bodyText: body } : {}),
  };
}

export class GmailMailSource implements MailSource {
  readonly provider = "gmail" as const;
  constructor(
    private readonly accessToken: () => Promise<string>,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async get<T>(url: string): Promise<T> {
    const res = await this.fetchImpl(url, { headers: { authorization: `Bearer ${await this.accessToken()}` }, signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`Gmail ${res.status}: ${await res.text().catch(() => "")}`.trim());
    return (await res.json()) as T;
  }

  async fetchChanges(state: SyncState) {
    const since = typeof state.afterEpoch === "number" ? state.afterEpoch : Math.floor(Date.now() / 1000) - 14 * 86_400;
    const ids: Array<{ id: string }> = [];
    let pageToken: string | undefined;
    for (let page = 0; page < 10; page++) {
      const q = encodeURIComponent(`after:${since} -in:chats`);
      const list = await this.get<{ messages?: Array<{ id: string }>; nextPageToken?: string }>(`${GMAIL}/messages?q=${q}&maxResults=100${pageToken ? `&pageToken=${pageToken}` : ""}`);
      ids.push(...(list.messages ?? []));
      pageToken = list.nextPageToken;
      if (!pageToken) break;
    }
    const messages: MailMessage[] = [];
    let newest = since;
    for (const { id } of ids) {
      const m = normaliseGmailMessage(await this.get<GmailMessage>(`${GMAIL}/messages/${id}?format=full`));
      if (!m) continue;
      messages.push(m);
      newest = Math.max(newest, Math.floor(m.receivedAt.getTime() / 1000));
    }
    return { messages, state: { ...state, afterEpoch: newest } };
  }
}

/** Google OAuth endpoints for the Gmail connect flow. */
export const GOOGLE_AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";
export const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
