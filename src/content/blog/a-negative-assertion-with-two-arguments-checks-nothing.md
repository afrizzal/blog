---
title: 'A negative assertion with two arguments checks nothing'
description: 'In Pest, ->not->toContain($needle, $label) reads like one check with a failure message attached. toContain is variadic, so the label is a second needle and the negation only fires when the page contains both — which turned a 75-check privacy sweep into one that practically verified nothing.'
category: 'Systems & Performance'
pubDate: 2026-10-13
updatedDate: 2026-10-25
tags: ['testing', 'reliability', 'privacy']
draft: false
---

A trailing argument on an assertion can be a diagnostic label or one more thing to check, and the call site looks identical either way. In Pest, `expect($html)->not->toContain($needle, $label)` is the second kind: the label is a second needle, and a negated check over two needles only fails when the page contains both. On a training-academy information system I'm building, still pre-production, a privacy sweep written in exactly that shape — "no analytics tag on any page a private link leads to" — ran 75 negated checks per suite run and practically verified nothing. An adversarial review caught it the same morning the helper was written, and the proof that its replacement works is a deliberate mutation, not a green run.

## The assertion read like a check with a label and ran like a check with two needles

The rule the sweep defends comes from the design record: the analytics tag renders only on public content pages in production — never on forms, token-gated pages, previews, or admin — and a link token must never leak to analytics or to a referrer. The sweep checked the page each kind of private token link lands on, the thank-you pages after an inquiry or a registration, certificate verification, the admin login, and editor previews. To keep two dozen of those checks readable, the tests went through one helper:

```php
function expectNoAnalyticsTag(TestResponse $response, string $label): void
{
    // Reads as: "must not contain the tag; if it does, report $label".
    // Runs as:  "must not contain the tag AND $label" — fails only if both are there.
    expect((string) $response->getContent())->not->toContain('googletagmanager', $label)
        ->not->toContain('gtag(', $label)
        ->not->toContain('google-site-verification', $label);
}

// Call site: the label is meant as a diagnostic, and becomes a needle.
expectNoAnalyticsTag($this->get('/admin/login')->assertOk(), 'admin login');
```

Most assertion APIs treat a trailing string as a failure message, and the line was written as if Pest did too. Pest's signature is `toContain(mixed ...$needles)`: it loops over the needles and asserts each one is present, so the positive form passes only when the subject contains every argument. `->not` is implemented by running the wrapped expectation and passing if it throws. Put those together and `->not->toContain('googletagmanager', 'admin login')` throws — and therefore fails the negation — only when the page contains the tag *and* the literal text "admin login". The labels were short descriptions like that one, or the name of a thank-you page, or a link's purpose; a page has no reason to contain them verbatim, so the second needle was missing on almost every call — and on each of those calls the wrapped expectation threw and the negation passed, whatever the page contained.

That is a **vacuous assertion**: one that cannot fail for the reason its name claims. Nothing about it is syntactically wrong. A variadic parameter accepts the extra string without complaint, and a string is a perfectly valid needle.

![A ball rolls through a doorway, snapping the low tripwire, but the net above stays up: its second wire runs to an amber name tag on the wall.](../../assets/blog/a-negative-assertion-with-two-arguments-checks-nothing/a-net-that-needs-two-tripwires.webp "Concept illustration, generated with Codex: the label became a second tripwire, so the net only drops when both are pulled.")

## Whether a check worked depended on what its label happened to say

The helper ran 25 times per suite run — on the entry redirect and the landing page of each of seven kinds of token link, on the six other pages that must stay clean, and on content pages while analytics was switched off — with three negated checks each. Seventy-five checks, and their coverage was decided by label text nobody was reading as code. Three of the content-page calls used the page URL as the label, and the homepage's URL is `/`, a substring of every closing tag in every HTML document. That one call's negation could fire, by accident. The privacy-relevant calls were labeled with a link's purpose or a page's name, and whether any of those strings happened to appear in its own page was luck, not design.

