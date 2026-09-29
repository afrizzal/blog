---
title: 'Renaming an unused parameter is not always a no-op'
description: 'A Biome lint fix renamed a Playwright fixture''s empty-object parameter to silence a dead-pattern lint error — a no-op for the function body, but Playwright reads that exact syntax shape to resolve fixture dependencies, and the rename crashed every end-to-end test before a single one ran.'
category: 'Systems & Performance'
pubDate: 2026-09-07
tags: ['testing', 'reliability', 'architecture', 'typescript']
draft: false
---

AIDA's Playwright setup resets a shared rate-limit table between end-to-end tests, using a fixture whose first parameter was written as an empty object: `async ({}, use) => {...}`. Biome's linter flagged that `{}` under `lint/correctness/noEmptyPattern` — an empty destructuring pattern binds nothing, so the rule assumes it's dead weight — and a cleanup commit renamed the parameter to `_fixtures`, the conventional way to mark a parameter as intentionally unused. Lint went green. The type checker didn't blink. The rename was one identifier wide. About a month later, every single end-to-end test in the suite failed before running a single assertion, because that same `{}` wasn't a variable binding Playwright ever cared about — it was the exact syntax shape the test runner reads to know the fixture takes no dependencies of its own.

## A linter reads code for meaning it can prove statically

`noEmptyPattern` exists because an empty **destructuring pattern** has no effect — the ESLint rule it mirrors treats one as a likely mistake, often a mistyped default value. Biome can prove that much from the syntax tree alone: no identifiers get bound, so nothing downstream in the function body can depend on this parameter's shape. Renaming it to `_fixtures` is the standard fix for exactly that situation — an underscore prefix that tells both the reader and the linter "yes, this is unused, and that's fine." The deferred-items ledger that queued the work had filed this finding, together with a `void` type on the same fixture, as "low-risk, mechanical", and commit `321ce89` (07-09's pass to clear five pre-existing lint errors blocking CI) fixed it exactly that way. Judged by the syntax tree alone, the label was accurate.

## Playwright reads the same line as a contract, not a binding

`test.extend()` fixtures don't declare their dependencies through a config object or a TypeScript type — they declare them through the literal shape of the fixture function's own first parameter. An object-destructuring pattern, even an empty one, is how a fixture says "I don't need any other fixture before me." Playwright checks that shape while it loads the test files, before any test runs: it reads the fixture function's own source text back through `fn.toString()`, strips the comments, and rejects any first parameter that doesn't start with `{` and end with `}`. A plain identifier fails that check no matter what it's named or whether the function body ever reads it.

Two tools looked at the same parameter slot — `{}` before the rename, `_fixtures` after — and reached opposite conclusions about whether its shape mattered. Biome asked whether anything binds here. Playwright asked whether this is shaped like the contract it requires. `{}` answers no to the first question and yes to the second, and the lint fix only checked the first.

## A load error left no partial blast radius to notice

The rate-limit fixture is registered as an **auto fixture** — `{ auto: true }` — which means Playwright runs it for every test built on the extended `test` object, without any test naming it as a parameter. That's the right call for what it does: public routes share one rate-limit bucket keyed by IP, and all Playwright traffic comes from the same machine, so leaving the reset opt-in would mean any spec that forgot to request it could trip the limiter for every spec that ran after it.

But only four of the suite's fifteen spec files import that extended `test`; the other eleven import `test` straight from `@playwright/test` and never see the fixture. By that arithmetic the break should have been partial — four spec files red, eleven green. It wasn't, because Playwright parses every registered fixture's signature while it loads test files, auto or not, and reports a bad one as a load error. The `playwright test` runner treats a load error as fatal to the whole run, so the suite stopped before a single test body executed, including the eleven spec files that never touched the fixture: `First argument must use the object destructuring pattern: _fixtures`.

## The lint fix passed every gate that runs on every pull request

