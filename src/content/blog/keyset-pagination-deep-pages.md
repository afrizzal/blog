---
title: 'Keyset pagination, or why page 5,000 kills your database'
description: 'OFFSET/LIMIT is fine on page 2 and catastrophic on page 5,000, because the database scans and discards every row it skips. Keyset pagination keeps the cost flat no matter how deep the page.'
category: 'Systems & Performance'
pubDate: 2026-06-22
tags: ['database', 'pagination', 'postgres']
draft: true
---

`OFFSET`/`LIMIT` pagination is fine on page 2 and catastrophic on page 5,000, because the database has to scan and throw away every row it skips. Which pagination scheme you ship is an interface decision, not a tuning knob — and the cheap-looking one quietly bills you under load you never tested for.

## The cost you cannot see in the query

Here is the query every API ships on day one:

```sql
SELECT id, title, created_at
FROM articles
ORDER BY created_at DESC, id DESC
LIMIT 20 OFFSET 99980;
```

It reads fine. It is a trap. To return rows 99,981 through 100,000 — page 5,000 at 20 per page — the database must produce the first 99,980 rows in sorted order and then discard them. `OFFSET` is not a seek; it is a count-and-throw-away. Cost is `O(offset + limit)`, and the limit shrinks to a rounding error as the offset grows. Page 2 touches 40 rows. Page 5,000 touches 100,000 to hand back 20. Same query, same index, 2,500x the work.

The sibling problem — [an index that fooled the planner with a bad cardinality estimate](/blog/index-that-made-the-query-slower/) — is the planner making a correct choice on top of wrong numbers. This one is the opposite: the estimate is right, the plan is right, and it is *still* linear in page depth. No index fixes it, because the work isn't finding the rows. It's skipping them.

## "Nobody pages that deep" is wrong

The usual pushback: real users stop at page 3. True. But your `OFFSET` query is not served only to real users. Scrapers crawl to the last page on purpose. Export jobs walk the entire table 100 rows at a time. "Load more" loops keep incrementing an offset until they hit the end. A retrying integration replays the same deep request in a tight loop. The deepest, most expensive pages are exactly the ones automated traffic hammers — and they surface in your slow query log at 3 a.m., not in a user's browser.

So the design question is not "how deep will a person scroll." It is "what happens when something pages to the end of this table" — because something always will. You size the access pattern for the worst caller, not the median one, because the worst caller is guaranteed to exist. That is the call, and it is the kind that ages well: the cost stays flat whether the table holds ten thousand rows or ten million.

## Keyset: remember where you stopped

Keyset pagination (also called seek pagination) throws out page numbers. Instead of "skip 99,980 rows," you say "give me the next 20 *after the last row I saw*." You remember the sort key of the last row on the previous page and ask for everything past it:

```sql
SELECT id, title, created_at
FROM articles
WHERE (created_at, id) < ('2026-06-22 09:00:00', 48213)
ORDER BY created_at DESC, id DESC
LIMIT 20;
```

That `(created_at, id) < (?, ?)` is a **row-value comparison** (a tuple comparison): it compares the pair lexicographically, exactly the way `ORDER BY created_at DESC, id DESC` sorts. Backed by a matching composite index, the database jumps straight to the boundary and reads 20 rows. No skipping. The cost is `O(limit)` — flat, whether it is page 2 or page 50,000.

The index has to match the sort: both columns, same direction.

```sql
CREATE INDEX articles_feed_idx
ON articles (created_at DESC, id DESC);
```

Now the `WHERE` clause is a range scan starting at the cursor, and the `ORDER BY` is satisfied by walking the index. The plan reads the same on every page.

One precondition: the sort columns must be `NOT NULL`. A `NULL` inside a tuple comparison makes the predicate evaluate to `UNKNOWN`, which silently drops those rows from the page. If a sort column is genuinely nullable, pin the nulls to one end with `NULLS LAST` and carry that through both the `ORDER BY` and the index, or the boundary math stops being a total order.

## The tiebreaker is not optional

It is tempting to paginate on `created_at` alone. Don't. `created_at` is not unique — bulk imports, batch jobs, and ordinary concurrency stamp many rows with the same timestamp. Without a unique tiebreaker there is no *total order*, and rows that tie on `created_at` sit in an arbitrary, unstable position relative to your page boundary.

The failure is concrete. Say five rows share `09:00:00` and your page boundary lands in the middle of them. `created_at < '09:00:00'` skips all five — you **lose** the rows on the far side of the boundary. Switch to `created_at <= '09:00:00'` to stop dropping them and you re-fetch the ones you already returned — now you **duplicate**. Either way the page is wrong, and only intermittently, which makes it miserable to reproduce.

Appending a unique column — the primary key is the natural choice — gives every row a single unambiguous position. `(created_at, id)` is unique even when `created_at` is not, so `< (?, ?)` has exactly one correct answer for "the next row." The tiebreaker is what makes the contract sound.

## Tuple comparison is not portable

PostgreSQL supports `(a, b) < (?, ?)` natively and uses the composite index for it (since 8.4); it is the clearest way to write the query, so use it there.

MySQL 8 is the trap. It *parses* the same row-constructor syntax, but for a row-value inequality the optimizer only uses the leading column of the index and filters the rest — so the scan is no longer flat-cost. On MySQL, write the logically equivalent expansion instead:

```sql
WHERE created_at < ?
   OR (created_at = ? AND id < ?)
```

Same result, and on MySQL it is the form the optimizer can actually drive with the full `(created_at, id)` index. Don't take that on faith on either engine: run `EXPLAIN` and confirm the composite index is used end to end — on MySQL, check that `key_len` covers both columns, not just the first.

## Don't leak your internals: opaque cursors

Don't put `created_at` and `id` in the URL as raw query params. They are implementation detail, and once a client depends on their shape you can't change your sort key without breaking them. Hand back an opaque cursor instead — base64 of the boundary tuple:

```ts
// encode the last row of the page into a cursor
const cursor = Buffer.from(
  JSON.stringify([lastRow.created_at, lastRow.id])
).toString('base64url');

// decode it on the next request
const [createdAt, id] = JSON.parse(
  Buffer.from(cursor, 'base64url').toString()
);
```

The client treats `cursor` as a meaningless token and echoes it back for the next page. You keep the freedom to change what's inside it — add a column, swap the sort, sign it against tampering — without a breaking API change.

## The trade you are actually making

Keyset is not free. You lose random access: there is no "jump to page 50," because the cursor only knows where the *last* page ended, not where an arbitrary page begins. You get cheap next/prev — cursors and infinite scroll — instead. For feeds, public APIs, and export jobs, that is the right trade: those workloads page forward, and they page deep. `OFFSET` is still fine for small, bounded, human-browsed result sets — an admin table with 40 rows and a page picker doesn't need any of this.

That choice is the point. Picking keyset is picking a pagination *contract* whose cost stays flat as the table grows, designed for the traffic you actually get — bots and exports included — not the three pages a person clicks. `OFFSET` looks fine in the demo and bills you later, at the depth nobody tested.

Paginate from where you stopped, not from how far you've come.
