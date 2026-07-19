---
title: 'One lock on that door was never going to be enough'
description: 'OmniSync checks the same SHA-256 fingerprint three times — a Redis gate, BullMQ''s jobId, and a Postgres unique constraint. On a whiteboard that reads as paranoia; in production each layer closes a race window the other two physically cannot see.'
category: 'Systems & Performance'
pubDate: 2026-07-20
tags: ['architecture', 'reliability', 'queues', 'postgres']
draft: true
---

OmniSync deduplicates every event three times — once at a Redis gate, once at the queue, once in the database — and not one of those checks is redundant. [The last post](/blog/omnisync-http-202-is-a-promise/) ended its dedup story at a Postgres `ON CONFLICT` and promised that the walkthrough of why one lock on that door isn't enough would be its own post. This is that post. The whiteboard reading of three checks on one identity is belt-and-suspenders paranoia; the accurate reading is that each layer closes a **race window** the other two cannot see — and the repo's pitfalls research, dated before the first migration existed, named every one of those windows before there was any code to race through.

All three layers enforce a single identity: the SHA-256 fingerprint over source, event type, external ID, and a canonicalized timestamp, null-byte-joined against boundary collisions. That part is covered in the last post and doesn't change here. What changes is position — the same key checked from three different places fails in three different ways, and the differences are the design.

## The Redis gate answers in microseconds and forgets in a day

```ts
// Step 4: Redis SET NX dedup gate (D-16 / IDM-01) — null means key existed → duplicate
const gate = await redis.set(`idem:${fingerprint}`, "1", "EX", 86400, "NX");
if (gate === null) {
  return reply.code(202).send({ status: "duplicate", fingerprint });
}
```

This is the layer the hot path is built around: a duplicate turns around at Redis without ever touching the queue, which is what lets the ingestion path keep its no-database-write property and its single-digit-millisecond ack. It closes the tightest window there is — two identical webhooks racing into the API in the same instant, where the loser hits an already-set key and stops. And note what the loser receives: a **202**, not a 409. Under at-least-once delivery a duplicate is normal operation, and answering normal operation with an error status invites the one thing a dedup gate exists to stop — another retry.

What the gate cannot do is remember. The TTL is 24 hours, and the same research doc notes that webhook senders typically keep retrying for 24 to 72 hours — the gate's memory deliberately sits at the bottom of that range, because it was never meant to be the record. A key can also simply vanish: a Redis restart, or eviction under memory pressure — which is why the compose file pins `maxmemory-policy noeviction` with AOF persistence, and a standalone assertion script (`pnpm assert:redis`) exits fatally if the running Redis reports any other eviction policy. But narrowing a window is not closing it, and the architecture doc states the demotion plainly: *"Redis is a performance gate, not the authoritative dedup store."* This layer has also already had its one production-shaped bug — the gate-then-enqueue rollback from the last post, where a set gate plus a failed enqueue briefly turned a sender's honest retry into a false "duplicate."

## The queue forgets a completed job after an hour, and the test suite found out first

The queue's default job options — annotation mine:

```ts
defaultJobOptions: {
  attempts: env.RETRY_ATTEMPTS,
  backoff: { type: "custom" },
  // This layer's dedup memory: a completed job's id survives one hour or 1,000
  // newer completions, whichever runs out first — then BullMQ forgets it ever ran.
  removeOnComplete: { age: 3600, count: 1000 },
  removeOnFail: { age: 7 * 24 * 3600 },
},
```

Setting `jobId = fingerprint` makes the queue itself refuse a second enqueue of the same identity — for as long as it still remembers the first. `removeOnComplete` is the fine print on that memory: after an hour, or after a thousand newer completions, the id is gone, and a late duplicate enqueues freely.

I know this window is real because the test suite fell into it. An integration test reused a static fingerprint across runs, and the completed job from a previous run — still inside its one-hour retention in Redis — silently deduplicated the next run's enqueue. The fix, commit `237342e`, generates a unique fingerprint per run, and the comment it left behind is the best documentation this window has:

```ts
// Unique fingerprint per test run — avoids BullMQ jobId dedup when the completed job
// stays in Redis for up to 1 hour (removeOnComplete: { age: 3600 }). Must be 64 hex chars.
```

