// Offline test of services/video-transcript.ts: a fake Gemini answers, no network, no key.
// Run from backend/: npx tsx scripts/test-video-transcript.mts
// Not wired into any build.
import assert from 'node:assert/strict';
import { transcribeYouTubeVideoWith } from '../src/services/video-transcript.ts';

type Row = { start: string; text: string };
let calls: Array<{ model: string; from: number }> = [];
let answer: (model: string, from: number) => Row[] = () => [];
(globalThis as any).fetch = async (url: string, init: any) => {
  const model = decodeURIComponent(url.match(/models\/([^:]+):/)![1]);
  const meta = JSON.parse(init.body).contents[0].parts[0].videoMetadata;
  const from = parseInt(meta.startOffset ?? '0', 10);
  calls.push({ model, from });
  return {
    ok: true,
    status: 200,
    json: async () => ({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(answer(model, from)) }] } }], usageMetadata: {} }),
  };
};
const log = console.log, warn = console.warn;
const quiet = async <T,>(fn: () => Promise<T>) => {
  console.log = () => {};
  console.warn = () => {};
  try { return await fn(); } finally { console.log = log; console.warn = warn; }
};
const url = 'https://www.youtube.com/watch?v=bejPkfyvRhY';
const hms = (s: number) => `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
// A sentence every 20 seconds from..to
const speech = (from: number, to: number): Row[] => {
  const rows: Row[] = [];
  for (let t = from; t < to; t += 20) rows.push({ start: hms(t), text: `Said at ${t}.` });
  return rows;
};
const sentences = (r: { words: Array<{ word: string; start: number }> }) => {
  const out: Array<{ start: number; text: string }> = [];
  let cur: string[] = [];
  let start = 0;
  for (const w of r.words) {
    if (cur.length === 0) start = w.start;
    cur.push(w.word);
    if (/[.!?]\]?$/.test(w.word)) { out.push({ start, text: cur.join(' ') }); cur = []; }
  }
  return out;
};

// 1) Complete pieces: one call each, no line
calls = [];
answer = (_m, from) => speech(from, from + 600);
let r = await quiet(() => transcribeYouTubeVideoWith('fake', 'lite', url, 1500));
assert.equal(calls.length, 3);
assert.ok(!r.text.includes('may be missing'));

// 2) The second piece stops at 11:00 with the default model, the retry model has it all
calls = [];
answer = (model, from) => from === 600 && model === 'lite' ? speech(600, 660) : speech(from, from + 600);
r = await quiet(() => transcribeYouTubeVideoWith('fake', 'lite', url, 1500));
assert.deepEqual(calls.map((c) => `${c.model}@${c.from}`), ['lite@0', 'lite@600', 'gemini-3.8-flash@600', 'lite@1200']);
assert.ok(!r.text.includes('may be missing'), 'the complete second answer is kept');
assert.ok(r.text.includes('Said at 900.'));

// 3) Both answers miss 13:00 to 18:00: the line marks it, after the sentence before it
calls = [];
answer = (_m, from) => from === 600 ? [...speech(600, 780), ...speech(1080, 1200)] : speech(from, from + 600);
r = await quiet(() => transcribeYouTubeVideoWith('fake', 'lite', url, 1500));
let s = sentences(r);
let i = s.findIndex((x) => x.text.startsWith('[Transcript may be missing'));
assert.ok(i > 0, 'a line is there');
assert.equal(s[i - 1].text, 'Said at 760.');
assert.equal(s[i].text, '[Transcript may be missing from 0:12:41 to 0:18:00.]');
assert.equal(s[i + 1].text, 'Said at 1080.');
assert.ok(Math.abs(s[i].start - 761.2) < 0.01, 'the line starts after the sentence before it');

// 4) The retry is worse: the first answer stays, with its line
calls = [];
answer = (model, from) => from === 600 ? (model === 'lite' ? speech(600, 900) : speech(600, 620)) : speech(from, from + 600);
r = await quiet(() => transcribeYouTubeVideoWith('fake', 'lite', url, 1500));
assert.ok(r.text.includes('Said at 880.'));
assert.ok(r.text.includes('[Transcript may be missing from 0:14:41 to 0:20:00.]'));

// 5) A piece that is all silence (or music) in the middle: the line covers the whole piece
calls = [];
answer = (_m, from) => from === 600 ? [] : speech(from, from + 600);
r = await quiet(() => transcribeYouTubeVideoWith('fake', 'lite', url, 1500));
assert.ok(r.text.includes('[Transcript may be missing from 0:10:00 to 0:20:00.]'));

// 6) The last piece may end in silence (closing music), and the first may start with it
calls = [];
answer = (_m, from) => from === 0 ? speech(120, 600) : from === 1200 ? speech(1200, 1260) : speech(from, from + 600);
r = await quiet(() => transcribeYouTubeVideoWith('fake', 'lite', url, 1500));
assert.equal(calls.length, 3, 'no retry for an intro or an ending without speech');
assert.ok(!r.text.includes('may be missing'));

// 7) No speech at all is still an error, not a transcript of lines
calls = [];
answer = () => [];
await assert.rejects(quiet(() => transcribeYouTubeVideoWith('fake', 'lite', url, 1500)), /no speech/);

// 8) A short video in one piece: a stretch without speech inside it is marked too
calls = [];
answer = () => [...speech(0, 100), ...speech(300, 400)];
r = await quiet(() => transcribeYouTubeVideoWith('fake', 'lite', url, 400));
assert.equal(calls.length, 2);
assert.ok(r.text.includes('[Transcript may be missing from 0:01:21 to 0:05:00.]'));

console.log('VIDEO TRANSCRIPT CHECKS PASSED');
