// Normalizes the committed voice-preview mp3s in public/voice-previews to the same
// loudness target the backend applies to generated audio (-19 LUFS integrated,
// -1.5 dBTP ceiling, the mono spoken-word norm). Two-pass linear loudnorm, so each
// file gets one constant gain and the voice's own dynamics are untouched.
//
// Run this after generate-voice-previews.mjs, then commit the changed mp3s.
// Needs an ffmpeg binary: uses the FFMPEG_PATH env var if set, else `ffmpeg` on PATH.
//
// Usage (from frontend/):  node scripts/normalize-voice-previews.mjs

import fs from 'fs/promises';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'voice-previews');
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
// Keep in sync with LOUDNORM_TARGET in backend/src/services/openai-tts.ts.
const TARGET = 'I=-19:TP=-1.5:LRA=11';

function run(args) {
  const r = spawnSync(FFMPEG, ['-hide_banner', ...args], { encoding: 'utf8' });
  if (r.error) throw r.error;
  return r.stderr || '';
}

function measure(file) {
  const err = run(['-i', file, '-af', `loudnorm=${TARGET}:print_format=json`, '-f', 'null', '-']);
  const m = err.match(/\{[^{}]*"input_i"[^{}]*\}/);
  if (!m) return null;
  const stats = JSON.parse(m[0]);
  for (const k of ['input_i', 'input_tp', 'input_lra', 'input_thresh', 'target_offset']) {
    if (!Number.isFinite(parseFloat(stats[k]))) return null;
  }
  return stats;
}

for (const f of (await fs.readdir(DIR)).sort()) {
  if (!f.endsWith('.mp3')) continue;
  const file = path.join(DIR, f);
  const s = measure(file);
  if (!s) {
    console.warn(`${f}: could not measure, skipped`);
    continue;
  }
  const filter = `loudnorm=${TARGET}:measured_I=${s.input_i}:measured_TP=${s.input_tp}:measured_LRA=${s.input_lra}:measured_thresh=${s.input_thresh}:offset=${s.target_offset}:linear=true`;
  const tmp = `${file}.tmp.mp3`;
  run(['-y', '-i', file, '-af', filter, '-ar', '24000', '-b:a', '96k', '-f', 'mp3', tmp]);
  await fs.rename(tmp, file);
  const after = measure(file);
  console.log(`${f}: ${s.input_i} -> ${after ? after.input_i : '?'} LUFS`);
}
console.log('Done.');
