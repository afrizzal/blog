---
title: 'The index that made the query slower'
description: 'Every index is a bet placed on the planner''s behalf, and the house edge is not free. A Monday pipeline report that got slower after a "fix" — and why the cure was DROP INDEX.'
category: 'Systems & Performance'
pubDate: 2026-06-22
tags: ['database', 'performance', 'postgres']
draft: true
---

Every index is a bet you place on the query planner's behalf, and the house edge is not free. Here is a Monday pipeline report that got slower after a "fix" — and why the cure was `DROP INDEX`.

## The Monday report that got slower

A B2B distributor ran a pipeline-review report every Monday morning. Sales leadership opened it right before the weekly forecast meeting, so its latency had a business cadence: nobody noticed on Wednesday, everybody noticed at 8:55am Monday. It pulled open deals from a few hundred thousand rows, filtered by stage and owner, joined to accounts, and rolled up expected value by region.

It had crept from snappy to sluggish — a few seconds, enough that the meeting opened with someone watching a spinner. The naive instinct, and I had it too, was the obvious one: it's slow, it filters on `stage` and `owner_id`, so add a composite index on those columns and move on.

So we did. And the report got *slower* — not dramatically, but measurably and repeatably. That is the moment worth stopping for. When a textbook fix moves the needle the wrong way, the mental model is wrong, not the effort.

## Read the plan, not your assumptions

An index doesn't make a query fast. It hands the planner a new option, and the planner picks whatever it *estimates* is cheapest. If the estimates are off, the new option can be a worse option that merely looks better on paper.

That is exactly what happened. With the composite index in place, the planner abandoned a perfectly good bitmap scan and switched to a nested loop driven by the new index — because it estimated the filter would return a handful of rows. In reality the active stages covered most of the open pipeline, so "a handful" was thousands. The numbers below are illustrative, but the shape is real.

**With the new index (the regression):**

```text
Nested Loop  (cost=0.42..18450 rows=12 width=86)
             (actual time=0.18..2240 ms rows=8900 loops=1)
  ->  Index Scan using deals_stage_owner_idx on deals
            (cost=0.42..980 rows=12 width=40)
            (actual time=0.05..58 ms rows=8900 loops=1)
            Index Cond: (stage = ANY ('{negotiation,proposal}') AND owner_id = 7)
  ->  Index Scan using accounts_pkey on accounts
            (cost=0.29..1.4 rows=1 width=54)
            (actual time=0.22..0.24 ms rows=1 loops=8900)
Planning Time: 0.6 ms
Execution Time: 2310 ms
```

The load-bearing line is `rows=12` estimated versus `rows=8900` actual on the deals scan. The planner thought it was looping a dozen times; it looped nearly nine thousand — `loops=8900` on the inner node — doing a fresh `accounts` lookup each pass. A nested loop is cheap when the outer side is tiny and a disaster when it isn't. The estimate made a disaster look cheap, so the planner chose it on purpose.

Two lessons hide in that one mismatch. First, when estimated and actual rows diverge by two or three orders of magnitude, the planner is flying blind — usually stale statistics or a correlation it can't model. Here `stage` and `owner_id` aren't independent: this owner lives in those stages, so the planner multiplied two selectivities as if they were unrelated and got a number far too small. Second, the cost figure is fiction built on top of that estimate. Trust the *actual* time and *actual* row counts, not the tidy cost number and not your intuition about which columns "should" be indexed.

## Sometimes the fix is DROP INDEX

Once you can see the plan, the fix writes itself. The old bitmap path was already healthy; the new index just tempted the planner off it. So:

```sql
DROP INDEX deals_stage_owner_idx;
```

**After dropping it:**

```text
Hash Join  (cost=3650..4900 rows=8700 width=86)
           (actual time=255..300 ms rows=8900 loops=1)
  Hash Cond: (deals.account_id = accounts.id)
  ->  Bitmap Heap Scan on deals
            (cost=210..3400 rows=8700 width=40)
            (actual time=12..240 ms rows=8900 loops=1)
        Recheck Cond: (owner_id = 7)
        Filter: (stage = ANY ('{negotiation,proposal}'))
        ->  Bitmap Index Scan on deals_owner_idx
                  (cost=0..208 rows=9100 width=0)
                  (actual time=9..9 ms rows=9100 loops=1)
  ->  Hash  (cost=...)
        ->  Seq Scan on accounts  (actual time=0.01..6 ms rows=1200 loops=1)
Planning Time: 0.4 ms
Execution Time: 300 ms
```

Same query, no new index, ~7x faster. Look at what changed: the estimate (`rows=8700`) now lands next to actual (`rows=8900`), and with an honest cardinality the planner makes two better decisions at once. It grabs the matching deals in bulk via the bitmap scan, then builds the accounts side into a hash table and joins once — instead of re-probing `accounts` nine thousand times. The bad estimate hadn't just picked a worse scan; it had picked a worse *join*. Fix the number and both decisions correct themselves.

That is the real lesson, and it's why the title is a little glib on purpose. The point isn't that composite indexes are bad. It's that an index is a bet, and the house edge isn't free: every index taxes every `INSERT`, `UPDATE`, and `DELETE` on that table — a write cost paid forever to speed up one read path you assumed was hot. On a deals table that churns all day, an index that only confuses the planner is pure overhead in both directions.

`DROP INDEX` was the right call *here* because the bitmap path was already good and the index added nothing but temptation. The more general lever sits one level up: the estimates. Before adding an index, run `EXPLAIN ANALYZE` and read estimated-vs-actual rows on every node. If they match, the planner already understands your data and a new index probably won't help. If they don't, fix the estimates first — `ANALYZE` the table, and for correlated columns reach for extended statistics:

```sql
CREATE STATISTICS deals_stage_owner (dependencies)
  ON stage, owner_id FROM deals;
ANALYZE deals;
```

That teaches the planner the two columns travel together, so its row estimate stops collapsing to a dozen. An index built on top of bad estimates just hands a confused planner a new way to be wrong.

The Monday report is quick again. We didn't buy a bigger box, and in the end we didn't add an index — we deleted one.

Start with the plan, not the index.
