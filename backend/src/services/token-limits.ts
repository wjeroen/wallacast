import type { PoolClient } from 'pg';
import { getPool, query } from '../database/db.js';
import { getUserSetting } from './ai-providers.js';

/**
 * Limits, usage and the change log for API tokens (table api_token_events, migration 031).
 *
 * Every token has four limits, set per token in Settings (a leaked token cannot change them,
 * token management only accepts a normal login):
 *   items_hour / items_2d       items added plus pages read without saving
 *   minutes_hour / minutes_2d   minutes of AI generation started for items the token added: an
 *                               article's audio counts its narration time, a transcript the
 *                               episode's length, a summary a tenth of its article's narration time
 * "Per hour" and "per 2 days" are rolling windows (the last 60 minutes, the last 48 hours).
 * The Reset button in Settings sets usage_reset_at, and nothing before it counts.
 *
 * Over an item limit the request is refused (429). Over a minute limit the item is still
 * added, only the generation that does not fit is skipped, and the reply says so. Either way
 * the token's limit_hit and limit_hit_at are set, which the app shows as a notice.
 *
 * Two more limits are fixed, not settings: one feed refresh per REFRESH_INTERVAL_MINUTES per
 * token, and CHANGES_PER_HOUR tag and star changes (undoable through the change log).
 *
 * Usage comes from the event log, so a deploy does not reset it and deleting an item does
 * not free what it used. A check and the event it records run under a row lock on the
 * token, so a burst of parallel requests cannot all slip under the limit together.
 */

export const LIMIT_KEYS = ['items_hour', 'items_2d', 'minutes_hour', 'minutes_2d'] as const;
export type LimitKey = typeof LIMIT_KEYS[number];
export type TokenLimits = Record<LimitKey, number>;

/** What a token gets until the user changes it. */
export const DEFAULT_LIMITS: TokenLimits = { items_hour: 20, items_2d: 100, minutes_hour: 120, minutes_2d: 600 };

/** The highest values Settings accepts. Items cost only server work and storage (an add
 *  takes about 2 to 5 seconds, articles average about 18 KB of stored HTML), minutes cost
 *  money on the user's own API keys. */
export const MAX_LIMITS: TokenLimits = { items_hour: 500, items_2d: 5000, minutes_hour: 2000, minutes_2d: 10000 };

export const REFRESH_INTERVAL_MINUTES = 15;
export const CHANGES_PER_HOUR = 500;

/** Narration speed used to turn text into minutes: about 150 words a minute at about six
 *  characters per word including the space. */
export const CHARS_PER_MINUTE = 900;
/** An episode whose feed gives no duration is counted as this long. */
export const UNKNOWN_EPISODE_MINUTES = 60;
/** Summary audio narrates a summary of a few short paragraphs. */
export const SUMMARY_AUDIO_MINUTES = 3;
/** A summary counts this share of its article's minutes. Summarizing reads the text once and
 *  writes a few paragraphs, far cheaper than narrating all of it: a summary of a 3,300-token
 *  article cost cents on gpt-5.4-mini (production log, 2026-10-09), while one 27,600-character
 *  article counted 31 minutes at the full share. */
export const SUMMARY_SHARE = 0.1;

export const CHANGE_KINDS = ['tag_add', 'star', 'unstar'] as const;
export type ChangeKind = typeof CHANGE_KINDS[number];

/** The four limits a token has, its stored values over the defaults. */
export function effectiveLimits(raw: unknown): TokenLimits {
  const stored = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const out = { ...DEFAULT_LIMITS };
  for (const key of LIMIT_KEYS) {
    const v = stored[key];
    if (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= MAX_LIMITS[key]) out[key] = v;
  }
  return out;
}

/** Validate limits sent from Settings. Missing keys keep their current value. */
export function validateLimits(raw: unknown, current: TokenLimits): { limits: TokenLimits } | { error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'limits must be an object' };
  const out = { ...current };
  for (const [key, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!(LIMIT_KEYS as readonly string[]).includes(key)) return { error: `Unknown limit: ${key}` };
    const k = key as LimitKey;
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > MAX_LIMITS[k]) {
      return { error: `${k} must be a whole number from 0 to ${MAX_LIMITS[k]}` };
    }
    out[k] = v;
  }
  return { limits: out };
}

