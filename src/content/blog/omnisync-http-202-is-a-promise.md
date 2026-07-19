---
title: 'An HTTP 202 is a promise: why I built OmniSync'
description: 'Every webhook integration works in the demo. Production loses events in the silence after you reply 200 — so I built OmniSync around one guarantee: once an event is acknowledged, it is never silently lost. At-least-once delivery, idempotent everything.'
category: 'Systems & Performance'
pubDate: 2026-07-06
tags: ['architecture', 'reliability', 'queues', 'postgres']
draft: false
---

Every webhook integration works in the demo. Production is where the other thing happens: the sender fires an event, your endpoint replies 200, and the data never lands anywhere — no error, no retry, no trace. I ship marketing and CRM integrations at my day job, and the failure mode that actually costs money is not the crash you get paged for. It is the silence you discover weeks later, when someone asks why one channel's leads dried up. OmniSync is the side project where I engineered against that silence explicitly: a webhook ingestion pipeline built around a single load-bearing guarantee — once an event is acknowledged, it is never silently lost.

The concrete shape: a Fastify API ingesting webhooks from marketplace and ads channels (Shopee, Tokopedia, Meta Ads, plus CRM webhooks), BullMQ on Redis as the durable bus, Postgres as the store, and a worker that normalizes, deduplicates, and syncs each event to a downstream CRM. I built it deliberately as a portfolio piece — the README says so out loud — but the failure modes it defends against are imported from real integration work. Treating it as an exercise bought me one luxury production projects rarely get: the first artifact in the repo is not code but a research doc cataloguing nine ways this class of system fails — written before any feature existed, so each failure mode could be designed out on purpose instead of discovered one incident at a time.

## The dangerous reply is 200, not 500

A 500 is honest. The sender knows delivery failed and retries. The reply that loses data is the 200 you return *before* the event is actually safe.

The default shape of a webhook handler does everything inline: validate, transform, write to the database, call the CRM, then respond. Two things are wrong with that. It is slow — a downstream API having a bad day pushes you past the sender's timeout, which triggers retries you now have to survive anyway. And it is fragile in the worst direction: any crash *after* the response means the event is gone while the sender holds a receipt saying you took delivery.

So OmniSync decouples. The API acknowledges with **HTTP 202** — "accepted, not processed", the accurate status code for this contract — and everything else happens asynchronously behind a durable queue. But decoupling doesn't remove the risk; it relocates it into the gaps. Between the ack and the enqueue. Between the queue and the worker. Between the worker and the row. Each gap needs a designed answer, and "we process everything exactly once" is not one of them: a worker that crashes after persisting but before confirming its job *will* see that job again on restart. The only honest contract is **at-least-once delivery** plus **idempotent processing**. Seeing an event twice is normal operation. Storing it twice is the bug.

## Keep the hot path boring

The ingestion path does five things and refuses to do a sixth: verify the HMAC-SHA256 signature (timing-safe, against the raw body), parse with Zod, compute a SHA-256 fingerprint, set a Redis `SET NX` dedup gate, enqueue with `jobId = fingerprint` — then reply 202. Single-digit milliseconds, no database write anywhere on the path. Postgres being down does not stop ingestion — events pile up in Redis and drain later.

The interesting bug lives in the two-step: gate first, enqueue second. What happens when the gate is set and then `queue.add` throws?

```ts
try {
  await queue.add(
    "process-event",
    { source, payload: parsed.data, fingerprint },
    { jobId: fingerprint },
  );
} catch (err) {
  // Best-effort rollback: release the dedup gate so the sender's retry is accepted,
  // not silently dropped as a "duplicate" while no job was ever enqueued.
  await redis.del(`idem:${fingerprint}`).catch(() => undefined);
  throw err; // centralized error handler returns 500 → sender retries
}
```

Without the rollback, the failure sequence is quiet and complete: enqueue fails, the sender gets a 500 and correctly retries, the retry hits the dedup gate that was already set, and the pipeline replies "duplicate, all good" — for an event that never entered the queue. Every component behaved correctly and the event still evaporated. This is what designing against silence actually means: the dangerous cases are not failure *points*, they are failure *sequences*, and you find them by walking the gaps between your own steps.

## Two strings can be the same instant and different bytes

Idempotency needs an identity, and identity is where the subtle bugs live. OmniSync fingerprints each event from the fields that define it — source, event type, external ID, occurrence time:

```ts
export function buildFingerprint(
  source: string,
  eventType: string,
  externalId: string,
  occurredAt: string,
): string {
  const normalizedOccurredAt = new Date(occurredAt).toISOString();
  return createHash("sha256")
    .update([source, eventType, externalId, normalizedOccurredAt].join("\0"))
    .digest("hex");
}
```

