// Scratch test for the fetch cleanups in article-fetcher.ts:
//   0.  the JSON-LD author fallback, Tufte sidenotes, (0c) the story box, share links,
//       comment areas, archive date and lead photo, (0d) bot walls, paywall previews,
//       Substack notes and blog post boxes, (0e) page-layout styles, (0f) print-hidden
//       parts and empty video players, (0g) consent gates, login forms, captchas and
//       empty pages, (0h) paid previews and archive.ph timemaps, and (0i) teaser copies and
//       the error without an archive link, all on small fixtures (no network)
//   1.  the <main>-inside-<article> preference and the share-menu removal (live Compact fetch)
//   2.  archive.is paragraph restore (runs on a stored export, no network)
//   3.  the widened email-table flattener (runs on a stored export, no network)
//
// Run from backend/:  npx tsx scripts/test-fetch-cleanup.mts [investigationDir]
// Without the directory argument, steps 2 and 3 are skipped. Not wired into any build.
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import {
  fetchArticleContent,
  flattenEmailTables,
  restoreArchivedParagraphs,
  normalizeSidenotes,
  isArchiveMirrorUrl,
  authorFromJsonLd,
  isArchiveSnapshot,
  isCommentArea,
  removeCommentAreas,
  removeShareLinks,
  findStoryBody,
  nestedStoryArticle,
  archivedPublishedDate,
  archivedLeadFigure,
  isBotCheckPage,
  isPaywallPreview,
  substackNote,
  blogPostBox,
  stripLayoutStyles,
  removePrintHidden,
  removeEmptyVideoPlayers,
  isLoginWall,
  hasNoText,
  dpgPrivacyGateCallback,
  archiveSubmitUrl,
  isPaidPreview,
  storyTextChars,
  copyProblem,
  noCopyError,
  lightenHtml,
  parsePage,
} from '../src/services/article-fetcher.js';
import { newestArchiveCopy } from '../src/services/url-guard.js';

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

// --- 0b. Tufte sidenotes become a real footnote section ----------------------------
// collusion.wiki holds the whole note inside the sentence and hides the machinery with its
// own stylesheet, which we do not keep: the reader showed bare checkboxes and the note text
// spliced mid-sentence. The markup below is exactly what the page serves.
{
  const body = new JSDOM(
    '<div id="root"><p>These AIs colluded.' +
    '<label for="fn-intro-9" class="margin-toggle sidenote-number" data-n="1"></label>' +
    '<input type="checkbox" id="fn-intro-9" class="margin-toggle">' +
    '<span class="sidenote" data-n="1">However, we believe this is distinct.</span>' +
    ' And they kept going.</p>' +
    '<p>A second claim.' +
    '<label for="fn-intro-4" class="margin-toggle sidenote-number" data-n="†"></label>' +
    '<input type="checkbox" id="fn-intro-4" class="margin-toggle">' +
    '<span class="marginnote">An unnumbered margin note.</span></p></div>'
  ).window.document.querySelector('#root')!;

  normalizeSidenotes(body);
  const html = body.innerHTML;

  assert.equal((html.match(/<input/g) || []).length, 0, 'the toggle checkboxes are gone');
  assert.equal((html.match(/<label/g) || []).length, 0, 'the empty number labels are gone');
  assert.equal((html.match(/class="sidenote"|class="marginnote"/g) || []).length, 0, 'no note is left inline');
  assert.match(
    html,
    /These AIs colluded\.<sup class="footnote-ref" id="fnref-side-1"><a href="#fn-side-1">\[1\]<\/a><\/sup> And they kept going\./,
    'a numbered marker sits where the note was, and the sentence is intact'
  );
  assert.match(html, /<sup class="footnote-ref" id="fnref-side-2">/, 'a dagger note is renumbered like any other');
  assert.match(html, /<section class="footnotes"><hr><ol>/, 'the notes collect into a footnotes section');
  assert.match(
    html,
    /<li id="fn-side-1">However, we believe this is distinct\. <a href="#fnref-side-1" class="footnote-backref">↩<\/a><\/li>/,
    'the note keeps its text and gains a back-link'
  );
  assert.match(html, /<li id="fn-side-2">An unnumbered margin note\./, 'the margin note becomes a footnote too');

  // Nothing to do on a page without sidenotes, and no empty section left behind.
  const plain = new JSDOM('<div id="root"><p>Just prose.</p></div>').window.document.querySelector('#root')!;
  normalizeSidenotes(plain);
  assert.equal(plain.innerHTML, '<p>Just prose.</p>', 'a page without sidenotes is untouched');

  console.log('✅ Tufte sidenotes: 2 notes converted, toggles removed, sentence intact');
}

