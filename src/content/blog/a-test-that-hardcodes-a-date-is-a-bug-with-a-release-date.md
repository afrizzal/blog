---
title: 'A hardcoded date in a test is a bug with a release date'
description: 'A test that pins a session to a real calendar date was harmless until a correct rule began locking a session''s room once it starts. One such test failed in CI on schedule; a clock-shifting audit of 18 suspect files found the other with about nine hours left before it would have fired.'
category: 'Systems & Performance'
pubDate: 2026-10-17
updatedDate: 2026-10-25
tags: ['testing', 'reliability', 'architecture']
draft: false
---

A date literal in a test fixture is harmless until some code under test starts comparing it to the clock. From that commit on, the test has a release date: it passes on every run until the wall clock crosses the date someone typed, then fails on every run after, with no code change in between. That isn't flakiness — flaky means unpredictable, and this is a deadline. On a training-academy information system I'm building, still pre-production, one correct business rule armed two of those deadlines in a single commit. The first went off in CI nine days later. The second was caught by a deliberate audit with about nine hours left on its fuse.

![A disc rolls along a straight paper track, motion lines behind it, toward an amber flag pinned into the track at one fixed point.](../../assets/blog/a-test-that-hardcodes-a-date-is-a-bug-with-a-release-date/the-present-meets-the-pinned-flag.webp "Concept illustration, generated with Codex: a date typed into a test is a flag the moving present will reach.")

## A rule that locks the past was working exactly as designed

The rule is simple: a session's room can change until the session's scheduled start, and after that it's locked. The plan that introduced it treats past sessions as history — references from sessions that already happened don't even block archiving a room. In code, it's one guard clause:

```php
private function roomError(?string $venueId, ?string $roomId, ?TrainingAgendaItem $existing): ?string
{
    $unchanged = $existing !== null && $roomId === $existing->room_id;

    // "Already started" is decided against now() — the one input no fixture writes.
    if ($existing !== null && ! $unchanged && ! $existing->starts_at->isAfter(CarbonImmutable::now())) {
        return (string) __('training.validation.past_session_location_locked');
    }
    // ...
}
```

Read in isolation, `! $existing->starts_at->isAfter(CarbonImmutable::now())` is an unremarkable guard. What makes it interesting is that `now()` is the one input to this function a test author never writes into a fixture. It comes from the wall clock the suite happens to run on, and it only moves in one direction.

## The commit that added the rule also edited the two tests it armed

The two tests were written a day before the rule existed, and neither is a scheduling test. Both are privacy checks: they create a session, update it — new title, new description, new meeting link, a different room — and assert that none of those values leak into the audit log. One pinned its session to 09:00 Asia/Jakarta on 5 October; the other to 09:00 Asia/Makassar on 7 October. When they were written, changing a room read no clock at all, so the dates were just data.

The next day the room lock landed, and the same commit edited both tests, rewriting their room swaps to pick from the new venue-room list. The plan summary written that afternoon even records the convention: tests that depend on the clock freeze time. These two didn't look like they depended on the clock — they were about redaction — and they weren't frozen. They passed, because 5 and 7 October were still in the future, and from that commit on each one had a release date.

## The first one went off on schedule, against commits that never touched it

On 5 October, a CI run at 07:14 Jakarta time was green. The next run, on commits that touched only an unrelated upload guard and its notes, was red on both PHP versions in the matrix: one failure out of 349 integration tests, a `ValidationException` carrying the room-lock message, thrown from a test whose subject was audit redaction. The session had started at 09:00. The rule did exactly what it was built to do; the test had simply outlived its own date.

## Freezing the clock is not the same as loosening the rule

The fix didn't touch the rule, and it didn't touch the shared fixture or its dates. Either change would have turned the test green, and either would have meant the test stopped checking what it claims to check. Instead the scenario freezes time explicitly, in the session's own time zone, an hour before the session starts:

