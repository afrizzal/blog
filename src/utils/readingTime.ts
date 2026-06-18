// Dependency-free reading-time estimate from the raw markdown body.
// ~200 words per minute, minimum 1 minute.
export function readingTime(body: string | undefined): number {
  const words = (body ?? '').trim().split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(words / 200));
}
