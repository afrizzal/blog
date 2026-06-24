# afrizzal/blog — Design Spec

The blog is the writing wing of the afrizzal.pro portfolio. It must read as the **same brand universe**: deep-navy GitHub-Primer dark theme, ambient purple/teal glow, mono accents, crisp bordered cards. Vanilla CSS driven by custom properties; static HTML in `dist/`; near-zero JS.

**Brand one-liner:** deep-navy dark theme with subtle ambient purple/teal glow, mono accents, and bordered cards that light up on hover.

---

## 1. Foundations

### Type
| Role | Family | Notes |
|---|---|---|
| UI + prose | **Inter** (`--font-sans`) | 400/500/600/700; `cv11`/`ss01` enabled |
| Meta, eyebrows, logo, code | **JetBrains Mono** (`--font-mono`) | 400/500/600/700 |

Self-host both in production (`/fonts`, `font-display: swap`). Only these two families load — no third web font.

Scale is fluid via `clamp()` so headings breathe on desktop and stay legible on mobile. Body reading size is **17→18px** at `--lh-body: 1.7`. Tokens: `--fs-eyebrow` (12) · `--fs-meta` (13) · `--fs-sm` (14) · `--fs-base` · `--fs-lead` · `--fs-h4/h3/h2/h1` · `--fs-display`.