// --- 0c. Story box, share links, comments, archive date and lead photo -------------
// Shapes taken from five real archive.is copies (FT, the New York Times, the Washington Post,
// The Information and Compact, 2026-09-14): class names gone, every <p> turned into a <div>,
// while ids, aria-labels, datetimes and link addresses survive.
{
  const block = (n: number) => `<div>${'The story goes on here. '.repeat(n)}</div>`; // 24 chars per repeat
  const doc = (html: string) => new JSDOM(html).window.document;
  const snap = (inner: string) =>
    doc(`<div id="HEADER"><time datetime="2026-09-02T21:38:33Z">archived</time></div><div id="CONTENT">${inner}</div>`);

  // FT: the whole page is one <article>, the story a second <article> inside it.
  const ft = doc(
    '<div id="HEADER"><time datetime="2026-09-14T23:43:47Z">archived</time></div>' +
    '<div id="CONTENT"><article id="site-content" role="main">' +
      '<div><figure><picture><img src="/MHqt4/lead.avif" alt="A mural"></picture>' +
        '<figcaption>A visitor passes a mural</figcaption></figure></div>' +
      '<div><ul>' +
        '<li><a href="https://archive.is/o/MHqt4/https://twitter.com/intent/tweet?url=https://www.ft.com/content/x">Time for a pause on x (opens in a new window)</a></li>' +
        '<li><a href="https://archive.is/o/MHqt4/https://www.facebook.com/sharer.php?u=x">Time for a pause on facebook (opens in a new window)</a></li>' +
        '<li><a href="whatsapp://send?text=Time">Time for a pause on whatsapp (opens in a new window)</a></li>' +
      '</ul></div>' +
      '<div><a href="https://archive.is/o/MHqt4/https://www.ft.com/ft-view">The editorial board</a>' +
        '<time datetime="2026-09-14T17:16:35.451Z">7 hours ago</time></div>' +
      '<div>Unlock the White House Watch newsletter for free</div>' +
      `<article id="article-body">${block(25)}${block(25)}${block(25)}</article>` +
      `<div id="o-comments-stream"><main aria-label="Comments Embed">${block(250)}` +
        '<time datetime="2026-09-14T22:49:49Z">59 minutes ago</time></main></div>' +
    '</article></div>'
  );
  const siteContent = ft.querySelector('#site-content')!;
  const storyBody = ft.querySelector('#article-body')!;
  assert.equal(findStoryBody(ft), storyBody, 'FT: the marked story body is found');
  assert.equal(nestedStoryArticle(siteContent), storyBody, 'FT: the story <article> inside the page <article> is found too');
  assert.equal(archivedPublishedDate(ft, '2026-09-14T23:43:47Z'), '2026-09-14T17:16:35.451Z',
    'FT: the byline date, not the archive time and not a comment date');
  assert.equal(isArchiveSnapshot(ft), true, 'a snapshot has the CONTENT box');
  assert.equal(isArchiveSnapshot(doc('<h1>Welcome to nginx!</h1>')), false, 'the nginx placeholder is not a snapshot');
  assert.equal(archivedLeadFigure(ft, storyBody.firstElementChild), ft.querySelector('figure'),
    'FT: the captioned photo before the story is the lead photo');

  const shareBar = ft.querySelector('ul')!.parentElement!;
  assert.equal(removeShareLinks(siteContent), 3, 'FT: all three share links go');
  assert.equal(siteContent.contains(shareBar), false, 'the emptied share bar goes with them');
  assert.ok(siteContent.querySelector('a[href*="ft-view"]'), 'an ordinary link stays');
  assert.equal(removeCommentAreas(siteContent), 1, 'FT: the comment stream goes, its Comments Embed with it');
  assert.ok(!/59 minutes ago/.test(siteContent.textContent || ''), 'no comment text is left');

  // Teaser cards are never the story, nor is a long piece that is a small part of the page,
  // nor a long comment.
  const teasers = doc(`<article id="outer">${block(60)}<article>Teaser one</article><article>Teaser two</article></article>`);
  assert.equal(nestedStoryArticle(teasers.querySelector('#outer')!), null, 'short nested teasers never win');
  const minor = doc(`<article id="outer">${block(250)}<article>${block(50)}</article></article>`);
  assert.equal(nestedStoryArticle(minor.querySelector('#outer')!), null, 'a nested article under half the page text does not win');
  const wordpress = doc(`<article id="post">${block(60)}<div id="comments"><article id="div-comment-1">${block(50)}</article></div></article>`);
  assert.equal(nestedStoryArticle(wordpress.querySelector('#post')!), null, 'a long comment is never the story');

  // Story body markers.
  const nyt = doc(`<div id="CONTENT"><header>${block(10)}</header><section name="articleBody">${block(30)}</section></div>`);
  assert.equal(findStoryBody(nyt), nyt.querySelector('section'), 'the New York Times marker');
  const split = doc(`<div itemprop="articleBody">${block(30)}</div><div>Ad</div><div itemprop="articleBody">${block(30)}</div>`);
  assert.equal(findStoryBody(split), null, 'a body split over two markers is left to the other rules');
  const nestedMarkers = doc(`<div id="article-body"><div itemprop="articleBody">${block(30)}</div></div>`);
  assert.equal(findStoryBody(nestedMarkers), nestedMarkers.querySelector('#article-body'), 'a marker inside a marker is one body');
  assert.equal(findStoryBody(doc('<div id="article-body">Just a teaser.</div>')), null, 'a marker under 500 characters does not count');

  // Archive dates: one candidate only, never a later teaser date.
  assert.equal(archivedPublishedDate(snap('<article><time datetime="2026-08-26T03:01:07-04:00">Aug. 26</time></article>'), '2026-09-01T00:50:36Z'),
    '2026-08-26T07:01:07.000Z', 'NYT: a date with a zone offset is read');
  assert.equal(archivedPublishedDate(snap('<article><time datetime="Sep 1, 2026, 5:40pm PDT">Sep 1</time><time datetime="2026-08-27T21:48:57Z">teaser</time></article>'), '2026-09-02T21:38:33Z'),
    '2026-09-02T00:40:00.000Z', 'The Information: "5:40pm PDT" is read');
  assert.equal(archivedPublishedDate(snap('<article><time datetime="whenever">Soon</time><time datetime="2026-08-27T21:48:57Z">teaser</time></article>'), '2026-09-02T21:38:33Z'),
    null, 'an unreadable first date falls back to the archive time, never to a later teaser date');
  assert.equal(archivedPublishedDate(snap('<article><time datetime="2026-07-23">July 23</time></article>'), '2026-07-23T12:11:40Z'),
    '2026-07-23T12:00:00.000Z', 'Compact: a date without a time becomes noon UTC');
  assert.equal(archivedPublishedDate(snap('<div><time datetime="2026-09-03T09:00:00.000Z">5:00 a.m.</time></div><article>no date</article>'), '2026-09-03T09:21:46Z'),
    '2026-09-03T09:00:00.000Z', 'WaPo: the byline date sits outside the <article>');
  assert.equal(archivedPublishedDate(snap('<article><time datetime="2026-09-10T08:00:00Z">later</time></article>'), '2026-09-02T21:38:33Z'),
    null, 'a date after the archiving itself is rejected');
  assert.equal(archivedPublishedDate(doc('<article><time datetime="2026-08-26">x</time></article>'), null), null, 'not a snapshot, no date');

  // Lead photo: a figure before the story text, never a bare image, never a later figure.
  const wapo = snap(`<figure><div><img src="/8QTe9/lead.webp" alt=""></div></figure><article><div>By Ian Duncan</div>${block(10)}</article>`);
  assert.equal(archivedLeadFigure(wapo, wapo.querySelector('article > div:nth-child(2)')), wapo.querySelector('figure'),
    'WaPo: an unlabelled figure before the story is the lead photo');
  const logoOnly = snap(`<img src="/logo.png" alt=""><article>${block(10)}<figure><img src="/later.jpg"></figure></article>`);
  assert.equal(archivedLeadFigure(logoOnly, logoOnly.querySelector('article > div')), null,
    'a bare logo image never counts, nor a figure after the story start');

  // Share links are judged by their address, nothing else.
  const links = doc(
    '<div id="root"><p>Read <a href="https://x.com/someone/status/123">the post</a> and ' +
    '<a href="mailto:author@example.com">email the author</a>.</p>' +
    '<p><a href="https://box.com/shared/abc">a shared folder</a></p>' +
    '<ul><li><a href="https://www.linkedin.com/sharing/share-offsite/?url=x">LinkedIn</a></li>' +
    '<li><a href="mailto:?subject=Look">Email</a></li>' +
    '<li><a href="https://bsky.app/intent/compose?text=x">Bluesky</a></li></ul></div>'
  ).querySelector('#root')!;
  assert.equal(removeShareLinks(links), 3, 'LinkedIn, the recipient-less mailto and Bluesky go');
  assert.equal(links.querySelector('ul'), null, 'the emptied list goes too');
  assert.equal(links.querySelectorAll('a').length, 3, 'a status link, a real mailto and a box.com link stay');

  const el = (html: string) => doc(html).body.firstElementChild!;
  assert.equal(isCommentArea(el('<div id="comments"></div>')), true, '#comments');
  assert.equal(isCommentArea(el('<div id="coral_thread"></div>')), true, 'a Coral embed');
  assert.equal(
    isCommentArea(el('<ol aria-label="Comments"><li>Karen Weise, Technology reporter: I read the essay twice.</li></ol>')),
    false,
    'an aria-label is never read: the Times labels a reporter note "Comments"'
  );
  assert.equal(isCommentArea(el('<div id="commentary"></div>')), false, '"commentary" is not a comment area');
  assert.equal(isCommentArea(el('<a aria-label="There are 97 comments">97</a>')), false, 'a comment count link is left alone');

  console.log('✅ Story box, share links, comment areas, archive date and lead photo');
}

