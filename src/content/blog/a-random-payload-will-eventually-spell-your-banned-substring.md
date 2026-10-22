---
title: 'A random payload will eventually spell your banned substring'
description: 'A certificate QR code''s base64 PNG and a page''s CSP nonce are random strings inside meaningful HTML, so a test that greps the whole page for a forbidden substring will eventually match the noise. The fix strips or decodes exactly the random part, and the QR check came out stricter than the one it replaced.'
category: 'Systems & Performance'
pubDate: 2026-10-12
updatedDate: 2026-10-25
tags: ['testing', 'reliability', 'security']
draft: false
---

If a test greps a whole rendered page for a forbidden substring, and that page contains any field whose job is to be random, the test already has a failure rate — nobody has measured it yet. Random strings eventually spell things. On a training-academy information system I'm building, two tests in unrelated features turned out to share exactly that defect, and both were fixed on the same morning, twenty-nine minutes apart: one scanned a certificate PDF's HTML for a forbidden link and found it inside the base64 of a QR code image, the other scanned public pages for template leftovers and found "USD" inside a CSP nonce. Neither page was wrong, and neither fix loosened an assertion.

![A stencil with three cut strokes hovers over randomly scattered paper strips; three amber strips below have fallen into the same pattern.](../../assets/blog/a-random-payload-will-eventually-spell-your-banned-substring/noise-that-matches-the-stencil.webp "Concept illustration, generated with Codex: scan enough random noise for a pattern and chance will draw it for you.")

## A QR code is a photograph of a string, and the photograph can lie

The first instance lived in the certificate PDF. Every certificate carries a QR code that must point at the public verification page — never at the certificate download route, and never at a token-gated link, which on this system starts with `/t/`. The PDF is stored permanently, so whatever it links to is effectively final, and the test suite guards the destination. The original test captured the HTML handed to the PDF renderer and asserted that the whole string did not contain `/t/`.

The QR code sits in that HTML as `<img src="data:image/png;base64,...">`. The image encodes the verification URL, and the verification code inside that URL is 128 random bits, so every certificate produces a different PNG — and the base64 text of that PNG is, for practical purposes, a long run of random characters. Standard base64 uses a 64-character alphabet that includes `/`, and nothing in it prevents `/`, `t`, `/` from landing side by side. There's a small irony in the details: the verification code itself is base64url, whose alphabet has no slash at all, but the PNG wrapping it is encoded in standard base64, which does. The fix commit estimates the old assertion failed on roughly 1% of runs.

A 1% flake does more damage to a suite than an honest failure. It doesn't reproduce on demand, it doesn't correlate with any change, and every time it fires, red means a little less.

## The flaky assertion was blind to the thing it was named for

Reading the old test again exposed a second problem. It was named for the QR's destination — the QR points to the verification page, not the download — but nothing in it ever looked at the QR. It asserted that the verification URL appeared somewhere in the HTML, which the URL printed as text under the code satisfied on its own. It asserted that `/t/` appeared nowhere, which a QR pointing straight at a token link would also satisfy, because the destination is encoded in pixels and the pixels are encoded in base64. The fix commit says it plainly: the old check only read the URL text under the QR. A QR code pointing at exactly the wrong place would have passed.

The fix stops reading the QR as text and starts reading it as a QR code:

```php
// The QR payload is a base64 PNG, not prose: decode it with a real QR reader
// and check the DESTINATION it encodes, never the encoded noise around it.
$stripped = preg_replace_callback('#data:image/png;base64,([A-Za-z0-9+/=]+)#', function (array $match) use (&$qr): string {
    $qr[] = (string) (new QRCode)->readFromBlob((string) base64_decode($match[1], true));

    return 'data:image/png;base64,[payload]';
}, $html);
```

The helper swaps every image payload for a placeholder, decodes each PNG with a QR reader library, and returns two things: the HTML with the payloads removed, and the list of decoded QR contents. The test now asserts that the decoded list is exactly one entry — the certificate's own verification URL — and runs the forbidden-link check against both the stripped HTML and the decoded text. It checks the destination a scanner would follow, which the old version never did.

