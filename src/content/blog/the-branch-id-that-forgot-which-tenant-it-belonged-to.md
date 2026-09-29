---
title: 'The branch id that forgot which tenant it belonged to'
description: 'A refactor made a branch entity canonical across tenant workspaces so it could belong to several at once — but the balance queries that filtered on its id kept summing every workspace''s top-ups and usage together, so a workspace with no billing connection configured still saw another tenant''s budget on its dashboard.'
category: 'CRM & Revenue'
pubDate: 2026-09-29
tags: ['security', 'data-integrity', 'crm', 'architecture']
draft: false
---

Making a row shared across tenants does not make every query that joins on it tenant-safe. It just moves the boundary — from a foreign key that used to enforce it for free, to every query written from that point on, forever, with no compiler or schema constraint to catch the one that forgets. A multi-branch aesthetic clinic chain I build WhatsApp-billing tooling for found this out when a workspace that had never configured WhatsApp billing at all still rendered another workspace's Total Budget, Total Used, and Net Balance, in real money, on its own dashboard.

Nobody bypassed a permission check to see it. Nobody guessed another tenant's id. That's what makes this bug worth walking through: it doesn't look like the access-control bugs the term "leak" usually points at. The row really was shared, on purpose, by design. The number computed from it wasn't supposed to be.

## A branch became a shared row, and the queries didn't notice

The platform organizes work into workspaces — the codebase calls them Spaces, several of them under one parent group — each with its own WhatsApp broadcast ledger, budget top-ups, and usage log. Early on, a physical clinic branch was modeled as one row per workspace: `Branch { spaceId, code, name, ... }`. If two workspaces both needed to reference "the same" branch, they got two separate rows. Duplication, but also an accidental safety property — a branch row belonged to exactly one workspace, so anything that queried by branch id was automatically scoped to one tenant.

An earlier refactor fixed the duplication. Branches became canonical at the parent-organization level — one row per physical branch, full stop — with a join table recording which workspaces that branch is a member of and what workspace-specific settings apply. This is the right call: the same physical clinic branch is legitimately referenced from more than one workspace's modules, and modeling that as duplicate rows was already causing drift — the refactor's own summary records the same physical branch existing twice, once carrying its WhatsApp-platform division id and once without it. The refactor didn't introduce a bug by being wrong. It introduced one by being correct about the schema and silent about everything downstream that had been leaning on the old schema's side effect.

That side effect was structural tenant isolation. Once `branchId` alone stopped implying a single workspace, every query that had been written against the old assumption became a query with a hole in it — and nothing about TypeScript, Prisma, or a passing build could tell the difference between a query that had been updated to add the workspace filter back and one that hadn't.

## The leak lived in the aggregate, not the row

Fourteen query sites across the balance API, the depletion forecast, the finance report, and two low-balance alert checks computed budget and usage by filtering the top-up and usage-entry tables on `branchId`. That was correct arithmetic under the old schema. Under the new one, it silently became: sum every top-up and every usage entry recorded against this branch, across every workspace that happens to share it.

A workspace with no billing connection configured at all — one that could not sync a single broadcast of its own, because usage sync already refused to run without a connection — could still open its balance page and see numbers. Not zeroes. Not an error. Another workspace's real budget, real spend, real depleting balance, rendered as if it belonged there, because the aggregate had no way to know it shouldn't include those rows and nothing told it to exclude them.

This is a quieter failure mode than the IDOR shape most access-control writing focuses on — no attacker types `?branchId=other-tenant` and gets back data they weren't supposed to request. Here, every request was for the requester's own, legitimate, correctly-scoped branch. The tenant boundary that used to live in the row disappeared, and the query that used to inherit it for free just kept doing exactly what it always did.

## Closing it took an audit, not a permission check

The core fix wasn't a new authorization rule — there was nothing to authorize against, since the request was legitimate on its face. The fix's own summary is explicit that the balance endpoint's data security comes from query scoping, not from its route guard: the same endpoint doubles as the branch-picker data source for two other pages gated by different feature keys, so no single page's gate was ever the thing separating one workspace's numbers from another's. The forecast route, which has no other consumer, moved to a feature gate as part of the same fix.

The rest was mechanical: grep every read and aggregate that touches the top-up or usage-entry tables, and add the workspace id back explicitly to each `where` clause. Three kinds of call site were documented and deliberately left as they were: a group-wide delete-guard that is cross-workspace by design, a top-up delete that loads the row by id and already refuses it when the row's workspace id isn't the caller's, and a handful of Prisma `upsert` calls whose `where` clause has to address the compound unique key on branch and broadcast — the plan left those alone because the `create` half already stamps the workspace id and the fix was scoped to no schema change at all.

Layered on top, the balance endpoint started checking for the existence of a billing connection before doing any aggregation at all: a workspace with none configured now gets back `configured: false` with an empty branch list, the forecast route answers the same way, and adding a top-up is refused outright. The page keys on that flag and renders no financial numbers at all — not even zeroes that could be mistaken for a real balance — instead of a banner that was, until this fix, advisory only while the KPI cards and tables kept rendering underneath it anyway.

The acceptance criteria for the fix are as telling as the fix itself: verify that the workspace which actually owns the data sees the exact same balance before and after, because every row it queries was already correctly stamped with its own workspace id — the fix only had to stop other workspaces' rows from being pulled in, not change what the rightful owner sees. A regression check aimed entirely at proving the fix didn't fix anything for the tenant that was never broken.

The postscript is the part I'd point a hiring manager to first: seven weeks later, an AI-usage metering feature cited this exact incident in its own decision record. Its append-only adjustment table has no workspace column of its own, so the monthly cost-cap query scopes adjustments through their parent usage entry's workspace instead of by billing period alone — and the project documentation names filtering by period alone as "the exact cross-tenant leak shape" this incident had already documented. The bug didn't just get patched. It became the precedent the next feature aggregating rows without a tenant column of their own cited when it shipped with the tenant filter already in its query, instead of having it audited in after a workspace saw a number it shouldn't have.

A row you make canonical across tenants is still, from every query's point of view, just a row — the tenant boundary you used to get for free now has to be asked for by name, every single time.
