// Scratch test for the read-along element extractor, focused on the blockquote split.
// Run from backend/: npx tsx scripts/test-quote-split.mts [path-to-content.html]
// Defaults to the small samples below. Not wired into any build.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { extractContentElements } from '../src/services/llm-alignment.js';

// A long quote: several paragraphs and an image inside one <blockquote>.
const longQuote = `
<p>Intro paragraph before the quote.</p>
<blockquote>
  <p>First quoted paragraph.</p>
  <div class="captioned-image-container"><figure><img src="https://x/y.png" alt="A chart"></figure></div>
  <p>Second quoted paragraph.</p>
  <p>Third quoted paragraph.</p>
</blockquote>
<p>Paragraph after the quote.</p>`;

const els = extractContentElements(longQuote, 'T', 'A');
const kinds = els.map(e => `${e.type}:${e.text.slice(0, 28)}`);
console.log(kinds.join('\n'));

const quoteParts = els.filter(e => e.html.startsWith('<blockquote>'));
assert.equal(quoteParts.length, 4, 'the quote splits into 4 pieces (3 paragraphs + 1 image)');
assert.ok(quoteParts[0].text.startsWith('Quote: First quoted'), 'only the first piece carries the Quote: prefix');
assert.ok(!quoteParts[2].text.startsWith('Quote:'), 'later pieces match on their own words');
assert.equal(quoteParts[1].type, 'image', 'the image inside the quote gets its own element');
assert.ok(quoteParts[1].text.includes('A chart'), 'the image element uses the alt text');
assert.ok(quoteParts.every(p => p.html.startsWith('<blockquote>') && p.html.endsWith('</blockquote>')),
  'every piece is still wrapped as a quote so it renders as one');

// A short quote keeps its single element, exactly as before.
const shortQuote = `<p>Before.</p><blockquote><p>One line only.</p></blockquote><p>After.</p>`;
const shortEls = extractContentElements(shortQuote, 'T', 'A');
const shortParts = shortEls.filter(e => e.type === 'blockquote');
assert.equal(shortParts.length, 1, 'a one-block quote is not split');
assert.ok(shortParts[0].text.startsWith('Quote: '), 'and keeps the Quote: prefix');

// A quote with bare text (no inner blocks) also stays whole.
const bareQuote = `<blockquote>Just text, no paragraph tags.</blockquote>`;
const bareParts = extractContentElements(bareQuote).filter(e => e.type === 'blockquote');
assert.equal(bareParts.length, 1, 'a quote without inner block tags is not split');

// An image with NO description is still dropped (existing rule: the narration never
// speaks it, so it must not become an element the read-along waits on).
const undescribed = `
<blockquote>
  <p>One.</p>
  <div><figure><img src="https://x/no-alt.png"></figure></div>
  <p>Two.</p>
</blockquote>`;
const undescribedEls = extractContentElements(undescribed);
assert.equal(undescribedEls.filter(e => e.type === 'image').length, 0, 'an image with no description is dropped');
assert.equal(undescribedEls.filter(e => e.type === 'blockquote').length, 2, 'its neighbours still split');

// Tweets keep their single-element behaviour (they are quoted markup too).
const tweet = `<blockquote class="twitter-tweet"><p class="tweet-author"><strong>Jane</strong> @jane</p><p>Hello world.</p></blockquote>`;
const tweetEls = extractContentElements(tweet).filter(e => e.type === 'tweet');
assert.equal(tweetEls.length, 1, 'a tweet card stays ONE element');

// Optional: run over a real exported article to see the real element count.
const file = process.argv[2];
if (file) {
  const html = readFileSync(file, 'utf8');
  const real = extractContentElements(html, 'Title', 'Author');
  console.log(`\n${file}\n  ${real.length} elements`);
  for (const e of real) console.log(`  ${e.type.padEnd(11)} ${e.text.replace(/\s+/g, ' ').slice(0, 70)}`);
}

console.log('\nALL QUOTE-SPLIT TESTS PASSED');
