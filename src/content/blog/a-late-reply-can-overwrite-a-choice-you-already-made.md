---
title: 'A late reply can overwrite a choice you already made'
description: 'A registration form''s file-upload fields each fire an async initialization request on load. When one of those responses lands after the user has already picked a schedule, its older snapshot is merged over the newer choice and a generic required-field error blocks the save — and the first guard against it collided with the framework''s own queue.'
category: 'Systems & Performance'
pubDate: 2026-10-16
tags: ['concurrency', 'testing', 'reliability']
draft: false
---

When more than one in-flight request can write a form's state, the response that lands last wins — not the one that reflects what the user did last. On a training-academy information system I'm building, still pre-production, a browser test that failed in CI had every mark of ordinary flakiness: a registration form timed out waiting for a confirmation that never rendered. The reflexive fix is a longer timeout. Following it down instead turned up a real ordering bug in the form, a test that had never been synchronized to anything, and — after the first fix — a second bug the fix itself introduced in the framework's own action queue.

## A test that waits for the wrong signal can still be catching something real

The failing case picks a training schedule first and expects the form to show a registration-snapshot confirmation. In CI it gave up waiting for that text after 7.96 seconds, with no server error anywhere. The create form starts four async requests right after load — one per file-upload field, each a Filament `FileUpload` calling `getUploadedFiles` through `callSchemaComponentMethod` — and the test picked a schedule while all four were still in flight. The line it relied on to sync, a wait for the terms text, wasn't a synchronization point at all: that text is on the page from the first render, so waiting for it never waits for anything.

I reproduced the failure on purpose. An init script patches `fetch` in the browser so those async responses are held for 900 ms, then the same user steps run. Three runs out of three failed the way CI did: the schedule selection came back empty, the select's native `required` constraint reported `valueMissing`, the click on Create never sent a create request, and zero registrations were written. Without the hold, three out of three passed. Delaying on the server side didn't reproduce it, because the in-process test server blocks the test driver along with the response. What I could never observe was the actual response order on the CI runner itself — CI kept no screenshots — so the claim the record makes is a matching mechanism, not a replay.

The test fix adds no sleep. A small helper counts Livewire commits from `livewire:init`, treats a commit as done only after Livewire has merged the response and morphed the DOM, and waits until a commit has started, every commit has finished, and the page has been quiet for 250 ms. A first version built on waiting for network idle failed too. Waiting for `load` or `networkidle` through the browser-testing plugin couldn't have helped in any case: in the version in use, `Page::waitForLoadState()` calls `Client::execute()`, which is a PHP generator function, and never iterates the generator. A generator's body doesn't run until something iterates it, so the wait command never leaves PHP and the call returns within a millisecond.

## The response that lands last wins, even when it carries the oldest state

A synchronized test only makes the race deterministic; it doesn't make it go away. Each `FileUpload` loads its file list through its own async call, with its own message and request, and each of those carries the component snapshot as it was when the request left. With the versions in use — Livewire 4.4.5 and Filament 5.8.2 — when one of those responses was merged after the user's own commit, its older snapshot overwrote the newer state, and the schedule and customer the user had just picked went back to their initial values: empty.

Nothing in that sequence raises an error that names the cause. The browser's own `required` check on the now-empty select is what blocks the save, and it tells a user who just filled the field to go fill it. It rhymes with [a validation error that was actually a rendering race](/blog/a-validation-error-that-was-actually-a-rendering-race/), but the mechanism is different in a way that matters: there, a hidden form element wrote an empty value over the field on every provider switch, deterministically, through React's own commit order. Here, nothing on the page misbehaves on its own — the rollback depends on how independent requests interleave, so a fast local run can pass every time while a slow network, or a server answering requests on several workers, reorders the replies.

## Deferring the user's action is safer than locking the form

The fix touches no vendor code, upgrades nothing, and adds no delay. A render hook scoped to the registration create page installs a guard through Livewire's public interception API, `interceptMessage` and `interceptAction`, for that page's component only. While any `getUploadedFiles` message from that component is outstanding, every other Livewire action on it is deferred into the guard's queue — deferred, not canceled — and the form never locks. The queue releases when the last initialization message ends, on any ending: a successful response has already been merged and morphed by then, and an HTTP error, a network failure, or an abort is never merged at all. Either way, no stale snapshot can still arrive behind the user's commit.

One detail of the first write-up was wrong and the record corrects it: the release doesn't send actions one by one, in order. It fires them all at once; Livewire bundles the non-async ones into a single message after its 5 ms buffer, which the server processes in queue order, while async actions get their own parallel requests.