// ---- generation for items a token adds -----------------------------------------------

export interface TokenGeneration {
  /** True: the app's own auto-generation settings decide. False: the four flags below. */
  follow: boolean;
  audio: boolean;
  summary: boolean;
  summary_audio: boolean;
  transcribe: boolean;
}

const GENERATION_FLAGS = ['audio', 'summary', 'summary_audio', 'transcribe'] as const;

export function parseGeneration(raw: unknown): TokenGeneration {
  const g = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return {
    follow: g.follow !== false,
    audio: g.audio === true,
    summary: g.summary === true,
    summary_audio: g.summary_audio === true,
    transcribe: g.transcribe === true,
  };
}

export function validateGeneration(raw: unknown, current: TokenGeneration): { generation: TokenGeneration } | { error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'generation must be an object' };
  const out = { ...current };
  for (const [key, v] of Object.entries(raw as Record<string, unknown>)) {
    if (key !== 'follow' && !(GENERATION_FLAGS as readonly string[]).includes(key)) return { error: `Unknown generation setting: ${key}` };
    if (typeof v !== 'boolean') return { error: `${key} must be true or false` };
    (out as any)[key] = v;
  }
  return { generation: out };
}

export type ResolvedGeneration = Omit<TokenGeneration, 'follow'>;

/** What actually runs for an item this token adds. Following the app reads the same four
 *  settings, with the same defaults, that POST /content and the summarizer read. */
export async function resolveGeneration(userId: number, gen: TokenGeneration): Promise<ResolvedGeneration> {
  if (!gen.follow) {
    return { audio: gen.audio, summary: gen.summary, summary_audio: gen.summary_audio, transcribe: gen.transcribe };
  }
  const [audio, summary, summaryAudio, transcribe] = await Promise.all([
    getUserSetting(userId, 'auto_generate_audio_for_articles'),
    getUserSetting(userId, 'auto_generate_summary'),
    getUserSetting(userId, 'auto_generate_summary_audio'),
    getUserSetting(userId, 'auto_transcribe_podcasts'),
  ]);
  return {
    audio: audio === 'true',
    summary: summary === 'true',
    summary_audio: summaryAudio === 'true',
    transcribe: transcribe === null || transcribe === 'true',
  };
}

// ---- how long a generation is, in minutes ----------------------------------------------

export function textMinutes(chars: number): number {
  return Math.max(1, Math.ceil(Math.max(0, chars) / CHARS_PER_MINUTE));
}

/** The minutes a summary of a text counts: SUMMARY_SHARE of its narration, at least 1. */
export function summaryMinutes(chars: number): number {
  return Math.max(1, Math.ceil((Math.max(0, chars) / CHARS_PER_MINUTE) * SUMMARY_SHARE));
}

/** The plain-text length of a comment tree (the stored JSON, or the array). Comment bodies
 *  are HTML, so tags are not counted. */
export function commentChars(raw: unknown): number {
  let list: unknown = raw;
  if (typeof raw === 'string') {
    try { list = JSON.parse(raw); } catch { return 0; }
  }
  if (!Array.isArray(list)) return 0;
  let total = 0;
  for (const c of list) {
    if (!c || typeof c !== 'object') continue;
    const body = (c as { content?: unknown }).content;
    if (typeof body === 'string') total += body.replace(/<[^>]*>/g, '').length;
    total += commentChars((c as { replies?: unknown }).replies);
  }
  return total;
}

export function episodeMinutes(durationSeconds: unknown): number {
  const s = Number(durationSeconds);
  return Number.isFinite(s) && s > 0 ? Math.ceil(s / 60) : UNKNOWN_EPISODE_MINUTES;
}

// ---- usage -------------------------------------------------------------------------------

