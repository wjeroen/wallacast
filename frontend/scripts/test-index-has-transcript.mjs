// The has_transcript column of GET /api/content/index, run on an in-memory Postgres (PGlite).
// The expression is read straight out of backend/src/routes/content.ts, so this tests the
// code as it ships. It must agree with exportHasTranscript() in frontend/src/markdown.ts (a
// podcast episode whose transcript holds text), which backend/scripts/test-markdown-export.mts
// checks on the export side.
// Run from frontend/: node scripts/test-index-has-transcript.mjs   (needs: npm i --no-save @electric-sql/pglite)
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';

const here = path.dirname(fileURLToPath(import.meta.url));
const route = readFileSync(path.join(here, '..', '..', 'backend', 'src', 'routes', 'content.ts'), 'utf8');
const match = route.match(/(COALESCE\(type = 'podcast_episode'[\s\S]*?\)\s*AS has_transcript)/);
assert.ok(match, 'the has_transcript expression is in routes/content.ts');
const expression = match[1];

const db = new PGlite();
await db.exec('CREATE TABLE content_items (id SERIAL PRIMARY KEY, type VARCHAR(50) NOT NULL, transcript TEXT)');

const cases = [
  ['podcast_episode', 'Welcome to the show.', true, 'podcast with text'],
  ['podcast_episode', 'x'.repeat(50000), true, 'long transcript'],
  ['podcast_episode', '  Text after spaces', true, 'text after leading spaces'],
  ['podcast_episode', null, false, 'no transcript'],
  ['podcast_episode', '', false, 'empty'],
  ['podcast_episode', ' \n\t ', false, 'whitespace only'],
  ['article', 'Read-along transcript of generated audio.', false, 'articles never'],
  ['text', 'Read-along transcript of generated audio.', false, 'texts never'],
  // Known limit, documented at the route: older whitespace-only values over 1,000 bytes
  // count as text (the check only reads short transcripts). New ones are never stored.
  ['podcast_episode', ' '.repeat(1500), true, 'long whitespace-only (documented limit)'],
];
for (const [type, transcript] of cases) {
  await db.query('INSERT INTO content_items (type, transcript) VALUES ($1, $2)', [type, transcript]);
}
const result = await db.query(`SELECT id, ${expression} FROM content_items ORDER BY id`);
result.rows.forEach((row, i) => {
  const [, , expected, label] = cases[i];
  assert.equal(row.has_transcript, expected, label);
});
console.log(`✅ has_transcript: ${cases.length} cases`);
