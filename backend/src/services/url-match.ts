import { EA_FORUM_HOST, EA_FORUM_BOTS_HOST, normalizeEAForumUrl } from './article-fetcher.js';
import { archivedOriginalUrl } from '../shared/format.js';

/**
 * URL identity for outside readers. Seen from an Obsidian vault, an item IS its URL (the
 * `source` property of a note), never its database id. These helpers give every caller
 * the same answer to "which stored item does this URL name?".
 */

/**
 * The human form of a stored URL: the EA Forum bot mirror rewritten back to the main host,
 * which is exactly what Copy content writes into `source` (`displayUrl` in
 * frontend/src/format.ts). A synthetic `wallacast://` address (an item without a URL,
 * minted for the Wallabag push) becomes null, and so does an empty value.
 */
export function humanUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  if (url.startsWith('wallacast://')) return null;
  return url.replace(EA_FORUM_BOTS_HOST, EA_FORUM_HOST);
}

/** Query parameters that only track where a click came from, never which page it is. */
const DROPPED_QUERY_PARAMS = new Set(['fbclid', 'ref']);

/**
 * Canonical comparison key for a URL: scheme dropped (http and https are the same page),
 * host lowercased with a leading `www.` removed, the EA Forum mirror rewritten to the human
 * host, trailing slash and fragment dropped, `utm_*`, `fbclid` and `ref` query parameters
 * removed. Other query parameters are kept in their original order, since for many sites
 * they select the page. A value that is not a URL at all is compared as trimmed lowercase.
 */
export function normalizeUrlForMatch(raw: string): string {
  const human = (humanUrl(raw) ?? raw).trim();
  // An archive.is-style mirror that names its original compares AS that original, so the
  // real article address and the mirror Wallacast read are the same item to a lookup.
  const resolved = archivedOriginalUrl(human) ?? human;
  let u: URL;
  try {
    u = new URL(resolved);
  } catch {
    return resolved.toLowerCase().replace(/\/+$/, '');
  }
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  const path = u.pathname.replace(/\/+$/, '');
  const params = new URLSearchParams();
  for (const [key, value] of u.searchParams) {
    const k = key.toLowerCase();
    if (k.startsWith('utm_') || DROPPED_QUERY_PARAMS.has(k)) continue;
    params.append(key, value);
  }
  const search = params.toString();
  return `${host}${path}${search ? '?' + search : ''}`;
}

export interface UrlCandidate {
  id: number;
  url: string | null;
  is_archived: boolean;
  created_at: Date | string;
}

/**
 * The library item a URL names. Exact matches win (the stored URL, its human form, or its
 * mirror form equals the query), then normalized matches. Several items can carry the same
 * URL (an article added twice): the one that is not archived wins, then the newest.
 */
export function pickItemByUrl<T extends UrlCandidate>(candidates: readonly T[], queryUrl: string): T | null {
  const q = queryUrl.trim();
  if (!q) return null;
  const qMirror = normalizeEAForumUrl(q);
  const withUrl = candidates.filter((c) => !!c.url && !c.url.startsWith('wallacast://'));

  const exact = withUrl.filter((c) => c.url === q || c.url === qMirror || humanUrl(c.url) === q);
  let pool = exact;
  if (pool.length === 0) {
    const nq = normalizeUrlForMatch(q);
    pool = withUrl.filter((c) => normalizeUrlForMatch(c.url!) === nq);
  }
  if (pool.length === 0) return null;

  return [...pool].sort((a, b) => {
    if (a.is_archived !== b.is_archived) return a.is_archived ? 1 : -1;
    return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
  })[0];
}

/**
 * The library item any of several URLs names, for a note that carries more than one address
 * for the same article (`source` plus `alt-source`: a crosspost's other home, or the archive
 * mirror behind a paywalled original).
 *
 * The given order is the preference: the first URL that finds anything wins, so a note's
 * `source` beats its `alt-source` even when only the second matches exactly. Within one URL
 * the usual rules apply (exact before normalised, then not-archived before newest).
 * Returns the item together with the URL that found it, so the caller can say which
 * address resolved.
 */
export function pickItemByUrls<T extends UrlCandidate>(
  candidates: readonly T[],
  queryUrls: readonly string[]
): { item: T; matchedUrl: string } | null {
  for (const url of queryUrls) {
    const item = pickItemByUrl(candidates, url);
    if (item) return { item, matchedUrl: url.trim() };
  }
  return null;
}
