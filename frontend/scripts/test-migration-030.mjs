// Dry run of backend/src/database/migrations/030_feed_item_teaser.sql on an in-memory Postgres
// (PGlite): the column after migrations 013 and 018, a second run (every boot re-runs every
// migration), and the refresh's upsert, which must keep a stored teaser when a later refresh
// builds none (refreshFeedFromNetwork in backend/src/services/podcast-service.ts).
// Run from frontend/: node scripts/test-migration-030.mjs   (needs: npm i --no-save @electric-sql/pglite)
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';

const here = path.dirname(fileURLToPath(import.meta.url));
const migrations = path.join(here, '..', '..', 'backend', 'src', 'database', 'migrations');
const read = (name) => readFileSync(path.join(migrations, name), 'utf8');

const db = new PGlite();
await db.exec('CREATE TABLE podcasts (id SERIAL PRIMARY KEY)');
await db.exec(read('013_add_feed_items_cache.sql'));
await db.exec(read('018_add_feed_item_author.sql'));
await db.exec(read('030_feed_item_teaser.sql'));
await db.exec(read('030_feed_item_teaser.sql')); // the next boot

const col = await db.query(`
  SELECT data_type, is_nullable FROM information_schema.columns
   WHERE table_name = 'feed_items' AND column_name = 'teaser'`);
assert.deepEqual(col.rows, [{ data_type: 'text', is_nullable: 'YES' }], 'teaser is a nullable TEXT column');

// The upsert as the refresh runs it (same ON CONFLICT clause)
await db.exec('INSERT INTO podcasts DEFAULT VALUES');
const upsert = (teaser) => db.query(
  `INSERT INTO feed_items (feed_id, item_type, title, published_at, guid, author, teaser)
   VALUES (1, 'article', 'Post', NOW(), 'guid-1', 'Author', $1)
   ON CONFLICT (feed_id, guid) DO UPDATE SET author = EXCLUDED.author,
     teaser = COALESCE(EXCLUDED.teaser, feed_items.teaser)`,
  [teaser]
);
const teaserNow = async () => (await db.query(`SELECT teaser FROM feed_items WHERE guid = 'guid-1'`)).rows[0].teaser;

await upsert(null);
assert.equal(await teaserNow(), null, 'an item cached before teasers has none');
await upsert('Subtitle\n\nOpening of the post.');
assert.equal(await teaserNow(), 'Subtitle\n\nOpening of the post.', 'the first refresh after 030 fills it in');
await upsert(null);
assert.equal(await teaserNow(), 'Subtitle\n\nOpening of the post.', 'a later refresh that builds none keeps it');

console.log('✅ migration 030: teaser column, re-run, and the refresh upsert');
