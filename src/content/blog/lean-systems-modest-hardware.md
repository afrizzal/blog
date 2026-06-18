---
title: 'Lean systems on modest hardware'
description: 'Most of the tools I ship run happily on a single small box — and stay maintainable precisely because they are small.'
category: 'Engineering'
pubDate: 2026-06-15
tags: ['architecture', 'performance']
draft: false
---

Not every system needs a Kubernetes cluster. Most of the tools I've shipped run happily on a
single modest box — and stay maintainable precisely because they're small.

## Constraints are a feature

When the budget is one VPS, you make sharper choices: fewer moving parts, boring databases,
and caching where it actually matters.

## What I reach for

- A single relational database, indexed well, before any NoSQL
- Background jobs over real-time when the user can't tell the difference
- Static output wherever the content doesn't change per request

The result is something one person can reason about at 2 a.m. during an incident. That's the
real win.
