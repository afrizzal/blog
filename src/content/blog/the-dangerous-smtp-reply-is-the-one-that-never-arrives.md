---
title: 'The dangerous SMTP reply is the one that never arrives'
description: 'An SMTP client whose connection drops after the end-of-data dot but before the server''s reply cannot know whether the message was accepted. A training-academy information system''s mail pipeline refuses to guess: that outcome is recorded as unknown, never retried automatically, and resolved only by a person.'
category: 'Systems & Performance'
pubDate: 2026-10-15
tags: ['reliability', 'queues', 'email', 'architecture']
draft: false
---

Most of the ways an email send can go wrong are easy to act on. The server says no — mailbox doesn't exist, try again later — and you have a fact. The hard case in the mail pipeline of a training-academy information system I'm building, still pre-production, is the opposite: no fact at all. A connection that drops after the whole message has been handed to the server, and before the server's reply comes back, doesn't mean the send failed. It means the sending side cannot know. A retry policy that files that silence under "no" will eventually send the same email twice; one that files it under "yes" will eventually lose one without a trace. This pipeline files it under neither.

## The handoff happens on a reply the client may never read

An SMTP send is a short conversation: name the sender, name the recipients, announce the body, stream it, end it with a line holding a single period, then wait for the server's verdict. RFC 5321 is explicit about what a positive verdict means: "once the server has issued a success response at the end of the mail data, a formal handoff of responsibility for the message occurs" — from then on, the server must either deliver the message or report that it couldn't. The server decides to accept on its own side. The client finds out one round trip later, if the connection survives that long.

That window is as old as the protocol. RFC 1047, from 1988, calls it a synchronization problem: once the receiver has decided to accept, the message is live on both machines, and the sender — which has to assume nothing was delivered until it reads the 250 — delivers it again if the link dies first. The current standard still carries the warning: a spurious timeout while the client waits for that reply "would typically result in delivery of multiple copies of the message," and servers are told to answer the final dot as fast as they can for exactly that reason. Between mail servers, the conventional answer is to re-deliver and live with the occasional duplicate. An application sending one trainee a payment link or a schedule reminder gets to choose differently.

The receiving side of the same contract — once you acknowledge, you own it — is what [OmniSync](/blog/omnisync-http-202-is-a-promise/) is built around. This post is about the other side: the one that never hears the acknowledgment.

## The transport flags the boundary before the final dot leaves, not after

The pipeline's SMTP transport extends Symfony Mailer's ESMTP transport, which Laravel's mailer sits on, and changes one thing: it remembers where in the conversation a failure happened. Symfony sends the end-of-data sequence through the same method as every other SMTP command — write the bytes, then read the reply — so the override sets a flag on the way in, before the parent writes anything:

```php
public function executeCommand(string $command, array $codes): string
{
    // Flag BEFORE the dot is written, not after the call returns: once the
    // first byte of the terminator is on the wire the server may accept, so
    // "the message never got there" stops being provable from this point on.
    if ($command === self::END_OF_DATA) {   // "\r\n.\r\n"
        $this->endOfDataSent = true;
    }

    return parent::executeCommand($command, $codes);
}
```

Setting it afterwards is the natural mistake, and a mutation test pins it down: move the flag to after the end-of-data command returns, and the three uncertain cases in the transport's fifteen-case unit table go red, because a timeout while reading the reply would then be filed as a failure that happened before the handoff.

When the send throws, the classifier reads that flag first:

```php
if ($this->endOfDataSent) {
    // Only an explicit SMTP verdict on the final dot proves non-acceptance.
    // A timeout, reset or read error from here on proves nothing either way.
    if ($e instanceof UnexpectedResponseException && $code >= 400 && $code < 600) {
        return new DeliveryRefused($code >= 500, $code, $summary, $e);
    }

    return new DeliveryUncertain($summary, $e);
}
```

Everything that fails before the flag — a 4xx or 5xx on `MAIL FROM` or `RCPT TO`, a TLS or authentication failure, a connection dropped mid-body — becomes `DeliveryRefused`, because the server never held a complete message. A 5xx, or a local rejection that would fail identically every time, is permanent. Everything else is transient and goes back on a bounded schedule: by default at most three automatic retries, one, five and fifteen minutes apart, after which the message is marked failed. An explicit 4xx or 5xx in answer to the final dot is also a refusal, because the server said so. Only the silent outcomes after the flag — timeout, reset, read error — become `DeliveryUncertain`.

## An uncertain outcome must not look like a transport failure to anything downstream

`DeliveryUncertain` deliberately does not implement Symfony's transport-exception interface. That isn't tidiness. Symfony's failover and round-robin transports catch transport exceptions and hand the message to the next configured server — which, after the final dot has gone out, is precisely a blind second send. A plain runtime exception passes through them untouched. The email channel above the transport maps it to its own outcome, and the attempt is recorded as `unknown` with the error code `no_reply_after_data`. No retry is scheduled, and the attempt is not called failed. The same channel files any unexpected exception from the send call as uncertain too, on the stated grounds that nobody can prove nothing left the process.

