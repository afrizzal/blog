import { visit, SKIP } from 'unist-util-visit';
import { h } from 'hastscript';

/**
 * Prose post-processing for Markdown-rendered articles:
 *   - wrap every <table> in `.table-wrap` so a wide table scrolls on its own
 *     instead of forcing the whole page to scroll;
 *   - append a hover-reveal "#" anchor link to each h2/h3 (the ids are added
 *     upstream by rehype-slug). Only h2/h3 get anchors, matching the design.
 */
export default function rehypeProse() {
  return (tree) => {
    visit(tree, 'element', (node, index, parent) => {
      if (parent === null || index === null) return;

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
