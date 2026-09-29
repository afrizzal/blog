---
title: 'The audit chain hashed one timestamp and persisted another'
description: 'A weekly audit ledger sealed each finding into a SHA-256 hash chain, but the hash and the database row each read the clock independently — so every untampered entry would have verified as tampered. The fix was one field, passed explicitly instead of left to a schema default.'
category: 'Systems & Performance'
pubDate: 2026-09-29
tags: ['data-integrity', 'reliability', 'architecture', 'postgres']
draft: false
---

A hash chain is only tamper-evident if the value you hash is exactly the value you keep. I built one for a weekly audit ledger — the kind of thing whose entire job is proving nobody edited history after the fact — and its seal step hashed one timestamp while the database row kept another. Run through the verification path, every untampered entry would have come back tampered. Nothing needed to be touched: two parts of the same write each asked for "now" and got two different, equally correct answers, and a **hash chain** does not know the difference between tampering and disagreement.

The ledger exists for a multi-branch aesthetic clinic chain's paid social spend. Once a week it runs a handful of deterministic policies over the account's ad performance — fatigued creative, budget burning with zero results, that kind of thing — and instead of acting on any of it, writes down what it would have flagged. It never calls the ad platform's write API. Its only job is to remember its own predictions honestly enough that someone can check, once an entry has aged four weeks, whether it would have paid off.

## A ledger proves its own honesty by hashing what it seals

Each finding becomes a row: which policy fired, the target (an ad, a campaign, or a competitor signal), the evidence behind it, a predicted outcome, and the moment it was sealed. That payload gets canonicalized — object keys sorted recursively so the same data always serializes to the same string, regardless of insertion order — then hashed together with whatever was sealed immediately before it:

```ts
export function canonicalize(obj: unknown): string {
  return JSON.stringify(sortKeysDeep(obj)); // same object -> same string, always
}

export function chainHash(prevHash: string, payloadJson: string): string {
  return sha256hex(prevHash + payloadJson);
}
```

Chain each entry's hash into the next one and you get a structure where editing any sealed row breaks its own hash check, and hiding the edit means rewriting every hash that comes after it — the same idea a blockchain or a Merkle-style audit log runs on, minus the distributed-consensus part. Verifying it later means rebuilding the payload field by field from the entry's stored columns, recomputing `chainHash()`, and comparing the result against the `entryHash` column sitting right next to it. Disagreement means either the payload changed after sealing, or the hash was wrong from the start.

## The payload deliberately leaves some fields out

Not everything about a finding gets hashed. Status, who approved it, when it was approved, when it was verified — all of that mutates after sealing, on purpose, because someone has to be able to approve or dismiss a finding without the act of reviewing it corrupting the ledger meant to hold it accountable. Only the sealed content — the evidence, the prediction, the moment it was written — has to survive unchanged. That is a real design decision, not an oversight, and it is the right one: a hash chain over fields that are supposed to change would fail constantly, for reasons that have nothing to do with tampering.

## One of the permanent fields turned out not to be permanent

`sealedAt` is one of the fields inside the hashed payload — the instant the entry was written, baked in on purpose so a later reader can't quietly claim a different sealing time than the one that was actually hashed. The code that builds the payload computes it once:

```ts
const sealedAtIso = new Date().toISOString();
const payload = {
  policyKey: finding.policyKey,
  targetType: finding.targetType,
  targetId: finding.targetId,
  proposedAction: finding.proposedAction,
  evidenceJson: JSON.stringify(evidence),
  predictedJson: JSON.stringify(finding.predicted ?? {}),
  amountAtRiskRp: finding.amountAtRiskRp,
  snapshotId: snapshot.id,
  sealedAt: sealedAtIso,
};
const candidateHash = chainHash(prevHash, canonicalize(payload));
```