The vocabulary holds the same line at the other end. A clean 250 moves an attempt to `submitted`, labelled "accepted by server" in the admin interface rather than "delivered", because the RFC's handoff moves responsibility to the server, not the message into an inbox. And when an attempt carried a one-time link, the link is revoked if the attempt definitely failed but stays valid if the attempt is `unknown`: if the message may have arrived, killing its link would break the one copy that might already be in someone's inbox.

## The send runs outside every transaction so a dead worker still leaves evidence

The classifier only covers failures the transport sees. The other way to lose the reply is for the worker itself to die between the server's 250 and the database write that records it, and the transport never sees that. The pipeline handles it with shape rather than code: a send is three steps, and no database transaction spans the network call. Prepare is a short transaction that locks the message, re-checks that it's still relevant and still allowed out, issues its link token once, and commits a new attempt row in state `sending`. Send runs with no transaction open. Record is another short transaction that finalizes the attempt exactly once; a database trigger rejects backward transitions and rewrites of a final state. A job that gets re-driven later finds a message that is no longer `queued` and exits without effect.

A worker killed in the gap therefore leaves an attempt stuck in `sending`. A scheduled sweep runs every five minutes and moves attempts older than a threshold from `sending` to `unknown`, with the error code `stale_sending` and an audit entry — never to failed, never to a resend. The threshold defaults to eleven minutes, chosen to exceed the transactional-mail lane's timeout plus a margin, and the config file records it as a technical assumption rather than a decision the product owner has signed off on.

## The design this replaced sent the message twice, and a mutation run proved it

Before this pipeline, transactional messages went out with the pattern described in [A blocked email is not a failed send](/blog/a-blocked-email-is-not-a-failed-send/) for account invitations: the send ran inside the same transaction as an effect marker. That post was explicit about what the pattern can't cover — a worker that dies after the server accepts but before the marker commits leaves no record, so the next delivery sends again. The three-step pipeline closes exactly that gap for transactional mail, and its proof reuses the same harness — a real queue worker in its own OS process, a real local mail-testing inbox, `SIGKILL` — aimed at the instant that post left open.

The kill point is the framework's "message sent" event, which fires after the transport has read the server's reply and before the send call returns to the pipeline. A thin wrapper around the real email handler listens for it, drops a marker file and sleeps; the test kills the worker as soon as the marker appears. The inbox then holds exactly one message, and the attempt is still `sending`, because the worker died before the record step. The test runs the sweep with its threshold lowered to zero, and the attempt becomes `unknown`. Then it lets the outbox relay re-drive the job and starts a fresh worker running the unmodified handler: still one message, still one attempt, still `unknown`. It passed three consecutive runs.

The mutation run puts the old shape back — send inside the effect-marker transaction — and repeats the test. The inbox ends with two messages, and the assertion fails with "Failed asserting that 2 is identical to 1". That's the double send the earlier post conceded, reproduced on demand instead of described.

## A stub server that hangs up after the dot tests the protocol case without a mock

The kill test covers the worker dying in the gap. The protocol case — the server going silent after the final dot — has its own test. It starts a minimal SMTP server written in plain PHP as a child process on a random local port; in one mode it reads the message through the terminating dot and closes the connection without answering. The real transport talks to it over a real socket. The attempt ends `unknown` with `no_reply_after_data`, no retry is queued, and running the handler and the delivery action again produces no second attempt. In another mode the stub answers 451 to `MAIL FROM`, and that attempt ends `failed_transient` with a retry scheduled in the future. The two modes differ only in where the conversation breaks, and they land on opposite sides of the line. The file's three cases also passed three consecutive runs.

## Admitting uncertainty only helps if a person can resolve it

An `unknown` attempt doesn't resolve itself in either direction. The way out is a resend that an administrator triggers by hand, and every resend requires a typed reason of 10 to 500 characters. For an `unknown` message the form adds a checkbox acknowledging that the original may already have arrived; submitting without it is refused and the status stays `unknown`. A resend creates a new attempt with the next attempt number, carrying the reason and the administrator who sent it, while the old attempt, the template version it used and its history stay as they were. At no point is the message relabelled failed.

That moves the duplicate risk to the only place it can be weighed. Whether a second copy is worse than a missing one depends on who the recipient is, what the message asked them to do and whether they've already done it — context the mail transport doesn't have and shouldn't pretend to.

None of this makes the SMTP conversation any less ambiguous — it just stops the pipeline from pretending the ambiguity isn't there.

---

## Sources

- IETF — *RFC 5321: Simple Mail Transfer Protocol*, §2.1, §4.5.3.2.6 and §6.1 (a success reply at the end of the mail data is the formal handoff of responsibility; a spurious client timeout while awaiting that reply typically results in multiple copies; servers must minimize the time to answer the final end-of-data indicator). Retrieved 2026-10-21. <https://www.rfc-editor.org/rfc/rfc5321>
- IETF — *RFC 1047: Duplicate Messages and SMTP* (the synchronization gap between the receiver accepting a message and the sender reading the 250 reply; a sender must assume non-delivery until then and re-delivers if the link fails). Retrieved 2026-10-21. <https://www.rfc-editor.org/rfc/rfc1047>
