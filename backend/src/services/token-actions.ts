import { query } from '../database/db.js';
import { normalizeTagList, findReservedTags } from './tags.js';
import { findItem } from './url-match.js';
import { normalizeEAForumUrl } from './article-fetcher.js';
import {
  reserveItem,
  checkChanges,
  logChanges,
  type LimitResult,
  type ChangeRecord,
  type TokenContext,
} from './token-limits.js';
import type { TokenPermission } from './api-tokens.js';

/**
 * What an API token may change, beyond reading (see TOKEN_ROUTES in services/api-tokens.ts):
 * adding an item (POST /content), and tagging or starring items (POST /content/bulk). The
 * routes call these helpers for a token and keep their own code for a normal session.
 */

export interface TokenRequestContext extends TokenContext {
  permissions: TokenPermission[];
}

export type Refusal = { ok: false; status: number; error: string; extra?: Record<string, unknown> };

function refuse(status: number, error: string, extra?: Record<string, unknown>): Refusal {
  return { ok: false, status, error, ...(extra ? { extra } : {}) };
}

/** A limit refusal as a 429, with the numbers a caller needs to wait or report. */
export function limitRefusal(result: Extract<LimitResult, { ok: false }>): Refusal {
  return refuse(429, result.message, {
    limit: result.limit,
    max: result.max,
    used: result.used,
    ...(result.retryAfterSeconds !== undefined ? { retry_after_seconds: result.retryAfterSeconds } : {}),
  });
}

/** The longest description a Feed tab card carries (FEED_LIST_DESCRIPTION_CHARS in
 *  podcast-service.ts), which is what the app sends when it adds a feed article. */
const FEED_ARTICLE_DESCRIPTION_CHARS = 2_000;

export interface FeedItemRow {
  id: number;
  item_type: 'podcast_episode' | 'article';
  title: string | null;
  description: string | null;
  url: string | null;
  audio_url: string | null;
  published_at: Date | null;
  duration: number | null;
  preview_picture: string | null;
  author: string | null;
  podcast_id: number;
  show_name: string | null;
  show_author: string | null;
  is_subscribed: boolean | null;
}

/** One cached feed item from the user's own feeds, or null. */
export async function lookupFeedItem(userId: number, feedItemId: number): Promise<FeedItemRow | null> {
  const r = await query(
    `SELECT fi.id, fi.item_type, fi.title, LEFT(fi.description, ${FEED_ARTICLE_DESCRIPTION_CHARS}) AS description,
            fi.url, fi.audio_url, fi.published_at, fi.duration, fi.preview_picture, fi.author,
            p.id AS podcast_id, p.title AS show_name, p.author AS show_author, p.is_subscribed
       FROM feed_items fi JOIN podcasts p ON p.id = fi.feed_id
      WHERE fi.id = $1 AND p.user_id = $2`,
    [feedItemId, userId]
  );
  return r.rows[0] ?? null;
}

export function parsePositiveInt(raw: unknown): number | null {
  const n = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw;
  return typeof n === 'number' && Number.isInteger(n) && n > 0 ? n : null;
}

/** A public http(s) address, or null. (The fetcher's SSRF guard checks the host itself.) */
export function parseHttpUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try {
    const u = new URL(raw.trim());
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : null;
  } catch {
    return null;
  }
}

/** Tags a token sends must already exist in the user's library: normalized like every other
 *  tag, reserved names refused, at most 20. */
export async function existingTagsOnly(userId: number, raw: unknown): Promise<{ tags: string[] } | { error: string }> {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 20 || !raw.every((t) => typeof t === 'string')) {
    return { error: 'tags must be a non-empty list of strings (max 20)' };
  }
  const reserved = findReservedTags(raw);
  if (reserved.length > 0) {
    return { error: `Reserved tag(s): ${reserved.join(', ')}. Type tags are set automatically and nosync is managed in Wallabag.` };
  }
  const tags = normalizeTagList(raw);
  if (tags.length === 0) return { error: 'No valid tags given' };
  const r = await query(
    `SELECT DISTINCT t FROM content_items, unnest(tags) AS t WHERE user_id = $1 AND t = ANY($2::text[])`,
    [userId, tags]
  );
  const known = new Set(r.rows.map((row: any) => row.t));
  const unknown = tags.filter((t) => !known.has(t));
  if (unknown.length > 0) {
    return { error: `Unknown tag(s): ${unknown.join(', ')}. An API token may only use tags that already exist in your library.` };
  }
  return { tags };
}

