---
title: 'Marketing wants a real-time revenue dashboard. Translate that before you build it.'
description: '"We need a real-time revenue dashboard" is solution-language, not a requirement: someone has a decision to make and pre-filled the implementation. Translate the guess back into the decision it serves — its freshness, its grain, the action it changes, and what real-time actually costs — and you usually ship something cheaper that people actually open.'
category: 'Engineering Leadership'
pubDate: 2026-06-22
tags: ['analytics', 'leadership', 'product-sense']
draft: true
---

"We need a real-time revenue dashboard" is not a requirement. It is a guess at one. Someone has a real decision to make and has already pre-filled the implementation field — and the worst thing you can do is open a Jira ticket and build exactly that. The sentence is solution-language. Your job is not to gatekeep the guess; it is to translate it back into the decision it serves. That translation is four questions you can answer in an afternoon: how fresh the number has to be, what it counts, which action it changes, and what real-time actually costs. The questions are the deliverable. They save the team the weeks it takes to build the wrong thing and find out at launch.

## "Real-time" is an adjective; the decision wants a number

Start with the one word doing the most work. "Real-time" almost never survives contact with the actual decision. The question that replaces it: at what staleness does the action change? If a marketer would do precisely the same thing whether the number is two minutes old or two hours old, you do not need real-time. You need *fresh by the time they look* — a number that's, say, no more than 15 minutes behind when someone opens the tab to watch an intraday launch.

The honest answer is almost always measured in minutes-to-hours, not seconds, and the right number depends entirely on the cadence of the decision. A budget-pacing call made once at 9 a.m. needs this-morning's data — last night's batch, fresh by the time anyone logs in, is already enough. A weekly budget reallocation is fine with yesterday. A live fraud cutoff genuinely needs seconds. Most revenue dashboards live in the first world and get speced as if they live in the third. So pin the freshness the decision demands, not the adjective in the ask. *Fresh by the time they look* is a freshness target you can build in days. *Real-time* is a procurement decision dressed up as a verb.

## "Revenue" is unbuildable; "recognized revenue per channel per day" is a spec

The second question is the one the ask almost always omits, and it's the one that defines the entire data model: revenue by *what*?

Revenue, unqualified, cannot be built. There is no table called revenue. There is revenue per campaign, per channel, per region, per cohort, per day, per hour — and each of those is a different shape of pipeline, a different join, a different storage cost. Grain is not a detail you settle later; it is the spec. It is also load-bearing precisely because it does not retrofit: a daily number cannot answer an hourly question, and a per-account number cannot be un-mixed back into per-channel after the fact. Pick the grain too coarse and the dashboard is silently useless for half its intended decisions, and you only learn which half once someone asks the question it can't answer.

So you push, gently and specifically. Recognized revenue or bookings? Per channel, or per campaign inside a channel? Daily, or do they genuinely need the intraday curve? "Recognized revenue per channel per day" is something an engineer can estimate, build, and test. "A revenue dashboard" is something three people will define three different ways in the first week — and you'll discover the disagreement only after you've built one of the three.

## A dashboard exists to change an action — name two or three

Now the question that decides whether the thing should exist at all. A dashboard is not a place numbers go to be looked at. It is an instrument for changing a decision. So: what will someone do *differently* because of this number?

Name the decisions out loud — two or three, concretely. *We watch blended CAC by channel so we can shift next week's budget away from the channel that's drifting up.* *We watch day-one revenue against the launch forecast so we know by noon whether to escalate.* If you can name them, you have a spec for exactly which tiles earn their place. If you cannot — if the honest answer is "we just want visibility" — you are about to build wall decoration, and wall decoration is expensive to maintain and embarrassing to delete.

Here a careful requester pushes back, and they're right to: *monitoring is a real reason; not everything is a one-click action.* Agreed — with one bar. Monitoring counts as a decision only when it has an owner, a trigger, and a defined next step. "Alert when CAC crosses $120, and Sam pauses the campaign" clears the bar. So does a diagnostic surface where the trigger is a shape rather than a fixed line — "when the curve deviates from what we expect, Sam looks and decides whether to investigate" — as long as someone owns the look and the next step is named. What fails is the unowned number with no defined response: "we'd like to keep an eye on revenue" has no owner, no trigger, and no next step, and a number you keep an eye on but never act on is a screensaver. The bar isn't "must be clickable." The bar is "someone, by name, does something specific when it moves." Apply it and most vanity tiles fail honestly, while the genuinely useful monitor sails through.

## The streaming bill is the stakeholder's to pay, so show it

You've now narrowed the ask from an adjective to a freshness window, a grain, and a short list of decisions. Only now does cost belong on the table — because the stakeholder should choose real-time, if they choose it, with eyes open.

Lay out the price in plain terms. Scheduled batch is a job that re-runs one query on a timer; it is cheap to stand up and cheap to own. Streaming is always-on infrastructure with always-on failure modes — the kind that pages an engineer at 2 a.m. when the stream backs up. Streaming is typically an order of magnitude more expensive to *own* than scheduled batch, and the gap is dominated by the always-on ops and the correctness work — handling late and out-of-order events, exactly-once counting — not by the compute. The infra line item alone is real but modest; the bill is mostly engineering and operations time.

Then the quieter, larger cost: reconciliation. A live number drifts from the one finance closes the books with. And staleness alone does not fix this — a slow dashboard can be just as unreconciled as a fast one. Batch reconciles not because it's slow but because a scheduled job can *wait* for late and adjusting entries to settle and then read the same source of record finance reads; a live stream has to publish its number before those entries land. A figure you can't reconcile to the books is a figure nobody trusts — and the first time the dashboard and the monthly close disagree, you're in a meeting about why, and trust in the dashboard quietly drains.

So lay the two options side by side. Truly live and unreconcilable, or [reconciled to the same source finance uses](/blog/reconcile-three-sources-of-truth/) and fresh enough for every decision you just named. Fresh enough and reconciled beats truly live and unreconcilable — present it as a genuine choice, not a verdict you've pre-decided. Once the stakeholder sees the bill, they pick fresh-enough almost every time. They were never attached to milliseconds. They were attached to making a good call, and "real-time" was their honest guess at what that required.

## The same lens deletes dashboards as fast as it builds them

This is not only a build-time tool. Point the same question at what you already run and it becomes an audit. Walk an existing dashboard tile by tile and ask of each: what action does this change, and who takes it? Most won't survive. The tiles nobody acts on aren't neutral — they dilute attention away from the tiles that matter, and every stale or contradictory number on the board erodes trust in the ones beside it. One tile that's quietly wrong makes people doubt the four that are right.

So delete the tiles nobody acts on. Four tiles, each wired to a named action and an owner, are worth more than thirty tiles wired to nothing — and it isn't close. Fewer, sharper. A dashboard you trust enough to act on beats a dashboard that shows everything and decides nothing.

## A dashboard is a decision wearing a chart

Freshness, grain, the named decisions, the real cost, the delete pass — these aren't five tricks. They're one discipline: design the measurement around the decision, and translate solution-language into decision-language before you build. "Real-time revenue dashboard" is what the ask sounds like; "recognized revenue per channel, refreshed every 15 minutes, reconciled to finance, so Sam can reallocate budget Monday" is what it means. The afternoon you spend on the four questions is set against real weeks: the streaming infrastructure and on-call you'd otherwise stand up, the rebuild when the unspecced grain gets defined three ways and the gap surfaces only at launch, and the reconciliation meeting that follows the first mismatch with finance. You are not refusing the request. You are handing the requester the thing they actually came for.

Build what they typed and you spend weeks; translate what they meant and you spend an afternoon.
