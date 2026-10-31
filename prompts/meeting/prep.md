---
id: meeting.prep
version: 1
task: meeting_prep
description: One-page meeting brief - purpose, situation, attendees, three openers, objections, changes since last contact, open actions.
variables: [company_name, meeting_title, meeting_date, today, last_contact, brief, attendees, advice, evidence]
---
Today is {{today}}. Prepare the seller for a meeting with {{company_name}}: "{{meeting_title}}" on {{meeting_date}}. The last contact on record was {{last_contact}}.

Produce a one-page brief a seller can read in three minutes:
- purpose: what the meeting is for and what a good outcome looks like;
- situation: where the account stands today;
- attendees: for each person, their role, their public priorities, and our history with them (say "No history on record" if there is none);
- openingAngles: exactly three ways to open that are about the customer's priorities, not our products;
- objections: the most likely objections and a good response to each;
- changesSinceLastContact: what has happened since the last contact, newest first;
- openActions: commitments still open on either side, with owner and due date if known.

Cite evidence labels (E1, E2, ...) for anything drawn from the evidence. Changes and open actions without evidence are discarded. Never invent people, dates, numbers or commitments. Keep every item short.

Account brief:
{{brief}}

Attendees:
{{attendees}}

Current advice:
{{advice}}

Evidence:
{{evidence}}