## Forcing the coincidence on demand is how you know the fix closes it

A fix for a 1% flake can't be proven by watching it pass a few times, so the commit adds a test that makes the coincidence happen on purpose. It generates QR codes for a verification URL with a counter appended — the loop allows up to three thousand attempts — until one PNG's base64 happens to contain `/t/`. On that output it asserts that the old whole-HTML assertion would have failed, that the decoded QR is the harmless payload, and that the stripped HTML carries no forbidden link.

Then it builds the real failures. A `/t/` link in an `href` and a download URL in body text are both caught in the stripped HTML. A QR whose decoded destination is a `/t/` link is not — the test asserts that explicitly — and is caught only in the decoded text. That last assertion is the whole argument in one line: a substring scan of the markup cannot see where a QR code points. With the fix in, the QR test passed fifteen consecutive runs.

## A nonce is supposed to be unpredictable, and unpredictable sometimes spells USD

The second instance was in a different corner of the codebase. The public website was converted from a stock HTML template, and a feature test guards against leftovers: no public page's markup may contain the template's name ("canvas"), placeholder "lorem" text, or "USD" — markers of the template's demo content. Every public page also carries a CSP nonce: 32 random characters per request, set in the `nonce` attribute of the script tags the asset bundler emits, telling the browser which scripts are legitimate for that one response.

Three case-sensitive letters in a 32-character alphanumeric string come up roughly once in eight thousand nonces — rare for any one page, inevitable for a suite that renders public pages on every run. It happened once, in the test covering the program catalog and trainer pages, while unrelated CMS work was underway. The rerun passed three times in a row.

## Naming the first flake kept the second from being shrugged off

Three green reruns are where a flake like that usually ends: shrug, move on, wait for it to come back. This one didn't end there. The QR fix had landed twenty-nine minutes before the nonce fix, with the mechanism spelled out — random payload, whole-page substring scan, coincidental match — and the nonce fix's commit message points straight at it: "the same class of problem as the certificate QR." The second flake was filed as a member of a class that already had a name, so the repair started from the mechanism instead of from a mystery, and it took the same shape:

```php
// nonce="..." is 32 random characters per request. Blank that one attribute
// before scanning, so a coincidental "USD" in it can't fail a check about content.
$scan = (string) preg_replace('/\snonce="[^"]*"/', ' nonce=""', $html);

return array_values(array_filter([
    stripos($scan, 'canvas') !== false ? 'canvas' : null,
    stripos($scan, 'lorem') !== false ? 'lorem' : null,
    str_contains($scan, 'USD') ? 'USD' : null,
]));
```

The regex requires whitespace before `nonce=`, so it blanks the real attribute and nothing else. The accompanying test pins that boundary down: a nonce stuffed with "USD", "canvas" and "LOREM" is ignored, while "USD 100" in body text, `/images/canvas/` in an image path, "Lorem ipsum" in a paragraph, and a `data-nonce="USD"` attribute are all still caught. The random field is excluded by name; everything around it is scanned exactly as before.

## Exclude the random field by construction, never by tolerance

Both repairs follow one rule. A test that greps rendered output for a banned word assumes the output contains no field whose job is to vary, and a QR payload, a CSP nonce, a session token, or a request ID each break that assumption the moment it appears. So you identify which parts are supposed to be random and remove exactly those parts before checking anything else: decode a QR code instead of grepping its photograph, blank a nonce attribute by name instead of loosening the pattern around it. Neither repair is a retry, a skip, or a weaker matcher.

The QR case shows the payoff can run the other way, too. Excluding the noise properly forced the test to read what the QR actually encodes, and that made it strictly stronger than the substring version it replaced — a check that tolerates randomness in exactly the right place ends up stricter everywhere else.

A flaky test that fails for a reason you can name and force on demand was never flaky — it was checking the wrong thing, and now it checks the right one.
