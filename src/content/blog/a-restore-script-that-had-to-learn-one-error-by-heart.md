---
title: 'A restore script that had to learn one error message by heart'
description: 'A disaster-recovery script that treats every non-zero exit code as failure is only correct until the tool it wraps has a documented limitation of its own — then it starts lying about restores that actually worked.'
category: 'Systems & Performance'
pubDate: 2026-08-13
tags: ['postgres', 'reliability', 'architecture', 'data-integrity']
draft: true
---

A restore script's job is to tell the truth about whether the restore worked, and the honest default — any non-zero exit code from the underlying tool means failure — turns out to be wrong the moment that tool has a known limitation of its own. On AIDA, an AI-native helpdesk, `scripts/restore.sh` wraps `pg_restore --clean --if-exists` to bring a Postgres dump back onto a fresh instance. A full seed-backup-destroy-restore-assert round trip against a live `docker compose` stack surfaced the case: `pg_restore` returned exit code 1 against this project's real schema even when every row of application data came back intact.

## The failure was real, but it wasn't the restore's

`pg_restore --clean` drops each object before recreating it, and one of those objects is `pgboss.job` — the job-queue table pg-boss creates as a Postgres native partitioned table with a declared primary key on `job_common`, the parent of the partition hierarchy. Postgres refuses to drop a constraint that a partitioned table's children inherit; `pg_restore` hits that refusal, prints an error for that one statement, and keeps going — the rest of the dump, including every application table, restores cleanly. The tool's own exit code doesn't distinguish "one statement failed for a known structural reason" from "the restore is broken." It just reports a nonzero count of errors and lets the caller decide what that means.

```sh
# restore.sh, after pg_restore --clean --if-exists runs:
# A bare `[[ $? -ne 0 ]]` here would report failure on every restore of this
# schema, forever — pgboss.job's partitioned primary key can't be dropped
# cleanly, and that's a pg_dump/pg_restore limitation, not app data loss.
if grep -q 'cannot drop inherited constraint' "$restore_log" \
  && ! grep -vq 'cannot drop inherited constraint' "$restore_log"; then
  echo "Restore completed (pgboss partition constraint warning is expected)"
else
  echo "Restore failed — see $restore_log" >&2
  exit 1
fi
```

## Tolerating one error message is not the same as tolerating errors

The naive fix — swallow `pg_restore`'s exit code and always report success — would have been strictly worse than the honest-but-wrong default it replaced. The script has to keep failing loudly on everything else: a corrupted dump file, a permissions error, a genuinely missing table. So the check isn't "did `pg_restore` exit nonzero," it's "does the error log contain *only* that one specific, known-benign message." Any other line in the log — any error the script hasn't been told to expect — still aborts the restore and surfaces the raw log to the operator. The allowlist has exactly one entry, and it's an exact string match against a message tied to a documented Postgres behavior (constraints inherited by partition children can't be dropped independently of the parent), not a pattern loose enough to catch adjacent, unrelated failures by accident.

That asymmetry is the actual engineering decision here: erring toward "restore reported as failed when it actually worked" is an annoyance an operator can double-check by hand; erring toward "restore reported as succeeded when data is actually missing" is the failure mode a disaster-recovery script exists to prevent. Given a choice between a script that's occasionally too pessimistic and one that's occasionally too optimistic, the pessimistic default is the only safe one to loosen, and only for an error the team can name and explain.

## The fix only earned trust from a real round trip, not a green exit code

`restore.sh`'s new tolerance wasn't validated by making the exit code turn green — it was validated by seeding a database, running `backup.sh`, destroying the container, running `restore.sh` against the fresh instance, and then asserting against the restored data directly: a specific row present in Postgres, a specific uploaded file present on disk. An exit-code check alone can't tell you the difference between "the restore succeeded" and "the restore's failure-detection logic has a bug that happens to agree with a green exit code today." Proving the round trip against real rows and real files is what makes tolerating that one error message defensible instead of just convenient — the assertion isn't "the script says it worked," it's "the data that mattered is actually back."

`docs/OPERATIONS.md` documents this exact message and why the script treats it as benign, so the next person reading a restore log that mentions `cannot drop inherited constraint` doesn't have to rediscover the reasoning from scratch — the log line, the constraint, and the partition it belongs to are all named in one place instead of living only in a script comment nobody reads until something goes wrong.

A backup-and-restore script's whole reason to exist is to be trusted more than a human running the same commands by hand under pressure, and that trust has a narrower scope than "exit code zero." It has to know, by name, the one error its own dependency is documented to produce — and refuse to extend that same leniency to anything it doesn't recognize.
