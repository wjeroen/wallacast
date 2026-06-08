import express from 'express';
import { query } from '../database/db.js';

const router = express.Router();

// Get queue (manual items only). Aliases queue_items columns so they don't
// collide with content_items.id/position joined via c.*
router.get('/', async (req, res) => {
  try {
    const result = await query(
      `SELECT q.id AS queue_id, q.position AS queue_position, q.added_at AS queue_added_at, c.*
       FROM queue_items q
       JOIN content_items c ON q.content_item_id = c.id
       WHERE q.user_id = $1
       ORDER BY q.position ASC`,
      [req.user!.userId]
    );
    res.json(result.rows);
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

    const result = await query(
      'INSERT INTO queue_items (content_item_id, position, user_id) VALUES ($1, $2, $3) RETURNING id, position, added_at',
      [content_item_id, nextPosition, req.user!.userId]
    );

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