```php
// Freeze an hour before the session, in the session's own zone: the rule stays
// live at its real boundary, and "today" stops being an input to this test.
$this->travelTo(CarbonImmutable::parse('2026-10-05 08:00:00', 'Asia/Jakarta'));

try {
    // ... create the session, swap its room, assert the room really changed
    //     and that no title, description, room or link reached the audit log
} finally {
    // A failed assertion must not leave every later test living on 5 October.
    $this->travelBack();
}
```

The framework's own teardown clears the test clock as a second line of defense. The assertions got stricter in the same commit, not looser: the test now also checks that the room really changed and that the audit row names the `room_id` field, on top of the redaction checks it existed for. A future version that quietly skipped the swap can't pass anymore.

## Proving the freeze didn't defeat the rule meant trying to break it on purpose

A frozen clock that always sits safely before the deadline could just as easily be hiding a rule that stopped firing — a test that can't go red isn't a test, it's a tautology with extra steps. So the fix came with throwaway mutants, never committed.

Remove the freeze, and the test fails with the same rule violation it was built to survive. Freeze the clock at 09:00 exactly, the session's start, and it still fails, because the rule's boundary is being exercised, not dodged. Leave the room unchanged, and it fails on the new assertion that the room actually changed. Force the scenario to throw inside the frozen window, and the next test in the same process sees the real clock, within a minute of `time()` — the `finally` block does its job. Four mutants, four expected outcomes. That's what separates "I froze the clock so the test passes" from "I froze the clock at a point where the thing being tested is still being tested."

## The first failure was a pointer, not the population

The more useful output of the first fix was a list. The same afternoon, a read-only follow-up named every rule that reads the current clock — the room lock, conflict checks that only consider upcoming sessions, venue archiving that respects batches in progress, RSVP cutoffs and attendance thresholds — and 18 test files that used the shared fixture's default dates or agenda without freezing time. It marked the risk as unproven and set a policy: nothing changes without evidence of a failure. A list of suspects is a hypothesis, and rewriting eighteen files on suspicion would have been churn with no defect behind it.

## A clock you can move is how a suspect list becomes evidence

The next evening the hypothesis got tested. A temporary harness, kept outside the repository and never committed, registered a PHPUnit extension that moved Carbon's clock to a simulated instant before each test's setup; the clock kept running from there, and the machine's system clock was never touched. All eighteen files ran at the real time and at nine simulated instants: the minute after the default batch dates ran out; one minute before, exactly at, and thirty minutes after 09:00 Asia/Makassar on 7 October; four dates across the following weeks in three different time zones; and one in June 2027.

Seventeen files came back identical at every point — same test counts, same assertion counts. The default dates running out broke nothing, and the fixed dates in those files are part of their scenarios, so they stayed. One scenario failed: the second redaction test, the one pinned to 09:00 Asia/Makassar on 7 October. It passed at 00:59 UTC and failed at 01:00 UTC — the session's start — and at every point after. The real clock would have crossed that line a little under ten hours after the harness first ran, on the main branch as well. The same freeze-and-restore fix landed about nine hours before the fuse ran out, with the same mutants; the no-freeze one was redundant, since the harness had just played it.

## An audit you can trust names what it didn't check

The write-up names its limits instead of implying it covered everything. The harness can't move child processes started with `php -r`, which ignore the `auto_prepend_file` hook a shift would need, and it can't move PostgreSQL's own `now()`; the write-up records that the child processes in the one suite that spawns them either don't read the clock or already receive a fixed one. A full local run of the feature suite was stopped after 1,423 tests with zero failures, because another workstream needed the shared test database, and the write-up says plainly that this is not proof of a full pass — CI is. And the scope was those eighteen files, not the whole project.

Those limits are what make the result usable. "Eighteen files checked at ten instants, one time bomb found and defused, these gaps not covered" is a claim someone else can verify or extend; "the suite is time-safe" is not.

A green suite only vouches for today, so if a test carries a date, move the clock there yourself before the calendar does it for you.
