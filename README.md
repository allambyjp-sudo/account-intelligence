# Account Intelligence Platform

A web app for enterprise sellers in Australia and New Zealand. Enter a company and get a live
account page: a deep, cited brief, live news and signals, hiring and tech-stack evidence, an AI
sales advisor, account memory, one-click meeting prep, and email linked to each account.

What sets it apart: deep ANZ public sources, memory that builds over time, meeting prep in one
click, and email tied to each account.

## Status: building all phases (branch `full-build`)

| # | Phase | Status |
|---|-------|--------|
| 1 | Foundation: repo, sign-in, database, model layer with the Anthropic provider, fetch layer, job queue, UI shell | **Done** |
| 2 | Research agent: intake and entity resolution, ANZ source adapters, the cited brief and brief viewer | **Done** (sources connect later) |
| 3 | Live monitoring: schedulers, signal classification, timeline, share price | **Done** |
| 4 | Sales advisor and account memory: notes, embeddings, "what's changed" | **Done** |
| 5 | Meeting prep: one-pager, PDF/DOCX export | **Done** |
| 6 | Email: Graph ingestion against a test mailbox with synthetic data, matching, seller inbox | **Done** (real mailboxes off until approved) |
| 7 | Conver: ConverProvider, Datacom tenant hosting, IT and privacy review | Planned |

## Ground rules

- **Public and free data only.** Official APIs and RSS first. Every external request goes through
  one fetch layer that enforces rate limits, retries, caching and robots.txt.
- **Everything cited.** Claims carry a source and retrieval date, or they're labelled Unconfirmed.
  The database enforces it.
- **Professional contact details only**, labelled Published, Verified pattern or Inferred. There is
  no column for anything personal, and phone numbers are never guessed.
- **Swappable model layer.** All LLM calls go through `LLMProvider`. `LLM_PROVIDER` switches
  between Anthropic, Conver (stub) and a mock.
- **Fictional and public data only** until the model layer runs through Conver. That includes notes
  about real accounts, not just email. A test fails if seed data or fixtures name a real domain.

See [`docs/decisions.md`](docs/decisions.md) for the reasoning behind each choice.

## Quick start

Needs Node 22+ and Docker (or a local Postgres 16 with pgvector).

```bash
npm install
cp .env.example .env            # then set SESSION_SECRET: openssl rand -base64 48
docker compose up -d            # Postgres 16 + pgvector, plus an aip_test database
npm run db:migrate
npm run db:seed                 # three fictional accounts for the dev sign-in user
npm run catalogue:sync          # services catalogue (placeholders until you edit it)
npm run dev                     # http://localhost:3000, choose "Development sign-in"
npm run worker                  # in a second terminal: background jobs and heartbeat
```

For the UI without an API key, set `LLM_PROVIDER=mock`. To check real model calls:

```bash
ANTHROPIC_API_KEY=... npm run llm:smoke   # one text call and one structured call, under a cent
```

Microsoft sign-in: [`docs/entra-sign-in-setup.md`](docs/entra-sign-in-setup.md).

## Checks

```bash
npm run typecheck
npm test          # unit tests always; integration tests too when TEST_DATABASE_URL is set
npm run build
```

Integration tests create and drop their own Postgres schema per suite, so they don't touch your
dev data. CI runs everything against a pgvector Postgres service.

## Layout

```
db/migrations/        SQL schema, the source of truth (constraints and triggers live here)
prompts/              every LLM prompt, versioned (see prompts/README.md)
data/                 services catalogue (maintained by hand)
docs/                 decisions, Entra setup
scripts/              migrate, seed, worker, catalogue sync, LLM smoke test
src/app/              Next.js pages and auth routes
src/lib/auth/         Entra sign-in (MSAL), sealed session cookies
src/lib/llm/          LLMProvider, EmbeddingProvider, Anthropic / Conver / mock providers
src/lib/prompts/      prompt loader and renderer
src/lib/http/         PoliteFetcher: rate limits, retries, cache, robots.txt
src/lib/sources/      source adapter contract (adapters arrive in Phase 2)
src/lib/jobs/         JobQueue on pg-boss, job definitions
src/lib/db/           Drizzle mirror of the schema, connection
src/lib/accounts/     portfolio and account page queries, urgency scoring
src/lib/demo/         fictional seed data
tests/                Vitest; tests/integration needs TEST_DATABASE_URL
```

## Stack

Next.js 16, React 19, TypeScript (strict), Tailwind CSS 4, PostgreSQL 16 with pgvector, Drizzle
ORM, pg-boss, MSAL Node, the Anthropic TypeScript SDK, Zod and Vitest.

## Open questions (from the brief)

- Does Conver expose an API, and is it approved to process mailbox data?
- Datacom's AI usage policy, and its data residency requirements for customer email.
- Who owns the IP if this is built outside Datacom time. **Settle this before Phase 2.**
- Where the Datacom services catalogue and case studies will come from.
