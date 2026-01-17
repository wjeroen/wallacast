import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { query } from '../database/db.js';
import { WallabagService } from '../services/wallabag-service.js';
import { fullSync, syncFromWallabag, syncToWallabag } from '../services/wallabag-sync.js';

const router = Router();

// All routes require authentication
router.use(requireAuth);

/**
 * POST /api/wallabag/test
 * Test connection with current credentials
 */
router.post('/test', async (req, res) => {
  console.log('[Wallabag] Test endpoint called by user:', req.user!.userId);
  try {
    const service = new WallabagService(req.user!.userId);
    const result = await service.testConnection();
    console.log('[Wallabag] Test result:', result);
    res.json(result);
  } catch (error) {
    console.error('[Wallabag] Test endpoint error:', error);
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
 */
router.post('/sync', async (req, res) => {
  console.log('[Wallabag] Full sync endpoint called by user:', req.user!.userId);
  try {
    const result = await fullSync(req.user!.userId);
    console.log('[Wallabag] Full sync result:', result);
    res.json(result);
  } catch (error) {
    console.error('[Wallabag] Sync error:', error);
    res.status(500).json({ error: 'Sync failed', details: String(error) });
  }
});

/**
 * POST /api/wallabag/pull
 * Pull changes from Wallabag into Wallacast
 */
router.post('/pull', async (req, res) => {
  console.log('[Wallabag] Pull endpoint called by user:', req.user!.userId);
  try {
    const result = await syncFromWallabag(req.user!.userId);
    console.log('[Wallabag] Pull result:', result);
    res.json({ pulled: result.count, errors: result.errors });
  } catch (error) {
    console.error('[Wallabag] Pull error:', error);
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
