---
title: 'A hand-rolled after-commit step only knows about its own transaction'
description: 'A duplicate-customer scan ran right after its own transaction returned, but on the website path that transaction was only a savepoint inside the caller''s. A read-only audit, not the 1,319 tests already passing, found that bug and three more like it.'
category: 'CRM & Revenue'
pubDate: 2026-09-29
tags: ['crm', 'data-integrity', 'concurrency', 'testing']
draft: false
---

A training-academy information system I'm building, still pre-production, had 1,319 tests passing across eleven suites, with build, lint and static-analysis checks green alongside them. None of them caught four bugs in how the system tracks and merges duplicate customer records. A read-only audit with adversarial verification, instead of more tests, surfaced seven verified problems in one sitting, these four among them. None of the bugs were edge cases nobody thought to write a test for. They were assumptions nobody had written down as a claim in the first place, so there was nothing for a test to check.

## A savepoint commit is not the commit the scan was waiting for

Creating a customer record also triggers a scan for potential duplicates — matching names, emails, and phone numbers against everyone already in the system. That scan is meant to run only once the new record is durable: candidates are computed from contacts that are already saved, and a scan rolled back along with its transaction would leave a customer with no suggestions at all. So the action ran it on the line right after its own `DB::transaction()` call returned — after commit, as far as the action could tell.

Two call sites exercise that action differently. An admin creating a customer by hand calls it directly — its own transaction is the outermost one, so the scan runs the moment that commit lands. A customer registering through the public website goes through a different path, one that wraps the same action inside the registration flow's own transaction. From the action's point of view, its internal commit stopped being a real commit — its transaction was only a savepoint inside one that hadn't finished yet, and "committing" it just stepped the nesting level back down.

The bug was that on the website path the scan never waited for the real, outer commit; it ran as soon as the nested call returned, while the registration transaction was still open. A customer who committed inside that window and the new registrant were invisible to each other's scans — each scan could only see committed rows, and the other side hadn't committed yet — so the pair was never flagged.

The fix wasn't a new lock or a queue. It replaced the hand-placed call with Laravel's `DB::afterCommit()`, which holds the callback until the root transaction commits and runs it immediately when no transaction is open. The admin path behaves exactly as before; the website path now waits for the registration to land. An adversarial review of the fixes found one real defect, and it was in this one: once scans run after commit, two of them can evaluate the same pair at the same moment, so the candidate insert now runs in its own savepoint, and the scan that loses the unique-key race updates the winner's row instead of throwing after its caller has already committed.

## Hiding merged pairs also hides the evidence a merge moves

When two customer identities get merged, the absorbed record's contacts — an email, a phone number that used to sit on the other record — move to the survivor and stay active, and some of its identity attributes, such as a name or a birth date, can be copied over too. The review queue that surfaces potential duplicate pairs deliberately hides any pair where one side has already been merged; that side is no longer an active identity, and offering the pair for merging would only end in a rejection.

That hiding rule has a side effect nobody had accounted for. Suppose the absorbed record shared an email with a third customer. That pair is now hidden, because one side is merged. The survivor carries the same email now, so the survivor and the third customer are the pair that should surface — a pair that only exists because of the merge, involving a party that was never part of it. But nothing re-scanned the survivor after the merge landed, so that evidence simply dropped out of the review queue. It would stay out of the queue until some later, unrelated edit happened to trigger a fresh scan. The fix registers the same duplicate scan against the survivor, through the same `DB::afterCommit()` hook, right after the merge transaction commits — treating a merge as a change worth re-checking, not just a change worth recording.

## A plan marked done can still leave its demo step impossible to perform

The product roadmap's demo script had a step: after a merge, the audit shows why it was performed. The design spec had a matching line: the audit displays the reason. The plan that built merging was checked off, its behavior already proven in CI. The reason was, in fact, being written to the database every time a merge happened.

It just wasn't readable anywhere except a direct database query. An earlier, deliberate decision had kept the audit-event log — which every role can read — down to IDs and attribute names, never personal values, so the free-text reason stayed in the merge record and never reached that log. That decision was right on its own terms. But nobody built another surface for the reason itself, so the demo step and the spec line were both true on paper and false in the product — there was no page, table, or panel where an authorized reviewer could actually read why a merge happened.

The fix kept the decision intact: the merge's audit entry now carries a reference to its merge record, and a merge-notes section on both records involved shows the reason only to users who hold the merge permission. A Chromium browser test checks that the reason appears on both records after a merge done through the UI, rather than only asserting against a database row.

## A link outlives the identity it points to

An unsubscribe link is valid for a year and bound to whichever customer ID was current when the email went out. If that customer is later merged into another record, the link still points at an ID that no longer accepts writes — the merge correctly locks it, on purpose, to stop anything from updating a superseded identity by mistake.

Clicking that link after a merge returned an HTTP 500 — the regression test reproduces exactly that against the old code. The consent withdrawal was never recorded, and the survivor — which had inherited the old identity's "consent granted" status as part of the merge — stayed in the campaign audience for a customer who had explicitly tried to leave it. The write lock was doing exactly its job; the unsubscribe handler just wasn't asking the right question first.

The fix resolves the link's bound ID to the surviving record through the merge alias before recording the withdrawal — a narrow exception, now written into the identity decision record, to the rule that writes aimed at a merged identity are rejected rather than redirected. The lock still refuses those writes, the audit entry records the link's original ID next to the survivor's, and if a merge commits between the resolve and the lock, the handler resolves once more.

## The audit asked questions the test suite had no way to ask

All four surfaced in the same read-only pass — no code written during it. The audit split the customer-identity guarantees into seven dimensions — profiles and contacts, cross-module writes, duplicate candidates, merges, audit, private documents, demo readiness — and every finding had to survive two adversarial verifiers, one checking it against the code and one against the task's mandate. Eleven findings went in; seven came out.

The four above reduce to questions nobody had put to the code. What happens if this runs nested. What happens if this hides something on purpose. What happens if a spec line and the product itself disagree. What happens if the identity a link points to stops existing. Each fix landed as its own commit with a regression test shown to fail on the old code, and the full gate then passed twice, at 1,328 tests. But the questions came first, and no amount of running the existing 1,319 tests faster, or more often, would have generated a single one of them.

None of the four bugs failed an assertion, because none of them had one written against the assumption they broke — an audit doesn't run the suite harder, it goes looking for the claims nobody thought to encode as a test in the first place.

---

## Sources

- Laravel — *framework: src/Illuminate/Database/DatabaseTransactionsManager.php (13.x)* (after-commit callbacks registered inside a transaction run only when the root transaction commits; with no transaction open, the callback runs immediately). Retrieved 2026-09-29. <https://github.com/laravel/framework/blob/13.x/src/Illuminate/Database/DatabaseTransactionsManager.php>
- Laravel — *framework: src/Illuminate/Database/Concerns/ManagesTransactions.php (13.x)* (a `transaction()` call made while another transaction is open creates a savepoint rather than a new transaction, and committing it only decrements the nesting level; the real commit happens at level one). Retrieved 2026-09-29. <https://github.com/laravel/framework/blob/13.x/src/Illuminate/Database/Concerns/ManagesTransactions.php>
