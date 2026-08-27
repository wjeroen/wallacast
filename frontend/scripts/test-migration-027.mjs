// Dry run of backend/src/database/migrations/027_tags_array.sql on an in-memory Postgres
// (PGlite). Two scenarios: an EXISTING database (comma-string tags column, the dead
// tags/content_tags tables present, sample rows) and a FRESH database (schema.sql first).
// Run from frontend/: node scripts/test-migration-027.mjs   (needs: npm i --no-save @electric-sql/pglite)
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';

const here = path.dirname(fileURLToPath(import.meta.url));
const dbDir = path.join(here, '..', '..', 'backend', 'src', 'database');
const migration = readFileSync(path.join(dbDir, 'migrations', '027_tags_array.sql'), 'utf8');
const schema = readFileSync(path.join(dbDir, 'schema.sql'), 'utf8');

async function scenarioExisting() {
  const db = new PGlite();
  // Minimal pre-027 shape: what production has (tags TEXT + the dead tables).
  await db.exec(`
    CREATE TABLE users (id SERIAL PRIMARY KEY);
    CREATE TABLE content_items (
      id SERIAL PRIMARY KEY,
      user_id INTEGER,
      type VARCHAR(50),
      title TEXT,
      tags TEXT,
      wallabag_id INTEGER,
      wallabag_updated_at TIMESTAMP,
      wallabag_needs_push BOOLEAN NOT NULL DEFAULT FALSE
    );
    CREATE TABLE tags (id SERIAL PRIMARY KEY, name VARCHAR(100) NOT NULL UNIQUE, color VARCHAR(7));
    CREATE TABLE content_tags (
      content_item_id INTEGER NOT NULL REFERENCES content_items(id) ON DELETE CASCADE,
      tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
      PRIMARY KEY (content_item_id, tag_id)
    );
    INSERT INTO content_items (user_id, type, title, tags, wallabag_id) VALUES
      (1, 'article', 'pulled with tags', 'article,ToRead, ai safety ,toread', 10),
      (1, 'article', 'pulled only type tag', 'article', 11),
      (1, 'text', 'local never synced', NULL, NULL),
      (1, 'podcast_episode', 'empty string tags', '', 12),
      (1, 'article', 'nosync kept', 'article,nosync,x', 13);
  `);

  await db.exec(migration);
  // Idempotent: every boot re-runs it.
  await db.exec(migration);

  const cols = await db.query(
    `SELECT column_name, data_type, column_default FROM information_schema.columns
      WHERE table_name = 'content_items' AND column_name IN ('tags', 'tags_legacy', 'wallabag_synced_tags') ORDER BY column_name`
  );
  console.log('columns:', cols.rows);
  const byName = Object.fromEntries(cols.rows.map((r) => [r.column_name, r]));
  assert.equal(byName.tags.data_type, 'ARRAY');
  assert.equal(byName.tags_legacy.data_type, 'text');
  assert.equal(byName.wallabag_synced_tags.data_type, 'ARRAY');

  const rows = await db.query('SELECT title, tags, tags_legacy, wallabag_synced_tags FROM content_items ORDER BY id');
  console.log('rows after migration:');
  for (const r of rows.rows) console.log('  ', r);
  const t = Object.fromEntries(rows.rows.map((r) => [r.title, r]));
  assert.deepEqual(t['pulled with tags'].tags, ['ai safety', 'toread']);
  assert.deepEqual(t['pulled with tags'].wallabag_synced_tags, ['ai safety', 'toread']);
  assert.deepEqual(t['pulled only type tag'].tags, []);
  assert.deepEqual(t['pulled only type tag'].wallabag_synced_tags, []);
  assert.deepEqual(t['local never synced'].tags, []);
  assert.equal(t['local never synced'].wallabag_synced_tags, null);
  assert.deepEqual(t['empty string tags'].tags, []);
  assert.deepEqual(t['nosync kept'].tags, ['nosync', 'x']);
  assert.equal(t['pulled with tags'].tags_legacy, 'article,ToRead, ai safety ,toread', 'legacy column untouched');

  const tables = await db.query(`SELECT table_name FROM information_schema.tables WHERE table_name IN ('tags', 'content_tags')`);
  assert.equal(tables.rows.length, 0, 'empty dead tables dropped');

  const idx = await db.query(`SELECT indexname FROM pg_indexes WHERE tablename = 'content_items' AND indexname = 'idx_content_items_tags'`);
  assert.equal(idx.rows.length, 1, 'GIN index exists');

  // The queries the app runs against the new column.
  const filt = await db.query(`SELECT title FROM content_items WHERE tags @> ARRAY['toread']::text[]`);
  assert.deepEqual(filt.rows.map((r) => r.title), ['pulled with tags']);
  await db.query('UPDATE content_items SET tags = $1 WHERE id = 3', [['b', 'a']]);
  const upd = await db.query('SELECT tags FROM content_items WHERE id = 3');
  assert.deepEqual(upd.rows[0].tags, ['b', 'a']);
  const counts = await db.query(`SELECT tag, count(*)::int AS n FROM content_items, unnest(tags) AS tag GROUP BY tag ORDER BY n DESC, tag`);
  console.log('tag counts:', counts.rows);
  console.log('EXISTING-DB SCENARIO OK');
}

async function scenarioDeadTablesNotEmpty() {
  const db = new PGlite();
  await db.exec(`
    CREATE TABLE content_items (id SERIAL PRIMARY KEY, tags TEXT, wallabag_id INTEGER);
    CREATE TABLE tags (id SERIAL PRIMARY KEY, name VARCHAR(100) NOT NULL UNIQUE, color VARCHAR(7));
    CREATE TABLE content_tags (content_item_id INTEGER NOT NULL, tag_id INTEGER NOT NULL REFERENCES tags(id), PRIMARY KEY (content_item_id, tag_id));
    INSERT INTO tags (name) VALUES ('keep me');
  `);
  await db.exec(migration);
  const tables = await db.query(`SELECT table_name FROM information_schema.tables WHERE table_name IN ('tags', 'content_tags') ORDER BY table_name`);
  assert.deepEqual(tables.rows.map((r) => r.table_name), ['tags'], 'non-empty tags table kept, empty content_tags dropped');
  console.log('NON-EMPTY DEAD TABLE SCENARIO OK');
}

async function scenarioFresh() {
  const db = new PGlite();
  await db.exec(schema);
  await db.exec(migration);
  await db.exec(migration);
  const cols = await db.query(
    `SELECT column_name, data_type FROM information_schema.columns
      WHERE table_name = 'content_items' AND column_name IN ('tags', 'tags_legacy', 'wallabag_synced_tags') ORDER BY column_name`
  );
  console.log('fresh columns:', cols.rows);
  assert.deepEqual(cols.rows.map((r) => r.column_name), ['tags', 'wallabag_synced_tags'], 'no tags_legacy on a fresh db');
  const tables = await db.query(`SELECT table_name FROM information_schema.tables WHERE table_name IN ('tags', 'content_tags')`);
  assert.equal(tables.rows.length, 0);
  await db.query(`INSERT INTO content_items (type, title) VALUES ('text', 'x')`);
  const r = await db.query('SELECT tags, wallabag_synced_tags FROM content_items');
  assert.deepEqual(r.rows[0].tags, []);
  assert.equal(r.rows[0].wallabag_synced_tags, null);
  console.log('FRESH-DB SCENARIO OK');
}

await scenarioExisting();
await scenarioDeadTablesNotEmpty();
await scenarioFresh();
console.log('MIGRATION 027 DRY RUN PASSED');
