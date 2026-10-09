// What a slow article fetch is doing, for the Add tab to show while it waits. POST /api/content
// stores each step the fetcher reports (FetchProgress in article-fetcher.ts) under the id the
// app sent as `progress_id`, and the app asks for it every second and a half through
// GET /api/content/fetch-progress/:id until its save answers. Kept in memory, which fits the
// single backend instance. An entry goes when its fetch ends, or after ten minutes.

const entries = new Map<string, { userId: number; text: string; at: number }>();
const MAX_AGE_MS = 10 * 60 * 1000;

/** An id the app may send: a UUID or a similar token of letters, digits and hyphens. */
export function isProgressId(id: unknown): id is string {
  return typeof id === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(id);
}

export function setFetchProgress(id: string, userId: number, text: string): void {
  const now = Date.now();
  for (const [key, entry] of entries) {
    if (now - entry.at > MAX_AGE_MS) entries.delete(key);
  }
  entries.set(id, { userId, text, at: now });
}

/** The latest step of a fetch, or null when there is none (yet), or it belongs to someone else. */
export function getFetchProgress(id: string, userId: number): string | null {
  const entry = entries.get(id);
  return entry && entry.userId === userId ? entry.text : null;
}

export function clearFetchProgress(id: string): void {
  entries.delete(id);
}
