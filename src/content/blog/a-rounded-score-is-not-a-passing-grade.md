---
title: 'A rounded score is not a passing grade'
description: 'A training-academy information system I''m building had an exam scorer whose only output was a two-decimal float. Rounded, 2/3 clears a 66.67 passing grade it doesn''t meet; unrounded, PHP turns an exact 57/100 into 56.99999999999999 and fails it. The fix keeps the fraction in integers and rounds once, for display.'
category: 'Systems & Performance'
pubDate: 2026-10-19
tags: ['data-integrity', 'reliability', 'architecture', 'postgres']
draft: false
---

A passing grade is a boolean, not a decimal. Either the candidate cleared the bar or they didn't, and that decision should never depend on how a CPU happens to approximate one hundredth. On a training-academy information system I'm building, still pre-production, the plan for the post-test phase already had the right rule in writing: a candidate passes when the score is at least the passing grade, compared against the stored computed value, never the number rounded for display. A review of that plan against the code on the main branch found the rule had nothing to stand on — the existing scorer's computed value *was* the number rounded for display.

## The function that computes a score, computes a float

Here is the scorer, close to verbatim:

```php
final class Scoring
{
    public static function score(iterable $questions, array $answers): array
    {
        $correct = 0;
        $total = 0;
        $earned = 0;
        $totalWeight = 0;
        $recorded = [];

        foreach ($questions as $question) {
            $id = (string) $question->getKey();
            $choice = $answers[$id] ?? null;
            $choice = is_int($choice) && $choice >= 0 && $choice < count($question->options) ? $choice : null;
            $recorded[$id] = $choice;

            $total++;
            $totalWeight += $question->weight;

            if ($choice !== null && $choice === $question->correct_index) {
                $correct++;
                $earned += $question->weight;
            }
        }

        // The only score this function hands back is already rounded — the
        // earned and total weights never leave the loop.
        $score = $totalWeight === 0 ? 0.0 : round($earned / $totalWeight * 100, 2);

        return ['correct' => $correct, 'total' => $total, 'score' => $score, 'answers' => $recorded];
    }
}
```

`$earned` and `$totalWeight` are both integers the whole way through the loop — question weight is a positive small-integer column, so the sum of the weights a candidate got right is an integer too. The function has an exact answer sitting right there as a ratio of two integers. Then, on the second-to-last line, it throws that exactness away: `$earned / $totalWeight * 100` runs the division in floating point, `round(..., 2)` turns the result into a two-decimal number, and that number is what gets stored. Once it's stored, the fraction is gone. Every later comparison, average, or delta can only ever start from the rounded value.

## Rounding moves candidates across the bar

Take a post-test of three equally weighted questions and a candidate who gets two right. The exact score is 2/3, which is 66.666…%. The scorer stores `66.67`. Now set the passing grade at 66.67. Measured exactly, the candidate falls short — two thirds is less than 66.67 hundredths. Measured against the stored value, `66.67 >= 66.67` is true, and they pass. Rounding didn't just lose precision here; it promoted a score over a bar it never reached.

Set the bar at 66.66 instead and both paths agree on a pass. That is why this class of bug survives casual testing: it only shows up when the passing grade lands inside the sliver between the exact score and its rounded value, and nobody writes that test case unless they're already looking for it.

## Not rounding fails the other way

The obvious fix is to compare before rounding. It fails in the opposite direction. 0.57 has no finite binary representation, the same way 1/3 has no finite decimal one, so a double-precision float stores the closest approximation it can. For a candidate who earned exactly 57 points out of 100, `57 / 100 * 100` in PHP evaluates to `56.99999999999999`. Compare that to a passing grade of 57 and a candidate who landed exactly on the bar is told they missed it.

The existing scorer's `round(..., 2)` happens to repair this particular case — it lands back on `57.0` — which is how two wrong answers can look like one right one. The float paths fail at different boundaries: unrounded, a score sitting exactly on the bar can be rejected; rounded, a score just below it can be accepted. Neither is a comparison you can defend to the candidate on the wrong side of it.

## Rounding early doesn't just lose precision, it changes the number

The same mistake compounds when you aggregate, and the existing code already did it: the batch summary averaged the stored two-decimal scores and then rounded the average again. Take two candidates in a batch, one with an exact 2/3 and one with a perfect 3/3, and average them. Computed from the exact fractions, that average is 83.33%. Round each score to two decimals *first* — 66.67 and 100.00 — then average those, and you get 83.34%. One-hundredth of a point, invented entirely by the order of operations, with nothing in either dataset actually different.

The same thing happens to a delta. A candidate improves from 1/3 correct on a pre-test to 2/3 on the post-test. Computed exactly, that's a 33.33-point gain. Round each score first, subtract the rounded values, and you get 33.34. Neither difference is a rounding *error* in the sense of being slightly off and harmless — each is a different number, produced by a decision about when in the pipeline a ratio becomes a two-decimal value. Make that decision once, at the very last step before a human reads the number, and every aggregate agrees with the exact answer. Make it per score, and aggregates drift from it by a hundredth here and there, for no reason a reviewer could find by reading the code that computes any single score.

## A passing grade is a comparison between two integers

The replacement design doesn't touch the counting — the earned and scorable weights were already exact. It just refuses to manufacture a decimal before the one comparison that matters. Each attempt now stores what was earned and what was possible as two integer columns, and that pair is what flows into re-grades and the append-only results ledger. The passing grade lives in a `numeric(5,2)` column, but it is read as a string and parsed into integer hundredths — `"66.67"` becomes `6667` — so it never passes through a float either. Pass or fail is then integer cross-multiplication:

```php
// earned/scorable >= gradeHundredths/10000, cross-multiplied so no float
// ever exists on the decision path; a test with nothing scorable never passes.
public static function passes(int $earned, int $scorable, int $gradeHundredths): bool
{
    return $scorable > 0 && $earned * 10000 >= $gradeHundredths * $scorable;
}
```

Both sides of that comparison are products of integers. There is no rounding to get wrong, because there is no decimal intermediate to round. The unit tests pin both boundaries from this post: 57 of 100 against a passing grade of 57 passes; 2 of 3 against 66.67 fails, and against 66.66 passes.

A two-decimal score is still worth having — people need something to read on a results page — but it is computed once, from the exact fraction, with half-up rounding done in integer arithmetic, and it never flows back into a decision. Picking a candidate's highest attempt goes through the same cross-multiplication, with ties broken by the earliest submission rather than by whichever float happened to round up. Averages are summed as exact fractions in arbitrary-precision integer arithmetic and rounded once at the end, which is why the test for 2/3 and 3/3 expects 83.33, not 83.34. Even the migration that moved existing attempts onto integer fractions refuses to paper over the old scheme: it recomputes each attempt's fraction from its answers, checks the old stored score is a legitimate two-decimal rounding of it, and fails as a whole on any real mismatch.

None of this needed a new package. Integer arithmetic was already sitting in the loop that computed `$earned` and `$totalWeight` — the bug was never in the counting. It was in the one line that converted a perfectly good fraction into a float before anyone had asked it a yes-or-no question.

The old scorer was never wrong about who answered what; it was wrong only within a hair of the threshold, which in the design that follows is exactly where a post-test result decides whether someone gets a certificate.
