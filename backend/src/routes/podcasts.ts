import express from 'express';
import { query } from '../database/db.js';
import { searchPodcasts, searchRSSByUrl, subscribeToPodcast, fetchPodcastEpisodes, getPreviewEpisodes } from '../services/podcast-service.js';

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
    const episodes = await getPreviewEpisodes(podcast.feed_url);

    res.json(episodes);
  } catch (error) {
    console.error('Error fetching preview episodes:', error);
    res.status(500).json({ error: 'Failed to fetch preview episodes' });
  }
});

// Get preview episodes from feed URL (without subscription)
router.get('/preview-by-url', async (req, res) => {
  try {
    const { url } = req.query;

    if (!url || typeof url !== 'string') {
      return res.status(400).json({ error: 'Feed URL required' });
    }

    const episodes = await getPreviewEpisodes(url);
    res.json(episodes);
  } catch (error) {
    console.error('Error fetching preview by URL:', error);
    res.status(500).json({ error: 'Failed to fetch preview' });
  }
});

// Get episodes for a podcast (saved in library)
router.get('/:id/episodes', async (req, res) => {
  try {
    const result = await query(
      'SELECT * FROM content_items WHERE podcast_id = $1 AND user_id = $2 ORDER BY published_at DESC',
      [req.params.id, req.user!.userId]
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching episodes:', error);
    res.status(500).json({ error: 'Failed to fetch episodes' });
  }
});

export default router;
