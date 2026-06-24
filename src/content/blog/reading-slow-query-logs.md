---
title: 'Read the slow query log first'
description: 'Before reaching for a bigger server, read the slow query log. It is the cheapest performance win you will ever get.'
category: 'Systems & Performance'
pubDate: 2026-06-05
tags: ['database', 'performance']
draft: false
---

Before reaching for a bigger server, read the slow query log. It's the cheapest performance
win you'll ever get.

## What it tells you

The log shows exactly which queries cost the most time and how often they run. Nine times out
of ten the culprit is a missing index or a query that loads far more rows than it needs.

## A quick checklist

1. Sort by total time, not just per-query time
2. Look for full table scans on hot paths
3. Add the index, then re-measure

I've turned multi-second pages into instant ones without touching the hardware. Start with the
data, not the credit card.
