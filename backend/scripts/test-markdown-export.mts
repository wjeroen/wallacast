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
const { humanUrl, normalizeUrlForMatch, pickItemByUrl } = await import('../src/services/url-match.ts');
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
console.log('✅ URL identity: human form, normalisation, duplicate rule');

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

console.log('\nALL MARKDOWN EXPORT / URL MATCH / TOKEN TESTS PASSED');
