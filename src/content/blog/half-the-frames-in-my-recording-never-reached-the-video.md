---
title: 'Half the frames in my recording never reached the video'
description: 'A screencast take for a 30 fps tutorial logged 23,896 frames, and the renderer could only ever show 11,986 of them. Which frames reach the screen is decided by the output clock and the renderer''s pick rule, not the source frame rate, so a safe cut has to come from that rule and be checked against the log.'
category: 'Systems & Performance'
pubDate: 2026-10-23
tags: ['performance', 'typescript', 'video']
draft: false
---

The final take of a cashier tutorial I made for a multi-branch aesthetic clinic chain's management system logged 23,896 screencast frames. The 30 fps video built from it could only ever put 11,986 of them on screen. Which half survives isn't decided by how fast the recording captured. It's decided by the output clock and by the renderer's rule for which frame to show at each tick — write that rule down exactly and you can drop every source frame it will never pick while every output frame still picks the same source frame. The guarantee belongs to the rule, not to the recording, and where it stops matters as much as the cut.

![Illustration: a dense, uneven stream of translucent blank cards flows along a ribbon of blue light. Above it runs a rail of evenly spaced ticks; at each tick a thin beam reaches down and lifts one card into an evenly spaced row at the top, while the remaining cards drift past, dimmed.](../../assets/blog/half-the-frames-in-my-recording-never-reached-the-video/editorial-output-clock.webp "Concept illustration, generated with Codex's built-in image tool: the recording throws off snapshots unevenly; a steady output clock lifts out one per tick and lets the rest go by.")

## A screencast sends frames when the page paints, not when a clock ticks

The take is a Chrome screencast of the application on demo data, driven by a script, with every frame logged as a JPEG file name and a timestamp in seconds from the start of the take. That log is in Git; the JPEGs aren't. It shows a source that behaves nothing like a camera. Frame 0 arrived at 0.0217 s and frame 1 at 15.411 s, because the login screen didn't change for fifteen seconds and Chrome had nothing new to send. Up to the click on **Buka Shift** (open shift) at 116.99 s, the take collected 255 frames — about 2.2 per second.

Then the shift opened, and the app's top bar started pulsing a small "Shift Buka" status dot. The page now repainted constantly, and the stream jumped to 23,641 frames in the remaining 394.5 s: 59.9 per second, with a median gap of 16.7 ms. The production checkpoint records it in one line — the blinking dot makes Chrome send about 60 frames a second. So the source isn't a 60 fps recording. It's an irregular stream of samples, nearly empty where the screen sat still and twice as dense as the output wherever something moved.

## Sampling theory explains what a 30 fps grid loses, not which file to keep

Michael Unser's [*Sampling—50 Years After Shannon*](https://doi.org/10.1109/5.843002) starts from the classical result: a signal with no frequencies above some limit is completely determined by samples spaced finely enough, and the sinc series rebuilds it exactly (Theorem 1 and eq. 1, p. 569). The paper's argument is that the premise rarely holds. Real signals are never exactly band-limited, and the ideal filters the theorem assumes don't exist (p. 569). So it recasts sampling as prefilter, sample, reconstruct (Fig. 2, p. 571), and asks how far the approximation lands from the original instead of demanding a perfect rebuild (§II, §IV). Its comparison of three linear-spline methods is blunt: sampling with no prefilter is by far the least favorable, because anything above the Nyquist frequency counts against you twice — once because the model can't represent it, and again because sampling folds it back as **aliasing** (Fig. 7, p. 578), a distortion the appendix calls generally nonrecoverable (p. 583).

The tutorial's renderer sits at the plain end of that framework. Its picture model is piecewise constant — each frame stays on screen until the next one arrives, an irregular-knot version of the paper's box function, the B-spline of degree 0 (eq. 15, p. 572). And it reads that held picture at each tick without averaging the frames inside the 33 ms window: point sampling, no prefilter. Whatever the 60-per-second paint stream carried faster than a 30 fps grid can show was given up the moment the video was set to 30 fps, before a single file was dropped. The paper explains that loss. It doesn't license the cut, and it isn't about this stream in particular: its subject is regular sampling on a uniform grid, with irregular sampling mentioned "only briefly" (p. 570; §V-E, p. 582). A vocabulary trap: when Unser writes about **frames** (§V-D, p. 581), he means a redundant set of functions that spans a space — a generalized basis — not pictures in a video.

## The renderer's pick rule is the whole guarantee

The compositor is a Remotion composition written in TypeScript. At every output frame it asks one function which screencast frame to draw:

