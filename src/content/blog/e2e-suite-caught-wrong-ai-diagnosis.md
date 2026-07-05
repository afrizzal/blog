---
title: 'My E2E suite caught a wrong AI diagnosis — then it caught mine too'
description: 'An AI agent blamed a failing Playwright test on Next.js response caching. I traced the code and blamed middleware. We were both wrong about the observation: the test''s "anonymous" context was quietly authenticated. Two stacked bugs, two confident stories, and the re-run as the only reviewer that counted.'
category: 'AI & Automation'
pubDate: 2026-07-05
tags: ['ai', 'testing', 'nextjs', 'reliability']
draft: false
---

An AI coding agent investigated a failing E2E test in my helpdesk project and delivered its verdict with everything a good bug report has: a mechanism (Next.js was caching an authenticated response and replaying it to anonymous users), evidence (every sibling route declares `force-dynamic`; this one doesn't), an experiment ("confirmed: a fresh cookie-less context got 200 instead of 401"), and a one-line fix. The verdict was wrong. I know because I checked — traced the request path, found a real bug in my middleware, wrote up my own confident explanation, applied my fix, and watched the same test fail with the same 200. My story was wrong too. A diagnosis, it turns out, is just [model output with no schema on it](/blog/llm-step-behind-a-schema/) — including the diagnoses I produce myself. The only schema prose ever passes through is the re-run.

## A red test and a confident story

AIDA is an open-source, self-hostable helpdesk I'm building in public, and since the product's pitch is AI-with-a-human-gate, the development workflow is AI-heavy too — agents run scoped passes under review. One of those passes generated a Playwright E2E suite: twenty-nine tests across public intake, the shared inbox, SLA timers, attachments, and authorization. Twenty-eight passed. The agent left one red on purpose, flagged it as a product bug it had discovered, and wrote it up.

The test itself is simple. Upload an attachment as an authenticated agent, confirm the download works, then fetch the same `/api/attachments/{id}` from a brand-new browser context carrying no cookies. Expected: 401. Observed: 200.

The write-up, condensed but faithful:

> `GET /api/attachments/[id]` is missing `export const dynamic = "force-dynamic"`. Every sibling route that reads session state declares it — this one doesn't. Next.js can cache the first authenticated response and serve it back to a later unauthenticated requester for the same attachment ID (confirmed: fresh cookie-less context got 200 instead of 401 on a second request). A one-line fix.

If that's true, it's a vulnerability — file bytes cached under a URL and handed to whoever asks next. And notice everything the report does right: it names a real Next.js mechanism, grounds itself in the codebase's own conventions, and claims an experimental confirmation. It reads like a senior engineer. Here's the route it indicted:

```ts
// src/app/api/attachments/[id]/route.ts (trimmed)
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  let scoped;
  try {
    scoped = await getScopedDb(); // reads the session from request headers — throws for anonymous callers
  } catch {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  // ...workspace-scoped lookup, then stream the file...
  return new Response(new Uint8Array(buffer), {
    headers: { "Cache-Control": "private, no-store" }, // even the browser is told not to keep this
  });
}
```

Nothing in the report is checkable as prose. Fluency, specificity, the word "confirmed" — these are exactly the features a language model optimizes for, and they attach to wrong explanations as smoothly as to right ones.

## The story could not survive its own crime scene

Four facts, each independently fatal to the caching theory, all sitting in files the agent had just been working with.

First: the suite runs against `next dev`. The agent's own global setup spawns the dev server on port 3100. Development mode doesn't serve route handlers from a production cache — whatever went wrong here went wrong live, per request.

Second: GET route handlers stopped being cached by default in Next.js 15. The [version 15 upgrade guide](https://nextjs.org/docs/app/guides/upgrading/version-15) says it in one sentence: "GET functions within Route Handlers are no longer cached by default." This project runs Next 16. The default the fix was defending against had been retired two major versions earlier.

Third: the route reads the session. `getScopedDb()` reaches into request headers, and a route that touches request headers is dynamic by definition. There is nothing left for `force-dynamic` to force.

Fourth: the one successful response path sets `Cache-Control: private, no-store`, explicitly.

Any one of these kills the theory. What interests me is the shape of the miss. The agent didn't trace the request — it matched a pattern: siblings declare `force-dynamic`, this file doesn't, there's a red test nearby, therefore the missing declaration is the bug. The convention it leaned on is even real, but it exists for a different mechanism entirely: those siblings are pages that read the database, marked dynamic so `next build` won't prerender them at build time. Convention-shaped reasoning instead of mechanism-shaped reasoning — the same reflex as [adding an index because the query is slow](/blog/index-that-made-the-query-slower/), and it fails the same way: plausibly.

And "confirmed" deserves its own small autopsy. Confirmed what, exactly? The agent re-observed the symptom — an anonymous request got 200, again. But a symptom that several competing hypotheses all predict confirms none of them. What you want is a **differential observation**: a fact the hypotheses disagree on. For the caching story, any of the four facts above qualified. I'm flagging the rule now, with some discomfort, because knowing it did not save me in the next section.

## Follow the request — and fall for the same trap

Trace a cookie-less request toward that route and it never arrives. It dies in middleware:

```ts
// src/middleware.ts — the actual suspect
const PUBLIC_PREFIXES = ["/login", "/setup", "/api/auth", "/api/health", "/request", "/status", "/api/public"];
// /api/attachments is NOT in this list, and the matcher covers everything except static assets.

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (PUBLIC_PREFIXES.some((p) => pathname.startsWith(p))) return NextResponse.next();

  const sessionCookie = getSessionCookie(request);
  // Right answer for a page. For an API route it converts "unauthorized" into "here, have some HTML".
  if (!sessionCookie) return NextResponse.redirect(new URL("/login", request.url));
  return NextResponse.next();
}
```

No cookie and not a public prefix, so the middleware answers with a redirect — `NextResponse.redirect` defaults to a 307 — pointing at `/login`. Playwright's `APIRequestContext` [follows redirects by default](https://playwright.dev/docs/api/class-apirequestcontext), up to twenty of them. The login page is public and renders happily. Final status of the chain: 200. Case closed, I wrote: the 200 that "confirmed" the caching theory was just the login page saying hello.

The middleware bug is real, and worth fixing on its own merits. An API surface that answers "unauthorized" with an HTML detour and a success status at the end is a wrong interface — [a status code is a promise](/blog/omnisync-http-202-is-a-promise/), and this chain breaks it for every authenticated API route in the app, not only the one under test. So the fix went into the class, not the instance:

```ts
if (!sessionCookie) {
  // Machine clients get machine-readable truth; humans get the login page.
  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  return NextResponse.redirect(new URL("/login", request.url));
}
```

The layering stays honest, too: `getSessionCookie` only proves a cookie exists, not that it's valid, so the route's own session check remains the real gate underneath. Satisfied, I re-ran the suite to collect my green checkmark.

## The test stayed red

Same test, same assertion, same 200. Except now the failure was impossible: the dev server's timing logs itemize the middleware on every request, and its new branch is six type-checked lines that cannot answer a cookie-less `/api/` request with anything but 401. Impossible failures are the most informative kind. If a cookie-less request must get 401 and this request got 200, then the request was not cookie-less.

The tell had been sitting in the spec the whole time. The "anonymous" call used a *relative* URL — `anonContext.request.get('/api/attachments/...')` — and it worked. A manually created context has no idea what host to resolve that against, unless it inherited `baseURL` from the config. And that's exactly what happens: when the browser comes from the test fixture, Playwright's `browser.newContext()` [inherits the config's `use` options](https://playwright.dev/docs/test-use-options). Not just `baseURL` — all of them, including this spec file's `test.use({ storageState: 'admin.json' })`. The "fresh cookie-less context" had been signing every request as the admin from the moment it was created.

So the 200 — the agent's 200, my 200, every 200 this test ever produced — was an authenticated download working exactly as designed. Not a cache replay. Not a login page. And here's the part that stings: the differential observation I'd lectured about, the response's `Content-Type`, would have read `image/png`. One field would have killed my login-page story instantly — while looking, superficially, like support for the agent's cache story. A differential observation only separates the hypotheses you aim it at. The four static falsifiers ruled out caching; the bytes ruled out my redirect; what survived both cuts was a theory nobody had proposed — the test's own premise was false.

The test-side fix is the documented one-liner for exactly this trap:

```ts
// A bare newContext() inherits test.use — including the admin storageState.
// Only an explicit empty state makes this context actually anonymous.
const anonContext = await browser.newContext({ storageState: { cookies: [], origins: [] } });
```

The assertion never changed. `expect(anonRes.status()).toBe(401)` was correct on the day the agent wrote it; the fixture underneath it was lying about being anonymous. With the context genuinely cookie-less and the middleware genuinely speaking JSON, the request finally met the 401 the assertion had demanded all along — and the full suite went 24 for 24.

## Trust the test, interrogate the story

The same model wrote the test and the diagnosis, and the asymmetry between those artifacts is the whole lesson. The test's assertion stayed correct through two wrong explanations — the agent's, then mine — because a test is a claim the runtime countersigns on every run. Prose gets no countersignature. Not the agent's prose, and not mine: my middleware story was built from real code, cited a real bug, produced a fix worth shipping, and still misdescribed the observation in front of me.

The industry numbers say none of this is unusual. In Stack Overflow's [2025 developer survey](https://survey.stackoverflow.co/2025/ai), 66% of developers named "AI solutions that are almost right, but not quite" their top frustration with AI tools. METR's [randomized controlled trial](https://metr.org/blog/2025-07-10-early-2025-ai-experienced-os-dev-study/) of experienced open-source developers is blunter: participants estimated AI made them 20% faster while it measurably made them 19% slower. The gap between how convincing assistance feels and what it did is a measured effect — and an almost-right diagnosis is its purest form, because it arrives pre-argued.

So, the protocol I'm keeping — each step bought with a specific embarrassment from this incident:

Demand the mechanism, not the fix. One causal sentence: this request takes this path and produces this observation. "Sibling files do X" is a convention, not a mechanism.

Ask what "confirmed" means. If re-observing the symptom is the confirmation, it confirms every theory that predicts the symptom — including ones nobody has proposed yet.

Collect the differential observation; don't just name it. I identified `Content-Type` as the deciding field and never read it. Naming the experiment is not running it — and aim it at the right pair, because a field that separates theory A from theory B may separate neither from the truth.

Re-run predicting the flip. Applying a fix and expecting one specific test to change state is the cheapest arbiter there is. My middleware fix was correct and the test still failed — that non-flip was the single most informative observation of the whole investigation, and it cost one command.

Interrogate the test's premises, not only the code's. An assertion can be right while its fixture lies. "Anonymous" was a claim in a variable name, not a property anything had verified.

AIDA's product pitch is that AI drafts and a human approves before anything reaches a customer. This incident was that contract applied twice over: the agent drafted a diagnosis, and approving it rightly meant tracing it — then my own trace turned out to need the same gate, and the only reviewer senior enough was the runtime.

A test is a story the runtime has to countersign; a diagnosis is a story you have to countersign yourself.
