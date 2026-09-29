---
title: 'A passing healthcheck guarantees order, not readiness'
description: 'A Docker Compose healthcheck gate held the ingestion worker back until the simulator had already fired a full day of factory telemetry at nobody — MQTT''s clean:false plus QoS 1 only replay into a session that already exists, and none did yet.'
category: 'Systems & Performance'
pubDate: 2026-08-24
tags: ['architecture', 'reliability', 'queues', 'concurrency']
draft: false
---

LineLens's docker-compose stack gates its startup on healthchecks, and the dependency graph reads as disciplined: the ingestion worker waits for Postgres and Mosquitto to report healthy, and — because it polls the simulator's clock over HTTP — for the simulator too. That looks like the responsible way to sequence a multi-container startup. On a clean `docker compose down -v && docker compose up`, it lost an entire simulated day of factory telemetry, silently, and every healthcheck in the stack still came up green. The bug wasn't in the worker or the simulator individually. It was in what "healthy" was being asked to mean.

## A healthcheck answers "am I alive," not "is my consumer ready"

LineLens's simulator boots by **warm-starting**: fast-forwarding a full prior sim-day of machine state through its internal clock and publishing the resulting backlog over MQTT in about 1.5 seconds, so that at go-live "yesterday" is always one fully completed sim-day for the Daily Direction Setting board and the order backfill to read. Its healthcheck hits `/healthz` on a small `node:http` control server — which, before the fix, the simulator only started *after* the warm-start burst had finished. The burst was over before the healthcheck's own 20-second `start_period` had even elapsed, so by the time Compose saw the simulator healthy, the backlog was already gone.

`docker-compose.yml` declares `worker.depends_on.simulator: condition: service_healthy`, which Compose honors exactly as written: it will not start the worker container until the simulator's healthcheck passes. That guarantee is real, and it is also not the guarantee anyone reading the compose file assumed they were getting. It answers "is the simulator's process alive and responding" — not "has the worker, some 13 seconds of its own boot and `prisma migrate deploy` and MQTT handshake later, actually subscribed to the topic the simulator floods at boot." Which makes the ordering itself the bug, not a race: on the measured cold start the worker process started three seconds after the burst ended and subscribed 16.2 seconds after it, and `depends_on` guaranteed that sequence on every clean run.

## `clean:false` and QoS 1 only replay into a session that already exists

The worker connects with a stable `clientId`, `clean: false`, and subscribes at QoS 1 — the standard MQTT pattern for a consumer that must survive its own restarts without losing messages. It works exactly as advertised, with one precondition nobody wrote down until this bug forced it into a comment: **replay** means resuming a session, and a session has to exist before there's anything for the broker to resume. On the worker's first-ever connection against clean volumes, no session exists yet for that client ID. The simulator's warm-start burst fires into a topic with zero subscribers, MQTT drops it as designed — nothing malfunctioned, nothing was configured wrong — and it is gone. `clean:false` protects a consumer that disconnects and reconnects. It cannot protect a consumer that was never connected in the first place.

## Nothing threw, which is why it stayed hidden

The stack came up. Every healthcheck in it was green. No exception fired in the simulator or the worker; the worker logged its first connection with `sessionPresent: false` and went on ingesting live events. The damage only showed up two hops downstream. `GET /api/losses?day=2026-01-05` — the warm-start day — returned zero rows on every line, not because the plant produced no losses that day, but because the day's events had never reached Postgres; the earliest stored `machine_event.simTime` was 07:00 on go-live day. `GET /api/dds` resolved "yesterday" with OEE, quality, and top-loss all null and zero actions — the Daily Direction Setting board's entire premise, empty on first run. LineLens's house rule that null reaches the UI as `N/A`, never a false `0`, at least kept that board honest about having nothing; a zero-filled board would have asserted a real, bad day instead.

What made it loud was a fixture invariant in the compose smoke suite — `line L1 must have losses on 2026-01-05` — failing during the UAT run that closed Phase 4. That was the first genuinely clean stack anyone had run since the invariant was written. Every earlier run of that test had been on a restarted stack, where the worker's MQTT session already existed and the broker had somewhere to queue the burst.

## The fix is a second readiness signal the platform doesn't have

Docker's healthcheck can only ever describe the simulator's own process. Whether the worker is subscribed is information the simulator has no way to observe unless the worker tells it — so the fix adds that channel explicitly, gated behind a promise the control server resolves:

```ts
// apps/simulator/src/main.ts
// WINDOWS 15: hold the backlog until the ingestion worker is subscribed.
// MQTT `clean:false` + QoS1 only replays into a session that already
// exists, so anything published before the worker's first connect is gone
// for good — and compose *guarantees* the worker starts after us.
const ingestorReadyGate = new Promise<void>((resolve) => { releaseGate = resolve; });

await Promise.race([
  ingestorReadyGate,
  new Promise<void>((resolve) => { timeoutHandle = setTimeout(resolve, INGESTOR_READY_TIMEOUT_MS); }),
]);
```

