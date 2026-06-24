---
title: 'I budget tech debt like a credit card, not a backlog'
description: 'Most of your tech debt charges no interest, sits on no road you will drive, and should never be paid off — chasing it is wasted principal dressed up as discipline. The debt worth money is the recurring tax under the feature you are about to ship, and it gets funded inside that feature, never beside it.'
category: 'Engineering Leadership'
pubDate: 2026-06-22
tags: ['tech-debt', 'leadership', 'prioritization']
draft: true
---

Stop asking your CEO for a sprint to pay down tech debt. That ask loses every time, and it should — you priced your own discipline as comfort and handed it to a room that runs on numbers. Most of your tech debt you should never pay off anyway. It is ugly, isolated, untouched, and charging you nothing — a 0% loan. The debt that actually costs you money is the thin slice sitting under the road you are about to drive on, quietly taxing every change. The job is not to retire the balance. It is to find the part that is charging interest and refinance it inside the work that already has to happen.

## The interest, not the principal, is the only number that costs you money

A credit card has two numbers. The principal is what you borrowed — here, the messy module, the tangled service, the schema nobody is proud of. The interest is what you pay every billing cycle just for carrying it: features that ship slower because they route through that module, bugs that recur because the design invites them, onboarding that drags because new hires have to learn the workaround before they can learn the system, incidents that cluster around the same fragile seam.

You manage the interest, not the principal. You do not rush to clear a 0% promotional balance while a 24% card compounds beside it. Tech debt is worth real money only when it is charging interest. Principal sitting quietly in a corner — a gnarly script that runs once a quarter and nobody touches — costs you nothing this year, next year, or the year after. Track it, fine. Funding its cleanup is a withdrawal with no deposit.

## The standard ask loses because you priced it as comfort

"Give us a sprint to clean up tech debt." "We need a quarter for a refactor." You have made this ask. It lost. It lost correctly, from where the exec was sitting.

Framed that way, the ask is purity with no stated return, competing head-to-head against features that have one. The CEO does not hear "investment." They hear *pause shipping value so the engineers can be more comfortable.* It is more than comfort, of course — but you handed them a request with no business number attached and a clear opportunity cost, the features you are not building during that sprint. Against a roadmap item with revenue or retention behind it, an un-priced cleanup loses every single time. It should. You would make the same call from that chair.

The error is not the exec's. It is that you brought a number-free ask to a room that runs on numbers.

## An unnamed interest rate never gets funded

Before anyone funds a paydown, the interest has to be visible, and visible in the roadmap's language, not yours. "The auth code is a mess" is not a rate. It is an aesthetic complaint. If your justification only lands with other engineers, you have written a complaint, not a business case. Translate it into the tax it imposes on work the business already cares about:

- "Every change to billing currently takes about 30% longer because it has to thread through this module."
- "This component is behind two of every three of our worst customer-facing outages this quarter — the recurring ones that take payments down."
- "It adds roughly two weeks to every new engineer's ramp on the payments team."

Now there is a rate. Numbers like these are illustrative — yours come from your own incident logs, cycle-time data, and onboarding notes, and they do not have to be precise to be persuasive. They have to be *named*. "Slows us down" is unfundable. "Adds ~30% to every billing change" is a line a finance-minded person can reason about, because it is denominated in time and risk, which convert to money.

Not all of this debt is even chosen. A composite index added in good faith to speed up a query can end up [making the very query it was meant to speed up slower](/blog/index-that-made-the-query-slower/). Nobody chose that debt. It still has to be serviced, and the service is cheap once it is named. An interest rate you cannot state is an interest rate nobody will pay to retire.

## Pay down only the debt under the road you are about to drive on

Here is the part that gets argued with. The triage rule is not "fix the worst debt." It is: spend principal only on interest-bearing debt that sits on the critical path of the roadmap you have already committed to — or that is clearly imminent on the path you can already see you are driving.

Two filters, both required. Is it charging interest — is it actually taxing changes, or just offending you? And is it on the road ahead — will the next quarter of real work route through it? Debt that fails either filter you carry. You leave it. You clean it up only when you are already in there for another reason — tidy it on the way past, but do not mount an expedition. The ugly-but-isolated module that nothing on the roadmap touches stays exactly as ugly as it is. Spending a sprint to beautify code no upcoming feature will go near is the engineering equivalent of overpaying a 0% card while a 24% balance compounds beside it.

This is why "fix all the tech debt" is not rigor. It is the absence of triage. The skill is choosing the small set of balances that are both interest-bearing and in your path, and ignoring the rest. The remaining debt is not failure. It is a portfolio decision.

## Fund the paydown inside the feature, not beside it

Once you have triaged to the debt that is taxing the road ahead, the funding ask rewrites itself. You do not ask for time to fix X. You bundle X into the feature it is slowing down.

The last time I got a paydown funded, I never said the word *refactor*. I priced the next three billing features as roughly 40% slower to build and noticeably riskier to ship until X was fixed. Fixing X first was about 15% of the quarter's billing scope, and it removed that tax from the other 85% — returning roughly a third of the quarter's billing capacity for a sixth of its cost, on the assumption that the remaining billing work actually routes through X, which is the triage filter from the section above. The CEO did not approve an engineering sabbatical. The CEO approved faster, safer billing features that were already on the roadmap and already wanted.

Same work as the rejected refactor. Opposite outcome. The only thing that changed is that the paydown became a line item *inside* the feature that benefits, framed as the thing that makes the rest of the quarter cheaper, rather than a standalone request to stop delivering value for a while. Debt gets funded as a discount on work you are already buying, never as a separate purchase.

This also disciplines you. If you cannot show the paydown makes a committed feature meaningfully faster or safer, that is not the business being short-sighted — that is the debt revealing itself as the 0% loan you were about to overpay.

## Bankruptcy is real, but it is not your opening move

Sometimes the interest genuinely swamps throughput. Every feature is late. Incidents dominate the calendar. The interest payments alone consume the team, and no line-item refinancing keeps up. That is insolvency, and the answer is a real restructure.

But a restructure is earned by numbers and rare. You declare it when you can show the system pays more in interest than it produces in value — and a restructure is months of paused delivery and real budget with real execution risk, the most expensive thing you can ask for. It is not the default ask dressed up in dramatic language.

Reach for "we need to rewrite this" on routine drag and you spend the credibility a real restructure requires. On the day insolvency is genuinely true, the claim has to be believed on sight. Cry bankruptcy early and it is met with a reflexive no when it finally matters. The routine line-item paydown is what earns you a real hearing on the day the restructure is real.

A backlog item asks someone to pay for code. An interest rate asks them to stop paying a tax. Only one of those is a thing a business will ever buy.
