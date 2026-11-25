// Tests services/text-cut.ts: cuts never keep half of a letter outside the basic plane, so the
// JSON sent to an AI service carries no lone \ud8xx escape (the 400 of item 2803, 2026-11-23).
// Run: node_modules/.bin/tsx scripts/test-text-cut.mts
import assert from 'node:assert/strict';
import { cutText, tailText, wholeEnd } from '../src/services/text-cut.js';

const lone = (s: string) => /\\ud[89ab][0-9a-f]{2}(?!\\ud[c-f])|(?<!\\ud[89ab][0-9a-f]{2})\\ud[c-f][0-9a-f]{2}/i.test(JSON.stringify(s));

// Item 2803's cut: bold math letters from a quoted tweet, each two units long
const bold = 'the policy most 𝐥𝐢𝐤𝐞𝐥𝐲';
for (let max = 0; max <= bold.length + 2; max++) {
  const cut = cutText(bold, max);
  assert.ok(!lone(cut), `cutText at ${max} keeps half a letter: ${JSON.stringify(cut)}`);
  assert.ok(cut.length === Math.min(max, bold.length) || cut.length === max - 1, `cutText at ${max} moves at most one place`);
  assert.ok(bold.startsWith(cut));
  const tail = tailText(bold, max);
  assert.ok(!lone(tail), `tailText at ${max} keeps half a letter: ${JSON.stringify(tail)}`);
  assert.ok(bold.endsWith(tail));
}

// Plain text and whole letters stay exactly as slice() cuts them
assert.equal(cutText('hello world', 5), 'hello');
assert.equal(tailText('hello world', 5), 'world');
assert.equal(cutText('ab😀cd', 4), 'ab😀');
assert.equal(cutText('ab😀cd', 3), 'ab');
assert.equal(tailText('ab😀cd', 3), 'cd');
assert.equal(tailText('ab😀cd', 4), '😀cd');
assert.equal(cutText('short', 50), 'short');
assert.equal(cutText('short', 0), '');
assert.equal(tailText('short', 0), '');
assert.equal(wholeEnd('ab😀cd', 3), 2);
assert.equal(wholeEnd('ab😀cd', 4), 4);
assert.equal(wholeEnd('ab😀cd', 99), 99);

// A lone half already in the text is left alone (only a cut's own split is moved)
assert.equal(cutText('ab\ud835cd', 3), 'ab\ud835');

console.log('text-cut: all tests passed');