export interface TokenUsage {
  items_hour: number;
  items_2d: number;
  minutes_hour: number;
  minutes_2d: number;
  changes_hour: number;
}

/** Usage of one token since its last reset, inside the 48-hour window. $1 is the token id. */
const USAGE_SQL = `
  SELECT
    COUNT(*) FILTER (WHERE e.kind IN ('add', 'read') AND e.created_at > NOW() - INTERVAL '1 hour')::int AS items_hour,
    COUNT(*) FILTER (WHERE e.kind IN ('add', 'read'))::int AS items_2d,
    COALESCE(SUM(e.minutes) FILTER (WHERE e.kind = 'generation' AND e.created_at > NOW() - INTERVAL '1 hour'), 0)::float AS minutes_hour,
    COALESCE(SUM(e.minutes) FILTER (WHERE e.kind = 'generation'), 0)::float AS minutes_2d,
    COUNT(*) FILTER (WHERE e.kind IN ('tag_add', 'star', 'unstar') AND e.created_at > NOW() - INTERVAL '1 hour')::int AS changes_hour
  FROM api_token_events e
  JOIN api_tokens t ON t.id = e.token_id
  WHERE e.token_id = $1
    AND e.created_at > NOW() - INTERVAL '48 hours'
    AND (t.usage_reset_at IS NULL OR e.created_at > t.usage_reset_at)`;

type Runner = { query: (text: string, params?: any[]) => Promise<{ rows: any[] }> };

async function usageWith(runner: Runner, tokenId: number): Promise<TokenUsage> {
  const r = await runner.query(USAGE_SQL, [tokenId]);
  const row = r.rows[0] || {};
  return {
    items_hour: row.items_hour ?? 0,
    items_2d: row.items_2d ?? 0,
    minutes_hour: Math.round((row.minutes_hour ?? 0) * 10) / 10,
    minutes_2d: Math.round((row.minutes_2d ?? 0) * 10) / 10,
    changes_hour: row.changes_hour ?? 0,
  };
}

export function getTokenUsage(tokenId: number): Promise<TokenUsage> {
  return usageWith({ query }, tokenId);
}

/** Runs fn inside a transaction that holds a row lock on the token, so checks and the
 *  events they record are serialised per token. */
async function withTokenLock<T>(tokenId: number, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT id FROM api_tokens WHERE id = $1 FOR UPDATE', [tokenId]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => { /* the connection is released below */ });
    throw error;
  } finally {
    client.release();
  }
}

// ---- checks --------------------------------------------------------------------------------

/** What a request carries about its token: set by requireAuth on req.apiToken. */
export interface TokenContext {
  id: number;
  userId: number;
  limits: unknown;
}

export type LimitResult =
  | { ok: true }
  | { ok: false; limit: LimitKey | 'changes_hour' | 'refresh'; max: number; used: number; message: string; retryAfterSeconds?: number };

const LIMIT_WORDS: Record<LimitKey, string> = {
  items_hour: 'items per hour',
  items_2d: 'items per 2 days',
  minutes_hour: 'generation minutes per hour',
  minutes_2d: 'generation minutes per 2 days',
};

function overLimit(key: LimitKey, max: number, used: number): LimitResult {
  return { ok: false, limit: key, max, used, message: `This token reached its limit of ${max} ${LIMIT_WORDS[key]}` };
}

/** Remember the last limit a token ran into, for the notice in the app. */
async function recordLimitHit(tokenId: number, message: string): Promise<void> {
  await query('UPDATE api_tokens SET limit_hit = $2, limit_hit_at = NOW() WHERE id = $1', [tokenId, message]).catch((err) => {
    console.error(`[ApiToken] could not record a limit hit for token ${tokenId}:`, err);
  });
}

