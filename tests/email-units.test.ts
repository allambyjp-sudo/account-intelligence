import { describe, expect, it } from "vitest";
import { priorityScore } from "@/lib/email/inbox";
import { realMailboxPolicy } from "@/lib/email/policy";
import { normaliseGmailMessage, parseAddressList } from "@/lib/email/sources/gmail";
import { GraphMailSource, normaliseGraphMessage } from "@/lib/email/sources/graph";
import { loadSyntheticMessages, SyntheticMailSource } from "@/lib/email/sources/synthetic";
import { gmailTokens, sealTokens, unsealTokens } from "@/lib/email/tokens";

const now = new Date("2026-10-30T00:00:00Z");
const day = 86_400_000;

describe("Outlook (Graph) messages", () => {
  it("normalises a message and skips removals", () => {
    const m = normaliseGraphMessage(
      {
        id: "AAMk1",
        conversationId: "conv-1",
        subject: "Renewal",
        from: { emailAddress: { address: "priya@bellbird.example", name: "Priya" } },
        toRecipients: [{ emailAddress: { address: "me@seller.example" } }],
        receivedDateTime: "2026-10-29T01:00:00Z",
        bodyPreview: "Hi",
        body: { contentType: "text", content: "Hi there" },
      },
      "inbound",
    );
    expect(m).toMatchObject({ threadId: "conv-1", from: { address: "priya@bellbird.example", name: "Priya" }, bodyText: "Hi there" });
    expect(normaliseGraphMessage({ id: "x", "@removed": { reason: "deleted" } }, "inbound")).toBeNull();
  });

  it("follows nextLink pages, keeps the deltaLink, and restarts a folder when the token expires", async () => {
    const calls: string[] = [];
    const pages: Record<string, unknown> = {
      inbox1: { value: [{ id: "1", conversationId: "c", subject: "a", from: { emailAddress: { address: "x@a.example" } } }], "@odata.nextLink": "https://graph.example/inbox2" },
      inbox2: { value: [], "@odata.deltaLink": "https://graph.example/inbox-delta" },
      sent: { value: [{ id: "2", conversationId: "c", subject: "b", from: { emailAddress: { address: "me@seller.example" } } }], "@odata.deltaLink": "https://graph.example/sent-delta" },
    };
    const fakeFetch = (async (url: string, init?: RequestInit) => {
      calls.push(url);
      expect((init!.headers as Record<string, string>).authorization).toBe("Bearer tok");
      if (url === "https://graph.example/expired") return new Response("", { status: 410 });
      if (url.includes("mailFolders('inbox')")) return new Response(JSON.stringify(pages.inbox1));
      if (url === "https://graph.example/inbox2") return new Response(JSON.stringify(pages.inbox2));
      return new Response(JSON.stringify(pages.sent));
    }) as unknown as typeof fetch;
    const src = new GraphMailSource(async () => "tok", fakeFetch);
    const res = await src.fetchChanges({ "delta:inbox": "https://graph.example/expired" });
    expect(res.messages.map((m) => `${m.providerMessageId}:${m.direction}`)).toEqual(["1:inbound", "2:outbound"]);
    expect(res.state).toEqual({ "delta:inbox": "https://graph.example/inbox-delta", "delta:sentitems": "https://graph.example/sent-delta" });
  });
});

describe("Gmail messages", () => {
  it("parses address headers with names and commas in quotes", () => {
    expect(parseAddressList('"Natarajan, Priya" <priya@bellbird.example>, tom@bellbird.example')).toEqual([
      { address: "priya@bellbird.example", name: "Natarajan, Priya" },
      { address: "tom@bellbird.example" },
    ]);
  });

  it("finds the plain-text part and the direction", () => {
    const m = normaliseGmailMessage({
      id: "g1",
      threadId: "t1",
      snippet: "Hi",
      internalDate: String(now.getTime()),
      labelIds: ["SENT"],
      payload: {
        headers: [
          { name: "From", value: "Me <me@seller.example>" },
          { name: "To", value: "priya@bellbird.example" },
          { name: "Subject", value: "Re: Renewal" },
        ],
        mimeType: "multipart/alternative",
        parts: [{ mimeType: "text/plain", body: { data: Buffer.from("Plain body").toString("base64url") } }],
      },
    });
    expect(m).toMatchObject({ direction: "outbound", subject: "Re: Renewal", bodyText: "Plain body", to: [{ address: "priya@bellbird.example" }] });
  });
});

describe("synthetic mailbox", () => {
  it("delivers each message once", async () => {
    const src = new SyntheticMailSource(undefined, () => now);
    const first = await src.fetchChanges({});
    expect(first.messages.length).toBe(loadSyntheticMessages(undefined, now).length);
    expect((await src.fetchChanges(first.state)).messages).toEqual([]);
  });
});

describe("inbox priority", () => {
  const thread = (classification: Parameters<typeof priorityScore>[0]["classification"], daysAgo = 1, outboundDaysAgo: number | null = null) => ({
    classification,
    lastMessageAt: new Date(now.getTime() - daysAgo * day),
    lastOutboundAt: outboundDaysAgo === null ? null : new Date(now.getTime() - outboundDaysAgo * day),
  });

  it("puts replies owed first, then near deadlines, then quotes", () => {
    const reply = priorityScore(thread("needs_reply"), [], now).score;
    const deadline = priorityScore(thread("deadline_mentioned"), [{ date: "2026-11-01" }], now);
    const quote = priorityScore(thread("quote_or_renewal"), [], now).score;
    expect(reply).toBeGreaterThan(quote);
    expect(deadline.score).toBeGreaterThan(quote);
    expect(deadline.why).toBe("deadline in 2 days");
  });

  it("raises stale threads we're waiting on, and ignores past deadlines", () => {
    expect(priorityScore(thread("waiting_on_them", 8, 8), [], now).why).toMatch(/nudge/);
    expect(priorityScore(thread("info_only"), [{ date: "2026-01-01" }], now).why).toBe("info only");
  });
});

describe("mailbox policy", () => {
  it("keeps real mailboxes off until IT approves and email runs through Conver", () => {
    expect(realMailboxPolicy({}).allowed).toBe(false);
    expect(realMailboxPolicy({ MAILBOX_CONNECT_APPROVED: "true" }).reasons).toEqual([expect.stringMatching(/Conver/)]);
    expect(realMailboxPolicy({ MAILBOX_CONNECT_APPROVED: "true", LLM_PROVIDER: "conver" }).allowed).toBe(true);
    expect(realMailboxPolicy({ MAILBOX_CONNECT_APPROVED: "true", ALLOW_MAILBOX_WITHOUT_CONVER: "true" }).allowed).toBe(true);
  });
});

describe("mailbox tokens", () => {
  it("seals with their own purpose, so they can't be read as a session", () => {
    const env = { TOKEN_ENCRYPTION_KEY: "k".repeat(40) };
    const sealed = sealTokens({ refreshToken: "r" }, env);
    expect(unsealTokens(sealed, gmailTokens, env)).toEqual({ refreshToken: "r" });
    expect(unsealTokens(sealed, gmailTokens, { TOKEN_ENCRYPTION_KEY: "x".repeat(40) })).toBeNull();
    expect(() => sealTokens({}, { TOKEN_ENCRYPTION_KEY: "short" })).toThrow(/32 characters/);
  });
});
