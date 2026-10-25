// @ts-check
import { defineConfig } from 'astro/config';
import { unified } from '@astrojs/markdown-remark';
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
  // Keep the existing inline whitespace behavior when upgrading from Astro 6.
  compressHTML: true,
  // Consistent trailing slashes so static Apache hosting never has to redirect
  // (all internal links + pagination URLs match the /folder/index.html layout).
  trailingSlash: 'always',
  integrations: [mdx(), sitemap()],
  vite: {
    // Prebundle CommonJS parsers used by content sync for Vite's module runner.
    environments: {
      astro: { optimizeDeps: { include: ['yaml', 'picomatch'] } },
    },
  },
  markdown: {
    // Captions, table wrappers and code-block controls use unified plugins.
    processor: unified({
      // Keep headings, captioned figures and scrollable tables on the same pipeline.
      rehypePlugins: [rehypeSlug, rehypeProse],
    }),
    shikiConfig: {
      // GitHub-flavoured dark theme to match the portfolio palette.
      theme: 'github-dark',
      // Long lines scroll horizontally inside the code block instead of
      // wrapping — matches the design's bordered code-block treatment.
      wrap: false,
      // Wrap each block in the .code-block chrome (bar + copy button).
      transformers: [codeBlockTransformer()],
    },
  },
});
