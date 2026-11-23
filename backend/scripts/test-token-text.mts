// A token's text add (readTokenText in services/token-actions.ts) reads a note the way the
// Add tab reads one: a Wallacast Copy content export comes back with its title, author, date,
// source, description, tags, summaries and comments. No database: the tag check, the duplicate
// check and the item limits run in shapeTokenText and are not covered here.
// Run from backend/:  node_modules/.bin/tsx scripts/test-token-text.mts
import assert from 'node:assert/strict';

const { readTokenText, MAX_TOKEN_TEXT_CHARS } = await import('../src/services/token-actions.ts');
const { contentToMarkdown } = await import('../src/shared/markdown.ts');

const read = (raw: Record<string, unknown>) => {
  const r = readTokenText(raw);
  if ('error' in r) throw new Error(`refused: ${r.status} ${r.error}`);
  return r;
};
const refused = (raw: Record<string, unknown>) => {
  const r = readTokenText(raw);
  assert.ok('error' in r, `expected a refusal for ${JSON.stringify(raw).slice(0, 80)}`);
  return r as { status: number; error: string };
};

// ---- 1. a Copy content export round-trips -------------------------------------------------
const item: any = {
  id: 1, type: 'article', title: 'The world is much better',
  author: 'Max Roser', url: 'https://ourworldindata.org/much-better-awful-can-be-better',
  published_at: '2022-09-15T00:00:00Z', tags: ['progress', 'ai-safety'],
  description: 'Three statements that are all true.',
  html_content: '<h2>Part one</h2><p>The world is <strong>much</strong> better.</p><p>It is also awful.</p>',
  content: '', summary: 'Three things are true at once.', comment_summary: 'Readers mostly agree.',
  comment_count: 2,
};
const comments = [
  { username: 'alice', date: '2022-09-16T10:00:00Z', karma: 4, content: '<p>Great piece.</p>', replies: [
    { username: 'bob', date: '2022-09-16T11:00:00Z', karma: 1, content: '<p>Agreed.</p>' },
  ] },
];
const note = contentToMarkdown(item, comments, { includeSummary: true, summaryCodeLabel: 'ad-summary', includeCommentSummary: true, includeComments: true });
const r = read({ markdown: note });
assert.equal(r.body.type, 'article', 'a source link makes it an article');
assert.equal(r.body.url, item.url);
assert.equal(r.body.title, item.title);
assert.equal(r.body.author, 'Max Roser');
assert.equal(r.body.published_at, '2022-09-15T00:00:00.000Z');
assert.equal(r.body.description, item.description);
assert.equal(r.body.summary, item.summary);
assert.equal(r.body.comment_summary, item.comment_summary);
assert.deepEqual(r.tags, ['progress', 'ai-safety'], 'the type tag is dropped');
assert.equal(r.tagsFromField, false);
const c = r.body.comments as any[];
assert.equal(c.length, 1);
assert.equal(c[0].username, 'alice');
assert.equal(c[0].replies?.[0]?.username, 'bob');
const html = r.body.content as string;
assert.ok(html.includes('<strong>much</strong>'), 'the body is HTML');
assert.ok(!html.includes(item.title), 'the repeated # Title is dropped');
assert.ok(!html.includes('Great piece'), 'the comments are not in the body');
assert.ok(!html.includes('Three things are true'), 'the summary is not in the body');
assert.deepEqual(r.warnings, []);
console.log('✅ a Copy content export comes back with its properties, summaries and comments');

// ---- 2. fields win over the note's properties ---------------------------------------------
const r2 = read({ markdown: note, title: 'My title', author: 'Someone', published: '2020-01-02', description: 'Mine', tags: ['reading'] });
assert.equal(r2.body.title, 'My title');
assert.equal(r2.body.author, 'Someone');
assert.equal(r2.body.published_at, '2020-01-02T00:00:00.000Z');
assert.equal(r2.body.description, 'Mine');
assert.deepEqual(r2.tags, ['reading']);
assert.equal(r2.tagsFromField, true);
const r2b = read({ markdown: note, source: 'https://example.com/other' });
assert.equal(r2b.body.url, 'https://example.com/other');
console.log('✅ fields win over the note\'s properties');

// ---- 3. plain Markdown, no properties -----------------------------------------------------
const r3 = read({ markdown: '# A plain note\n\nSome *text* here.\n' });
assert.equal(r3.body.type, 'text');
assert.equal(r3.body.title, 'A plain note', 'the title falls back to the first # Heading');
assert.ok(!(r3.body.content as string).includes('A plain note'));
assert.ok((r3.body.content as string).includes('<em>text</em>'));
assert.equal(r3.body.url, undefined);
assert.equal(r3.body.summary, undefined, 'summary blocks are only read after a properties block');
const r3b = read({ markdown: 'No heading here.', title: 'Given' });
assert.equal(r3b.body.title, 'Given');
console.log('✅ plain Markdown is a text, its title from the first heading or the field');

// ---- 4. alt-source, a bad date, a bad source in the note ----------------------------------
const r4 = read({ markdown: '---\ntitle: Mirror\nalt-source: "https://archive.ph/abc"\npublished: someday\n---\nBody text.\n' });
assert.equal(r4.body.url, 'https://archive.ph/abc', 'alt-source is used when there is no source');
assert.equal(r4.body.published_at, undefined);
assert.equal(r4.warnings.length, 1);
assert.match(r4.warnings[0], /someday/);
const r4b = read({ markdown: '---\ntitle: Odd\nsource: "https://exa mple.com/x"\n---\nBody.\n' });
assert.equal(r4b.body.type, 'text', 'a source that is not a web address is left out');
assert.match(r4b.warnings[0], /not a web address/);
console.log('✅ alt-source, and warnings for a bad date or source');

// ---- 5. refusals ----------------------------------------------------------------------------
assert.equal(refused({ markdown: '' }).status, 400);
assert.equal(refused({ markdown: 42 }).status, 400);
assert.equal(refused({ markdown: 'Just text, no title anywhere.' }).status, 400);
assert.equal(refused({ markdown: '---\ntitle: Only properties\n---\n' }).status, 400);
assert.equal(refused({ markdown: '# T\n\nx', title: 5 }).status, 400);
assert.equal(refused({ markdown: '# T\n\nx', source: 'ftp://a.b/c' }).status, 400);
assert.equal(refused({ markdown: '# T\n\nx', tags: 'ai' }).status, 400);
assert.equal(refused({ markdown: '# T\n\nx', tags: [] }).status, 400);
assert.equal(refused({ markdown: 'x'.repeat(MAX_TOKEN_TEXT_CHARS + 1), title: 'Big' }).status, 413);
console.log('✅ refusals: no text, no title, wrong field types, a bad source, bad tags, too long');

console.log('\nALL TOKEN TEXT CHECKS PASSED');
