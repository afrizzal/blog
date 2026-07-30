---
title: 'The UAT item that was still a checkbox'
description: 'A "verify docker compose up on a clean machine" note sat unautomated for a phase. Running it as a real test instead of eyeballing it surfaced three defects unit tests could never see — including one that would''ve crash-looped every service on a stranger''s laptop.'
category: 'Systems & Performance'
pubDate: 2026-08-06
tags: ['reliability', 'testing', 'architecture']
draft: true
---

A UAT checklist item that says "verify X on a clean machine" is not verified until something other than a human's memory runs it. LineLens's Phase 1 had exactly that item sitting unautomated, and the unit suite stayed green the whole time — 56/56, no red anywhere — while three defects sat underneath it, invisible to every test that ran.

The project is a real-time OEE dashboard with a manufacturing-line simulator behind it: a control API, an MQTT broker, a worker, and a web app, all meant to come up with one `docker compose up`. That one-command promise is the entire point of a portfolio appliance — nobody evaluating it is going to clone the repo and hand-configure four services. So the UAT item that mattered most was also the one nobody had actually run end-to-end on a machine that hadn't already built the image before.

## Automating the checkbox is what found the bug, not thinking harder about it

I didn't discover these by reasoning about the Dockerfile in the abstract. I discovered them by writing `tests/smoke/compose-stack.spec.ts`, a Playwright suite that runs against the live stack instead of asserting against mocks, and watching it fail in ways the unit suite never could. Vitest only scans `packages/*` and `apps/*` — it never touches a Dockerfile, a `.dockerignore`, or a `docker-compose.yml`, so a class of bug that lives entirely in "how the container gets built and wired" was structurally outside its reach. The smoke suite is the thing that closes that gap: `docker compose up -d --wait db mqtt simulator web && playwright test`, run against the artifact that ships, not a description of it.

The first and worst defect: there was no `.dockerignore`. `COPY . .` in the Dockerfile copied the host's `node_modules` straight into the image, overwriting the ones the image had just installed for its own platform. On Windows, pnpm's `node_modules` are symlinks pointing at paths on the host filesystem — paths that don't exist inside the container. Every service that needed `tsx` or `next` at runtime crash-looped on `MODULE_NOT_FOUND`, and the failure mode was almost designed to be missed: it only shows up on a machine where the host `node_modules` were installed with pnpm, which is to say, on a clean checkout doing exactly what the UAT note asked someone to verify. A developer running the stack a second time, with a stale image and cached layers, would never see it.

The fix is three lines that matter and a handful that don't:

```text
node_modules
**/node_modules
.next
**/.next
```

The rest of the file excludes `.git`, `docs`, `.env` — normal hygiene. The load-bearing part is `node_modules`, and the reason it's load-bearing is specific to this stack's package manager, not general Docker advice. A team on npm without symlinked packages might never trigger this exact failure; a Windows pnpm workspace hits it on the first real build.

## Reachability is part of correctness, not a deployment afterthought

The second defect was quieter: the simulator's control port, 4000, was exposed in the Dockerfile but not published in `docker-compose.yml`. `EXPOSE` documents a port to other containers on the same Docker network; it does nothing for a process on the host trying to reach it. The simulator's `inject-breakdown` endpoint — the one that lets a demo or an automated check simulate a machine failure and watch the dashboard react — was reachable from inside the compose network and from nowhere else. The fix is a one-line `ports: ["4000:4000"]`, but the interesting part is what made it visible: a smoke test that calls `POST /control/inject-breakdown` from the host, the same way a person doing a manual demo would, rather than asserting against an internal service call that would have passed regardless.

The third defect wasn't a bug so much as an environment LineLens hadn't accounted for: a machine behind a TLS-intercepting proxy — corporate MITM, antivirus SSL scanning, a Zscaler gateway — needs its custom CA certificate trusted inside the container, or every outbound HTTPS call from `pnpm install` onward fails with a certificate error the developer didn't cause and can't easily diagnose from the error message alone. The fix concatenates whatever's in a gitignored `docker/certs/` directory into the image's trust store at build time:

```dockerfile
COPY docker/certs/ /tmp/extra-certs/
RUN cat /tmp/extra-certs/*.crt > /usr/local/share/extra-ca.crt 2>/dev/null || : > /usr/local/share/extra-ca.crt
ENV NODE_EXTRA_CA_CERTS=/usr/local/share/extra-ca.crt
```

On a clean machine with no certs in that directory, the `cat` finds nothing to concatenate, the fallback writes an empty file, and `NODE_EXTRA_CA_CERTS` points at a trust store with nothing extra in it — a no-op. The design decision worth naming is that this had to be a no-op by default and opt-in by machine-local file, not a flag someone remembers to set, because the whole point of "clone and `docker compose up`" is that it works without the person reading a setup doc first.

## The suite proves it caught something real, not just that it's green

A smoke suite that only ever passes doesn't prove much — it might just be undertuned. `compose-stack.spec.ts` asserts on properties that would fail differently depending on what's actually broken: `/healthz` reports a populated plant (`machines > 0`), not just a 200; two calls to `/clock` three seconds apart return the same `speed` and `epochSimMs`, proving one clock origin instead of each request computing its own; the derived sim-elapsed time is measurably larger than real-elapsed time, proving the acceleration is real and not a cosmetic label; MQTT telemetry is validated against a Zod schema and its topic parsed against a Sparkplug-B-style contract, with simulated timestamps that differ from wall-clock by more than a minute; `inject-breakdown` 404s on an unknown line ID instead of silently succeeding; and the page loads with zero `pageerror` events.

The suite includes its own negative control: stopping the simulator before running it fails the suite, rather than passing vacuously because there was nothing left to check. That's the difference between "the test is green" and "the test is capable of being red" — a distinction that matters more for infrastructure tests than for unit tests, because infrastructure tests are exactly the kind that get written once, pass by accident, and then rot silently while everyone trusts them.

None of these three defects would have shown up in a code review of the application logic, because none of them were application logic. They lived in the seam between the code and the environment it runs in — the seam a UAT checklist item names but a checkbox can't verify. The fix wasn't writing better Docker configuration on the first attempt; it was refusing to let "verify on a clean machine" stay a sentence a human reads and nods at.
