---
title: 'A migration history looks complete until you build from nothing'
description: 'A migrations folder that only ever runs on top of an already-existing database proves nothing about whether it can build that schema from scratch, and the gap between what was written down and what was actually in production stayed invisible for months until someone finally tried.'
category: 'Systems & Performance'
pubDate: 2026-10-11
updatedDate: 2026-10-25
tags: ['postgres', 'data-integrity', 'reliability', 'architecture']
draft: false
---

A migration file that has run cleanly in production for months proves it can extend a database that already has most of the schema. It proves nothing about whether it can build that schema from an empty one. On a marketing-intelligence platform I maintain for a multi-branch aesthetic clinic chain, that distinction was worth 45 tables and nine columns that existed in `schema.prisma` and in the live database, but not in a single file `prisma migrate deploy` would ever run.

![A finished building stands on its old base; its copy rebuilt on bare ground has upper floors floating over missing lower parts traced in amber.](../../assets/blog/a-migration-history-looks-complete-until-you-build-from-nothing/rebuilt-from-bare-ground.webp "Concept illustration, generated with Codex: rebuilt from the written steps alone, the parts added by hand are simply missing.")

## `db push` doesn't fail loudly; it just stops writing anything down

Prisma gives you two ways to move a schema change into a database. `migrate dev` generates a SQL file, applies it, and writes it into the migrations folder — a permanent, replayable record. `db push` applies the change directly to whichever database you're connected to and writes nothing down at all. Both commands leave you with a database that matches `schema.prisma`. Only one of them leaves you with a way to prove that to anyone else, or to a future empty database.

The planning record shows how a project ends up on the second path without anyone deciding to skip a step. One phase, built for a local demo, synced its schema with `db push` on purpose and committed no migration file — the plan said so in writing. Other phases' notes record `prisma migrate dev` itself as broken in this project by "shadow DB drift", with `db push` written down as the fallback for local iteration. Either way, the running database absorbed the change and moved on. Nothing about the next `prisma migrate deploy` would ever notice, because that command only replays migrations that exist; it has no way to ask whether the database in front of it got there by an unrecorded shortcut.

That shadow-database note deserves a second look. `migrate dev` works by replaying the entire migrations folder into a scratch database, so a history that can't build the schema from empty can't build a shadow database either. By late April this history already contained a tracked migration that alters a table no earlier migration creates — a replay from empty stops right there. The record never connects the two, but it's the obvious suspect, and it makes the workaround self-reinforcing: every `db push` that routes around a broken `migrate dev` writes nothing down, which widens the gap that broke it.

## Production forgiveness is what let the gap reach 45 tables

`schema.prisma` had grown to 120 models by the time anyone checked. The first missing table surfaced on its own, the first time `migrate deploy` was pointed at a genuinely empty database, and got a one-table backfill. The sweep that followed found 44 more that had never been captured by a tracked migration. One was a branch table that many of the others reference by foreign key, so it got its own migration. Of the remaining 43, twenty-six did have a `CREATE TABLE` statement somewhere in the repository — inside a hand-written `manual_*.sql` file that nothing in the actual deploy pipeline executes. Seventeen had no SQL record anywhere at all, tracked or otherwise.

None of this broke anything, because production had been migrating forward continuously since April, from a database that already carried every one of those tables. Every new tracked migration applied cleanly on top of that base and `migrate deploy` kept exiting zero, because exiting zero only means every migration it knows about applied — not that the set of migrations it knows about is the complete story. The only way to see the missing tables was to point `migrate deploy` at a database that had never once been touched by `db push`: a genuinely empty one, which is exactly the database this project had never actually tried building.

## A clean `migrate diff` on the tables wasn't the finish line

The fix for the table-level gap rebuilt each missing table from its `schema.prisma` model definition, wrapped in an idempotent `DO $$ ... IF NOT EXISTS ... $$` block — a no-op against production, where every table already exists, and a real `CREATE TABLE` against anything built from scratch.

The model definition alone wasn't enough, though, because a backfill doesn't run at the end of history; it runs at the timestamp it's given. Each backfill was dated to land before the first tracked migration that assumes its table exists, and columns that a later tracked migration adds with an unguarded `ADD COLUMN` were deliberately left out of the base table, so that later migration would still apply instead of colliding with its own column. The blocks were ordered so foreign-key targets landed before the tables that reference them. Against a fresh empty database, `prisma migrate deploy` ran all 73 migrations with zero errors, and `prisma migrate diff` reported zero drift on every backfilled table.

That still wasn't proof the schema was reproducible, and the commit message said as much: the diff was not empty. The remaining output sat on tables that had been tracked for a long time, and it was written off as pre-existing drift, out of scope. It wasn't out of scope. Same root cause, one level down: `db push` had also been used to add individual columns to existing tables, and a migration history can be complete at the table level while still lying about what's inside them.

## The proof that mattered wasn't a diff — it was a script that had nothing to do with migrations

The column-level drift was a status enum and its column on the tenant table, plus eight more columns and one missing default spread across seven other tables. It wasn't cosmetic: a local recovery script — the one that recreates the tenant, the admin account, and the default workspace after a database reset — failed outright against a freshly-migrated database with `column groups.status does not exist`. A schema that "has all its tables" can still be missing the one column an ordinary script needs on its very first query.

```sql
-- Guarded so this is a no-op wherever the column already exists (added
-- out-of-band via `db push`, never captured by a tracked migration) --
-- only a database rebuilt from zero actually needs the ALTER to run.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'GroupStatus') THEN
    CREATE TYPE "GroupStatus" AS ENUM ('PENDING', 'ACTIVE', 'SUSPENDED');
  END IF;
END $$;

ALTER TABLE "groups" ADD COLUMN IF NOT EXISTS "status" "GroupStatus" NOT NULL DEFAULT 'ACTIVE';
```

The fix stayed deliberately narrow: only columns whose absence would make an ordinary query fail with "column does not exist," not every difference `migrate diff` could find. Renamed foreign-key constraints, renamed indexes, and a few redundant database-level id defaults were left alone and logged as follow-up — cosmetic drift that costs nothing to defer, next to functional drift that had just blocked a recovery path. Verified the same way as before: fresh empty database, `migrate deploy` (74 migrations, zero errors), `migrate status` reporting up to date, `prisma generate`, and this time the recovery script ran end to end and actually created its rows.

A migrations folder is not evidence your schema is reproducible. It's evidence that every migration inside it applied to whatever database happened to be sitting there — and the only way to find out whether that's the same claim is to hand it a database that was never anything.
