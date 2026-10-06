// Throwaway-but-persistent stand-in backend for previewing wallacast's UI (Settings,
// menus, Library, Feed, Add tabs) without a real account or a real database. Always
// "logs in" successfully. Content you add and feeds you subscribe to here are fake,
// held in mock-data.json (gitignored, local to this machine only), not your real
// Railway database, and never touched by the real deploy command (npm start).
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import cors from 'cors';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_FILE = path.join(__dirname, 'mock-data.json');

function loadData() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
  } catch {
    return { content: [], podcasts: [], nextContentId: 1, nextPodcastId: 1 };
  }
}
const db = loadData();
function saveData() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));
}

const app = express();
app.use(cors({ origin: 'http://localhost:5173' }));
app.use(express.json());

const fakeUser = {
  id: 1,
  username: 'previewuser',
  email: 'preview@example.com',
  display_name: 'Preview User',
  is_active: true,
  created_at: new Date(0).toISOString(),
};
const fakeTokens = { accessToken: 'mock-access-token', refreshToken: 'mock-refresh-token' };

app.post('/api/auth/login', (req, res) => res.json({ ...fakeTokens, user: fakeUser }));
app.post('/api/auth/register', (req, res) => res.json({ ...fakeTokens, user: fakeUser }));
app.post('/api/auth/refresh', (req, res) => res.json(fakeTokens));
app.get('/api/auth/me', (req, res) => res.json({ user: fakeUser }));
app.post('/api/auth/logout', (req, res) => res.json({ success: true }));
// Read-only API tokens (Settings section). A fake token so the one-time reveal can be previewed.
app.get('/api/auth/tokens', (req, res) => res.json({ tokens: [] }));
app.post('/api/auth/tokens', (req, res) => res.json({ id: 1, name: req.body?.name || 'Token', token: 'wcr_' + '0123456789abcdef'.repeat(2) + '01234567' }));
app.delete('/api/auth/tokens/:id', (req, res) => res.json({ success: true }));

app.get('/api/users/settings', (req, res) => res.json({ settings: {} }));
app.get('/api/users/prompts', (req, res) => res.json({ prompts: [] }));
app.get('/api/users/ai-providers', (req, res) => res.json({ providers: {} }));

// --- Content (Library / Add tabs) ---
app.get('/api/content', (req, res) => res.json(db.content));

app.get('/api/content/:id', (req, res) => {
  const item = db.content.find(c => c.id === Number(req.params.id));
  if (!item) return res.status(404).json({ error: 'not found' });
  res.json(item);
});

app.post('/api/content', (req, res) => {
  const now = new Date().toISOString();
  let title = req.body.title;
  if (!title && req.body.url) {
    try { title = new URL(req.body.url).hostname; } catch { title = 'Untitled'; }
  }
  const item = {
    id: db.nextContentId++,
    type: req.body.type || 'article',
    title: title || 'Untitled preview item',
    url: req.body.url,
    content: req.body.content,
    author: 'Preview Author',
    description: 'Fake preview content, not a real saved article.',
    is_starred: false,
    is_archived: false,
    playback_position: 0,
    playback_speed: 1,
    generation_status: 'completed',
    generation_progress: 100,
    created_at: now,
    updated_at: now,
    published_at: now,
  };
  db.content.push(item);
  saveData();
  res.json(item);
});

app.patch('/api/content/:id', (req, res) => {
  const item = db.content.find(c => c.id === Number(req.params.id));
  if (!item) return res.status(404).json({ error: 'not found' });
  Object.assign(item, req.body, { updated_at: new Date().toISOString() });
  saveData();
  res.json(item);
});

app.delete('/api/content/:id', (req, res) => {
  db.content = db.content.filter(c => c.id !== Number(req.params.id));
  saveData();
  res.json({ success: true });
});

// --- Podcasts (Feed tab) ---
app.get('/api/podcasts', (req, res) => res.json(db.podcasts));

app.get('/api/podcasts/search', (req, res) => {
  const q = String(req.query.q || 'Preview Podcast');
  const looksLikeUrl = /^https?:\/\//i.test(q);
  res.json([{
    title: looksLikeUrl ? 'Preview Feed' : `${q} (preview result)`,
    author: 'Preview Network',
    description: 'Fake search result, for previewing the subscribe flow only.',
    feed_url: looksLikeUrl ? q : `https://example.com/feeds/${encodeURIComponent(q)}.xml`,
    website_url: 'https://example.com',
    category: 'Technology',
    language: 'en',
    type: 'podcast',
  }]);
});

app.post('/api/podcasts/subscribe', (req, res) => {
  const now = new Date().toISOString();
  let title = 'Preview Podcast';
  try {
    const u = new URL(req.body.feed_url);
    const last = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() || u.hostname);
    title = last.replace(/\.(xml|rss)$/i, '') || title;
  } catch { /* keep default title */ }
  const podcast = {
    id: db.nextPodcastId++,
    title,
    author: 'Preview Network',
    description: 'Fake subscribed feed, not a real one.',
    feed_url: req.body.feed_url,
    website_url: 'https://example.com',
    category: 'Technology',
    language: 'en',
    type: 'podcast',
    subscribed_at: now,
  };
  db.podcasts.push(podcast);
  saveData();
  res.json(podcast);
});

app.delete('/api/podcasts/:id', (req, res) => {
  db.podcasts = db.podcasts.filter(p => p.id !== Number(req.params.id));
  saveData();
  res.json({ success: true });
});

// Anything else: harmless empty response so the real UI renders with empty states
// instead of erroring, rather than trying to enumerate every route by hand.
app.use('/api', (req, res) => res.json(req.method === 'GET' ? [] : {}));

const PORT = 3001;
app.listen(PORT, () => {
  console.log(`[mock-server] preview backend listening on http://localhost:${PORT}`);
  console.log(`[mock-server] fake data file: ${DATA_FILE}`);
});
