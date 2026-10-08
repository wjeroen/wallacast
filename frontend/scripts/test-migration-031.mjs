// Dry run of backend/src/database/migrations/031_api_token_permissions.sql on an in-memory
// Postgres (PGlite): a token made before the migration keeps exactly the read-only
// permission, the new columns have their defaults, the event log keeps usage when an item is
// deleted and goes with its token, and a second run (every boot re-runs every migration)
// changes nothing.
// Run from frontend/: node scripts/test-migration-031.mjs   (needs: npm i --no-save @electric-sql/pglite)
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';

const here = path.dirname(fileURLToPath(import.meta.url));
const dbDir = path.join(here, '..', '..', 'backend', 'src', 'database');
const read = (name) => readFileSync(path.join(dbDir, 'migrations', name), 'utf8');
const migration = read('031_api_token_permissions.sql');

const db = new PGlite();
await db.exec(readFileSync(path.join(dbDir, 'schema.sql'), 'utf8'));
await db.exec(read('005_add_users.sql'));
await db.exec(read('029_api_tokens.sql'));
await db.exec(`
  INSERT INTO users (username, password_hash) VALUES ('alice', 'x');
  INSERT INTO api_tokens (user_id, name, token_hash) VALUES (1, 'Obsidian', '${'a'.repeat(64)}');
  INSERT INTO content_items (type, title, user_id) VALUES ('article', 'One', 1), ('article', 'Two', 1);
`);

await db.exec(migration);

const tok = (await db.query(`SELECT permissions, limits, generation, usage_reset_at, limit_hit, limit_hit_at, limit_notice_seen_at, scope FROM api_tokens`)).rows[0];
assert.deepEqual(tok.permissions, ['read_library'], 'an existing token keeps read-only');
assert.deepEqual(tok.limits, {}, 'no stored limits: the defaults apply');
assert.deepEqual(tok.generation, { follow: true }, 'follows the app');
assert.equal(tok.usage_reset_at, null);
assert.equal(tok.limit_hit, null);
assert.equal(tok.limit_hit_at, null);
assert.equal(tok.limit_notice_seen_at, null);
assert.equal(tok.scope, 'read', 'scope stays');
console.log('✅ an existing token gets the read-only permission and the defaults');

await db.exec(`INSERT INTO api_tokens (user_id, name, token_hash) VALUES (1, 'Routine', '${'b'.repeat(64)}')`);
assert.deepEqual(
  (await db.query(`SELECT permissions FROM api_tokens WHERE name = 'Routine'`)).rows[0].permissions,
  ['read_library'],
  'a new token gets the same default'
);

const cols = (await db.query(`
  SELECT column_name FROM information_schema.columns WHERE table_name = 'api_token_events' ORDER BY ordinal_position
`)).rows.map((r) => r.column_name);
assert.deepEqual(cols, ['id', 'token_id', 'user_id', 'kind', 'content_item_id', 'tag', 'minutes', 'detail', 'created_at', 'undone_at']);
const idx = await db.query(`SELECT indexname FROM pg_indexes WHERE tablename = 'api_token_events'`);
assert.ok(idx.rows.some((r) => r.indexname === 'idx_api_token_events_token'), 'token index exists');

await db.exec(`
  INSERT INTO api_token_events (token_id, user_id, kind, content_item_id) VALUES (1, 1, 'add', 1);
  INSERT INTO api_token_events (token_id, user_id, kind, content_item_id, minutes, detail) VALUES (1, 1, 'generation', 1, 12.5, 'audio');
  INSERT INTO api_token_events (token_id, user_id, kind, content_item_id, tag) VALUES (2, 1, 'tag_add', 2, 'ai-safety');
`);
const ev = (await db.query(`SELECT minutes, created_at, undone_at FROM api_token_events WHERE kind = 'generation'`)).rows[0];
assert.equal(ev.minutes, 12.5);
assert.ok(ev.created_at, 'created_at defaults to now');
assert.equal(ev.undone_at, null);

await db.exec(`DELETE FROM content_items WHERE id = 1`);
const kept = (await db.query(`SELECT COUNT(*)::int AS n, COUNT(content_item_id)::int AS linked FROM api_token_events WHERE token_id = 1`)).rows[0];
assert.deepEqual(kept, { n: 2, linked: 0 }, 'deleting an item keeps its usage, unlinked');
console.log('✅ the event log keeps usage when an item is deleted');

await db.exec(migration);
assert.equal((await db.query(`SELECT COUNT(*)::int AS n FROM api_token_events`)).rows[0].n, 3, 're-run keeps the events');
assert.deepEqual((await db.query(`SELECT permissions FROM api_tokens WHERE id = 1`)).rows[0].permissions, ['read_library']);
console.log('✅ a second run changes nothing');

await db.exec(`DELETE FROM api_tokens WHERE id = 2`);
assert.equal((await db.query(`SELECT COUNT(*)::int AS n FROM api_token_events WHERE token_id = 2`)).rows[0].n, 0, 'events go with their token');
await db.exec(`DELETE FROM users WHERE id = 1`);
assert.equal((await db.query(`SELECT COUNT(*)::int AS n FROM api_token_events`)).rows[0].n, 0, 'and with their user');
console.log('✅ events go with their token and their user');

await db.close();
console.log('\nAll migration 031 checks passed.');
