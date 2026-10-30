---
id: smoke.structured
version: 1
task: smoke
description: Connectivity check for npm run llm:smoke. Structured JSON output.
variables: [company_name]
---
The following company is fictional: {{company_name}}.

Return its name exactly as written, the country you would guess from the name ("AU", "NZ" or "unknown"), and set fictional to true.
