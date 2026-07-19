---
title: 'One writer, one lock: a race-proof FIFO stock ledger on plain PostgreSQL'
description: 'Two POS terminals sell the last unit in the same second. Inventory survives that only if every stock mutation goes through one function, one advisory lock, and one idempotency key — and if sub-cent rounding residue dies the moment stock hits zero.'
category: 'Systems & Performance'
pubDate: 2026-07-09
tags: ['postgres', 'concurrency', 'data-integrity', 'architecture']
draft: false
---

An ERP's inventory module is where three unforgiving problems arrive at once: concurrency (two POS terminals selling the same last unit in the same second), money (FIFO cost of goods has to sum exactly — an auditor does not accept "close"), and retries (documents get reposted, requests get replayed). Building SentraOps — a study-case ERP I designed around the workflows of a multi-branch aesthetic clinic chain — I settled the whole knot with a design that fits in one sentence: every stock mutation in the system goes through one function, which takes one lock, keyed by one identity, and appends to one ledger. Balances, valuation, reports — everything else is derived.

The invariant that design defends is blunt: `stock_balances.totalValue` must equal the sum of `stock_ledgers.valueDelta`. Not approximately — exactly, to the cent, forever. The moment you tolerate a cent of drift, you lose the ability to tell rounding noise from a real bug, and a stock ledger that might be wrong is a stock ledger nobody trusts. The whole post is about what it takes to keep that equality under concurrency, FIFO costing, and decimal arithmetic — on nothing but PostgreSQL.

## Every mutation walks through one door

The ERP has 40 API routers — purchasing, sales, POS checkouts that explode bundle items into component deductions, stock adjustments, returns. Not one of them writes to the stock tables directly. They all call `postStockMovement`, whose doc comment (the codebase is in Indonesian) translates to: *"The only writer of `stock_ledgers` + `stock_balances` (the physical columns onHand/totalValue/avgCost) + `stock_cost_layers`. MUST be called inside the caller's `prisma.$transaction`."*

That second sentence is structural, not just convention:

```ts
type Tx = Prisma.TransactionClient;

export async function postStockMovement(tx: Tx, input: StockMovementInput) {
```

The function takes a `TransactionClient`, not the Prisma client — a caller has to go out of its way to sidestep the requirement (a handful of POS routers do, with a cast, though still from inside a transaction). The point stands: a goods issue is never just a stock write. The caller's transaction also updates the document status and posts the GL journal, and all three commit or roll back together. A crash between "stock deducted" and "journal posted" is not a cleanup script waiting to be written; it is a rollback.

The alternative — `UPDATE stock_balances SET ...` scattered across 40 routers — doesn't fail loudly. It fails the way inventory always fails: a few cents here, one phantom unit there, until the shelf count and the system disagree and nobody can say when the divergence started. A single writer means every quantity that ever changed has exactly one code path and one audit row.

## Lock the identity, not the row

The obvious way to serialize concurrent movements is `SELECT ... FOR UPDATE` on the balance row. It has a hole: the row might not exist. The very first receipt of a new item in a new warehouse has no balance row to lock, and two first receipts racing each other both find nothing, both insert, and one of them loses. Locking a row cannot protect the creation of that row.

So the lock is taken on the *identity* instead of the row — a PostgreSQL advisory lock on a hash of the composite key:

```ts
// 1) Advisory lock per identitas balance — serialisasi semua movement utk
//    (company,item,variant,warehouse), termasuk saat baris balance belum ada.
const lockKey = `${companyId}:${itemId}:${variantId}:${warehouseId}`;
await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`;
```

The comment doesn't hedge: serialize all movements for `(company, item, variant, warehouse)`, *"including when the balance row doesn't exist yet."* `pg_advisory_xact_lock` blocks until the lock is free and releases automatically at commit or rollback — no unlock bookkeeping, no leaked locks from a crashed request. `hashtextextended` turns the string key into the 64-bit integer the lock API wants. Two cashiers racing for the same last unit queue up for microseconds instead of corrupting a balance; movements for *different* items don't contend at all, which is the part `LOCK TABLE` could never give you.

The scope is deliberately narrow, too. One item in one warehouse is one lock — a busy POS terminal selling item A never waits behind a goods receipt for item B.

## Reposting a document must be a no-op

Retries are not an edge case in an ERP. A network blip mid-request, a POS terminal replaying after a Wi-Fi drop, a document reposted after a reversal — the ledger's answer to all of them is an idempotency key composed from the business reference, not a random token:

```ts
const idempotencyKey = `${referenceType}:${referenceId}:${referenceLine}:${direction}`;

// ... advisory lock taken here (previous section) ...