/** Count one added item ('add') or one page read without saving ('read'), or refuse. */
export async function reserveItem(token: TokenContext, kind: 'add' | 'read', detail?: string): Promise<LimitResult> {
  const limits = effectiveLimits(token.limits);
  const result = await withTokenLock(token.id, async (client) => {
    const used = await usageWith(client, token.id);
    if (used.items_hour + 1 > limits.items_hour) return overLimit('items_hour', limits.items_hour, used.items_hour);
    if (used.items_2d + 1 > limits.items_2d) return overLimit('items_2d', limits.items_2d, used.items_2d);
    await client.query(
      'INSERT INTO api_token_events (token_id, user_id, kind, detail) VALUES ($1, $2, $3, $4)',
      [token.id, token.userId, kind, detail ? detail.slice(0, 40) : null]
    );
    return { ok: true } as LimitResult;
  });
  if (!result.ok) {
    console.log(`[ApiToken] token ${token.id} refused (${kind}): ${result.message}`);
    await recordLimitHit(token.id, result.message);
  }
  return result;
}

/** Count `minutes` of generation for an item, or refuse (the caller then skips it). */
export async function reserveMinutes(
  token: TokenContext,
  minutes: number,
  detail: 'audio' | 'summary' | 'summary_audio' | 'transcript',
  contentItemId: number
): Promise<LimitResult> {
  const limits = effectiveLimits(token.limits);
  const result = await withTokenLock(token.id, async (client) => {
    const used = await usageWith(client, token.id);
    if (used.minutes_hour + minutes > limits.minutes_hour) return overLimit('minutes_hour', limits.minutes_hour, used.minutes_hour);
    if (used.minutes_2d + minutes > limits.minutes_2d) return overLimit('minutes_2d', limits.minutes_2d, used.minutes_2d);
    await client.query(
      'INSERT INTO api_token_events (token_id, user_id, kind, content_item_id, minutes, detail) VALUES ($1, $2, $3, $4, $5, $6)',
      [token.id, token.userId, 'generation', contentItemId, minutes, detail]
    );
    return { ok: true } as LimitResult;
  });
  if (!result.ok) {
    console.log(`[ApiToken] token ${token.id} skipped ${detail} (${minutes} min) for item ${contentItemId}: ${result.message}`);
    await recordLimitHit(token.id, result.message);
  }
  return result;
}

/** One feed refresh per REFRESH_INTERVAL_MINUTES per token. Not a limit hit for the notice:
 *  a routine that asks twice is normal. */
export async function reserveRefresh(token: TokenContext): Promise<LimitResult> {
  return withTokenLock(token.id, async (client) => {
    const r = await client.query(
      `SELECT EXTRACT(EPOCH FROM (NOW() - MAX(created_at)))::int AS ago
         FROM api_token_events WHERE token_id = $1 AND kind = 'refresh'`,
      [token.id]
    );
    const ago = r.rows[0]?.ago;
    const interval = REFRESH_INTERVAL_MINUTES * 60;
    if (ago !== null && ago !== undefined && ago < interval) {
      return {
        ok: false,
        limit: 'refresh',
        max: 1,
        used: 1,
        message: `A token may start one feed refresh every ${REFRESH_INTERVAL_MINUTES} minutes`,
        retryAfterSeconds: interval - ago,
      } as LimitResult;
    }
    await client.query(
      'INSERT INTO api_token_events (token_id, user_id, kind) VALUES ($1, $2, $3)',
      [token.id, token.userId, 'refresh']
    );
    return { ok: true } as LimitResult;
  });
}

/** Room for `count` more tag or star changes this hour? The changes themselves are logged
 *  by logChanges once they are made, since only real changes count. */
export async function checkChanges(token: TokenContext, count: number): Promise<LimitResult> {
  const used = await getTokenUsage(token.id);
  if (used.changes_hour + count > CHANGES_PER_HOUR) {
    const result: LimitResult = {
      ok: false,
      limit: 'changes_hour',
      max: CHANGES_PER_HOUR,
      used: used.changes_hour,
      message: `This token reached its limit of ${CHANGES_PER_HOUR} tag and star changes per hour`,
    };
    await recordLimitHit(token.id, result.message);
    return result;
  }
  return { ok: true };
}

// ---- the change log ------------------------------------------------------------------------