```ts
/** the screencast frame on screen at time t (the latest one sent at or before t) */
function frameAt(frames: [string, number][], t: number) {
  let lo = 0, hi = frames.length - 1;
  // upper-middle split + "<=": converges on the LAST frame stamped at or before t,
  // so equal timestamps resolve to the later frame
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (frames[mid][1] <= t) lo = mid; else hi = mid - 1; }
  // nothing stamped at or before t? lo never moved, so frame 0 stands in
  return frames[lo][0];
}
```

The edges are all in those lines. Before the first frame, the answer is frame 0 — that happens exactly once in this take, at t = 0, since frame 0 is stamped 0.0217 s. Equal timestamps resolve to the later frame. After the last frame, the last frame holds. And the caller clamps time to the take's length (`Math.min(t, data.duration)`), so the 138 output frames that run past the end of the take all ask about 511.462 s.

Read as a rule, it says a source frame reaches the screen only if some output time lands between its own timestamp and the next frame's. When frames arrive faster than ticks, many of those stretches fall entirely between two ticks, and nothing will ever ask for them.

![Diagram, synthetic example: capture timestamps at 0, 12, 28, 45, 62, 79 and 95 ms on an upper lane, output times 0, 33.3, 66.7 and 100 ms on a lower lane; connectors show the output times picking 0, 28, 62 and 95 ms, while 12, 45 and 79 ms are never picked.](../../assets/blog/half-the-frames-in-my-recording-never-reached-the-video/timestamp-diagram.svg "Synthetic example, not production data. Each 30 fps output time picks the last capture at or before it. No output time lands inside the stretches where the frames at 12, 45 and 79 ms would be on screen, so the clock never asks for them.")

## One forward pass finds every frame the clock will ever ask for

Because the rule depends only on output times, it can run ahead of the render: `thin-take.mjs` walks the output timeline once and writes a derived take holding only the frames some tick will pick:

```js
const FPS = 30, frames = take.frames;
const keep = new Set();
let i = 0;                                   // never moves back: the whole scan is one pass
for (let k = 0; k <= Math.ceil(take.duration * FPS) + FPS; k++) {  // a second past the end
  const t = k / FPS;                         // the same double the renderer gets from frame / FPS
  while (i + 1 < frames.length && frames[i + 1].t <= t) i++;       // the same "<=" as frameAt
  keep.add(i);
}
const kept = [...keep].sort((a, b) => a - b).map((j) => frames[j]); // outside the O(N + M) claim
```

The edges match `frameAt` on purpose: the pointer starts at frame 0, `<=` walks past equal timestamps to the later one, the bound stops at the last frame, and the extra second covers the clamped tail. Each of the M output times is visited once and the pointer only moves forward, at most N − 1 times in total, so the scan is O(N + M). On the final take, M was 15,375 and the pointer advanced 23,895 times — exactly N − 1. That bound covers the scan and nothing else: the sort of the kept indices, the 11,986 hard links and the JSON write sit outside it, and I didn't time any of them.