`ci.yml` runs on every push to `master` and every pull request: install, `pnpm lint`, `pnpm typecheck`, `pnpm test` — unit tests only — and `pnpm build`. `integration.yml` runs the Testcontainers-backed integration suite once a night on a cron schedule, deliberately kept off the pull-request path so a flaky container start doesn't turn the public CI badge red. Neither workflow runs Playwright. End-to-end tests exist in the repo and are expected to pass before a phase closes, but they run when a person or an agent runs them locally, not as an automated check on every commit. So `321ce89` shipped exactly the way it looked from CI: the pull request's `lint · typecheck · test · build` check passed within two minutes of the commit, the PR merged the same day, and there was no regression anywhere a machine was watching for one.

## Finding it took a gate that doesn't run automatically

The break surfaced about a month later, during the full eight-gate matrix the 07-12 launch close-out plan runs by hand against merged `master` before signing off the v1.0.0 milestone — lint, typecheck, unit, integration, e2e, production build, docs-site build, and a Docker cold start, each with verbatim evidence, because the plan makes that evidence the phase's hard stop condition. Two of those eight gates, e2e and the Docker cold start, never run in CI at all. `pnpm test:e2e` failed immediately — a hard crash in Playwright's own fixture parser, not a test assertion. `git blame` on `tests/e2e/support/fixtures.ts` pointed straight at `321ce89`, and the commit message named exactly what it had done — clear five lint errors — with no way for that commit, on its own, to know it had also broken the test runner's contract for the one fixture it touched.

## The fix keeps both tools honest instead of picking one

Restoring `{}` on its own would satisfy Playwright and reopen the Biome error. Leaving `_fixtures` in place would keep lint green and the suite broken. The actual fix goes one step past the first option — it restores `{}` and adds a targeted suppression that names the reason instead of just overriding the rule:

```ts
// biome-ignore lint/correctness/noEmptyPattern: required by Playwright's fixture API contract
async ({}, use) => {
  await prisma.rateLimitHit.deleteMany({});
  await use(undefined);
},
```

That one line is what separates the fix from a plain revert. Biome's rule isn't wrong in general — disabling it project-wide would throw away a real signal everywhere else it fires correctly. It's wrong about this one specific `{}`, because this `{}` isn't dead code; it's an API contract Biome has no way to see. The suppression comment is where that fact gets written down, so the next person who runs the linter and wonders why one empty object survived the sweep doesn't have to reconstruct the answer from `git blame`. The commit went further than the excerpt above: five more comment lines sit over the suppression, explaining that Playwright reads this parameter as a destructuring pattern, quoting its error text, and recording that 07-09's rename to `_fixtures` is what broke the suite.

Two tools can read the identical two characters in a source file and both be right, because they're not answering the same question — which means passing one of them proves nothing about whether the change satisfies the other.

---

## Sources

- Biome — *noEmptyPattern* (`lint/correctness/noEmptyPattern` disallows empty destructuring patterns, is recommended by default, lists `function foo({}) {}` as invalid, and names ESLint's `no-empty-pattern` as its equivalent). Retrieved 2026-09-29. <https://biomejs.dev/linter/rules/no-empty-pattern/>
- ESLint — *no-empty-pattern* (an empty destructuring pattern has no effect and usually signals a mistake, typically an intended default value). Retrieved 2026-09-29. <https://eslint.org/docs/latest/rules/no-empty-pattern>
- Playwright — *Fixtures* (automatic fixtures are set up for each test even when the test does not list them; a fixture declares its dependencies through its first argument's destructuring, and the docs' own no-dependency example is written `async ({}, use, testInfo)`). Retrieved 2026-09-29. <https://playwright.dev/docs/test-fixtures>
- microsoft/playwright — *packages/playwright/src/common/fixtures.ts, main branch* (`innerFixtureParameterNames` reads the fixture's source via `fn.toString()`, rejects a first parameter not wrapped in `{}` with "First argument must use the object destructuring pattern", and the fixture pool runs that check for every fixture it registers, reporting failures as load errors). Retrieved 2026-09-29. <https://github.com/microsoft/playwright/blob/main/packages/playwright/src/common/fixtures.ts>
- microsoft/playwright — *packages/playwright/src/runner/taskRunner.ts, main branch* (errors raised during a runner task such as test loading set the run to interrupted, so later tasks, including running the tests, do not execute). Retrieved 2026-09-29. <https://github.com/microsoft/playwright/blob/main/packages/playwright/src/runner/taskRunner.ts>
