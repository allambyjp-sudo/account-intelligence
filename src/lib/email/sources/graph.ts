import type { Address, MailMessage, MailSource, SyncState } from "../types";

/**
 * Outlook via Microsoft Graph, delegated Mail.Read. Uses delta queries on Inbox and Sent Items so
 * each sync returns only what changed; the delta links are the sync state.
 */
export const GRAPH = "https://graph.microsoft.com/v1.0";
const SELECT = "subject,from,toRecipients,ccRecipients,receivedDateTime,sentDateTime,conversationId,bodyPreview,body";

interface GraphRecipient {
  emailAddress?: { address?: string; name?: string };
}
interface GraphMessage {
  id: string;
  conversationId?: string;
  subject?: string;
  from?: GraphRecipient;
  toRecipients?: GraphRecipient[];
  ccRecipients?: GraphRecipient[];
  receivedDateTime?: string;
  sentDateTime?: string;
  bodyPreview?: string;
  body?: { contentType?: string; content?: string };
  "@removed"?: unknown;
}
interface GraphPage {
  value: GraphMessage[];
  "@odata.nextLink"?: string;
  "@odata.deltaLink"?: string;
}

const addr = (r?: GraphRecipient): Address | null => (r?.emailAddress?.address ? { address: r.emailAddress.address, ...(r.emailAddress.name ? { name: r.emailAddress.name } : {}) } : null);

export function normaliseGraphMessage(m: GraphMessage, direction: "inbound" | "outbound"): MailMessage | null {
  const from = addr(m.from);
  if (m["@removed"] || !from) return null;
  return {
    providerMessageId: m.id,
    threadId: m.conversationId ?? m.id,
    subject: m.subject ?? "(no subject)",
    from,
    to: (m.toRecipients ?? []).map(addr).filter((a): a is Address => Boolean(a)),
    cc: (m.ccRecipients ?? []).map(addr).filter((a): a is Address => Boolean(a)),
    receivedAt: new Date(m.receivedDateTime ?? m.sentDateTime ?? Date.now()),
    direction,
    preview: m.bodyPreview ?? "",
    ...(m.body?.content ? { bodyText: m.body.content } : {}),
  };
}

export class GraphMailSource implements MailSource {
  readonly provider = "graph" as const;
  constructor(
    private readonly accessToken: () => Promise<string>,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly maxPages = 20,
  ) {}

  async fetchChanges(state: SyncState) {
    const next: SyncState = { ...state };
    const messages: MailMessage[] = [];
    for (const [folder, direction] of [
      ["inbox", "inbound"],
      ["sentitems", "outbound"],
    ] as const) {
      let url = (state[`delta:${folder}`] as string | undefined) ?? `${GRAPH}/me/mailFolders('${folder}')/messages/delta?$select=${SELECT}&$top=50`;
      for (let page = 0; page < this.maxPages; page++) {
        const res = await this.fetchImpl(url, {
          headers: { authorization: `Bearer ${await this.accessToken()}`, prefer: 'outlook.body-content-type="text"' },
          signal: AbortSignal.timeout(30_000),
        });
        if (res.status === 410) {
          // The delta token expired: start this folder again from scratch.
          delete next[`delta:${folder}`];
          url = `${GRAPH}/me/mailFolders('${folder}')/messages/delta?$select=${SELECT}&$top=50`;
          continue;
        }
        if (!res.ok) throw new Error(`Graph ${folder} delta failed: ${res.status} ${await res.text().catch(() => "")}`.trim());
        const body = (await res.json()) as GraphPage;
        for (const m of body.value) {
          const n = normaliseGraphMessage(m, direction);
          if (n) messages.push(n);
        }
        if (body["@odata.nextLink"]) url = body["@odata.nextLink"];
        else {
          if (body["@odata.deltaLink"]) next[`delta:${folder}`] = body["@odata.deltaLink"];
          break;
        }
      }
    }
    return { messages, state: next };
  }
}

/** Change notifications (webhooks) for new Inbox mail. Graph caps message subscriptions at just under 3 days. */
export async function createGraphSubscription(accessToken: string, notificationUrl: string, clientState: string, fetchImpl: typeof fetch = fetch) {
  const expirationDateTime = new Date(Date.now() + 4_200 * 60_000).toISOString();
  const res = await fetchImpl(`${GRAPH}/subscriptions`, {
    method: "POST",
    headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
    body: JSON.stringify({ changeType: "created", notificationUrl, resource: "me/mailFolders('inbox')/messages", expirationDateTime, clientState }),
  });
  if (!res.ok) throw new Error(`Graph subscription failed: ${res.status} ${await res.text().catch(() => "")}`.trim());
  const body = (await res.json()) as { id: string; expirationDateTime: string };
  return { id: body.id, expiresAt: new Date(body.expirationDateTime) };
}

export async function renewGraphSubscription(accessToken: string, subscriptionId: string, fetchImpl: typeof fetch = fetch) {
  const expirationDateTime = new Date(Date.now() + 4_200 * 60_000).toISOString();
  const res = await fetchImpl(`${GRAPH}/subscriptions/${subscriptionId}`, {
    method: "PATCH",
    headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
    body: JSON.stringify({ expirationDateTime }),
  });
  if (!res.ok) throw new Error(`Graph subscription renewal failed: ${res.status}`);
  return new Date(((await res.json()) as { expirationDateTime: string }).expirationDateTime);
}
