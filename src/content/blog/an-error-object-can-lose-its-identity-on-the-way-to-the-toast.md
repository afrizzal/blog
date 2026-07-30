---
title: 'An error object can lose its identity on the way to the toast'
description: 'A Meta Graph API sync failure carried a real, actionable error code the whole time. Three layers of catch-and-rethrow nearly turned it into a generic ''Failed to fetch campaign'' string before it reached the UI.'
category: 'Systems & Performance'
pubDate: 2026-08-10
tags: ['reliability', 'architecture', 'typescript']
draft: true
---

Meta's Graph API tells you exactly what went wrong. Error code 190 means the access token is expired or invalid — not "something failed," not "try again later," a specific, actionable fact you could act on immediately. The failure mode in a sync pipeline built against that API isn't Meta being vague. It's the application code between the fetch and the screen swallowing that specificity one layer at a time, until what reaches the user is a paragraph that used to be a fact and is now a shrug.

The fix in this codebase — a Meta Ads intelligence platform for a multi-branch aesthetic clinic chain — was to make one error class carry its identity through every layer that touches it, and to audit each of those layers for the specific mistake that erases identity: wrapping.

## A caught error and a re-thrown error are not the same operation

The lowest layer, `graphGet` and `paginate` in the Meta Graph client, used to `throw new Error(...)` on any API failure — a plain, structurally anonymous error. The fix was a dedicated class:

```ts
export class MetaGraphError extends Error {
  readonly code?: number;
  readonly errorSubcode?: number;
  readonly fbtraceId?: string;

  constructor(message: string, meta: { code?: number; errorSubcode?: number; fbtraceId?: string } = {}) {
    super(message);
    this.name = "MetaGraphError";
    this.code = meta.code;
    this.errorSubcode = meta.errorSubcode;
    this.fbtraceId = meta.fbtraceId;
  }
}
```

That alone doesn't fix anything. A typed error is only useful if every catch block between the throw site and the response actually preserves the type instead of re-wrapping it. `fetchCampaignDetail`, the next layer up, calls `graphGet` inside a try/catch that used to build its own error message on any failure — a reasonable-looking pattern that turns out to be the exact bug:

```ts
} catch (err) {
  if (err instanceof MetaGraphError) throw err;
  throw new Error(
    `Failed to fetch campaign ${campaignId}: ${err instanceof Error ? err.message : String(err)}`,
  );
}
```

The `instanceof` check is the whole fix. Without it, a `MetaGraphError` carrying `code: 190` and Meta's actual message ("Error validating access token: Session has expired") gets caught, its `.message` string-interpolated into a new generic `Error`, and its `code` field — never copied, because the receiving `Error` constructor has nowhere to put it — is gone. The object that reaches the caller still describes a failure. It no longer describes *this* failure.

## A prefix is also a kind of wrapping

The sync pipeline had a second place doing the same damage for a different reason: not carelessness, but a UI constraint. The Branch Performance sync toast truncates error text to roughly 120 characters so a batch failure doesn't blow out a toast component. Before this fix, a caught error got a prefix — `Failed to fetch campaign 23851...: ` — before truncation. That prefix is 30-plus characters of scaffolding that says nothing a user can act on, and it was eating into the budget that should have held the one sentence Meta actually sent. Preserving the `MetaGraphError` instance through the catch chain means the truncation now operates on Meta's own message, unprefixed, so the 120 characters that survive are the useful ones.

## The type has to survive as far as the UI decides what to render

`syncCampaignInsights`, which wraps `fetchCampaignDetail` in a loop-safe helper that promises never to throw, is where the `code` field finally gets extracted into a field the caller can read without an `instanceof` check of its own:

```ts
} catch (err) {
  return {
    success: false,
    campaignId,
    dailyRowsUpserted: 0,
    adInsightRowsUpserted: 0,
    partialErrors,
    error: err instanceof Error ? err.message : String(err),
    errorCode: err instanceof MetaGraphError ? err.code : undefined,
  };
}
```

The SSE route that streams batch progress to the browser copies `errorCode` onto every `progress` event, and does one more thing with it at the end of the batch: it scans the collected errors for `errorCode === 190` and, if found, calls `markMetaConnectionUnhealthy` exactly once — not once per failed campaign, once per batch, because a token doesn't expire per-campaign and firing the same write 40 times for a 40-campaign sync would just be redundant load with no new information:

```ts
const expiredErr = errors.find((e) => e.errorCode === 190);
if (expiredErr) {
  try {
    await markMetaConnectionUnhealthy(spaceId, 190, expiredErr.error);
  } catch (e) {
    console.error("[sync-campaigns] could not mark Meta connection unhealthy:", e);
  }
}

send({
  phase: "done",
  total,
  succeeded,
  failed,
  errors,
  connectionExpired: Boolean(expiredErr),
});
```

`markMetaConnectionUnhealthy` flips `SpaceMetaConnection.status` to `"expired"`, which is what makes the connection self-healing in the sense that matters here: the *next* thing that reads connection health — a page load, not just the sync that happened to trigger it — sees the correct state without anyone having to remember to check. The header banner on Branch Performance reads that same `status` field via a `GET /api/intelligence/meta-connection` health check and renders a thin red bar with a Fix-connection link whenever it isn't clean. The sync toast, separately, renders a "danger" variant carrying the real, truncated Meta message and the same Fix-connection link. Two surfaces, one status field, no polling loop guessing at staleness.

## The type only had to survive three hops, and it almost didn't at two of them

None of this required a new abstraction — no error-taxonomy library, no centralized error bus. It required treating "catch and re-throw" as a decision with a wrong default, not a neutral pass-through. The wrong default is: catch, and construct a new error from the old one's `.message`, because that's what a generic catch block does when you don't think about it. The right default, once you're carrying a typed error with fields worth keeping, is: catch, check `instanceof`, and re-throw the original unless you're deliberately replacing it with something more specific. Every re-throw site in a call chain is a place identity can be lost, and there's no mechanism that catches the loss for you — the type system will happily let a `MetaGraphError` get boxed into a plain `Error` and never complain, because from its perspective a new `Error` is a perfectly valid thing to throw.

The error was never vague. It took three opportunities to make it that way before someone decided not to.