// --- 0d. Bot walls, paywall previews, Substack notes and blog post boxes -----------
// Shapes from 2026-10-06: wsj.com's DataDome page (HTTP 401) and its Wayback copy, a Substack
// note, and robert.ocallahan.org (no <article> or <main>, the archive list before the post).
{
  const DATADOME = '<html lang="en"><head><title>wsj.com</title><style>#cmsg{animation: A 1.5s;}</style></head>'
    + '<body style="margin:0"><p id="cmsg">Please enable JS and disable any ad blocker</p>'
    + '<script data-cfasync="false">var dd={\'rt\':\'c\'}</script>'
    + '<script data-cfasync="false" src="https://ct.captcha-delivery.com/c.js"></script></body></html>';
  assert.equal(isBotCheckPage(DATADOME), true, 'DataDome block page');

  const ldPaywall = (body: string) => '<html><head><script type="application/ld+json">'
    + '{"@type":"NewsArticle","isAccessibleForFree":false,'
    + '"hasPart":{"@type":"WebPageElement","cssSelector":".paywall","isAccessibleForFree":false}}'
    + `</script></head><body><article><p>Alicja Piecha found her first rogue AI swarm.</p>${body}</article></body></html>`;
  assert.equal(isPaywallPreview(ldPaywall('')), true, 'the paid part is missing: a preview');
  assert.equal(
    isPaywallPreview(ldPaywall(`<div class="paywall"><p>${'The rest of the story. '.repeat(20)}</p></div>`)),
    false,
    'the paid part is there (hidden by CSS on the site): the whole article'
  );
  assert.equal(isPaywallPreview('<html><body><p>No markup at all.</p></body></html>'), false, 'no JSON-LD, no verdict');
  assert.equal(
    isPaywallPreview('<script type="application/ld+json">{ "isAccessibleForFree": false, broken</script>'),
    false,
    'a malformed block is skipped'
  );

  const preloads = {
    feedData: {
      feedItem: {
        comment: {
          name: 'Will MacAskill',
          date: '2026-10-04T17:24:53.856Z',
          body: 'Effective altruism\'s openness to strangeness is a big part of its strength.\n\nMy response:',
          attachments: [
            { type: 'image', imageUrl: 'https://substack-post-media.s3.amazonaws.com/public/images/a.png' },
            { type: 'post', post: { canonical_url: 'https://www.planned-obsolescence.org/p/x', title: 'The attack surprised me' } },
            { type: 'link', linkMetadata: { url: 'javascript:alert(1)', title: 'Never a link' } },
            { type: 'comment', comment: { user: { name: 'Dan Williams' }, body: 'New episode!\n\nI enjoyed it.' } },
            { type: 'video' },
          ],
        },
      },
    },
  };
  const notePage = '<html><head><meta name="author" content="Substack">'
    + `<script>window._preloads = JSON.parse(${JSON.stringify(JSON.stringify(preloads))})</script></head><body>`
    + '<div style="margin-right:420px"><h3>Make money doing the work you believe in</h3>'
    + '<div class="ProseMirror FeedProseMirror"><p>Effective altruism\'s openness to strangeness is a big part of its strength.</p>'
    + '<p>My response:</p></div><h4>Log in or sign up</h4></div></body></html>';
  const noteDoc = new JSDOM(notePage).window.document;
  const note = substackNote(notePage, noteDoc, 'https://substack.com/@willmacaskill/note/c-352811447');
  assert.ok(note, 'a note page is a note');
  assert.equal(note!.title, 'Effective altruism\'s openness to strangeness is a big part of its strength.', 'first line as title');
  assert.equal(note!.author, 'Will MacAskill', 'the note author, not "Substack"');
  assert.equal(note!.publishedDate, '2026-10-04T17:24:53.856Z', 'the note date');
  const noteHtml = note!.content.innerHTML;
  assert.ok(!/Make money|Log in|420px/.test(noteHtml), 'none of the page shell');
  assert.equal(note!.content.querySelectorAll(':scope > p').length, 3, 'two note paragraphs and the post link');
  assert.equal(note!.content.querySelector('figure img')?.getAttribute('src'), 'https://substack-post-media.s3.amazonaws.com/public/images/a.png', 'the image');
  assert.equal(note!.content.querySelector('a[href="https://www.planned-obsolescence.org/p/x"]')?.textContent, 'The attack surprised me', 'the attached post');
  assert.ok(!noteHtml.includes('javascript:'), 'a non-http link is dropped');
  assert.equal(note!.content.querySelector('blockquote strong')?.textContent, 'Dan Williams', 'the quoted note author');
  assert.equal(note!.content.querySelectorAll('blockquote p').length, 3, 'the quoted note author and two paragraphs');
  assert.equal(
    substackNote(notePage, new JSDOM(notePage).window.document, 'https://www.astralcodexten.com/p/an-open-letter'),
    null,
    'a post is not a note'
  );
  const longBody = { feedData: { feedItem: { comment: { name: 'A', body: 'x'.repeat(30) + ' ' + 'y'.repeat(90) + '\nline two' } } } };
  const longPage = `<html><head><script>window._preloads = JSON.parse(${JSON.stringify(JSON.stringify(longBody))})</script></head><body></body></html>`;
  const longNote = substackNote(longPage, new JSDOM(longPage).window.document, 'https://substack.com/@a/note/c-1');
  assert.equal(longNote!.title, 'x'.repeat(30) + '...', 'a long first line is cut at a word');
  assert.equal(longNote!.content.innerHTML, `<p>${'x'.repeat(30)} ${'y'.repeat(90)}<br>line two</p>`, 'without the rendered box, the plain text');

  const blog = (posts: string) => new JSDOM('<body><h1>Eyes Above The Waves</h1><div id="main"><div id="nav"><h2>Archive</h2><ul>'
    + '<li><a href="/2026/09/goodbye-google.html">Goodbye Google</a></li>'.repeat(40)
    + `</ul></div><div id="body">${posts}</div></div></body>`).window.document;
  const post = `<div class="post"><p class="date">Thursday 24 September 2026</p><h2>Goodbye Google</h2><p>${'I resign. '.repeat(60)}</p></div>`;
  assert.equal(blogPostBox(blog(post))?.querySelector('h2')?.textContent, 'Goodbye Google', 'the one post box, not the archive');
  assert.equal(blogPostBox(blog(post + post)), null, 'two posts (a list page) give no box');
  assert.equal(blogPostBox(blog('<div class="post"><p>Short.</p></div>')), null, 'a box under 500 characters does not count');

  console.log('✅ Bot walls, paywall previews, Substack notes and blog post boxes');
}

