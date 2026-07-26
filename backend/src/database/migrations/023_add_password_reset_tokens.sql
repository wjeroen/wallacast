-- Migration 023: password reset tokens for the email-based "forgot password" flow.
--
-- A token row is created by POST /api/auth/forgot-password and consumed (used_at set)
-- by POST /api/auth/reset-password. Only the SHA-256 hash of the token is stored, the
-- raw token exists only inside the emailed link. Expired and used rows are cleaned up
-- opportunistically whenever a new token is created.
--
-- Safe to re-run on every boot (db.ts re-runs all migration files): plain IF NOT EXISTS,
-- no data backfill.
CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash VARCHAR(64) NOT NULL UNIQUE,
  expires_at TIMESTAMP NOT NULL,
  used_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_user ON password_reset_tokens(user_id);
