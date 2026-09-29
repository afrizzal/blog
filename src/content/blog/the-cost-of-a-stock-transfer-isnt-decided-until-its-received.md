---
title: 'The cost of a stock transfer isn''t decided until it''s received'
description: 'SentraOps ships stock between warehouses through one shared virtual TRANSIT buffer, and a plan-checker caught the flaw before a line of code existed: freezing the unit cost at ship time breaks the moment two transfers of the same item at different costs land in that buffer and get received out of order.'
category: 'Systems & Performance'
pubDate: 2026-09-29
tags: ['postgres', 'data-integrity', 'architecture', 'concurrency']
draft: false
---

A stock transfer looks like one operation — move ten units from Warehouse A to Warehouse B — but SentraOps, the study-case ERP I built around the workflows of a multi-branch aesthetic clinic chain, models it as two independent postings around a shared virtual warehouse. The unit cost you can safely compute when stock leaves the source is not automatically the unit cost you can assume when it lands at the destination, and the gap between those two postings is exactly where a plausible design goes wrong. The plan review that checks my implementation plans before I write a line of code caught that gap before it ever became a bug.

## A transfer is two postings around a shared buffer

SentraOps has no "move" primitive. Every stock mutation — purchase receipt, sale, adjustment, transfer — goes through one ledger-writing function that takes stock out of a warehouse or puts it in, FIFO-costed, inside a transaction. A transfer between real warehouses is built from two calls to that function, bridged by a warehouse that doesn't physically exist: `TRANSIT`, a `VIRTUAL`-type warehouse seeded once per company. Shipping is `OUT` the source, `IN` to TRANSIT. Receiving is `OUT` TRANSIT, `IN` to the destination. Nothing touches the general ledger — inventory's *total* value doesn't change while stock is "on the truck," it just sits in a different bucket that happens to have no address.

That design buys something valuable for free: in-transit stock shows up in the existing stock-balance and inventory views the moment it exists, with no special-case code, because TRANSIT is a warehouse like any other. It also means the two postings can be arbitrarily far apart in time, and — this is the part that matters — TRANSIT can hold stock from more than one transfer at once.

## Freezing the ship-time cost looks obviously correct

The tempting implementation computes cost exactly once. Ship pulls units from the source warehouse's FIFO layers, and `postStockMovement` returns the value that left — divide by quantity and you have a clean unit cost for this shipment. Store it on the transfer line. When the document is received later, reuse that stored number to post the `IN` at the destination.

```ts
// The design that looks safe: compute cost once, at ship, and carry it.
const unitCost = valueOut.abs().div(line.qty);
await tx.stockTransferLine.update({ where: { id: line.id }, data: { unitCost } });
// ...later, at receive:
// unitCost: line.unitCost   <- reuse the frozen number
```

Nothing about that looks wrong in isolation. It's the same document, the same line, the same items — what could possibly change between ship and receive? The answer is that the number was never really "this line's cost." It was the cost of whatever FIFO layer happened to be at the front of the source warehouse's queue at the moment of shipping. TRANSIT is where that assumption stops holding.

## TRANSIT belongs to the company, not to one transfer

TRANSIT is one warehouse per company, not one scratch space per transfer. If two transfers are shipped around the same time, TRANSIT can be holding two FIFO layers of the same item at two different costs simultaneously — say four units at 100 from one transfer, four units at 150 from another. TRANSIT doesn't know or care which layer "belongs" to which document; FIFO consumption at receive time draws from whichever layer is oldest, full stop.

Receive the second transfer first — a completely legal thing to do, since nothing in the workflow forces receipts to follow shipping order — and its `OUT` from TRANSIT consumes the *first* transfer's layer, not its own. A design that reuses the ship-time `unitCost` would post that receipt at 150 (the number written on its own line) while the ledger actually gave up value costed at 100: 200 of inventory value appears with no goods behind it, and it stays on the books until the other transfer is received and the opposite mismatch cancels it out. With transfers overlapping continuously, TRANSIT may never drain, and the company's total inventory value quietly drifts from the sum of what's actually on the shelves — the exact failure a FIFO ledger exists to prevent.

## A plan review caught it before a line of code existed

This is where a structured review step earned its keep. Before implementation started, the plan for this feature went through a checker pass — an adversarial review that starts from the assumption that the plan will not deliver its goal and has to be argued out of it. It flagged the frozen-cost design as a blocker, not a style note, and the plan's decision log was revised on the spot (translated here from the Indonesian original):

> Receive's unit cost into the destination is derived from the *actual* `OUT` at receive time, never from the line's frozen ship-time cost — because TRANSIT is shared per company, and two transfers of the same item at different costs, received out of order, consume FIFO layers that belong to the other document. Deriving cost from the actual `OUT` preserves the company's total inventory value under any receive order, by construction.

No bug report, no production incident — the failure mode was reasoned out from what the schema already implied (one shared warehouse, FIFO consumption, no ordering guarantee on receipt) and fixed in the design document itself. That's the version of "caught early" that a decision record can actually show its work for: the revision date sits right next to the reasoning that produced it.

## Receive derives cost from what actually left the buffer

The shipped code reflects the revision exactly. `receiveTransfer` never reads `line.unitCost` for costing purposes — it exists purely as ship-time information for display, deliberately labeled "Cost saat Ship" (cost at ship) in the Indonesian UI instead of "Unit Cost" so nobody mistakes it for the number that was actually booked:

```ts
const out = await postStockMovement(tx, {
  warehouseId: transit.id,
  direction: "OUT",
  qty: line.qty,
  // ...
});

// Derived from what TRANSIT's FIFO layers actually gave up right now —
// never from line.unitCost (that's ship-time info only, shown in the UI,
// intentionally unused here).
const unitCostIn = D(out.valueDelta).abs().div(line.qty).toDecimalPlaces(6);

await postStockMovement(tx, {
  warehouseId: transfer.toWarehouseId,
  direction: "IN",
  qty: line.qty,
  unitCost: unitCostIn,
  // ...
});
```

The rule generalizes past this one feature: a value snapshot taken at step one of a multi-step process is only safe to reuse at step two if nothing else could have touched the resource in between. The moment the resource is shared — a buffer, a cache, a queue — the only cost, balance, or count you can trust is the one you compute at the point where you actually consume it.

## An adversarial interleaving test targets the out-of-order path, not the happy path

A test that only ships and receives one transfer at a time would never exercise the bug the revision exists to prevent. The suite includes one built to be adversarial: two transfers into two different destinations, shipped from two different source warehouses at two different costs — four units at 100, four units at 150 — landing in the same shared TRANSIT. Then it receives them in the wrong order on purpose, second transfer first.

The assertions are deliberately narrow. The test does not check that either destination receives its "own" cost, because after an out-of-order receive there is no such thing — cost can legitimately swap between documents as a consequence of FIFO, and asserting a specific per-destination number would bake in a wrong assumption about which layer serves which receipt. What it does assert: the company's total inventory value before shipping equals the total after both receipts land, and TRANSIT ends the scenario holding exactly zero value. Get the ordering-independence right, and the specific numbers per destination are allowed to be whatever FIFO says they are.

Those are end-state checks, though, and that has a limit worth stating: in this symmetric scenario the frozen-cost design would also net back to 1,000 once both receipts landed, because its extra 200 only exists between the two receives. The assertion that would actually tell the two designs apart is the company total taken right after the first out-of-order receipt, and the suite doesn't make that check.

A shared buffer has no memory of who put what into it, so the only unit cost worth trusting at receive time is the one the ledger gives up right then — never the one somebody wrote down when the stock went in.
