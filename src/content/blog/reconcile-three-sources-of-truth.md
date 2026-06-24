---
title: 'Reconcile your revenue numbers, or executives stop trusting the dashboard'
description: 'Three systems each believe they own revenue — the ad platform, the CRM, and the finance ledger — and they never agree by default. Run a nightly reconciliation that joins them on a common key, anchors to the ledger, and pages you when a delta crosses a threshold, so you find the divergence before an executive does.'
category: 'CRM & Revenue'
pubDate: 2026-06-22
tags: ['revenue', 'reconciliation', 'data-integrity']
draft: true
---

Three systems each believe they own revenue — the ad platform, the CRM, and the finance
ledger — and they never agree by default. Treat the gap between them as an SLA on trust, not a
report: run a nightly job that joins all three on a common key and pages *you* the moment a delta
crosses a threshold, so you find the divergence before an executive does.

## A dashboard's trust is binary, and you only get to lose it once

An executive killed a dashboard in a single meeting, with one sentence: "this doesn't match
finance." Not "the methodology is wrong," not "the query has a bug" — just that the number on the
screen and the number in the books disagreed by a few percent. The room moved on. He never opened
it again, and neither did anyone who watched him close the tab.

That is the whole stakes. Trust in a number is binary. It survives until the first time it's caught
disagreeing with the books, and then it's dead — not degraded, dead — because once someone has seen
the dashboard be wrong, they discount every number on it. A more-correct dashboard that nobody
trusts is worth nothing. You weren't shipping a chart; you were shipping a claim, and the claim got
falsified in public.

The fix is not a better chart. It's to make the disagreement *your* alert instead of an
executive's discovery — surfacing in your inbox at 6 a.m. with a period and a channel attached, not
in a quarterly review with a CFO reading off a different page.

## The three systems disagree by construction, not by bug

It is tempting to treat divergence as a defect to eliminate. It isn't. The three sources measure
different things, on different clocks, with different definitions of "happened" — and each is
*correct* about its own question:

- **The ad platform** reports spend and platform-attributed conversions. It counts a sale the
  moment its pixel fires, inside its own attribution window, often before money moves at all.
- **The CRM** reports pipeline and closed-won — the sales view. A deal is "revenue" when a rep
  marks the stage, which can be days before the invoice and may include deals that never get paid.
- **The finance ledger** reports recognized, collected revenue. This is the number that is legally
  true, the one tied to the bank. It lags everything and reverses on refunds.

So you don't reconcile to make them equal. You reconcile to *quantify the gap and explain it*, and
you anchor every comparison to the ledger — the only source that has to defend itself to an auditor.
The other two are leading indicators of a number finance hasn't booked yet.

## Reconciliation is a join problem before it is an alerting problem

Get the join right and the alert is a `where` clause. Normalize each source into the same grain —
`(period, channel)` — then full-outer-join them so a row that exists in one source and not another
still appears. A missing row is the most interesting row you have; an inner join would hide exactly
the divergence you're hunting.

```sql
-- each source pre-aggregated to the common grain: (period, channel)
-- the nightly job runs with: set time zone 'UTC';  so every date_trunc lands on the same clock
with ad as (
  select date_trunc('day', spend_at at time zone 'UTC') as period,
         coalesce(channel, 'unattributed')              as channel,
         sum(platform_revenue)                          as ad_revenue
  from ad_platform_facts
  group by 1, 2
),
crm as (
  select date_trunc('day', closed_at at time zone 'UTC') as period,
         coalesce(channel, 'unattributed')               as channel,
         sum(amount)                                      as crm_revenue
  from crm_deals
  where stage = 'closed_won'
    and not coalesce(is_test, false)   -- nullable flag: an unset is_test must NOT drop the deal
  group by 1, 2
),
ledger as (
  select date_trunc('day', recognized_at at time zone 'UTC') as period,
         coalesce(channel, 'unattributed')                   as channel,
         sum(amount_recognized)                              as ledger_revenue  -- net of refunds (see below)
  from gl_revenue
  group by 1, 2
),
-- the spine: every (period, channel) that appears in ANY source
keys as (
  select period, channel from ad
  union select period, channel from crm
  union select period, channel from ledger
)
select
  k.period,
  k.channel,
  coalesce(a.ad_revenue,     0) as ad_revenue,
  coalesce(c.crm_revenue,    0) as crm_revenue,
  coalesce(l.ledger_revenue, 0) as ledger_revenue,
  coalesce(c.crm_revenue, 0) - coalesce(l.ledger_revenue, 0)        as crm_minus_ledger,
  coalesce(a.ad_revenue,  0) - coalesce(l.ledger_revenue, 0)        as ad_minus_ledger
from keys k
left join ad     a on a.period = k.period and a.channel = k.channel
left join crm    c on c.period = k.period and c.channel = k.channel
left join ledger l on l.period = k.period and l.channel = k.channel
order by abs(coalesce(c.crm_revenue, 0) - coalesce(l.ledger_revenue, 0)) desc;
```

