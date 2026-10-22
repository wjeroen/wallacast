import crypto from 'crypto';
import { query } from '../database/db.js';
import { hashRefreshToken } from './auth.js';
import {
  effectiveLimits,
  parseGeneration,
  validateLimits,
  validateGeneration,
  type TokenLimits,
  type TokenGeneration,
} from './token-limits.js';

/**
 * API tokens (table `api_tokens`, migrations 029 and 031).
 *
 * A token is the long-lived credential an outside tool uses: the Obsidian "Wallacast
 * overview", "Wallacast import" and "Wallacast import checked" commands, and a cloud Claude
 * Code routine. Access tokens live 15 minutes and refresh tokens rotate, so neither fits a
 * script. A token can sit as plain text in a synced vault, so it can do only what its
 * permissions allow: `TOKEN_ROUTES` below is the complete list of what any token may call,
 * and `requireAuth` answers 403 for everything else, every GET included. What a token adds
 * and generates is limited per token (services/token-limits.ts).
 *
 * Format: `wcr_` + 40 hex characters (160 random bits). Only the SHA-256 hash is stored,
 * exactly like refresh tokens, so a database leak does not leak usable tokens.
 */

export const API_TOKEN_PREFIX = 'wcr_';

/** A cap on live tokens per user, so a script gone wrong cannot fill the table. */
export const MAX_ACTIVE_TOKENS_PER_USER = 20;

/** last_used_at is written at most this often per token. A busy overview refresh must not
 *  turn every request into an UPDATE. */
const LAST_USED_WRITE_INTERVAL_MS = 60_000;

/**
 * What a token may do. A new token gets read_library only, which is what every token could
 * do before permissions existed.
 *   read_library  the library index, an item's Copy content Markdown, summaries, the tag list
 *   feed          the subscriptions, the cached feed items, start and watch a feed refresh
 *   add_any       add an article by URL or a feed item, read a page without saving it
 *   add_feed      the same, but only items from the user's own feeds, never a free URL
 *   tag           add tags that already exist in the library to items (logged, undoable)
 *   star          star and unstar items (logged, undoable)
 * add_any and add_feed exclude each other.
 */
export const TOKEN_PERMISSIONS = ['read_library', 'feed', 'add_any', 'add_feed', 'tag', 'star'] as const;
export type TokenPermission = typeof TOKEN_PERMISSIONS[number];
export const DEFAULT_PERMISSIONS: TokenPermission[] = ['read_library'];

export interface ApiTokenSummary {
  id: number;
  name: string;
  created_at: Date;
  last_used_at: Date | null;
  permissions: TokenPermission[];
  limits: TokenLimits;
  generation: TokenGeneration;
  usage_reset_at: Date | null;
  limit_hit: string | null;
  limit_hit_at: Date | null;
}

/** What `requireAuth` learns about a valid token. */
export interface ApiTokenAuth {
  tokenId: number;
  userId: number;
  username: string;
  name: string;
  permissions: TokenPermission[];
  limits: TokenLimits;
  generation: TokenGeneration;
}

export class ApiTokenLimitError extends Error {
  constructor() {
    super(`You already have ${MAX_ACTIVE_TOKENS_PER_USER} active tokens. Revoke one first.`);
    this.name = 'ApiTokenLimitError';
  }
}

/** True when a Bearer value is an API token rather than a JWT. */
export function isApiToken(bearer: string): boolean {
  return bearer.startsWith(API_TOKEN_PREFIX);
}

export function generateApiToken(): string {
  return API_TOKEN_PREFIX + crypto.randomBytes(20).toString('hex');
}

/** Same hashing as refresh tokens: SHA-256, hex. */
export const hashApiToken = hashRefreshToken;

/** The stored permissions, known names only, in the canonical order. */
export function parsePermissions(raw: unknown): TokenPermission[] {
  const list = Array.isArray(raw) ? raw : [];
  return TOKEN_PERMISSIONS.filter((p) => list.includes(p));
}

/** Validate a permission list sent from Settings. */
export function validatePermissions(raw: unknown): { permissions: TokenPermission[] } | { error: string } {
  if (!Array.isArray(raw)) return { error: 'permissions must be a list' };
  for (const p of raw) {
    if (typeof p !== 'string' || !(TOKEN_PERMISSIONS as readonly string[]).includes(p)) {
      return { error: `Unknown permission: ${String(p)}` };
    }
  }
  const permissions = parsePermissions(raw);
  if (permissions.includes('add_any') && permissions.includes('add_feed')) {
    return { error: 'Choose one of add_any and add_feed' };
  }
  return { permissions };
}

