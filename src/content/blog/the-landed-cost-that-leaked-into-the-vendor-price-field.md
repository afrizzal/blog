---
title: 'The landed cost that leaked into the vendor-price field'
description: 'A goods-receipt line''s unitCost field meant two different things at once — the vendor''s price, and that price plus the freight allocated onto it. The moment the second meaning won, the AP invoice''s GR/IR clearing math invented a purchase-price variance that was never real.'
category: 'Systems & Performance'
pubDate: 2026-09-29
tags: ['postgres', 'data-integrity', 'architecture', 'concurrency']
draft: false
---

SentraOps, the study-case ERP I built around a multi-branch aesthetic clinic chain's workflows, added landed-cost allocation so freight and duty on a purchase order can raise the recorded cost of the goods it bought — a feature every ERP eventually needs. The obvious place to store that raised number was the goods-receipt line's `unitCost` field, since it already held a cost. One self-review pass, before the mandatory code-review gate even ran, caught that `unitCost` already had a job: pricing the clearing entry on the AP invoice. Giving it a second job silently invented a purchase-price variance that had never happened.

## A field already has one reader before you add a second meaning to it

`GoodsReceiptLine.unitCost` is written once, at goods-receipt time, from the vendor's quoted price. It isn't just display data — `resolveApGrirAmount`, the function that prices the **GR/IR clearing** entry (Goods Receipt / Invoice Receipt, the suspense account that bridges "we received the goods" and "we got the bill") when an AP invoice references that line, reads it straight back:

```ts
// invoiceJournals.ts — grirAmount for the AP invoice's clearing entry
const grCost = line.grLineId != null ? costByGrLine.get(line.grLineId) : undefined;
const value =
  grCost != null
    ? D(line.qty).mul(D(grCost)).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP)
    : D(line.lineTotal);
```

That function was written in June, with the accounting module's automatic AP/AR invoice journals, nearly two months before landed cost existed, on the entirely reasonable assumption that `unitCost` means one thing: what the vendor charged for the item. Landed-cost allocation needed a home for a second number — the freight and duty apportioned to that same line — and `unitCost` was sitting right there, already the right shape, already persisted per line. The first implementation raised it in place, and not on a whim: the feature's own plan asked for it. Its worked example, encoded as case #1 of the landed-cost test suite, expected the goods-receipt lines to read `1333.3333` and `2666.6667` after posting, even though the plan's persistence step named only `allocatedCharge`. The plan contradicted itself, the code followed the example, and the suite passed while asserting the bug.

## Overwriting the field balances the receipt and unbalances the invoice

The goods-receipt journal itself doesn't care which number lives in `unitCost` — it posts from the allocation result directly. A PO with 300,000 of goods and 100,000 of allocated freight posts a clean three-leg journal: debit **Inventory** 400,000, credit **GR/IR** 300,000, credit **Charge Clearing** 100,000. Balanced, by construction, every time.

The trouble starts one document later. If `unitCost` had been overwritten with the landed figure (1,333.33 and 2,666.67 per unit instead of 1,000 and 2,000), the AP invoice for the vendor's actual 300,000 bill would call `resolveApGrirAmount`, read the landed `unitCost`, and compute a GR/IR debit of 400,000 — money the goods receipt never credited. The invoice would debit GR/IR for more than the receipt credited it, leave a 100,000 hole sitting on that clearing account, and book the difference as a **purchase price variance**: a credit implying the vendor charged 100,000 less than expected. Nothing about the vendor's actual invoice changed. The variance existed purely because one field had quietly stopped meaning what a function in the accounting module still assumed it meant.

## The fix is a storage decision, not a math one

Nothing about the allocation math had to change to fix this — only where the second number was allowed to live. `unitCost` keeps its original, single meaning forever: the vendor's price, full stop. The allocated charge gets its own column, `allocatedCharge`, persisted alongside it. The landed unit cost — the number that actually matters for inventory valuation and COGS — flows into the FIFO layer as an argument to the stock-posting call, never back into the field `resolveApGrirAmount` reads:

```ts
// landed-cost.test.ts — end-to-end case #1 after the fix (excerpt)
// Alokasi tersimpan per baris + total di header. `unitCost` SENGAJA tetap
// harga vendor (bukan landed) — kolom itu dipakai clearing GR/IR di AP invoice;
// landed cost hidup di ledger/cost layer (diuji lewat StockBalance di bawah).
expect(D(gl1.unitCost).toString()).toBe("1000");
expect(D(gl1.allocatedCharge).toString()).toBe("33333.33");

// Nilai stok = harga barang + landed cost
const balA = await prisma.stockBalance.findFirstOrThrow({
  where: { companyId: s.companyId, itemId: s.itemId, warehouseId: s.warehouseId },
});
expect(D(balA.totalValue).toString()).toBe("133333.33");
```

Where the landed unit cost has to be *displayed* — the goods-receipt detail page — it's computed on the fly as `unitCost + allocatedCharge / qty`, never stored back over the vendor price. One field, one meaning, for the whole lifetime of the record. The number everyone downstream already trusted stays trustworthy.

## A negative control proves the regression test actually tests something

The bug was caught by reading the code, not by a failing test — a self-review pass that asked one question, who else reads `GoodsReceiptLine.unitCost`, ahead of the feature's mandatory code-review gate. The same trace cleared every other reader: creating an AP invoice from the PO and posting a purchase return both price from the PO line's `unitPrice`, and the journal backfill and supplier lead-time analytics never read the unit cost at all.

What makes the fix worth trusting is what happened next: case #1's `unitCost` expectation flipped from `1333.3333` to `1000`, and a regression test was added that posts a landed-cost goods receipt, invoices it, and asserts the GR/IR debit equals the vendor's 300,000, not the landed 400,000. To prove that assertion would actually have caught the original bug, the old behavior — overwriting `unitCost` with the landed figure — was temporarily reinstated against the same test.

It failed exactly as predicted: `expected '400000' to be '300000'`. That's the difference between a regression test that happens to pass and one that's been shown to fail for the right reason — you don't get to claim the second kind without deliberately breaking the code once and watching the assertion catch it.

## A shared resource needs its own kind of lock

Fixing the field-overloading bug didn't fix everything the feature touched. Posting a goods receipt reads the PO's list of allocated charges to compute the allocation, and that list was read outside the posting transaction, while the guard that freezes charges once a receipt posts wasn't transactional either — a pre-merge review flagged it as the one blocker. Create or delete a charge at the exact moment a receipt is posting, and the cost layer and the journal could disagree with the charge table permanently, since a posted receipt can never be reopened.

The fix takes a Postgres advisory lock, scoped per purchase order, as the first statement inside the receipt-posting transaction — always before the per-item balance locks the stock-posting function takes, so the two can't deadlock — re-reads the charge list inside that transaction, and routes every charge mutation through the same lock so it queues instead of racing.

It's worth naming why this needed an explicit lock while a sibling feature shipped the next day — price-list edits — didn't: a price list's own update transaction writes its header row first (always a real write, since `@updatedAt` changes on every save), and that write already serializes concurrent editors as a side effect, a mutex it gets for free from the shape of the write itself. Goods-receipt posting has no equivalent shared row to write first — the lock had to be added on purpose, because nothing about the transaction's existing writes would have serialized it by accident.

A field will happily hold whatever number you put in it — the discipline is making sure every piece of code that reads it still agrees on what that number means, and proving it with a test you've actually watched fail.
