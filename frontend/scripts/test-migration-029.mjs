// Dry run of backend/src/database/migrations/029_api_tokens.sql on an in-memory Postgres
// (PGlite): the table shape, its defaults, the unique hash, the cascade on user deletion,
// and a second run (every boot re-runs every migration).
// Run from frontend/: node scripts/test-migration-029.mjs   (needs: npm i --no-save @electric-sql/pglite)
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';

const here = path.dirname(fileURLToPath(import.meta.url));
const dbDir = path.join(here, '..', '..', 'backend', 'src', 'database');
const migration = readFileSync(path.join(dbDir, 'migrations', '029_api_tokens.sql'), 'utf8');

async function run(label, prepare) {
  const db = new PGlite();
  await prepare(db);
  await db.exec(migration);

  const cols = await db.query(`
    SELECT column_name, data_type, is_nullable FROM information_schema.columns
     WHERE table_name = 'api_tokens' ORDER BY ordinal_position
  `);
  assert.deepEqual(
    cols.rows.map((r) => r.column_name),
    ['id', 'user_id', 'name', 'token_hash', 'scope', 'created_at', 'last_used_at', 'revoked_at'],
    'all columns present, in order'
  );
  assert.equal(cols.rows.find((r) => r.column_name === 'last_used_at').is_nullable, 'YES');
  assert.equal(cols.rows.find((r) => r.column_name === 'revoked_at').is_nullable, 'YES');
  assert.equal(cols.rows.find((r) => r.column_name === 'token_hash').is_nullable, 'NO');

  const idx = await db.query(`SELECT indexname FROM pg_indexes WHERE tablename = 'api_tokens'`);
  assert.ok(idx.rows.some((r) => r.indexname === 'idx_api_tokens_user'), 'user index exists');

  const users = (await db.query(`SELECT id FROM users ORDER BY id`)).rows.map((r) => r.id);
  assert.ok(users.length >= 2, 'fixture has two users');
  const [u1, u2] = users;
  const hash = 'a'.repeat(64);
  await db.query(`INSERT INTO api_tokens (user_id, name, token_hash) VALUES ($1, $2, $3)`, [u1, 'Obsidian', hash]);
  const row = (await db.query(`SELECT scope, created_at, last_used_at, revoked_at FROM api_tokens`)).rows[0];
  assert.equal(row.scope, 'read', 'scope defaults to read');
  assert.ok(row.created_at, 'created_at defaults to now');
  assert.equal(row.last_used_at, null);
  assert.equal(row.revoked_at, null);

  await assert.rejects(
    db.query(`INSERT INTO api_tokens (user_id, name, token_hash) VALUES ($1, 'dup', $2)`, [u2, hash]),
    /unique|duplicate/i,
    'the same hash cannot be stored twice'
  );

  // A second run must be a no-op that keeps the data.
  await db.exec(migration);
  assert.equal((await db.query(`SELECT COUNT(*)::int AS n FROM api_tokens`)).rows[0].n, 1, 're-run keeps the row');

  // Deleting the user takes the tokens with it.
  await db.query(`DELETE FROM users WHERE id = $1`, [u1]);
  assert.equal((await db.query(`SELECT COUNT(*)::int AS n FROM api_tokens`)).rows[0].n, 0, 'cascade on user delete');

  console.log(`✅ migration 029 (${label}): shape, defaults, unique hash, idempotent, cascade`);
  await db.close();
}

// A: a minimal users table, the only thing the migration depends on.
await run('minimal users table', async (db) => {
  await db.exec(`
    CREATE TABLE users (id SERIAL PRIMARY KEY, username TEXT NOT NULL, is_active BOOLEAN NOT NULL DEFAULT TRUE);
    INSERT INTO users (username) VALUES ('alice'), ('bob');
  `);
});

// B: the real schema plus the real users migration, the shape a fresh database has.
await run('schema.sql + 005_add_users', async (db) => {
  await db.exec(readFileSync(path.join(dbDir, 'schema.sql'), 'utf8'));
  await db.exec(readFileSync(path.join(dbDir, 'migrations', '005_add_users.sql'), 'utf8'));
  await db.exec(`INSERT INTO users (username, password_hash) VALUES ('alice', 'x'), ('bob', 'y')`);
});

console.log('\nAll migration 029 checks passed.');
