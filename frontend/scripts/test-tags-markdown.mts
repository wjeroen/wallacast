// Scratch test for the Obsidian-properties export/import round trip and the tag helpers.
// Run: npx tsx scripts/test-tags-markdown.mts   (needs: npm i --no-save jsdom tsx)
// Not wired into any build.
import { JSDOM } from 'jsdom';
import assert from 'node:assert/strict';

const dom = new JSDOM('');
(globalThis as any).DOMParser = dom.window.DOMParser;
(globalThis as any).document = dom.window.document;

const { contentToMarkdown, parseFrontmatter, splitExportedComments, splitExportedSummary, stripLeadingTitle } =
  await import('../src/markdown.ts');
const { obsidianTag, parseTagInput, collectTagCounts } = await import('../src/tags.ts');

const item: any = {
  id: 42,
  type: 'article',
  title: 'The "Quoted" Title: with a colon',
  author: 'Scott Alexander',
  url: 'https://forum-bots.effectivealtruism.org/posts/abc/some-post',
  published_at: '2026-03-14T10:00:00Z',
  created_at: '2026-08-01T12:00:00Z',
  tags: ['ai safety', 'Econ', 'weird#chars!'],
  description: '<p>An <b>HTML</b> description   with   spaces</p>',
  karma: 87,
  comment_count: 3,
  html_content: '<h2>Intro</h2><p>Body <em>text</em> with a <a href="https://x.y">link</a>.</p><blockquote><p>a quote</p></blockquote>',
  summary: 'Tweet one.\n\nTweet two with ```backticks``` inside.',
  comment_summary: 'People argued.',
  is_starred: false,
  is_archived: false,
  playback_position: 0,
  playback_speed: 1,
  updated_at: '2026-08-01T12:00:00Z',
};

const comments: any[] = [
  {
    username: 'alice',
    karma: 12,
    date: '2026-03-15T00:00:00Z',
    content: '<p>Top level <strong>bold</strong>.</p><blockquote><p>she quoted this</p></blockquote>',
    replies: [
      {
        username: 'bob',
        karma: -1,
        date: '2026-03-16T00:00:00Z',
        content: '<p>Reply one.</p><p>Second paragraph.</p>',
        replies: [{ username: 'carol', content: '<p>Deep reply.</p>' }],
      },
      { username: 'dave', karma: 3, content: '<p>Sibling reply.</p>' },
    ],
  },
  { username: 'erin', content: '<p>Second top-level, no karma no date.</p>' },
];

// ---- export -------------------------------------------------------------
const md = contentToMarkdown(item, comments, { includeSummary: true, summaryCodeLabel: 'ad-summary' });
console.log('----- EXPORT -----\n' + md + '\n------------------');

assert.ok(md.startsWith('---\ntitle: "The \\"Quoted\\" Title: with a colon"\n'), 'title quoted/escaped');
assert.ok(md.includes('source: "https://forum.effectivealtruism.org/posts/abc/some-post"'), 'human host in source');
assert.ok(md.includes('\ntags:\n  - article\n  - ai-safety\n  - econ\n  - weirdchars\n'), 'tags list');
assert.ok(md.includes('published: 2026-03-14'), 'published date');
assert.ok(md.includes('description: "An HTML description with spaces"'), 'description cleaned');
assert.ok(md.includes('upvotes: 87') && md.includes('comments: 3'), 'upvotes + comments');
assert.ok(md.includes('---\n\n````ad-summary\nTweet one.'), 'summary block directly under the properties, 4-backtick fence because the summary contains ```');
assert.ok(md.includes('```ad-summary\nComments summary:\n\nPeople argued.\n```\n\n# The'), 'comment summary block, then the title');
assert.ok(!md.includes('By Scott Alexander'), 'old meta line gone');

