// Dry run of backend/src/database/migrations/028_wallabag_synced_flags.sql on an in-memory
// Postgres (PGlite), plus the pure mergeFlag rules the migration exists to support.
// Run from frontend/: node scripts/test-migration-028.mjs   (needs: npm i --no-save @electric-sql/pglite)
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';

const here = path.dirname(fileURLToPath(import.meta.url));
const dbDir = path.join(here, '..', '..', 'backend', 'src', 'database');
const migration = readFileSync(path.join(dbDir, 'migrations', '028_wallabag_synced_flags.sql'), 'utf8');

// Mirror of mergeFlag() in backend/src/services/wallabag-sync.ts. Kept in step by these tests.
function mergeFlag(base, local, remote) {
  if (base === null || base === undefined) return local;
  if (local === remote) return local;
  return local !== base ? local : remote;
}

function testMergeRules() {
  // No base yet (an item that predates this bookkeeping): keep what Wallacast has.
  assert.equal(mergeFlag(null, true, false), true, 'no base, local wins');
  assert.equal(mergeFlag(undefined, false, true), false, 'undefined base, local wins');

  // Both sides agree: nothing to decide.
  assert.equal(mergeFlag(false, true, true), true, 'both sides starred it');
  assert.equal(mergeFlag(true, false, false), false, 'both sides unstarred it');

  // Only Wallacast moved: Wallacast wins, which is the bug this fixes. The old code copied
  // Wallabag's value here and silently undid a local star.
  assert.equal(mergeFlag(false, true, false), true, 'starred in Wallacast only');
  assert.equal(mergeFlag(true, false, true), false, 'unstarred in Wallacast only');

  // Only Wallabag moved: take Wallabag's value instead of stubbornly re-asserting the old one.
  assert.equal(mergeFlag(false, false, true), true, 'starred in Wallabag only');
  assert.equal(mergeFlag(true, true, false), false, 'unstarred in Wallabag only');

  console.log('✅ mergeFlag: all 8 rules hold');
}

async function testMigration() {
  const db = new PGlite();
  // Pre-028 shape: what production has after 027.
  await db.exec(`
    CREATE TABLE content_items (
      id SERIAL PRIMARY KEY,
      user_id INTEGER,
      title TEXT,
      is_starred BOOLEAN NOT NULL DEFAULT FALSE,
      is_archived BOOLEAN NOT NULL DEFAULT FALSE,
      wallabag_id INTEGER,
      updated_at TIMESTAMP NOT NULL DEFAULT NOW()
    );
    INSERT INTO content_items (user_id, title, is_starred, is_archived, wallabag_id) VALUES
      (1, 'synced and starred',   TRUE,  FALSE, 10),
      (1, 'synced and archived',  FALSE, TRUE,  11),
      (1, 'synced, neither',      FALSE, FALSE, 12),
      (1, 'never synced',         TRUE,  TRUE,  NULL);
  `);

  const before = await db.query(`SELECT updated_at FROM content_items ORDER BY id`);

  await db.exec(migration);

  const cols = await db.query(`
    SELECT column_name, data_type FROM information_schema.columns
     WHERE table_name = 'content_items' AND column_name LIKE 'wallabag_synced_%'
     ORDER BY column_name
  `);
  assert.deepEqual(
    cols.rows.map(r => `${r.column_name}:${r.data_type}`),
    ['wallabag_synced_archived:boolean', 'wallabag_synced_starred:boolean'],
    'both base columns exist as booleans'
  );

  const rows = (await db.query(`
    SELECT title, is_starred, is_archived, wallabag_synced_starred, wallabag_synced_archived
      FROM content_items ORDER BY id
  `)).rows;

  for (const r of rows.filter(r => r.title !== 'never synced')) {
    assert.equal(r.wallabag_synced_starred, r.is_starred, `${r.title}: star base backfilled`);
    assert.equal(r.wallabag_synced_archived, r.is_archived, `${r.title}: archive base backfilled`);
  }

  const unsynced = rows.find(r => r.title === 'never synced');
  assert.equal(unsynced.wallabag_synced_starred, null, 'an item never pushed gets no base');
  assert.equal(unsynced.wallabag_synced_archived, null, 'an item never pushed gets no archive base');

  // updated_at must NOT move: bumping it would fake a local edit and manufacture a conflict
  // on the very next pull, for every item in the library.
  const after = await db.query(`SELECT updated_at FROM content_items ORDER BY id`);
  assert.deepEqual(
    after.rows.map(r => String(r.updated_at)),
    before.rows.map(r => String(r.updated_at)),
    'the backfill leaves updated_at alone'
  );

  // A later local change followed by a re-run (every boot runs every migration) must not
  // reset the base the sync has since maintained.
  await db.exec(`UPDATE content_items SET wallabag_synced_starred = FALSE WHERE wallabag_id = 10`);
  await db.exec(migration);
  const rerun = (await db.query(
    `SELECT wallabag_synced_starred FROM content_items WHERE wallabag_id = 10`
  )).rows[0];
  assert.equal(rerun.wallabag_synced_starred, false, 're-running the migration keeps the maintained base');

  console.log(`✅ migration 028: ${rows.length} rows, columns added, backfill correct, idempotent`);
  await db.close();
}

testMergeRules();
await testMigration();
console.log('\nAll migration 028 checks passed.');