// --- 0e. Page-layout styles a phone reader cannot carry ----------------------------
{
  const root = new JSDOM('<body>'
    + '<div id="note" style="margin-right: 420px; max-width: var(--feed-page-width)"><p>Note</p></div>'
    + '<div id="wrap" style="position: relative; padding-bottom: 56.25%; height: 0px; overflow: hidden">'
    + '<img id="img" style="position: absolute; top: 0; left: 0; width: 100%; height: 100%"></div>'
    + '<p id="indent" style="margin-left: 40px; font-style: italic">Indented quote</p>'
    + '<div id="wide" style="width: 680px; display: flex; white-space: nowrap; text-align: center">Wide</div>'
    + '<div id="narrow" style="width: 50%; min-width: 120px; display: none">Hidden</div>'
    + '<span id="pre" style="white-space: pre-wrap">a  b</span>'
    + '<figure id="fig" style="width: 56.25%; float: right"><img src="x.png"></figure>'
    + '<div id="only" style="position: absolute; top: 3px">x</div>'
    + '</body>').window.document;
  stripLayoutStyles(root.body);
  const style = (id: string) => root.getElementById(id)!.getAttribute('style');
  assert.equal(style('note'), 'max-width: var(--feed-page-width)', 'the 420px margin goes, max-width stays');
  assert.equal(style('wrap'), 'overflow: hidden', 'the aspect-ratio wrapper loses its position, percentage padding and height');
  assert.equal(style('img'), 'width: 100%; height: 100%', 'an image keeps its own size, not its position');
  assert.equal(style('indent'), 'margin-left: 40px; font-style: italic', 'a small indent and text styling stay');
  assert.equal(style('wide'), 'text-align: center', 'a desktop width, flex and nowrap go');
  assert.equal(style('narrow'), 'width: 50%; min-width: 120px; display: none', 'a percentage width, a small min-width and display none stay');
  assert.equal(style('pre'), 'white-space: pre-wrap', 'pre-wrap stays');
  assert.equal(style('fig'), 'width: 56.25%', 'a figure keeps its percentage width, not its float');
  assert.equal(root.getElementById('only')!.hasAttribute('style'), false, 'an emptied style attribute is removed');
  assert.equal(root.body.textContent, 'NoteIndented quoteWideHiddena  bx', 'no text changes');
  console.log('✅ Page-layout styles');
}

