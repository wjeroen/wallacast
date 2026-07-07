import express from 'express';
import { query } from '../database/db.js';
import { withAudioToken } from '../services/audio-token.js';

const router = express.Router();

// Get queue (manual items only). Aliases queue_items columns so they don't collide
// with content_items. Uses the SAME lean column list as GET /api/content (never c.*),
// so it never ships audio_data (BYTEA), transcript, html_content, comments, or
// content_alignment. Selecting c.* shipped all of those per queued item (multi-MB each),
// the same class of bug as the 80GB data-transfer incident.
router.get('/', async (req, res) => {
  try {
    const result = await query(
      `SELECT q.id AS queue_id, q.position AS queue_position, q.added_at AS queue_added_at,
              c.id, c.type, c.title, c.url, c.content, c.author, c.description, c.preview_picture,
              c.audio_url, c.duration, c.file_size, c.podcast_id, c.podcast_show_name, c.episode_number,
              c.published_at, c.is_starred, c.is_archived, c.tags, c.playback_position, c.playback_speed,
              c.last_played_at, c.created_at, c.updated_at, c.generation_status, c.generation_progress,
              c.generation_error, c.current_operation, c.tts_chunks, c.transcript_words, c.karma,
              c.agree_votes, c.disagree_votes, c.summary, c.summary_status, c.summary_generated_at,
              c.summary_error, COALESCE(c.comment_count_total, 0) AS comment_count
       FROM queue_items q
       JOIN content_items c ON q.content_item_id = c.id AND c.user_id = q.user_id
       WHERE q.user_id = $1
       ORDER BY q.position ASC`,
      [req.user!.userId]
    );
    res.json(result.rows.map(withAudioToken));
  } catch (error) {
    console.error('Error fetching queue:', error);
    res.status(500).json({ error: 'Failed to fetch queue' });
  }
});

// Add to queue (appends at end)
router.post('/', async (req, res) => {
  try {
    const { content_item_id } = req.body;

    const maxPositionResult = await query(
      'SELECT COALESCE(MAX(position), -1) as max_position FROM queue_items WHERE user_id = $1',
      [req.user!.userId]
    );
    const nextPosition = maxPositionResult.rows[0].max_position + 1;

    // Only enqueue an item the caller actually owns. INSERT ... SELECT writes the row
    // only when content_items has a matching id for THIS user, so a stranger cannot
    // enqueue (and then read back via GET /) someone else's content.
    const result = await query(
      `INSERT INTO queue_items (content_item_id, position, user_id)
       SELECT $1, $2, $3 FROM content_items WHERE id = $1 AND user_id = $3
       RETURNING id, position, added_at`,
      [content_item_id, nextPosition, req.user!.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Content item not found' });
    }

    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('Error adding to queue:', error);
    res.status(500).json({ error: 'Failed to add to queue' });
  }
});

// Add to front of queue (position 0, bumps all others). Used when a manual
// item's audio finishes generating and should play next.
router.post('/front', async (req, res) => {
  try {
    const { content_item_id } = req.body;

    // Verify ownership before touching the queue, so a foreign or invalid id can't slip
    // in and can't leave a gap at position 0 after the bump below.
    const owns = await query(
      'SELECT 1 FROM content_items WHERE id = $1 AND user_id = $2',
      [content_item_id, req.user!.userId]
    );
    if (owns.rows.length === 0) {
      return res.status(404).json({ error: 'Content item not found' });
    }

    await query(
      'UPDATE queue_items SET position = position + 1 WHERE user_id = $1',
      [req.user!.userId]
    );

    const result = await query(
      'INSERT INTO queue_items (content_item_id, position, user_id) VALUES ($1, 0, $2) RETURNING id, position, added_at',
      [content_item_id, req.user!.userId]
    );

    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('Error adding to front of queue:', error);
    res.status(500).json({ error: 'Failed to add to front of queue' });
  }
});

// Remove from queue
router.delete('/:id', async (req, res) => {
  try {
    const result = await query(
      'DELETE FROM queue_items WHERE id = $1 AND user_id = $2 RETURNING position',
      [req.params.id, req.user!.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Queue item not found' });
    }

    await query(
      'UPDATE queue_items SET position = position - 1 WHERE position > $1 AND user_id = $2',
      [result.rows[0].position, req.user!.userId]
    );

    res.json({ message: 'Removed from queue' });
  } catch (error) {
    console.error('Error removing from queue:', error);
    res.status(500).json({ error: 'Failed to remove from queue' });
  }
});

// Reorder queue
router.put('/reorder', async (req, res) => {
  try {
    const { items } = req.body; // Array of { id, position }

    for (const item of items) {
      await query(
        'UPDATE queue_items SET position = $1 WHERE id = $2 AND user_id = $3',
        [item.position, item.id, req.user!.userId]
      );
    }

    res.json({ message: 'Queue reordered' });
  } catch (error) {
    console.error('Error reordering queue:', error);
    res.status(500).json({ error: 'Failed to reorder queue' });
  }
});

// Clear queue
router.delete('/', async (req, res) => {
  try {
    await query('DELETE FROM queue_items WHERE user_id = $1', [req.user!.userId]);
    res.json({ message: 'Queue cleared' });
  } catch (error) {
    console.error('Error clearing queue:', error);
    res.status(500).json({ error: 'Failed to clear queue' });
  }
});

export default router;
