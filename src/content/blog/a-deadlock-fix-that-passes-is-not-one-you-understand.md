---
title: 'A deadlock fix that passes is not a deadlock fix you understand'
description: 'A payment-link reissue stopped deadlocking once it wrote its rows in a different order, and the race test went green four runs in a row — but that order rested on PostgreSQL firing foreign-key triggers alphabetically. The fix that merged takes its own locks in a stated order and re-checks status under them.'
category: 'Systems & Performance'
pubDate: 2026-10-14
tags: ['postgres', 'concurrency', 'testing', 'architecture']
draft: false
---

On a training-academy information system I'm building, still pre-production, a two-process race test proved that reissuing a payment link could deadlock against a customer's payment-proof upload and against a cancellation. The first fix to go green — fifteen of fifteen, four runs in a row — worked because PostgreSQL happened to check two foreign keys in a convenient order, and the write-up committed alongside it said so in its own list of leftovers. A passing race test tells you a deadlock stopped happening under the interleavings you wrote down. It does not tell you the code owns the lock order that stopped it. That took a second round the same afternoon, before anything merged.

## Several writers share two rows, and only a convention keeps their order

A registration belongs to a customer. An admin can copy a fresh payment link for that registration to send over chat — call it the copy action — which revokes the previous link, issues a new one, and writes a history row recording that a link was shared. Independently, the customer can upload payment proof through the link, an admin can cancel or transfer the registration, staff can attach a document to it, and two customer identities can be merged. Every one of those writers ends up holding the customer row, the registration row, or both.

When every writer funnels through one function, as in [a FIFO stock ledger I built earlier](/blog/race-proof-fifo-stock-ledger-postgres/), one lock settles the question. Here the writers live in different modules, so what settles it is a convention: a global lock order — customer first, registration after it, the link table last — written into the payment data dictionary, and enforced for customer-owned writes by a small helper that locks the customer `FOR UPDATE` as the first statement of the transaction. The copy action never called that helper. The only lock it took on purpose was an advisory lock that keeps two link issuances for the same registration from overlapping.

## The race test was written to retire a caveat, and it found three deadlocks

When the link feature first landed, its summary listed a gap in the evidence: no two-process test raced a link reissue against an upload through the old link. The follow-up closed that gap with a harness worth describing, because it is what makes everything after it trustworthy. Each side of a race runs in its own OS process with the full application booted. Ordering is driven by signals, not sleeps: a child pauses at a named point — transaction begin, just before commit, or right after the first statement matching a regex, so the locks that statement took are already held — and waits for a go-file from the test. Before asserting that one process waited on the other, the test polls `pg_stat_activity` until the waiting backend really is blocked on a heavyweight lock. Without that, "B waited for A" is a guess.

Nine new cases brought the race suite to fifteen. On the code as it stood, twelve passed and three died with `SQLSTATE[40P01]`: the copy action against a payment-proof upload in both interleavings, and the copy action against a cancellation. The cycle had one shape. The copy action revoked the old link first — an `UPDATE` that row-locks the link — and only then inserted its history row, whose foreign-key check needed a key-share lock on the registration. The upload or the cancellation was already holding that registration `FOR UPDATE`, and was waiting for the link row.

## Locking the contested row first moved the deadlock instead of removing it

The instinctive repair was to lock the registration `FOR UPDATE` as the copy action's first statement, so nothing could slip in underneath. It closed all three cycles. It also opened a new one. An adversarial read-only review pointed out that attaching a document to a registration follows the convention — customer first, then registration — and the race test confirmed it: fourteen of fifteen, with the new `40P01` raised on `customers`.

```sql
-- Copy action, first attempted fix: registration first. It never names the customer row,
-- but its history insert carries a foreign key to it, and that check takes a lock like any other.
SELECT * FROM registrations WHERE id = :registration_id FOR UPDATE;   -- held
INSERT INTO communication_messages (customer_id, registration_id /* ... */)
VALUES (:customer_id, :registration_id /* ... */);                    -- FK check: FOR KEY SHARE on the customer, waits

-- Document upload, unchanged and following the convention: customer first.
SELECT * FROM customers WHERE id = :customer_id FOR UPDATE;           -- held
SELECT * FROM registrations WHERE id = :registration_id FOR UPDATE;   -- waits for the copy action: cycle
```

Neither writer is wrong on its own terms. Together they take the same two rows in opposite order, which is the shape the PostgreSQL manual tells you to avoid by acquiring locks on multiple objects in a consistent order, and the one its deadlock detector resolves by aborting one of the transactions. The "lock it first" repair was rejected with that test as the evidence.

## The fix that passed rested on the order PostgreSQL fires its triggers

