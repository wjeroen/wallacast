import express from 'express';
import { query } from '../database/db.js';
import { searchPodcasts, searchRSSByUrl, subscribeToPodcast, fetchPodcastEpisodes, getPreviewEpisodes, searchFeedEpisodes, getCachedFeedItems, startFeedRefresh, getFeedRefreshStatus, getLastRefreshTime } from '../services/podcast-service.js';
import { reserveRefresh } from '../services/token-limits.js';

/** An API token gets at most this many feed items per request, the app's own page size
 *  (FEED_PAGE_SIZE in the frontend's feedStore.ts). It pages on with offset. */
const TOKEN_FEED_PAGE_MAX = 50;

const router = express.Router();

// Get all subscribed podcasts
router.get('/', async (req, res) => {
  try {
    const result = await query(
      'SELECT * FROM podcasts WHERE user_id = $1 AND is_subscribed = true ORDER BY title ASC',
      [req.user!.userId]
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching podcasts:', error);
    res.status(500).json({ error: 'Failed to fetch podcasts' });
  }
});

// Helper function to detect if query looks like a URL
function looksLikeUrl(query: string): boolean {
  return (
    query.includes('://') ||
    (query.includes('.') && !query.includes(' ')) ||
    query.startsWith('www.')
  );
}

// Search for podcasts or RSS feeds
router.get('/search', async (req, res) => {
  try {
    const { q } = req.query;

    if (!q || typeof q !== 'string') {
      return res.status(400).json({ error: 'Search query required' });
    }

    // Detect if query is a URL or search term
    if (looksLikeUrl(q)) {
      // Treat as URL - fetch RSS feed directly
      const results = await searchRSSByUrl(q);
      res.json(results);
    } else {
      // Treat as search term - use iTunes API
      const results = await searchPodcasts(q);
      res.json(results);
    }
  } catch (error) {
    console.error('Error searching podcasts:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to search' });
  }
});

// Subscribe to a podcast
router.post('/subscribe', async (req, res) => {
  try {
    const { feed_url } = req.body;

    if (!feed_url) {
      return res.status(400).json({ error: 'Feed URL required' });
    }

    const podcast = await subscribeToPodcast(feed_url, req.user!.userId);
    res.status(201).json(podcast);
  } catch (error) {
    console.error('Error subscribing to podcast:', error);
    res.status(500).json({ error: 'Failed to subscribe to podcast' });
  }
});

