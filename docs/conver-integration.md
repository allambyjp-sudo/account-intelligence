# Conver integration (Phase 7)

The app reaches models only through `LLMProvider` (`src/lib/llm/types.ts`). Moving from Claude to
Datacom's Conver platform means implementing one class, `ConverProvider` (`src/lib/llm/conver.ts`),
and setting `LLM_PROVIDER=conver`. No other code changes.

## Questions for the Conver team

Bring these to the first conversation. The answers decide how much of the app keeps working
unchanged.

1. **API.** Is there a programmatic API (REST or SDK), or only a chat interface? What does
   a request look like: messages, system prompt, max tokens?
2. **Authentication.** API key, Entra service principal, or managed identity? Managed
   identity is best when hosted in Datacom's tenant.
3. **Models.** Which models sit behind it, and is the model reported per response? The app
   records the serving model on everything it generates.
4. **Structured output.** Can it force output to match a JSON schema? If not, the provider
   can ask for JSON in the prompt and validate it with Zod, at some cost in reliability.
5. **Web search.** Does it have one? If not, set `capabilities.webSearch = false`. Research
   then relies on the source adapters alone, which already do most of the work.
6. **Embeddings.** Does it offer an embeddings endpoint? If so, add a `ConverEmbeddingProvider`
   too, so account memory stays inside Datacom as well.
7. **Data approvals.** Is it approved to process (a) public research about customers,
   (b) seller notes about customers, (c) customer email? Where is data processed and stored
   (region), and for how long is it retained? Section 4.8 of the brief makes mailbox approval
   the gate for connecting real email.
8. **Limits.** Rate limits, context window, maximum output length, and cost allocation.

## Implementing the provider

The contract (all in `src/lib/llm/types.ts`):

- `generate(req)` returns `{ text, citations, usage, provenance }`. Citations are only
  needed if Conver has web search.
- `generateStructured(req)` returns `{ data, usage, provenance }`, where `data` has passed
  `req.schema.safeParse()`. Throw `LLMOutputError` with the raw text when it hasn't.
- Throw `LLMRefusalError` when the model declines and `LLMOutputError` on truncation. Never
  return partial output as if it were complete.
- `req.task` picks the model and effort; map it to Conver's equivalents in one table, as
  `src/lib/llm/tasks.ts` does for Claude.
- Put `provenance.model` = the model that actually answered.

Copy the shape of `tests/llm-provider.test.ts`: a fake HTTP client, then request-shaping,
refusal, truncation and schema-failure tests. Then:

```bash
LLM_PROVIDER=conver CONVER_BASE_URL=... CONVER_API_KEY=... npm run llm:smoke
```

Re-run research on a known account and compare the brief side by side with Claude's version. The
prompts may need tuning for a different model; bump their versions when you change them.

## Switching over

1. Deploy with `LLM_PROVIDER=conver`, and the embeddings provider too if Conver has one.
2. The worker re-embeds memory for the new model by itself (vectors are keyed by model).
3. Once IT has approved mailbox processing, set `MAILBOX_CONNECT_APPROVED=true`. The app then
   allows Outlook connections, because `LLM_PROVIDER=conver`.
