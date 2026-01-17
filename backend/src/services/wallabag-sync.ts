import { query } from '../database/db.js';
import { WallabagService, WallabagEntry } from './wallabag-service.js';

/**
 * Wallabag Sync Service
 *
 * Handles bidirectional synchronization between Wallacast and Wallabag.
 */

// ============================================================================
// Type Definitions
// ============================================================================

export interface SyncResult {
  count: number;       // Items processed
  errors: string[];    // Error messages for failed items
}

export interface FullSyncResult {
  pulled: number;
  pushed: number;
  errors: string[];
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Determine Wallacast type from Wallabag entry
 */
function detectTypeFromWallabag(entry: WallabagEntry): 'article' | 'text' | 'podcast_episode' {
  const tagSlugs = entry.tags.map(t => t.slug.toLowerCase());

  // Check explicit type tags first
  if (tagSlugs.includes('podcast')) return 'podcast_episode';
  if (tagSlugs.includes('text')) return 'text';
  if (tagSlugs.includes('article')) return 'article';

  // Infer from URL pattern
  if (entry.url.startsWith('wallacast://text/')) return 'text';
  if (entry.url.startsWith('wallacast://podcast/')) return 'podcast_episode';

  // Check for audio file extensions
  const audioExtensions = ['.mp3', '.m4a', '.wav', '.ogg', '.opus', '.aac'];
  const urlLower = entry.url.toLowerCase();
  if (audioExtensions.some(ext => urlLower.includes(ext))) {
    return 'podcast_episode';
  }

  // Default to article
  return 'article';
}

/**
 * Get the tag string that should be used for a Wallacast type
 */
function getTypeTag(type: string): string {
  switch (type) {
    case 'podcast_episode': return 'podcast';
    case 'text': return 'text';
    default: return 'article';
  }
}

/**
 * Check if entry should be skipped (has nosync tag)
 */
function shouldSkip(entry: WallabagEntry): boolean {
  return entry.tags.some(t => {
    const labelLower = t.label.toLowerCase();
    const slugLower = t.slug.toLowerCase();
    return slugLower === 'nosync' ||
           labelLower === 'nosync' ||
           labelLower === '#nosync';
  });
}

/**
 * Get a user setting from the database
 */
async function getUserSetting(userId: number, key: string): Promise<string | null> {
  const result = await query(
    'SELECT setting_value FROM user_settings WHERE user_id = $1 AND setting_key = $2',
    [userId, key]
  );
  return result.rows[0]?.setting_value || null;
}

/**
 * Set a user setting in the database
 */
async function setUserSetting(
  userId: number,
  key: string,
  value: string,
  isSecret = false
): Promise<void> {
  await query(
    `INSERT INTO user_settings (user_id, setting_key, setting_value, is_secret)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id, setting_key) DO UPDATE SET
       setting_value = EXCLUDED.setting_value,
       updated_at = NOW()`,
    [userId, key, value, isSecret]
  );
}

// ============================================================================
// Sync Functions
// ============================================================================

/**
 * Pull changes from Wallabag into Wallacast
 */
export async function syncFromWallabag(userId: number): Promise<SyncResult> {
  console.log('[Wallabag Sync] Starting pull for user:', userId);

  const wallabag = new WallabagService(userId);
  const errors: string[] = [];
  let count = 0;

  // Check if enabled
  if (!(await wallabag.isEnabled())) {
    console.log('[Wallabag Sync] Sync not enabled');
    return { count: 0, errors: ['Wallabag sync not enabled'] };
  }

  try {
    // Get last sync timestamp
    const lastSync = await getUserSetting(userId, 'wallabag_last_sync');
    console.log('[Wallabag Sync] Last sync:', lastSync || 'never');

    // Fetch entries modified since last sync (or all if first sync)
    const entries = await wallabag.fetchEntries(lastSync || undefined);
    console.log('[Wallabag Sync] Fetched', entries.length, 'entries from Wallabag');

    for (const entry of entries) {
      try {
        // Skip nosync entries
        if (shouldSkip(entry)) {
          console.log('[Wallabag Sync] Skipping entry', entry.id, '(has nosync tag)');
          continue;
        }

        // Determine content type
        const type = detectTypeFromWallabag(entry);
        console.log('[Wallabag Sync] Processing entry', entry.id, `"${entry.title}" as type:`, type);

        // Check if we already have this item
        const existing = await query(
          'SELECT id, updated_at FROM content_items WHERE wallabag_id = $1 AND user_id = $2',
          [entry.id, userId]
        );

        // Build tags string from Wallabag tags
        const tagsString = entry.tags.map(t => t.label).join(',');

        if (existing.rows.length > 0) {
          // UPDATE existing item
          console.log('[Wallabag Sync] Updating existing item:', existing.rows[0].id);

          if (type === 'podcast_episode') {
            await query(
              `UPDATE content_items SET
                title = $1,
                transcript = $2,
                is_starred = $3,
                is_archived = $4,
                tags = $5,
                preview_picture = $6,
                wallabag_updated_at = $7,
                updated_at = NOW()
              WHERE id = $8`,
              [
                entry.title,
                entry.content,  // Wallabag content → transcript for podcasts
                entry.is_starred === 1,
                entry.is_archived === 1,
                tagsString,
                entry.preview_picture,
                entry.updated_at,
                existing.rows[0].id,
              ]
            );
          } else {
            // Articles and texts
            await query(
              `UPDATE content_items SET
                title = $1,
                content = $2,
                html_content = $3,
                is_starred = $4,
                is_archived = $5,
                tags = $6,
                preview_picture = $7,
                wallabag_updated_at = $8,
                updated_at = NOW()
              WHERE id = $9`,
              [
                entry.title,
                entry.content,
                entry.content,  // Store in both fields
                entry.is_starred === 1,
                entry.is_archived === 1,
                tagsString,
                entry.preview_picture,
                entry.updated_at,
                existing.rows[0].id,
              ]
            );
          }
        } else {
          // INSERT new item
          console.log('[Wallabag Sync] Creating new item for entry:', entry.id);

          if (type === 'podcast_episode') {
            await query(
              `INSERT INTO content_items
                (type, title, url, transcript, is_starred, is_archived, tags,
                 preview_picture, wallabag_id, wallabag_updated_at, user_id,
                 author, published_at)
              VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
              [
                type,
                entry.title,
                entry.url,
                entry.content,  // Wallabag content = transcript
                entry.is_starred === 1,
                entry.is_archived === 1,
                tagsString,
                entry.preview_picture,
                entry.id,
                entry.updated_at,
                userId,
                entry.published_by?.[0] || null,
                entry.published_at,
              ]
            );
          } else {
            // Articles and texts
            await query(
              `INSERT INTO content_items
                (type, title, url, content, html_content, is_starred, is_archived, tags,
                 preview_picture, wallabag_id, wallabag_updated_at, user_id,
                 author, published_at)
              VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
              [
                type,
                entry.title,
                entry.url,
                entry.content,
                entry.content,
                entry.is_starred === 1,
                entry.is_archived === 1,
                tagsString,
                entry.preview_picture,
                entry.id,
                entry.updated_at,
                userId,
                entry.published_by?.[0] || null,
                entry.published_at,
              ]
            );
          }

          // TODO: Optionally trigger TTS generation for new articles/texts
          // TODO: Optionally trigger transcription for new podcasts (if audio URL accessible)
        }

        count++;
      } catch (error) {
        const errorMsg = `Entry ${entry.id} (${entry.title}): ${error}`;
        console.error('[Wallabag Sync]', errorMsg);
        errors.push(errorMsg);
      }
    }

    // Update last sync timestamp
    await setUserSetting(userId, 'wallabag_last_sync', new Date().toISOString());
    console.log('[Wallabag Sync] Pull complete:', count, 'items synced,', errors.length, 'errors');

    return { count, errors };
  } catch (error) {
    console.error('[Wallabag Sync] Pull failed:', error);
    errors.push(`Sync failed: ${error}`);
    return { count, errors };
  }
}

/**
 * Push changes from Wallacast to Wallabag
 * TODO: Implement in next phase
 */
export async function syncToWallabag(userId: number): Promise<SyncResult> {
  console.log('[Wallabag Sync] Push not yet implemented');
  return { count: 0, errors: ['Push sync not yet implemented'] };
}

/**
 * Full bidirectional sync (pull then push)
 */
export async function fullSync(userId: number): Promise<FullSyncResult> {
  console.log('[Wallabag Sync] Starting full sync for user:', userId);

  // Pull first to get latest from Wallabag
  const pullResult = await syncFromWallabag(userId);

  // Then push so that Wallacast changes win any conflicts
  const pushResult = await syncToWallabag(userId);

  return {
    pulled: pullResult.count,
    pushed: pushResult.count,
    errors: [...pullResult.errors, ...pushResult.errors],
  };
}

/**
 * Delete a specific entry from Wallabag (called when deleting locally)
 * TODO: Implement in Phase 5
 */
export async function deleteFromWallabag(
  userId: number,
  wallabagId: number
): Promise<boolean> {
  const wallabag = new WallabagService(userId);

  if (!(await wallabag.isEnabled())) {
    return false;  // Not an error, just skip
  }

  return wallabag.deleteEntry(wallabagId);
}