// --- 0f. Print-hidden parts and empty video players ---------------------------------
// The shape of smh.com.au's story box (2026-10-07): ads, a save tooltip and a Brightcove player
// marked noPrint between the paragraphs, and the player's file loaded only by the site's script.
{
  const story = '<p>' + 'Labor is eyeing laws to force tech firms to be transparent. '.repeat(4) + '</p>';
  const doc = new JSDOM('<body><div id="box">'
    + '<div class="container"><div class="adWrapper noPrint" data-testid="ad"><small>Advertisement</small></div></div>'
    + '<div class="noPrint" data-testid="article-actions"><div role="tooltip"><p>You have reached your maximum number of saved items.</p></div></div>'
    + story
    + '<div class="noPrint" data-testid="video"><div><video data-video-id="6405512121112" controls></video>'
    + '<div><span>Loading</span></div></div><p></p></div>'
    + story
    + '<aside class="noPrint" data-testid="related-story"><h2>Related Article</h2></aside>'
    + '</div></body>').window.document;
  const box = doc.getElementById('box')!;
  assert.equal(removePrintHidden(box), 4, 'the ad, the tooltip bar, the player and the related box go');
  assert.equal(box.textContent!.replace(/\s+/g, ' ').trim(), (story + story).replace(/<\/?p>/g, '').trim(), 'only the story text is left');

  const whole = new JSDOM('<body><div id="box"><div class="no-print">' + story + story + '</div><p>Short</p></div></body>').window.document;
  assert.equal(removePrintHidden(whole.getElementById('box')!), 0, 'a story body marked print-hidden stays');

  // Another site's player without print marks: the empty one goes with its "Loading" box, a
  // captioned one keeps its caption, and a video with a file stays.
  const players = new JSDOM('<body><div id="box">' + story
    + '<div id="p1"><div><video data-account="1"></video><div><span>Loading</span></div></div></div>'
    + '<figure id="p2"><div id="p2box"><video></video><span>Play</span></div><figcaption>The prime minister at the United Nations in New York.</figcaption></figure>'
    + '<div id="p3"><video src="clip.mp4" controls></video></div>'
    + '<div id="p4"><video controls><source src="clip.webm" type="video/webm"></video></div>'
    + story + '</div></body>').window.document;
  const pbox = players.getElementById('box')!;
  assert.equal(removeEmptyVideoPlayers(pbox), 2, 'two players without a file go');
  assert.equal(players.getElementById('p1'), null, 'the empty player and its Loading box are gone');
  assert.equal(players.getElementById('p2box'), null, 'the captioned player box is gone');
  assert.ok(players.getElementById('p2')!.querySelector('figcaption'), 'its caption stays');
  assert.ok(players.getElementById('p3')!.querySelector('video'), 'a video with src stays');
  assert.ok(players.getElementById('p4')!.querySelector('video'), 'a video with a <source> stays');
  console.log('✅ Print-hidden parts and empty video players');
}

