import { getCollection } from 'astro:content';

// Published posts, newest first. Drafts (draft: true) are hidden in production
// builds but remain visible while running `astro dev`.
export async function getPublishedPosts() {
  const posts = await getCollection('blog', ({ data }) =>
    import.meta.env.PROD ? !data.draft : true,
  );
  return posts.sort((a, b) => b.data.pubDate.valueOf() - a.data.pubDate.valueOf());
}
