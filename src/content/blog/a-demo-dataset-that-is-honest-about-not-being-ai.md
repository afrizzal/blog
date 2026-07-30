---
title: 'A demo dataset that is honest about not being AI'
description: 'Pre-computed triage, audit, and CSAT rows can make a demo look alive without a single LLM call — but only if every artifact admits it is a demo, and the honesty flags that say AI is off stay truthful instead of getting faked green for the tour.'
category: 'AI & Automation'
pubDate: 2026-08-17
tags: ['ai-automation', 'testing', 'data-integrity', 'architecture']
draft: true
---

A demo dataset for an AI product has an obvious shortcut and an obvious trap. The shortcut is to fake the AI output — write plausible triage labels and drafted replies straight into the database, skip the LLM calls, and the demo looks alive in seconds. The trap is that "plausible" is a low bar for a reviewer clicking through a self-hosted tour, and a high bar for the product's own honesty rules. AIDA, a self-hosted AI-native helpdesk, ships exactly this shortcut — `seedDemoData()` writes triage results, an audit trail, CSAT responses, and AIDA Insight runs with zero LLM configured — and the interesting engineering is in what the seed refuses to fake along the way.

## Every generated artifact carries proof it isn't real

The simplest way a demo dataset lies is by omission: a triage chip that looks identical to a real one, sitting in a database that's never called an LLM. AIDA's seed closes that gap at the data layer instead of the UI layer. Every `AuditEvent` the seed writes — 3 `DRAFT_GENERATED` rows, 2 `DRAFT_APPROVED` rows, 26 `TRIAGE` rows, 3 completed `InsightRun`s — is stamped `provider: "demo"` and `model: "demo-seed"`. Those are the same two fields a real triage or draft call would populate with `"openai"`/`"gpt-4o"` or `"anthropic"`/`"claude-opus-5"`. Nothing downstream needs a special case to know the difference; a query that groups audit events by provider partitions demo activity from real activity for free, and no code path anywhere in the app has to remember "oh, and also check if this is the demo org."

```ts
// seed-demo-data.ts — every AI-shaped row this seed writes carries the
// same two fields a real completion adapter would populate, set to
// values no real provider can produce. The distinction lives in the
// data, not in a UI label someone could forget to render.
await tx.auditEvent.create({
  data: {
    organizationId,
    actionType: "TRIAGE",
    provider: "demo",
    model: "demo-seed",
    input: redactedPromptForTicket(ticket),
    output: triageResultFor(ticket),
  },
});
```

## The dataset is only allowed to look finished where the app actually is

The second, harder discipline is refusing to fake the parts of the demo that the app hasn't earned yet. AIDA's `aiEnabled` Setting — the kill switch that gates whether auto-triage and drafted replies run at all — is never written by the seed, so a fresh demo workspace shows AI features as configured-but-off, matching a real self-host that hasn't added an API key yet. Knowledge base articles seed with `embeddingStatus: PENDING`, never `COMPLETED`, because no embedding provider has actually processed them; a `COMPLETED` status would be a lie about work that never happened, and it would make the KB-gap and retrieval features in `/insights` and drafted replies look functional when they'd silently return nothing. The seed produces a workspace that *looks* like a team has been using AIDA for weeks, while staying truthful about the one thing a self-hosted evaluator most needs to trust: whether the AI actually ran.

That distinction matters because the audience for this dataset is exactly the audience the blog's "honest claims" rule exists for — someone deciding whether to trust a self-hosted tool with their own support data. A demo that quietly upgrades its own claims to look more finished than the product is would undercut the same credibility the rest of the project is built to earn.

## The seed is code, so it gets to have its own bugs

Treating the seed as a first-class write path rather than a one-off script paid off directly. `fixtures.ts` documents an exact target distribution for the demo tickets — 26 `COMPLETED` triage rows, 37 `AuditEvent` rows total — and a re-verification pass against a real seed run found the numbers off by one: ticket #2, "Slack messages not syncing," had been left with `triage: null` instead of the documented `COMPLETED`/`TECHNICAL`/`NEGATIVE`. That's a fixture bug, caught the same way a bug in application code gets caught — by writing down an expected invariant and then actually running the thing and checking the output against it, not by eyeballing the seed script and trusting that the numbers add up.

```ts
// fixtures.ts — the fix. The bug wasn't a logic error, it was a fixture
// entry that silently fell outside its own documented distribution;
// the fix is boring on purpose (one ticket, one missing field), which
// is exactly what makes "run it and count" worth doing over "read it
// and trust it."
{
  id: "T02",
  subject: "Slack messages not syncing",
  triage: { category: "TECHNICAL", sentiment: "NEGATIVE", status: "COMPLETED" },
  // was: triage: null — silently dropped one ticket from the
  // documented 26 COMPLETED count, and one row from 37 total audits.
}
```

The seed's own `db:seed` CLI closes the loop the same way: it refuses to run twice against a non-empty workspace rather than duplicating rows, and the whole path — seven migrations, first seed run, second seed run correctly refused with exit 1 — was proven end-to-end against a disposable Postgres container before it shipped, including a check that every `InsightRun` citation and `nearestArticle` reference resolves to a real seeded `Ticket` or `KbArticle` row. A demo that fabricates plausible-looking data is easy; a demo dataset that has to satisfy the exact same referential-integrity and audit-append-only invariants the real feature enforces is a different kind of easy to get subtly wrong, which is why it was worth verifying like production code instead of eyeballing like a fixture.

A demo dataset for an AI feature is not obligated to run the AI — it's obligated to never let a reviewer mistake `demo-seed` for a real model, or `PENDING` for `COMPLETED` work that hasn't happened yet.
