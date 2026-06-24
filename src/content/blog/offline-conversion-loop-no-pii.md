---
title: 'Close the offline-conversion loop: send revenue back to the ad platform without leaking PII'
description: 'Your ad platform bids toward whatever signal you feed it, and most teams only feed it the lead form — so it learns to buy cheap leads, not paying customers. Close the loop server-to-server: when a lead becomes recognized revenue, send an offline conversion keyed on the click ID, with hashed PII only as a consented fallback.'
category: 'CRM & Revenue'
pubDate: 2026-06-22
tags: ['revenue', 'attribution', 'privacy']
draft: true
---

Your ad platform optimizes for cheap leads because cheap leads are the only outcome you ever let it
see. Send it money instead. Most teams fire a "conversion" the moment someone submits a lead form,
so the algorithm dutifully learns to buy more form-fills — including the junk that never pays. Your
ad platform is a controller, and it bids toward whatever signal you wire into its feedback loop; if
the only signal is "lead created," the loop is open — spend drives clicks, clicks drive leads, the
signal goes out, and then nothing comes back when the lead actually turns into money. Closing the
loop means sending an **offline conversion** back to the platform — keyed on the click ID, valued by
recognized revenue — so value-based bidding optimizes for dollars instead of form-fills. This is the
back half of the loop, it runs server-to-server from your own data, and you can close it without
shipping raw PII to anyone.

## The cheapest lead was the most expensive customer

A campaign once looked like the obvious winner on the dashboard everyone watched: lowest
cost-per-lead by a wide margin. Nobody questioned it until someone joined the leads to the deal
ledger and looked at cost-per-*customer* — and that same campaign was, quietly, the worst in the
portfolio. The leads were cheap because they were low-intent; they converted on the form and then
evaporated. The platform couldn't have known any better. The only outcome it could see was "lead
created," so it optimized hard for the cheapest way to create one.

A bidding algorithm has no opinion about your business — it maximizes whatever value you report.
Report `1.0` for every lead and you've told it that all leads are worth exactly the same, so it
finds the cheapest ones. Report the recognized revenue of the deals that *closed*, and the loss
function changes underneath it: now a $40 lead that becomes a $9,000 contract outweighs fifty $5
leads that became nothing. The instant the loop was closed — feeding back which leads became paying
customers and for how much — the algorithm re-ranked the campaigns and started starving the
cheap-lead machine. Nothing about the ad creative changed. The *signal* changed. That is the whole
game, and it is why sending the *wrong* value — the lead-time quote, the gross order total, a
refunded sale — is worse than sending nothing.

## Capture the click ID at the front door and never overwrite it

The wire that carries the conversion back is the **click ID**. Google stamps `gclid` on the landing
URL, and uses `gbraid` (app-to-web) or `wbraid` (web-to-web on iOS, under ATT) when `gclid` isn't
available. Meta gives you `fbclid` plus the `_fbp` and `_fbc` first-party cookies. This identifier is
created at the click — the front door — and if you don't capture it there, it's gone. Read it on the
first pageview, before any redirect or SPA route swap can strip the query string, and persist it as a
**first-touch fact**.

The critical discipline: you never *update* it. The first click that brought this person in is the
click the platform will want credited, and a later organic visit must not clobber it. This is
exactly the job of an [append-only identity event log](/blog/crm-identity-append-only-event/) —
every touch is an immutable row, and "the click ID that owns this lead" is a projection you compute
from the earliest `ad_click` event, not a mutable column you keep overwriting.

```sql
-- one row per touch; the click is just another immutable fact
insert into identity_events (lead_id, event_type, click_id, click_id_kind, occurred_at, source_key)
values ($1, 'ad_click', $2, 'gclid', $3, $4)
on conflict (source_key) do nothing;  -- idempotent: replaying the same touch is a no-op
```

## Match on the click ID first; fall back to hashed PII, never raw

There is a strict preference order for *how* you tell the platform "this conversion belongs to that
click," and it minimizes exposure at every step.

1. **The click ID** — deterministic, and it carries no PII of its own. It's an opaque token the
   platform minted and can match back to its own click record. This is the preferred key for both
   Google's offline conversion import and Meta's Conversions API. Send this whenever you have it.
