// seed-demo.mjs
//
// Populates or refreshes the shared demo account on a RUNNING Wallacast instance by
// driving its public HTTP API, exactly like the frontend does. Because it only talks
// HTTP, the same script works against localhost and against the production Railway URL.
//
// Usage (run from the backend directory):
//   BASE_URL=https://your-instance DEMO_PASSWORD=... OPENAI_API_KEY=... \
//   DEEPINFRA_API_KEY=... ANTHROPIC_API_KEY=... npm run seed:demo
//
// Node 18+ is assumed (native fetch, no external libraries). Plain ESM.
//
// What it does, in order:
//   1. Reads config from env and fails fast if anything required is missing.
//   2. Registers the demo account (409 already-exists is fine), then logs in.
//   3. Saves the demo account settings (models, voice, transcription, keys, toggles).
//   4. Adds three library items in an order that leaves the onboarding guide NEWEST:
//        a) an 80,000 Hours podcast episode, b) an EA Forum article, c) the text guide.
//   5. Generates audio / transcript / summaries for each, polling until each is done.
//   6. Removes all three API keys from the demo account so it holds no usable keys.
//
// SECURITY: API key VALUES are never printed. They are referenced by variable name only
// and passed straight into request bodies (which this script never logs).

import { ONBOARDING_TITLE, ONBOARDING_HTML } from './seed-demo-content.mjs';

// ---------------------------------------------------------------------------
// 1. Config from environment
// ---------------------------------------------------------------------------

const cfg = {
  baseUrl: process.env.BASE_URL,
  username: process.env.DEMO_USERNAME || 'demo',
  password: process.env.DEMO_PASSWORD,
  openaiKey: process.env.OPENAI_API_KEY,
  deepinfraKey: process.env.DEEPINFRA_API_KEY,
  anthropicKey: process.env.ANTHROPIC_API_KEY,
};

const missing = [];
if (!cfg.baseUrl) missing.push('BASE_URL');
if (!cfg.password) missing.push('DEMO_PASSWORD');
if (!cfg.openaiKey) missing.push('OPENAI_API_KEY');
if (!cfg.deepinfraKey) missing.push('DEEPINFRA_API_KEY');
if (!cfg.anthropicKey) missing.push('ANTHROPIC_API_KEY');

if (missing.length > 0) {
  console.error(`Missing required environment variables: ${missing.join(', ')}`);
  console.error('');
  console.error('Run it like this (from the backend directory):');
  console.error('  BASE_URL=https://your-instance DEMO_PASSWORD=... OPENAI_API_KEY=... \\');
  console.error('  DEEPINFRA_API_KEY=... ANTHROPIC_API_KEY=... npm run seed:demo');
  console.error('');
  console.error('DEMO_USERNAME is optional and defaults to "demo".');
  process.exit(1);
}

// Normalize the base URL. The operator can pass either the origin (https://foo.com) or
// the full API base (https://foo.com/api). All routes live under /api (see index.ts).
function normalizeApiBase(raw) {
  let b = String(raw).trim().replace(/\/+$/, '');
  if (!/\/api$/i.test(b)) b += '/api';
  return b;
}
const API = normalizeApiBase(cfg.baseUrl);

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const POLL_INTERVAL_MS = 3000;          // poll status every 3 seconds
const ITEM_TIMEOUT_MS = 30 * 60 * 1000; // give up on any single item after 30 minutes
const REQUEST_TIMEOUT_MS = 5 * 60 * 1000; // abort any single HTTP request after 5 minutes

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const secsSince = (startMs) => Math.round((Date.now() - startMs) / 1000);
const fmtDuration = (sec) => (sec == null ? '-' : `${Math.floor(sec / 60)}m${String(sec % 60).padStart(2, '0')}s`);

// Bearer token for all authed calls, set after login.
let accessToken = null;

