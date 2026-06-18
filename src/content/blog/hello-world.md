---
title: 'Hello, World'
description: 'Why I started this blog, what I plan to write about, and a quick tour of the formatting it supports.'
category: 'Notes'
pubDate: 2026-06-18
tags: ['meta', 'career']
draft: false
---

Welcome to the blog. I'm Afrizzal — I work where IT operations, CRM, advertising, and AI
automation meet measurable business outcomes. This is where I'll write the things that don't
fit in a portfolio: lessons from shipping systems, notes on the stacks I use, and the
occasional opinion.

This first post does double duty — it's also a quick check that every piece of formatting
renders the way it should.

## Why a blog?

A portfolio shows *what* I built. A blog shows *how I think*. Expect posts on:

- Building lean, maintainable systems on modest infrastructure
- CRM and revenue plumbing that actually moves numbers
- Practical AI automation — beyond the demos
- War stories from real production incidents

## Code looks like this

Posts are written in Markdown, and code blocks are highlighted with the same GitHub-dark
palette as the rest of the site:

```ts
type Post = { title: string; tags: string[] };

export function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

console.log(slugify('Hello, World')); // "hello-world"
```

Inline code such as `npm run build` is styled too.

## Quotes and lists

> The best way to predict the future is to build it — then write down what broke.

Ordered lists work as expected:

1. Write the post in Markdown
2. Preview with `npm run dev`
3. Build and upload

## What's next

I'll keep these short and useful. If you want to follow along, grab the
[RSS feed](/rss.xml) or find me on the links in the footer.

Thanks for reading — more soon.
