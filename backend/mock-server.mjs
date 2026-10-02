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
    author: req.body.author || 'Preview Author',
    audio_url: req.body.audio_url,
    duration: req.body.duration,
    podcast_id: req.body.podcast_id || null,
    // Same rule as the real backend: the subscription's title, else the name the Feed tab sent
    podcast_show_name: db.podcasts.find(p => p.id === req.body.podcast_id)?.title || req.body.podcast_show_name || null,
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
// A small fixed catalog of fake feeds, so the Feed tab's flows (search, preview,
// subscribe, unsubscribe, Load More, Refresh) can be clicked through. Each feed has
// 120 generated items. "Slow Feed" answers after 3 seconds and "Broken Feed" always
// fails, to try out loading states and errors. Refresh takes 3 seconds, and a feed's
// items only reach Recent Updates after a Refresh, like the real backend.
const MOCK_FEEDS = [
  { title: 'Hard Fork', author: 'The New York Times', type: 'podcast', feed_url: 'https://example.com/feeds/hard-fork.xml' },
  { title: 'The 80,000 Hours Podcast', author: 'The 80,000 Hours team', type: 'podcast', feed_url: 'https://example.com/feeds/80000-hours.xml' },
  { title: "Don't Worry About the Vase", author: 'Zvi Mowshowitz', type: 'newsletter', feed_url: 'https://thezvi.substack.com/feed' },
  { title: 'Slow Feed', author: 'Preview Network', type: 'podcast', feed_url: 'https://example.com/feeds/slow.xml', delay: 3000 },
  { title: 'Broken Feed', author: 'Preview Network', type: 'podcast', feed_url: 'https://example.com/feeds/broken.xml', broken: true },
].map(f => ({
  description: `Fake ${f.type} for previewing the Feed tab. Not a real feed.`,
  website_url: 'https://example.com',
  category: 'Technology',
  language: 'en',
  ...f,
}));
const ITEMS_PER_FEED = 120;
const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const catalogFeed = (feedUrl) => MOCK_FEEDS.find(f => f.feed_url === feedUrl);

function feedEpisodes(feedUrl) {
  const feed = catalogFeed(feedUrl) || { title: 'Preview Feed', type: 'podcast' };
  const index = Math.max(0, MOCK_FEEDS.indexOf(feed));
  const slug = feed.title.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const now = Date.now();
  return Array.from({ length: ITEMS_PER_FEED }, (_, i) => {
    const article = feed.type === 'newsletter';
    const n = ITEMS_PER_FEED - i;
    return {
      title: `${feed.title} ${article ? 'post' : 'episode'} ${n}`,
      description: `Fake description of item ${n} of ${feed.title}.`,
      item_type: article ? 'article' : 'podcast_episode',
      url: article ? `https://example.com/${slug}/${n}` : null,
      audio_url: article ? null : `https://example.com/audio/${slug}-${n}.mp3`,
      duration: article ? null : 1800 + i * 60,
      published_at: new Date(now - i * 86400000 - index * 3 * 3600000).toISOString(),
    };
  });
}

async function previewAnswer(feedUrl, query, res) {
  const feed = catalogFeed(feedUrl);
  await wait(feed?.delay ?? 600);
  if (feed?.broken) return res.status(500).json({ error: 'Fake error: this preview feed always fails' });
  const limit = query.limit !== undefined ? Number(query.limit) : 50;
  const offset = Number(query.offset || 0);
  const all = feedEpisodes(feedUrl);
  res.json({ episodes: all.slice(offset, offset + limit), hasMore: offset + limit < all.length });
}

app.get('/api/podcasts', (req, res) => res.json(db.podcasts.filter(p => p.is_subscribed !== false)));

app.get('/api/podcasts/search', async (req, res) => {
  await wait(400);
  const q = String(req.query.q || 'Preview Podcast');
  if (/^https?:\/\//i.test(q)) {
    return res.json([catalogFeed(q) || {
      title: 'Preview Feed',
      author: 'Preview Network',
      description: 'Fake search result, for previewing the subscribe flow only.',
      feed_url: q,
      type: 'podcast',
    }]);
  }
  const matches = MOCK_FEEDS.filter(f => f.title.toLowerCase().includes(q.toLowerCase()));
  res.json(matches.length > 0 ? matches : MOCK_FEEDS);
});