// --- 0g. Consent gates, login forms, captchas and empty pages ------------------------
// Shapes from 2026-10-07: DPG Media's privacy gate (hln.be, demorgen.be), Roularta's login page
// (knack.be on our server) and AWS WAF's captcha (knack.be from a phone).
{
  const article = 'https://www.hln.be/binnenland/een-artikel~adfc0aaa/';
  const callback = `https://www.hln.be/privacy-gate/accept-tcf2?redirectUri=%2Fbinnenland%2Feen-artikel%7Eadfc0aaa%2F&authId=6eb89096-432c-42ed-a9ed-dc62a84484bf`;
  const gate = `<!DOCTYPE html><html lang='nl'><head><script type="text/javascript">
    const callbackUrl = new URL(decodeURIComponent('${encodeURIComponent(callback)}'))
    window._privacy = window._privacy || [];</script><title>DPG Media Privacy Gate</title></head>
    <body><noscript><iframe title="gtm" src="https://www.googletagmanager.com/ns.html?id=GTM-1"></iframe></noscript>
    <div class="container"><div id="message" class="modal"><img src="logo.svg" alt="dpg media logo"><div aria-busy="true"></div></div></div></body></html>`;
  const gateUrl = 'https://myprivacy.dpgmedia.be/consent?siteKey=Uqxf9TXhjmaG4pbQ&callbackUrl=x';
  assert.equal(dpgPrivacyGateCallback(gateUrl, gate), callback, 'the gate gives its continue link');
  assert.equal(dpgPrivacyGateCallback(article, '<html><title>Een artikel</title><p>Tekst</p></html>'), null, 'an ordinary page has none');
  assert.equal(
    dpgPrivacyGateCallback(gateUrl, gate.replace(encodeURIComponent(callback), encodeURIComponent('https://myprivacy.dpgmedia.be/x'))),
    null,
    'a link back to the gate itself does not count'
  );
  assert.equal(hasNoText(gate), true, 'the gate page has no text');
  assert.equal(hasNoText('<html><head><title>Een artikel met een titel</title></head><body><p>' + 'Woord '.repeat(10) + '</p></body></html>'), false, 'a page with a sentence has text');

  const login = '<html><head><title>Knack</title></head><body><div class="roul-wrapper"><h4>Vul hier je e-mailadres en wachtwoord in om aan te melden:</h4>'
    + '<form><input type="email" name="email"><input type="password" name="password"><button>Aanmelden</button></form>'
    + '<span>Nog geen account? <a href="/register">Maak er snel één aan.</a></span></div></body></html>';
  assert.equal(isLoginWall(login), true, 'a short page with a password field is a login form');
  const articleWithDialog = login.replace('</body>', '<article><p>' + 'Een lange zin uit het artikel. '.repeat(120) + '</p></article></body>');
  assert.equal(isLoginWall(articleWithDialog), false, 'an article page hiding a login dialog is not');

  const captcha = '<!DOCTYPE html><html lang="en"><head><title>Human Verification</title>'
    + '<script src="https://x.token.awswaf.com/challenge.js"></script></head><body><div id="captcha-container"></div></body></html>';
  assert.equal(isBotCheckPage(captcha), true, "AWS WAF's Human Verification captcha is a bot check");

  assert.equal(archiveSubmitUrl(article), 'https://archive.ph/?run=1&url=' + encodeURIComponent(article), 'the archive.ph link carries the address');
  console.log('✅ Consent gates, login forms, captchas and empty pages');
}

