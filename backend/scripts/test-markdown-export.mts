// Scratch test for the server-side Copy content (services/markdown-export.ts), the URL
// matcher (services/url-match.ts), and the read-token allow-list (services/api-tokens.ts).
// Run from backend/:  npx tsx scripts/test-markdown-export.mts
// Not wired into any build. Needs the frontend's node_modules too: the frontend module is
// imported directly, so the two turndown installs render side by side.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, '..', '..');

// ---- 1. the shared copies are byte-identical to the frontend originals ------------------
const SHARED_FILES = ['markdown.ts', 'format.ts', 'tags.ts', 'types.ts', 'turndown-plugin-gfm.d.ts'];
for (const f of SHARED_FILES) {
  const original = readFileSync(path.join(repo, 'frontend', 'src', f), 'utf8').replace(/\r\n/g, '\n');
  const copy = readFileSync(path.join(repo, 'backend', 'src', 'shared', f), 'utf8').replace(/\r\n/g, '\n');
  assert.equal(
    copy,
    original,
    `backend/src/shared/${f} differs from frontend/src/${f}. Copy the frontend file over (see backend/src/shared/README.md).`
  );
}
console.log(`✅ ${SHARED_FILES.length} shared copies match the frontend originals`);

// ---- 2. the backend renders the same Markdown as the frontend module --------------------
// The backend service installs jsdom's parser itself. The frontend module gets what the
// browser gives it, a global DOMParser (jsdom's here, as in frontend/scripts/test-tags-markdown.mts).
const dom = new JSDOM('');
(globalThis as any).DOMParser = dom.window.DOMParser;

const backend = await import('../src/services/markdown-export.ts');
const frontend = await import('../../frontend/src/markdown.ts');
const { withAudioToken } = await import('../src/services/audio-token.ts');