app.post('/api/podcasts/subscribe', async (req, res) => {
  await wait(400);
  const feedUrl = req.body.feed_url;
  const known = catalogFeed(feedUrl);
  let title = known?.title || 'Preview Podcast';
  if (!known) {
    try {
      const u = new URL(feedUrl);
      const last = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() || u.hostname);
      title = last.replace(/\.(xml|rss)$/i, '') || title;
    } catch { /* keep default title */ }
  }
  // Like the real backend, a feed subscribed before is the same row again
  let podcast = db.podcasts.find(p => p.feed_url === feedUrl);
  if (podcast) {
    podcast.is_subscribed = true;
  } else {
    podcast = {
      id: db.nextPodcastId++,
      title,
      author: known?.author || 'Preview Network',
      description: known?.description || 'Fake subscribed feed, not a real one.',
      feed_url: feedUrl,
      website_url: 'https://example.com',
      category: 'Technology',
      language: 'en',
      type: known?.type || 'podcast',
      is_subscribed: true,
      subscribed_at: new Date().toISOString(),
    };
    db.podcasts.push(podcast);
  }
  saveData();
  res.status(201).json(podcast);
});

app.delete('/api/podcasts/:id', async (req, res) => {
  await wait(300);
  const podcast = db.podcasts.find(p => p.id === Number(req.params.id));
  if (!podcast) return res.status(404).json({ error: 'Podcast not found' });
  podcast.is_subscribed = false;
  saveData();
  res.json(podcast);
});

app.get('/api/podcasts/preview-by-url', (req, res) => previewAnswer(String(req.query.url), req.query, res));

app.get('/api/podcasts/:id/preview-episodes', (req, res) => {
  const podcast = db.podcasts.find(p => p.id === Number(req.params.id));
  if (!podcast) return res.status(404).json({ error: 'Podcast not found' });
  previewAnswer(podcast.feed_url, req.query, res);
});

app.get('/api/podcasts/search-feed', async (req, res) => {
  await wait(300);
  const q = String(req.query.q || '').toLowerCase();
  res.json(feedEpisodes(String(req.query.url)).filter(ep => ep.title.toLowerCase().includes(q)).slice(0, 50));
});

// Cached items of subscribed feeds that were refreshed at least once
app.get('/api/podcasts/feed-items', (req, res) => {
  const limit = Number(req.query.limit || 50);
  const offset = Number(req.query.offset || 0);
  const items = db.podcasts
    .filter(p => p.is_subscribed !== false && p.last_refreshed_at)
    .flatMap(p => feedEpisodes(p.feed_url).slice(0, 100).map(ep => ({ ...ep, feed_id: p.id, podcast_show_name: p.title, feed_type: p.type })))
    .sort((a, b) => b.published_at.localeCompare(a.published_at));
  res.json(items.slice(offset, offset + limit));
});

app.post('/api/podcasts/refresh-feeds', async (req, res) => {
  await wait(3000);
  const now = new Date().toISOString();
  const subscribed = db.podcasts.filter(p => p.is_subscribed !== false);
  subscribed.forEach(p => { p.last_refreshed_at = now; });
  saveData();
  res.json({ totalFeeds: subscribed.length, totalItemsAdded: 0 });
});

app.get('/api/podcasts/last-refresh', (req, res) => {
  const times = db.podcasts.filter(p => p.is_subscribed !== false && p.last_refreshed_at).map(p => p.last_refreshed_at).sort();
  res.json({ lastRefresh: times.length ? times[times.length - 1] : null });
});

// Anything else: harmless empty response so the real UI renders with empty states
// instead of erroring, rather than trying to enumerate every route by hand.
app.use('/api', (req, res) => res.json(req.method === 'GET' ? [] : {}));

const PORT = 3001;
app.listen(PORT, () => {
  console.log(`[mock-server] preview backend listening on http://localhost:${PORT}`);
  console.log(`[mock-server] fake data file: ${DATA_FILE}`);
});
