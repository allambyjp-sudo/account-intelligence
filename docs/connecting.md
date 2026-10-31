# Connecting the platform

Everything is built and tested against stand-ins (fixtures, a mock model, a synthetic mailbox).
This is the list of real connections, in the order worth doing them, what each one unlocks, and
how to check it.

**Golden rule:** secrets go in environment variables or the hosting platform's secret store, never
in chat, code or git.

## Quick status

| # | Connection | Unlocks | Needs | Effort |
|---|------------|---------|-------|--------|
| 1 | Claude API key | Research, classification, advisor, meeting prep, email summaries | `ANTHROPIC_API_KEY` | 5 min |
| 2 | Network access to sources | All public sources | Allowed domains in the environment | 5 min |
| 3 | Crawler contact | Any external fetch | `CRAWLER_CONTACT` | 1 min |
| 4 | ABN Lookup | Australian entity resolution | `ABN_LOOKUP_GUID` | Register, then wait for the GUID email |
| 5 | NZBN | New Zealand entity resolution | `NZBN_API_KEY` | Register on api.business.govt.nz |
| 6 | Alpha Vantage | Share price and price-move signals | `ALPHA_VANTAGE_API_KEY` | 2 min |
| 7 | Entra sign-in | Real sign-in | `ENTRA_*` | 10 min (docs/entra-sign-in-setup.md) |
| 8 | Embeddings | Account memory search by meaning | `EMBEDDING_PROVIDER=local` or `voyage` | 5 min |
| 9 | Mailbox | Email ingestion from Outlook or Gmail | IT approval and Conver | Phase 7 |
| 10 | Conver | Moving the model layer to Datacom | API details | Phase 7 (docs/conver-integration.md) |

After each step, run `npm run sources:check` (for sources) or `npm run llm:smoke` (for the model).

## 1. Claude API key

Set `ANTHROPIC_API_KEY` and `LLM_PROVIDER=anthropic`. In this cloud environment: the environment
menu in the session title bar, then Edit, then add it as a secret; a new session picks it up.

Check: `npm run llm:smoke` makes one text call and one structured call (well under a cent).

**Then tune the prompts.** They were written without a model to test against. Run research on two
or three real, public companies and read the brief critically: citation coverage, Unconfirmed
labels, tone. Adjust files in `/prompts` and bump their `version`. Each run's stats show
`invalidRefs`, `droppedQuotes` and `droppedContacts`. High numbers there mean a prompt needs work.

**Cost:** every task defaults to Claude Opus 5.5 ($4 / $20 per million input / output tokens). A
full research run is roughly 6 calls over a ~40k-token cached source pack, so expect around
$0.50–$1.50 per account per run [estimate; confirm with the first runs' token counts on the brief
page]. Classification is the high-volume task: `LLM_MODEL_CLASSIFY=claude-haiku-5-5` is the
obvious saving once volumes are known.

## 2. Network access

The cloud environment's network policy currently blocks the source hosts. Add these under
Allowed domains (environment menu, then Edit, then Network access), or choose a broader level:

```
abr.business.gov.au
api.business.govt.nz
www.asx.com.au
api.tenders.gov.au
news.google.com
www.alphavantage.co
www.theregister.com
www.itnews.com.au
www.crn.com.au
www.arnnet.com.au
itbrief.com.au
itbrief.co.nz
securitybrief.com.au
www.reseller.co.nz
www.cyber.gov.au
huggingface.co              (only for EMBEDDING_PROVIDER=local, first run)
api.voyageai.com            (only for EMBEDDING_PROVIDER=voyage)
graph.microsoft.com         (Phase 7, mailbox)
login.microsoftonline.com   (Entra sign-in and mailbox consent)
```

Company websites are fetched too, during research and careers monitoring. Those hosts can't be
listed in advance, so a broad access level suits research best. When hosted in Datacom's tenant,
the same list goes into the outbound firewall rules.

Check: `npm run sources:check`. Each source reports ok, skipped (no key) or FAILED with the reason.
When a source passes, set `formatVerified: true` in its adapter (or `verified: true` in
`data/news-feeds.json`). Formats were written from documentation and will likely need small fixes
on first contact. The adapter tests show exactly what each parser expects.

## 3. Crawler contact

`CRAWLER_CONTACT=you@example.com` (an address or URL). It goes in the User-Agent so site owners
can reach you. The app refuses to fetch anything without it.

## 4. ABN Lookup

Register for a GUID on the ABN Lookup web services page (abr.business.gov.au, "Web services").
It's free; the GUID arrives by email. Set `ABN_LOOKUP_GUID`.

Check: `npm run sources:check` (searches for "Australian Taxation Office" by default, or
`-- --company "Name"`).

## 5. NZBN

Register on api.business.govt.nz, subscribe to the NZBN API, and set `NZBN_API_KEY`. If the API
version has moved past v5, set `NZBN_API_BASE`.

## 6. Alpha Vantage

Get a free key on alphavantage.co and set `ALPHA_VANTAGE_API_KEY`. The free tier allows about
25 calls a day; the app fetches each listed account at most once a day.

Check: `npm run sources:check -- --ticker BHP`. If ASX symbols don't resolve with `.AX`, set
`ALPHA_VANTAGE_SUFFIX_ASX` (and `_NZX` for New Zealand) to whatever the API expects.

## 7. Entra sign-in

Follow `docs/entra-sign-in-setup.md`. Set `AUTH_DEV_BYPASS=false` once it works.

## 8. Embeddings

- `EMBEDDING_PROVIDER=local`: run `npm install @huggingface/transformers`. The model (about 90 MB)
  downloads from huggingface.co on first use. Free, and memory never leaves the machine.
- `EMBEDDING_PROVIDER=voyage`: set `VOYAGE_API_KEY` (and optionally `VOYAGE_MODEL`).

The worker re-embeds everything for the new model by itself (`memory-sync`).

## 9. Mailbox (Phase 7, needs approval)

Real mailboxes are refused in code until both are true:

- `MAILBOX_CONNECT_APPROVED=true`, meaning IT has approved it;
- `LLM_PROVIDER=conver`, meaning email content goes to Datacom's own AI platform.

`ALLOW_MAILBOX_WITHOUT_CONVER=true` lifts the second check, for a personal test mailbox only.
Until then, use the synthetic mailbox (Inbox, then "Connect the synthetic test mailbox").

**Outlook:** in the same Entra app registration, add the redirect URI
`<your app>/api/connect/graph/callback` and the delegated permission `Mail.Read`. Also set:

- `ORG_EMAIL_DOMAINS` to your own domains (mail only among these is skipped);
- `TOKEN_ENCRYPTION_KEY` (32+ random characters) to seal mailbox tokens;
- `PUBLIC_BASE_URL` (HTTPS) for instant change notifications. Without it, the 15-minute sync
  sweep is the fallback.

**Gmail (optional):** create a Google OAuth client with redirect URI
`<your app>/api/connect/gmail/callback` and the `gmail.readonly` scope, then set
`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and `GOOGLE_REDIRECT_URI`.

## 10. Conver

See `docs/conver-integration.md`.

## Sources that stay off until their terms are read

`asx_announcements` reads the JSON behind asx.com.au. Read ASX's website terms first; if they allow
it, set `SOURCES_ENABLED=asx_announcements`. LinkedIn and Seek aren't read at all (their terms
prohibit scraping). Job-alert emails you subscribe to can reach accounts through the inbox
instead.