/** Create a token for a user. Returns the RAW token, the only time it is ever available. */
export async function createApiToken(userId: number, name: string): Promise<{ id: number; name: string; token: string }> {
  const active = await query(
    'SELECT COUNT(*)::int AS n FROM api_tokens WHERE user_id = $1 AND revoked_at IS NULL',
    [userId]
  );
  if ((active.rows[0]?.n ?? 0) >= MAX_ACTIVE_TOKENS_PER_USER) {
    throw new ApiTokenLimitError();
  }
  const token = generateApiToken();
  const r = await query(
    'INSERT INTO api_tokens (user_id, name, token_hash, scope) VALUES ($1, $2, $3, $4) RETURNING id, name',
    [userId, name, hashApiToken(token), 'read']
  );
  return { id: r.rows[0].id, name: r.rows[0].name, token };
}

function summaryFromRow(row: any): ApiTokenSummary {
  return {
    id: row.id,
    name: row.name,
    created_at: row.created_at,
    last_used_at: row.last_used_at,
    permissions: parsePermissions(row.permissions),
    limits: effectiveLimits(row.limits),
    generation: parseGeneration(row.generation),
    usage_reset_at: row.usage_reset_at,
    limit_hit: row.limit_hit,
    limit_hit_at: row.limit_hit_at,
  };
}

const SUMMARY_COLUMNS =
  'id, name, created_at, last_used_at, permissions, limits, generation, usage_reset_at, limit_hit, limit_hit_at';

/** The user's live tokens, newest first. Never the hash. */
export async function listApiTokens(userId: number): Promise<ApiTokenSummary[]> {
  const r = await query(
    `SELECT ${SUMMARY_COLUMNS} FROM api_tokens WHERE user_id = $1 AND revoked_at IS NULL ORDER BY created_at DESC`,
    [userId]
  );
  return r.rows.map(summaryFromRow);
}

/** One live token of the user, or null. */
export async function getApiToken(userId: number, tokenId: number): Promise<ApiTokenSummary | null> {
  const r = await query(
    `SELECT ${SUMMARY_COLUMNS} FROM api_tokens WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL`,
    [tokenId, userId]
  );
  return r.rows[0] ? summaryFromRow(r.rows[0]) : null;
}

/** Change a token's permissions, limits or generation choice. Each part is optional and
 *  validated on its own. Changing a limit clears the last limit hit, which named the old
 *  value. Returns the updated token, null when it is not the user's, or an error message. */
export async function updateApiToken(
  userId: number,
  tokenId: number,
  patch: { permissions?: unknown; limits?: unknown; generation?: unknown }
): Promise<ApiTokenSummary | null | { error: string }> {
  const current = await getApiToken(userId, tokenId);
  if (!current) return null;
  let permissions = current.permissions;
  let limits = current.limits;
  let generation = current.generation;
  if (patch.permissions !== undefined) {
    const v = validatePermissions(patch.permissions);
    if ('error' in v) return v;
    permissions = v.permissions;
  }
  if (patch.limits !== undefined) {
    const v = validateLimits(patch.limits, current.limits);
    if ('error' in v) return v;
    limits = v.limits;
  }
  if (patch.generation !== undefined) {
    const v = validateGeneration(patch.generation, current.generation);
    if ('error' in v) return v;
    generation = v.generation;
  }
  const limitsChanged = JSON.stringify(limits) !== JSON.stringify(current.limits);
  await query(
    `UPDATE api_tokens
        SET permissions = $3, limits = $4, generation = $5,
            limit_hit = CASE WHEN $6 THEN NULL ELSE limit_hit END,
            limit_hit_at = CASE WHEN $6 THEN NULL ELSE limit_hit_at END
      WHERE id = $1 AND user_id = $2`,
    [tokenId, userId, permissions, JSON.stringify(limits), JSON.stringify(generation), limitsChanged]
  );
  return getApiToken(userId, tokenId);
}

/** Revoke one of the user's tokens. False when it does not exist, is not theirs, or is
 *  already revoked. */
export async function revokeApiToken(userId: number, tokenId: number): Promise<boolean> {
  const r = await query(
    'UPDATE api_tokens SET revoked_at = NOW() WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL',
    [tokenId, userId]
  );
  return (r.rowCount ?? 0) > 0;
}

