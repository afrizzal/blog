---
title: 'Stop overwriting your leads: store identity as an append-only event log'
description: 'The moment you UPDATE a mutable contact row, you destroy the attribution history finance will later ask you to defend. Model identity as an append-only event log and the current contact becomes a projection you compute, not a truth you overwrite.'
category: 'CRM & Revenue'
pubDate: 2026-06-22
tags: ['crm', 'attribution', 'data-modeling']
draft: true
---

The moment you `UPDATE` a mutable contact row, you destroy the attribution history finance
will later ask you to defend. Model identity as an append-only event log instead, and the
"current contact" becomes a projection you compute — not a source of truth you keep clobbering.

## The row you overwrite is the evidence you destroy

A lead arrives through a paid search ad. Ingestion writes a contact row and stamps it with
`utm_source=google`, `utm_medium=cpc`, and a click ID. Marketing is happy: a paid lead exists.

Weeks later the same person comes back — this time through an organic post or a direct visit —
and submits a form again. The CRM matches them by email and does the obvious thing: it updates
the existing row with the new UTMs. The paid attribution is gone. Not archived, not versioned.
Overwritten.

Now run the quarterly attribution report. Marketing spent budget to acquire that lead and
counts it as paid. Finance queries the CRM, sees `utm_source=organic`, and counts it as free.
Both are reading the same record and reaching opposite conclusions, and neither can prove the
other wrong — because the proof was overwritten by the last form submission.

You can't argue your way out of that. Multiply it across thousands of returning leads and your
channel ROI report is fiction with good formatting.

## Append, never overwrite

Stop treating identity as a single mutable row. Every touch is a fact that happened at a point
in time, and facts don't change — so you never update them, you only append new ones. The
contact "record" stops being a row you edit and becomes a stream of events you add to.

```sql
create table identity_events (
  event_id     bigint      generated always as identity primary key,
  lead_id      uuid        not null,                       -- stable internal identity
  event_type   text        not null,                       -- 'form_submit', 'ad_click', 'page_view'
  utm_source   text,
  utm_medium   text,
  utm_campaign text,
  click_id     text,                                       -- gclid / fbclid / msclkid
  occurred_at  timestamptz not null,                       -- when it happened (the business clock)
  ingested_at  timestamptz not null default now(),         -- when we learned about it
  source_key   text        not null,                       -- business key for idempotent ingestion
  unique (source_key)
);

create index on identity_events (lead_id, occurred_at);
```

Two columns earn their place. `occurred_at` is when the touch actually happened; `ingested_at`
is when your pipeline recorded it. They drift apart constantly — a webhook retries, a batch job
runs late, an offline conversion uploads a day after the fact. Keep both, because they answer
two different questions: *when did this happen* and *when did we know*. Collapse them into one
and you lose the ability to ask either cleanly.

`source_key` is the seatbelt. Webhooks fire twice, queues redeliver, a backfill reruns. Make
the key a stable identifier for the underlying event — say `form:{form_id}:{submission_id}` —
and let the unique constraint absorb the duplicate. Dedupe on the business event, not on row
identity, so the same real-world touch can never become two rows. (That's idempotent ingestion,
which earns its own post.)

## The current view is just a projection

Once the log is immutable, "who is this lead and where did they come from" stops being a stored
fact and becomes a query. First-touch versus last-touch is no longer a destructive write you
committed months ago — it's an `ORDER BY` direction you choose at read time.

```sql
-- First-touch: earliest attributed event per lead
select distinct on (lead_id)
  lead_id, utm_source, utm_medium, utm_campaign, click_id, occurred_at
from identity_events
where utm_source is not null
order by lead_id, occurred_at asc;

-- Last-touch: same untouched log, opposite direction
select distinct on (lead_id)
  lead_id, utm_source, utm_medium, utm_campaign, click_id, occurred_at
from identity_events
where utm_source is not null
order by lead_id, occurred_at desc;
```

Same table, same rows, zero writes between them. The paid ad click and the later organic visit
both still exist, so first-touch reports paid and last-touch reports organic — and both are
correct, because they answer different questions against the same evidence.

This is the part that changes the conversation with finance. When marketing standardizes on a
new attribution model next quarter, you don't migrate data or apologize for history you can't
reconstruct. You write a new projection and re-derive every past period from the log that was
there all along.

And here's where the two timestamps pay off. There are two honest versions of "as of last
quarter," and you can answer either:

```sql
-- What was true by the end of Q1 (business reality, including events ingested late)
... where occurred_at <= '2026-03-31'

-- What we knew on the day we closed the Q1 books (the report finance actually filed)
... where ingested_at <= '2026-03-31'
```

If you only carry `occurred_at`, you can never reproduce the number finance already reported,
because a late-arriving offline conversion silently rewrites the past. Filtering by
`ingested_at` reconstructs exactly what the system knew when the books closed — and being able
to defend *the number you filed*, not just *the number that's true now*, is the difference
between a finance meeting and an audit.

The mutable contact row still exists, by the way — as a cached projection for the UI, rebuilt
from the log. It's a convenience, not the canon. When it and the events disagree, the events
win, because they're the ones that actually happened.

Overwrite the row and you're arguing from memory; append the event and you're arguing from
evidence.
