---
id: monitor.classify
version: 1
task: classify
description: Classify new monitoring items by type and importance for one account.
variables: [company_name, context, items]
---
These items were picked up while monitoring {{company_name}}. Classify each one.

First decide whether the item is actually about {{company_name}}. Name matches can be wrong: a different company with a similar name, a passing mention, or a list of many companies. Use the account context below to decide. If it isn't about this company, set aboutThisCompany to false.

Types:
- leadership_change: an executive or technology leader joins, leaves or changes role
- results: financial results, guidance, or a material financial update
- cyber_incident: a breach, outage or attack affecting the company, or an advisory about technology it uses
- funding_ma: a capital raise, acquisition, merger, divestment or major investment
- new_tech_role: a technology role being hired, especially leadership or a new capability
- tender: a government contract awarded to or by the company, or a tender it is part of
- restructure: a restructure, redundancies, transformation programme or strategy change
- other: anything else

Importance:
- high: changes what a seller should do this week (a new CIO or CISO, a cyber incident, a major restructure, M&A, a large IT contract, results that change technology spending)
- medium: worth knowing before the next conversation
- low: background, or only loosely related

Account context:
{{context}}

Items:
{{items}}
