---
title: 'A more-correct rebuild that nobody trusts is worth nothing'
description: 'A spreadsheet quietly running part of the business is a production system with real users and a proven spec. You earn the right to replace it by matching its numbers exactly — bugs included — before you change a single thing.'
category: 'CRM & Revenue'
pubDate: 2026-06-01
updatedDate: 2026-06-22
tags: ['analytics', 'data-modeling', 'crm']
draft: false
---

Every team you join has a spreadsheet quietly running part of the business — the one that calculates commissions, or forecasts pipeline, or decides which accounts get a call this week. It is not a failure of engineering. The shadow IT running your business is a signal, not a mess: a production system with real users and a spec proven by the fact that the business keeps acting on it. The mistake is treating its replacement as a build problem. It is a trust problem. The number in that sheet is correct *by definition* — it is what the business has been acting on — and your job is not to compute a better number. It is to reproduce their number exactly, bug-for-bug, before you earn the right to change anything.

## The sheet is the spec, and the bugs are requirements

Open the sheet and read it like a contract, because that is what it is. The formula in column H is the definition of "qualified pipeline" — not your definition, theirs. The manual-override column where someone types a value that wins over the formula is not sloppiness; it is a documented exception path the business relies on. The row that gets deleted every Friday is a workaround for a duplicate the upstream system creates. The rounding that drops a half-cent the "wrong" way has been baked into every payout for two years.

None of this is noise. All of it is the spec. When you rebuild and your "correct" version disagrees with the sheet, you have not fixed a bug — you have changed someone's commission, or moved an account out of a rep's territory, and you did it before anyone asked you to. The first time your system shows a number that contradicts the sheet, you are not the source of truth. You are the thing that is wrong.

So you reproduce it. Exactly. Including the override column, including the Friday delete, including the rounding. You can fix the rounding *later*, on purpose, with the finance team watching. A bug you reproduce on purpose is a known quantity; a bug you "fix" silently is a betrayal with a commit message.

## 9,998 rows agreeing is still untrusted if 2 disagree

A dashboard that matches finance on 9,998 rows and disagrees on 2 is not 99.98% trusted — it is untrusted, because now every number on it is suspect and someone has to go check the sheet anyway. Trust in a number is binary. There is no "mostly right." The moment a person finds one cell where your rebuild and their spreadsheet disagree, your system becomes the thing they reconcile *against* the sheet, which means the sheet is still the source of truth and you have shipped nothing.

This is the same principle behind [reconciling your revenue numbers to a source](/blog/reconcile-three-sources-of-truth/): a number is either trusted or it is not, and you earn trust by agreeing with the thing people already believe — not by being independently, theoretically correct. For a migration the "source" is simpler and stricter than three external systems. It is the sheet itself. You agree with the sheet, to the cent, or you have not finished.

## The parity check is how you earn the cutover

Here is the mechanic that turns "I think it matches" into a fact you can show the finance lead. Export the sheet's current values to CSV. Load that export into a staging table. Build your real datasource and its query *behind the scenes* — nobody is using it yet. Then full-outer-join the two on the business key and select only the rows that disagree. The artifact you are chasing is an empty result set. (One caveat first: a blank business key never joins to itself — `null = null` is unknown — so clean or reject blank keys before you stage, or two identical empty-key rows will haunt the diff forever.)

