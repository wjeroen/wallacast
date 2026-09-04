-- Migration 029: read-only API tokens for outside readers (the Obsidian import commands).
--
-- A session's access token lives 15 minutes and its refresh token rotates, so a script that
-- runs from a note-taking app needs a credential of its own. That credential sits as plain
-- text in a synced vault, so it may do nothing but read: `requireAuth` in middleware/auth.ts
-- accepts a `wcr_...` Bearer value only on the library index and the Copy content Markdown
-- endpoints and answers 403 everywhere else. `scope` is always 'read' today. The column exists
-- so a wider scope can be added later without a schema change.
--
-- Only the SHA-256 hash of a token is stored (like refresh tokens). The raw token is shown
-- once, at creation. Revoking sets revoked_at, and the row stays in the table (hidden from the
-- Settings list). last_used_at is written at most once a minute per token.
--
-- Safe to re-run on every boot (db.ts re-runs all migration files): plain IF NOT EXISTS,
-- no data backfill.
CREATE TABLE IF NOT EXISTS api_tokens (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(100) NOT NULL,
  token_hash VARCHAR(64) NOT NULL UNIQUE,
  scope VARCHAR(20) NOT NULL DEFAULT 'read',
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  last_used_at TIMESTAMP,
  revoked_at TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_api_tokens_user ON api_tokens(user_id);