The `keys` CTE is the part people skip and then regret. Building the spine from a `union` of all
three sources means a channel the ad platform reported but finance never recognized still produces a
row — with `ledger_revenue = 0` and a delta that screams. That row is the find. Coalescing nulls to
zero at the *edges* keeps the arithmetic honest: absence becomes zero revenue, which is what it
means, instead of a `null` that quietly poisons every subtraction. Coalescing a null channel to
`'unattributed'` does the same job for the spine — an unknown channel stays a visible bucket worth
reconciling, instead of falling out of the join entirely.

## A delta that drifts in silence is the one that kills you

The query above is diagnostic. The SLA is the part that runs without you watching. Wrap the
reconciliation in a check that fires when a delta crosses a threshold — and use *both* a relative
percentage and an absolute floor, because either one alone lies:

```sql
-- the nightly alert: flag (period, channel) rows where CRM and ledger have drifted apart.
-- assumes the block-1 select is materialized:  create view revenue_recon as <block 1>;
select
  period,
  channel,
  crm_revenue,
  ledger_revenue,
  crm_minus_ledger,
  round(crm_minus_ledger / nullif(ledger_revenue, 0) * 100, 1) as drift_pct
from revenue_recon
where abs(crm_minus_ledger) > 500                                -- absolute floor: ignore noise (500 in your currency)
  and (
        ledger_revenue = 0                                       -- revenue claimed where none settled: the scariest row
     or abs(crm_minus_ledger) / nullif(ledger_revenue, 0) > 0.02 -- relative drift: >2% of the books
  )
order by abs(crm_minus_ledger) desc;
```

Relative-only breaks on small denominators: a channel that recognized almost nothing shows 1,000%
drift over a rounding error and pages you nightly until you mute it — and a muted alert is a
disabled alert. Absolute-only breaks at scale: a 0.3% gap on your largest channel is real money,
but never trips a flat dollar threshold sized for the long tail. Requiring material-in-dollars
**and** the OR-guarded fraction is what separates a signal you act on from a pager everyone learns
to ignore. The `ledger_revenue = 0` branch earns its own line: it catches the scariest shape — a
channel claiming revenue the bank never saw — which the relative test alone would silence, because
dividing by `nullif(ledger_revenue, 0)` returns `null` and a `null` comparison fails a `where`
clause. The `nullif` guard is still doing work: it stops the query from aborting on division by
zero. The absolute floor, now OR-combined, is what actually surfaces the ledger-is-zero row.

## The three gotchas that make every delta look worse than it is

Most alerts that fire are not fraud or pipeline bugs. They are timing and definition. Name them, or
you'll spend every morning rediscovering them:

- **Period-boundary skew.** A deal closed at 23:59 local time lands on the *next* day in UTC. Join
  on mismatched time zones and a chunk of revenue teleports one period forward, lighting up two
  adjacent days at once. Pick one clock — UTC at the ledger, always — and `date_trunc(... at time
  zone 'UTC')` every source into it before the join (run the job with `set time zone 'UTC'` so
  bare truncations agree too). The skew doesn't vanish, but it stops being invisible.
- **Refunds and clawbacks.** Finance reverses recognized revenue *after the fact*; the ad platform
  and CRM rarely walk their numbers back. Recognize the ledger net of reversals (the `amount_recognized`
  comment above) and a refunded sale shrinks the ledger side on the day it's clawed back — exactly
  when CRM and ledger *should* diverge, and exactly what the alert should surface, not smooth over.
- **Test, duplicate, and internal rows.** A QA deal, a double-fired pixel, or an internal "customer"
  inflates one source and nothing else. The `not coalesce(is_test, false)` filter handles the test
  rows; the deeper fix is upstream — dedupe ingestion on a business key so the same real-world event
  can't become two rows in the first place. And when you still have to reconstruct which channel
  earned a deal, it is far easier when identity is an event log you can replay than a mutable row
  you've already overwritten: the ledger anchors the *amount*,
  [store identity as an append-only event log](/blog/crm-identity-append-only-event/) anchors *which
  channel* earned it.

In all three cases the move is the same: the ledger is the anchor. CRM and ad are leading
indicators, allowed to run ahead. When they disagree with the books, the books win, and the delta
measures *how far ahead the optimism ran* — not an error to suppress.

## Reconciliation is a contract, not a chart

Schedule the alert nightly, route it to Slack with the period and channel inline, and treat a fired
alert like a failing healthcheck: someone looks before the next business day. What you've built
isn't a report — it's an SLA that says *the dashboard's number will never be caught disagreeing with
finance by more than a known tolerance, and if it drifts, we know first.* So when an executive asks
"does this match finance," the answer is no longer a flinch — it's "reconciled to the ledger last
night, within 2%, and here's the one channel that's off, and why." That sentence is the entire
reason the executive keeps the tab open. The chart was never the product. The defensibility was.

Reconcile the number before the meeting, and the meeting is about the business, not the dashboard.