The version committed that morning took no new lock. It moved the history insert ahead of the link reissue and filled in the new link's id afterwards. The history row carries two foreign keys, one to the customer and one to the registration, so inserting it makes PostgreSQL check both — customer first, then registration, on the test database — before the copy action touches the link table. That matched the global order. Fifteen of fifteen, repeated four times.

Why customer first? Not because the application said so. PostgreSQL implements foreign keys with internally generated constraint triggers, and when several triggers of the same kind fire for the same event, it fires them in alphabetical order by name. The order of those two checks was a property of generated trigger names, which nothing in the application chooses or checks. The write-up committed with the fix said exactly that — proven on the test database by the document-upload case, not guaranteed by code — and listed three more leftovers: the copy action read the registration's status before taking any lock (a check-then-act gap older than this fix), the copy-versus-transfer and copy-versus-merge cycles were analysed as closed but never raced, and two concurrent copies could record history in a different order than they issued links.

## Turning the leftovers into tests failed five of twenty-two

That afternoon, before the branch merged, a second pass turned the leftover list into seven more two-process cases. Run against the morning's code, seventeen of twenty-two passed. Three failed with a wrong answer: when a cancellation, a transfer, or a merge committed first, the copy action carried on from the registration summary it had read before any of that, and issued a fresh payment link for a registration that had already been cancelled, transferred away, or moved to another identity. Two more errored instead of failing: they were built to pause inside an explicit customer lock the copy action had never taken, so the pause point was never reached.

The wrong answer had a ceiling. An upload through a link issued for a registration that was no longer active would still be refused, because the payment-submission path re-checks status under its own lock. But an admin would have been handed a link that could never be used, and the copy action would have reported success.

## The order that merged is written in the code, not left to trigger names

The design that replaced it gives the copy action its own locks, taken in the global order before anything is written, and re-checks what it read under them (comments condensed and translated from the codebase's Indonesian):

```php
private function lockForLink(RegistrationSummary $peek): RegistrationSummary
{
    // Customer first, like every other writer. FOR KEY SHARE, not FOR UPDATE: the copy action
    // never changes the customer, and FOR UPDATE would deadlock with writers that lock a
    // registration and then only reference its customer through a foreign key.
    try {
        CustomerWriteLock::acquireReference($peek->customerId);
    } catch (CustomerAlreadyMerged) {
        throw CommunicationRuleViolation::registrationChanged();
    }

    // Registration second. Taking it first is the order that deadlocked with document upload.
    $registration = $this->registrations->lockSummary($peek->id);

    // The summary read before these locks was a peek; only what is re-read under them counts.
    if ($registration === null || $registration->customerId !== $peek->customerId) {
        throw CommunicationRuleViolation::registrationChanged();
    }

    if (! $registration->isActive()) {
        throw CommunicationRuleViolation::registrationNotActive();
    }

    return $registration;
}
```

The customer lock is `FOR KEY SHARE` on purpose: the same mode a foreign-key check takes, but taken explicitly as step one. In PostgreSQL's row-lock conflict table, `FOR KEY SHARE` conflicts only with `FOR UPDATE`. It therefore queues behind the customer-owned writers and merge, which lock the customer `FOR UPDATE`, and stays out of the way of a writer that locks a registration and merely references its customer, such as the one that records a registration receipt. A cancellation or transfer that commits first now gets the copy refused as "not active"; a merge that commits first gets it refused as "changed"; neither leaves a link, a history row, or a success audit behind. Twenty-two of twenty-two, with the original fifteen still green.

Green was not the last check. A deliberate mutant switched the customer lock to `FOR UPDATE`, and the registration-receipt writer racing the copy action died with `40P01` — so the lock mode is load-bearing, and a test now guards it rather than a comment. The branch merged that afternoon with the explicit order in place.

A green race test proves the deadlock stopped; only a lock the code takes on purpose proves you know why.

---

## Sources

- PostgreSQL Global Development Group — *PostgreSQL Documentation: Explicit Locking* (`FOR KEY SHARE` conflicts only with `FOR UPDATE` in the row-level lock conflict table; PostgreSQL detects deadlocks and resolves them by aborting one of the transactions; the best defense is acquiring locks on multiple objects in a consistent order). Retrieved 2026-10-21. <https://www.postgresql.org/docs/current/explicit-locking.html>
- PostgreSQL Global Development Group — *PostgreSQL Documentation: CREATE TRIGGER* (multiple triggers of the same kind defined for the same event fire in alphabetical order by name). Retrieved 2026-10-21. <https://www.postgresql.org/docs/current/sql-createtrigger.html>
- PostgreSQL Global Development Group — *PostgreSQL Documentation: ALTER TABLE* (foreign key constraints are implemented by internally generated constraint triggers). Retrieved 2026-10-21. <https://www.postgresql.org/docs/current/sql-altertable.html>