// Unsubscribe from a podcast
router.delete('/:id', async (req, res) => {
  try {
    const result = await query(
      'UPDATE podcasts SET is_subscribed = false WHERE id = $1 AND user_id = $2 RETURNING *',
      [req.params.id, req.user!.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Podcast not found' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error unsubscribing from podcast:', error);
    res.status(500).json({ error: 'Failed to unsubscribe' });
  }
});

// Fetch latest episodes for a podcast (DISABLED - auto-adding episodes to library was unwanted)
// Users should manually add episodes via the "Add to Library" button
/*
router.post('/:id/refresh', async (req, res) => {
  try {
    const podcastResult = await query(
      'SELECT * FROM podcasts WHERE id = $1 AND user_id = $2',
      [req.params.id, req.user!.userId]
    );

    if (podcastResult.rows.length === 0) {
      return res.status(404).json({ error: 'Podcast not found' });
    }

    const podcast = podcastResult.rows[0];
    const episodes = await fetchPodcastEpisodes(podcast.feed_url, podcast.id, req.user!.userId);

    await query(
      'UPDATE podcasts SET last_fetched_at = CURRENT_TIMESTAMP WHERE id = $1',
      [podcast.id]
    );

    res.json({ episodes });
  } catch (error) {
    console.error('Error refreshing podcast:', error);
    res.status(500).json({ error: 'Failed to refresh podcast' });
  }
});
*/

// Get preview episodes from feed (without saving)
router.get('/:id/preview-episodes', async (req, res) => {
  try {
    const podcastResult = await query(
      'SELECT feed_url FROM podcasts WHERE id = $1 AND user_id = $2',
      [req.params.id, req.user!.userId]
    );

    if (podcastResult.rows.length === 0) {
      return res.status(404).json({ error: 'Podcast not found' });
    }

    const podcast = podcastResult.rows[0];
    const limit = req.query.limit !== undefined ? parseInt(req.query.limit as string) : 50;
    const offset = req.query.offset ? parseInt(req.query.offset as string) : 0;
    const result = await getPreviewEpisodes(podcast.feed_url, limit, offset);

    res.json(result);
  } catch (error) {
    console.error('Error fetching preview episodes:', error);
    res.status(500).json({ error: 'Failed to fetch preview episodes' });
  }
});

// Get preview episodes from feed URL (without subscription)
router.get('/preview-by-url', async (req, res) => {
  try {
    const { url, limit, offset } = req.query;

    if (!url || typeof url !== 'string') {
      return res.status(400).json({ error: 'Feed URL required' });
    }

    const parsedLimit = limit !== undefined ? parseInt(limit as string) : 50;
    const parsedOffset = offset ? parseInt(offset as string) : 0;
    const result = await getPreviewEpisodes(url, parsedLimit, parsedOffset);

    res.json(result);
  } catch (error: any) {
    console.error('Error fetching preview by URL:', error);
    const errorMessage = error?.message || 'Failed to fetch preview';
    console.error('Error message:', errorMessage);
    res.status(500).json({ error: errorMessage });
  }
});

router.get('/search-feed', async (req, res) => {
  try {
    const { url, q } = req.query;
    if (!url || typeof url !== 'string' || !q || typeof q !== 'string') {
      return res.status(400).json({ error: 'Feed URL and search query required' });
    }
    const results = await searchFeedEpisodes(url, q);
    res.json(results);
  } catch (error: any) {
    console.error('Error searching feed:', error);
    res.status(500).json({ error: error?.message || 'Failed to search feed' });
  }
});

// --- Feed Caching Endpoints ---

// Get cached feed items from database (instant, no network requests)
router.get('/feed-items', async (req, res) => {
  try {
    const { feedId, limit, offset } = req.query;
    const whole = (raw: unknown, fallback: number) => {
      const n = typeof raw === 'string' ? parseInt(raw, 10) : NaN;
      return Number.isFinite(n) && n >= 0 ? n : fallback;
    };
    const parsedFeedId = feedId ? whole(feedId, 0) || undefined : undefined;
    let parsedLimit = whole(limit, 50) || 50;
    if (req.apiToken) parsedLimit = Math.min(parsedLimit, TOKEN_FEED_PAGE_MAX);
    const parsedOffset = whole(offset, 0);

    const items = await getCachedFeedItems(req.user!.userId, parsedFeedId, parsedLimit, parsedOffset);
    res.json(items);
  } catch (error) {
    console.error('Error fetching cached feed items:', error);
    res.status(500).json({ error: 'Failed to fetch feed items' });
  }
});

// Refresh all subscribed feeds from network (fetches RSS and updates cache). The refresh runs
// in the background and this answers 202 at once with its status, also when one is already
// running for this user (see startFeedRefresh). The app polls GET /refresh-status. An API
// token may start one refresh every REFRESH_INTERVAL_MINUTES (429 with retry_after_seconds).
router.post('/refresh-feeds', async (req, res) => {
  try {
    if (req.apiToken) {
      const allowed = await reserveRefresh(req.apiToken);
      if (!allowed.ok) {
        return res.status(429).json({ error: allowed.message, retry_after_seconds: allowed.retryAfterSeconds });
      }
    }
    res.status(202).json(startFeedRefresh(req.user!.userId));
  } catch (error) {
    console.error('Error starting a feed refresh:', error);
    res.status(500).json({ error: 'Failed to start a feed refresh' });
  }
});

// Status of this user's latest feed refresh: { running, startedAt, finishedAt, error,
// totalFeeds, totalItemsAdded }, or { running: false } when there was none since the server
// started.
router.get('/refresh-status', (req, res) => {
  res.json(getFeedRefreshStatus(req.user!.userId));
});

// Get last refresh timestamp for user's feeds
router.get('/last-refresh', async (req, res) => {
  try {
    const lastRefresh = await getLastRefreshTime(req.user!.userId);
    res.json({ lastRefresh });
  } catch (error) {
    console.error('Error getting last refresh time:', error);
    res.status(500).json({ error: 'Failed to get last refresh time' });
  }
});

export default router;
