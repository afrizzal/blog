---
title: 'A 404 that lies on purpose is more honest than a 403'
description: 'Fixing a cross-tenant IDOR taught me that ''access denied'' and ''does not exist'' are the same message when the requester should never learn which one is true.'
category: 'Systems & Performance'
pubDate: 2026-07-15
tags: ['security', 'reliability', 'architecture', 'data-integrity']
draft: false
---

A branch-detail route that returns 403 for a branch outside your group is confirming, for free, that the branch exists. That single bit of information is what an IDOR fix has to close, not just the read itself. On a multi-branch aesthetic clinic chain's internal ops dashboard, a customer-satisfaction (CSI) module's branch-detail and responses routes were scoped by role but not by group: any authenticated user could substitute another group's branch UUID in the URL and pull that branch's KPI numbers and response text. The fix landed as `assertBranchInGroup()`, and the interesting decision wasn't the guard itself — it was what the guard returns when it fails.

## The guard is additive, not a rewrite of the role check

`assertBranchInGroup(user, branchId, db?)` sits after the existing role check, not instead of it. Roles split exactly two ways: `SUPERADMIN` bypasses the group check entirely, and every other role gets the same treatment regardless of whether they're an admin, supervisor, or plain staff account. The function takes an optional `db` parameter purely so unit tests can inject a fake client — the production call site never passes one. That shape kept the change additive: existing `getBranchScope()`, `requireBranchAccess()`, and `assertSupervisorOrAbove()` exports were untouched, so nothing else in the route tree had to be re-audited for a signature change.

```ts
// Returns 404 (never 403) on cross-group branch access — see below for why
export async function assertBranchInGroup(user: User, branchId: string, db = prisma) {
  const branch = await db.branch.findUnique({ where: { id: branchId }, select: { groupId: true } })
  // Strict !== fails closed: an undefined groupId can never equal a real group id.
  if (!branch || (user.role !== "SUPERADMIN" && branch.groupId !== user.groupId)) throw new NotFoundError()
}
```

## 403 tells the attacker the door exists

A textbook access-control fix returns 403 Forbidden for a branch outside the user's group and 404 Not Found for a branch UUID that doesn't exist at all. That distinction is exactly the leak. If a response code alone tells a requester "this branch exists, you're just not allowed to see it" versus "no such branch," an attacker enumerating UUIDs across groups gets a working existence oracle even after the KPI data itself is locked down. `assertBranchInGroup()` collapses both cases into the same `NotFoundError` — a cross-group branch and a nonexistent one are indistinguishable from the caller's side. The guard never confirms existence; it only ever confirms access.

The companion routes carry the same instinct further. The branches-list endpoint, `ea8cdcc`, returns a 403 instead of an unscoped list when `scope.type === "all"` and `user.groupId` is undefined — a fail-closed default where the previous behavior (an undefined scope silently resolving to "show everything") would have been the same class of bug from the other direction: a missing value expanding access instead of the guard rejecting it. And a lightweight `?light=1` branches query — added so the public QR-poster page can list branch names without triggering the KPI aggregation — still goes through the same group scoping; a "cheap read" code path is not an exemption from the access model, it's a second implementation of the same access model with less work attached.

## Fail-closed is a property of the default, not the check

The guard function is easy to get right in isolation; the harder discipline is making sure every route that touches branch data actually calls it, and that the routes that can't call it yet fail safe instead of failing open. That's what `ea8cdcc`'s branches-list fix is really about — it isn't a second IDOR, it's the same principle applied to a state (`groupId` undefined) that the original code treated as "show everything" instead of "block everything." A fail-closed default costs nothing when the state is well-formed and stops the exact failure mode a missing-field bug produces when it isn't.

The test suite backing this — `scope-branch-group.test.ts` — covers four cases: same-group access allowed, cross-group access blocked with a 404, `SUPERADMIN` bypassing the group check globally, and a missing branch. The four cases aren't chosen to maximize coverage percentage; they're chosen because each one is a distinct way the guard could silently degrade into an oracle — same-group false negative, cross-group false positive, role-bypass drift, and existence-leak on the missing-branch path. A guard that returns the right status code for the happy path but the wrong one for "branch doesn't exist" is a guard that still tells an attacker something true.

Collapsing the two cases on the wire doesn't mean collapsing them in your own telemetry — the server still knows which of the two stories it just told, and it should keep that knowledge. A cross-group denial and a genuinely missing branch leave the requester staring at the same 404, but they mean opposite things to an operator: a run of denials against branches that *do* exist, all from one account, is what UUID enumeration looks like from the inside, while a run of true misses usually means a client is holding stale branch ids after a deletion. If the log line records nothing but the status code, the deliberate ambiguity you built for attackers now blinds you too. The guard is the right place to make that distinction durable — it's the one spot that knows which side of the condition fired, and recording the real reason costs one structured log field that never reaches the response body.

The lesson generalizes past this one dashboard: an access-control fix that's correct about *what* data leaks but wrong about *whether the response confirms a resource exists* has only fixed half the vulnerability class.