It's a merge of two inputs ordered on the same key, and Goetz Graefe's survey of query evaluation states the price of admission: merge-join "requires that both inputs are sorted on the join attribute" ([Graefe 1993](https://doi.org/10.1145/152610.152611), p. 106). Neither script checks that. The final take's 23,896 timestamps strictly increase. The first take, which wasn't used, had four places where a timestamp ran about 3 ms backwards; no output time happened to land inside one of them, so its thinned list still agreed with its original. That's luck, not design.

## The renderer keeps binary search because it never sees the timeline in order

So why doesn't the renderer scan too? It never gets the chance. Remotion renders each frame independently — its documentation warns that [frame 30 might be rendered before frame 10](https://www.remotion.dev/docs/troubleshooting/css-animations) — and it renders across several browser tabs that [don't share state](https://www.remotion.dev/docs/flickering). There's no pointer left over from the previous frame to advance. `frameAt` has to find its answer from t alone, which is what binary search does: about 14 halvings over 11,986 entries, 15 over 23,896. Halving N saves one step per frame, and I don't count that as a result.

Graefe draws the same line between a merge and an index nested-loops join, which replaces scans with index lookups and can be the fastest method when one input is small and the indexed one is large (p. 106). Preprocessing a whole timeline in order is a merge. Answering one arbitrary time per render call is a lookup. What has to be identical across the two is the rule — at or before, later on ties, first before the start, last after the end — not the algorithm.

## The cut holds only while take time is video time

Two things keep the take's timestamps on the same grid the renderer samples. The take starts on a whole output frame — frame 240, after an 8-second title card — and Remotion's frame counter [restarts at zero inside the take's sequence](https://www.remotion.dev/docs/sequence), so the renderer's t is take time from the first frame. And the data builder passes every timestamp through a function, `at()`, that maps take time to video time. If a narration clip's length differs from the length that paced its step by more than half a millisecond, `at()` stretches that step's voice window and shifts every later time. A shifted timestamp moves against the 30 fps grid, and a frame that no tick picked in take time could be exactly the one a retimed tick needs.

`thin-take.mjs` refuses any take that wasn't paced by the final narration, and its error says why: "re-timing would move frame times". That guard works from provenance — a field saying which voice paced the take — rather than by recomputing each window. The evidence that it held is in the data built for the final render: `retimed: []`, so `at()` returned every timestamp unchanged, and the frame list it handed to the composition is the derived take's, entry for entry.

## I checked which frame gets picked, not what the video looks like

A small read-only script reads both take logs from Git, runs the thinning loop and `frameAt` exactly as written, and walks every output frame of the final composition: 15,722 frames, of which the take fills the 15,482 after the title card. Recomputing the thinning from the original log reproduced the derived list exactly — the same 11,986 files with the same timestamps. At all 15,482 output frames, the original list and the thinned list picked the same file: zero disagreements. Both put exactly 11,986 distinct frames on screen, and none of the kept frames went unused. The cut landed where the sampling story predicts: 164 of the 255 frames before the shift opened were kept, against 11,822 of the 23,641 after it.

![Horizontal bar chart of source frames in the final take: the original take has 23,896 frames, of which 11,986 are picked at some 30 fps output time and 11,910 never are; the derived take for 30 fps has 11,986. These are counts of screencast frames, not output frames, render time or file size.](../../assets/blog/half-the-frames-in-my-recording-never-reached-the-video/frame-count-chart.svg "Source frames in the final take, counted from the take logs. The bars count screencast JPEGs, not output video frames, render time or file size.")

What the check doesn't show matters as much. It compares the file each output frame would draw, not pixels, and nothing was re-rendered. No render was timed, and Gene Amdahl's [1967 argument](https://doi.org/10.1109/N-SSC.2007.4785615) is the reason not to guess: speeding up one part of a job is capped by the part you didn't touch, and I never measured how much of a render goes into fetching frames. Disk didn't shrink either — the derived take is hard links to the same files, and the original take was left as it was. The private media archive for the final stores the derived take's 11,986 frames, so the other 11,910 aren't in it. That makes the derived take complete for one renderer at 30 fps with this pick rule, and nothing more: a 60 fps export, a renderer that blends frames for motion blur, or a re-timed narration would all need the original.

The recording decides what could be on screen; the output clock and the pick rule decide what will be, and only the second is safe to cut against.

---

## Sources

- IEEE — Michael Unser, *Sampling—50 Years After Shannon*, Proceedings of the IEEE, vol. 88, no. 4, pp. 569–587, April 2000; journal article (Shannon's theorem and the sinc series, p. 569; the prefilter–sample–reconstruct paradigm, Fig. 2; the degree-0 B-spline, eq. 15; aliasing without a prefilter, Fig. 7 and Appendix A; regular-sampling scope and the brief treatment of irregular sampling, pp. 570 and 582; frames as redundant function sets, §V-D). Retrieved 2026-10-23. <https://doi.org/10.1109/5.843002>
- ACM — Goetz Graefe, *Query Evaluation Techniques for Large Databases*, ACM Computing Surveys, vol. 25, no. 2, pp. 73–170, June 1993; journal article (merge-join requires both inputs sorted on the join attribute; index nested-loops join replaces scans with index lookups, p. 106). Retrieved 2026-10-23. <https://doi.org/10.1145/152610.152611>
- AFIPS — Gene M. Amdahl, *Validity of the Single Processor Approach to Achieving Large Scale Computing Capabilities*, AFIPS Conference Proceedings, vol. 30, pp. 483–485, 1967; conference paper, read in its reprint in IEEE Solid-State Circuits Society News, Summer 2007, pp. 19–20 (the part of a workload that isn't sped up caps the overall gain). Retrieved 2026-10-23. <https://doi.org/10.1109/N-SSC.2007.4785615>
- Remotion — *Flickering*; technical documentation (Remotion renders in several browser tabs that don't share state). Retrieved 2026-10-23. <https://www.remotion.dev/docs/flickering>
- Remotion — *Don't use CSS animations*; technical documentation (each frame is rendered independently; frame 30 might be rendered before frame 10). Retrieved 2026-10-23. <https://www.remotion.dev/docs/troubleshooting/css-animations>
- Remotion — `<Sequence>`; technical documentation (inside a sequence, `useCurrentFrame()` is shifted by its `from`). Retrieved 2026-10-23. <https://www.remotion.dev/docs/sequence>
