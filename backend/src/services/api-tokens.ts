import crypto from 'crypto';
import { query } from '../database/db.js';
import { hashRefreshToken } from './auth.js';

/**
 * Read-only API tokens (table `api_tokens`, migration 029).
 *
 * A token is the long-lived credential an outside reader uses, today the Obsidian "Wallacast
 * inbox" and "Import from wallacast" commands. Access tokens live 15 minutes and refresh
 * tokens rotate, so neither fits a script that runs from a note. The token sits as plain
 * text in a synced vault, which is why it can do nothing but read: `isReadTokenAllowed()`
 * below is the complete list of what it may call, and `requireAuth` answers 403 for
 * everything else, every GET included.
 *
 * Format: `wcr_` + 40 hex characters (160 random bits). Only the SHA-256 hash is stored,
 * exactly like refresh tokens, so a database leak does not leak usable tokens.
 */

export const API_TOKEN_PREFIX = 'wcr_';

/** A cap on live tokens per user, so a script gone wrong cannot fill the table. */
export const MAX_ACTIVE_TOKENS_PER_USER = 20;

/** last_used_at is written at most this often per token. A busy inbox refresh must not
 *  turn every request into an UPDATE. */
const LAST_USED_WRITE_INTERVAL_MS = 60_000;

export interface ApiTokenSummary {
  id: number;
  name: string;
  created_at: Date;
  last_used_at: Date | null;
}

/** What `requireAuth` learns about a valid token. */
export interface ApiTokenAuth {
  tokenId: number;
  userId: number;
  username: string;
  scope: 'read';
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

/** The user's live tokens, newest first. Never the hash. */
export async function listApiTokens(userId: number): Promise<ApiTokenSummary[]> {
  const r = await query(
    'SELECT id, name, created_at, last_used_at FROM api_tokens WHERE user_id = $1 AND revoked_at IS NULL ORDER BY created_at DESC',
    [userId]
  );
  return r.rows;
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

/** Look a raw token up by its hash. Null for unknown, revoked, or a disabled account. */
export async function authenticateApiToken(bearer: string): Promise<ApiTokenAuth | null> {
  const r = await query(
    `SELECT t.id, t.user_id, t.scope, u.username, u.is_active
       FROM api_tokens t
       JOIN users u ON u.id = t.user_id
      WHERE t.token_hash = $1 AND t.revoked_at IS NULL`,
    [hashApiToken(bearer)]
  );
  if (r.rows.length === 0) return null;
  const row = r.rows[0];
  if (!row.is_active) return null;
  return { tokenId: row.id, userId: row.user_id, username: row.username, scope: 'read' };
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
 * The complete allow-list for a read token. Everything else, every other GET included
 * (`GET /api/users/settings` exists and must never be reachable with a vault token), gets
 * `403 { error: 'This token is read-only' }` from requireAuth.
 */
const READ_TOKEN_ROUTES: RegExp[] = [
  /^\/api\/content\/index$/,
  /^\/api\/content\/markdown$/,
  /^\/api\/content\/\d+\/markdown$/,
];

export function isReadTokenAllowed(method: string, originalUrl: string): boolean {
  if (method !== 'GET' && method !== 'HEAD') return false;
  const path = (originalUrl || '').split('?')[0].replace(/\/+$/, '');
  return READ_TOKEN_ROUTES.some((re) => re.test(path));
}
