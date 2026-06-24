# Implementation Map — Astro

How each design decision lands in your existing files. Implementation should be mechanical: drop in the two stylesheets, then wire the class names below into the components you already have. No new dependencies.

**Stack reminder:** Astro 5, Markdown content collections, fully static (`output: 'static'`), vanilla CSS via custom properties, no Tailwind, near-zero JS.

---

## 0. Stylesheets (do this first)

| Deliverable file | Replaces / becomes | Notes |
|---|---|---|
| `styles/design-tokens.css` | your `src/styles/tokens.css` | Supersedes current tokens. Same `:root` custom-property pattern — names are backward-compatible (`--bg-main`, `--border`, `--accent`, `--purple`, `--cyan`, `--green`, `--text-*`). New: extra surfaces, fluid type scale, spacing/radii/shadow/motion tokens, `--gradient-brand`, `--glow`, `--focus-ring`. |
| `styles/blog.css` | merge into your `src/styles/global.css` | Reset + ambient glow + all component classes + responsive + a11y. |

Import both once in `BaseLayout.astro` (see below). **Remove the dev `@import` for Google Fonts** at the top of `blog.css` and self-host instead:

```astro
---
// BaseLayout.astro
import '../styles/design-tokens.css';
import '../styles/global.css'; // (was blog.css)
---
<link rel="preconnect" href="/fonts" />
<!-- @font-face for Inter + JetBrains Mono in global.css, font-display: swap -->
```

---

## 1. `BaseLayout.astro`
- Add `<a class="skip-link" href="#main">Skip to content</a>` as the first body child.
- Body needs no class — the global `body::before` paints the **ambient glow** automatically (fixed radial gradients). Ensure direct children sit above it (already handled by `body > * { z-index: 1 }`).
- Wrap page content in `<main id="main" class="shell page">` (or `shell shell--prose article` for posts). Slot `<Header />` above and `<Footer />` below the `<main>`.
- Put `color-scheme: dark` + lang on `<html>`. Head: `<meta name="viewport">`, per-page `<title>`/`<meta description>`.

## 2. `Header.astro`
- Markup: `.nav > .nav__inner` with the mono logo `<span class="prompt">&gt;</span> afrizzal<span class="path">/blog</span>`, `.nav__links` (Posts / Categories / Tags / RSS), and the `.nav__cta` Portfolio link to `https://afrizzal.pro`.
- **Active link:** set `aria-current="page"` on the matching link by comparing `Astro.url.pathname` to each href — the gradient underline keys off that attribute. No JS.
- **Mobile (≤640px):** include the CSS-only disclosure — `<input type="checkbox" id="navt" class="nav__toggle sr-only">` + `<label for="navt" class="nav__burger">`. Pure CSS, ships static, works without JS. Keep it inside `.nav` as a sibling preceding `.nav__links` (the `:checked ~ .nav__links` selector depends on order).
- RSS link → `/rss.xml` (Astro `@astrojs/rss`).

## 3. `Footer.astro`
- `.footer > .footer__inner`: `© {year} ` + `<span class="mono">Afrizzal P Pratama</span>` on the left, `.footer__links` (LinkedIn / GitHub / RSS) on the right. `{year}` from `new Date().getFullYear()`.

## 4. `PostCard.astro`
- Root `<article class="card">`. Props from the content schema: `title`, `description`, `category`, `pubDate`, `tags[]`, plus computed `readingTime` and `href`.
- Anatomy:
  - `.post-card__top` → `<a class="badge badge--category" href={/categories/${slug(category)}}>` + `.meta` with `<time datetime={pubDate.toISOString()}>{formatDate(pubDate)}</time> · {readingTime} min read`.
  - `<h2 class="post-card__title"><a href={href}>{title}</a></h2>` — the stretched link makes the whole card clickable. Add `class="clamp-2"` on the inner `<a>` to cap **very long titles** at 2 lines.
  - `.post-card__desc`.
  - `.post-card__footer`: `{tags.length ? <div class="tag-row">…tags…</div> : <span class="meta" style="color:var(--text-muted)">No tags</span>}` (**no-tags edge case**) + `.post-card__more`.
- Reading time: compute at build from body word count (≈225 wpm), `Math.max(1, …)`.
- Date format `DD Mon YYYY` (e.g. `12 Jun 2026`) via `toLocaleDateString('en-GB', { day:'2-digit', month:'short', year:'numeric' })`.
- Optional `variant="rule"` prop → add `card--rule`. Keep one canonical variant per listing.