/** The library item that already has this address, if any. */
async function existingItemId(userId: number, urls: string[], audioUrls: string[]): Promise<number | null> {
  const candidates = await query(
    'SELECT id, url, audio_url, title, is_archived, created_at FROM content_items WHERE user_id = $1',
    [userId]
  );
  const match = findItem(candidates.rows, { urls, audioUrls, titles: [] });
  return match ? match.item.id : null;
}

const TOKEN_ADD_KEYS = ['url', 'feed_item_id', 'tags'];

/**
 * Turn what a token sends to POST /content into the body the app itself would send, or a
 * refusal. A token sends `{ url }` (needs add_any) or `{ feed_item_id }` (add_any or
 * add_feed), plus optional `tags` (needs tag, existing tags only). Nothing else: no content,
 * no comments, no summary, no type. A feed item is rebuilt from the user's own cached feed,
 * the same fields the Feed tab's plus button sends. An address already in the library is a
 * 409 with its id. Only then does the add count against the token's item limits.
 */
export async function shapeTokenAdd(
  token: TokenRequestContext,
  raw: unknown
): Promise<{ ok: true; body: Record<string, unknown>; tags: string[] } | Refusal> {
  const body = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const extra = Object.keys(body).filter((k) => !TOKEN_ADD_KEYS.includes(k));
  if (extra.length > 0) {
    return refuse(400, `An API token may send only url, feed_item_id and tags (not: ${extra.join(', ')})`);
  }
  const hasUrl = body.url !== undefined && body.url !== null && body.url !== '';
  const hasFeedItem = body.feed_item_id !== undefined && body.feed_item_id !== null && body.feed_item_id !== '';
  if (hasUrl === hasFeedItem) {
    return refuse(400, 'Send either url or feed_item_id');
  }

  let tags: string[] = [];
  if (body.tags !== undefined) {
    if (!token.permissions.includes('tag')) {
      return refuse(403, 'This token needs the tag permission to add tags');
    }
    const checked = await existingTagsOnly(token.userId, body.tags);
    if ('error' in checked) return refuse(400, checked.error);
    tags = checked.tags;
  }

  let shaped: Record<string, unknown>;
  if (hasUrl) {
    if (!token.permissions.includes('add_any')) {
      return refuse(403, 'This token may only add items from your feed. Send a feed_item_id.');
    }
    const url = parseHttpUrl(body.url);
    if (!url) return refuse(400, 'url must be an http or https address');
    const existing = await existingItemId(token.userId, [url, normalizeEAForumUrl(url)], []);
    if (existing) return refuse(409, 'This article is already in your library', { id: existing });
    shaped = { type: 'article', url };
  } else {
    const id = parsePositiveInt(body.feed_item_id);
    if (!id) return refuse(400, 'feed_item_id must be a positive whole number');
    const item = await lookupFeedItem(token.userId, id);
    if (!item) return refuse(404, 'No item in your feeds has this feed_item_id');
    const podcastId = item.is_subscribed === false ? undefined : item.podcast_id;
    if (item.item_type === 'article') {
      if (!item.url) return refuse(400, 'This feed item has no address to fetch');
      const existing = await existingItemId(token.userId, [item.url, normalizeEAForumUrl(item.url)], []);
      if (existing) return refuse(409, 'This article is already in your library', { id: existing });
      shaped = {
        type: 'article',
        title: item.title ?? undefined,
        description: item.description ?? undefined,
        url: item.url,
        podcast_id: podcastId,
        podcast_show_name: item.show_name ?? undefined,
        published_at: item.published_at ?? undefined,
        preview_picture: item.preview_picture ?? undefined,
      };
    } else {
      if (!item.audio_url) return refuse(400, 'This feed item has no audio file');
      const existing = await existingItemId(token.userId, [], [item.audio_url]);
      if (existing) return refuse(409, 'This episode is already in your library', { id: existing });
      shaped = {
        type: 'podcast_episode',
        title: item.title ?? undefined,
        description: item.description ?? undefined,
        feed_item_id: item.id,
        audio_url: item.audio_url,
        podcast_id: podcastId,
        podcast_show_name: item.show_name ?? undefined,
        published_at: item.published_at ?? undefined,
        duration: item.duration ?? undefined,
        preview_picture: item.preview_picture ?? undefined,
        author: item.author || item.show_author || undefined,
      };
    }
  }

  if (tags.length > 0) {
    const room = await checkChanges(token, tags.length);
    if (!room.ok) return limitRefusal(room);
    shaped.tags = tags;
  }
  const reserved = await reserveItem(token, 'add', hasUrl ? 'url' : 'feed_item');
  if (!reserved.ok) return limitRefusal(reserved);
  return { ok: true, body: shaped, tags };
}

