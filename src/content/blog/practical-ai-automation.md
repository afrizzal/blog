---
title: 'Use the model only where it beats a regex on your own data'
description: 'A model call is the slowest, priciest, least deterministic dependency in your whole system, so you ration it like an unreliable third-party API you call as rarely as you can. The practical skill is putting the model only where fuzzy understanding is genuinely required and doing the boring 80% with deterministic code you can test.'
category: 'AI & Automation'
pubDate: 2026-06-09
updatedDate: 2026-06-22
tags: ['ai', 'automation', 'architecture']
draft: false
---

The most reliable AI automation you will ever ship barely uses AI — because a model call is the slowest, priciest, least deterministic dependency in your whole system, and you architect around calling it as rarely as you can. AI demos are easy; AI that survives Monday morning is not, and the reason is rarely the prompt. It's that someone built the model into the spine of the workflow when it should have been one narrow vertebra. The practical skill isn't prompting. It's drawing a line, on purpose, between the fuzzy work that genuinely needs a model and the boring 80% that deterministic code does faster, cheaper, and the same way every time.

## Treat the model like a dependency you ration

You already know how to ration an expensive call. A payment gateway, a metered upstream, a rate-limited partner API — you keep it off the hot path, you cache its answers, you set timeouts, and you reach for it only when nothing local will do, because every call costs you latency and money. A model call is the most extreme version of that dependency you have ever integrated: it's slow on the scale of network round-trips, it costs real money per invocation, and unlike a payment gateway it isn't even deterministic, so the same input can give you a different answer twice.

So you ration it. The instinct that gets teams in trouble is reaching for the model *first* — making it the thing the request flows into, with deterministic code as garnish around it. Invert that. The model is the call of last resort. Most of an "AI workflow" should be plumbing you fully control: routing, lookups, rules, validation, retries, idempotency. The model is the one step you reach for only when nothing cheaper will do, and you spend the rest of the architecture making sure most requests never reach it.

## "AI" is sometimes the expensive way to write an if-statement

Here is the line worth drawing in permanent marker. The model earns its place on genuinely fuzzy work: understanding natural language, classifying something ambiguous, extracting structure from messy unstructured text a human wrote. That is real value, and no `if` statement replaces it — when the input is "hey so the thing I bought last week is doing the weird flickering again," you need fuzzy understanding, and the model is the right tool.

It does *not* earn its place where the answer is a rule, a lookup, a regex, or a SQL query. If the routing decision is "orders over a threshold go to the priority queue," that's a comparison, not a cognition problem. If the category is decided by which of five keywords appears, that's a dictionary lookup. Wrapping either in a model call doesn't make it smarter — it makes it slower, costlier, and nondeterministic, and it converts a line of code you can unit-test into a dependency you have to *monitor*. Sometimes "AI" is just the most expensive, least reliable way anyone has ever written an if-statement. The skill is noticing when that's what you're about to do, and not doing it.

## Earn the model against a dumb baseline on your own data

There's a concrete test for whether the model earns its place, and it's the "if you can't measure it, you can't trust it" rule made operational: measure the model against a dumb baseline, on *your* data, before you ship it.

Write the twenty-line version first — the keyword classifier, the heuristic, the lookup table. Run it over a few hundred real, labeled examples from your actual traffic. Often the dumb baseline gets you to 90% accuracy, and it's faster, cheaper, and debuggable, because when it's wrong you can read exactly why and fix the rule. Now run the model over the same set. You've earned the model only on the gap where it *measurably* beats the baseline on your inputs — because your distribution is not the benchmark's, and a model that tops a public leaderboard can still lose to your five keywords on the tickets your customers actually write. If the model wins by two points and costs a hundred times more per call and you can't explain its mistakes, the baseline was the right answer and you just saved yourself an operational dependency. If it wins by thirty points on the messy tail the rules can't touch, now you know precisely what you're paying for — and you keep that baseline around afterward as a regression check, because the day the model quietly degrades, your dumb classifier is the only thing that tells you.

