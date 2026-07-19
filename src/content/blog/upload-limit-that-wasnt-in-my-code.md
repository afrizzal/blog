---
title: 'The upload limit that mattered wasn''t the one in my code'
description: 'AIDA''s public intake route checks content length, per-file size, a running total, and byte-sniffed MIME type before saving an attachment. None of that mattered once Next.js''s own proxy layer silently truncated the request body first, with no error back to the client.'
category: 'Systems & Performance'
pubDate: 2026-07-06
tags: ['nextjs', 'reliability', 'architecture']
draft: false
---

AIDA's public web-intake form has to trust nothing about what a stranger uploads — not the declared size, not the file extension, not the weight of the whole request. So the route handler checks all three, explicitly, in the right order, before a single byte touches disk. That code is correct. It also, for one entire class of legitimate multi-file submission, never got to run — because the request body it was written to inspect had already been cut down to size by a Next.js layer neither the route nor I knew was there.

## Three checks stood between a stranger and the filesystem

The intake endpoint is `POST /api/public/intake` — no login, rate-limited, a honeypot field, and attachments a customer picked off their own disk. Nothing about the input can be trusted, so the checks stack in order of how cheap they are to run:

```ts
// src/app/api/public/intake/route.ts (trimmed)
export async function POST(request: Request) {
  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > MAX_TOTAL_REQUEST_BYTES) {
    return NextResponse.json({ error: "payload_too_large" }, { status: 413 });
  }
  // ...parse the form...
  let totalBytes = 0;
  for (const file of files) {
    if (file.size > MAX_BYTES) {
      return NextResponse.json({ error: "file_too_large" }, { status: 413 });
    }
    totalBytes += file.size;
    if (totalBytes > MAX_TOTAL_REQUEST_BYTES) {
      return NextResponse.json({ error: "payload_too_large" }, { status: 413 });
    }
    // Sniff the real bytes — the extension and declared MIME type are client-controlled.
    const buffer = Buffer.from(await file.arrayBuffer());
    const sniffed = await fileTypeFromBuffer(buffer);
    if (!sniffed || !ALLOWED_MIME.has(sniffed.mime)) {
      return NextResponse.json({ error: "unsupported_file_type" }, { status: 415 });
    }
  }
}
```

A header check first, because it's free. A per-file cap next, because it's cheap and catches the common case early. A running total after that, because the header can't be trusted either — a client can lie about `content-length`, or omit it. Then a byte-sniffed MIME type, because a file extension is a suggestion, not a fact. The constants behind all of it are unremarkable: `MAX_BYTES = 10MB` per file, `MAX_TOTAL_REQUEST_BYTES = 30MB` combined. A customer attaching three photos of a broken fixture, each a little under 10MB, is exactly the request this code was written to accept.

## The checks agreed with reality until reality got cut off first

That request started failing during Phase 2 sign-off — not in a unit test, not in the Testcontainers integration suite, but in a real `docker compose up` cold start, the same discipline that [caught a wrong AI diagnosis](/blog/e2e-suite-caught-wrong-ai-diagnosis/) a day earlier precisely because a green test suite is necessary and not sufficient. And the failure didn't look like either `payload_too_large` or `file_too_large`. It looked like a form that shouldn't have failed, failing anyway, with no clean error the intake route had ever been coded to produce.

The cause was two layers up from any code I'd written. AIDA's `next.config.ts` sets `output: "standalone"`, and a `middleware.ts` runs in front of every request. That combination puts an internal Next.js proxy between the incoming connection and the route handler — and that proxy, independent of anything in `src/app/api`, buffers the request body itself, up to a limit of its own. Next's own documentation states the default plainly: 10MB, and if the body is bigger, "the body will only be buffered up to the limit… the request will **not** fail or return an error to the client." No 413. No 415. The route runs, on a body that is no longer the one the client sent.

The number is the trap. AIDA's own per-file cap is also 10MB, which reads like a coincidence that should have made this safe — it isn't, because the proxy's ceiling caps the *entire* body, not one field of a multipart form. Three attachments at 9MB each sail past every check this code was written to enforce — each file comfortably under the per-file cap, the ~27MB total comfortably under the 30MB combined cap — and the proxy still severs the body at 10MB, a limit that has nothing to do with `MAX_TOTAL_REQUEST_BYTES` and was never in the ticket. The same cold-start pass turned up a second, unrelated silent failure that same week — a `.dockerignore` pattern that wasn't anchored to match nested `node_modules`, quietly feeding 11.8GB of stale worktree directories into the Docker build context and stalling builds past 45 minutes with no error either. Different layer, same shape: nothing crashed, something just quietly stopped being what the code assumed it was.

## A quiet truncation breaks the check that trusted it most

Here's the part worth sitting with: the *first* line of defense in the intake route reads `content-length` off the request headers and trusts it as ground truth for how many bytes are coming. That header describes what the client sent. It says nothing about what the route will actually receive, because by the time the handler runs, the proxy has already decided how much of the body survives. A request declaring 22MB — comfortably under the 30MB combined cap — can still arrive at the route physically severed at 10MB: a multipart boundary sliced mid-file, a trailing field truncated, a byte count that no longer matches anything the code checked for. None of the three checks in the route were wrong. They were answering questions about a body that had already been edited by something upstream of all of them.

## Fix the smallest ceiling in the chain, not the one you administer

The fix is one config line, and the comment next to it is the whole postmortem:

```ts
// next.config.ts
const nextConfig: NextConfig = {
  output: "standalone",
  experimental: {
    // Next buffers request bodies at 10MB by default when a proxy/middleware is
    // present, truncating anything larger BEFORE the route runs — which made the
    // intake route's own 413 (file_too_large / payload_too_large) checks
    // unreachable and broke legitimate multi-file submissions over 10MB combined.
    // Keep this in lockstep with the intake route's combined cap.
    proxyClientMaxBodySize: MAX_TOTAL_REQUEST_BYTES,
  },
};
```

One import — `MAX_TOTAL_REQUEST_BYTES` from the same constants file the route already uses — so the two ceilings can't drift apart again by accident. That's the actual lesson, and it generalizes past Next.js: in any layered request pipeline, the limit that governs your users' experience is the *smallest* one configured anywhere in the chain, not the one you wrote and can point to in a code review. A CDN, a reverse proxy, a framework's internal plumbing, and your own route handler can each impose a ceiling, and only one of those is visible to `git blame`. The other three only announce themselves when a legitimate request hits them — quietly, in whatever way that particular layer has chosen to fail, which is not guaranteed to be a failure at all.

[A status code is a promise](/blog/omnisync-http-202-is-a-promise/); so is your own validation code, and a layer you didn't know existed gets to break that promise first — without sending an error to tell you it happened.

---

## Sources

- Vercel — *next.config.js: proxyClientMaxBodySize* (default limit is 10MB; an oversized body is buffered only up to the limit and "will not fail or return an error to the client"). Retrieved 2026-07-06. <https://nextjs.org/docs/app/api-reference/config/next-config-js/proxyClientMaxBodySize>
