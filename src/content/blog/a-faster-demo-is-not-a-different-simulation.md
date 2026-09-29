---
title: 'A faster demo is not a different simulation'
description: 'A factory-telemetry simulator that replays four hours in 15,000-millisecond steps and again in 150,000-millisecond steps must produce a byte-identical event list, or every calibrated OEE band is only true at the speed you happened to demo it — a discrete-event scheduler makes the tick size irrelevant by design, and a test proves it rather than assuming it.'
category: 'Systems & Performance'
pubDate: 2026-09-29
tags: ['testing', 'architecture', 'performance', 'reliability']
draft: false
---

A factory-telemetry simulator earns its demo value by being fast: a full day of machine activity compresses into 24 real minutes, at a speed multiplier an operator can dial up or down live. That multiplier is supposed to be cosmetic — a knob on how quickly a human watches something happen, not on what happens. The moment turning it changes the actual sequence of events the simulator produces, every number built on top of that sequence — OEE percentage, loss classification, whether an order ships by its due date — stops being a fact about the simulated plant and becomes a fact about whichever tick rate happened to be running when you looked. LineLens's simulator is built so that can't occur, and it doesn't just assert that — it runs the same four hours twice, at two different tick sizes, and diffs the output byte for byte.

## The real-time loop is an input, not a source of truth

The simulator's default speed is `SIM_SPEED = 60`: one real minute maps to one simulated hour, so a full simulated day passes in 24 real minutes and a live dashboard always has a fresh "yesterday" to show. That mapping is walked forward by a plain loop — every 250 real milliseconds, `main.ts` computes how far simulated time has moved and asks the plant to catch up to it. It would be easy to let that 250ms cadence *be* the simulation: decrement every countdown by one tick's worth of simulated time, check thresholds, repeat.

That design would run, and it would also be silently speed-dependent — a machine's remaining time-to-failure budget crossing zero between tick *N* and tick *N+1* at one tick size can land inside a different tick's boundary at another, and now the order in which two machines fail depends on how often you happened to sample them, not on when they were scheduled to fail. The codebase's standing rule keeps wall-clock time out of that decision entirely: wall-clock reads are allowed only for MQTT/infra plumbing, `ingested_at` audit columns, and the clock edge that feeds `simNow` — derivation logic computes every duration from the simulated timestamp it's handed, and the machine module never reads `Date.now()` at all.

## The scheduler jumps to the next event, never to the next tick

The answer isn't a smaller, safer tick — it's not ticking at all. `advance(rt, toSimMs)` doesn't step the machine forward in fixed increments; it jumps straight to whichever internal event is due next — a calendar boundary, a failure, a changeover, a micro-stop, a cycle completing, a counts batch flushing, evaluated in a fixed priority order — and stops exactly there. The 250ms real-time loop's only job is to keep calling `advance()` with a later and later `toSimMs`; how far forward each call happens to ask for is irrelevant to what the function does, because the function was never counting ticks. In the running state, the caller's target is just one more bound on how far the cursor may move before something is due:

```ts
// toSimMs is one bound among seven: an earlier target can stop the cursor
// short of the next event, but it can never move where that event lands.
const step = Math.max(
  0,
  Math.min(
    boundary - rt.cursor,
    rt.remainingToFailureMs,
    rt.remainingToChangeoverMs,
    rt.remainingToMicrostopMs,
    cycleRemaining,
    batchRemaining,
    toSimMs - rt.cursor,
  ),
);
```

Wall-clock time enters only upstream of all this, in one pure function in the shared contracts package:

```ts
export const simNow = (c: ClockState, nowRealMs: number): number =>
  c.pausedAtRealMs !== null
    ? c.epochSimMs + (c.pausedAtRealMs - c.startedAtRealMs) * c.speed
    : c.epochSimMs + (nowRealMs - c.startedAtRealMs) * c.speed;
```

`simNow` is the only place a wall-clock reading and a speed multiplier are allowed to touch each other on any path that decides what happened (its one SQL mirror, `sim_now()`, does the same math so the database's OEE views can clamp still-open intervals; the dashboard's client-side clock hook also projects forward between polls, but only for display, and that value never feeds a derivation), and even here the relationship is piecewise-linear, not incremental — a `rebase` on a speed change re-anchors the line without rewriting the simulated time that already happened. Everything downstream of that one function receives an absolute simulated millisecond and asks "what's next before this," never "what changed since last tick."

## Two tick sizes, one event list, or the proof doesn't count

A design argument is a claim; a test that could fail is the difference between a claim and a fact. The invariance test runs the exact same four-hour window twice with the same seed, once fed in steps shaped like what a 250ms loop produces at speed 60 (15,000 simulated milliseconds per call) and once shaped like speed 600 (150,000 per call):

```ts
const runWithStep = (stepMs: number) => {
  const ctx: MachineCtx = {
    calib: PROFILES.typical,
    products,
    shifts,
    rng: makeRng(seedFor(42, 'L2-M1')),
  };
  const rt = createMachineRuntime({ id: 'L2-M1', lineId: 'L2', productId: 'CYC-A' }, ctx, DAY_START);
  const events: unknown[] = [];
  const horizon = DAY_START + FOUR_HOURS_MS;
  for (let toSimMs = DAY_START + stepMs; toSimMs < horizon; toSimMs += stepMs) {
    advance(rt, toSimMs, ctx, (e) => events.push(e));
  }
  advance(rt, horizon, ctx, (e) => events.push(e));
  return events;
};

const eventsAtSpeed60 = runWithStep(15_000); // 250ms real tick × speed 60
const eventsAtSpeed600 = runWithStep(150_000); // 250ms real tick × speed 600
expect(JSON.stringify(eventsAtSpeed60)).toEqual(JSON.stringify(eventsAtSpeed600));
expect(eventsAtSpeed60.length).toBeGreaterThan(0); // two empty lists would also be "identical"
```

A second test in the same file pushes the claim further: a single `advance()` call straight to the horizon, with no intermediate steps at all, has to produce the identical serialized list too. That's the stronger and more useful version of the guarantee — not "two speeds agree with each other," but "the number of times you ask doesn't matter, only the final timestamp you ask about does." Jumping to the next due event passes both for the same reason: polling frequency was never an input to begin with.

## Reproducible is not the same claim as uneventful

None of this makes the simulator's output monotonous, because determinism and variety are solved at different layers. Each machine draws from its own mulberry32 stream, seeded by hashing the run's top-level seed together with that machine's ID through FNV-1a — so the streams are independent of each other, but the same top-level seed reproduces every machine's sequence exactly on the next run. The calibration test leans on that directly: it doesn't just check that a machine on the `typical` profile lands in a verified 48–67% OEE band over three simulated days, it also computes a simplified reference OEE for each of the six shifts in that window and asserts the standard deviation across them exceeds 1.5 points —

```ts
expect(stddev(perShiftOee)).toBeGreaterThan(1.5);
```

— specifically to catch a simulator that's gone *too* deterministic: one where every shift lands on the same number because the randomness got averaged away somewhere, which would be a flatline pretending to be a plant. Speed-invariance and shift-to-shift jitter are answering two different questions — "does asking more or less often change the story" and "does the story stay believable" — and a seeded PRNG plus a pure, poll-count-agnostic scheduler is what lets both be true at once instead of trading off against each other.

The knob that makes a demo go faster only stays harmless once it has no path into the code that decides what happens at all.
