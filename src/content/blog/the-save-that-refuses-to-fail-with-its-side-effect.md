---
title: 'The save that refuses to fail with its side effect'
description: 'A Google Reviews listing-confirm route taught me that ''it saved'' and ''everything it triggered afterward also worked'' are two different claims, and a response body should never merge them into one.'
category: 'Systems & Performance'
pubDate: 2026-07-16
tags: ['reliability', 'architecture', 'nextjs']
draft: false
---

A route that persists a resource and then kicks off a dependent action has two outcomes to report, not one. On a multi-branch aesthetic clinic chain's internal ops dashboard, the endpoint that links a branch to a Google Maps listing does exactly that: it writes the branch's `googlePlaceId`/`googleMapsUrl`, then immediately runs the first review sync so the branch has data the moment the wizard closes. The obvious implementation wraps both steps in one try/catch and returns 500 if either fails. The actual implementation doesn't, and the reason is that a sync failure five seconds after a successful save is not the same category of failure as the save itself failing.

## The save and the sync live in two different failure domains

```ts
// Run first sync — this creates the first GoogleReviewSnapshot. A sync
// failure here must NOT roll back the saved listing or 500 the request —
// the listing persist above already succeeded.
try {
  const syncResult = await syncBranch(branchId, user.groupId ?? "", user, request)
  return NextResponse.json({ success: true, syncResult })
} catch (syncErr) {
  console.error("[google-reviews/listings/confirm] first sync failed:", syncErr)
  return NextResponse.json(
    { success: true, syncResult: null, warning: "Listing saved; initial sync failed — use Sync now to retry" },
    { status: 200 }
  )
}
```

The `prisma.branch.update()` that maps the branch to a place ID happens outside this block, unconditionally, before the sync is even attempted. By the time `syncBranch()` runs, the thing the user asked for — "remember this branch's Google listing" — has already durably happened. `syncBranch()` calls Apify's Google Maps scraper over the network, which fails for reasons that have nothing to do with whether the mapping is valid: rate limits, a transient scrape timeout, Apify itself being slow. None of those are reasons to tell the user their save didn't work, and none of them are reasons to undo a write that already committed. A single try/catch around both steps would have forced a choice between two wrong answers: report success and hide the sync failure, or report failure and imply the mapping needs to be re-entered when it doesn't.

## The response body carries a third state, not two

The naive shape for this response is a boolean — `success: true` or `success: false`. That shape can't represent "the thing you asked for happened, but a step that depends on it didn't." The actual response adds a `warning` field alongside `success: true` and sets `syncResult: null` instead of a populated sync payload, and it does this with an HTTP 200, not a 207 or a custom status — the request succeeded; the caller doesn't need to special-case the status code to find out something is off, it needs to read the body. The listings UI checks for `warning` and renders it as an amber "saved, but…" state rather than either a green success toast or a red error toast, because neither of those is honest about what happened.

The same three-state shape shows up again one layer up, in the SSE stream that bulk-syncs every branch on the Overview page:

```ts
// One branch failing must not abort the batch — the operator needs
// per-branch outcomes, not a single pass/fail for the whole run.
try {
  await syncBranch(b.id, groupId, user, request)
  succeeded++
  send({ phase: "done", branchName: b.name, index, total })
} catch (err) {
  failed++
  failedBranches.push(b.name)
  console.error("[google-reviews/sync-all] branch sync failed:", err)
  send({ phase: "failed", branchName: b.name, index, total, error: "Sync failed" })
}
```

One branch's scrape timing out doesn't abort the batch — the loop keeps going, and the stream ends with a `complete` event carrying `succeeded`, `failed`, and `failedBranches` as three separate numbers instead of a single pass/fail flag for the whole run. A dashboard that syncs fourteen branches and shows "13 done, 1 failed: Branch 07" gives the operator something actionable — retry that one branch — instead of forcing them to either distrust a false "all synced" or re-run all fourteen because one timed out.

## Acknowledging a write and acknowledging its consequences are different claims

The instinct to collapse a multi-step operation into one status code comes from treating "did the API call succeed" as the only question worth answering. It isn't, once a route's job is to trigger something downstream that the caller cares about independently — a sync that populates the dashboard, a batch job that touches other branches, a notification that may or may not have gone out. The response has to be able to say "yes" to the first question and "not yet" to the second, in the same payload, without forcing the caller to guess which claim the status code was actually about.

If the route had gone the other way — one try/catch, 500 on any failure — the failure would look like this: Apify rate-limits the first sync, the wizard shows a red "save failed" toast, and the operator re-enters a mapping that had in fact committed seconds earlier. Their second attempt rewrites the same `googlePlaceId` and fires the same sync again — harmless at best, and at worst the opening of a support thread about saves "randomly failing" in which every single save succeeded.

A 200 that means "saved" and a 200 that means "saved and everything downstream also worked" look identical on the wire unless the body is built to tell them apart.
