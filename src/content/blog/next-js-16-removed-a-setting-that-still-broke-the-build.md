---
title: 'The setting Next.js 16 stopped supporting is what turned CI red'
description: 'Next.js 16 removed the ''eslint'' key from its config type, and a key written into next.config.ts anyway didn''t fail at runtime — it failed the type checker. The CI gate sat red for about a week before anyone acted on it, and the first to act was a baseline audit, not anyone watching the build.'
category: 'Systems & Performance'
pubDate: 2026-09-29
tags: ['nextjs', 'typescript', 'reliability', 'architecture']
draft: false
---

A setting a framework no longer supports is not automatically harmless. If it is still typed — still checked against a shape the framework's own type definitions describe — removing support for it is a breaking change to the type, even though it does nothing at runtime either way. That is what happened to an `eslint` block in a Next.js config file on SentraOps ERP, my ERP rebuild: the key was written into a project already on Next.js 16, which no longer supports it, so `tsc --noEmit` started failing on it immediately, and the failure sat red in CI for about a week before anyone acted on it.

## Skipping type-check at build time made a separate gate load-bearing

SentraOps builds on a small VPS, and `next build`'s own type-checking pass is expensive enough to OOM a 2 GB box. The project's own rule, written into `next.config.ts` as a comment, is explicit about the trade: `typescript: { ignoreBuildErrors: true }`, with types "verified separately via `npm run typecheck`" (my translation of the Indonesian comment). That single decision means the production build itself will happily ship code with type errors — the safety net isn't `next build`, it's a dedicated `tsc --noEmit` step that has to run somewhere else and has to actually get watched.

CI is that somewhere else: the workflow's own header comment lists exactly two mandatory gates, "(1) `tsc --noEmit` zero error, (2) test modul pass" (verbatim; *modul* is Indonesian for module) — nothing about lint, nothing implicit. Once you've made that trade, the typecheck step isn't a nice-to-have; it's the only thing standing between a real type error and a green merge.

## The break showed up in the gate built to catch exactly this

Next.js 16 removed the `eslint` option outright, after a deprecation period — the installed 16.2.4 type definitions have no such property on `NextConfig`, and at runtime the framework only logs that the option is no longer supported. The project had been on Next 16 since its first commit, but the same commit that switched off build-time type-checking to stop the OOM also added the companion line, `eslint: { ignoreDuringBuilds: true }`, an option from before Next 16. TypeScript's excess-property check on object literals turned that into `TS2353`, a hard compile error on the config file itself:

```ts
// next.config.ts, before the fix — valid JavaScript, not a valid Next 16 NextConfig
const config: NextConfig = {
  reactStrictMode: true,
  experimental: { typedRoutes: true },
  typescript: { ignoreBuildErrors: true },
  eslint: { ignoreDuringBuilds: true }, // TS2353: 'eslint' does not exist in type 'NextConfig'
};
```

This is the part worth sitting with: the key was inert from the day it was written. Next 16's `next build` doesn't run the linter at all anymore, so at the level of "does the app behave differently," deleting that block changes nothing. But `tsc --noEmit` doesn't check behavior, it checks shape, and the shape the installed framework ships has no room for that value. A cold typecheck — no cache, no incremental build info, exactly what a fresh CI runner does on every push — failed on that file every single time, correctly, for a genuinely dead setting. A warm one didn't: the audit found that once a `next dev` server had regenerated `.next/dev/types`, the generated augmentation re-added `eslint` and `tsc` reported zero errors, so the same command could pass on a machine running the dev server while failing on every fresh runner.

## A gate that works is not the same as a gate someone is watching

That's the uncomfortable middle of this story: the gate did its job. `tsc --noEmit` failed the moment the line landed, and it kept failing on every push for roughly a week. Nobody fixed it in that window, and nothing in the workflow forced anyone to look — there's no separate mechanism that pages a human when the mandatory check goes red, only the check itself, sitting there. It couldn't even block a merge: branch protection wasn't available on the repo's plan, so the gate the workflow header calls mandatory was advisory in practice.

What actually surfaced it wasn't someone noticing a failing badge; it was a baseline audit run against the repo, whose first move was a cold `tsc --noEmit` plus the test suite, specifically to establish what was and wasn't already broken before doing anything else. The audit's record says it plainly: tests green, cold typecheck red, and CI red on exactly this for about seven days.

That ordering matters more than the bug. A type-check gate that only gets read when something else goes looking for it is providing less safety than its green-or-red status implies — the failure mode isn't "the gate missed something," it's "the gate caught something and nobody was listening." For a solo-to-small-team project without a dashboard or an on-call rotation, that's a realistic gap, not a process failure worth dramatizing — but it's still the gap that let a one-line, zero-risk fix sit undone for more than a week.

The red gate also took something down with it. A Playwright job added to the workflow a few days into that window declares `needs: quality`, so it was skipped on every run — the audit notes those smoke specs had never once executed in CI. A downstream gate that depends on a red upstream one doesn't fail; it just never starts.

## The fix matched what the framework had already done

The fix itself is almost anticlimactic, which is the point:

```ts
// next.config.ts, after the fix (comments translated from Indonesian)
const config: NextConfig = {
  reactStrictMode: true,
  experimental: { typedRoutes: true },
  // Small-RAM VPS build: skip type-check during `next build`
  // (the most memory-hungry phase; it OOMs a 2 GB machine).
  // Types are verified separately via `npm run typecheck` (tsc --noEmit).
  // Next.js 16 removed the built-in ESLint integration (the `eslint` option
  // is gone from NextConfig) — lint now runs purely via `npm run lint`,
  // no longer automatically during `next build`.
  typescript: { ignoreBuildErrors: true },
};
```

Deleting the key isn't a workaround or a suppression — it's catching the config file up to a decoupling the framework had already made. Lint used to ride along inside `next build` as a side effect; Next 16 severed that, so lint now lives only in `npm run lint`, answerable to nobody but whoever remembers to run it — the CI workflow has no lint step. The audit logged a separate item for that script too: it still called `next lint`, a command Next 16 also removed, so it errored instead of linting.

The commit that landed the fix on master didn't stop at the one key: it also bumped `actions/checkout` and `actions/setup-node`, and moved the jobs from Node 20 to 22, to clear the Node 20 deprecation warnings in the same workflow. Once you're in a workflow file fixing one kind of staleness, checking for the adjacent kind costs almost nothing and catches problems before they're the thing a future audit has to find.

Type-checking a config file catches drift that no test suite will ever think to write, because nobody writes a test for "does this config match the framework version I'm actually on." The gate worked exactly as designed.

The only thing missing was someone with a reason to look at it before the audit did.

---

## Sources

- Vercel — *How to upgrade to version 16* (the `next lint` command and the `eslint` option in the Next.js config file are removed in Next.js 16 as previously deprecated features; `next build` no longer runs linting). Retrieved 2026-09-29. <https://nextjs.org/docs/app/guides/upgrading/version-16>
