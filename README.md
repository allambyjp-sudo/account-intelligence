# Account Intelligence Platform

A web app for enterprise sellers in Australia and New Zealand. Enter a company and get a live
account page: a deep, cited brief, live news and signals, hiring and tech-stack evidence, an AI
sales advisor, account memory, one-click meeting prep, and email linked to each account.

What sets it apart: deep ANZ public sources, memory that builds over time, meeting prep in one
click, and email tied to each account.

## Status: built end to end; real connections pending

Every phase is built and tested against stand-ins (fixtures shaped like each source, a mock model,
a synthetic mailbox). `docs/connecting.md` lists what to plug in and what each connection unlocks.

| # | Phase | Status |
|---|-------|--------|
| 1 | Foundation: sign-in, database, model layer, fetch layer, job queue, UI shell | **Done** |
| 2 | Research agent: intake and entity resolution, ANZ source adapters, the cited brief | **Done** (sources connect later) |
| 3 | Live monitoring: pollers, signal classification, timeline, share price | **Done** |
| 4 | Sales advisor and account memory: notes with dictation, embeddings, "what's changed" | **Done** |
| 5 | Meeting prep: one-pager, PDF and Word export | **Done** |
| 6 | Email: Outlook/Gmail/synthetic ingestion, matching, Confirm queue, seller inbox | **Done** (real mailboxes off until approved) |
| 7 | Conver, Datacom tenant, IT and privacy review | **Prepared**: provider stub, Dockerfile, deployment guide, review pack |

## Ground rules, and where they're enforced

| Rule (from the brief) | Enforced by |
|-----------------------|-------------|
| Everything cited; unverifiable means Unconfirmed | Database CHECK constraints; citation refs validated in code |
| Professional contacts only, labelled Published / Verified pattern / Inferred | Database (no column for anything else; phones never inferred); contacts checked against their source |
| Public and free data; respect terms and robots.txt | One fetch layer with robots.txt, rate limits and caching; unconfirmed-terms sources start off |
| Swappable model layer | `LLMProvider` and `EmbeddingProvider`; `LLM_PROVIDER` switches |
| No real customer data until Conver | Banner on every page; real mailboxes refused in code; a test fails on non-reserved domains in fixtures |
| Per-account email exclusion | Database trigger refuses and purges |
| Every prompt in /prompts, versioned | Prompt loader; outputs record prompt id and version |

Reasoning for every significant choice: [`docs/decisions.md`](docs/decisions.md).

## Quick start

Needs Node 22+ and Docker (or a local Postgres 16 with pgvector).

```bash
npm install
cp .env.example .env            # then set SESSION_SECRET (openssl rand -base64 48) and CRAWLER_CONTACT
docker compose up -d            # Postgres 16 + pgvector, plus an aip_test database
npm run db:migrate
npm run db:seed                 # three fictional accounts and demo matching rules
npm run catalogue:sync          # services catalogue (placeholders until you edit it)
npm run dev                     # http://localhost:3000, choose "Development sign-in"
npm run worker                  # second terminal: every background job runs here
```

Try it without any keys:

- **Inbox:** "Connect the synthetic test mailbox". Fictional mail flows through matching, the
  Confirm queue and the priority list.
- **Account page:** add notes (try Dictate), search memory, and prepare a meeting.
- **Add account:** shows what each registry needs before it can search.

With `LLM_PROVIDER=mock`, model steps fail cleanly (and say so). Add `ANTHROPIC_API_KEY` to see real
briefs, advice, summaries and meeting prep:

```bash
npm run llm:smoke        # one text and one structured call, under a cent
npm run sources:check    # one live call per source; reports ok / skipped / FAILED with reasons
```

## Checks

```bash
npm run typecheck
npm test          # unit tests always; integration tests too when TEST_DATABASE_URL is set
npm run build
```

Integration tests create and drop their own Postgres schema per suite, so they don't touch your
data. CI runs everything against a pgvector Postgres service on every push.

## Background jobs (worker)

| Job | When | What |
|-----|------|------|
| `resolve-intake` | On "Add account" | Registry and ASX search for the picker |
| `research-account` | On create or "Re-run research" | Gather sources, then six cited brief sections |
| `monitor-sweep` / `monitor-account` | Every 2 hours (`:17`) | News, press, announcements, tenders, careers changes, share price |
| `classify-sweep` / `classify-signals` | Hourly, and after polling | Type, importance and relevance; high importance raises an alert |
| `match-advisories` | Daily 7:43 | ACSC advisories matched to accounts' tech stacks |
| `quiet-check` | Daily 8:11 | Quiet-customer alerts for key accounts |
| `memory-sync` | After notes, email, signals, research | Embeds anything new for the current model |
| `advisor-refresh` | When inputs change meaningfully | Next best actions, trigger alerts, talking points, risk flags |
| `meeting-prep` | On "Prepare for a meeting" | The one-pager |
| `mail-sync-sweep` / `mail-sync` | Every 15 minutes, and on Graph notifications | Mailbox delta sync, match, summarise |
| `graph-subscriptions` | Every 12 hours | Keeps Outlook change notifications alive |

Times are Melbourne time (`APP_TIMEZONE`).

## Layout

```
db/migrations/        SQL schema, the source of truth (constraints and triggers live here)
prompts/              every LLM prompt, versioned (see prompts/README.md)
data/                 services catalogue, news and advisory feeds, synthetic mailbox
docs/                 decisions, connecting, deployment, privacy and security, Conver, Entra
scripts/              migrate, seed, worker, catalogue sync, LLM smoke test, source check
src/app/              pages, server actions, API routes (auth, connect, webhooks, export, health)
src/lib/auth/         Entra sign-in (MSAL), sealed cookies
src/lib/llm/          LLMProvider, EmbeddingProvider; Anthropic, Conver (stub), mock, local, Voyage
src/lib/http/         PoliteFetcher: rate limits, retries, cache, robots.txt
src/lib/sources/      source adapters (registries, ASX, AusTender, news, feeds, web, careers, PDF, prices)
src/lib/intake/       entity resolution
src/lib/research/     the research agent: gather, source pack, sections, citations, contact rules
src/lib/monitor/      polling, classification, advisories, price moves, quiet customers
src/lib/memory/       chunking, embeddings, search, what's changed
src/lib/advisor/      the sales advisor
src/lib/meetings/     meeting prep, one-pager, PDF and Word export
src/lib/email/        mail sources, matching, ingestion, inbox, mailbox policy, tokens
src/lib/jobs/         job definitions and the pg-boss queue
tests/                Vitest; tests/integration needs TEST_DATABASE_URL
```

## Stack

Next.js 16, React 19, TypeScript (strict), Tailwind CSS 4, PostgreSQL 16 with pgvector, Drizzle
ORM, pg-boss, MSAL Node, the Anthropic TypeScript SDK, Zod, fast-xml-parser, node-html-parser,
unpdf, docx, PDFKit and Vitest.

## Open questions (from the brief)

- Does Conver expose an API, and is it approved to process mailbox data? (`docs/conver-integration.md`)
- Datacom's AI usage policy, and its data residency requirements for customer email. (`docs/privacy-and-security.md`)
- Who owns the IP if this is built outside Datacom time.
- Where the Datacom services catalogue and case studies will come from. (`data/services-catalogue.json` holds placeholders)
