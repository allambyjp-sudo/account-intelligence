# Privacy and security review pack

For the IT and privacy review in Phase 7. It describes what the app stores, where data goes, and
the controls that are built in rather than just promised. Where a control lives in code or in the
database, the file is named so the reviewer can check it.

## What the app is

A seller tool. It researches companies from public sources, monitors them for changes, keeps the
seller's own notes, and (once approved) reads the seller's own mailbox for email with those
companies. It never connects to a customer's systems.

## Data inventory

| Data | Where | Source | Personal information? | Retention |
|------|-------|--------|-----------------------|-----------|
| Company records, brief sections, signals, tech stack | `entities`, `brief_sections`, `signals`, `tech_stack_items` | Public sources | No (business data) | Until the account is deleted; brief sections are versioned |
| Public sources' text | `sources`, `http_cache` | Public web, registries, news | Incidental (names in news) | Sources: kept while cited (the database refuses to delete a cited source). HTTP cache: expires per host (30 min to 30 days) |
| Stakeholders | `stakeholders`, `contact_points` | Public company pages, reports, news | Yes: names, titles, work contact details | Until the account is deleted |
| Seller notes, meetings, advice | `notes`, `meetings`, `recommendations` | The seller | Possibly (about customer staff) | Until the account is deleted |
| Email | `email_threads`, `email_summaries` | The seller's own mailbox (after approval) | Yes | Until the account is deleted or excluded |
| Memory vectors | `memory_chunks` | Derived from notes, email summaries, signals, brief | As above | Until the account is deleted |
| Users and mailbox tokens | `users`, `mail_connections` | Entra sign-in, OAuth consent | Yes (seller's name and email) | Tokens deleted on disconnect |

## Controls the database enforces

In `db/migrations`; tests in `tests/integration/invariants.test.ts`.

- **Professional contacts only.** A contact can only be a work email or a work phone. There is no
  column for anything else. Phone numbers must be published; they are never inferred.
- **Everything cited.** A claim can only be "verified" with a source and a retrieval time.
- **Email exclusion.** A trigger refuses to store email against an excluded account, and excluding
  an account deletes the email already stored.
- **Deletion cascades.** Deleting an account removes everything stored about it (Account
  settings, then Delete).

## Controls in code

- **No real mailbox until approved** (`src/lib/email/policy.ts`): it requires
  `MAILBOX_CONNECT_APPROVED=true` and `LLM_PROVIDER=conver`.
- **Only account mail is kept** (`src/lib/email/ingest.ts`). Internal mail, personal mail,
  unmatched mail and mail for excluded accounts is never stored. Rejected threads are deleted.
- **Summaries, not bodies, by default.** Bodies are stored only if the seller opts in.
- **Contact details are checked against their source** (`src/lib/research/sections.ts`). An
  email is kept only if printed in the cited source and on the company's own domain. Addresses
  are never probed against mail servers. Pattern guesses are labelled Inferred or Verified pattern.
- **No social networks.** Web search excludes LinkedIn, Facebook, Instagram, TikTok, X and Seek.
- **Polite, honest collection** (`src/lib/http/fetcher.ts`): robots.txt, rate limits, caching and
  a User-Agent with a contact address. Sources whose terms aren't confirmed stay off.
- **No real customer data in the code base.** A test fails if seed data, fixtures or prompts
  name a non-reserved domain (`tests/no-real-data.test.ts`).

## Where data goes

| Destination | What is sent | When |
|-------------|--------------|------|
| Model provider (Claude API now; Conver after Phase 7) | Public source text, brief summaries, seller notes, email text (after approval), stakeholder names and titles | Research, classification, advisor, meeting prep, email summaries |
| Embeddings provider | The same text as memory | Only if `voyage`; `local` keeps it on the server |
| Public sources | Company names, tickers and ABNs in queries | Research and monitoring |
| Microsoft Graph / Gmail | OAuth tokens (delegated, read-only) | Email sync |

The switch to Conver (`LLM_PROVIDER=conver`) moves all model processing inside Datacom with no code
change. Until then, the guidance for development is fictional and public data only. The app shows
a banner saying so on every page.

## Authentication and access

- Microsoft Entra ID, single tenant, authorization code flow with PKCE. Sign-ins from another
  tenant are rejected.
- Sessions are encrypted (AES-256-GCM), HttpOnly, SameSite=Lax cookies, valid for 8 hours.
- Every page and action checks ownership on the server. A seller sees only their own accounts
  (`tests/integration/portfolio.test.ts`).
- State-changing auth routes are POST-only and check the request's origin.
- The development sign-in refuses to start in production.
- Mailbox tokens are sealed with their own key (`TOKEN_ENCRYPTION_KEY`) before storage, and
  deleted on disconnect.
- Graph webhooks only trigger a sync, and only when their client-state secret matches.

## Threats and mitigations

| Threat | Mitigation |
|--------|------------|
| Prompt injection in web pages or email ("ignore previous instructions...") | Prompts tell the model to treat sources and email as data. Outputs are schema-validated, citations are checked against handed-out refs, and the model has no tools that act. |
| The model inventing facts, people or quotes | Unsourced claims are labelled Unconfirmed; quotes must appear verbatim in their source; contacts must appear in their source |
| Mail for the wrong account | Uncertain matches go to the Confirm queue; excluded accounts are enforced in the database |
| Leaked database dump | Mailbox tokens are sealed; there are no passwords |
| Credential leakage via citations | API URLs carrying keys (ABN GUID, Alpha Vantage key) are never stored as citation URLs (tested) |
| Over-collection from websites | robots.txt honoured; rate limits; no social networks; no SMTP probing |

## Open items for the review

1. Is Conver approved to process customer email and seller notes, and where is data processed and stored?
2. Datacom's AI usage policy and data residency requirements for customer email.
3. Retention: the app keeps data until an account is deleted. Does Datacom need a fixed
   retention period for email summaries or notes (for example, 24 months)?
4. Australian Privacy Principles: stakeholder data is collected from public professional sources.
   Confirm the collection notice and access/correction process Datacom wants.
5. Logging and audit: the app logs job outcomes, not content. Confirm what audit trail is required.
6. Who owns the IP if this was built outside Datacom time.
