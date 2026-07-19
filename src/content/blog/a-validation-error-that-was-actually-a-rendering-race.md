---
title: 'A validation error that was actually a rendering race'
description: 'AIDA''s Settings AI Features form blocked Save with a "Select a model" error right after switching providers. The real defect sat two React commits away, inside a hidden native select Radix uses to bridge into native form submission — and it never raised an error of its own.'
category: 'Systems & Performance'
pubDate: 2026-07-17
tags: ['reliability', 'testing', 'architecture', 'typescript']
draft: false
---

A validation error names a field, not a cause. AIDA's Phase 4 UAT run turned one up in Settings → AI Features: switch the provider from Ollama to OpenAI, and the Model dropdown shows the "Select a model" placeholder instead of the new provider's first model — Save is then blocked by the same zod check that exists to catch exactly this. The code that's supposed to set the model on a provider switch is three lines long and correct. The bug lived two React commits away, inside a native HTML element the settings form never renders visibly and nobody had written.

## The obvious suspects were all innocent

The provider-switch handler looks like it should just work:

```tsx
function handleProviderChange(next: ProviderName) {
  form.setValue("provider", next);
  const catalog = MODEL_CATALOG[next];
  // the line the zod error blames — it provably runs, with the right value
  form.setValue("modelSelect", catalog[0] ?? CUSTOM_MODEL_VALUE);
  form.setValue("customModel", "");
}
```

Three `setValue` calls, one of them setting the model to the new provider's first catalog entry. The automated Playwright UAT (`tests/e2e/phase4-ai.spec.ts`) caught the Model field coming up empty in both switch directions — Ollama→OpenAI and OpenAI→Ollama — so this wasn't a one-off flake, it was deterministic. Every cheap explanation for it was wrong:

- **react-hook-form dropping a `setValue` call under batching** — ruled out. React Hook Form's internal state provably receives the new model value first; the Select component's own sync effect only fires *because* it detects the value prop changed from the old model to the new one. The empty string arrives after that, not instead of it.
- **the shadcn `Select` wrapper mutating the value** — ruled out. It's a thin pass-through over Radix's primitive with no logic of its own.
- **a stray `onValueChange("")` from keyboard typeahead or item-click handling** — ruled out. Grepping the installed `@radix-ui/react-select` package turns up exactly three call sites for `onValueChange`, and only one of them can ever produce an empty string.

That third call site is a piece of the component nobody in the codebase had ever had a reason to read.

## A fake `<select>` still needs a real one behind it

Radix's `Select` renders a fully custom, ARIA-driven listbox — divs and buttons, not a native `<select>`. That's what makes it stylable. But a form's browser-native submission, autofill, and any tooling that expects a real form control don't know what to do with a div. So when a Radix `Select` sits inside a `<form>` element, it quietly mounts a second, invisible piece: `SelectBubbleInput`, a real, uncontrolled native `<select>` with its own `<option>` elements, kept roughly in sync with whatever the visible listbox is showing. It exists purely so the DOM has something that looks like an ordinary form field to everything outside React.

"Roughly in sync" is the part that matters. The hidden select doesn't share state with the visible one directly — it watches the controlled `value` prop via a passive effect and pushes changes into the native DOM element by hand:

```ts
// @radix-ui/react-select@2.3.1, dist/index.mjs:1094-1108 (paraphrased)
useEffect(() => {
  if (prevValue !== selectValue) {
    const event = new Event("change", { bubbles: true });
    selectRef.current.value = selectValue; // native HTMLSelectElement setter
    selectRef.current.dispatchEvent(event);
  }
}, [prevValue, selectValue]);
```

Meanwhile the `<option>` elements inside that hidden select aren't static — each one is registered by its own `SelectItemText` layout effect, which means the option list updates via its own `setState` call, landing in a follow-up commit rather than the commit that swapped the visible items.

## The value arrived a commit before its own options did

Put those two facts together and the provider switch becomes a race with a fixed, always-losing side. `handleProviderChange` batches all three `setValue` calls into one React commit: the controlled value becomes the new provider's first model, and the visible `SelectItem` children swap to the new catalog, in the same render. The passive effect on the hidden select fires in that same commit's effect phase — before the `<option>` elements have re-registered themselves against the new catalog, because that re-registration is queued for the *next* commit. So the hidden native select receives `select.value = "gpt-5.4-mini"` while its own `<option>` list still only contains the old provider's model names.

The browser has an answer for what happens when you assign a `<select>`'s value to something that matches none of its current `<option>`s: per the HTML spec, `selectedIndex` becomes `-1` and `.value` becomes `""`. The assignment silently fails, the hidden select dispatches its `change` event anyway — because the assignment *did* happen, just not to the value that was asked for — and that event's handler calls `onValueChange("")`. React Hook Form's guard against redundant updates only suppresses an `onChange` when the incoming value matches what the field already holds; `""` doesn't match `"gpt-5.4-mini"`, so it sails through and overwrites the very `setValue` call that triggered this whole chain three effects earlier. Nothing threw. Nothing logged. The only visible trace is a form field that quietly forgot what it had just been told, and a zod message on Save that points at the field, not at the four-effect chain that emptied it.

This is a known shape of the same upstream bug, not a one-off in this codebase — Radix's issue tracker has multiple reports of a controlled `Select` inside a form spontaneously calling `onValueChange("")` when its value and options change together, including one that reproduces only on React 19 (see Sources).

## The fix is a remount, not a workaround

The fix is one line, and it isn't a guard clause — it sidesteps the race entirely rather than papering over its symptom:

```tsx
// before: one Select instance survives every provider switch, so the hidden
// bubble input's stale-options race can fire on every value+items swap.
<Select value={field.value} onValueChange={field.onChange}>

// after: keying by provider forces a full remount on switch, landing on the
// proven-safe initial-mount path instead of the update path that races.
<Select key={provider} value={field.value} onValueChange={field.onChange}>
```

On initial mount, the hidden select's "previous value" tracker starts equal to the current value — there's no mismatch to detect, so the sync effect never dispatches a change event in the first place, and the fresh `<option>` list registers together with the correct `defaultValue` in the same pass. Keying the component by `provider` forces React to tear down and rebuild the whole Select subtree, hidden input included, every time the provider changes — trading an update (which races) for a mount (which doesn't). The Provider select itself stays unkeyed on purpose: its option list never changes, so it was never exposed to this race, and keying it would remount — and drop focus from — a control that didn't need fixing.

That fix is merged — `edcb651` keys the Model Select by provider, and `4106f42` closes the loop on the tests: the UAT's two workaround-laden assertions, which had papered over the bug by explicitly re-picking a model after every provider switch, became direct assertions that the reset happens on its own. A future Radix upgrade or form refactor that reintroduces this clobber now fails a visible test instead of silently degrading the settings screen again.

A "Select a model" error is a claim about what the user forgot to do — this one was a claim about what a hidden layer of the DOM had already undone, one commit before anyone had the chance to look.

---

## Sources

- radix-ui/primitives — *Controlled Select component is resetting itself only on React 19* (issue #3381: a controlled Select spontaneously calls `onValueChange` with an empty string when its value updates, reproducing only under React 19). Retrieved 2026-07-17. <https://github.com/radix-ui/primitives/issues/3381>
- radix-ui/primitives — *React Select changes value to '' on render* (issue #3693: a Select inside a form triggers `onValueChange('')` when rendered with a value after its options load asynchronously). Retrieved 2026-07-17. <https://github.com/radix-ui/primitives/issues/3693>