There is also a failure this layer cannot touch even in principle: the stalled worker. When a worker's event loop blocks past the job lock's duration, BullMQ re-queues the job and a second worker picks it up; if the first worker then recovers and finishes, the same job — one id, one enqueue — has been processed twice. The pitfalls doc is blunt about what that means: the lock is a performance optimization, not an exactly-once guarantee. Enqueue-side dedup is helpless here, because nothing was enqueued twice.

## The database is the only layer that never forgets

Everything the first two layers let through lands on the worker's insert — `INSERT ... ON CONFLICT (fingerprint) DO NOTHING` against a unique constraint, shown in full last time. What matters for this post is what the processor does with the result:

```ts
const outcome = await persistEvent(prisma, normalized);

if (outcome === "duplicate") {
  logger.info(
    { jobId: job.id, fingerprint: normalized.fingerprint },
    "[worker] duplicate absorbed",
  );
}
// No throw on duplicate — conflict is success (D-05). At-least-once safe: every path is safe to run twice.
```

"Duplicate absorbed," logged at info level, and the job completes normally — a duplicate here is not an error to raise, it is the system's outermost promise being kept by its innermost layer. This is where the redelivery arriving 25 hours after the gate expired gets caught, where an enqueue after a Redis wipe gets caught, where the stalled worker's second pass gets caught, and where the nastiest sequence in the catalogue — worker persists the row, crashes before acknowledging the job, and receives the same job again — resolves into one row and a log line. The research rejected the obvious alternative by name: never check-then-act, because a SELECT followed by an INSERT reopens the race the constraint exists to close. Whoever inserts first wins; everyone else gets a silent no-op.

The tests treat this layer as the load-bearing one. The idempotency proof fires 50 concurrent identical events at the processor *directly* — deliberately invoked below the queue, so jobId dedup can't quietly help — and asserts exactly one row lands. The durability proof pauses the real Postgres container, fires a load of events into the outage, un-pauses it, re-drives every event the way at-least-once redelivery would, and asserts the count is exactly N: duplicates absorbed, nothing lost.

## The re-queue button bought its idempotency with someone else's code

The dead-letter queue's re-queue path is where the layering pays out as a feature. An operator re-queuing a dead event goes through `queue.add` with the same fingerprint as the jobId — not `job.retry()` — and the phase's own research initially recommended the opposite. The plan overruled it: a failed BullMQ job older than `removeOnFail`'s seven days no longer exists to retry, while the Postgres DLQ mirror still does, so re-queue re-enters through the front door of the normal pipeline.

```ts
const job = await deps.queue.add("process-event", jobData, {
  jobId: entry.fingerprint, // reuse fingerprint -> BullMQ dedup makes re-queue idempotent
});
// BullMQ returns the existing job (no new add) when the jobId already exists in active/waiting;
// treat a re-add of a still-present job as already_queued (Pitfall 8 double-click safety).
if (job == null)
  return { status: "already_queued", fingerprint: entry.fingerprint };
```

A double-click is absorbed at the queue; a re-queue of an event that did in fact persist before dying downstream is absorbed at the database. The feature shipped with zero new dedup logic — reusing the identity bought it passage through the same three doors, the same way [the ERP ledger's business-reference idempotency key](/blog/race-proof-fifo-stock-ledger-postgres/) makes reposting a document free. The phase-3 research says it out loud: with jobId dedup at enqueue and the constraint at persist, the worker needs zero custom deduplication logic — attempt the insert, handle the two outcomes.

## Three layers still refuse to promise one thing

Exactly-once *storage* is not exactly-once *side effects*. If the worker persists the row, calls the CRM, and crashes before acknowledging the job, redelivery produces a duplicate row that the constraint absorbs — and a second CRM call that nothing in this pipeline can un-send. The pitfall catalogue's mitigation is the honest one: the downstream endpoint has to be idempotent too, because the alternative is pretending a two-phase commit exists between your database and someone else's API.

Two archaeological honesty notes to close. First, no test in the repo lets an `idem:` key actually expire and proves the database catches the 25-hour redelivery — the claim rests on the constraint's own tests, which is consistent with the design but is a rehearsal that hasn't happened. Second, the repo never calls this a three-layer design: the architecture doc says "two-layer dedup" and means Redis plus the constraint; the phase-3 research also counts two and means jobId plus the constraint. Two documents, two different pairs, and the union is what actually shipped. Each doc counted the layers its phase could see — which is the whole point, because a dedup layer is invisible except from inside the window it closes.

The gate forgets in a day, the queue forgets in an hour, and the guarantee survives because the database never forgets at all.
