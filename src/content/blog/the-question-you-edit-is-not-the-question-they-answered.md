---
title: 'The question you edit is not the question they answered'
description: 'A branch-satisfaction survey for a multi-branch aesthetic clinic chain went from sixteen hardcoded questions to an admin-editable form, and the entire design turned on one rule: an edit that would change what a past answer means has to fork the question, not overwrite it, and the fork boundary is enforced by what the code can''t do.'
category: 'Systems & Performance'
pubDate: 2026-09-29
tags: ['data-integrity', 'architecture', 'postgres', 'reliability']
draft: false
---

A branch-satisfaction survey for a multi-branch aesthetic clinic chain started as sixteen hardcoded questions baked into a page component — the kind of form you build once and never expect an admin to touch. Making it editable meant admins could rename a question, retype it, hide it, or delete it, at any branch, at any time. The hard constraint underneath that feature was never really about the UI: an edit made today can never change what a customer's answer from three months ago meant when they gave it. The way I enforced that wasn't a permission check or a warning dialog. It was making certain edits create a new row instead of rewriting the old one, and making sure the code paths capable of skipping that distinction simply didn't exist for the operations that shouldn't need it.

## An edited question can't just overwrite what it already meant

Every answer to a custom question is a `CsiAnswer` row holding a foreign key straight to the `CsiQuestion` row it answered. A label snapshot rides along, but the type, the options, and the scale bounds live only on that question row. That's fine as long as questions never change. The moment an admin can retype a custom rating question from a 1–5 scale to a yes/no choice, or relabel it, that FK becomes a liability: every historical `CsiAnswer` would silently start being read through the *new* definition, as if the customer had answered a question that didn't exist yet when they filled out the form.

The fix is copy-on-write. A PATCH to a custom question with at least one answer and a change to a **fork-triggering field** — type, options, label, help text, required, the scale bounds and their labels, the allow-other flag — doesn't rewrite the row's content at all. It inserts a new row, then retires the old one, inside the same transaction:

```ts
const result = await prisma.$transaction(async (tx) => {
  const newQuestion = await tx.csiQuestion.create({
    data: {
      formId: question.formId,
      key: question.key,
      // ...patched fields...
      retiredAt: null,
      supersededById: null,
    },
  });
  await tx.csiQuestion.update({
    where: { id: question.id },
    data: { retiredAt: new Date(), supersededById: newQuestion.id },
  });
  return newQuestion;
});
```

Insert-then-retire, never the reverse. Postgres wouldn't actually expose a zero-live-row window across a single transaction either way, but the order still does real work: the retire step writes `supersededById: newQuestion.id`, so the new row has to exist before the old one can point at it. Every historical `CsiAnswer.questionId` keeps pointing at the retired row, its content never rewritten, still carrying the exact label and options it was answered against. That guarantee lives in the record, not in every read of it: the branch dashboard deliberately groups every version under the question's stable `key` and charts them as one continuous series under the newest live label, while the admin drill-down still shows each answer beside the `questionLabelSnapshot` it was given against.

## Not every edit is dangerous enough to fork

Forking on every edit would be the easy, wrong answer — retire a question every time an admin moves it to a new position, hides it, or fixes a typo before anyone has answered it, and the form accumulates a new version for every keystroke's worth of admin regret. The actual rule lives in one small, DB-free module: a question forks only if it's custom (the sixteen system questions never version — policy limits them to label, help-text, required, order, section, and safe-hide edits, and the dashboard charts them under a hardcoded analytics label that never reads the editable one), has at least one existing answer, and the patch touches a field that actually changes what the question *means*:

```ts
export const FORK_TRIGGERING_FIELDS = [
  "type", "optionsJson", "scaleMin", "scaleMax",
  "scaleMinLabel", "scaleMaxLabel", "allowOther", "label", "helpText", "required",
] as const;
```

`order`, `section`, and `hidden` are deliberately absent from that list — reordering a question or hiding it doesn't change what a past answer meant, so those patches always update in place, at any answer count. A rule like this only earns its keep if it's testable without touching a database, and it is: `shouldForkOnEdit` is a pure function over an `{ isSystem, answerCount }` shape and a patch object, exercised against every branch — system questions, zero-answer custom questions, answer-count-guarded custom questions, order-only and hide-only patches, an empty patch. The sibling delete and hide rules in the same module get the same treatment, with their exact user-facing rejection strings asserted verbatim, not just the boolean outcome.

## A route that cannot fork is safer than one that correctly declines to

The reorder endpoint only moves questions around — its write is `order` and `section` and nothing else — and it never needs to fork regardless of how many answers a question has. The safe way to guarantee that isn't a runtime check inside the route that happens to always evaluate false. It's not giving the route the ability to fork in the first place:

