import { visit, SKIP } from 'unist-util-visit';
import { h } from 'hastscript';

/**
 * Prose post-processing for Markdown-rendered articles:
 *   - wrap every <table> in `.table-wrap` so a wide table scrolls on its own
 *     instead of forcing the whole page to scroll;
 *   - append a hover-reveal "#" anchor link to each h2/h3 (the ids are added
 *     upstream by rehype-slug). Only h2/h3 get anchors, matching the design;
 *   - turn a paragraph that holds nothing but an image with a title,
 *     `![alt](src "caption")`, into <figure><img><figcaption>caption</figcaption>,
 *     so posts get captions while staying plain Markdown. The <img> node itself
 *     is moved, not rebuilt: Astro's own image pass runs after this plugin and
 *     still finds it.
 */
export default function rehypeProse() {
  return (tree) => {
    visit(tree, 'element', (node, index, parent) => {
      if (parent === null || index === null) return;

      if (node.tagName === 'p') {
        const kids = node.children.filter((c) => !(c.type === 'text' && !c.value.trim()));
        const img = kids.length === 1 && kids[0].type === 'element' && kids[0].tagName === 'img' ? kids[0] : null;
        const caption = img?.properties?.title;
        if (img && typeof caption === 'string' && caption.trim()) {
          // the caption is shown once, as text — not again as a hover tooltip
          delete img.properties.title;
          parent.children[index] = h('figure', [img, h('figcaption', caption.trim())]);
          return [SKIP, index + 1];
        }
      }

      if (node.tagName === 'table') {
        parent.children[index] = h('div', { class: 'table-wrap' }, [node]);
        // Skip the wrapper we just inserted; continue after it.
        return [SKIP, index + 1];
      }

      if (node.tagName === 'h2' || node.tagName === 'h3') {
        const id = node.properties?.id;
        const alreadyAnchored = node.children.some(
          (c) =>
            c.type === 'element' &&
            [].concat(c.properties?.className ?? []).includes('anchor'),
        );
        if (id && !alreadyAnchored) {
          node.children.push(
            h('a', { class: 'anchor', href: `#${id}`, ariaLabel: 'Link to this section' }, '#'),
          );
        }
      }
    });
  };
}