const noComments = contentToMarkdown(item, comments, { includeComments: false });
assert.ok(!noComments.includes('## Comments'), 'comments toggle off');
assert.ok(noComments.includes('comments: 3'), 'count property stays');
const noCommentSummary = contentToMarkdown(item, comments, { includeSummary: true, includeCommentSummary: false });
assert.ok(noCommentSummary.includes('Tweet one.') && !noCommentSummary.includes('Comments summary:'), 'comment summary toggle off keeps the summary');

// ---- import -------------------------------------------------------------
const fm = parseFrontmatter(md);
assert.ok(fm, 'frontmatter parsed');
assert.equal(fm!.meta.title, 'The "Quoted" Title: with a colon');
assert.equal(fm!.meta.author, 'Scott Alexander');
assert.deepEqual(fm!.meta.tags, ['article', 'ai-safety', 'econ', 'weirdchars']);
assert.equal(fm!.meta.published, '2026-03-14');
assert.equal(fm!.meta.source, 'https://forum.effectivealtruism.org/posts/abc/some-post');

const sum = splitExportedSummary(fm!.body);
assert.equal(sum.summary, 'Tweet one.\n\nTweet two with ```backticks``` inside.', 'summary imported');
assert.equal(sum.comment_summary, 'People argued.', 'comment summary imported');
assert.ok(sum.body.startsWith('# The'), 'summary blocks removed, title next');
assert.deepEqual(splitExportedSummary('# No summary\n\n```js\ncode\n```'), { body: '# No summary\n\n```js\ncode\n```' }, 'a code block that is not first is left alone');

const body1 = stripLeadingTitle(sum.body, fm!.meta.title as string);
assert.ok(!body1.trimStart().startsWith('# '), 'leading H1 stripped');

const { body, comments: parsed } = splitExportedComments(body1);
assert.ok(!body.includes('## Comments'), 'comments section removed from body');
assert.ok(body.includes('## Intro') && body.includes('> a quote'), 'body kept');
assert.equal(parsed.length, 2, 'two top-level comments');
assert.equal(parsed[0].username, 'alice');
assert.equal(parsed[0].karma, 12);
assert.equal(parsed[0].date, '2026-03-15');
assert.ok(parsed[0].content.includes('<strong>bold</strong>'), 'comment html');
assert.ok(parsed[0].content.includes('<blockquote>'), 'a quote inside a comment survives');
assert.equal(parsed[0].replies!.length, 2, 'alice has two replies');
assert.equal(parsed[0].replies![0].username, 'bob');
assert.equal(parsed[0].replies![0].karma, -1);
assert.ok(parsed[0].replies![0].content.includes('Second paragraph'), 'multi-paragraph reply');
assert.equal(parsed[0].replies![0].replies![0].username, 'carol', 'depth-2 reply');
assert.equal(parsed[0].replies![1].username, 'dave');
assert.equal(parsed[1].username, 'erin');
assert.equal(parsed[1].karma, undefined);

// Plain markdown without our format stays untouched
const plain = '# Hello\n\nSome text\n\n## Comments\n\nNot our format, just prose.';
const r = splitExportedComments(plain);
assert.equal(r.comments.length, 0);
assert.equal(r.body, plain);
assert.equal(parseFrontmatter('no frontmatter here'), null);

// Inline list + BOM
const inl = parseFrontmatter('﻿---\ntags: [a, "b c", d]\n---\nbody');
assert.deepEqual(inl!.meta.tags, ['a', 'b c', 'd']);
assert.equal(inl!.body, 'body');

// ---- tag helpers --------------------------------------------------------
assert.equal(obsidianTag('AI Safety'), 'ai-safety');
assert.equal(obsidianTag('  weird, #chars!  '), 'weird-chars');
assert.deepEqual(parseTagInput('AI, article, Ai , nosync, econ,,'), ['ai', 'econ']);
assert.deepEqual(
  collectTagCounts([{ tags: ['a', 'b'] } as any, { tags: ['b'] } as any, {} as any]),
  [{ tag: 'b', count: 2 }, { tag: 'a', count: 1 }]
);

console.log('ALL TAG/MARKDOWN TESTS PASSED');
