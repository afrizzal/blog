---
title: 'A dropdown wired the ordinary way quietly erased a saved value'
description: 'react-hook-form''s register() sets a select''s value once, at mount, via a ref. When the options for that select load asynchronously, the value it commits can be empty — and the form has no idea anything went wrong.'
category: 'Systems & Performance'
pubDate: 2026-07-27
tags: ['reliability', 'testing', 'typescript', 'architecture']
draft: true
---

A Supplier edit form that never touched the "Term Pembayaran" (payment term) dropdown would still, on submit, silently strip the term the supplier already had. Same for "Mata Uang Default" (default currency). The field showed the right value on screen. The database disagreed. The bug wasn't in any handler anyone had written — it was in how the dropdown was wired in the first place.

## The dropdown looked ordinary, which was the problem

The form used react-hook-form, and the payment-term select was bound the way every other plain field in the form was bound: `{...register("paymentTermId")}`. That's the idiomatic path for an uncontrolled input — react-hook-form attaches a ref to the DOM node and reads `.value` off it at submit time. For a text input that works fine, because the DOM node exists and holds its value from the moment it renders.

A `<select>` populated from a tRPC query is a different animal. The `<option>` elements it needs don't exist until the query resolves. `register()` still runs at mount, still grabs the ref, and still (per the form's `defaultValues`) tries to set `.value = existingPaymentTermId` on that ref — before any `<option>` with that value has been rendered into the DOM. Per the HTML spec, assigning a `<select>`'s `.value` to something none of its current `<option>` elements match doesn't error and doesn't warn. It just resets the select to `""`.

By the time the trpc query resolved and the real options rendered, react-hook-form's internal form state already thought the field's value was empty — because that's what it read off the ref the one time it looked. Nothing re-reads a ref after mount for an uncontrolled field. The UI still rendered the correct label from `defaultValues`, so a human looking at the screen saw the right term. Submit sent `""`.

## An edit that never touched the field still lost the field

This is the detail that made it dangerous rather than merely annoying: a user editing the supplier's phone number, changing nothing about the payment term, would still submit a form that wiped it. There was no interaction that triggered the bug. There was no interaction that avoided it, either — every edit through that form carried the same silent reset, because the failure happened at mount, before any user input occurred at all.

It surfaced first as a UAT checkpoint marked "human-verify" in the plan — the kind of item that's easy to close by clicking through the happy path once and moving on. It was closed instead with a real Playwright spec (`14-payment-terms.spec.ts`), at the owner's explicit request, because manual verification wasn't available at the time. That decision is what caught it: the spec asserted the *persisted* value after a full page reload, not the value shown immediately after a click — the exact gap a manual click-through would have missed, since the on-screen label looked correct all the way up to submit.

## The fix was to stop trusting the ref

The fix wasn't a guard clause or a null check on submit. It was to stop using `register()` for that field and bind it as a controlled component instead — value and onChange flowing from react-hook-form's `Controller`, sourced from the same query that supplies the options, so the select's displayed value and its committed value are reading from the same place at the same time. There's no window where the DOM node's `.value` and the form's real state can diverge, because the DOM node is never the source of truth to begin with.

Two regression tests were converted from documented `test.fail()` known-issues into permanent green assertions once the fix landed, and both specs — payment terms and the dependent manual-invoice due-date logic that reads `paymentTermId` downstream — passed 8/8. The second spec mattered as much as the first: a `dueDate` auto-fill on a manual AP/AR invoice reads the supplier or customer's `paymentTermId` to compute a due date. Silently losing that field didn't just corrupt the supplier record; it broke a calculation two screens away that had nothing to do with the form where the bug lived.

## Async-populated selects don't get to be uncontrolled

The general shape of this bug isn't specific to react-hook-form or to this form. Any binding pattern that assumes a form control's value can be read from the DOM at an arbitrary later moment is making a bet that the DOM control was fully formed at mount. That bet is safe for static markup and unsafe the instant the control's valid values depend on a network response. The fix generalizes further than the two fields it patched: this codebase's dropdown pattern is now controlled-by-default anywhere the option list is `async`, not opt-in per field.

The lesson isn't "test everything end-to-end" — that's a slogan, not a technique. It's narrower: a checkpoint that only verifies what the screen shows immediately after an action will pass a bug that only manifests after the round trip through persistence. The spec that caught this one specifically reloaded the page before asserting the value, because "looks right" and "is right" are different claims, and only one of them survives a page refresh.
