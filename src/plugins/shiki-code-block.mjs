import { h } from 'hastscript';

/**
 * Shiki transformer — wraps each highlighted <pre> in the design's `.code-block`
 * frame: a header bar (traffic-light dots + uppercase language label) and a
 * hover-reveal copy button. It also strips Shiki's inline background so the
 * `.code-block` surface (--bg-card) shows through uniformly.
 *
 * Running as a Shiki transformer (rather than a rehype plugin) means it executes
 * inside the highlighter: the language is always known and we never have to
 * guess the ordering relative to Astro's built-in syntax highlighting.
 */
export function codeBlockTransformer() {
  return {
    name: 'afrizzal:code-block',

    // Drop the inline `background-color` Shiki sets on <pre>.
    pre(node) {
      const style = node.properties?.style;
      if (typeof style === 'string') {
        const stripped = style.replace(/background(-color)?\s*:[^;]*;?/gi, '').trim();
        node.properties.style = stripped || undefined;
      }
    },

    // Wrap the <pre> in the bordered code-block chrome.
    root(node) {
      const pre = node.children.find((c) => c.type === 'element' && c.tagName === 'pre');
      if (!pre) return;

      const raw = this.options?.lang;
      const lang = raw && raw !== 'text' && raw !== 'plaintext' ? raw : 'code';

      node.children = [
        h('div', { class: 'code-block' }, [
          h('div', { class: 'code-block__bar' }, [
            h('div', { class: 'code-block__dots' }, [h('i'), h('i'), h('i')]),
            h('span', { class: 'code-block__lang' }, lang),
          ]),
          h(
            'button',
            { class: 'code-block__copy', type: 'button', ariaLabel: 'Copy code' },
            'copy',
          ),
          pre,
        ]),
      ];
    },
  };
}