// --- 0h. Paid previews without a selector, and archive.ph timemaps -------------------
// HLN+ (2026-10-07): `NewsArticle.isAccessibleForFree: false` without hasPart, the intro and a
// list of teaser links in the story box. De Morgen names its paid part `.paywall` and ships it.
{
  const ld = (free: string, part = '') =>
    `<script type="application/ld+json">{"@type":"NewsArticle","isAccessibleForFree":${free}${part}}</script>`;
  const teasers = Array.from({ length: 17 }, (_, i) => `<a href="/a${i}"><p>Een ander artikel met een lange titel nummer ${i}</p></a>`).join('');
  const intro = '<p>' + 'De argwaan tegenover AI is niet kleiner geworden. '.repeat(5) + '</p>';
  const hlnPreview = `<html><head>${ld('false')}</head><body><main><article>${intro}${teasers}</article></main></body></html>`;
  assert.ok(storyTextChars(hlnPreview) < 400, 'teaser links do not count as story text');
  assert.equal(isPaidPreview(hlnPreview), true, 'a paid page without a selector and only an intro is a preview');
  const fullStory = '<p>' + 'Een volledige alinea uit het betalende artikel. '.repeat(60) + '</p>';
  const hlnFull = hlnPreview.replace(intro, intro + fullStory);
  assert.equal(isPaidPreview(hlnFull), false, 'the same page with the whole story is not');
  assert.equal(isPaidPreview(hlnPreview.replace(ld('false'), ld('true'))), false, 'a free article is never a preview');
  assert.equal(isPaidPreview(hlnPreview.replace(ld('false'), ld('"False"'))), true, 'the flag may be a string in any case');
  const shipped = `<html><head>${ld('false', ',"hasPart":{"@type":"WebPageElement","isAccessibleForFree":false,"cssSelector":".paywall"}')}</head>`
    + `<body><article>${intro}<div class="paywall">${fullStory}</div></article></body></html>`;
  assert.equal(isPaidPreview(shipped), false, 'a page that ships its named paid part is not a preview');
  assert.equal(isPaidPreview(shipped.replace(`<div class="paywall">${fullStory}</div>`, '')), true, 'without the named part it is');

  const timemap = [
    '<https://www.hln.be/binnenland/x~adfc0aaa/>; rel="original",',
    '<http://archive.md/timegate/https://www.hln.be/binnenland/x~adfc0aaa/>; rel="timegate",',
    '<http://archive.md/20260113075854/https://www.hln.be/binnenland/x~adfc0aaa/>; rel="first memento"; datetime="Tue, 13 Jan 2026 07:58:54 GMT",',
    '<http://archive.md/20260203192713/https://www.hln.be/binnenland/x~adfc0aaa/>; rel="last memento"; datetime="Tue, 03 Feb 2026 19:27:13 GMT",',
    '<http://archive.md/timemap/https://www.hln.be/binnenland/x~adfc0aaa/>; rel="self"; type="application/link-format"',
  ].join('\n');
  assert.equal(newestArchiveCopy(timemap), 'https://archive.ph/20260203192713/https://www.hln.be/binnenland/x~adfc0aaa/', 'the last memento, on archive.ph');
  assert.equal(
    newestArchiveCopy('<http://archive.md/20260113075854/https://a.be/x>; rel="first last memento"; datetime="x"'),
    'https://archive.ph/20260113075854/https://a.be/x',
    'a single copy is both first and last'
  );
  assert.equal(newestArchiveCopy('<https://a.be/x>; rel="original"'), null, 'a timemap without copies gives none');
  console.log('✅ Paid previews without a selector, and archive.ph timemaps');
}

