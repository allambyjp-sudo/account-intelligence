<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Project rules (Account Intelligence Platform)

- Work phase by phase (README status table). Confirm the plan for a phase before writing its code.
  (JP waived this for the full build on 31 Oct 2026; see docs/decisions.md §10. Resume it for changes.)
- Strict TypeScript. Tests for every source adapter and for email matching.
- Every LLM call goes through `LLMProvider` (`src/lib/llm`). Every prompt lives in `/prompts`, with its
  version bumped when its output changes.
- Every external request goes through `PoliteFetcher` (`src/lib/http`). Never call `fetch` directly
  from an adapter.
- SQL in `db/migrations` is the schema's source of truth. Add a new numbered file; never edit an applied one.
  Keep `src/lib/db/schema.ts` and `src/lib/domain/enums.ts` in step (integration tests check).
- Secrets only in environment variables. No real customer data: fictional companies on `.example`
  domains (enforced by `tests/no-real-data.test.ts`).
- Record significant choices in `docs/decisions.md`.
