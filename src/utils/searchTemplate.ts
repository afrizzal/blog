// Pagefind result template shared by /search/ and the nav search dialog.
// Kept as a string because Astro would otherwise read the {{ }} placeholders
// as expressions; render it with <Fragment set:html>. meta.category and
// meta.date come from data-pagefind-meta in BlogPost.astro.
export const SEARCH_RESULT_TEMPLATE = `<script type="text/pagefind-template">
  <li class="search-result">
    <p class="search-result__meta">{{ meta.category }}{{#if meta.date}} · {{ meta.date }}{{/if}}</p>
    <a class="search-result__title" href="{{ meta.url | default(url) | safeUrl }}">{{ meta.title }}</a>
    {{#if excerpt}}<p class="search-result__excerpt">{{+ excerpt +}}</p>{{/if}}
    {{#if sub_results}}
    <ul class="search-result__sections">
      {{#each sub_results as sub}}
      <li><a href="{{ sub.url | safeUrl }}">{{ sub.title }}</a></li>
      {{/each}}
    </ul>
    {{/if}}
  </li>
</script>`;
