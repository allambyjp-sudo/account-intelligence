# Prompts

Every LLM prompt the app sends lives here, one Markdown file per prompt, so they can be versioned,
reviewed and tuned without code changes.

## Format

```markdown
---
id: research.profile          # must match the path: prompts/research/profile.md
version: 1                    # bump when the wording changes what the model produces
task: research                # picks the model, effort and output budget (src/lib/llm/tasks.ts)
description: One line on what this prompt is for.
variables: [company_name]     # every {{placeholder}} the body uses, and nothing else
---
The prompt body. Use {{company_name}} placeholders.
```

## Rules

- **Bump `version` on any change that alters output.** Generated rows (brief sections,
  recommendations, summaries) store `prompt_id` and `prompt_version`, so you can see which wording
  produced what, and re-run stale ones.
- **Undeclared or unused variables fail the tests.** So does a missing variable at render time.
  Nothing renders silently blank.
- **Keep volatile content out of system prompts.** Dates, IDs and account data go in the user
  message, so the system prompt stays byte-identical and prompt caching keeps working.
- **No real customer data in examples.** Use fictional companies on `.example` domains.

`system.base` is the shared system prompt: the citation, confidence and contact rules from the
brief. Task prompts build on it rather than restating it.