2. **Hashed PII as a fallback** — Google's Enhanced Conversions for Leads and Meta's CAPI accept
   SHA-256 hashes of normalized email and phone, used to match when the click ID is missing or
   stale. You never send raw email or phone. You send a hash.

The order matters because the click ID reveals nothing about the human on its own, while a hashed
email is a derived identifier matchable across every other vendor who holds the same email. Reach for
the lower-exposure key first and treat hashed PII as the exception, not the default.

## Normalize, then hash — and stop calling that anonymization

The single most common implementation bug is hashing before normalizing. `Alice@Example.com ` and
`alice@example.com` must produce the *same* hash or the match silently fails, so normalization comes
first, every time. Lowercase and trim email; reduce phone to E.164 digits-only; then SHA-256 to
lowercase hex.

```ts
import { createHash } from 'node:crypto';

// SHA-256 -> lowercase hex, the format both Google EC and Meta CAPI expect
const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

export function hashEmail(raw: string): string {
  // normalize FIRST: lowercase + trim. Do NOT invent your own canonicalization —
  // collapsing alice+x@ and a.lice@ to one identity over-links sub-addresses the
  // user kept separate. Match exactly what the platform expects, nothing more.
  return sha256(raw.trim().toLowerCase());
}

export function hashPhone(raw: string, defaultCountry = '1'): string {
  // naive 10-digit -> +country assumption (NANP-shaped); a real E.164 normalize
  // needs per-country trunk-prefix handling — use libphonenumber in production.
  let digits = raw.replace(/\D/g, '');
  if (digits.length === 10) digits = defaultCountry + digits;  // assume national US/CA number
  return sha256(digits);  // E.164 digits only, no '+', no spaces/dashes/parens
}

// IMPORTANT: hashing is NOT anonymization. A SHA-256 of an email is deterministic and
// matchable — that's the entire point of sending it — and it is trivially reversible by
// dictionary attack across a known user base. It is pseudonymous personal data: consent,
// access requests, and deletion obligations all still apply to it.
```

Write that last comment into your codebase and mean it. A hashed email is still personal data under
GDPR and similar regimes — it's pseudonymous, not anonymous, precisely *because* it's deterministic
and matchable; over a known set of users a hash is reversible by simply hashing the candidates and
comparing. If it weren't matchable it would be useless to the ad platform. So the legal obligations
don't evaporate when you call `sha256()`; they travel with the hash.

## The consent boundary is the difference between sharing and leaking

"Without leaking PII" is a design constraint, not a slogan, and it resolves into a clear rule. The
exposure of the two keys differs, but the *consent* requirement does not — sending either one back to
Google or Meta to attribute and optimize bidding is ad processing, and in the EEA the platforms'
own policies require a consent signal even for click-ID-only imports.

