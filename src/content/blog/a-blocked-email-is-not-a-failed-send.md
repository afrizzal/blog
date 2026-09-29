---
title: 'A blocked email is not a failed send'
description: 'A mail guard that throws an exception when it blocks a message teaches the retry queue to keep attempting a send that will never be allowed to leave the process — the harder design keeps a policy block and a transport failure looking nothing alike, then proves a worker killed after the send is recorded but before acknowledgment leaves one copy, not two.'
category: 'Systems & Performance'
pubDate: 2026-09-29
tags: ['reliability', 'queues', 'email', 'architecture']
draft: false
---

An outbound email guard for a system that has not gone live yet has to hold two guarantees that pull in opposite directions: no message may ever reach a real person by accident, and a message the system is allowed to send has to actually arrive, even if the worker sending it gets killed mid-flight. On a training-academy information system I am building that is still pre-production, getting the acknowledgment semantics wrong in either direction breaks one of those guarantees. Treat a policy block like a delivery failure and the retry queue spins forever on a message that will never be allowed out. Treat a real crash like a policy block and a real invitation silently never arrives at all.

## A blocked message and a failed send have to look nothing alike to the retry logic

Every mail transport in the application is wrapped by a single guard, installed by extending the framework's own mail-manager binding so it resolves to a guarded manager, rather than adding a check inside each mailer. That matters because no caller — a queued job, a mailer built on demand, one member of a composite failover or round-robin transport — has a path around it. The guard reads the message's actual recipients, `to`, `cc` and `bcc` together, asks a **policy** object whether any of them should be blocked, and only forwards the send if the answer is no. One recipient that fails the check blocks the whole message, so there are no partial sends — and because the policy is fail-closed, any path it does not explicitly allow ends as a block.

```php
public function send(RawMessage $message, ?Envelope $envelope = null): ?SentMessage
{
    $recipients = $this->recipients($message, $envelope);
    $reason = $this->policy->reasonToBlock($this->transport, $this->host, $recipients);

    if ($reason !== null) {
        // A policy block is a decision, not an outage: returning null instead of
        // throwing tells the outbox the job is done, so nothing keeps retrying a
        // send that the policy will refuse again on every future attempt.
        Log::warning('outbound_blocked', [
            'reason' => $reason,
            'mailer' => $this->mailer,
            'transport' => $this->transport,
            'recipient_count' => count($recipients),
            'recipients' => array_map(Fingerprint::of(...), $recipients),
        ]);

        return null;
    }

    return $this->inner->send($message, $envelope);
}
```

The fingerprint in that log line is a truncated HMAC over the lowercased address, keyed with a value only the application holds — not the address, not the domain, not a hash an attacker could brute-force offline against a list of guesses. A log whose whole purpose is proving a block happened should not double as a mailing list of who almost got emailed.

## Two independent rules decide whether a message leaves the process, not one

The policy behind `reasonToBlock` runs two checks that do not share a condition. Destinations flagged as a **sink** — a local mail-testing service, or any transport that never actually leaves the process — accept only recipients on a small set of synthetic domains, and that restriction holds no matter what a **kill switch** elsewhere in configuration is set to. Destinations that are not a sink only open at all when that kill switch is off, and only to addresses on an explicit allowlist. The two axes are independent by construction: one governs whether the destination is even real, the other governs whether real destinations are currently allowed to receive anything.

That independence was not what the plan said. The plan this guard was built from described the rule as one axis — kill switch on means only the sink is reachable, kill switch off means the allowlist opens — which reads as reasonable until you enforce it literally: read as written, it lets the sink accept non-synthetic recipients the moment the switch is turned off, which contradicts the same plan's own must-haves, where the sink accepts synthetic domains and nothing else, unconditionally.

The implementation took the stricter reading of both by refusing to treat "is this a sink" and "is the kill switch engaged" as the same decision. A sink stays restricted to synthetic domains unconditionally, and the kill switch only ever decides whether the world outside the sink opens up. The deviation was then written back into the phase's shared contracts, not just the plan summary, so that plans not yet executed read the same rule the code enforces.

## An invitation that carries nothing cannot be turned into a way in

Account invitations sent through this guard are deliberately plain text, with no link, no token, no code, and no application URL anywhere in the body — a departure from the framework's Markdown mail layout, whose header links the application's own URL automatically. Plain text also makes that property provable by reading one view file rather than tracing a vendor layout. Whoever receives an invitation gets their name, a note that an account now exists without a password, and nothing to click; the one-time activation link is handed to them directly by an administrator, out of band from email entirely. The design question this answers is not "how do we stop this email from leaking" — leaks happen regardless of how careful anyone is — but "what happens if it does." An invitation with nothing actionable in it gives a wrong recipient, or a compromised mailbox, nothing to act on.

## The only convincing proof of at-least-once kills the process at exactly the wrong instant

A stand-in transport can tell you a `send()` method was called. It cannot tell you whether a real message already left the process before something failed, because nothing it tracks is external to the test itself — and that is precisely the gap where a delivery guarantee actually gets tested. So the test that proves invitations are delivered at-least-once runs a real queue worker in a separate operating-system process against a real local mail-testing inbox, and kills that worker with `SIGKILL` at a precise moment: after the message has genuinely gone out and the record of it has committed, but before the outbox message that carried it has been acknowledged. The test does not replace the real handler to get there; a thin wrapper runs the real one, drops a marker file once it returns, and then sleeps so the test has something to kill.

A naive design would double-send here — the job looks unfinished, so redelivering it would run the send again. What actually happens is that the send runs inside a database transaction that first inserts an **effect marker** keyed to the invitation — one account, one invitation, forever — and that transaction commits as soon as the send returns, before anything waits on acknowledgment. When the killed job is redriven and the same handler runs a second time, the marker insert finds the row already there, so the send is skipped and the job completes without sending anything again. The mail-testing inbox still shows exactly one message. The outbox row simply catches up from dispatched to processed on its second attempt, with a redrive count of one to show that the kill really happened.

## At-least-once still means an email has to be safe to arrive twice

That result proves one path, and the plan summary says so up front, in a table of claims written so the test would not read stronger than it is. The marker and the send share a transaction, but handing a message to a mail server and committing a database row cannot be made atomic without a distributed transaction. A worker that dies after the mail server has accepted the message but before the marker commits leaves no record behind, and the next delivery sends again — the recipient gets two copies. That is the outbox's at-least-once contract for external effects working as written, not a gap in the test, and exactly-once external delivery is listed as not claimed.

The consequence lands back on the invitation itself. Because a second copy is always possible, every email the system sends has to be harmless to receive twice, which means carrying no one-time action that breaks when repeated. An invitation with no link and no token already meets that bar for the same reason it survives a wrong recipient: there is nothing in it to use up.

A guard can promise that a blocked email never leaves, but an outbox can only promise that an allowed one leaves at least once — so the email itself has to be safe to arrive twice.

---

## Sources

- Laravel — *framework/src/Illuminate/Mail/resources/views/html/message.blade.php, 13.x branch* (the default Markdown mail layout passes `config('app.url')` to its header component, which renders it as a link). Retrieved 2026-09-29. <https://github.com/laravel/framework/blob/13.x/src/Illuminate/Mail/resources/views/html/message.blade.php>
