// @ts-check
import { defineConfig } from 'astro/config';
import mdx from '@astrojs/mdx';
import sitemap from '@astrojs/sitemap';

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
    // GitHub-flavoured dark theme to match the portfolio palette.
    shikiConfig: {
      theme: 'github-dark',
      wrap: true,
    },
  },
});