// Authenticated fetch wrapper. Throws with method, path, status, and response body text on
// any non-2xx status (except statuses passed in `allow`, e.g. the expected 409 on register).
// It never logs request bodies, so API keys sent to the settings endpoint are never printed.
// Access tokens only live 15 minutes and a full seed run takes far longer, so on the first
// 401 of an authed call the wrapper logs in again with the password (a password login stays
// writable, see the demo-session rules in backend/src/services/auth.ts) and retries once.
async function apiFetch(method, path, { body, auth = true, allow = [] } = {}) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const url = `${API}${path}`;
    const headers = { 'Content-Type': 'application/json' };
    if (auth && accessToken) headers.Authorization = `Bearer ${accessToken}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    let res;
    try {
      res = await fetch(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      if (err && err.name === 'AbortError') {
        throw new Error(`${method} ${path} timed out after ${REQUEST_TIMEOUT_MS / 1000}s`);
      }
      throw new Error(`${method} ${path} network error: ${err && err.message ? err.message : String(err)}`);
    }
    clearTimeout(timer);

    const text = await res.text();

    if (res.status === 401 && auth && attempt === 0) {
      console.log(`  Access token expired (401 on ${method} ${path}). Logging in again...`);
      await login();
      continue;
    }

    if (!res.ok && !allow.includes(res.status)) {
      throw new Error(`${method} ${path} -> ${res.status} ${res.statusText}\n${text.slice(0, 1000)}`);
    }

    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }
    return { status: res.status, data };
  }
  throw new Error(`${method} ${path} still unauthorized after re-login`);
}

// ---------------------------------------------------------------------------
// 2. Auth
// ---------------------------------------------------------------------------

async function register() {
  const { status } = await apiFetch('POST', '/auth/register', {
    auth: false,
    allow: [409],
    body: { username: cfg.username, password: cfg.password, displayName: 'Demo' },
  });
  if (status === 409) {
    console.log(`  Account "${cfg.username}" already exists (409). Will log in instead.`);
  } else {
    console.log(`  Registered new account "${cfg.username}".`);
  }
}

async function login() {
  let res;
  try {
    res = await apiFetch('POST', '/auth/login', {
      auth: false,
      body: { username: cfg.username, password: cfg.password },
    });
  } catch (err) {
    throw new Error(
      `Login failed for "${cfg.username}". If this account already exists, DEMO_PASSWORD is ` +
      `probably wrong for it.\n${err.message}`
    );
  }
  accessToken = res.data && res.data.accessToken;
  if (!accessToken) throw new Error('Login succeeded but the response had no accessToken.');
  console.log(`  Logged in as "${cfg.username}".`);
}

// ---------------------------------------------------------------------------
// 3. Settings
// ---------------------------------------------------------------------------

// Bulk settings save. Body shape matches PUT /api/users/settings ({ settings: {...} }).
async function saveSettings(settings) {
  await apiFetch('PUT', '/users/settings', { body: { settings } });
}

// Every key below is a real entry in VALID_SETTING_KEYS (backend/src/routes/users.ts).
// Values match the exact shapes the Settings page persists (see frontend SettingsPage.tsx).
const demoSettings = {
  // Narration chat job: OpenAI GPT-5 Mini, reasoning effort left at the provider default (blank).
  narration_provider: 'openai',
  narration_model: 'gpt-5-mini',
  narration_reasoning_effort: '',

  // Read-along alignment job: OpenAI GPT-5 Mini, reasoning effort high. "Same as narration"
  // is turned OFF so these explicit values are the ones that apply.
  alignment_same_as_narration: 'false',
  alignment_provider: 'openai',
  alignment_model: 'gpt-5-mini',
  alignment_reasoning_effort: 'high',

  // Summary job: Anthropic Claude Sonnet 5, effort at default (blank), same-as-narration OFF.
  summary_same_as_narration: 'false',
  summary_provider: 'anthropic',
  summary_model: 'claude-sonnet-5',
  summary_reasoning_effort: '',

  // Transcription: DeepInfra, the Whisper preset that maps to large-v3-turbo. This is the
  // exact preset id the Settings page fills into transcription_model (DEEPINFRA_WHISPER_PRESETS).
  transcription_provider: 'deepinfra',
  transcription_model: 'openai/whisper-large-v3-turbo',

  // TTS: the Kokoro Puck voice served via DeepInfra. tts_voices is stored exactly as the
  // Settings page writes it: JSON.stringify of an array of { model, voice } objects. Puck lives
  // under the hexgrad/Kokoro-82M model. kokoro_tts_provider picks DeepInfra as the synthesizer.
  kokoro_tts_provider: 'deepinfra',
  tts_voices: JSON.stringify([{ model: 'hexgrad/Kokoro-82M', voice: 'am_puck' }]),

  // Image descriptions: DeepInfra, model left at its default (blank), feature enabled.
  image_alt_text_enabled: 'true',
  image_alt_text_provider: 'deepinfra',
  image_alt_text_model: '',

  // Auto-generation toggles OFF so this script controls every generation step explicitly.
  auto_generate_audio_for_articles: 'false',
  auto_transcribe_podcasts: 'false',
  auto_generate_summary: 'false',

  // API keys from the environment. Referenced by name only, values are never logged.
  openai_api_key: cfg.openaiKey,
  deepinfra_api_key: cfg.deepinfraKey,
  anthropic_api_key: cfg.anthropicKey,
};

let keysSaved = false;
let keysRemoved = false;

// Cleanup: save the three API keys as empty strings. The backend treats '' as unset
// (and does not encrypt an empty value), so the shared demo account keeps no usable keys.
async function removeKeys() {
  if (keysRemoved) return;
  await saveSettings({ openai_api_key: '', deepinfra_api_key: '', anthropic_api_key: '' });
  keysRemoved = true;
  console.log('  Removed openai_api_key, deepinfra_api_key, and anthropic_api_key from the demo account.');
}

// ---------------------------------------------------------------------------
// 4. Content helpers
// ---------------------------------------------------------------------------

// GET /api/content returns the whole library as an array, ordered created_at DESC (newest first).
async function getLibrary() {
  const { data } = await apiFetch('GET', '/content');
  return Array.isArray(data) ? data : [];
}

// Re-runnability: delete any existing library items matching `predicate` before adding a fresh copy.
async function deleteMatching(predicate, label) {
  const items = await getLibrary();
  const matches = items.filter(predicate);
  for (const it of matches) {
    await apiFetch('DELETE', `/content/${it.id}`);
    console.log(`  Removed existing ${label} "${it.title}" (id ${it.id}) so the seed is re-runnable.`);
  }
  return matches.length;
}

// ---------------------------------------------------------------------------
// 5. Generation triggers
// ---------------------------------------------------------------------------

async function triggerAudio(id) {
  await apiFetch('POST', `/content/${id}/generate-audio`, {
    body: { regenerate: false, exclude_comments: false },
  });
}

async function triggerTranscript(id) {
  await apiFetch('POST', `/transcription/content/${id}`, { body: {} });
}

async function triggerSummary(id, generateTranscript = false) {
  await apiFetch('POST', `/content/${id}/generate-summary`, {
    body: { regenerate: false, generate_transcript: generateTranscript },
  });
}

// Fetch just the tiny status fields for one item (POST /api/content/status, batched by design).
async function fetchStatus(id) {
  const { data } = await apiFetch('POST', '/content/status', { body: { ids: [id] } });
  const rows = Array.isArray(data) ? data : [];
  return rows.find((r) => r.id === id) || null;
}

// Poll generation_status until it reaches a terminal state. Terminal means 'completed' or
// 'failed'. We also treat 'ready' with a null current_operation as done (the audio pipeline
// parks at 'ready' before transcription/alignment, but keeps current_operation non-null while
// those run, so this only fires when there is genuinely nothing left to do). Prints progress
// as it changes. Throws loudly on 'failed', including generation_error.
async function pollGeneration(id, label) {
  const start = Date.now();
  let lastProgress = -1;
  let lastStatus = '';
  while (true) {
    if (Date.now() - start > ITEM_TIMEOUT_MS) {
      throw new Error(`${label}: generation timed out after 30 minutes (id ${id}).`);
    }
    const row = await fetchStatus(id);
    if (!row) {
      // The item should exist (we just created it). Keep trying briefly in case of replica lag.
      await sleep(POLL_INTERVAL_MS);
      continue;
    }
    const status = row.generation_status;
    const progress = row.generation_progress == null ? 0 : row.generation_progress;
    const op = row.current_operation;
    if (status !== lastStatus || progress !== lastProgress) {
      console.log(`  [${label}] status=${status} progress=${progress}%${op ? ` op=${op}` : ''}`);
      lastStatus = status;
      lastProgress = progress;
    }
    if (status === 'failed') {
      throw new Error(`${label}: generation FAILED (id ${id}): ${row.generation_error || 'no error message'}`);
    }
    if (status === 'completed') return status;
    if (status === 'ready' && (op === null || op === undefined)) return status;
    await sleep(POLL_INTERVAL_MS);
  }
}

// Poll summary_status until terminal ('completed' or 'failed'). The status endpoint does not
// return summary_error, so on failure we fetch the full item once to surface the message.
async function pollSummary(id, label) {
  const start = Date.now();
  let lastStatus = '';
  while (true) {
    if (Date.now() - start > ITEM_TIMEOUT_MS) {
      throw new Error(`${label}: summary timed out after 30 minutes (id ${id}).`);
    }
    const row = await fetchStatus(id);
    const status = row ? row.summary_status : null;
    if (status !== lastStatus) {
      console.log(`  [${label}] summary_status=${status}`);
      lastStatus = status;
    }
    if (status === 'failed') {
      let msg = 'no error message';
      try {
        const { data } = await apiFetch('GET', `/content/${id}`);
        msg = (data && data.summary_error) || msg;
      } catch {
        // Best effort. Fall through with the generic message.
      }
      throw new Error(`${label}: summary FAILED (id ${id}): ${msg}`);
    }
    if (status === 'completed') return status;
    await sleep(POLL_INTERVAL_MS);
  }
}

// ---------------------------------------------------------------------------
// Content add steps (returns the created item, records timing in `report`)
// ---------------------------------------------------------------------------

const FEED_URL = 'https://feeds.transistor.fm/80000-hours-podcast';
// Extra demo subscriptions so the Feed tab has content: one more podcast and one Substack
// newsletter (the type is auto-detected from the feed). Swap these for other feeds freely,
// re-running the seeder re-subscribes and refreshes the cache.
const EXTRA_FEEDS = [
  'https://apple.dwarkesh-podcast.workers.dev/feed.rss',
  'https://www.astralcodexten.com/feed',
];
const ARTICLE_URL =
  'https://forum.effectivealtruism.org/posts/6dsrwxHtCgYfJNptp/the-world-is-much-better-the-world-is-awful-the-world-can-be';
const ARTICLE_SLUG = '6dsrwxHtCgYfJNptp'; // stable across the EA-Forum host rewrite

const report = {
  podcast: { label: 'Podcast episode (80,000 Hours)' },
  article: { label: 'Article (EA Forum)' },
  text: { label: 'Text (onboarding guide)' },
};

// Find the episode whose title contains both "235" and "Ajeya". search-feed matches
// title, description, or author, so we query both distinctive terms, merge unique results,
// then keep only the one whose TITLE contains both markers.
async function findTargetEpisode() {
  const titleWanted = (t) => {
    const s = String(t || '').toLowerCase();
    return s.includes('235') && s.includes('ajeya');
  };
  const seen = new Map();
  for (const q of ['Ajeya', '235']) {
    const { data } = await apiFetch(
      'GET',
      `/podcasts/search-feed?url=${encodeURIComponent(FEED_URL)}&q=${encodeURIComponent(q)}`
    );
    for (const ep of Array.isArray(data) ? data : []) {
      const key = ep.audio_url || ep.url || ep.title;
      if (!seen.has(key)) seen.set(key, ep);
    }
  }
  return [...seen.values()].find((ep) => titleWanted(ep.title)) || null;
}

async function addPodcastEpisode() {
  const t0 = Date.now();
  console.log('\n[add 1/3] Podcast: subscribing to the 80,000 Hours feed...');
  const { data: podcast } = await apiFetch('POST', '/podcasts/subscribe', { body: { feed_url: FEED_URL } });
  console.log(`  Subscribed to "${podcast.title}" (podcast id ${podcast.id}).`);

  console.log('  Searching the feed for the "235 ... Ajeya" episode...');
  const episode = await findTargetEpisode();
  if (!episode) {
    throw new Error(
      'Could not find an episode whose title contains both "235" and "Ajeya" in the 80,000 Hours feed. ' +
      'The RSS feed may no longer include that episode.'
    );
  }
  console.log(`  Found episode: "${episode.title}".`);

  await deleteMatching(
    (it) => (episode.audio_url && it.audio_url === episode.audio_url) || it.title === episode.title,
    'podcast episode'
  );

  const { data: created } = await apiFetch('POST', '/content', {
    body: {
      type: 'podcast_episode',
      title: episode.title,
      description: episode.description,
      audio_url: episode.audio_url,
      podcast_id: podcast.id,
      published_at: episode.published_at,
      duration: episode.duration,
      preview_picture: episode.preview_picture,
    },
  });
  console.log(`  Added podcast episode to the library (content id ${created.id}).`);
  report.podcast.id = created.id;
  report.podcast.title = created.title;
  report.podcast.addSec = secsSince(t0);
  return created;
}

async function addArticle() {
  const t0 = Date.now();
  console.log('\n[add 2/3] Article: adding by URL from the EA Forum (fetch happens server-side)...');
  await deleteMatching(
    (it) => it.type === 'article' && typeof it.url === 'string' && (it.url.includes(ARTICLE_SLUG) || it.url === ARTICLE_URL),
    'article'
  );
  const { data: created } = await apiFetch('POST', '/content', { body: { type: 'article', url: ARTICLE_URL } });
  console.log(`  Added article "${created.title}" (content id ${created.id}).`);
  report.article.id = created.id;
  report.article.title = created.title;
  report.article.addSec = secsSince(t0);
  return created;
}

async function addTextItem() {
  const t0 = Date.now();
  console.log('\n[add 3/3] Text: adding the onboarding guide last so it lands on top of the library...');
  await deleteMatching((it) => it.type === 'text' && it.title === ONBOARDING_TITLE, 'onboarding text');
  const { data: created } = await apiFetch('POST', '/content', {
    body: { type: 'text', title: ONBOARDING_TITLE, content: ONBOARDING_HTML },
  });
  console.log(`  Added text item "${created.title}" (content id ${created.id}).`);
  report.text.id = created.id;
  report.text.title = created.title;
  report.text.addSec = secsSince(t0);
  return created;
}

// ---------------------------------------------------------------------------
// Final summary
// ---------------------------------------------------------------------------

function printSummary() {
  console.log('\n==================== Demo seed summary ====================');
  for (const key of ['text', 'article', 'podcast']) {
    const r = report[key];
    const genLabel = key === 'podcast' ? 'transcript' : 'audio';
    console.log(`- ${r.label}`);
    console.log(`    id: ${r.id == null ? '-' : r.id}    title: ${r.title || '-'}`);
    console.log(
      `    add: ${fmtDuration(r.addSec)}   ${genLabel}: ${fmtDuration(r.genSec)}   ` +
      `summary: ${fmtDuration(r.summarySec)}   status: ${r.status || '-'} / summary ${r.summaryStatus || '-'}`
    );
  }
  console.log('');
  console.log('The onboarding text item was added last, so it is the newest item and sits on top of the library.');
  console.log('Reminder: the OpenAI, DeepInfra, and Anthropic API keys were removed from the demo account.');
  console.log('The shared demo account now holds no usable API keys.');
  console.log('===========================================================');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log(`Wallacast demo seeder targeting: ${API}`);
  console.log(`Demo account username: ${cfg.username}`);

  try {
    // 2. Auth
    console.log('\nAuthenticating...');
    await register();
    await login();

    // 3. Settings (before content, so generation uses these models/voice/keys)
    console.log('\nSaving demo account settings...');
    await saveSettings(demoSettings);
    keysSaved = true;
    console.log('  Settings saved (models, voice, transcription, image descriptions, toggles, keys).');

    // 4. Add content: podcast, then article, then text, so the text guide is newest.
    const podcast = await addPodcastEpisode();
    const article = await addArticle();
    const text = await addTextItem();

    // 4b. Extra feed subscriptions + the feed cache, so the Feed tab is not empty. The
    // refresh endpoint is a write, which demo visitors cannot call (their refresh button
    // shows the read-only toast), so the seeder populates Recent Updates for them here.
    console.log('\n[feeds] Subscribing to the extra demo feeds...');
    for (const url of EXTRA_FEEDS) {
      const { data: sub } = await apiFetch('POST', '/podcasts/subscribe', { body: { feed_url: url } });
      console.log(`  Subscribed to "${sub.title}" (${sub.type}).`);
    }
    console.log('  Refreshing the feed cache (Recent Updates)...');
    const { data: refreshed } = await apiFetch('POST', '/podcasts/refresh-feeds');
    console.log(`  Feed cache refreshed: ${refreshed.totalFeeds} feeds, ${refreshed.totalItemsAdded} new items.`);

    // 5. Generate, sequentially, with progress.
    // 5a. Text audio.
    console.log('\n[gen 1/6] Text item: generating audio...');
    let t = Date.now();
    await triggerAudio(text.id);
    report.text.status = await pollGeneration(text.id, 'text audio');
    report.text.genSec = secsSince(t);

    // 5b. Article audio.
    console.log('\n[gen 2/6] Article: generating audio...');
    t = Date.now();
    await triggerAudio(article.id);
    report.article.status = await pollGeneration(article.id, 'article audio');
    report.article.genSec = secsSince(t);

    // 5c. Podcast transcript.
    console.log('\n[gen 3/6] Podcast episode: transcribing...');
    t = Date.now();
    await triggerTranscript(podcast.id);
    report.podcast.status = await pollGeneration(podcast.id, 'podcast transcript');
    report.podcast.genSec = secsSince(t);

    // 5d. Summaries: text, article, then podcast (podcast only after its transcript exists).
    console.log('\n[gen 4/6] Text item: generating summary...');
    t = Date.now();
    await triggerSummary(text.id);
    report.text.summaryStatus = await pollSummary(text.id, 'text summary');
    report.text.summarySec = secsSince(t);

    console.log('\n[gen 5/6] Article: generating summary...');
    t = Date.now();
    await triggerSummary(article.id);
    report.article.summaryStatus = await pollSummary(article.id, 'article summary');
    report.article.summarySec = secsSince(t);

    console.log('\n[gen 6/6] Podcast episode: generating summary from the transcript...');
    t = Date.now();
    await triggerSummary(podcast.id, false);
    report.podcast.summaryStatus = await pollSummary(podcast.id, 'podcast summary');
    report.podcast.summarySec = secsSince(t);

    // 6. Cleanup: remove the API keys on success.
    console.log('\nCleanup: removing API keys from the demo account...');
    await removeKeys();

    printSummary();
    console.log('\nDone. Demo account seeded successfully.');
  } finally {
    // Safety net: if we saved keys but did not reach the success cleanup (an error happened),
    // still strip the keys so the shared demo account never retains usable keys.
    if (keysSaved && !keysRemoved) {
      console.error('\nScript did not finish cleanly. Removing API keys as a safety net...');
      await removeKeys().catch((err) =>
        console.error(`WARNING: could not remove API keys. Remove them manually in Settings. ${err.message}`)
      );
    }
  }
}

main().catch((err) => {
  console.error(`\nFATAL: ${err.message}`);
  process.exit(1);
});