```ts
/**
 * Reorder can never fork — this file deliberately imports no fork-decision
 * helper from question-rules.ts at all, so there is no code path here that
 * CAN fork, not merely one that chooses not to.
 */
```

That comment sits above the reorder handler and names the actual design decision: nowhere in that file does `shouldForkOnEdit` get imported. No condition can quietly start evaluating true after an unrelated refactor and turn a reorder into a fork, because the machinery to fork was never wired into that file — anyone who wanted it there would have to add the import themselves, which is a louder, more deliberate act than flipping a boolean somewhere else. Whole classes of mistakes are cheaper to prevent by omission than by another `if`.

## Hiding a question is a data-shape change, not a cosmetic toggle

"Hide this question" sounds like a UI-only feature until you notice that the eight rating columns backing the system questions used to be `NOT NULL`. Once an admin can hide `ratingFacilityCleanliness`, new submissions legitimately have no value for it — the column has to go nullable, which is a real migration, not a flag flip.

The subtler part showed up in the KPI aggregates once nulls were possible: the branch-list query used to run two `groupBy` calls sharing one `where` clause, with the first one supplying both the response count and the overall average. Push a null filter into that shared `where`, and one column's hidden rows silently shrink a *different* metric's denominator — a hidden overall rating would drop that response out of the NPS count and the total alike. The fix runs three aggregates instead of two: an unfiltered total, plus one per rating metric, each with its own filter:

```ts
// Each rating column can be independently safe-hidden, so each aggregate
// below adds its OWN `{ not: null }` filter — a shared `where` would let
// one column's hidden rows silently corrupt another column's denominator.
// ...
// Own where: the NPS denominator is the non-null count, not the row count.
prisma.csiSubmission.groupBy({
  by: ["branchId", "ratingRecommendation"],
  where: { ...where, ratingRecommendation: { not: null } },
  _count: true,
}),
```

A response with every rating hidden is still a response — it counts toward the branch's total submission count, which stays on an unfiltered query — but it has to drop out of the *specific* averages and NPS calculation it has no opinion on. Getting that distinction wrong doesn't crash anything; it just quietly reports a wrong number that looks perfectly plausible.

## The client doesn't get to name its own column

Every question row carries `semanticRole` and `storageColumn` fields — null on a custom question, and on each of the sixteen system questions the server-side mapping that says which legacy `CsiSubmission` column its answer actually lands in. Nothing about that mapping is allowed to originate from the browser, on either side of the wire. On the write path, answer validation resolves each answer purely against the question definition the server already loaded — a raw payload that smuggles its own `type` or `storageColumn` has zero effect on the result, proven by a test that submits exactly that smuggled payload and asserts the fields never reach the output. On the read path, the function that turns a `CsiQuestion` row into the JSON the public form actually sees builds that object field by field:

```ts
// Fields are assigned explicitly, one by one — never a spread of the
// Prisma row — so `semanticRole` / `storageColumn` (server-internal)
// can never leak.
export function toPublicFormDefinition(resolved: ResolvedForm): PublicFormDefinition {
  return {
    formId: resolved.form.id,
    version: resolved.form.version,
    questions: resolved.questions.map((q) => ({
      questionId: q.id,
      key: q.key,
      type: q.type,
      label: q.label,
      // ...
    })),
  };
}
```

A `{ ...q }` spread would have been one line instead of fifteen and would have shipped `semanticRole` and `storageColumn` straight to every browser that ever loaded the form. The explicit version costs a few extra lines up front and buys a real property: adding a new internal column to `CsiQuestion` later can never silently become a new public field, because someone has to deliberately add it to this list.

## A tier check can degrade a response instead of blocking it

Free-text answers to custom questions carry more identifying risk than a 1–5 rating, so only admin-tier callers can see them — but the branch-responses endpoint had to decide what a lower-tier caller sees when they ask for the enriched view anyway. Rejecting the request outright would have been the simpler code path. What actually ships degrades instead:

```ts
// `?includeCustom=1` degrades rather than rejects: a view-tier caller
// still gets the (unenriched) list, byte-identical to today's response —
// no `customAnswers` key at all, not even an empty array, so a view-tier
// client cannot detect that free text exists.
```

A view-tier client that sends `?includeCustom=1` gets exactly the response it would have gotten without the flag — not a 403, not an empty array that hints something exists behind a wall. An empty array is still information: it tells a client something *could* be there. Byte-identical is the only response shape that reveals nothing about a capability the caller doesn't have.

None of these six decisions were about making the form flexible — they were about making sure flexibility never got a chance to rewrite what a customer had already told you.

---

## Sources

- PostgreSQL Global Development Group — *PostgreSQL Documentation: 13.2. Transaction Isolation* (Read Committed is the default level, and a query under it never sees uncommitted data from another transaction; dirty reads are not possible at any level in PostgreSQL). Retrieved 2026-09-29. <https://www.postgresql.org/docs/current/transaction-iso.html>