### Color (all WCAG AA on their intended surface)
- Surfaces step up: `--bg-main #060b17` → `--bg-card #0d1526` → `--bg-elevated #111d33` → `--bg-subtle #172036`, plus `--bg-inset #0a1120` for wells (blockquote).
- Text: `--text-primary #e6edf3`, `--text-secondary #9aa4b2` (nudged lighter than the portfolio's `#8b949e` to clear AA on `--bg-card`), `--text-muted #6e7681` (meta only — never body copy).
- Accents share a chroma family, hue shifts only: `--accent #3b82f6` (links/buttons), `--purple #a78bfa` (tags), `--cyan #22d3ee` (category badges), `--green #3fb950`.
- **Signature gradient** `--gradient-brand` purple→blue→cyan: used as clipped text emphasis, eyebrow tick, heading-anchor, hairline rules, and the card leading-rule variant. Use sparingly — one gradient moment per view.

### Ambient glow
Fixed `body::before` with two radial gradients anchored at the bottom (`--glow-purple rgba(124,58,237,.28)` bottom-left, `--glow-teal rgba(34,211,238,.10)` bottom-right). `position: fixed; pointer-events: none; z-index: 0`. Content sits at `z-index: 1`.

### Spacing, radii, motion
- Spacing is a **4px base scale** (`--space-1`…`--space-24`). Compose vertical rhythm from these only.
- Radii: `6 / 8 / 12 / 16px` + `pill 100px`. Cards use `--radius-lg (12)`; badges/tags use pill; buttons/inputs use `--radius-md (8)`.
- Motion: `--dur 0.2s` default, `--ease ease`; expressive movement uses `--ease-smooth cubic-bezier(0.16,1,0.3,1)`. **`prefers-reduced-motion: reduce` collapses all durations to ~0** and disables smooth scroll.

---

## 2. Layout grid & max-widths
- **Reading column** `--measure-prose: 760px` — article body, article header.
- **Wide shell** `--measure-wide: 1100px` — nav, footer, home/list/category/tag pages.
- Page side padding `--gutter: clamp(1.25rem, 4vw, 2rem)`.
- Fixed nav is **60px** (`--nav-height`); page content clears it with `padding-top: calc(var(--nav-height) + space)`.
- `.shell` centers and pads; add `.shell--prose` to clamp to the reading column.

---

## 3. Components

### Nav (`.nav`)
Fixed, full-width, 60px, glassy (`backdrop-filter: blur(14px) saturate(140%)` over `--bg-main` at 72%), 1px subtle bottom border. Inner content clamped to `--measure-wide`. Logo `> afrizzal/blog` in mono (`>` cyan, `/blog` secondary). Links right-aligned (`margin-left:auto`); the active link carries a gradient underline via `aria-current="page"`. Trailing **Portfolio ↗** CTA is a bordered ghost button linking to the apex domain.

### Footer (`.footer`)
Subtle top border, clamped to `--measure-wide`. `© 2026 Afrizzal P Pratama` (name in mono) on the left; LinkedIn / GitHub / RSS links on the right. Stacks on mobile.

### PostCard (`.card`) — canonical
`--bg-card`, 12px radius, **transparent border at rest** with `--shadow-card`. On hover: border → `--border`, background → `--bg-elevated`, `--shadow-hover` (lift + accent-tinted glow), `translateY(-2px)`, title brightens to `#fff`, "Read post →" turns blue and nudges right. Anatomy top-to-bottom: top row (category badge + meta line), title (`h2`/`h3`, `-0.015em`), description (secondary, ≤64ch), footer (tag pills + more-affordance). The title link is **stretched** (`::after { inset:0 }`) so the whole card is one click target; tag pills sit above it at `z-index:1` so they stay independently clickable.
- **Variant B `.card--rule`** — adds a gradient leading rule that fades in on hover. Use for a featured/recent strip if desired; keep one canonical variant per view.

### Badges & tags
- `.badge--category` (cyan) for the single category; mono, uppercase, pill, tinted fill. State variants: `--accent`, `--green` (published), `--amber` (updated), `--red` (draft), `--muted` (archived).
- `.tag` (purple) — mono, lowercase, leading `#`, pill. Hover lightens and lights the border.

### Meta line (`.meta`)
`CATEGORY · 12 Jun 2026 · 4 min read` in mono `--fs-meta`. Category as badge, `<time datetime>` secondary, reading time muted, `·` dots at 0.5 opacity.

### Pagination (`.pagination`)
`← Newer · Page 1 of N · Older →`. Prev/next are `.page-btn` (card bg, subtle border, hover lifts to elevated). Disabled end uses `aria-disabled="true"` (0.4 opacity, no pointer). Status in mono with bold numerals. Stacks (reversed, full-width buttons) ≤560px.

### Article header
Back-link (mono, cyan arrow, gap widens on hover) → meta row (category badge + meta + optional **Updated** amber badge) → `h1` (`--fs-h1`, 700, `-0.02em`, balanced) → lead (`--fs-lead`, secondary) → tag pills → gradient hairline `<hr>`.

### Prose (`.prose`) — the reading system
- Vertical rhythm via `.prose > * + * { margin-top: --space-6 }`; headings get extra top space and tight `+ *` below.
- Paragraphs `#d6dde6` at 1.7; `text-wrap: pretty`.
- `h2/h3` carry a hover-reveal `#` **anchor**; `scroll-margin-top` clears the fixed nav.
- Links: blue, underline at 3px offset, 0.4-alpha decoration that solidifies on hover.
- Lists: `ul` purple `▹` markers, `ol` mono numerals; nested lists supported.
- Blockquote: gradient `border-image` left edge, `--bg-inset` well, lead-sized text, optional mono `<cite>`.
- Inline code: `--bg-subtle` chip, subtle border, purple text.
- **Code block (`.code-block`)**: bordered, rounded, header bar (traffic dots + uppercase mono lang), hover-reveal **copy** button, `pre` with `overflow-x:auto`. A block **wider than the column scrolls horizontally on its own** — the page never does. Shiki output drops into `pre code`; the `tok-*` classes here are a stand-in for Shiki's theme.
- Tables: wrapped in `.table-wrap` (`overflow-x:auto`, bordered/rounded), mono uppercase header on `--bg-elevated`, zebra body rows.
- Figures: bordered/rounded image (or striped `.img-placeholder` with mono caption of what belongs there), centered mono `figcaption`.
- `<hr>`: gradient hairline, generous margin.

### Empty state (`.empty`)
Dashed-border panel, mono `∅` glyph, headline + one line, ghost button back home. Render in place of the post list for an **empty category/tag** or no-results.

### 404 (`.notfound`)
Centered, `404` in display mono with the brand gradient, headline, one calm line, primary + ghost actions, and a mono `GET /missing · 404 Not Found` footnote that keeps the developer tone.

---

## 4. Interaction & state spec
Every interactive element implements **default / hover / focus-visible / active / disabled**:
- **Hover** — `--dur 0.2s`. Cards lift + glow; links shift color; buttons brighten; affordance arrows nudge via `--ease-smooth`.
- **Focus-visible** — keyboard only. `--focus-ring` = 2px page-colored inset + 4px `--accent-ring` halo, on a slightly rounded box. Never shown for mouse (`:focus-visible`). Skip-link is the first focusable element.
- **Active** — `translateY(1px)` press on buttons/tags; primary button darkens to `--accent-active`.
- **Disabled** — `aria-disabled="true"` (or `:disabled`): 0.45 opacity, `pointer-events:none`, `cursor:not-allowed`.
- Card click target is the stretched title link; nested tag links opt out by raising their `z-index`.

---

## 5. Responsive behaviour
- **≤640px — nav collapses.** Burger button (CSS-only `<input type=checkbox>` disclosure, no JS) toggles a blurred dropdown panel that slides down with `--ease-smooth`; burger morphs to an ✕. Active-link underline hidden in the stack. The checkbox is keyboard-focusable; the panel is progressive enhancement and degrades to always-visible links if CSS fails.
- **≤560px — mobile tightening.** Reduced top padding; card padding → `--space-5`; PostCard footer stacks; pagination stacks (reversed, full-width); footer stacks; blockquote padding reduced. Reading column already fits within the gutter.
- Fluid type means no separate desktop/mobile heading sizes are needed.

---

## 6. Accessibility
- WCAG **AA** contrast on every surface (secondary text lightened from the portfolio value specifically to pass on `--bg-card`).
- Semantic structure: one `<h1>` per page, ordered headings, `<nav aria-label>`, `<main id="main">`, `<time datetime>`, `<article>`, `<figure>/<figcaption>`.
- Visible focus ring on all interactive elements; **skip-to-content** link.
- `prefers-reduced-motion: reduce` removes transitions, transforms-in-motion, and smooth scroll.
- `aria-current="page"` marks the active nav item; decorative dots/arrows are not announced; copy button and burger have `aria-label`s.
- Color is never the sole signal (badges carry text; states carry motion + border, not just hue).

---

## 7. Performance
- Two stylesheets, zero framework, no runtime JS for layout. Only optional progressive-enhancement JS: copy-to-clipboard on code blocks (the markup works without it).
- Self-hosted, subset, `display:swap` fonts. The `@import` in `blog.css` is a convenience for opening the files raw — replace with `<link rel="preconnect">` + self-hosted `@font-face` in the build.
- Static `dist/` output; no client hydration. Glow is a single fixed pseudo-element, not an image.