// 2) Idempotency: post ulang dengan key sama → no-op (kembalikan baris existing).
const existing = await tx.stockLedger.findUnique({ where: { idempotencyKey } });
if (existing) return existing;
```

Goods receipt #1042, line 3, direction IN has exactly one legal ledger row, ever. Post it twice and the second call returns the first call's row — same result, zero writes. Note the check runs *after* the advisory lock is held, so two concurrent posts of the same line can't both see "nothing exists yet" and both insert.

The key includes `direction` so that a reversal posted against the same reference line — should a flow ever do that — lands as a distinct legal row instead of a false idempotency hit. Same reference, opposite directions, two different facts.

## FIFO is a queue you keep after it empties

Valuation is pluggable behind a two-method interface — `onReceipt` and `onIssue` — with FIFO as the shipped strategy. Receipts create **cost layers**: a row recording quantity and unit cost at arrival. Issues consume the oldest layers first, under an explicit row lock, oldest-first with the primary key as tiebreaker. This is the query as Postgres receives it (the source builds it with Prisma's tagged-template `$queryRaw`):

```sql
-- Oldest-first is the FIFO contract; id breaks same-timestamp ties so replay is deterministic.
-- FOR UPDATE: the layers are the valuation source of truth — nothing may price against them mid-consume.
SELECT id, qty_remaining, unit_cost
FROM stock_cost_layers
WHERE company_id = $1 AND item_id = $2
  AND variant_id = $3 AND warehouse_id = $4
  AND qty_remaining > 0
ORDER BY received_at ASC, id ASC
FOR UPDATE
```

The consume loop walks the layers, takes what it needs from each, and prices the issue at the weighted average of what it actually consumed — so an issue that spans a cheap old layer and an expensive new one gets the true blended cost, not either sticker price. And when a layer hits `qtyRemaining = 0`, it is *not* deleted. The comment: depleted layers are kept *"for audit & rebuild."* If the balance table were ever corrupted or doubted, the layers plus the ledger are sufficient to replay valuation from zero — the derived data is disposable, the history is not.

One belt-and-suspenders detail: the writer checks `onHand` against the balance *and* the costing strategy independently reports whether the layers could cover the issue. The two should always agree. Checking both means that if they ever don't, the system fails loudly at the moment of divergence instead of shipping a wrong cost quietly.

## Rounding residue has to die at zero

Here is the bug that survives most code reviews. The ledger's value column is `Decimal(18,2)` — two decimal places. Unit costs carry six. Round each movement to two places and a sub-cent residue accumulates in the balance. Watch it happen: receive 3 units bought for 10,000 (unit cost 3,333.333333), then issue them one at a time.

```text
receive 3 @ 3333.333333  →  valueDelta +10000.00   balance: 3 units / 10000.00
issue 1                  →  valueDelta  -3333.33   balance: 2 units /  6666.67
issue 1                  →  valueDelta  -3333.33   balance: 1 unit  /  3333.34
issue 1                  →  valueDelta  -3333.33   balance: 0 units /      0.01   ← wrong
```

Zero units on hand, one cent of value. Absurd on its face, and worse than absurd: the next receipt inherits it. Receive 5 units at 2,000.00 and the balance says 10,000.01 — average cost 2,000.002. The residue has *poisoned* the cost of stock that hasn't arrived yet, and every future issue prices it in. The fix in `postStockMovement` is four lines with a three-clause justification:

```ts
// Stok habis (onHand 0) ⇒ paksa nilai ke 0 dan serap residual rounding sub-sen ke valueDelta
// movement ini: (a) fisik benar (0 unit ⇒ 0 nilai), (b) Σ ledger.valueDelta tetap konsisten,
// (c) mencegah residual meracuni avgCost penerimaan berikutnya.
if (newQty.isZero() && !newValue.isZero()) {
  valueDelta = valueDelta.minus(newValue);
  newValue = D(0);
}
```

Translated: when stock hits zero, force the value to zero and absorb the residue into *this* movement's `valueDelta` — because (a) it is physically correct, zero units are worth zero; (b) the ledger sum stays exactly equal to the balance, since the correction lives in a ledger row instead of being silently discarded; and (c) the residue can't poison the next receipt's average cost. The last issue in the sequence above posts `-3333.34` instead of `-3333.33`, and the books close the cycle at exactly zero. Stock hitting zero is the one natural moment the invariant can be re-anchored to what is actually on the shelf, and the code refuses to waste it.

## A reservation is a claim, not a movement

The last design line is about what the ledger *refuses* to record. When a sales order is approved, stock is reserved for it — but a claim on future stock is not a change in what you physically own. So reservations live in a separate service that moves only `qtyReserved` on the balance (available = on hand minus reserved), takes the *same* advisory lock, carries its own per-reference idempotency, and never writes a ledger row. On goods issue the two halves meet: the ledger records the actual OUT, and the reservation releases — clamped, per an inline comment that translates to "never over-release," so a botched release request can zero out a reservation but can't drive it negative.

Keeping claims out of the ledger keeps both sides honest. On-hand quantity and FIFO cost reflect only things that actually happened; availability math reflects commitments; and cancelling a sales order is a bookkeeping change on the claim side, not a fake stock movement that would distort costing.

None of this needed a message broker or an event store. It needed one function that owns the writes, one advisory lock that serializes an identity that may not exist yet, one composed key that makes retries free, and a four-line guard that re-anchors the books every time stock touches zero.

The ledger is the only pen; everything else is just reading.