// --- 0i. Teaser copies, and the error without an archive link ----------------------
// The shape of archive.ph's copies of Knack articles (2026-10-07): the JSON-LD block kept but
// emptied, so the paid flag is gone. A paid article's story box holds only the title, the
// byline and a note on letters to the editor, its subscribe box sits after the footer.
{
  const story = (body: string) => '<html><head><script type="application/ld+json"></script><title>Knack</title></head><body><div id="CONTENT">'
    + '<article><h1>Frankrijk is de nieuwe zieke man van Europa</h1><div>Ewald Pironet Senior writer 10:19 2 min leestijd</div>'
    + body
    + '<div>Reageren op dit artikel kan u door een e-mail te sturen naar <a href="mailto:x">lezersbrieven@knack.be</a>. Uw reactie wordt dan mogelijk meegenomen in het volgende nummer.</div></article>'
    + '<footer><div>' + 'Knack is er voor mensen met een lenige geest. Kritisch, doordacht, diepgaand. '.repeat(20) + '</div></footer>'
    + '<div>Wil je dit artikel verder lezen? Neem een Knack abonnement. Volledige digitale toegang tot alle artikels.</div></div></body></html>';
  const teaser = story('');
  const paragraph = (n: number) => '<div>' + 'Een volledige zin uit het gratis artikel over de superrijken. '.repeat(n) + '</div>';
  const free = story(paragraph(70));
  const problem = copyProblem(teaser, 'bot check');
  assert.equal(problem?.preview, true, 'a copy with only a title and a byline is a preview');
  assert.match(problem?.reason || '', /^too short \(\d+ characters of story\)$/, 'and the log says how short');
  assert.equal(copyProblem(free, 'bot check'), null, 'the same copy with the whole story is the article');
  assert.equal(copyProblem(free, 'login'), null, 'whatever wall sent us there');
  const login = '<html><head><title>Knack</title></head><body><form><input type="password"></form></body></html>';
  assert.deepEqual(copyProblem(login, 'bot check'), { reason: 'login form', preview: false }, 'a wall page is no preview');
  const longer = story(paragraph(25));
  assert.ok(storyTextChars(longer) > 1000 && storyTextChars(longer) < 1850, 'a copy just over the minimum');
  assert.equal(copyProblem(longer, 'bot check'), null, 'passes on its own');
  assert.match(copyProblem(longer, 'paywall', 850)?.reason || '', /^the same preview/, 'but not 1,000 characters past an 850-character preview');

  const knack = 'https://www.knack.be/nieuws/wereld/europa/frankrijk-is-de-nieuwe-zieke-man-van-europa-kan-belgie-besmet-raken/';
  const onlyPreview = noCopyError(knack, 'bot check', true);
  assert.equal(
    onlyPreview.message,
    "This site blocks automated reading with a bot check, and archive.ph's copy holds only a preview of the article. Knack sends paid articles only to subscribers.",
    'a preview on archive.ph says so, and names Knack'
  );
  assert.equal(onlyPreview.archiveSubmitUrl, null, 'and offers no archive link');
  const hln = noCopyError('https://www.hln.be/binnenland/x~adfc0aaa/', 'paywall', true);
  assert.equal(hln.message, "This article is behind a paywall, and archive.ph's copy holds only a preview of the article.", 'other sites get no Knack note');
  const noCopy = noCopyError(knack, 'login', false);
  assert.equal(noCopy.message, 'This article is behind a login, and no other copy of the article could be found.', 'without a copy the message stays');
  assert.equal(noCopy.archiveSubmitUrl, archiveSubmitUrl(knack), 'and offers the archive link');
  console.log('✅ Teaser copies, and the error without an archive link');
}

// --- 0j. Scripts and styles are cut before a page is read ---------------------------
// CNN's 5.8 MB article page froze the backend for about 20 minutes on 2026-10-09: jsdom on the
// page as it came did not finish in 10 minutes, and took 0.3 seconds without its scripts.
{
  const bigScript = '<script>window.__DATA__ = ' + JSON.stringify({ x: 'y'.repeat(300_000) }) + ';</script>';
  const page = `<html><head><title>T</title>
    <script type="application/ld+json">{"@type":"NewsArticle","author":{"name":"Ann Writer"},"isAccessibleForFree":false,"hasPart":{"isAccessibleForFree":false,"cssSelector":".paid"}}</script>
    <script src="/app.js"></script>
    <SCRIPT type="text/javascript">var a = "</div>";</SCRIPT>
    <style>.paid { display: none }</style>
    ${bigScript}
  </head><body><article><p>Opening paragraph of the story.</p><div class="paid">${'Paid text. '.repeat(40)}</div></article>
    <noscript><img src="https://a.b/lazy.jpg"></noscript></body></html>`;
  const light = lightenHtml(page);
  assert.ok(!/__DATA__|app\.js|display: none|var a/.test(light), 'scripts and styles are gone, uppercase tags too');
  assert.ok(/application\/ld\+json/.test(light) && /Ann Writer/.test(light), 'JSON-LD stays');
  assert.ok(/<noscript>/.test(light), 'noscript stays (lazy images)');
  assert.ok(light.length < 2000, `the 300 KB script is gone (${light.length} characters left)`);
  const doc = parsePage(page, 'https://example.com/a').window.document;
  assert.equal(authorFromJsonLd(doc), 'Ann Writer', 'the author is still read from JSON-LD');
  assert.equal(isPaywallPreview(doc), false, 'the paid part is there, so no preview (read from the page object)');
  assert.equal(isPaywallPreview(page), false, 'the same from the string');
  assert.ok(storyTextChars(doc) > 300, 'story text counted from the page object');
  assert.throws(() => parsePage('<html><body>' + '<p>x</p>'.repeat(700_000) + '</body></html>'), /too large to read: 5\.6 MB/, 'a page still over 5 MB is refused');
  console.log('✅ Scripts and styles are cut before a page is read, oversized pages are refused');
}

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