export interface ChangeRecord {
  itemId: number;
  kind: ChangeKind;
  tag?: string;
}

export async function logChanges(token: TokenContext, changes: ChangeRecord[]): Promise<void> {
  if (changes.length === 0) return;
  await query(
    `INSERT INTO api_token_events (token_id, user_id, kind, content_item_id, tag)
     SELECT $1, $2, c.kind, c.item_id, c.tag
       FROM unnest($3::text[], $4::int[], $5::text[]) AS c(kind, item_id, tag)`,
    [token.id, token.userId, changes.map((c) => c.kind), changes.map((c) => c.itemId), changes.map((c) => c.tag ?? null)]
  );
}

export interface ChangeRow {
  id: number;
  kind: ChangeKind;
  tag: string | null;
  content_item_id: number | null;
  title: string | null;
  created_at: Date;
  undone_at: Date | null;
}

/** A token's tag and star changes, newest first. */
export async function listChanges(userId: number, tokenId: number, limit = 200): Promise<ChangeRow[]> {
  const r = await query(
    `SELECT e.id, e.kind, e.tag, e.content_item_id, c.title, e.created_at, e.undone_at
       FROM api_token_events e
       JOIN api_tokens t ON t.id = e.token_id AND t.user_id = $1
       LEFT JOIN content_items c ON c.id = e.content_item_id
      WHERE e.token_id = $2 AND e.kind IN ('tag_add', 'star', 'unstar')
      ORDER BY e.created_at DESC, e.id DESC
      LIMIT $3`,
    [userId, tokenId, Math.min(Math.max(1, limit), 1000)]
  );
  return r.rows;
}

/**
 * Undo a token's changes: the given event ids, or every change not yet undone. Newest first,
 * so an item starred and then unstarred by the token ends where it started. A tag the token
 * added is removed from the item, a star it set is taken off, an unstar is starred again.
 * Items deleted since are skipped. Each undone item is pushed to Wallabag again.
 */
export async function undoChanges(userId: number, tokenId: number, eventIds: number[] | 'all'): Promise<number> {
  const r = await query(
    `SELECT e.id, e.kind, e.tag, e.content_item_id
       FROM api_token_events e
       JOIN api_tokens t ON t.id = e.token_id AND t.user_id = $1
      WHERE e.token_id = $2 AND e.kind IN ('tag_add', 'star', 'unstar') AND e.undone_at IS NULL
        ${eventIds === 'all' ? '' : 'AND e.id = ANY($3::int[])'}
      ORDER BY e.created_at DESC, e.id DESC`,
    eventIds === 'all' ? [userId, tokenId] : [userId, tokenId, eventIds]
  );
  let undone = 0;
  for (const ev of r.rows) {
    if (ev.content_item_id) {
      if (ev.kind === 'tag_add' && ev.tag) {
        await query(
          `UPDATE content_items
              SET tags = array_remove(tags, $3), updated_at = NOW(), wallabag_needs_push = TRUE
            WHERE id = $1 AND user_id = $2 AND $3 = ANY(COALESCE(tags, '{}'))`,
          [ev.content_item_id, userId, ev.tag]
        );
      } else if (ev.kind === 'star' || ev.kind === 'unstar') {
        await query(
          `UPDATE content_items SET is_starred = $3, updated_at = NOW(), wallabag_needs_push = TRUE
            WHERE id = $1 AND user_id = $2 AND is_starred IS DISTINCT FROM $3`,
          [ev.content_item_id, userId, ev.kind === 'unstar']
        );
      }
    }
    await query('UPDATE api_token_events SET undone_at = NOW() WHERE id = $1', [ev.id]);
    undone++;
  }
  return undone;
}

/** Start counting usage from now. */
export async function resetTokenUsage(userId: number, tokenId: number): Promise<boolean> {
  const r = await query(
    'UPDATE api_tokens SET usage_reset_at = NOW(), limit_hit = NULL, limit_hit_at = NULL WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL',
    [tokenId, userId]
  );
  return (r.rowCount ?? 0) > 0;
}
