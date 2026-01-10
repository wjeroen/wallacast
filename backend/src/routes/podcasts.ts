import express from 'express';
import { query } from '../database/db.js';
import { searchPodcasts, subscribeToPodcast, fetchPodcastEpisodes } from '../services/podcast-service.js';

const router = express.Router();

// Get all subscribed podcasts
router.get('/', async (req, res) => {
  try {
    const result = await query(
      'SELECT * FROM podcasts WHERE is_subscribed = true ORDER BY title ASC'
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching podcasts:', error);
    res.status(500).json({ error: 'Failed to fetch podcasts' });
  }
});

// Search for podcasts
router.get('/search', async (req, res) => {
  try {
    const { q } = req.query;

    if (!q || typeof q !== 'string') {
      return res.status(400).json({ error: 'Search query required' });
    }

    const results = await searchPodcasts(q);
    res.json(results);
  } catch (error) {
    console.error('Error searching podcasts:', error);
    res.status(500).json({ error: 'Failed to search podcasts' });
  }
});

// Subscribe to a podcast
router.post('/subscribe', async (req, res) => {
  try {
    const { feed_url } = req.body;

    if (!feed_url) {
      return res.status(400).json({ error: 'Feed URL required' });
    }

    const podcast = await subscribeToPodcast(feed_url);
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
      'UPDATE podcasts SET is_subscribed = false WHERE id = $1 RETURNING *',
      [req.params.id]
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

// Fetch latest episodes for a podcast
router.post('/:id/refresh', async (req, res) => {
  try {
    const podcastResult = await query(
      'SELECT * FROM podcasts WHERE id = $1',
      [req.params.id]
    );

    if (podcastResult.rows.length === 0) {
      return res.status(404).json({ error: 'Podcast not found' });
    }

    const podcast = podcastResult.rows[0];
    const episodes = await fetchPodcastEpisodes(podcast.feed_url, podcast.id);

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

// Get episodes for a podcast
router.get('/:id/episodes', async (req, res) => {
  try {
    const result = await query(
      'SELECT * FROM content_items WHERE podcast_id = $1 ORDER BY published_at DESC',
      [req.params.id]
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching episodes:', error);
    res.status(500).json({ error: 'Failed to fetch episodes' });
  }
});

export default router;
