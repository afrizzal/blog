---
title: 'Three AI-generation routes had a login check and nothing else'
description: 'Auditing 263 API routes for AI spend found three image- and video-generation endpoints gated only by ''is this user logged in.'' Any tier, any role, any tenant could burn two paid providers with no cap and no way to tell whose bill it was.'
category: 'AI & Automation'
pubDate: 2026-09-29
tags: ['ai', 'security', 'reliability', 'architecture']
draft: false
---

Auditing 263 API routes on a social-media intelligence platform for a multi-branch aesthetic clinic chain found twenty that call an AI provider without ever checking a spending cap. Seven of those read the platform's own API keys straight from `process.env`, so every call billed the platform owner instead of whichever tenant triggered it. Three of the seven — the image- and video-generation endpoints behind the app's studio page — had no entry guard in the route file at all. The only thing standing between an authenticated request and an unmetered call to two paid providers was `authorized: !!token`, a middleware check that answers "is this a logged-in user" and nothing more specific than that.

## A generic auth check answers a different question than a spending guard

Classified by the entry guard each route file actually calls, 12 of the 263 routes had none whatsoever. Nine of those twelve are intentionally public — a health check, a webhook receiver, things that have to answer before anyone's identity is known. The other three were `vio-generate`, `vio-pipeline`, and `vio-video`: real, expensive AI actions, reachable by any authenticated user regardless of tier, role, or tenant, protected by exactly the same middleware clause that guards a route with nothing to protect.

**Authentication** answers *who is making this request*. It says nothing about *whether this specific action is one they're entitled to trigger, repeatedly, at someone else's expense*. Those are different claims, and a route that only checks the first one is implicitly assuming the second one doesn't need checking — which is true for a read, and false for anything that calls out to a metered provider. The fix borrowed a pattern the codebase had already gotten right elsewhere:

```ts
// app/src/app/api/vio-generate/route.ts (trimmed)
export async function POST(req: NextRequest) {
  const user = await requireFeature("studio", "view");
  if (user instanceof NextResponse) return user;
  const groupId = user.groupId ?? "";
  const spaceId = groupId ? await getActiveSpaceId(groupId, req, user) : null;
  if (!spaceId) return NextResponse.json({ error: "No active space" }, { status: 400 });
  try {
    await assertAiBudget(spaceId, groupId || null, "vio-generate");
  } catch (err) {
    if (err instanceof AiBudgetExceededError) {
      return NextResponse.json(
        { error: "AI usage cap reached for this workspace this month" },
        { status: 429 },
      );
    }
    throw err;
  }
  // ...key lookup, prompt reformatting, and the actual generation call follow
```

`requireFeature("studio", "view")` replaces the bare auth check — at `view`, not the `run` tier that generation would require on access-control grounds alone. The route had never called `requireFeature` at all, so every authenticated user's *de facto* access to this action was whatever an unchecked call implies: unconditional. Gating at `run` would introduce a new 403 for every default-role user, whose studio tier falls back to `view` unless someone raises it explicitly — a product decision about who's allowed to spend, not a security necessity.

The first version of the fix did gate at `run`; the same day it was walked back to `view` for exactly that reason. Gating at `view` closes the actual gap (every request to these three routes now passes through the feature-tier system) while changing access only for accounts explicitly set to `none`, which are now correctly refused; the run-versus-view question was treated as a product decision outside the security change, so the urgent fix wouldn't wait on a sign-off it didn't need. That one call is the whole access-control fix. Everything below it in the function — the budget assertion, the space resolution, the usage record — is a second, independent problem that a tier check alone doesn't solve.

## A budget check has to run before the call, not after it

`generate-image/route.ts`, the sibling image-generation route, already had the shape the three vio-* routes were missing:

```ts
// app/src/app/api/generate-image/route.ts (trimmed)
let key: string;
try {
  await assertAiBudget(spaceId, groupId || null, "generate-image");
  key = await getGeminiKeyForSpace(spaceId);
} catch (err) {
  if (err instanceof AiBudgetExceededError) {
    return NextResponse.json({ error: "AI usage cap reached for this workspace this month" }, { status: 429 });
  }
  if (err instanceof MissingAiKeyError) {
    return NextResponse.json({ error: "AI key not configured for this workspace" }, { status: 402 });
  }
  throw err;
}
```