The control server itself has to start listening *before* this wait, not after — if it only came up once the gate released, Compose's healthcheck would never go green, the worker would never start, and nothing would ever POST the `/control/ingestor-ready` signal that releases the gate. While it waits, the clock is held paused at go-live, so sim time cannot drift past a backlog that hasn't been published yet. The worker only calls that endpoint from its broker-confirmed `onSubscribed` callback — the SUBACK, not the earlier `connect` event, which would still race the burst — so "ready" means the broker itself has confirmed the subscription, not just that the worker's code reached a certain line.

A 120-second timeout releases the gate anyway, loudly, because running the simulator standalone without a worker (a real dev workflow) must not hang forever; it just means that run's warm-start day goes unfed, which the log line says outright.

Re-run live on a clean volume, the simulator waited 13.0 seconds, the worker subscribed and signalled, and only then did the burst fire: the earliest stored event moved back to 07:00 on the warm-start day, losses came back on all four lines, and the smoke suite's losses test went green. Because the endpoint is idempotent, `docker compose restart worker` reconnects with `sessionPresent: true`, re-signals, and changes nothing — no second warm-start, no hang.

## Extending the same signal closed a second bug in the same family

The handshake above only covers a cold start. On a restart against a Postgres volume that already holds data past go-live, blindly warm-starting again ran the clock *behind* its own stored history — machines read `BREAK` with a `since` timestamp in the future, and `inject-breakdown` 404'd with "no injectable machine found" because nothing was in `EXECUTE`. The project's defect ledger — the source of the `WINDOWS` numbers in those code comments — files it as entry 14, the mirror image of entry 15, and the root shape is the same: the simulator was making a decision (warm-start vs. resume) without the one piece of state that decision actually depends on, which only the worker's side of the connection can see.

The fix widened the existing handshake instead of building a second one — the worker's readiness POST now carries `maxSimTimeMs`, the newest `machine_event.simTime` already in Postgres:

```ts
// apps/simulator/src/main.ts — WINDOWS 14
const resumeTo = storedMaxSimMs !== null && storedMaxSimMs > GO_LIVE ? storedMaxSimMs : null;
if (resumeTo !== null) {
  publishMuted = true;      // history already in Postgres — don't republish it over MQTT
  plant.advanceAll(resumeTo);
  publishMuted = false;
  clock = { epochSimMs: resumeTo, startedAtRealMs: Date.now(), speed: config.speed, pausedAtRealMs: null };
}
```

Verified against a live restart on a surviving volume: the gap between the simulator's clock and the newest stored event dropped from roughly 20 simulated hours to about 36 simulated seconds, and `inject-breakdown` returned a real machine instead of a 404. The catch-up stays deterministic — same seed, same span, same plant state — because `advanceAll` is the identical function that produced the original history; muting publication is the only difference between a resume and a rerun. The one documented exception is breakdowns injected by hand during the prior run: the catch-up does not replay them, an accepted divergence the code comment names outright.

## Ordering belongs to the orchestrator; readiness has to come from the consumer

A container healthcheck can only ever certify its own process — whether it's listening, whether it can reach its own dependencies, whether it would answer a probe right now. It has no visibility into a consumer running in a *different* container, and no orchestrator's `depends_on` graph can manufacture that visibility for you, no matter how correctly it's wired. Any service that both fronts a healthcheck for startup ordering *and* fires something unrepeatable on boot — a cache warm-up, a one-time backfill, an initial sync — needs its consumers to signal their own readiness explicitly, on a channel the orchestrator was never part of.

The healthcheck was telling the truth the entire time; it just could only ever speak for the simulator, and the question that mattered was about the worker.

---

## Sources

- OASIS — *MQTT Version 3.1.1*, §3.1.2.4 Clean Session, §3.2.2.2 Session Present, §3.3.1.3 RETAIN (with CleanSession 0 the server resumes the session for that client ID or creates a new one if none exists, storing QoS 1/2 messages matching its subscriptions; Session Present is 0 when no prior session state exists; a PUBLISH with RETAIN 0 is not stored). Retrieved 2026-09-29. <https://docs.oasis-open.org/mqtt/mqtt/v3.1.1/os/mqtt-v3.1.1-os.html>
- Docker — *Compose file reference: Services, `depends_on`* (`service_healthy` means a dependency is expected to be healthy, as indicated by its healthcheck, before starting the dependent service). Retrieved 2026-09-29. <https://docs.docker.com/reference/compose-file/services/>
- MQTT.js — *README* (the `subscribe` callback fires on SUBACK; `clean: false` receives QoS 1 and 2 messages while offline; default `protocolVersion` is 4, i.e. MQTT 3.1.1). Retrieved 2026-09-29. <https://github.com/mqttjs/MQTT.js/blob/main/README.md>
