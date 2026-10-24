---
title: 'A re-shown price is not a re-confirmed price'
description: 'A transfer modal refused a stale price and redrew the correct one, yet the retry failed the same way: the preview was recomputed on every render, while the hidden price it resubmitted only changed when a batch was picked. The fix writes that token from the same query at the moment of rejection.'
category: 'Systems & Performance'
pubDate: 2026-10-18
updatedDate: 2026-10-25
tags: ['concurrency', 'reliability', 'architecture', 'data-integrity']
draft: false
---

In the admin panel of a pre-production training-academy information system I'm building, moving a registration to another batch can change what the customer still owes, so the transfer modal previews the money before an admin confirms. A browser test caught that modal redrawing the correct price after a rejection and then failing the retry for the same reason, with the same notification. The server was right both times. The modal recomputed the price it displayed on every render, but the price it would resubmit only changed when the admin picked a batch — two values that look like one, refreshed by two different events.

## The hidden price is the admin's signature on what they saw

The decision behind the preview is short. Before confirming, the modal shows the destination batch's price, how much already-verified money moves with the registration, and the resulting shortfall or excess. A hidden `expected_price` field carries the destination price the admin was looking at. On submit, the server takes its locks, including one on the destination batch, re-reads the live price, and compares. If someone changed that batch's price after the preview, the transfer is refused with a message that, translated, reads: "The destination batch's price has changed since the preview. Check the latest preview, then confirm again." The design asks for exactly one extra round-trip: the admin looks, confirms again, and the transfer lands.

That hidden field is not a cache. It is the only record of which number the admin agreed to, and the guard is only as good as the moment that record was last written.

## The preview and the token were refreshed by different events

Both the transfer modal and the reschedule-approval modal build their destination fields from one shared definition. Trimmed to the three parts that matter:

```php
Select::make('target_batch_id')
    ->live()
    // The token is written here and only here: when the admin picks a batch.
    ->afterStateUpdated(fn (Set $set, ?string $state) => $set('expected_price',
        $state === null ? null : self::preview($registrationId, $state)?->targetPriceIdr)),

Hidden::make('expected_price'),

// The preview text is a closure, so every render re-queries the live price.
Text::make(fn (Get $get): string => self::summary($registrationId, $get('target_batch_id'))),
```

Read side by side, the bug is already there. The preview line has no memory; it asks the database each time the modal renders. The token has nothing but memory; it updates only when the select changes. A rejection re-renders the modal without the admin choosing anything new, so the text moves on to the current price while the token stays where the select left it.

![A display card shows a fresh tall bar; a hidden slip clipped behind it, edged in amber, still shows the older, shorter bar.](../../assets/blog/a-re-shown-price-is-not-a-re-confirmed-price/the-front-card-and-the-stale-slip.webp "Concept illustration, generated with Codex: the card on show was redrawn; the slip that gets submitted still carries the old value.")

## The browser test reproduced it with one direct price update

The scenario the test drives in real Chromium: a registration fully paid at Rp1,000,000, a transfer target priced Rp1,200,000, and a preview showing Rp1,000,000 moved and Rp200,000 short. Once that preview is on screen, the test updates the destination's price to Rp1,300,000 directly in the database, standing in for an edit made elsewhere. The first confirm is refused, correctly, and the registration stays where it was. The modal re-renders with Rp1,300,000 and a Rp300,000 shortfall. The test then clicks confirm again and expects the transfer to land at Rp1,300,000.

Before the fix, it didn't. The second confirm still carried Rp1,200,000; the server compared it with Rp1,300,000 and refused again — two identical notifications in the failure screenshot, for a preview that was already correct. One test failed across the browser suites for the two modals. The message had told the admin to check the latest preview and confirm again, the admin did exactly that, and the modal resubmitted the old preview instead.

## The fix sits one layer above a runner that must not know about modals

Admin table and modal actions in this codebase call their domain actions through a shared runner. It catches rule violations and validation errors, turns the message into a persistent notification, and throws Filament's `Halt` so the modal stays open instead of erroring. More than forty call sites use it — payments, certificates, website content, and more — so it has no business knowing that two of them carry a hidden price. The fix wraps it only for the transfer and reschedule-approval modals:

```php
public static function run(HasActions $livewire, string $registrationId, array $data, Closure $call): mixed
{
    try {
        return ModuleActionRunner::run($call);
    } catch (Halt $halt) {
        // The modal stays open and re-renders its preview from the live price. Write that same
        // price into the token now, so the next confirm vouches for the preview about to be shown,
        // not for the one the admin saw before the rejection.
        $batchId = $data['target_batch_id'] ?? null;
        $mounted = data_get($livewire, 'mountedActions');
        $index = is_array($mounted) ? array_key_last($mounted) : null;

        if (is_string($batchId) && $batchId !== '' && $index !== null) {
            data_set($livewire, "mountedActions.{$index}.data.expected_price",
                self::preview($registrationId, $batchId)?->targetPriceIdr);
        }

        throw $halt;
    }
}
```

Two details carry the design. The rejection itself carries only a message, so the wrapper recomputes the price with `self::preview()`, the same query the preview text renders from — the number written and the number displayed now share a source. And it writes into the open modal's own state on the Livewire component, the place the next confirm reads from, rather than into the local `$data` array, a copy that is discarded with this request. It runs on any halt, not only a price mismatch, and that breadth is harmless: whatever kept the modal open, the preview it redraws is current, and the token should agree with it.

## The server check did not move, and that is the point

Nothing in the transfer action itself changed. The comparison still happens under the destination batch's lock on every confirm, so a price edit that lands between the rejection and the retry is refused exactly as the first one was. The fix doesn't loosen the guard or let the modal skip a round; it changes which number the modal is able to vouch for. Afterwards, the browser suites for both modals passed seven of seven; thirty-five feature tests covering transfer preview, transfer rules, the transfer itself, reschedule requests, and batch-cancellation follow-up passed; static analysis reported zero errors.

## Every path that redraws the screen must also rewrite the token

The shape generalizes to any value a client holds only to detect drift — a price, a row version for optimistic locking, an `updated_at` stamp, an ETag. The obvious version of this bug sets the token once and never again. This one is quieter: the token was refreshed on the path everyone pictured, picking a batch, and not on the path the guard itself creates, the rejection that redraws the screen. A guard that tells the user to look again has to rewrite its own memory on that same path, or the next request is not a retry — it is a replay of the one that already failed.

The admin read the new price and confirmed it; the modal confirmed the old one, and the server was right to refuse it twice.
