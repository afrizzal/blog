import { getCollection } from 'astro:content';
import { OGImageRoute } from 'astro-og-canvas';
import { SITE_TITLE } from '../../consts';

// Build-time OG cards (1200×630 PNG) for social unfurls. The pages themselves
// stay imageless by design (see BRAND.md) — these cards are metadata only.
// Drafts are excluded so unpublished titles never leak into dist/.
const posts = await getCollection('blog', ({ data }) => !data.draft);

const pages: Record<string, { title: string; description: string }> = Object.fromEntries(
  posts.map((post) => [
    `blog/${post.id}`,
    { title: post.data.title, description: `${post.data.category}  ·  blog.afrizzal.pro` },
  ]),
);

// Fallback card for every non-post page (home, tags, categories, 404).
pages.site = {
  title: SITE_TITLE,
  description: 'Engineering notes on systems, revenue plumbing, and AI automation',
};

export const { getStaticPaths, GET } = await OGImageRoute({
  param: 'route',
  pages,
  getImageOptions: (_path, page) => ({
    title: page.title,
    description: page.description,
    padding: 72,
    // --bg-main (#060b17) fading into a slightly lifted navy.
    bgGradient: [
      [6, 11, 23],
      [13, 22, 41],
    ],
    // --accent (#3b82f6) as a bottom rule — the one brand mark on the card.
    border: { color: [59, 130, 246], width: 10, side: 'block-end' },
    font: {
      title: { size: 60, lineHeight: 1.25, weight: 'Bold', color: [237, 242, 250] },
      description: { size: 30, lineHeight: 1.4, color: [148, 163, 184] },
    },
  }),
});
