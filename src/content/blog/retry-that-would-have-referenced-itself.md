---
title: 'The retry that would have referenced itself'
description: 'AIDA''s outbound email job derives References and In-Reply-To by querying every prior email-bearing message on the ticket. On a retry, the message being sent already has its own Message-ID persisted from the failed first attempt — without an explicit exclusion, it would show up in its own References chain.'
category: 'Systems & Performance'
pubDate: 2026-07-07
tags: ['reliability', 'queues', 'email', 'architecture']
draft: false
---

AIDA sends agent replies over email through a background job, and background jobs retry. The job that builds the **References** and **In-Reply-To** headers for that email works by querying every prior email-bearing message on the ticket — and on a retry, that query includes the message it's about to send for the second time, because the first attempt already wrote that message's own Message-ID to the database before the send itself failed. Left as written, the query would have made an email cite itself as one of its own ancestors.

## A queue that retries can't rely on what the last attempt remembered

Outbound replies go through a pg-boss job, not a synchronous send inside the request. `retryLimit: 2` with exponential backoff means a failed send gets up to three attempts, each one a fresh invocation with no memory of the last. That's the correct shape for the same reason [OmniSync's event pipeline treats a 202 as a promise, not a receipt](/blog/omnisync-http-202-is-a-promise/): a job that might retry can't keep anything important in a local variable between attempts, because there might not be a "between" — the process handling attempt two has no idea attempt one ever ran. Everything the handler needs has to be re-derived from the database on every single invocation, including the answer to "what came before this message on this ticket."

## Persisting an identity before confirming delivery is what set the trap

The **Message-ID** AIDA stamps on an outbound email is generated in a specific bracketed format up front, and it's reused verbatim on every retry — never regenerated. That's deliberate: if attempt one's SMTP send actually succeeded but the acknowledgment back to the job was lost, regenerating the ID on attempt two would hand the recipient two different Message-IDs for what should be one email, breaking the exact threading this system exists to preserve. So the ID gets written to the message row as part of the first attempt, independent of whether that attempt's send succeeds. By the time a retry runs, the message already exists in the ticket's set of "messages with a Message-ID" — the same set the References query selects from:

```ts
// src/lib/worker/jobs/email-outbound-send.ts — the query as first written
const priorEmailMessages = await db.message.findMany({
  where: {
    ticketId: message.ticketId,
    emailMessageId: { not: null },
  },
  orderBy: { createdAt: "asc" },
});
// references = priorEmailMessages.map(m => m.emailMessageId) — every row this
// returns becomes an ancestor claim in the outgoing header
```

On a first attempt, `message` doesn't have an `emailMessageId` yet at query time, so it can't match its own filter — the bug is invisible. On a retry, it does, and it can.

## Nothing in the schema tells you to exclude yourself

The **References** field exists to record a message's ancestors: RFC 5322 defines it as the parent message's own References field plus the parent's Message-ID, appended once per hop up the reply chain. The algorithm has no step where a message's identifier belongs in its own References — it's built by walking backward through what a message replied to, and a message has never replied to itself. A query that selects "every message on this ticket with a Message-ID" doesn't know that distinction unless it's told; `ticketId` and `emailMessageId: { not: null }` are both true of the row currently being sent, on the second attempt, and Prisma will return exactly what was asked for.

Nothing caught this in a test. There wasn't one to catch it — no integration test yet exercises the outbound handler against a live or fake SMTP server, a gap the phase's own plan summary flags openly rather than papering over. What caught it was reading the query back against what it was supposed to mean, during the same task that wrote it, before the commit: the fix and the bug shipped in the same change.

## The fix is one clause; the habit is asking what "so far" means on attempt two

```ts
// src/lib/worker/jobs/email-outbound-send.ts — corrected
const priorEmailMessages = await db.message.findMany({
  where: {
    ticketId: message.ticketId,
    emailMessageId: { not: null },
    id: { not: message.id }, // a retry already persisted its own ID — don't cite yourself
  },
  orderBy: { createdAt: "asc" },
});
```

The general shape outlives this one query. Any handler built to be retried safely ends up re-deriving "what's true about this ticket so far" from scratch on every attempt, and a message that failed to send once is still, unambiguously, part of "so far" — it has a row, a timestamp, and now a Message-ID, whether or not a mail server ever accepted it. Idempotent retry logic gets audited for double-charging or duplicate rows constantly; it gets audited far less often for the subtler version of the same mistake, where the thing you're about to (re)produce quietly counts itself among its own prerequisites.

A second attempt at sending isn't a first attempt with a different name — it inherits everything the first attempt already wrote down, itself included, and has to know to leave that one row out.

---

## Sources

- IETF — *RFC 5322, Section 3.6.4 (Identification Fields)* (defines References as the parent message's References field plus the parent's Message-ID, with no provision for a message's own identifier). Retrieved 2026-07-07. <https://www.rfc-editor.org/rfc/rfc5322#section-3.6.4>