/**
 * POST /content/bulk for a token: add_tags (tag permission, existing tags only), star and
 * unstar (star permission). Every real change is logged, so Settings can undo it, and only
 * real changes count against the hourly change limit.
 */
export async function tokenBulk(token: TokenRequestContext, raw: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const body = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const { action, ids } = body;
  if (action === 'add_tags') {
    if (!token.permissions.includes('tag')) return { status: 403, json: { error: 'This token needs the tag permission' } };
  } else if (action === 'star' || action === 'unstar') {
    if (!token.permissions.includes('star')) return { status: 403, json: { error: 'This token needs the star permission' } };
  } else {
    return { status: 403, json: { error: 'An API token may only use the add_tags, star and unstar actions' } };
  }
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > 500 || !ids.every((n) => Number.isInteger(n))) {
    return { status: 400, json: { error: 'ids must be a non-empty array of integers (max 500)' } };
  }

  let changes: ChangeRecord[] = [];
  if (action === 'add_tags') {
    const checked = await existingTagsOnly(token.userId, body.tags);
    if ('error' in checked) return { status: 400, json: { error: checked.error } };
    const before = await query(
      'SELECT id, tags FROM content_items WHERE user_id = $1 AND id = ANY($2::int[])',
      [token.userId, ids]
    );
    for (const row of before.rows) {
      const has = new Set<string>(row.tags || []);
      for (const tag of checked.tags) if (!has.has(tag)) changes.push({ itemId: row.id, kind: 'tag_add', tag });
    }
    if (changes.length > 0) {
      const room = await checkChanges(token, changes.length);
      if (!room.ok) {
        const r = limitRefusal(room);
        return { status: r.status, json: { error: r.error, ...r.extra } };
      }
      const changedIds = Array.from(new Set(changes.map((c) => c.itemId)));
      await query(
        `UPDATE content_items
            SET tags = ARRAY(SELECT DISTINCT x FROM unnest(COALESCE(tags, '{}') || $3::text[]) x ORDER BY x),
                updated_at = NOW(), wallabag_needs_push = TRUE
          WHERE user_id = $1 AND id = ANY($2::int[])`,
        [token.userId, changedIds, checked.tags]
      );
    }
  } else {
    const target = action === 'star';
    const before = await query(
      'SELECT id, is_starred FROM content_items WHERE user_id = $1 AND id = ANY($2::int[])',
      [token.userId, ids]
    );
    changes = before.rows
      .filter((row: any) => Boolean(row.is_starred) !== target)
      .map((row: any) => ({ itemId: row.id, kind: action as 'star' | 'unstar' }));
    if (changes.length > 0) {
      const room = await checkChanges(token, changes.length);
      if (!room.ok) {
        const r = limitRefusal(room);
        return { status: r.status, json: { error: r.error, ...r.extra } };
      }
      await query(
        `UPDATE content_items SET is_starred = $3, updated_at = NOW(), wallabag_needs_push = TRUE
          WHERE user_id = $1 AND id = ANY($2::int[])`,
        [token.userId, changes.map((c) => c.itemId), target]
      );
    }
  }
  await logChanges(token, changes);
  const affected = new Set(changes.map((c) => c.itemId)).size;
  console.log(`[bulk] token=${token.id} user=${token.userId} action=${String(action)} ids=${ids.length} affected=${affected} changes=${changes.length}`);
  return { status: 200, json: { affected, changes: changes.length } };
}
