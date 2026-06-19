// @ts-check
import { defineConfig } from 'astro/config';
import mdx from '@astrojs/mdx';
import sitemap from '@astrojs/sitemap';
import rehypeSlug from 'rehype-slug';
import rehypeProse from './src/plugins/rehype-prose.mjs';
import { codeBlockTransformer } from './src/plugins/shiki-code-block.mjs';

// https://astro.build/config
export default defineConfig({
  // Used for canonical URLs, Open Graph, RSS and sitemap. Change if the
  // production domain ever changes.
  site: 'https://blog.afrizzal.pro',
  output: 'static',
  // Consistent trailing slashes so static Apache hosting never has to redirect
  // (all internal links + pagination URLs match the /folder/index.html layout).
  trailingSlash: 'always',
  integrations: [mdx(), sitemap()],
  markdown: {
    shikiConfig: {
      // GitHub-flavoured dark theme to match the portfolio palette.
      theme: 'github-dark',
      // Long lines scroll horizontally inside the code block instead of
      // wrapping — matches the design's bordered code-block treatment.
      wrap: false,
      // Wrap each block in the .code-block chrome (bar + copy button).
      transformers: [codeBlockTransformer()],
    },
    // rehype-slug adds heading ids; rehype-prose appends h2/h3 anchors and
    // wraps tables in .table-wrap for horizontal scroll.
    rehypePlugins: [rehypeSlug, rehypeProse],
  },
});
