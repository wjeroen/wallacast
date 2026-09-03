// Scratch test for the Obsidian-properties export/import round trip and the tag helpers.
// Run: npx tsx scripts/test-tags-markdown.mts   (needs: npm i --no-save jsdom tsx)
// Not wired into any build.
import { JSDOM } from 'jsdom';
import assert from 'node:assert/strict';

const dom = new JSDOM('');
(globalThis as any).DOMParser = dom.window.DOMParser;
(globalThis as any).document = dom.window.document;

const { contentToMarkdown, htmlToMarkdown, parseFrontmatter, splitExportedComments, splitExportedSummary, stripLeadingTitle } =
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
assert.ok(md.includes('````\n\n# The'), 'the title follows the summary block, nothing between them');
assert.ok(
  md.includes('```ad-summary\ntitle: Comments summary\n\nPeople argued.\n```\n\n# Comments (3)'),
  'comment summary block sits directly above the comments heading, opened by a callout title line'
);
assert.ok(!/^## Comments/m.test(md), 'the comments heading uses one hash');
assert.ok(!md.includes('By Scott Alexander'), 'old meta line gone');

const noComments = contentToMarkdown(item, comments, { includeComments: false });
assert.ok(!/^#{1,2} Comments/m.test(noComments), 'comments toggle off');
assert.ok(noComments.includes('comments: 3'), 'count property stays');
// With the comments left out, the summary still closes the note rather than disappearing.
const summaryNoComments = contentToMarkdown(item, comments, { includeSummary: true, includeComments: false });
assert.ok(summaryNoComments.trimEnd().endsWith('People argued.\n```'), 'comment summary survives without the comments section');
const noCommentSummary = contentToMarkdown(item, comments, { includeSummary: true, includeCommentSummary: false });
assert.ok(noCommentSummary.includes('Tweet one.') && !noCommentSummary.includes('Comments summary'), 'comment summary toggle off keeps the summary');

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
assert.ok(!sum.body.includes('Comments summary'), 'the comment summary block is gone from the body');
assert.ok(/^# Comments \(3\)$/m.test(sum.body), 'the comments section itself is untouched');
assert.deepEqual(splitExportedSummary('# No summary\n\n```js\ncode\n```'), { body: '# No summary\n\n```js\ncode\n```' }, 'a code block that is not first is left alone');

// A note exported before 2026-09-01: both summaries at the top, "Comments summary:" marker,
// "## Comments" heading. Still round-trips, so an old vault note imports correctly.
const legacy = [
  '```ad-summary', 'Old summary.', '```', '',
  '```ad-summary', 'Comments summary:', '', 'Old comment summary.', '```', '',
  '# Old Title', '', 'Body text.', '',
  '## Comments (1)', '', '**alice • 3 points • 15/03/2026**', '', 'Hi.',
].join('\n');
const legacySplit = splitExportedSummary(legacy);
assert.equal(legacySplit.summary, 'Old summary.', 'legacy summary imported');
assert.equal(legacySplit.comment_summary, 'Old comment summary.', 'legacy comment summary imported');
assert.ok(legacySplit.body.startsWith('# Old Title'), 'legacy body starts at the title');
assert.equal(splitExportedComments(legacySplit.body).comments.length, 1, 'legacy two-hash comments heading still parses');

// A real code block in the article body must never be taken for the comment summary.
const codeInBody = '```ad-summary\nReal summary.\n```\n\n# T\n\n```js\nconst x = 1;\n```\n\n# Comments (1)\n\n**a • 1 points • 15/03/2026**\n\nHi.';
const codeSplit = splitExportedSummary(codeInBody);
assert.equal(codeSplit.comment_summary, undefined, 'an ordinary code block is not a comment summary');
assert.ok(codeSplit.body.includes('const x = 1;'), 'the ordinary code block stays in the body');

const body1 = stripLeadingTitle(sum.body, fm!.meta.title as string);
assert.ok(!body1.trimStart().startsWith('# '), 'leading H1 stripped');

const { body, comments: parsed } = splitExportedComments(body1);
assert.ok(!/^#{1,2} Comments/m.test(body), 'comments section removed from body');
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

// ---- podcast export: audio property + timestamped transcript ------------
const podWords = [
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
];
const pod: any = {
  id: 7,
  type: 'podcast_episode',
  title: 'Episode One',
  podcast_show_name: 'The Show',
  audio_url: 'https://cdn.example.com/ep1.mp3',
  duration: 125,
  description: '<p>Episode notes.</p>',
  transcript: 'Welcome to the show. Still minute one. Into minute two.',
  // The transcript_words column is JSONB, so the real API delivers a parsed ARRAY,
  // not a JSON string. The array shape is the primary fixture on purpose: the first
  // release only handled strings and silently fell back to the plain transcript in
  // production while this test passed on a stringified fixture.
  transcript_words: podWords,
  tags: [],
};
const podMd = contentToMarkdown(pod, []);
assert.ok(podMd.includes('audio: "https://cdn.example.com/ep1.mp3"'), 'direct audio link in properties');
assert.ok(
  podMd.includes('## Transcript\n\n**[00:00]** Welcome to the show. Still minute one.\n\n**[01:02]** Into minute two.'),
  'one paragraph per minute, marker shows the real start of its first sentence'
);
assert.ok(!md.includes('\naudio:'), 'articles get no audio property');

// A JSON string (and even a double-stringified one) produces the same output.
const podString = contentToMarkdown({ ...pod, transcript_words: JSON.stringify(podWords) }, []);
assert.ok(podString.includes('**[00:00]** Welcome to the show. Still minute one.'), 'JSON-string shape works too');
const podDouble = contentToMarkdown({ ...pod, transcript_words: JSON.stringify(JSON.stringify(podWords)) }, []);
assert.ok(podDouble.includes('**[00:00]** Welcome to the show. Still minute one.'), 'double-stringified shape works too');

// Without word timestamps the plain transcript is kept, unchanged.
const podPlain = contentToMarkdown({ ...pod, transcript_words: undefined }, []);
assert.ok(podPlain.includes('## Transcript\n\nWelcome to the show. Still minute one. Into minute two.'), 'plain fallback');
assert.ok(!podPlain.includes('**['), 'no markers without word data');

// Past one hour the markers grow an hour digit.
const podHour = contentToMarkdown(
  { ...pod, transcript: 'Late.', transcript_words: JSON.stringify([{ word: 'Late.', start: 3725, end: 3726 }]) },
  []
);
assert.ok(podHour.includes('**[1:02:05]** Late.'), 'h:mm:ss past the first hour');

// Broken JSON falls back instead of crashing.
const podBroken = contentToMarkdown({ ...pod, transcript_words: 'not json' }, []);
assert.ok(podBroken.includes('## Transcript\n\nWelcome to the show.'), 'broken word JSON falls back to plain');

// ---- export preprocessing: math, bare <pre>, giant figures ---------------
// arXiv-style math keeps its original TeX, unescaped (backslashes and underscores intact).
const mathMd = htmlToMarkdown(
  '<p>inline <math><semantics><mrow></mrow><annotation encoding="application/x-tex">x_{i}\\dagger</annotation></semantics></math> and</p>' +
  '<math display="block"><semantics><annotation encoding="application/x-tex">Y=\\sum_{i} x_{i}</annotation></semantics></math>'
);
assert.ok(mathMd.includes('$x_{i}\\dagger$'), 'inline math as $TeX$, backslash not escaped');
assert.ok(mathMd.includes('$$Y=\\sum_{i} x_{i}$$'), 'display math as $$TeX$$');

// A LaTeX equation layout table unwraps so the $$ is not trapped in a raw HTML island.
const eqMd = htmlToMarkdown(
  '<table class="ltx_equation"><tbody><tr><td></td><td><math display="block"><semantics><annotation encoding="application/x-tex">a=b</annotation></semantics></math></td><td>(1)</td></tr></tbody></table>'
);
assert.ok(eqMd.includes('$$a=b$$'), 'equation table unwraps to display math');
assert.ok(!eqMd.includes('<table'), 'no raw equation table left');

// A bare <pre> (no <code> child, e.g. arXiv verbatim prompts) becomes a real fenced block,
// and a fence inside the content grows the outer fence instead of ending it early.
const preMd = htmlToMarkdown('<pre>line one\n    indented\ncontains ``` fence</pre>');
assert.ok(
  preMd.startsWith('````\nline one\n    indented\ncontains ``` fence\n````'),
  'bare pre fenced with a longer fence'
);

// A pre>code block keeps working and keeps its language.
const codeMd = htmlToMarkdown('<pre><code class="language-js">const a = 1;</code></pre>');
assert.ok(codeMd.includes('```js\nconst a = 1;\n```'), 'pre>code stays a fenced block with language');

// A small captioned figure is still kept as a raw HTML island (the rule it was built for).
const smallFig = '<figure><img src="https://x.y/i.png"><figcaption>A cat</figcaption></figure>';
assert.ok(htmlToMarkdown(smallFig).includes('<figure>'), 'small captioned figure stays raw');

// A giant widget figure is reduced to image + caption; the scaffolding never reaches the note.
const giantFig =
  '<figure><div class="widget" style="white-space:nowrap">' + '<span>noise</span>'.repeat(120) +
  '</div><img src="https://x.y/chart.png"><figcaption>Figure 3: results</figcaption></figure>';
assert.ok(giantFig.length > 1500, 'fixture really is over the cap');
const giantMd = htmlToMarkdown(giantFig);
assert.ok(!giantMd.includes('<figure'), 'giant figure not kept raw');
assert.ok(!giantMd.includes('noise'), 'widget scaffolding dropped');
assert.ok(giantMd.includes('![](https://x.y/chart.png)'), 'the image survives');
assert.ok(giantMd.includes('Figure 3: results'), 'the caption survives');

// A giant figure with no image, table, or caption leaves a visible omission note.
const widgetOnly = '<figure><div>' + '<b>w</b>'.repeat(300) + '</div></figure>';
assert.ok(
  htmlToMarkdown(widgetOnly).includes('Interactive figure omitted, see the original page'),
  'omission note for a widget-only figure'
);

// ---- tag helpers --------------------------------------------------------
assert.equal(obsidianTag('AI Safety'), 'ai-safety');
assert.equal(obsidianTag('  weird, #chars!  '), 'weird-chars');
assert.deepEqual(parseTagInput('AI, article, Ai , nosync, econ,,'), ['ai', 'econ']);
assert.deepEqual(
  collectTagCounts([{ tags: ['a', 'b'] } as any, { tags: ['b'] } as any, {} as any]),
  [{ tag: 'b', count: 2 }, { tag: 'a', count: 1 }]
);

console.log('ALL TAG/MARKDOWN TESTS PASSED');
