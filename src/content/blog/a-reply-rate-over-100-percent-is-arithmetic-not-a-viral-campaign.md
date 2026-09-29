---
title: 'A reply rate over 100% is arithmetic, not a viral campaign'
description: 'WhatsApp status counts tallied from a vendor''s delivery log are exclusive latest-state buckets, not a running total — dividing every rate by raw sentCount produced a 177.8% reply rate and a 2,881% delivered rate in production, and the fix needed no new column, only different arithmetic.'
category: 'CRM & Revenue'
pubDate: 2026-08-20
tags: ['crm', 'revenue', 'analytics', 'data-integrity']
draft: false
---

A WhatsApp broadcast dashboard for a multi-branch aesthetic clinic chain reported a 177.8% reply rate on one campaign and a 2,881% delivered rate on one of its message templates. Nobody over-delivered anything — the raw counts were correct all along. The bug lived entirely in the division: every rate on the funnel was computed against a denominator that looked like "everyone the campaign reached" and was actually a much smaller number that happened to share a name with it.

## The status counts are exclusive buckets, not a running total

A WhatsApp Business message moves through a fixed sequence of statuses — sent, then delivered, then read — as delivery receipts arrive. The third-party WhatsApp vendor behind this funnel exposes a per-recipient broadcast log in which each row carries a single status: that recipient's latest. The sync step tallies those rows into per-status counters on every broadcast, three of which feed the funnel: `sentCount`, `deliveredCount`, `readCount`. The names read like funnel stages: how many were sent, how many were delivered, how many were read. They aren't that. Each recipient is counted exactly once, in the *furthest* status they reached — a recipient who got as far as "read" isn't also sitting in the "delivered" bucket, and isn't counted under "sent" either. `sentCount` really means "recipients stuck at sent and never progressed further," a residual.

Nothing in the schema marks that distinction. Three nullable `Int` columns, three plausible funnel-stage names, and the only place the real semantics lived was the tally loop in the sync code. The plan that specified the outcomes report, written three weeks after that loop, read the names instead: it put `replyRate = replies/sent` into the spec, and the code carried that assumption into every rate downstream.

## Dividing by a bucket instead of a total inflates every rate built on it

Every rate on the campaign funnel and the template league — delivered, read, reply, lead — used to divide by that raw `sentCount` bucket, on the assumption it was the campaign's total addressable audience. On a campaign that worked its way mostly through the funnel — most recipients reaching "delivered" or "read," only a handful stuck at "sent" — that denominator is tiny. Divide a healthy reply count by a residual bucket of a few stragglers and the percentage stops meaning anything: a 177.8% reply rate, a 2,881% delivered rate, both real numbers the fix's commit records from production.

The campaign row named in the fix's verification checklist shows the mechanism exactly. Accumulated, it should read 470 sent, 452 delivered, 204 read, which unpacks to 18 recipients stuck at sent, 248 stuck at delivered, and 204 at read. Under the old formula its 32 attributed replies divided by that 18-recipient `sentCount` bucket come to 177.8% — the reported figure to the decimal. Divided by the 204 who read, the same 32 replies are 15.7%.

The counts feeding those percentages were never wrong. `sentCount`, `deliveredCount`, and `readCount` accurately reflected the vendor's log. The bug was entirely arithmetic — a rate built on the wrong side of the fraction — which is also why the fix needed no new column, no re-sync, no schema migration. Just different math over data that was already correct.

## The fix does two things a shared denominator can't: accumulate, then divide

`computeCampaignFunnel` now sums cumulatively before any rate touches a division sign:

```ts
// Inputs are EXCLUSIVE status buckets (WhatsApp statuses progress
// sent → delivered → read; the enrich tally counts each recipient once, in
// its latest state). Outputs are cumulative: sent = everything that left
// the gateway, delivered includes read. Rates are stage-over-previous-stage
// (reply/read, lead/reply) — reply attribution is a phone-join, so a reply
// from a recipient with read receipts off can push replyRate past 100%.
const totalSent = sent + delivered + read;
const totalDelivered = delivered + read;

return {
  // ... broadcastId, replies, leads, totalCostRp, costPerReply unchanged
  sent: totalSent,
  delivered: totalDelivered,
  read,
  replyRate: read > 0 ? replies / read : 0,
  leadRate: replies > 0 ? leads / replies : 0,
  readRate: totalSent > 0 ? read / totalSent : 0,
  cpl: leads > 0 ? totalCostRp / leads : null,
};
```

Reconstructing the cumulative total — everyone who left the gateway — turns the three exclusive buckets back into the funnel their names always implied. Only then do rates divide stage-over-previous-stage: replies against read, not against the whole campaign; leads against replies, not against sent. Each of those rates answers "of the people who reached the previous stage, how many reached this one," which is the question a funnel is supposed to answer and the one the old code never actually asked.

## A reply rate over 100% survived the fix, on purpose

The fix deliberately leaves `replyRate` uncapped — an accepted choice, not a leftover bug. Reply attribution is a phone-number join against every recipient who received a blast in the 72-hour attribution window, independent of their read-receipt status — and, as the decision log records the accepted caveat, a recipient with read receipts turned off can reply without ever counting as "read" on the sending side. `replyRate = replies / read` is stage-over-previous-stage by *reported* read receipts, not by everyone who actually opened the message, so a small campaign can still legitimately clear 100%: more people replied than the read counter could see. Capping the rate at 100% would have hidden that signal behind a false ceiling instead of reporting it.

## The template league needed a different denominator, not the funnel's

`buildTemplateLeague` aggregates across broadcasts sharing a template, and its inputs include recipients the single-campaign funnel never sees: sends that failed or are still pending. Reusing the funnel's bucket-sum denominator there would silently exclude them, so it sums a separate `recipients` total instead, read from a `recipientTotal` column the sync already stored:

```ts
agg.recipients += b.recipientTotal ?? sentOnly + deliveredOnly + read;
// ...
deliveredRate: agg.recipients > 0 ? agg.delivered / agg.recipients : 0,
readRate: agg.recipients > 0 ? agg.read / agg.recipients : 0,
replyRate: agg.read > 0 ? agg.replies / agg.read : 0,
```

Delivered and read rates divide by every attempt, including the ones that never left the gateway, because a template's actual performance includes its failures. The sanity check the plan recorded was one template's 630 reads over 1,232 recipients, about 51%, and the new denominator reproduces it. Reply rate keeps dividing by read, for the same reason it does in the single-campaign funnel — it's stage over previous stage, so the league and the funnel tab agree on what a reply rate means. Three rates in the same object, two different denominators, all correct because they're answering different questions about the same template.

The counts tallied from the vendor's log were accurate on every single day this bug was live; the only thing that ever lied was the fraction built on top of them.

---

## Sources

- Meta — *Status messages webhook reference* (outgoing WhatsApp messages report `sent` when the message leaves Meta's servers, `delivered` when it reaches the user's device, `read` when it is displayed in an open chat thread, and `failed` on a send or delivery failure). Retrieved 2026-09-29. <https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/messages/status>