- **The click ID** — send it for consented users the campaign touched. It's the lowest-*exposure*
  key (the platform's own token coming home, carrying no email-derived identifier), but it is not
  consent-exempt: the same ad-data-sharing consent must exist.
- **Hashed PII** — send *only* for users who consented to sharing data with ad/marketing partners.
  Consent is a column you check at upload time, not an assumption you bake in.
- **Withdrawal is undo, not just "stop next time."** When someone revokes consent or is erased, you
  stop sending their identifiers *and* you retract anything already sent — even when the sale was
  real and the money was kept. Erasure and withdrawal are their own retraction trigger, legally
  independent of any refund: you delete the already-sent conversion (Google adjustment / Meta event
  deletion keyed on `event_id`) because the person exercised their rights, not because the revenue
  reversed.

Be honest that the click ID isn't magic — it does tie back to a person inside the platform's graph.
But it's categorically less exposing than shipping an identifier *derived from their email*. The
boundary is: deterministic click token by default, hashed PII only with the same explicit consent,
and nothing at all for a user who said no.

## Send recognized revenue, not the number from the dashboard

The value you upload must be **recognized revenue** — what the business actually booked, net of
refunds — not the lead-time quote, not the gross order total, not the optimistic figure in the CRM
opportunity. Teach the optimizer with the gross total and you teach it to chase deals that get
discounted or returned. The amount has to come from the system that owns it. As established when you
[reconcile your revenue numbers across three sources of truth](/blog/reconcile-three-sources-of-truth/),
the **ledger is the anchor** for the amount; the CRM and the ad upload are downstream of it, never
the reverse.

So the batch query joins three facts: a deal that is closed-won and paid, its first-touch click ID
from the event log (if one exists), and its recognized value from the ledger — while carrying the
consent flag and excluding refunds and anything you've already uploaded.

```sql
-- build the offline-conversion upload batch
select
  d.order_id,                                   -- stable idempotency key, see below
  d.consent_ad_sharing,                          -- consent is a column, checked at upload time
  fc.click_id,                                  -- first-touch gclid/fbclid, NULL if no ad_click
  fc.click_id_kind,                             -- 'gclid' | 'gbraid' | 'wbraid' | 'fbclid'
  l.recognized_amount as value,                 -- net of refunds, FROM THE LEDGER
  l.currency,
  d.closed_at as conversion_time                -- when the value became real (the business clock)
from deals d
-- earliest ad_click per lead = the first-touch click that owns the conversion.
-- LEFT JOIN: a click-less deal survives (click_id NULL) and is routed to the
-- hashed-PII path at upload time instead of being silently dropped here.
left join lateral (
  select e.click_id, e.click_id_kind
  from identity_events e
  where e.lead_id = d.lead_id
    and e.event_type = 'ad_click'
  order by e.occurred_at asc
  limit 1
) fc on true
-- recognized revenue comes from the reconciled ledger, never the CRM quote
join ledger_revenue l on l.order_id = d.order_id
where d.stage = 'closed_won'
  and d.paid = true
  and d.consent_ad_sharing = true               -- no consent, no signal — for either key
  and l.recognized_amount > 0                   -- genuine $0 wins are intentionally excluded as
                                                -- non-monetary signal; a sale that REFUNDED to
                                                -- zero is a retraction, handled below, not a row here
  and not exists (                              -- don't re-select an already-confirmed upload
    select 1 from conversion_uploads u
    where u.order_id = d.order_id and u.status = 'accepted'
  );
```

The payload you derive from each row is click-id-first, hashed-PII as fallback:

```jsonc
{
  "order_id": "ord_8f3c",          // your idempotency key, echoed back in adjustments
  "gclid": "Cj0KCQ...",            // preferred; omit hashed_pii entirely when present
  "hashed_pii": {                  // ONLY when click_id is missing AND consent_ad_sharing = true
    "email": "b1f3...e9",          // hashEmail() output
    "phone": "a07c...4d"           // hashPhone() output
  },
  "value": 9000.00,                // recognized, net of refunds
  "currency": "USD",
  "conversion_time": "2026-06-20T14:02:00Z",
  "event_id": "ord_8f3c"           // Meta dedupe key, shared with any client Pixel for this event
}
```

## Idempotency and retraction keep you honest after the upload

Uploads get retried — networks fail, batch jobs re-run, someone replays yesterday's file. Key every
conversion on a stable `order_id` and record the platform's accepted/rejected status in
`conversion_uploads`. Double-count safety comes from two layers, not one: the `not exists` guard
stops you re-selecting an upload the platform already *accepted*, and the platform itself dedupes
in-flight sends on the conversion key — `order_id`/transaction-id on Google, `event_id` on Meta —
which covers the gap while a `pending` send awaits confirmation. The guard alone is not enough; a row
still in `pending` will be re-selected and re-sent, and it's the platform's dedupe that makes that
re-send a no-op. Idempotency here is the same discipline as `on conflict do nothing` on ingestion:
the operation must be safe to repeat.

Corrections are the part teams forget. Revenue gets refunded and clawed back, and if you don't tell
the platform, you keep teaching it that a refunded sale was a win — you're optimizing toward your own
returns. When the ledger reverses an amount, **retract or adjust** the conversion: Google supports
offline conversion *adjustments* (retract to zero, or restate the value); Meta supports deletion of a
previously sent event keyed by its `event_id`. The adjustment closes the loop in the other direction
— the feedback wire has to carry bad news too, or the controller drifts.

One last wiring note: this whole back half is **server-to-server**, running from your backend over
the Google Ads API and the Meta Conversions API on data you already own. There is no browser pixel in
it. If you also fire a client-side Pixel for the same event, dedupe on Meta by sending the same
`event_id` from CAPI so it counts once; on Google, the offline import dedupes on your
`order_id`/`gclid` rather than a browser event id. Your server holds the part the pixel never sees:
the money.

Send the lead and the platform learns to find more forms; send the money and it learns to find more customers.
