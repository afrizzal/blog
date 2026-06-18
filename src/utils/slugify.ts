// Turn a human label ("CRM & Revenue") into a URL-safe slug ("crm-revenue").
// Used for tag and category routes so labels can contain spaces/symbols.
export function slugify(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}
