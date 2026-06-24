---
title: 'The LLM step belongs behind a schema, not a prompt'
description: 'An LLM inside a pipeline is an unreliable function call. What makes it production-safe is not prompt wording — it is forcing every output through a typed schema with a deterministic fallback.'
category: 'AI & Automation'
pubDate: 2026-06-22
tags: ['ai', 'llm', 'reliability', 'typescript']
draft: true
---

An LLM inside a pipeline is an unreliable function call. What makes it production-safe is not prompt wording — it's forcing every output through a typed schema with a deterministic fallback. The prompt is the least important, least durable part of the system.

## Treat the model as an untrusted function

Every other function in your codebase has a return type the compiler enforces. The model call doesn't. You asked for JSON and most of the time you get JSON — but eventually it returns a polite paragraph explaining the JSON, or the right shape with a `category` of `"Billing "` (trailing space), or a confidence score as the string `"high"`, or a field you never asked for and a field you needed quietly missing.

This isn't a bug you can prompt away. It's the nature of sampling from a distribution. You can push the failure rate from, say, 5% to 0.5% with better instructions, and that feels like progress until you run ten thousand calls a day and trip over the half-percent fifty times. A model upgrade that's better on every benchmark can still change its formatting habits and break code that was implicitly relying on the old ones.

So stop thinking about it as "the AI part" and start thinking about it as an I/O boundary, like a third-party API you don't control. You wouldn't `JSON.parse` a webhook payload and pass it straight into your billing logic. The model deserves exactly the same suspicion. If your next step assumes well-formed output, then the model — not your design — decides your uptime.

## The schema is the contract

The fix is dull on purpose: define the output shape as a schema, validate against it, and never let unvalidated model output reach the next step. The prompt describes what you'd *like*; the schema decides what's *allowed*. When the two disagree, the schema wins.

On a validation failure you have exactly two acceptable moves. Retry once, feeding the validation error back into the prompt so the model can self-correct — models are surprisingly good at fixing a clear "expected one of billing/technical/sales, got 'account'" when you hand them the problem in plain terms. Or fall through to a deterministic default that's safe by construction. What you must never do is throw a raw, half-parsed object into the rest of the pipeline and hope.

Here's the whole pattern in one TypeScript function using Zod. It's about as much code as the prompt itself:

```ts
import { z } from "zod";

const Triage = z.object({
  category: z.enum(["billing", "technical", "sales", "other"]),
  confidence: z.number().min(0).max(1),
  needsHuman: z.boolean(),
});
type Triage = z.infer<typeof Triage>;

// Safe by construction: if the model misbehaves, a human looks at it.
const FALLBACK: Triage = { category: "other", confidence: 0, needsHuman: true };

export async function triage(ticket: string): Promise<Triage> {
  const raw = await callModel(ticket); // returns a string, always
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    logFailure({ ticket, raw, reason: "not-json" });
    return FALLBACK;
  }

  const result = Triage.safeParse(parsed);
  if (!result.success) {
    logFailure({ ticket, raw, reason: result.error.message });
    return FALLBACK; // or: retry once with result.error fed back in
  }
  return result.data;
}
```

The caller of `triage()` gets a `Triage` every single time, and it never returns garbage — there is no third state. The pipeline downstream can be written as if the model were a normal typed function, because at this boundary it now is. Notice the fallback isn't a guess at the answer; it's the safe answer. `needsHuman: true` means a bad model day degrades into a slightly longer queue for a person, not a silently miscategorised ticket — a degradation you can explain to the business in one sentence and defend.

This is also the cheapest boundary to mandate across a team. "No unvalidated model output crosses a function boundary" is a one-line review rule that survives staff turnover and model swaps, which is more than you can say for any prompt.

## Log the failures as signal

That `logFailure` call is the part people skip, and it's the part that compounds. Capture three things every time validation fails: the input, the raw model output, and the validation error. Don't average it into a metric — keep the rows.

That corpus is worth more than the pipeline it protects. It's your eval set: real inputs that broke real output, which is exactly what you want to test the next prompt or the next model against before you ship it. It's your prompt-debugging log: patterns jump out fast when you read twenty failures side by side — one ambiguous enum value, one category the taxonomy is missing, one class of input nobody anticipated. And it's your early-warning system: a quiet failure rate that doubles overnight usually means the upstream data changed or the model did, and you want that from a dashboard, not from a customer.

Prompts are how you talk to the model. Schemas are how you trust it. Wrap the call, validate the output, log what breaks — and the prompt becomes the easiest thing in the system to change, because nothing downstream was ever depending on it.