The regression test holds the `getUploadedFiles` responses in the browser and releases them in the reverse of the order they were sent. It waits only until the initialization requests are *sent*, not finished, then picks a schedule and a customer, sets the confirmation checkbox, and saves. It asserts the schedule is still selected, exactly one registration lands on the right schedule, and the confirmation email count matches the checkbox. Without the guard, both dataset cases failed with the schedule blanked; with it, both passed.

## A guard against one race collided with the framework's own queue

The follow-up was a dedicated browser test that controls the network directly: hold the initialization call, then release it as the real response, an HTTP 500, a network `TypeError`, or an `AbortError`, with no artificial delay, while logging every Livewire request's send, finish, and abort in one sequence. Run against the first guard, it showed four things. A real identity-document upload with the guard active saved correct data — an earlier probe's failure traced to the in-process test server discarding the multipart body, not to the guard. On an error, a network failure, or an abort, the user's selection survived and the save landed exactly once, but nothing told the user the upload field had failed to load. If initialization never ended, the user's action waited forever, with no status and no way out.

The fourth was the sharp one. Livewire already defers an action internally when it arrives behind another in-flight, non-async message on the same component, and the guard queued that already-deferred action a second time — so it fired twice. When the initialization call and the user's commit landed in the same message, the action got squashed into itself: `RangeError: Maximum call stack size exceeded`, the message never finished, and `create` was never sent. In an A-then-init-then-B sequence, B went out while the initialization was still running and then fired again after it. Both cases were triggered synthetically, through the same public API the upload field itself uses (`Livewire.fireAction` with a `$commit` on the same tick); no real user path to them was reproduced, which is not the same as there being none.

The second commit stayed inside the guard and its configuration. An action Livewire has already deferred stays out of the guard's queue; instead, Livewire's own fire for it is wrapped so it lands in the guard's queue only if initialization is still running:

```js
Livewire.interceptAction(({ action, onSuccess }) => {
    const component = action.component;

    if (! isGuarded(component)) {
        return;
    }

    if (isUploadInit(action)) {
        onSuccess(() => loaded.add(action));

        return;
    }

    // Livewire already parked this action behind another in-flight message.
    // Queueing it again is what fired it twice — so borrow Livewire's own fire
    // instead of adding a second one.
    if (action.isDeferred()) {
        const fire = action.fire;

        action.fire = function () {
            if (busy(component)) {
                enqueue(component, () => fire.call(this));
            } else {
                fire.call(this);
            }
        };

        return;
    }

    if (! busy(component)) {
        return;
    }

    // Defer, don't cancel: the action still goes out, after every
    // initialization response has been merged or discarded.
    action.defer();
    enqueue(component, () => action.fire());
});
```

The same commit bounded the failure paths. An initialization message still open after 15 seconds — a value the record marks as a technical assumption, not yet measured on the site's real network — is canceled through Livewire, so its request is aborted and any response that still arrives is ignored, and only then is the queue released. A floating status says the upload fields are being prepared while actions are held, and says they failed to load, with reload and dismiss buttons, when initialization didn't succeed; the rest of the form can still be saved.

Each change was pinned by a mutant that turns the new test red: drop the `isDeferred` branch and both double-fire tests fail, keep it without redirecting the fire and the A/init/B test fails, remove the timeout and the hang test fails, and releasing the queue on every message end instead of the last one breaks the original regression test.

The record also keeps what this round didn't close. A timeout cancels the whole initialization message, so a user action that happened to be bundled into it — possible only inside that 5 ms buffer — is canceled too: its field values still go out with the next commit, but the button has to be pressed again. And Filament's select fields make async calls of their own that could, by the same mechanism, carry a stale snapshot; that hasn't been reproduced, and the guard doesn't cover it.

A guard that defers actions to protect one queue has to know about the queue it's borrowing from — the first version didn't, until a test went looking for it.

---

## Sources

- Pest — *pestphp/pest-plugin-browser v5.0.1: `src/Playwright/Page.php`* (`waitForLoadState()` calls `Client::instance()->execute(...)` and returns without iterating the result). Retrieved 2026-10-21. https://github.com/pestphp/pest-plugin-browser/blob/v5.0.1/src/Playwright/Page.php
- Pest — *pestphp/pest-plugin-browser v5.0.1: `src/Playwright/Client.php`* (`execute()` is declared to return `Generator` and contains `yield`, with the websocket send inside the same body). Retrieved 2026-10-21. https://github.com/pestphp/pest-plugin-browser/blob/v5.0.1/src/Playwright/Client.php
- The PHP Group — *PHP Manual: Generator syntax* (calling a generator function returns an object to iterate; its code runs as that object is iterated). Retrieved 2026-10-21. https://www.php.net/manual/en/language.generators.syntax.php