A green run carries no information about which of those situations you're in. A broken assertion and a correct one produce the same terminal output against correct code; the only observable difference is what happens when the property they guard stops being true, and nothing in a passing run tells you that. Here the gap was short-lived: the helper was committed at 10:00 one morning and rewritten at 10:17, in the very next commit. But nothing in the suite's output would ever have flagged it — not at 10:17, and not a year later.

## The review found it because its job was to assume the coverage was fake

The finding came out of a structured adversarial review of that morning's work, split across five dimensions. It raised eleven findings, and each one had to survive two skeptics trying to refute it before it was accepted. Three survived, and all three were the same species: a test that could not fail for the reason its name claimed.

The variadic negation was the most serious. The second was a test titled as proving that the create forms forward an SEO override into the first saved revision; it called the underlying action directly, so the form itself could have dropped the fields and the test would have stayed green. The third was an `assertSee` on a help-text string that happens to be a prefix of its "off" variant, so the assertion would pass with the wrong help text on screen. The review's security and privacy dimension found nothing in the product — the hole was in the evidence, not in the code it was meant to cover. A helper named `expectNoAnalyticsTag`, called 25 times, reads like coverage. Finding the seam took a pass whose brief was to assume the coverage was fake, which is a different job from writing the tests.

## The fix is one needle per call, and the proof is a deliberate mutation

The repair collapses each check to one needle and one boolean, which removes the ambiguity instead of working around it:

```php
function expectNoAnalyticsTag(TestResponse $response, string $label): void
{
    $html = (string) $response->getContent();

    // One needle per check: Pest's toContain() is variadic, so a second argument
    // is another needle, never a message. toBeFalse() does take a message.
    foreach (['googletagmanager', 'gtag(', 'google-site-verification'] as $needle) {
        expect(str_contains($html, $needle))->toBeFalse($label.': '.$needle);
    }
}
```

A rewritten helper going green proves nothing on its own — the old one was green too. So the commit records two deliberate mutations. First, the SEO component that decides where the tag renders was changed to render it on every route, and the sweep went red, failing first on the page a payment link lands on: `payment: googletagmanager`. Second, the SEO-override line was removed from the landing-page create form, and the rewritten create-form test failed with a null title. Both mutations were reverted once they'd done their job. That's the actual bar for "this test checks something": not that it passes against working code, but that it fails against code you broke on purpose.

## A message slot is a habit, not a guarantee

The wrong reading is easy because the neighbors teach it. Pest's `toBe($expected, string $message = '')` and `toBeFalse(string $message = '')` both end in a message, and PHPUnit's `assertStringContainsString($needle, $haystack, $message = '')` does too. `toContain` breaks the pattern, and nothing at the call site shows it.

Negation is what made the mistake silent. Written positively, `toContain($needle, 'admin login')` would have failed on the first run, because the page doesn't contain the label — a loud, immediate signal that the label was being read as a needle. Under `->not`, the same misreading flips from "always fails" to "always passes", and always-passes looks exactly like success. So the two checks worth making before trusting a negative assertion are the signature of the matcher under it, and a mutation that makes the forbidden thing appear and watches the test go red.

A test that cannot fail isn't a safety net — it's a sentence written in the grammar of one.

---

## Sources

- Pest — *pestphp/pest v5.2.0: `src/Mixins/Expectation.php`* (`toContain(mixed ...$needles)` asserts every needle is present; `toBe` and `toBeFalse` take an optional `$message`). Retrieved 2026-10-21. https://github.com/pestphp/pest/blob/v5.2.0/src/Mixins/Expectation.php
- Pest — *pestphp/pest v5.2.0: `src/Expectations/OppositeExpectation.php`* (`->not` runs the wrapped expectation and passes when it throws an assertion failure). Retrieved 2026-10-21. https://github.com/pestphp/pest/blob/v5.2.0/src/Expectations/OppositeExpectation.php
- PHPUnit — *sebastianbergmann/phpunit 13.3.3: `src/Framework/Assert.php`* (`assertStringContainsString(string $needle, string $haystack, string $message = '')`). Retrieved 2026-10-21. https://github.com/sebastianbergmann/phpunit/blob/13.3.3/src/Framework/Assert.php
