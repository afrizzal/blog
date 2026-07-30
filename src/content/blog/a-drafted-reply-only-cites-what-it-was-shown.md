---
title: 'A drafted reply only gets to cite sources it was actually shown'
description: 'AIDA''s grounded-drafting pipeline doesn''t just check whether an LLM found relevant knowledge-base content — it filters the model''s own citation list against the chunks it was actually given, because a model asked to name its sources is still a model that can misname them.'
category: 'AI & Automation'
pubDate: 2026-07-30
tags: ['ai', 'llm', 'postgres', 'reliability']
draft: true
---

AIDA drafts support replies by retrieving knowledge-base chunks for a ticket and asking an LLM to answer only from what it was given, citing which chunk backed which claim. The obvious failure mode is the model answering from nothing relevant and inventing an answer anyway — that one's handled by a groundedness gate before the model is ever called. The less obvious failure mode is the model answering correctly *and* attaching a citation number that doesn't correspond to anything it was actually shown. The fix for the first isn't a fix for the second, and treating them as the same problem is how citations quietly stop meaning anything.

## The gate runs before the model is called, not after

`generateDraftReply(orgId, ticketId)` embeds the ticket's content, retrieves the nearest knowledge-base chunks via pgvector cosine distance, and only then decides whether to call the LLM at all:

```ts
// src/lib/rag/generate-draft.ts (trimmed)
const MAX_COSINE_DISTANCE = 0.5;

const chunks = await retrieveRelevantChunks(orgId, queryEmbedding);
const relevant = chunks.filter((c) => c.distance <= MAX_COSINE_DISTANCE);

if (relevant.length === 0) {
  // No LLM call at all — grounded:false is a retrieval-layer decision,
  // never something the model has to be trusted to admit on its own.
  await recordAuditEvent({ ..., actionType: "DRAFT_GENERATED" });
  return { grounded: false, draftMarkdown: NO_RELEVANT_CONTENT_MESSAGE, citations: [] };
}
```

That distance cutoff is what keeps "the knowledge base has nothing on this" from ever reaching the model as a prompt to improvise against. It's a retrieval-layer decision made in plain TypeScript against a numeric threshold, not a behavior the model has to be prompted into and hoped for. The integration test's Case B proves the completion adapter is never invoked on an empty-KB ticket — not that the model declined to answer, but that it was never asked.

## Fencing the sources doesn't guarantee the model reads the numbers back correctly

Once there's relevant content, `draft-prompt.ts` fences it the same way triage fences ticket text — each retrieved chunk gets its own numbered block, and the ticket body gets its own:

```ts
// src/lib/rag/draft-prompt.ts (shape, trimmed)
function buildDraftUserPrompt(ticketText: string, chunks: RetrievedChunk[]): string {
  const sources = chunks
    .map((c) => `<kb_source id="${c.id}">\n${fenceContent(c.text)}\n</kb_source>`)
    .join("\n");
  return `<ticket_content>\n${fenceContent(ticketText)}\n</ticket_content>\n${sources}`;
}
```

`fenceContent` generalizes the same tag-escaping discipline AIDA's triage prompt already uses for a second untrusted surface — retrieved KB text, which is operator-authored but still reaches the prompt as data, not instructions. The model is told to cite `[N]` markers matching a `<kb_source id="N">` it was shown. Most of the time it will. But "most of the time" is exactly the gap between a prompt convention and a guarantee, and a support-reply citation that points at the wrong source is worse than an uncited claim — it looks verified when it isn't.

## The guarantee is a set-intersection, not a prompt instruction

`generateDraftReply` closes that gap after the model responds, not by asking it more firmly:

```ts
// src/lib/rag/generate-draft.ts (trimmed)
const retrievedIds = new Set(relevant.map((c) => c.id));
const citations = result.citations.filter((id) => retrievedIds.has(id));
// Any chunkId the model names that wasn't in the retrieved set is silently
// dropped here — never rendered, never trusted, regardless of why it appeared.
```

Whatever the model claims it cited, the only citations that ever reach `DraftCard` are the ones that survive an intersection against the chunk IDs `generateDraftReply` itself retrieved and handed over. A model that misremembers a number, hallucinates a plausible-looking ID, or gets confused by a long context window produces a draft with fewer or no citations — never a draft with a wrong one. `DraftResultSchema` (`grounded`/`draftMarkdown`/`citations`) validates the shape of what comes back, but shape validation only proves the model returned *a* list of numbers; it says nothing about whether those numbers refer to anything real. That's a second, independent check, and it's the one that actually backs the claim "this reply is grounded."

## Nothing generated ever sends itself

The rest of the pipeline is built so that even a perfectly grounded draft can't become a customer-facing message on its own. `DraftCard` renders the markdown and citation list — each `[N]` linking to `/kb/{articleId}` — with exactly two affordances, Insert and Discard, no data fetching or send path of its own. Inserting hands the text to the existing `Composer`, and only an explicit human `Send` through the existing messages route puts anything in front of a customer. The `DRAFT_APPROVED` audit event only gets written for a `PUBLIC` send that arrived via that `fromDraft` flag, linked to the sent message's id — a manually typed reply or an internal note never touches that code path at all. And every draft generation, grounded or not, writes exactly one `DRAFT_GENERATED` audit row with the redacted prompt — the zero-result path included — so there's a record of what the retrieval layer decided even when it decided to skip the model entirely.

A citation a reader can click is only as trustworthy as the check behind it — and the check that matters here isn't "did the model format a citation," it's "does that citation exist in the set the model was actually given."