## The architecture is a deterministic shell with a small model core

Put it together and the shape is a deterministic shell wrapped around a small model core: cheap rules resolve the clear cases for free, only the ambiguous middle pays for a model call, and the model's own low-confidence tail routes to a human. That's the 80/20 handoff, made into a confidence-routed pipeline.

```ts
// Most inputs never reach the model. That is the design, not an optimization.
async function routeTicket(ticket: Ticket): Promise<Routing> {
  // 1. RULES FIRST — free, deterministic, debuggable. Resolve every case you can.
  if (ticket.amount > PRIORITY_THRESHOLD) return { queue: "priority", by: "rule" };
  if (KNOWN_SPAM.test(ticket.body))      return { queue: "trash",    by: "rule" };
  const kw = keywordCategory(ticket.body); // dictionary lookup, no model
  if (kw) return { queue: kw, by: "rule" };

  // 2. CACHE — same input -> same answer; never pay for the same input twice.
  //    The cache makes a nondeterministic call behave idempotently for repeats.
  const key = hash(ticket.body);
  const cached = await cache.get(key);
  if (cached) return { ...cached, by: "cache" };

  // 3. MODEL — only the genuinely ambiguous tail reaches here. Narrow, single-purpose.
  //    Output is untrusted until validated behind a schema (see link below).
  const result = await classifyWithModel(ticket.body);

  // Decide the routing BEFORE caching, so the cache stores a finished verdict —
  // including "send this to a human." Otherwise a cached low-confidence answer
  // would skip the handoff gate on every future hit.
  const routing: Routing = result.confidence < MIN_CONFIDENCE
    ? { queue: "human-review", by: "low-confidence" } // 4. HUMAN — a handoff, not a guess
    : { queue: result.category, by: "model" };

  await cache.set(key, routing);
  log({ key, ...routing, confidence: result.confidence }); // every model path is logged
  return routing;
}
```

Notice what the model does *not* do here. It doesn't route — the rules do. It doesn't remember — the cache does. It doesn't decide what's certain enough to act on — the threshold does. It does one thing: read fuzzy text and propose a label. Every `return` above the model call is a request that never paid for one, and where you process a queue rather than a single request, you accumulate the model-tier items and flush them in one batched call instead of N. Pre-filter, cache, batch: three ways to spend the expensive dependency less. The model isn't the spine here; it's a branch most traffic skips.

## When you do call it, contain it

You will reach the model call sometimes — that's the 20% it earned. When you do, keep it narrow: a single-purpose call that does one fuzzy thing beats one mega-prompt trying to route, extract, classify, and summarize at once, because a narrow call is easier to validate, cache, and reason about when it fails. And the output is untrusted the instant it returns. Forcing it through a typed schema with a deterministic fallback is the whole subject of [the LLM step belongs behind a schema, not a prompt](/blog/llm-step-behind-a-schema/), and it's exactly what you do at this one step where the model actually runs. Everywhere else there's nothing to contain, because you were disciplined enough not to put a model there.

## Measure both halves, or you're flying blind

The 80% you automated with code is not "done" because it has no model in it — it's the half most likely to rot silently. Log the `by` tag on every routing decision and you can watch the split move: how much traffic the rules resolve, the model's share, the human-handoff rate, all as live numbers instead of vibes. Track the deterministic shell's accuracy too, so a rule that quietly starts mislabeling screams in a dashboard before it screams in a customer's inbox. Track the model's volume and confidence distribution, because a drift toward the low-confidence tail is the model telling you the world changed under it. And keep that dumb baseline running in the shadows as a regression check — the day the model degrades, the gap between it and your twenty-line classifier shows up as a number, not as a support fire.

Automate the repetitive 80% with code you can test, route the fuzzy 20% to the model, route the model's uncertain tail to a person, and measure all three — because automation should buy back hours without quietly burning the trust you can't see draining.

The best AI system is the one with the least AI in it.
