import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { query } from '../database/db.js';
import { WallabagService } from '../services/wallabag-service.js';

const router = Router();

// All routes require authentication
router.use(requireAuth);

/**
 * POST /api/wallabag/test
 * Test connection with current credentials
 */
router.post('/test', async (req, res) => {
  try {
    const service = new WallabagService(req.user!.userId);
    const result = await service.testConnection();
    res.json(result);
  } catch (error) {
    console.error('Wallabag test error:', error);
    res.status(500).json({ success: false, error: 'Internal error' });
  }
});

/**
 * GET /api/wallabag/status
 * Get sync status information
 */
router.get('/status', async (req, res) => {
  try {
    const service = new WallabagService(req.user!.userId);
    const enabled = await service.isEnabled();

    // Get last sync time
    const lastSyncResult = await query(
      'SELECT setting_value FROM user_settings WHERE user_id = $1 AND setting_key = $2',
      [req.user!.userId, 'wallabag_last_sync']
    );
    const lastSync = lastSyncResult.rows[0]?.setting_value || null;

    // Count pending changes (items that would be pushed)
    const pendingResult = await query(
      `SELECT COUNT(*) as count FROM content_items
       WHERE user_id = $1
       AND (wallabag_id IS NULL OR updated_at > COALESCE(wallabag_updated_at, '1970-01-01'::timestamp))`,
      [req.user!.userId]
    );
    const pendingChanges = parseInt(pendingResult.rows[0].count, 10);

    res.json({
      enabled,
      lastSync,
      pendingChanges,
    });
  } catch (error) {
    console.error('Wallabag status error:', error);
    res.status(500).json({ error: 'Failed to get status' });
  }
});

/**
 * POST /api/wallabag/sync
 * Full bidirectional sync (pull then push)
 *
 * TODO: Implement once wallabag-sync.ts is created
 */
router.post('/sync', async (req, res) => {
  try {
    // const result = await fullSync(req.user!.userId);
    // res.json(result);
    res.status(501).json({ error: 'Sync not yet implemented' });
  } catch (error) {
    console.error('Wallabag sync error:', error);
    res.status(500).json({ error: 'Sync failed', details: String(error) });
  }
});

/**
 * POST /api/wallabag/pull
 * Pull changes from Wallabag into Wallacast
 *
 * TODO: Implement once wallabag-sync.ts is created
 */
router.post('/pull', async (req, res) => {
  try {
    // const result = await syncFromWallabag(req.user!.userId);
    // res.json({ pulled: result.count, errors: result.errors });
    res.status(501).json({ error: 'Pull not yet implemented' });
  } catch (error) {
    console.error('Wallabag pull error:', error);
    res.status(500).json({ error: 'Pull failed' });
  }
});

/**
 * POST /api/wallabag/push
 * Push changes from Wallacast to Wallabag
 *
 * TODO: Implement once wallabag-sync.ts is created
 */
router.post('/push', async (req, res) => {
  try {
    // const result = await syncToWallabag(req.user!.userId);
    // res.json({ pushed: result.count, errors: result.errors });
    res.status(501).json({ error: 'Push not yet implemented' });
  } catch (error) {
    console.error('Wallabag push error:', error);
    res.status(500).json({ error: 'Push failed' });
  }
});

export default router;