## 5. `Pagination.astro`
- Use Astro's `paginate()` (`page.url.prev`, `page.url.next`, `page.currentPage`, `page.lastPage`).
- Markup `.pagination`: prev `.page-btn` (or `<span class="page-btn" aria-disabled="true">` when `!page.url.prev`), `.pagination__status` `Page <b>{currentPage}</b> of <b>{lastPage}</b>`, next `.page-btn`.

## 6. `BlogPost.astro` (article layout)
- Shell: `<main id="main" class="shell shell--prose article">`.
- `.article__nav` back-link → `/` (or referring list).
- `.article-header`: `.article-header__meta-row` (category badge + `.meta` + optional `<span class="badge badge--amber">Updated</span>` when `updatedDate` set) → `<h1>` → `.lead` (from `description`) → `.tag-row` → `<hr class="article-header__rule">`.
- Render Markdown into `<article class="prose">…<slot/>…</article>`. Map rendered elements to the prose system:
  - **Code blocks:** Shiki is Astro's default. Wrap output in `.code-block` with a `.code-block__bar` (lang label) via a rehype plugin or a custom `<Code>` MDX component. The `tok-*` classes in the mockup are placeholders for Shiki's own token spans — keep Shiki's theme; just ensure the container is `.code-block` so it gets the border, header, and `overflow-x:auto` (**wide-code edge case** handled by CSS).
  - **Tables:** wrap in `.table-wrap` (rehype plugin or MDX component) for horizontal scroll.
  - **Images:** style via `.prose figure img`; use Astro `<Image>` for optimization. Author figures with `<figure><figcaption>` in MDX; the striped `.img-placeholder` is for mockups only.
  - h2/h3 anchors: add via `rehype-slug` + `rehype-autolink-headings` (prepend/append the `.anchor` `#`). `scroll-margin-top` already set.
- **Code-block copy button** (`.code-block__copy`): the one allowed sprinkle of JS — a tiny progressive-enhancement script (clipboard API, hidden until hover). Page is fully functional without it.

## 7. Routes / pages
| Mockup | Astro route | Source |
|---|---|---|
| `home.html` | `src/pages/[...page].astro` (paginated index) | `getCollection('blog')`, `paginate(perPage)` |
| `article.html` | `src/pages/posts/[...slug].astro` → `BlogPost` layout | content collection entry |
| `categories.html` | `src/pages/categories/index.astro` | dedupe categories + counts |
| `category.html` | `src/pages/categories/[category].astro` (`getStaticPaths`) | filter by category; render `.empty` when count is 0 (**empty edge case**) |
| `tags.html` | `src/pages/tags/index.astro` | tag cloud; bucket counts into `w1`–`w4` weight classes |
| `tag.html` | `src/pages/tags/[tag].astro` (`getStaticPaths`) | filter by tag; `.empty` when none |
| `404.html` | `src/pages/404.astro` | static; Astro serves on static hosts |

## 8. Content schema → UI
`{ title, description, category, pubDate, updatedDate?, tags[], draft }`:
- `category` → single `.badge--category`. `tags[]` → `.tag` pills. `draft: true` → exclude from production builds (`getCollection` filter) and optionally show `.badge--red Draft` in dev.
- `updatedDate` present → `.badge--amber Updated` in the article meta row.
- `description` → card description **and** article `.lead`.

## 9. Tag-cloud weighting
Map post-count to a weight class: `w4` ≥ 8, `w3` 5–7, `w2` 3–4, `w1` ≤ 2 (tune to your distribution). Drives only font-size; color/shape constant.

## 10. JS budget
- **Required:** none for layout, nav, or reading.
- **Progressive enhancement only:** code-block copy button. Guard with feature detection; never block render. Honor `prefers-reduced-motion` (already handled in CSS tokens — no JS needed).

## 11. Don't-break checklist
- [ ] Keep `body::before` glow and `z-index` layering when you add wrappers.
- [ ] Preserve nav source order (`input` → `label` → `.nav__links`) for the CSS-only mobile menu.
- [ ] Stretched card link requires the card to be `position: relative` (it is) and tag links to keep `z-index:1`.
- [ ] Swap the dev Google-Fonts `@import` for self-hosted `@font-face`.
- [ ] Run an axe/Lighthouse pass — target AA contrast + visible focus (the tokens are built to pass; verify after any color tweak).