Two decisions in eight lines, both earned. The fields are joined with a null byte because naive concatenation has boundary collisions — `"ab" + "c"` hashes the same as `"a" + "bc"`, and you do not want two different events sharing a fingerprint because their field boundaries happened to slide. And the timestamp is canonicalized before hashing because ISO-8601 is many spellings for one instant: `Z`, `.000Z`, `+00:00` all name the same moment with different bytes. A sender that upgrades its serializer changes the string without changing the event — and a fingerprint built on raw bytes would wave the duplicate straight through as "new".

At the far end of the pipeline, the database holds the last word — this is the real function, trimmed to the shape that matters:

```ts
// Single atomic write. Returns "inserted" or "duplicate" — conflict absorbed = success.
// NEVER check-then-act: the ON CONFLICT clause is the only dedup at this layer.
const affected = await prisma.$executeRaw`
  INSERT INTO events (id, fingerprint, source, /* ... */)
  VALUES (gen_random_uuid(), ${event.fingerprint}, ${event.source}, /* ... */)
  ON CONFLICT (fingerprint) DO NOTHING
`;
return affected === 1 ? "inserted" : "duplicate";
```

Note what `duplicate` is: a return value, not an exception. Under at-least-once delivery a duplicate is not an error condition — it is the system working. Every write path in the worker is safe to run twice, because it *will* run twice. There are two more dedup layers between the fingerprint and this insert (the Redis gate and BullMQ's `jobId`), each covering a different race window; the full walkthrough of why one lock on that door isn't enough is its own post.

## A dead-letter queue that lives in Redis dies with Redis

Retries are bounded — full-jitter exponential backoff, a fixed number of attempts, and a circuit breaker in front of the CRM call so a downstream outage doesn't burn every job's retry budget against a wall. But bounded retries mean some jobs exhaust them, and where those jobs land decides whether the guarantee survives. BullMQ's failed set lives in Redis. A Redis restart, or a misconfigured eviction policy, and your record of what failed is gone — silent loss again, one level up.

So exhaustion is mirrored into a Postgres `dlq_events` table, with the payload plus the full error and stack. The handler is small, and both of its guard clauses trace straight back to entries in that pitfall catalogue:

```ts
if (!job) return; // stalled job + removeOnFail → job can arrive undefined

const maxAttempts = job.opts.attempts ?? 1;
if (job.attemptsMade < maxAttempts) return; // BullMQ fires "failed" on EVERY attempt
```

BullMQ emits `failed` on every attempt, not just the last — gate on exhaustion or your DLQ fills with events that were about to succeed. And re-queueing from the dashboard goes through `queue.add(jobId = fingerprint)` again rather than `job.retry()`, because the Redis-side job may have aged out entirely. Postgres is the durable source of truth; Redis is a bus. An operator double-clicking the re-queue button gets absorbed by the same `jobId` dedup as everything else — one more path that is safe to run twice.

## There is no free always-on worker, and that is a finding

The deployment story ends differently than I planned, and I kept it that way on purpose. A queue worker that must never sleep needs somewhere to run 24/7, and in 2026 there is no $0 tier for that anywhere: Render's background workers are paid, Railway has a monthly minimum, Fly is pay-as-you-go with no permanent free tier, and scale-to-zero platforms like Cloud Run put the worker to sleep — which for a delivery guarantee is indistinguishable from an outage, because queued jobs pile up unprocessed.

So OmniSync ships as pre-built GHCR images, a one-command reproducible demo (`pnpm demo` brings up the stack and fires an HMAC-signed multi-channel load test), and a recorded walkthrough — instead of a live URL that might be cold or dead at exactly the moment someone evaluates it. I would rather hand over a demo that provably works every time than a deployment that mostly works. The constraint analysis became the artifact.

The 202 takes under five milliseconds; keeping it is the entire rest of the system.

---

## Sources

- Render — *Pricing* (background workers have no free instance type). Retrieved 2026-07-19. <https://render.com/pricing>
- Railway — *Pricing* (the Hobby plan carries a monthly minimum). Retrieved 2026-07-19. <https://railway.com/pricing>
- Fly.io — *Pricing* (pay-as-you-go billing; no permanent free tier). Retrieved 2026-07-19. <https://fly.io/pricing>
- Google Cloud — *Configure minimum instances for services* (Cloud Run defaults to minimum instances 0, so idle services scale to zero). Retrieved 2026-07-19. <https://docs.cloud.google.com/run/docs/configuring/min-instances>
