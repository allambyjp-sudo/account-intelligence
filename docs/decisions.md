# Decisions

Short records of the calls that shape the build, and why. Add to the end; don't rewrite history.
If a decision is reversed, add a new entry that says so.

---

## 1. A separate repository from LIP (30 Oct 2026)

The Licensing Intelligence Platform (LIP) lives in its own repo and is kept clear of anything
employer-related. This platform is the opposite: a seller tool built for Datacom, using Datacom's
services catalogue and heading for Datacom's tenant. Keeping them apart keeps each one's ownership
clean, and keeps two different security boundaries in separate deployables. LIP reads client
tenants with application permissions; this app reads a seller's own mailbox with delegated
permissions.

## 2. Drizzle and plain SQL migrations, not Prisma (30 Oct 2026)

The brief named Prisma. pgvector decided it: classic Prisma ORM still treats `vector` columns as
`Unsupported` and needs raw SQL for similarity search. Native support exists only in the newer
Prisma Next stack. Drizzle has vector columns and distance helpers, and LIP already uses it.

SQL in `db/migrations/` is the source of truth because it carries the CHECK constraints and
triggers that enforce the brief's rules (see 7). `src/lib/db/schema.ts` mirrors it for typed
queries, and `tests/integration/schema.test.ts` fails on any drift, including enum value lists.

## 3. pg-boss on Postgres, not BullMQ and Redis (30 Oct 2026)

The brief named BullMQ with Redis. pg-boss keeps the queue in the same Postgres database, has cron
scheduling built in, and removes a service to host, secure and put through Datacom IT review. It
sits behind the `JobQueue` interface (`src/lib/jobs/types.ts`), so BullMQ can replace it if volume
ever needs it.

## 4. MSAL Node for sign-in (30 Oct 2026)

Phase 6 needs MSAL anyway for delegated Microsoft Graph tokens (Mail.Read), so one Microsoft library
covers sign-in and Graph. It is also the library Datacom IT will recognise. Auth is checked per
request in server code, not only in middleware.

## 5. Two model interfaces: LLMProvider and EmbeddingProvider (30 Oct 2026)

Anthropic has no embeddings API; its docs point to Voyage AI. The swappable model layer is therefore
two interfaces. For Phase 4 the plan is a local embedding model in the worker (free, and account
memory never leaves the box), with Voyage as an option. Every vector records its model, so changing
models means a re-embed job, not a schema change.

Providers declare their capabilities. Anthropic offers server-side web search; Conver may not. The
research agent (Phase 2) treats the source adapters as its main input and web search as an extra
it can do without.

## 6. Model defaults (30 Oct 2026)

- Every task defaults to `claude-opus-5-5`. Per-task overrides via `LLM_MODEL_<TASK>` and
  `LLM_EFFORT_<TASK>`. Cheaper models for classification are a cost decision to make once real
  volumes are known.
- Effort is set per task (`src/lib/llm/tasks.ts`). Opus 5.5 always thinks, and its default
  effort is `medium`, so effort is set explicitly.
- **Server-side refusal fallback is on** (`fallbacks: "default"`). If the model declines for
  policy reasons, the API re-runs the request on Anthropic's recommended substitute. Provenance
  records which model actually served each response. Turn it off with `LLM_REFUSAL_FALLBACK=off`.
- Structured output uses the API's JSON-schema format, then validates again with Zod. Output that
  doesn't validate is an error, never a partial save.
- A response cut off at the token limit is an error, not a partial answer.

## 7. Rules the database enforces (30 Oct 2026)

These are CHECK constraints and triggers, so an application bug can't break them:

- **Everything cited.** A claim can only be `verified` with a source and a retrieval time;
  otherwise it is `unconfirmed`. A source that something cites can't be deleted.
- **Professional contacts only.** `contact_points.kind` allows only `work_email` or `work_phone`.
  Phone numbers must be published; they are never inferred. A `verified_pattern` email must record
  its pattern.
- **Every recommendation has evidence.** An empty evidence array is rejected.
- **Email exclusion.** Email can't be stored against an excluded account, and excluding an account
  purges its stored email.