```sql
-- staging.sheet_export: the values people currently trust, loaded from the sheet's CSV
--   assumed grain: one row per deal_id (the business key); dedupe before loading
--   columns: deal_id, commission, stage
-- analytics.commission_v2: your new query's output, same grain, same keys

with sheet as (
    select
        deal_id,
        commission::numeric as commission,  -- numeric, not float: no representational noise to chase
        stage
    from staging.sheet_export
),
rebuild as (
    select
        deal_id,
        commission::numeric as commission,
        stage
    from analytics.commission_v2
)
select
    coalesce(s.deal_id, r.deal_id)               as deal_id,
    s.commission                                  as sheet_commission,
    r.commission                                  as rebuild_commission,
    s.stage                                       as sheet_stage,
    r.stage                                       as rebuild_stage,
    abs(coalesce(s.commission, 0)
      - coalesce(r.commission, 0))                as abs_delta,
    case
        when s.deal_id is null then 'extra_in_rebuild'     -- present in rebuild, absent from sheet: you invented a row
        when r.deal_id is null then 'missing_in_rebuild'   -- present in sheet, dropped by rebuild: the sheet has a row you lost
        else 'value_mismatch'                              -- same key, different number
    end                                           as diff_type
from sheet s
full outer join rebuild r
    on s.deal_id = r.deal_id
where
    s.deal_id is null                                       -- only in sheet
    or r.deal_id is null                                    -- only in rebuild
    or abs(coalesce(s.commission, 0)
         - coalesce(r.commission, 0)) > 0.005               -- sub-half-cent noise passes; any real cent-level error is caught
    or s.stage is distinct from r.stage                     -- null-safe text compare
order by abs_delta desc, diff_type, deal_id;                -- worst-first: chase the biggest gaps before the rounding dust
```

Three things make this real and not a toy. The `full outer join` catches all three failure classes — rows you dropped, rows you invented, and rows whose values disagree — because a left or inner join would silently hide the first two. And `is distinct from` compares the text columns null-safely, so a `null` stage on one side and a real value on the other shows up as a diff instead of vanishing the way `=` would. The `abs(...) > 0.005` tolerance lets sub-half-cent float noise pass while catching any real cent-level error — and because the column is `numeric` rather than `float8`, you keep the comparison on the raw values instead of pre-rounding them into a phantom mismatch. You set that tolerance *explicitly* with finance, rather than letting it be an accident of your data types.

Worst-first ordering is not cosmetic. A `value_mismatch` at the cents level is float rounding you can wave through; the same diff_type at the thousands level is a rule you have not reproduced yet. Read every row the query returns. Each one is either a bug in your rebuild or a bug in the sheet you did not know about — and you do not get to assume which. You investigate until the result set is empty, or until the only remaining diffs are ones finance has explicitly signed off as "the sheet was wrong, fix it."

Zero diff is not the end of the work. It is the permission slip to start it. So you keep the query in CI and run it nightly against a fresh export, where it stays green for as long as the two agree. The day it goes red after being green is the day someone changed the sheet — and now you find out the same hour, instead of in a quarterly review.

## Keep the interface they trust; swap it last

Parity buys you the right to change the *engine*, not the *dashboard*. So don't. Move the logic into the datasource first, prove zero diff, and keep the sheet itself — same column names, same order, same layout — as the interface, now populated by the new pipeline instead of by hand. People keep opening the file they have opened every morning for two years; they just stop pasting in numbers, because the numbers are already there and already correct.

This is the strangler-fig pattern, and the order is the whole point. Logic first, parity second, interface last. When you finally do move them to a real dashboard, the tiles should still map to the decisions the sheet was driving — the same columns people acted on, now faster — rather than to whatever looks impressive. Familiarity first, features second. Nobody mourns a spreadsheet that was replaced one trustworthy column at a time.

## Shadow IT is a roadmap, not a mess

Step back and notice what a heavily-used spreadsheet actually is: proven demand and a proven spec, with the users already in the room. Most new internal tools fail because nobody is sure anyone wants them. This one has a proven user — the person who has kept the sheet alive — and a requirements document written in formulas. That demonstrated demand is what makes it the *safest* internal tool you can build, not the embarrassing thing to stamp out.

So stop treating the sheet as technical debt to be deleted and start treating it as a shipped, validated product to be promoted. Find the sheets quietly running the business, reproduce their numbers to zero diff, and put a real engine under the columns people already trust.

The spreadsheet was never the problem. It was the spec you hadn't read yet.
