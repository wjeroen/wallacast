// Scratch test for the three fetch cleanups added on 2026-08-28:
//   1. the <main>-inside-<article> preference and the share-menu removal (live fetch)
//   2. archive.is paragraph restore (runs on a stored export, no network)
//   3. the widened email-table flattener (runs on a stored export, no network)
//
// Run from backend/:  npx tsx scripts/test-fetch-cleanup.mts [investigationDir]
// Without the directory argument, only step 1 runs. Not wired into any build.
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import {
  fetchArticleContent,
  flattenEmailTables,
  restoreArchivedParagraphs,
  isArchiveMirrorUrl,
  authorFromJsonLd,
} from '../src/services/article-fetcher.js';

// --- 0. JSON-LD author fallback ----------------------------------------------------
const ld = (json: string) =>
  new JSDOM(`<script type="application/ld+json">${json}</script>`).window.document;

assert.equal(
  authorFromJsonLd(ld('{"@type":"Article","author":{"@type":"Person","name":"William Thibeau"}}')),
  'William Thibeau',
  'a person author on an Article node'
);
assert.equal(
  authorFromJsonLd(ld('{"@graph":[{"@type":"WebSite","name":"Site"},{"@type":"NewsArticle","author":["Ada Lovelace"]}]}')),
  'Ada Lovelace',
  'a @graph wrapper, an array author, and a non-article node skipped'
);
assert.equal(
  authorFromJsonLd(ld('{"@type":"WebSite","author":{"name":"Publisher Inc"}}')),
  undefined,
  'a non-article node never supplies an author'
);
assert.equal(authorFromJsonLd(ld('{ this is not json')), undefined, 'a malformed block is skipped, not thrown');
assert.equal(authorFromJsonLd(new JSDOM('<p>no script</p>').window.document), undefined, 'no block, no author');

const dir = process.argv[2];

// --- 1. Compact: header and share menu must stay out of the body -------------------
const COMPACT = 'https://www.compactmag.com/article/misanthropic-altruism/';
console.log(`Fetching ${COMPACT} ...`);
const article = await fetchArticleContent(COMPACT);
const text = (article.content || '').replace(/\s+/g, ' ').trim();
console.log(`  title: ${article.title}`);
console.log(`  author: ${article.author || article.byline || '(none)'}`);
assert.equal(article.author, 'William Thibeau', 'the author comes from the JSON-LD block');
console.log(`  text length: ${text.length}`);
console.log(`  first 160 chars: ${text.slice(0, 160)}`);

assert.ok(!/Share via/i.test(text), 'no "Share via ..." links left in the body');
assert.ok(!/Copy link/i.test(text), 'no "Copy link" left in the body');
assert.ok(text.length > 3000, 'the body text is still complete');
assert.ok(/daughter/i.test(text.slice(0, 400)), 'the body now STARTS with the article itself');
const dateHits = (text.match(/July 23, 2026/g) || []).length;
assert.ok(dateHits <= 1, `the date is not repeated in the body (found ${dateHits})`);

// --- 2. archive.is: paragraphs come back ------------------------------------------
assert.equal(isArchiveMirrorUrl('https://archive.is/bxpY9#selection-315.0'), true);
assert.equal(isArchiveMirrorUrl('https://archive.ph/abc'), true);
assert.equal(isArchiveMirrorUrl('https://www.compactmag.com/article/x/'), false);
assert.equal(isArchiveMirrorUrl('not a url'), false);

if (dir) {
  const archived = path.join(dir, 'Misanthropic Altruism  Compact', 'content.html');
  if (existsSync(archived)) {
    const doc = new JSDOM(readFileSync(archived, 'utf8')).window.document;
    const before = {
      p: doc.querySelectorAll('p').length,
      styled: doc.querySelectorAll('[style]').length,
      textLen: (doc.body.textContent || '').trim().length,
    };
    restoreArchivedParagraphs(doc.body);
    const after = {
      p: doc.querySelectorAll('p').length,
      styled: doc.querySelectorAll('[style]').length,
      textLen: (doc.body.textContent || '').trim().length,
    };
    console.log('\narchive.is mirror:', { before, after });
    assert.equal(before.p, 0, 'the mirror really has no paragraphs');
    assert.ok(after.p > 10, 'paragraphs are restored');
    assert.equal(after.styled, 0, 'the mirror inline styles are dropped');
    assert.equal(after.textLen, before.textLen, 'no text is lost');
  }

  // --- 3. Mailchimp: the layout tables are flattened -------------------------------
  const email = path.join(dir, 'The anxiety trap that stops good people from doing good work', 'content.html');
  if (existsSync(email)) {
    const doc = new JSDOM(readFileSync(email, 'utf8')).window.document;
    const beforeTables = doc.querySelectorAll('table').length;
    const beforeText = (doc.body.textContent || '').replace(/\s+/g, ' ').trim();
    flattenEmailTables(doc.body);
    const afterTables = doc.querySelectorAll('table').length;
    const afterText = (doc.body.textContent || '').replace(/\s+/g, ' ').trim();
    console.log('\nMailchimp newsletter:', { beforeTables, afterTables });
    assert.ok(beforeTables > 20, 'the stored copy is still table soup');
    assert.ok(afterTables <= 2, `almost every layout table is unwrapped (left: ${afterTables})`);
    assert.ok(afterText.length > beforeText.length * 0.9, 'the newsletter text survives the flattening');
    assert.ok(/faulty smoke alarm/i.test(afterText), 'the body copy is still there');
  }
}

console.log('\nALL FETCH-CLEANUP TESTS PASSED');