const comments = [
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

// A row the way pg delivers it: Date objects, a JSONB array for comments, a TEXT[] for tags.
const articleRow: Record<string, unknown> = {
  id: 42,
  type: 'article',
  title: 'The "Quoted" Title: with a colon',
  url: 'https://forum-bots.effectivealtruism.org/posts/abc/some-post',
  content: 'plain fallback',
  html_content: [
    '<h2>Intro</h2>',
    '<p>Body <em>text</em> with a <a href="https://x.y">link</a>.<sup><a href="#fn1">[1]</a></sup></p>',
    '<div class="llm-content-block" data-model-name="Claude Opus 4.6"><p>LLM says hi.</p></div>',
    '<blockquote class="twitter-tweet"><p>tweet text</p><a href="https://twitter.com/x/status/1">link</a></blockquote>',
    '<table><tr><th>a</th><th>b</th></tr><tr><td>1</td><td>2</td></tr></table>',
    '<p><img src="https://x.y/i.png" alt="pic" width="200"></p>',
    '<pre><code class="language-js">const a = 1;</code></pre>',
    '<pre>bare pre with ``` inside</pre>',
    '<p>inline <math><semantics><mrow></mrow><annotation encoding="application/x-tex">x_{i}\dagger</annotation></semantics></math></p>',
    '<figure><img src="https://x.y/cap.png"><figcaption>A cat</figcaption></figure>',
    '<ol class="footnotes"><li id="fn1">Footnote body <a href="#fnref1">^</a></li></ol>',
  ].join(''),
  author: 'Scott Alexander',
  description: '<p>An <b>HTML</b> description   with   spaces</p>',
  audio_url: '/api/content/42/audio',
  transcript: null,
  transcript_words: null,
  duration: null,
  podcast_id: null,
  podcast_show_name: null,
  published_at: new Date('2026-03-14T10:00:00Z'),
  is_starred: false,
  is_archived: false,
  tags: ['ai safety', 'Econ', 'weird#chars!'],
  created_at: new Date('2026-08-01T12:00:00Z'),
  updated_at: new Date('2026-08-01T12:00:00Z'),
  karma: 87,
  comments,
  summary: 'Tweet one.\n\nTweet two with ```backticks``` inside.',
  comment_summary: 'People argued.',
  summary_status: 'completed',
  summary_audio_url: null,
  comment_count: 5,
};

const podcastRow: Record<string, unknown> = {
  id: 7,
  type: 'podcast_episode',
  title: 'Episode One',
  url: 'https://show.example/ep1',
  content: null,
  html_content: null,
  author: 'Host',
  description: '<p>Episode notes with a <a href="https://x.y">link</a>.</p>',
  audio_url: 'https://cdn.example.com/ep1.mp3',
  transcript: 'Welcome to the show. Still minute one. Into minute two.',
  transcript_words: [
    { word: 'Welcome', start: 0.0, end: 0.4 },
    { word: 'to', start: 0.4, end: 0.5 },
    { word: 'the', start: 0.5, end: 0.6 },
    { word: 'show.', start: 0.6, end: 1.0 },
    { word: 'Still', start: 30.0, end: 30.3 },
    { word: 'minute', start: 30.3, end: 30.6 },
    { word: 'one.', start: 30.6, end: 31.0 },
    { word: 'Into', start: 62.5, end: 62.8 },
    { word: 'minute', start: 62.8, end: 63.1 },
    { word: 'two.', start: 63.1, end: 63.5 },
  ],
  duration: 125,
  podcast_id: 3,
  podcast_show_name: 'The Show',
  published_at: new Date('2026-05-01T00:00:00Z'),
  is_starred: true,
  is_archived: false,
  tags: [],
  created_at: new Date('2026-05-02T00:00:00Z'),
  updated_at: new Date('2026-05-02T00:00:00Z'),
  karma: null,
  comments: null,
  summary: 'A summary.',
  comment_summary: null,
  summary_status: 'completed',
  summary_audio_url: null,
  comment_count: 0,
};

// What the browser receives: the same row after withAudioToken and a JSON round trip.
function asBrowserItem(row: Record<string, unknown>): any {
  return JSON.parse(JSON.stringify(withAudioToken(row as any)));
}

const OPTION_SETS: Array<[string, any]> = [
  ['defaults', backend.copyOptionsFromSettings({})],
  ['summary + label', { includeSummary: true, summaryCodeLabel: 'ad-summary', includeCommentSummary: true, includeComments: true }],
  ['summary without comment summary', { includeSummary: true, includeCommentSummary: false, summaryCodeLabel: '', includeComments: true }],
  ['no comments', { includeSummary: true, includeCommentSummary: true, summaryCodeLabel: 'ad-summary', includeComments: false }],
];

let compared = 0;
for (const [label, opts] of OPTION_SETS) {
  for (const [name, row] of [['article', articleRow], ['podcast', podcastRow]] as const) {
    const server = backend.renderItemMarkdown(row, opts);
    const item = asBrowserItem(row);
    const browser = frontend.contentToMarkdown(item, backend.parseComments(item.comments), opts);
    assert.equal(server, browser, `${name} / ${label}: backend and frontend output differ`);
    compared++;
  }
}
// The comments column can also arrive as a JSON string (older rows). Same output.
{
  const stringRow = { ...articleRow, comments: JSON.stringify(comments) };
  assert.equal(backend.renderItemMarkdown(stringRow, {}), backend.renderItemMarkdown(articleRow, {}), 'JSON-string comments render the same');
}
console.log(`✅ ${compared} backend renders are byte-identical to the frontend's contentToMarkdown`);

// Spot checks on the content itself, so a shared regression on both sides is still caught.
const md = backend.renderItemMarkdown(articleRow, OPTION_SETS[1][1]);
assert.ok(md.startsWith('---\ntitle: "The \\"Quoted\\" Title: with a colon"\n'), 'starts with the properties block');
assert.ok(md.includes('source: "https://forum.effectivealtruism.org/posts/abc/some-post"'), 'human EA Forum host in source');
assert.ok(!md.includes('alt-source:'), 'an ordinary article gets no alt-source');
// An item Wallacast read through an archive mirror: the real article is the source, the
// mirror is the alt-source, so the vault files the note under the address it belongs to.
const archivedMd = backend.renderItemMarkdown(
  { ...articleRow, url: 'https://archive.ph/2026.05.01-120000/https://www.wsj.com/paywalled' },
  OPTION_SETS[1][1]
);
assert.ok(archivedMd.includes('source: "https://www.wsj.com/paywalled"'), 'the real article is the source');
assert.ok(archivedMd.includes('alt-source: "https://archive.ph/2026.05.01-120000/https://www.wsj.com/paywalled"'), 'the mirror is the alt-source');
assert.ok(
  archivedMd.indexOf('source: "https://www.wsj.com') < archivedMd.indexOf('alt-source:'),
  'source comes before alt-source'
);
assert.ok(md.includes('\ntags:\n  - article\n  - ai-safety\n  - econ\n  - weirdchars\n'), 'tags list');
assert.ok(md.includes('````ad-summary\nTweet one.'), 'summary block with a longer fence');
assert.ok(md.includes('> [!ai] Claude Opus 4.6'), 'LLM block callout');
assert.ok(md.includes('> [!tweet]'), 'tweet callout');
assert.match(md, /\|\s*a\s*\|\s*b\s*\|\n\|\s*-{3,}\s*\|\s*-{3,}\s*\|\n\|\s*1\s*\|\s*2\s*\|/, 'GFM table');
assert.ok(md.includes('![pic|200](https://x.y/i.png)'), 'image width syntax');
assert.ok(md.includes('```js\nconst a = 1;\n```'), 'fenced code with language');
assert.ok(md.includes('````\nbare pre with ``` inside\n````'), 'bare pre fenced with a longer fence');
assert.ok(md.includes('$x_{i}\dagger$'), 'math as TeX, unescaped');
assert.ok(md.includes('<figure>'), 'small captioned figure kept raw');
assert.ok(md.includes('[^1]') && md.includes('[^1]: Footnote body'), 'footnote reference and definition');
assert.ok(md.includes('title: Comments summary\n\nPeople argued.'), 'comment summary block');
assert.ok(md.includes('# Comments (5)'), 'comments heading with the stored total');
assert.ok(md.includes('**alice • 12 points • 15/03/2026**'), 'comment header');
assert.ok(md.includes('> **bob • -1 points • 16/03/2026**'), 'nested reply as a quote');
const pod = backend.renderItemMarkdown(podcastRow, {});
assert.ok(pod.includes('audio: "https://cdn.example.com/ep1.mp3"'), 'podcast audio property');
assert.ok(pod.includes('show: "The Show"') && pod.includes('duration: "2m"'), 'show and duration');
assert.ok(pod.includes('**[00:00]** Welcome to the show. Still minute one.\n\n**[01:02]** Into minute two.'), 'timestamped transcript');
console.log('✅ rendered Markdown spot checks pass');

// ---- 2b. every footnote shape survives ---------------------------------------------------
// Sites mark footnotes up in three different ways, and all three must come out as real
// Markdown definitions. Checked through BOTH copies, because this is exactly the kind of
// bug that hides behind a fixture covering only one shape.
const sharedMarkdown = await import('../src/shared/markdown.ts');

const FOOTNOTE_SHAPES: Array<[string, string, RegExp[]]> = [
  [
    // Substack hangs the id on the little number link, not on the note. Reading the id
    // element directly gives the digit "1" and leaves the note loose in the body.
    'substack',
    '<p>A claim<a href="#footnote-1" id="footnote-anchor-1" class="footnote-anchor">1</a>.</p>' +
    '<div data-component-name="FootnoteToDOM" class="footnote">' +
    '<a id="footnote-1" href="#footnote-anchor-1" contenteditable="false" class="footnote-number">1</a>' +
    '<div class="footnote-content"><p><span> Compaction summaries are notes to a future self.</span></p></div>' +
    '</div>',
    [/^A claim\[\^1\]\.$/m, /^\[\^1\]: Compaction summaries are notes to a future self\.$/m],
  ],
  [
    // LessWrong / EA Forum put the id on the <li> that holds the text.
    'lesswrong',
    '<p>A claim<sup><a href="#fn1">[1]</a></sup>.</p>' +
    '<ol class="footnotes"><li id="fn1">First note body. <a href="#fnref1">^</a></li></ol>',
    [/^A claim\[\^1\]\.$/m, /^\[\^1\]: First note body\.$/m],
  ],
  [
    // Distill-style articles (alignment.anthropic.com) have no marker and no anchor at all,
    // just an inline custom element. Turndown unwraps unknown tags, so without help the note
    // reads as part of the sentence it interrupts.
    'd-footnote',
    '<p>We fixed the environments<d-footnote>All of them have since been removed.</d-footnote>.</p>',
    [/^We fixed the environments\[\^1\]\.$/m, /^\[\^1\]: All of them have since been removed\.$/m],
  ],
  [
    // What markdownToHtml rebuilds after an edit in the app, so an edited item still exports.
    'canonical',
    '<p>A claim<sup class="footnote-ref" id="fnref-1"><a href="#fn-1">[1]</a></sup>.</p>' +
    '<section class="footnotes"><hr><ol><li id="fn-1">Rebuilt body. <a href="#fnref-1" class="footnote-backref">↩</a></li></ol></section>',
    [/^A claim\[\^1\]\.$/m, /^\[\^1\]: Rebuilt body\.$/m],
  ],
];

for (const [name, html, expectations] of FOOTNOTE_SHAPES) {
  const viaFrontend = frontend.htmlToMarkdown(html);
  const viaBackend = sharedMarkdown.htmlToMarkdown(html);
  assert.equal(viaBackend, viaFrontend, `${name}: the two copies disagree`);
  for (const re of expectations) {
    assert.match(viaBackend, re, `${name}: ${re}`);
  }
  assert.ok(!/^\[\^\d+\]: \d+$/m.test(viaBackend), `${name}: a definition is just a digit`);
}
console.log(`✅ ${FOOTNOTE_SHAPES.length} footnote shapes convert correctly in both copies`);

// ---- 3. copy options and the index description -------------------------------------------
assert.deepEqual(backend.copyOptionsFromSettings({}), {
  includeSummary: false, includeCommentSummary: true, summaryCodeLabel: '', includeComments: true,
}, 'defaults match frontend/src/copy-settings.ts');
assert.deepEqual(backend.copyOptionsFromSettings({
  copy_include_summary: 'true', copy_include_comment_summary: 'false',
  copy_summary_code_label: ' ad-summary ', copy_include_comments: 'false',
}), { includeSummary: true, includeCommentSummary: false, summaryCodeLabel: 'ad-summary', includeComments: false });
assert.equal(backend.shortDescription('<p>Hello <b>world</b> &amp; friends</p>'), 'Hello world & friends');
assert.equal(backend.shortDescription('x'.repeat(400)), 'x'.repeat(300), 'cut to 300');
assert.equal(backend.shortDescription('Text <a href="https://ex'), 'Text', 'a cut-off opening tag is dropped');
assert.equal(backend.shortDescription(null), null);
assert.equal(backend.shortDescription('<p></p>'), null, 'nothing left after stripping');
assert.deepEqual(backend.parseComments('[{"username":"a","content":"b"}]'), [{ username: 'a', content: 'b' }]);
assert.deepEqual(backend.parseComments('not json'), []);
assert.deepEqual(backend.parseComments(null), []);
assert.deepEqual(backend.parseComments({ not: 'an array' }), []);
console.log('✅ copy options, index description, comment parsing');

// ---- 4. URL matching ---------------------------------------------------------------------
const { humanUrl, normalizeUrlForMatch, pickItemByUrl, findItem } = await import('../src/services/url-match.ts');
// findItem takes whole rows; these older cases only care about the url fields.
const asRows = (list: readonly any[]) => list.map((c) => ({ audio_url: null, title: null, ...c }));
const pickItemByUrls = (list: readonly any[], urls: readonly string[]) => {
  const m = findItem(asRows(list), { urls });
  return m ? { item: m.item, matchedUrl: m.value } : null;
};
assert.equal(humanUrl('https://forum-bots.effectivealtruism.org/posts/x'), 'https://forum.effectivealtruism.org/posts/x');
assert.equal(humanUrl('https://example.com/a'), 'https://example.com/a');
assert.equal(humanUrl('wallacast://3f1c'), null, 'synthetic address');
assert.equal(humanUrl(null), null);
assert.equal(humanUrl(''), null);

const n = normalizeUrlForMatch;
assert.equal(n('http://WWW.Example.com/Post/'), n('https://example.com/Post'), 'scheme, www, host case, trailing slash');
assert.equal(n('https://example.com/post#section'), n('https://example.com/post'), 'fragment dropped');
assert.equal(n('https://example.com/post?utm_source=x&fbclid=1&ref=tw&id=7'), n('https://example.com/post?id=7'), 'tracking parameters dropped, real ones kept');
assert.notEqual(n('https://example.com/post?id=7'), n('https://example.com/post?id=8'), 'a real query parameter still tells pages apart');
assert.equal(n('https://forum-bots.effectivealtruism.org/posts/x'), n('https://forum.effectivealtruism.org/posts/x'), 'EA mirror equals the human host');
assert.equal(n('  not a url  '), 'not a url', 'a non-URL compares as trimmed lowercase');
assert.equal(n('https://example.com/Path'), 'example.com/Path', 'path case is kept');

const items = [
  { id: 1, url: 'https://example.com/a', is_archived: true, created_at: '2026-01-01T00:00:00Z' },
  { id: 2, url: 'https://example.com/a', is_archived: false, created_at: '2026-01-02T00:00:00Z' },
  { id: 3, url: 'https://example.com/a', is_archived: false, created_at: '2026-01-03T00:00:00Z' },
  { id: 4, url: 'https://www.example.com/b/', is_archived: false, created_at: '2026-01-01T00:00:00Z' },
  { id: 5, url: 'https://forum-bots.effectivealtruism.org/posts/p/slug', is_archived: false, created_at: '2026-01-01T00:00:00Z' },
  { id: 6, url: 'wallacast://abc', is_archived: false, created_at: '2026-01-01T00:00:00Z' },
  { id: 7, url: null, is_archived: false, created_at: '2026-01-01T00:00:00Z' },
  { id: 8, url: 'https://example.com/c', is_archived: true, created_at: '2026-01-05T00:00:00Z' },
  { id: 9, url: 'http://example.com/c/', is_archived: false, created_at: '2026-01-01T00:00:00Z' },
];
assert.equal(pickItemByUrl(items, 'https://example.com/a')!.id, 3, 'duplicates: not archived first, then newest');
assert.equal(pickItemByUrl(items, 'http://example.com/b?utm_source=x')!.id, 4, 'normalised match');
assert.equal(pickItemByUrl(items, 'https://forum.effectivealtruism.org/posts/p/slug')!.id, 5, 'human EA URL finds the stored mirror URL');
assert.equal(pickItemByUrl(items, 'https://forum-bots.effectivealtruism.org/posts/p/slug')!.id, 5, 'mirror URL too');
assert.equal(pickItemByUrl(items, 'https://example.com/c')!.id, 8, 'an exact match wins over a normalised one');
assert.equal(pickItemByUrl(items, 'http://example.com/c/')!.id, 9, 'exact match on the other spelling');
assert.equal(pickItemByUrl(items, 'wallacast://abc'), null, 'synthetic addresses never match');
assert.equal(pickItemByUrl(items, 'https://example.com/none'), null, 'no match');
assert.equal(pickItemByUrl(items, '   '), null, 'blank query');
assert.equal(pickItemByUrl(items, 'https://archive.ph/2026.05.01-120000/https://example.com/a')!.id, 3, 'an archive URL finds the item stored under its original');
console.log('✅ URL identity: human form, normalisation, duplicate rule');

// Several URLs for one article (a note's `source` plus its `alt-source`).
const multi = [
  { id: 10, url: 'https://forum-bots.effectivealtruism.org/posts/p/crosspost', is_archived: false, created_at: '2026-02-01T00:00:00Z' },
  { id: 11, url: 'https://archive.is/2026.05.01-120000/https://www.wsj.com/paywalled', is_archived: false, created_at: '2026-02-02T00:00:00Z' },
  { id: 12, url: 'https://example.com/plain', is_archived: false, created_at: '2026-02-03T00:00:00Z' },
];
// The crosspost case: the vault filed it under Substack, Wallacast has the EA Forum copy.
assert.equal(
  pickItemByUrls(multi, ['https://author.substack.com/p/crosspost', 'https://forum.effectivealtruism.org/posts/p/crosspost'])!.item.id,
  10,
  'the second URL finds the item when the first does not'
);
// The archive case: the note keeps the real article in `source` and the mirror in `alt-source`.
assert.equal(pickItemByUrls(multi, ['https://www.wsj.com/paywalled'])!.item.id, 11, 'the real article finds the stored mirror');
assert.equal(
  pickItemByUrls(multi, ['https://www.wsj.com/paywalled', 'https://archive.is/2026.05.01-120000/https://www.wsj.com/paywalled'])!.matchedUrl,
  'https://www.wsj.com/paywalled',
  'the first given URL wins and is reported back'
);
assert.equal(pickItemByUrls(multi, ['https://nowhere.example/x', 'https://example.com/plain'])!.item.id, 12);
assert.equal(pickItemByUrls(multi, ['https://a.example/x', 'https://b.example/y']), null, 'no URL matches');
assert.equal(pickItemByUrls(multi, []), null, 'no URLs given');
console.log('✅ multi-URL lookup (source + alt-source)');

// A podcast episode is stored with NO url, so its media file is the only address it has,
// and a pasted text has neither, leaving only its title.
const mixed = [
  { id: 20, url: 'https://example.com/article', audio_url: '/api/content/20/audio', title: 'An Article', is_archived: false, created_at: '2026-03-01T00:00:00Z' },
  { id: 21, url: null, audio_url: 'https://media.transistor.fm/de837028/aef571fd.mp3', title: 'Why AI Hacking Is Becoming Hard to Control', is_archived: false, created_at: '2026-03-02T00:00:00Z' },
  { id: 22, url: null, audio_url: null, title: 'AI 2040: Plan A', is_archived: false, created_at: '2026-03-03T00:00:00Z' },
  { id: 23, url: null, audio_url: null, title: 'AI 2040: Plan A', is_archived: true, created_at: '2026-03-04T00:00:00Z' },
];
assert.deepEqual(
  (({ item, by, value }) => ({ id: item.id, by, value }))(findItem(mixed, { audioUrls: ['https://media.transistor.fm/de837028/aef571fd.mp3'] })!),
  { id: 21, by: 'audio', value: 'https://media.transistor.fm/de837028/aef571fd.mp3' },
  'an episode is found by its media file'
);
assert.equal(
  findItem(mixed, { audioUrls: ['https://media.transistor.fm/de837028/aef571fd.mp3?utm_source=x'] })!.item.id,
  21,
  'a tracking parameter on the media file does not stop the match'
);
assert.equal(findItem(mixed, { audioUrls: ['https://media.transistor.fm/other.mp3'] }), null, 'a different episode does not match');
assert.equal(
  findItem(mixed, { titles: ['ai 2040: plan a'] })!.item.id,
  22,
  'a text is found by title, case-insensitively, and the copy that is not archived wins'
);
assert.equal(findItem(mixed, { titles: ['  An Article  '] })!.by, 'title', 'a padded title still matches and reports how');
assert.equal(findItem(mixed, { titles: ['No Such Note'] }), null);
// Order: url beats audio beats title, so the strongest identifier a note carries wins.
assert.equal(
  findItem(mixed, { urls: ['https://example.com/article'], audioUrls: ['https://media.transistor.fm/de837028/aef571fd.mp3'], titles: ['AI 2040: Plan A'] })!.by,
  'url',
  'url wins over audio and title'
);
assert.equal(
  findItem(mixed, { audioUrls: ['https://media.transistor.fm/de837028/aef571fd.mp3'], titles: ['AI 2040: Plan A'] })!.by,
  'audio',
  'audio wins over title'
);
assert.equal(findItem(mixed, {}), null, 'nothing given, nothing found');
assert.equal(findItem(mixed, { urls: [''], audioUrls: ['  '], titles: [''] }), null, 'blank identifiers are ignored');
// An article's own generated narration must never be reachable as an "episode" address.
assert.equal(findItem(mixed, { audioUrls: ['/api/content/20/audio'] })!.item.id, 20, 'an exact internal audio path still matches, the route never sends one');
console.log('✅ podcast (audio) and text (title) lookup');

// ---- 4b. archive mirrors: the original URL, and the two source properties ----------------
const { archivedOriginalUrl, sourceUrls } = await import('../src/shared/format.ts');
const { isArchiveMirrorUrl } = await import('../src/services/article-fetcher.ts');
assert.equal(
  archivedOriginalUrl('https://archive.ph/2026.05.01-120000/https://www.wsj.com/x?a=1'),
  'https://www.wsj.com/x?a=1',
  'the original keeps its own query string'
);
assert.equal(
  archivedOriginalUrl('https://archive.is/newest/https%3A%2F%2Fwww.wsj.com%2Fx'),
  'https://www.wsj.com/x',
  'percent-encoded target decoded'
);
assert.equal(archivedOriginalUrl('https://archive.is/aBc12'), null, 'a short-code snapshot carries no original');
assert.equal(archivedOriginalUrl('https://example.com/a'), null, 'not an archive host');
assert.equal(archivedOriginalUrl('not a url'), null);
assert.equal(archivedOriginalUrl(null), null);
assert.equal(archivedOriginalUrl('https://archive.is/2026/https://archive.ph/xyz'), null, 'a snapshot of a snapshot is not unwrapped');
// The two host lists must agree, they are maintained in two files.
for (const host of ['archive.is', 'archive.ph', 'archive.today', 'archive.li', 'archive.vn', 'archive.fo', 'archive.md', 'www.archive.is']) {
  assert.equal(
    archivedOriginalUrl(`https://${host}/2026/https://x.example/a`),
    'https://x.example/a',
    `${host} recognised by shared/format.ts`
  );
  assert.ok(isArchiveMirrorUrl(`https://${host}/abc`), `${host} recognised by article-fetcher.ts`);
}
for (const host of ['example.com', 'archiveis.com', 'notarchive.is.example.com', 'web.archive.org']) {
  assert.equal(archivedOriginalUrl(`https://${host}/2026/https://x.example/a`), null, `${host} is not an archive mirror here`);
  assert.equal(isArchiveMirrorUrl(`https://${host}/abc`), false, `${host} is not an archive mirror in the fetcher either`);
}
assert.deepEqual(sourceUrls('https://example.com/a'), { source: 'https://example.com/a', altSource: null });
assert.deepEqual(sourceUrls('https://forum-bots.effectivealtruism.org/posts/x'), {
  source: 'https://forum.effectivealtruism.org/posts/x',
  altSource: null,
}, 'the EA mirror is still rewritten, and is not an alt-source');
assert.deepEqual(sourceUrls('https://archive.ph/2026/https://www.wsj.com/x'), {
  source: 'https://www.wsj.com/x',
  altSource: 'https://archive.ph/2026/https://www.wsj.com/x',
}, 'the real article becomes source, the mirror becomes alt-source');
assert.deepEqual(sourceUrls('https://archive.is/aBc12'), { source: 'https://archive.is/aBc12', altSource: null }, 'an unrecoverable snapshot stays the source');
assert.deepEqual(sourceUrls('wallacast://abc'), { source: null, altSource: null });
assert.deepEqual(sourceUrls(null), { source: null, altSource: null });
console.log('✅ archive originals and the source / alt-source pair');

// ---- 5. read-token allow-list and token format ------------------------------------------
const { isReadTokenAllowed, generateApiToken, isApiToken, hashApiToken } = await import('../src/services/api-tokens.ts');
const allowed: Array<[string, string]> = [
  ['GET', '/api/content/index'],
  ['GET', '/api/content/index?x=1'],
  ['GET', '/api/content/index/'],
  ['GET', '/api/content/markdown?url=https%3A%2F%2Fa.b%2Fc'],
  ['GET', '/api/content/123/markdown'],
  ['HEAD', '/api/content/index'],
];
const denied: Array<[string, string]> = [
  ['GET', '/api/content'],
  ['GET', '/api/content/123'],
  ['GET', '/api/content/123/export'],
  ['GET', '/api/content/abc/markdown'],
  ['GET', '/api/content/123/markdown/x'],
  ['GET', '/api/content/tags/all'],
  ['GET', '/api/users/settings'],
  ['GET', '/api/auth/tokens'],
  ['GET', '/api/auth/me'],
  ['GET', '/api/wallabag/status'],
  ['GET', '/api/queue'],
  ['POST', '/api/content/index'],
  ['POST', '/api/content/status'],
  ['DELETE', '/api/content/123'],
  ['PATCH', '/api/content/123'],
  ['GET', ''],
];
for (const [m, p] of allowed) assert.ok(isReadTokenAllowed(m, p), `${m} ${p} must be allowed`);
for (const [m, p] of denied) assert.ok(!isReadTokenAllowed(m, p), `${m} ${p} must be denied`);
const tok = generateApiToken();
assert.match(tok, /^wcr_[0-9a-f]{40}$/, 'token format');
assert.ok(isApiToken(tok) && !isApiToken('eyJhbGciOiJIUzI1NiJ9.x.y'), 'token vs JWT detection');
assert.match(hashApiToken(tok), /^[0-9a-f]{64}$/, 'sha256 hex');
assert.notEqual(generateApiToken(), tok, 'random');
console.log('✅ read-token allow-list and token format');

// ---- 6. file names inside the bulk Copy content zip ----------------------------------------
const { markdownFileName, uniqueFileName } = backend;
assert.equal(markdownFileName('Plain title'), 'Plain title.md');
assert.equal(
  markdownFileName('Café: "quoted" / slashed * star? [x] #y ^z | pipe <b>'),
  'Café quoted slashed star x y z pipe b.md',
  'forbidden characters dropped, Unicode kept'
);
assert.equal(markdownFileName('   '), 'Untitled.md');
assert.equal(markdownFileName(null), 'Untitled.md');
assert.equal(markdownFileName('Ends with dots...'), 'Ends with dots.md');
assert.equal(markdownFileName('x'.repeat(200)).length, 120 + 3, 'capped at 120 characters plus .md');
const used = new Set<string>();
assert.equal(uniqueFileName('A.md', used), 'A.md');
assert.equal(uniqueFileName('a.md', used), 'a (2).md', 'case-insensitive duplicates');
assert.equal(uniqueFileName('A.md', used), 'A (3).md');
assert.equal(uniqueFileName('A (2).md', used), 'A (2) (2).md', 'a real title that looks like a suffix still gets its own name');
assert.equal(uniqueFileName('B.md', used), 'B.md');
console.log('✅ zip file names');

console.log('\nALL MARKDOWN EXPORT / URL MATCH / TOKEN TESTS PASSED');