What the write path didn't originally do was pass that same value into the database insert. The schema defines the column as `sealedAt DateTime @default(now())`, and an ORM is happy to fill that in for you if you never mention it. Prisma's query engine evaluates `now()` itself when the create request runs and sends the result with the `INSERT`, with the migration's `DEFAULT CURRENT_TIMESTAMP` as the database-side backstop — either way, a fresh and independent reading of the clock. Two reads of "now," at least one database round trip apart, both technically correct, both describing the same seal, and neither aware the other existed. The gap would only have widened down the loop: the payload timestamp is computed once, before the first finding, while every insert first waits on a lookup and, for a new finding, a narrative-generation call.

## SHA-256 does not do "close enough"

This is where a hash chain punishes an assumption that would be harmless almost anywhere else in the codebase. A few milliseconds of drift in a timestamp is nothing to a human reading a log, and nothing to most other parts of this system. To SHA-256 it is everything: flip one bit anywhere in the input and the output is a completely unrelated 256-bit value, by design. There is no partial credit and no "mostly matches."

Against rows from the original write path, the verification route would rebuild each payload with the stored `sealedAt` and compare against a hash derived from a `sealedAt` that was never actually written down. It would essentially never have matched. Not sometimes — on every row, because `@default(now())` fires independently on every single insert. And since `verifyChain()` walks forward from the genesis hash and stops at the first mismatch, the very first entry would have marked the whole chain invalid on every entry's detail page.

## The acceptance criteria would have passed with every entry failing

This surfaced where two pieces of parallel work met. One plan built the sealing logic; a later one built the route that reads a sealed entry back and reports whether its chain still verifies, while a sibling branch running at the same time owned `scan.ts` for the scoring and digest stages. Writing the verify route meant reconstructing the exact object `scan.ts` hashes, field by field — and that is where the missing `sealedAt` became visible, in the code rather than in a failing read. The deferred-items log records it as a prediction: `verifyChain()` "will report `valid: false` for every entry — even freshly-sealed, untampered chains — until this is fixed."

The same log notes the uncomfortable part. The bug did not fail a single acceptance criterion of the plan that found it, because every one of them checked that the route *called* `verifyChain()` correctly, not that the result was `true` on real data. A check that the verifier ran cannot tell a working chain from one that fails on every row. What it did block was the phase's own must-have — a freshly sealed chain that verifies — and the manual smoke test built around the "chain verified" badge. Since `scan.ts` belonged to the concurrent branch, the defect was logged instead of patched — a known wiring bug with the exact one-line fix written into the entry, rather than something shipped quietly and discovered later by someone trying to trust the ledger for real — and the fix landed within five minutes of both branches merging.

## The fix is a single value, told to agree with itself

The correction is one field, passed explicitly instead of left to the schema default:

```ts
// Must match the `sealedAt` baked into `payload` above byte-for-byte —
// Prisma's @default(now()) would persist a different instant than the
// one hashed into entryHash, breaking verifyChain() on every read.
sealedAt: new Date(sealedAtIso),
```

The rule underneath that one-line fix applies to more than timestamps. Anything that feeds a hash — a checksum, an idempotency key, a signature — has to be the literal value that gets persisted and read back later, not a value some other code path is trusted to re-derive the same way. Two independent computations of "the current time," "a random id," or "a serialized object" are never guaranteed to agree, even when both are correct, even when they sit a few lines apart in the same function. It is the same rule, under a different name, behind the fingerprint checks I layered at three separate points in OmniSync: a value only works as a shared reference point if every place that is supposed to see it sees the exact same bytes, computed exactly once.

The ledger was never tampered with — it just asked the clock twice, and a hash chain will never pretend two honest answers are the same one.

---

## Sources

- Prisma — *prisma-engines PR #3200: qe: sync @default(now()) and @updatedAt within a request* (the query engine produces the value of `now()` itself, holding one timestamp for the duration of a request). Retrieved 2026-09-29. <https://github.com/prisma/prisma-engines/pull/3200>
- Prisma — *Models (Prisma ORM v6), "Using functions"* (relational database connectors implement `now()` at the database level, i.e. it also manifests as a column default in the schema). Retrieved 2026-09-29. <https://www.prisma.io/docs/orm/v6/prisma-schema/data-model/models>