/** Look a raw token up by its hash. Null for unknown, revoked, or a disabled account. Read
 *  on every request, so a revoke or a permission change applies to the very next one. */
export async function authenticateApiToken(bearer: string): Promise<ApiTokenAuth | null> {
  const r = await query(
    `SELECT t.id, t.user_id, t.name, t.permissions, t.limits, t.generation, u.username, u.is_active
       FROM api_tokens t
       JOIN users u ON u.id = t.user_id
      WHERE t.token_hash = $1 AND t.revoked_at IS NULL`,
    [hashApiToken(bearer)]
  );
  if (r.rows.length === 0) return null;
  const row = r.rows[0];
  if (!row.is_active) return null;
  return {
    tokenId: row.id,
    userId: row.user_id,
    username: row.username,
    name: row.name,
    permissions: parsePermissions(row.permissions),
    limits: effectiveLimits(row.limits),
    generation: parseGeneration(row.generation),
  };
}

const lastUsedWrites = new Map<number, number>();

/** Record that a token was used, at most once a minute per token. Fire and forget. */
export function touchApiToken(tokenId: number): void {
  const now = Date.now();
  const last = lastUsedWrites.get(tokenId) ?? 0;
  if (now - last < LAST_USED_WRITE_INTERVAL_MS) return;
  lastUsedWrites.set(tokenId, now);
  query('UPDATE api_tokens SET last_used_at = NOW() WHERE id = $1', [tokenId]).catch((err) => {
    console.error(`[ApiToken] last_used_at update failed for token ${tokenId}:`, err);
  });
}

/**
 * The complete list of routes any API token may call, and the permissions that open each
 * one (any of them is enough). Everything else answers 403, every other GET included:
 * `GET /api/users/settings` exists and must never be reachable with a token. Routes that
 * take part of a permission check their body themselves: POST /api/content accepts only a
 * `url` or a `feed_item_id` from a token, POST /api/content/bulk only add_tags, star and
 * unstar. HEAD counts as GET.
 */
interface TokenRoute {
  method: 'GET' | 'POST';
  path: RegExp;
  anyOf: readonly TokenPermission[] | 'any';
}

export const TOKEN_ROUTES: readonly TokenRoute[] = [
  { method: 'GET', path: /^\/api\/content\/index$/, anyOf: ['read_library'] },
  { method: 'GET', path: /^\/api\/content\/markdown$/, anyOf: ['read_library'] },
  { method: 'GET', path: /^\/api\/content\/\d+\/markdown$/, anyOf: ['read_library'] },
  { method: 'GET', path: /^\/api\/content\/summaries$/, anyOf: ['read_library'] },
  { method: 'GET', path: /^\/api\/content\/tags\/all$/, anyOf: ['read_library', 'tag'] },
  { method: 'GET', path: /^\/api\/podcasts$/, anyOf: ['feed'] },
  { method: 'GET', path: /^\/api\/podcasts\/feed-items$/, anyOf: ['feed'] },
  { method: 'GET', path: /^\/api\/podcasts\/refresh-status$/, anyOf: ['feed'] },
  { method: 'POST', path: /^\/api\/podcasts\/refresh-feeds$/, anyOf: ['feed'] },
  { method: 'POST', path: /^\/api\/content$/, anyOf: ['add_any', 'add_feed'] },
  { method: 'GET', path: /^\/api\/content\/preview$/, anyOf: ['add_any', 'add_feed'] },
  { method: 'POST', path: /^\/api\/content\/bulk$/, anyOf: ['tag', 'star'] },
  { method: 'GET', path: /^\/api\/auth\/token$/, anyOf: 'any' },
];

export type TokenRouteDecision =
  | { allowed: true }
  | { allowed: false; error: string };

export function tokenRouteDecision(permissions: readonly TokenPermission[], method: string, originalUrl: string): TokenRouteDecision {
  const m = method === 'HEAD' ? 'GET' : method;
  const path = (originalUrl || '').split('?')[0].replace(/\/+$/, '');
  const route = TOKEN_ROUTES.find((r) => r.method === m && r.path.test(path));
  if (!route) return { allowed: false, error: 'API tokens cannot use this route' };
  if (route.anyOf === 'any' || route.anyOf.some((p) => permissions.includes(p))) return { allowed: true };
  return { allowed: false, error: `This token needs the ${route.anyOf.join(' or ')} permission for this route` };
}