`assertAiBudget` runs before the API key is even resolved, let alone before the provider is called. Order is the entire point: a budget check placed after the request already went out isn't a budget check, it's a receipt. There's no way to un-bill Anthropic or Viostudio because a database row said afterward that the tenant was over their cap. The only place a cap can mean anything is upstream of the call it's supposed to prevent.

The other half of the same discipline is easy to skip because skipping it doesn't cause an error — it just quietly breaks the feature:

```ts
void recordAiUsage({ spaceId, groupId: groupId || null, provider: "viostudio", feature: "vio-generate" });
```

This has to fire on every success path. Without it, the counter `assertAiBudget` reads never moves, the cap never trips, and the 429 above becomes decorative — present in the code, never reachable in production, indistinguishable from a working gate until someone actually checks the numbers. Threading `assertAiBudget` before the call and `recordAiUsage` after a successful one onto the three vio-* routes plus the other four env-key routes wasn't seven separate fixes; it was one pattern, already proven in `generate-image/route.ts`, that just hadn't propagated to every route that needed it.

## Usage that isn't tied to a tenant can't be capped per tenant

The seven routes reading platform keys straight from `process.env` — Anthropic and Viostudio on the vio-* routes, Anthropic, OpenAI, and Gemini on the other four — shared a second problem underneath the missing budget check: five of them never resolved a `spaceId` at all. A per-tenant cap is meaningless without knowing which tenant made the call, so `getActiveSpaceId(groupId, req, user)` plus a 400 when no space is active had to land on those five before `assertAiBudget` had anything real to key off.

The provider invoice still landed on the platform owner after the fix — moving it to the tenant is the BYOK conversion deferred below — but every call was now attributed to the tenant that triggered it and counted against that tenant's cap. Reading a shared key from the environment without resolving a tenant isn't just a budget-gate gap, it's the absence of the attribution step a budget gate depends on. You can't cap what you never counted, and you can't count what you never attributed.

## The fix stayed inside the boundary of what it could verify was safe

Which tier vio generation should finally require stayed a product decision, and there was a practical reason not to rush it: tier grants are cached in the session JWT at sign-in, so raising a route's required tier means planning a production release around stale tokens — a different risk profile from adding a budget check to seven routes that already required auth and just skipped the spend guard.

Converting these seven to BYOK (bring-your-own-key) was considered and deferred for a sharper reason: the `AiProvider` type didn't have `openai`/`viostudio` entries, and `ALLOW_PLATFORM_KEY_FALLBACK` wasn't yet set on the production VM — flipping to BYOK that day would have returned 402 to every tenant who hadn't configured their own key, trading a cost leak for an outage. Thirteen other AI-calling routes that resolve their keys through a shared `lib` helper rather than reading `process.env` directly also lacked the cap; they were deferred to a later pass, and a follow-up gave them the same gate four days later.

None of those deferrals were accidents — each was something the fix explicitly declined to do in the same commit, because each one required a decision this change wasn't scoped to make safely. A security fix that also ships a half-considered second fix is two fixes at different confidence levels wearing one commit message.

One gap was an accident, and it sat inside the pattern being copied. As first written, `assertAiBudget` skipped the cap entirely for any space holding a single active BYOK connection, so a space that had brought only its own scraper key could still burn the platform's Anthropic, Gemini, and Viostudio keys without limit. An architecture review caught it, and the same round of follow-up fixes that capped the thirteen routes made the gate payer-aware: the cap now lifts only when the space holds its own key for every provider the call touches, and Viostudio, which has no BYOK path, is always capped.

Almost no visible consequence shipped alongside the fix: because the guard landed at `view` — the lowest default any role gets — the only new 403s go to accounts an admin had explicitly set to `none` for the studio, which is the tier contract doing what it says.

A login check tells you who is asking; only a check that runs before the provider is called, keyed to whoever's actually going to be billed, tells you whether they're still allowed to spend.
