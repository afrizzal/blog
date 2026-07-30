---
title: 'One import ran a purchase order against the wrong database'
description: 'A Playwright fixture script in SentraOps ERP had no guard on its own entry point, so any file that imported one exported constant from it silently reran the whole script — including, once the fixture grew to need a real goods receipt, a live purchase order posted against the actual dev database instead of the disposable E2E one.'
category: 'Systems & Performance'
pubDate: 2026-07-23
tags: ['testing', 'reliability', 'architecture', 'typescript']
draft: true
---

An `import` statement doesn't extract a value — it runs a file, then hands you a reference to whatever that file exported. If the file's top-level code does anything besides define exports, every import of it does that thing too, whether you wanted it to or not. SentraOps ERP's Playwright suite hit this the concrete way: a fixture script written to be run once as a standalone command was also imported from two other files for a single exported constant. Each of those imports silently reran the entire script — and by the time the fixture had grown to include a real purchase order, that rerun was writing live purchasing data into `erp_dev`, the actual development database, instead of `erp_e2e`, the disposable one the E2E suite is supposed to own exclusively.

## A script meant to run once doesn't know it's being imported

`e2e/seed-extra.ts` builds the E2E-specific fixtures on top of the production seed: four role accounts, a dedicated warehouse, a couple of sellable items with stock, a supplier, a customer with a credit balance. It's meant to be invoked directly — `npx tsx e2e/seed-extra.ts` — and it ends the way a standalone script ends:

```ts
main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
    await pool.end();
  });
```

Nothing guards that call. CommonJS gives you `require.main === module` for exactly this situation — a way for a file to ask "was I run directly, or just required?" and stay quiet in the second case. ESM doesn't hand you an equivalent by default, and this codebase runs its E2E scripts as ESM via `tsx`. The top-level `main()` call fires the moment the module is evaluated, full stop — invoked directly or merely imported, `PrismaClient` connects and every upsert runs either way.

The file also exports `E2E_USERS`, a small object of test credentials — kasir, spv, finance, viewer. Two other files needed exactly that constant and nothing else: `global-setup.ts`, to log each role into a real browser session, and one Playwright spec. Both wrote the line that looks obviously correct: `import { E2E_USERS } from "./seed-extra"`.

## The override that never got a head start

`global-setup.ts` is supposed to own `DATABASE_URL` for the whole E2E run — load `.env`, point it at `E2E_DATABASE_URL` (`erp_e2e`), drop and recreate that schema, migrate, seed. That sequencing lives in the function body. But a static `import` is hoisted: the ES module spec evaluates every import before the importing module's own top-level statements run, in dependency order, regardless of where the `import` line sits in the source. `seed-extra.ts` opens its own `dotenv/config` and builds its Postgres pool from `process.env.DATABASE_URL` as part of that hoisted evaluation — which means it connects before `global-setup.ts` has executed a single line of its own body, including the line that was going to redirect `DATABASE_URL` to `erp_e2e`.

So the accidental run used whatever `DATABASE_URL` was already sitting in the environment at process start — the same default `.env` value every other command on the machine uses. That default points at `erp_dev`. The fixture script never touched a config flag, never had a typo, never pointed anywhere on purpose. It just ran before the thing meant to redirect it got a turn.

## Idempotent fixtures don't stay idempotent as the suite grows

For a while this was mostly harmless. The original fixtures — user accounts, a warehouse, a couple of items — are all `upsert` calls, and an upsert running twice against the same rows just writes the same rows again. The bug was live, but its blast radius was small enough to hide.

That stopped being true once the Purchase Return spec needed a posted goods receipt to test against. Building a realistic GR meant not inserting rows by hand but driving the real purchasing flow — `purchasingRouter.createCaller()` calling `pr.create` → `pr.submit` → `pr.approve` → `po.create` → `po.submit` → `po.approve` → `gr.create` → `gr.post`, so the resulting document carries real numbering, real FIFO cost layers, and a real GRIR posting, the same as if an actual buyer had clicked through the UI. That's not an idempotent upsert anymore. It's a business transaction with GL and stock-ledger side effects, running unattended against whatever database the environment happened to resolve to at that moment — and by then, the environment had been resolving to `erp_dev` for as long as this bug existed. The bug itself never changed. What it was capable of doing did.

## A PID is a better witness than a guess

Confirming a double-execution by reading code is a hypothesis; confirming it by instrumentation is a fact. A temporary `process.pid` marker logged at the top of `seed-extra.ts` showed two different PIDs per `npx playwright test` run before the fix — one from the accidental import-time execution, one from `global-setup.ts`'s own explicit `execSync("npx tsx e2e/seed-extra.ts", ...)` later in its body, which is the actually-intended seed step. After the fix, exactly one.

The fix isn't a guard clause on `main()` — a guard there would have to make an assumption about what counts as "being run directly" that ESM doesn't give you a clean way to check. Instead, `E2E_USERS` moved into its own file, `e2e/e2e-users.ts`: `dotenv/config` and an object literal, nothing else, with a comment on it forbidding any future import that would activate `PrismaClient` or a router. `global-setup.ts` and the spec now import the constant from a file that is, by construction, incapable of doing anything when imported.

A read-only query against `erp_dev` confirmed what the accidental runs had left behind: the idempotent fixtures showed up as expected, re-written harmlessly on every accidental rerun. The Purchase Return fixture showed up as a real, un-idempotent trail — a supplier, an item, an approved purchase requisition, an approved purchase order, and a goods receipt stuck in `DRAFT`, because that particular accidental run happened to hit a transient failure before its `post()` call committed. No stock ledger entries, no GL journal — the one accidental run that could have posted a real journal into the dev database is the one that failed partway through. That's luck, not a property of the fix.

The database doesn't know or care why a write happened — only that it did. A constant that looks safe to import is a claim about the file it lives in, and the only way to make that claim true is to put the constant somewhere a database connection can't follow it.
