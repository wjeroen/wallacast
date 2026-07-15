// Generates the static voice-preview mp3s served from frontend/public/voice-previews/
// and played by the little speaker button on each voice chip in Settings.
//
// One short sentence per voice in the Settings VOICE_CATALOG (SettingsPage.tsx).
// Rerun after adding or removing voices there, then commit the mp3s.
//
// Uses REAL, BILLABLE API keys from the environment (never printed):
//   OPENAI_API_KEY     for the gpt-4o-mini-tts voices
//   DEEPINFRA_API_KEY  for the Kokoro voices
// A full run costs a few cents at most (18 sentences of ~55 characters).
//
// Usage (from frontend/):  node scripts/generate-voice-previews.mjs [--only openai|kokoro]

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const OUT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'voice-previews');

// Keep in sync with VOICE_CATALOG in SettingsPage.tsx.
const OPENAI_VOICES = ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer', 'coral'];
const KOKORO_VOICES = [
  'af_heart', 'af_bella', 'af_nicole',
  'am_adam', 'am_fenrir', 'am_michael', 'am_puck',
  'bf_emma', 'bf_isabella',
  'bm_fable', 'bm_lewis',
];

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const kokoroName = (id) => cap(id.split('_')[1]); // af_heart -> Heart
const sentence = (name) => `Hi, I'm ${name}. This is how I sound reading your articles.`;

// Must match previewFile() in SettingsPage.tsx.
const fileFor = (model, voice) => `${model.replace(/[^a-zA-Z0-9]+/g, '_').toLowerCase()}--${voice}.mp3`;

async function synth(baseURL, apiKey, model, voice, input) {
  const res = await fetch(`${baseURL}/audio/speech`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, voice, input, response_format: 'mp3' }),
  });
  if (!res.ok) {
    throw new Error(`${model}/${voice}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

await fs.mkdir(OUT_DIR, { recursive: true });
const onlyIdx = process.argv.indexOf('--only');
const only = onlyIdx >= 0 ? process.argv[onlyIdx + 1] : null;

if (only !== 'kokoro') {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY not set');
  for (const voice of OPENAI_VOICES) {
    const buf = await synth('https://api.openai.com/v1', key, 'gpt-4o-mini-tts', voice, sentence(cap(voice)));
    const file = fileFor('gpt-4o-mini-tts', voice);
    await fs.writeFile(path.join(OUT_DIR, file), buf);
    console.log(`${file}  ${(buf.length / 1024).toFixed(0)} KB`);
  }
}

if (only !== 'openai') {
  const key = process.env.DEEPINFRA_API_KEY;
  if (!key) throw new Error('DEEPINFRA_API_KEY not set');
  for (const voice of KOKORO_VOICES) {
    const buf = await synth('https://api.deepinfra.com/v1/openai', key, 'hexgrad/Kokoro-82M', voice, sentence(kokoroName(voice)));
    const file = fileFor('hexgrad/Kokoro-82M', voice);
    await fs.writeFile(path.join(OUT_DIR, file), buf);
    console.log(`${file}  ${(buf.length / 1024).toFixed(0)} KB`);
  }
}

console.log('Done.');
