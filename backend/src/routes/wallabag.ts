import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { query } from '../database/db.js';
import { WallabagService } from '../services/wallabag-service.js';
import { fullSync, syncFromWallabag, syncToWallabag, hasNosyncTag } from '../services/wallabag-sync.js';
import { deleteAudioFile } from '../services/audio-storage.js';

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

    // Count pending changes (items that would be pushed). nosync items are never pushed so they must not count as pending.
    const pendingResult = await query(
      `SELECT id, tags FROM content_items
       WHERE user_id = $1
       AND (wallabag_id IS NULL OR wallabag_needs_push = TRUE)`,
      [req.user!.userId]
    );
    const pendingChanges = pendingResult.rows.filter((row) => !hasNosyncTag(row.tags)).length;

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
    // Check if this is a full refresh (ignore timestamp)
    const fullRefresh = req.query.full === 'true';

    if (fullRefresh) {
      console.log('[Wallabag] Full refresh requested - ignoring last sync timestamp');
      // Delete the last sync timestamp so we fetch everything
      await query(
        `DELETE FROM user_settings
         WHERE user_id = $1 AND setting_key = 'wallabag_last_sync'`,
        [req.user!.userId]
      );
    }

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
 */
router.post('/push', async (req, res) => {
  console.log('[Wallabag] Push endpoint called by user:', req.user!.userId);
  try {
    const result = await syncToWallabag(req.user!.userId);
    console.log('[Wallabag] Push result:', result);
    res.json({ pushed: result.count, errors: result.errors });
  } catch (error) {
    console.error('[Wallabag] Push error:', error);
    res.status(500).json({ error: 'Push failed' });
  }
});

/**
 * POST /api/wallabag/cleanup
 * Emergency cleanup: Delete recently synced items from Wallabag
 *
 * Deletes items that:
 * - Have a wallabag_id (were synced from Wallabag)
 * - Were created in the last 2 hours
 * - Are NOT starred
 * - Do NOT have audio
 */
router.post('/cleanup', async (req, res) => {
  console.log('[Wallabag] Cleanup endpoint called by user:', req.user!.userId);
  try {
    // hoursAgo comes straight from the request body on a DELETE path, so coerce it to a
    // safe integer and bind it as a query parameter (never interpolate it into the SQL
    // text). Fall back to 2 and clamp to one week so a caller cannot request an absurd
    // window or change the query structure.
    let hoursAgo = Number.parseInt(req.body.hoursAgo, 10);
    if (Number.isNaN(hoursAgo) || hoursAgo < 1) hoursAgo = 2; // Default 2 hours
    if (hoursAgo > 168) hoursAgo = 168; // Clamp to one week (168 hours) max

    // First, count how many will be deleted
    const countResult = await query(
      `SELECT COUNT(*) as count FROM content_items
       WHERE user_id = $1
       AND wallabag_id IS NOT NULL
       AND created_at > NOW() - make_interval(hours => $2)
       AND is_starred = FALSE
       AND audio_data IS NULL
       AND audio_url IS NULL`,
      [req.user!.userId, hoursAgo]
    );
    const count = parseInt(countResult.rows[0].count, 10);

    let deletedCount = 0;

    // Delete items if any exist
    if (count > 0) {
      const deleteResult = await query(
        `DELETE FROM content_items
         WHERE user_id = $1
         AND wallabag_id IS NOT NULL
         AND created_at > NOW() - make_interval(hours => $2)
         AND is_starred = FALSE
         AND audio_data IS NULL
         AND audio_url IS NULL
         RETURNING id`,
        [req.user!.userId, hoursAgo]
      );
      deletedCount = deleteResult.rows.length;
      // Delete any on-disk audio file for each removed row, otherwise the mp3s orphan on /data.
      // Run in parallel. deleteAudioFile is best-effort (never throws), and allSettled makes
      // sure one failed unlink cannot abort the rest.
      await Promise.allSettled(deleteResult.rows.map((row) => deleteAudioFile(row.id)));
      console.log('[Wallabag] Cleanup deleted', deletedCount, 'items');
    } else {
      console.log('[Wallabag] No items to delete');
    }

    // ALWAYS reset last sync timestamp, even if no items were deleted
    // This allows users to "start fresh" with their Wallabag sync
    await query(
      `DELETE FROM user_settings
       WHERE user_id = $1 AND setting_key = 'wallabag_last_sync'`,
      [req.user!.userId]
    );
    console.log('[Wallabag] Reset last sync timestamp');

    res.json({
      deleted: deletedCount,
      message: deletedCount > 0
        ? `Deleted ${deletedCount} recently synced items. Last sync timestamp reset.`
        : 'No items to delete. Last sync timestamp reset - next sync will fetch all entries.'
    });
  } catch (error) {
    console.error('[Wallabag] Cleanup error:', error);
    res.status(500).json({ error: 'Cleanup failed' });
  }
});

export default router;
