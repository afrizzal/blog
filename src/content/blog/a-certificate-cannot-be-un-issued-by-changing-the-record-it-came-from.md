---
title: 'A certificate cannot be un-issued by changing the record it came from'
description: 'A training-academy information system never auto-revokes a certificate when the completion record behind it changes. A cancelled batch, a corrected attendance record or a superseded override opens a review instead, because revocation can''t be undone and a stale credential can''t be left silently valid.'
category: 'Systems & Performance'
pubDate: 2026-10-20
tags: ['data-integrity', 'architecture', 'reliability', 'postgres']
draft: false
---

A completion record is never really final. A batch gets cancelled after some of its training days have already run. An attendance correction makes the completion rules re-evaluate a participant who was already marked complete, and the answer flips. A manual override gets replaced when corrected evidence comes in. On a training-academy information system I'm building, any of those can land on a registration that already has a certificate — a document the participant may already have downloaded and shown to someone. The system's answer is deliberately inconvenient: it never revokes the certificate automatically, never regenerates it, and never pretends nothing happened. It opens a review, and only a person can close it.

## An issued certificate can be wrong in two directions, and code cannot pick between them

Until issuance, "is this person certified" is a query against live state: evaluate the completion rules, check payment, return an answer. Issuance turns that answer into a numbered PDF behind a download link, and from then on "update the row" and "fix the problem" stop being the same operation. When the record underneath changes, there are two ways to get it wrong. Revoke automatically, and a correction that later turns out to be mistaken has already killed a credential — and revocation here is final: it can't be undone, and the certificate number is never reused. Do nothing, and a credential stays valid that the record no longer supports.

The decision log rules out both. Revocation is irreversible, so it may not be automatic; the project charter separately requires that a credential never be left valid silently. What's left is a third option: record that the question exists, block anything that would build on top of it, and make a person answer it.

## Four kinds of change open a review, and none of them touches the certificate

Completion decisions live in an append-only ledger — a change writes a new row, never an edit — and each time the rules write a new decision, a review writer checks it against four triggers, in order:

- `batch_cancelled` — the batch was cancelled while the participant held an active certificate, or had previously been marked complete.
- `registration_exited` — the registration was cancelled or transferred out while it held an active certificate.
- `override_superseded` — the previous decision was a manual override, and changed evidence has now produced a rule-based one in its place, so an override is never kept or dropped without someone noticing.
- `completion_changed` — the new decision is anything other than complete while the registration holds an active certificate.

"Active" means issued or still being generated. The first match wins, so one decision opens at most one review. The writer inserts it with `ON CONFLICT DO NOTHING` against a partial unique index, which allows only one open review per registration-and-trigger pair while still letting the same pair open again later, once an earlier review has been resolved. That's a database guarantee rather than an application convention: a re-evaluation that runs twice, or a second code path added months from now, can't duplicate an open question, because the constraint doesn't care which code is asking. An audit entry is written only when a row was actually inserted.

Opening a review changes nothing on the certificate. No status flips, no document is regenerated, nothing is revoked. What it does change is eligibility: while a review is open, that registration can't be issued a certificate or re-issued one until a person resolves it. Administrators see the open count as a badge on the review page's navigation entry and per participant in the batch's certificate widget — a question waiting for an answer, not a verdict already rendered.

## Three ways to close a review, and none of them is automatic

A review resolves into exactly one of three outcomes:

- **Keep** re-affirms the certificate as issued. It requires a typed reason of 10 to 500 characters, because "keep" without a reason is indistinguishable from nobody having looked. The decision log rejected a review list derived purely from current state for exactly that reason: it would have no way to record "kept, and here's why."
- **Revoke** hands off to the certificate's own revocation action, the same one an administrator can run directly. Only super administrators may use it, it needs the same typed reason, and it applies only to a certificate that has actually been issued.
- **No action** is accepted only when the registration has no active certificate at all — a cancelled batch whose participant had been marked complete but never received a certificate, for instance.

A review resolves once. The application checks that before it writes, and the database enforces it independently of the application:

```sql
-- One OPEN review per (registration, trigger): partial, not a plain UNIQUE,
-- because the same pair may legitimately reopen after an earlier one closed.
CREATE UNIQUE INDEX certificate_reviews_one_open_per_trigger
  ON certificate_reviews (registration_id, "trigger") WHERE resolved_at IS NULL;

-- The runtime role can never delete a review or edit how it was opened;
-- the resolution columns are the only thing it is allowed to write.
REVOKE UPDATE, DELETE, TRUNCATE ON certificate_reviews FROM app_role;
GRANT UPDATE (resolved_at, resolution, resolution_reason, resolved_by, updated_at)
  ON certificate_reviews TO app_role;

-- A column grant can't say "only once"; a trigger can. A second resolution,
-- or any update that doesn't resolve, fails whichever code path sent it.
CREATE OR REPLACE FUNCTION certificate_reviews_resolve_once() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.resolved_at IS NOT NULL THEN
    RAISE EXCEPTION 'certificate_reviews.% is already resolved', OLD.id;
  END IF;
  IF NEW.resolved_at IS NULL OR NEW.resolution IS NULL THEN
    RAISE EXCEPTION 'certificate_reviews.% may only be updated to resolve it', OLD.id;
  END IF;
  RETURN NEW;
END;
$$;
```

The grant and the trigger do different jobs. The grant fixes which columns can change: what kind of change opened the review, the snapshot of what changed, and who opened it and when are all frozen once the row exists, and nothing can delete it. The trigger fixes how often: a column grant can't tell the first write to `resolution` from the second, so the resolve-once rule has to live in a trigger. A check constraint covers the last gap at the same level — a `kept` resolution with an empty reason is rejected by the database, not just by the form. A future resolver that forgets its status check, or an action that runs twice, hits the database before it can rewrite a decision someone already made.

## Revoking a certificate closes every open question about it

Revocation doesn't stop at the certificate. Whether it comes through a review or from an administrator revoking directly, the action also closes every other open review on that registration, recording each one as revoked instead of leaving it to point at a certificate that no longer stands. Without that step, an administrator working through the list later would be asked to keep or revoke something there's nothing left to act on.

The same action kills the certificate's download link. Certificate links have their own purpose, with a 30-day expiry by default, and that purpose is exclusive: sending a fresh certificate link revokes the previous one for the same registration. Revocation revokes links of that purpose only. A payment link, an RSVP link or a feedback link on the same registration is left alone, because revoking a certificate says nothing about whether someone should still reach their payment page. That scoping is the point of the change. Before it, revocation revoked no links at all, because the only bulk revoke available worked on the whole registration and would have taken RSVP and feedback links down with it; the download page re-checked the certificate's status on every request instead, as it still does.

Batch cancellation follows the same logic from the other side. Cancelling a batch closes its registrations' payment, RSVP, test and feedback links, but deliberately not the certificate link, which stays live for as long as the certificate is issued. A cancelled batch is a reason to review a certificate, not a reason to quietly break it.

## Every open and every close leaves an audit entry with a name on it

Every review that opens writes an audit entry, and every resolution writes another, with who resolved it and the reason they gave. A revoked certificate's public verification page shows that it was revoked, without the reason — but the reason exists, attached to a person rather than to "the system decided." That's the record that has to exist on the day someone asks why a certificate from a cancelled batch still reads as valid: a specific administrator's stated reason for keeping it.

The certificate already left the building; the only honest move left for the database is to ask a person what to do about it.
