import { glob } from 'astro/loaders';
import { defineCollection, z } from 'astro:content';

// Astro 5 Content Layer API. Posts live as Markdown/MDX files in
// src/content/blog/. Files whose name starts with "_" are ignored, so you can
// keep scratch drafts around without publishing them.
const blog = defineCollection({
  loader: glob({ pattern: '**/[^_]*.{md,mdx}', base: './src/content/blog' }),
  schema: ({ image }) =>
    z.object({
      title: z.string(),
      description: z.string(),
      // One primary category per post (required). Tags are secondary/cross-cutting.
      category: z.string(),
      pubDate: z.coerce.date(),
      updatedDate: z.coerce.date().optional(),
      tags: z.array(z.string()).default([]),
      heroImage: image().optional(),
      // draft: true hides the post in production builds (still visible in `dev`).
      draft: z.boolean().default(false),
    }),
});

export const collections = { blog };