"Verified pattern" means an address pattern confirmed by two or more published addresses on the
same domain. Addresses are never checked by probing mail servers.

## 8. Fictional and public data only until Conver (30 Oct 2026)

This covers more than email. Notes, meeting logs and opportunity details about real Datacom
accounts are confidential customer information. Until the model layer runs through Conver and IT
has approved it, development uses fictional accounts on reserved `.example` domains plus public
research. `tests/no-real-data.test.ts` fails if seed data, fixtures, prompts or data files mention a
non-reserved domain.

## 9. One fetch path for every external source (30 Oct 2026)

`PoliteFetcher` (`src/lib/http`) is the only way the app fetches from the outside world. It
applies per-host rate limits, retries with backoff (honouring Retry-After), a shared Postgres
response cache with ETag/Last-Modified revalidation, robots.txt for websites (including
Crawl-delay), the same rules on every redirect hop, and a User-Agent with a contact address.
Rate limits are per process, so external fetching runs in the worker.

Source realities that shape Phase 2 and 3 (checked 30 Oct 2026):

- LinkedIn's terms prohibit scraping, and Seek's likely do too. Use company careers pages, and
  later the job-alert emails the seller subscribes to (Phase 6).
- OAIC publishes breach statistics, not company names. Company-level breaches come from ASX
  disclosures and news.
- ACSC advisories are about vendors and vulnerabilities. Match them against each account's tech
  stack hypothesis.
- Alpha Vantage's free tier allows about 25 calls a day; ASX coverage still needs a test call.
  Yahoo Finance has no official API.
- AusTender's OCDS API covers awarded contracts (CC BY 3.0 AU). Open tenders are web pages only.

---

## 10. Build every phase now, connect later (31 Oct 2026)

JP's call: build phases 2–6 end to end, plus the Phase 7 preparation, without waiting on
credentials or the per-phase plan confirmation. Every external dependency sits behind an adapter or
provider with a test double. `docs/connecting.md` lists what to plug in and what each connection
unlocks. Work lands on the `full-build` branch, one commit per phase, with CI on each.

The sandbox's network policy blocks the source hosts, so adapter formats come from documentation
and are marked "format not yet checked live" until `npm run sources:check` confirms them.

## 11. How the research agent keeps "everything cited" (31 Oct 2026)

- Sources are numbered S1..Sn in a pack placed in the system prompt. The pack is identical for the
  six section calls, so it is cached after the first.
- The model cites refs; code maps them to source ids and drops any ref it didn't hand out. A claim
  with no valid ref is stored as Unconfirmed.
- Quotes are kept only if they appear verbatim in the cited source. Emails are kept as
  Published only if printed in the cited source and on the account's own domain. Phones only if
  the digits match. Everything else is dropped and counted in the run's stats.
- Tech stack items whose evidence excerpt isn't in a cited source drop to low confidence.
- Brief sections are versioned, never overwritten, and record the prompt id, version and model.
- A failing section doesn't stop the others; the run ends `partial`.
- Research never retries automatically, because it spends tokens. The seller re-runs it.

## 12. Web search excludes social networks (31 Oct 2026)

The research agent's web search blocks LinkedIn, Facebook, Instagram, TikTok, X and Seek. Their
terms prohibit automated collection, and they carry personal detail. Prior roles and statements
come from company pages, reports, news and talks instead.

## 13. Intake and research run in the worker (31 Oct 2026)

Registry lookups and research are jobs, never request-time fetches. The web app queues them via a
send-only pg-boss instance and polls. This keeps per-host rate limits in one process and keeps API
keys out of the web tier's request path. Seller-entered entities are Unconfirmed until research
finds a source.

## 14. Website tech footprint is deterministic (31 Oct 2026)

Vendors visible in a site's scripts, links and generator tag are detected by rules
(`src/lib/sources/footprint.ts`), not by the model. They are recorded as `web_footprint` evidence
at medium confidence: good evidence for the website's own stack, weaker for the wider estate.
