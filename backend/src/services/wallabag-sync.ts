import { query } from '../database/db.js';
import { WallabagService, WallabagEntry } from './wallabag-service.js';
import { fetchArticleContent, isEAForumUrl } from './article-fetcher.js';
import { snapshotContentVersion } from './content-versions.js';
import {
  TYPE_TAGS,
  hasNosyncTag,
  mergeTagSets,
  normalizeTagList,
  sameTagSet,
  userTagsFromWallabagLabels,
  wallabagTagString,
} from './tags.js';

/**
 * Wallabag Sync Service
 *
 * Handles bidirectional synchronization between Wallacast and Wallabag.
 *
 * Safety rules (Wallacast is the source of truth, a sync must never ruin the library):
 *   - A pull never deletes a local item. A `nosync` tag seen in Wallabag MARKS the local
 *     item (tags gain `nosync`, so it is never pushed and later pulls skip it) instead of
 *     removing it and its generated audio.
 *   - A pull never overwrites a body Wallacast owns (`content_source` != 'wallabag',
 *     i.e. fetched by our own fetcher, edited, or imported). Wallabag's copy is its
 *     purified re-parse of what we pushed (classes and data attributes stripped), so
 *     pulling it back would degrade read-along elements, LLM blocks, tweets, footnotes.
 *     Only star/archive/tags flow in for such items. Bodies that came FROM Wallabag are
 *     still refreshed, with a version snapshot first.
 *   - Tags are merged three-way against `wallabag_synced_tags` (the set both sides had
 *     at the last sync), so an addition on either side survives and a tag only disappears
 *     when a side deliberately removed it. See mergeTagSets() in tags.ts.
 *   - Deletions never propagate from Wallabag to Wallacast.
 */

// Re-exported for callers that historically imported it from here.
export { hasNosyncTag };

// ============================================================================
// Type Definitions
// ============================================================================

export interface SyncResult {
  count: number;       // Items actually changed (created or updated), up-to-date entries are not counted
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
  const tagSlugs = (entry.tags || []).map(t => t.slug.toLowerCase());

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
 * Check if entry should be skipped (has nosync tag)
 */
function shouldSkip(entry: WallabagEntry): boolean {
  return (entry.tags || []).some(t => {
    const labelLower = t.label.toLowerCase();
    const slugLower = t.slug.toLowerCase();
    return slugLower === 'nosync' ||
           labelLower === 'nosync' ||
           labelLower === '#nosync';
  });
}

/**
 * The user's own tags on a Wallabag entry: type tags and nosync stripped, normalized.
 */
function userTagsOf(entry: WallabagEntry): string[] {
  return userTagsFromWallabagLabels((entry.tags || []).map(t => t.label));
}

/**
 * Whether the entry's tag list looks populated and Wallacast-managed: it carries one of
 * our type tags. Every entry we ever pushed has one, so a missing type tag means either
 * the response did not serialize tags or the user stripped everything in Wallabag; in
 * both cases we must not treat "no tags" as "remove all local tags".
 */
function hasTypeTag(entry: WallabagEntry): boolean {
  const labels = (entry.tags || []).map(t => t.label.toLowerCase());
  return (TYPE_TAGS as readonly string[]).some(t => labels.includes(t));
}

/**
 * A Wallabag entry carries the nosync tag: MARK every local item mapped to it instead of
 * deleting it. The local tags become Wallabag's user tags plus `nosync`, which the push
 * honors (never pushed) and the pending-changes count excludes. Nothing is destroyed:
 * removing the `nosync` chip in the tag editor (or the tag in Wallabag) resumes syncing.
 * Returns the number of local items newly marked.
 */
async function markLocalItemsNosync(userId: number, entry: WallabagEntry): Promise<number> {
  const existing = await query(
    'SELECT id, tags FROM content_items WHERE wallabag_id = $1 AND user_id = $2',
    [entry.id, userId]
  );
  let marked = 0;
  for (const row of existing.rows) {
    const localTags: string[] = row.tags || [];
    if (hasNosyncTag(localTags)) continue;
    const remoteUserTags = userTagsOf(entry);
    const merged = [...localTags];
    for (const t of remoteUserTags) if (!merged.includes(t)) merged.push(t);
    merged.push('nosync');
    await query(
      'UPDATE content_items SET tags = $1, wallabag_synced_tags = $2 WHERE id = $3 AND user_id = $4',
      [merged, [...remoteUserTags, 'nosync'], row.id, userId]
    );
    console.log(`[Wallabag Sync] item ${row.id} marked nosync (Wallabag entry ${entry.id} carries the tag); kept locally, never pushed`);
    marked++;
  }
  return marked;
}

/**
 * Three-way merge for one true/false flag (starred, archived).
 *
 * `base` is the value both sides agreed on at the last sync (`wallabag_synced_starred` /
 * `wallabag_synced_archived`). Whichever side moved away from it wins, which is the same
 * rule the tags use. Two cases fall back to the local value: an unknown base (an item that
 * predates this bookkeeping) and the two sides already agreeing. A flag has only two
 * values, so "both sides changed it to something different" cannot happen: if the values
 * differ, exactly one of them still matches the base.
 */
export function mergeFlag(
  base: boolean | null | undefined,
  local: boolean,
  remote: boolean
): boolean {
  if (base === null || base === undefined) return local;
  if (local === remote) return local;
  return local !== base ? local : remote;
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
    const { entries, complete } = await wallabag.fetchEntries(lastSync || undefined);
    console.log('[Wallabag Sync] Fetched', entries.length, 'entries from Wallabag');

    // Count items that were already current, logged once as a summary to avoid per-item spam.
    let upToDateCount = 0;

    for (const entry of entries) {
      try {
        // nosync entries are never pulled. A local copy is marked, not deleted.
        if (shouldSkip(entry)) {
          console.log('[Wallabag Sync] Entry', entry.id, 'has nosync tag');
          count += await markLocalItemsNosync(userId, entry);
          continue; // Skip processing this entry
        }

        // Determine content type
        const type = detectTypeFromWallabag(entry);
        console.log('[Wallabag Sync] Processing entry', entry.id, `"${entry.title}" as type:`, type);

        // Check if we already have this item
        const existing = await query(
          `SELECT id, updated_at, wallabag_updated_at, tags, wallabag_synced_tags, content_source,
                  is_starred, is_archived, wallabag_synced_starred, wallabag_synced_archived
             FROM content_items WHERE wallabag_id = $1 AND user_id = $2`,
          [entry.id, userId]
        );

        // The user's tags as Wallabag has them (type tags stripped, normalized)
        const remoteTags = userTagsOf(entry);

        if (existing.rows.length > 0) {
          const row = existing.rows[0];
          // Check for conflicts: Has local item been modified since last Wallabag sync?
          const localUpdated = new Date(row.updated_at);
          const lastWallabagSync = row.wallabag_updated_at
            ? new Date(row.wallabag_updated_at)
            : new Date(0); // If never synced, assume very old
          const wallabagUpdated = new Date(entry.updated_at);

          const localIsNewer = localUpdated > lastWallabagSync;
          const wallabagIsNewer = wallabagUpdated > lastWallabagSync;

          // Tags: three-way merge against the last synced set, so additions on either side
          // survive and only a deliberate removal drops a tag. The push sends the merged
          // list if it still differs from Wallabag's (the item is dirty in that case).
          const localTags: string[] = row.tags || [];
          const tagsToStore = hasTypeTag(entry)
            ? mergeTagSets(row.wallabag_synced_tags, localTags, remoteTags)
            : localTags; // tags absent from the response: never treat that as "remove all"
          const syncedTags = hasTypeTag(entry) ? remoteTags : row.wallabag_synced_tags;
          if (!sameTagSet(tagsToStore, localTags)) {
            // Logged here as well as in the reconciliation pass, so a tag change is always
            // traceable to the phase that applied it.
            console.log(`[Wallabag Sync] tags merged in pull for item ${row.id}: [${localTags.join(', ')}] -> [${tagsToStore.join(', ')}] (Wallabag has [${remoteTags.join(', ')}])`);
          }

          // Star and archive merge the same way tags do, and the result is used by EVERY
          // branch below. That matters: the branch classification leans on comparing two
          // clocks that the push comments already call unreliable, so the flags must come
          // out right whichever branch happens to run.
          const remoteStarred = entry.is_starred === 1;
          const remoteArchived = entry.is_archived === 1;
          const starToStore = mergeFlag(row.wallabag_synced_starred, row.is_starred, remoteStarred);
          const archivedToStore = mergeFlag(row.wallabag_synced_archived, row.is_archived, remoteArchived);
          if (starToStore !== row.is_starred || archivedToStore !== row.is_archived) {
            console.log(`[Wallabag Sync] flags merged in pull for item ${row.id}: starred ${row.is_starred} -> ${starToStore}, archived ${row.is_archived} -> ${archivedToStore} (Wallabag has starred ${remoteStarred}, archived ${remoteArchived})`);
          }
          // A merge that kept a local value Wallabag does not have yet must be pushed back.
          // The local edit normally set the dirty flag already, so this is a safety net for
          // the case where the flag was cleared by an earlier partial sync.
          const flagsNeedPush = starToStore !== remoteStarred || archivedToStore !== remoteArchived;

          // Body ownership: only bodies that came FROM Wallabag are refreshed from it.
          // Anything our fetcher/editor/importer produced is better than Wallabag's
          // purified copy of it, so those items only take metadata.
          const localOwnsBody = row.content_source !== 'wallabag';

          if (localIsNewer && wallabagIsNewer) {
            // CONFLICT: Both modified since last sync
            // Wallacast wins - skip content update, only update metadata
            console.log('[Wallabag Sync] Conflict detected for item', row.id, '- local changes take precedence');

            // Keep the dirty flag on: local content won this conflict, so the following
            // push phase must re-assert it to Wallabag (the "Wallacast wins" rule). If we
            // did not, updating wallabag_updated_at here would mask the local edit and the
            // push would never re-send it.
            await query(
              `UPDATE content_items SET
                is_starred = $1,
                is_archived = $2,
                tags = $3,
                wallabag_synced_tags = $4,
                wallabag_synced_starred = $5,
                wallabag_synced_archived = $6,
                wallabag_updated_at = $7,
                wallabag_needs_push = TRUE
              WHERE id = $8`,
              [
                starToStore,
                archivedToStore,
                tagsToStore,
                syncedTags,
                remoteStarred,
                remoteArchived,
                entry.updated_at,
                row.id,
              ]
            );
          } else if (wallabagIsNewer && localOwnsBody) {
            // Wallabag changed something (star, archive, tags, or a re-parse), but the body
            // is ours. Take the metadata only; the body, title, and picture stay.
            console.log('[Wallabag Sync] Updating metadata only for item', row.id, '(body owned by Wallacast)');
            await query(
              `UPDATE content_items SET
                is_starred = $1,
                is_archived = $2,
                tags = $3,
                wallabag_synced_tags = $4,
                wallabag_synced_starred = $5,
                wallabag_synced_archived = $6,
                wallabag_updated_at = $7,
                wallabag_needs_push = wallabag_needs_push OR $8
              WHERE id = $9`,
              [
                starToStore,
                archivedToStore,
                tagsToStore,
                syncedTags,
                remoteStarred,
                remoteArchived,
                entry.updated_at,
                flagsNeedPush,
                row.id,
              ]
            );
          } else if (wallabagIsNewer) {
            // Wallabag is newer and the body came from Wallabag, safe to refresh it
            console.log('[Wallabag Sync] Updating existing item:', row.id);

            if (type === 'podcast_episode') {
              await query(
                `UPDATE content_items SET
                  title = $1,
                  transcript = $2,
                  is_starred = $3,
                  is_archived = $4,
                  tags = $5,
                  wallabag_synced_tags = $6,
                  wallabag_synced_starred = $7,
                  wallabag_synced_archived = $8,
                  preview_picture = $9,
                  wallabag_updated_at = $10,
                  wallabag_needs_push = wallabag_needs_push OR $11,
                  updated_at = NOW()
                WHERE id = $12`,
                [
                  entry.title,
                  entry.content,  // Wallabag content → transcript for podcasts
                  starToStore,
                  archivedToStore,
                  tagsToStore,
                  syncedTags,
                  remoteStarred,
                  remoteArchived,
                  entry.preview_picture,
                  entry.updated_at,
                  flagsNeedPush,
                  row.id,
                ]
              );
            } else {
              // Articles and texts. Snapshot the CURRENT body first (like edit/refetch/restore
              // do) so a bad Wallabag re-parse is recoverable from the History tab. Best-effort:
              // a snapshot failure must never block the sync overwrite.
              const before = await query(
                'SELECT title, author, published_at, html_content, content, comments FROM content_items WHERE id = $1 AND user_id = $2',
                [row.id, userId]
              );
              if (before.rows.length > 0) {
                await snapshotContentVersion(row.id, userId, before.rows[0], 'sync').catch((err) =>
                  console.error('[Wallabag Sync] Failed to snapshot version before overwrite:', err)
                );
              }
              await query(
                `UPDATE content_items SET
                  title = $1,
                  content = $2,
                  html_content = $3,
                  is_starred = $4,
                  is_archived = $5,
                  tags = $6,
                  wallabag_synced_tags = $7,
                  wallabag_synced_starred = $8,
                  wallabag_synced_archived = $9,
                  preview_picture = $10,
                  wallabag_updated_at = $11,
                  wallabag_needs_push = wallabag_needs_push OR $12,
                  updated_at = NOW()
                WHERE id = $13`,
                [
                  entry.title,
                  entry.content,
                  entry.content,  // Store in both fields
                  starToStore,
                  archivedToStore,
                  tagsToStore,
                  syncedTags,
                  remoteStarred,
                  remoteArchived,
                  entry.preview_picture,
                  entry.updated_at,
                  flagsNeedPush,
                  row.id,
                ]
              );
            }
          } else {
            // Local is current, no update needed. Counted and logged once after the loop
            // (see upToDateCount) instead of one line per item, to avoid log spam. Skip
            // the change counter below: the sync result reports only REAL changes, so the
            // UI message cannot claim "N pulled" when nothing was actually modified.
            // (Tag-only changes never bump Wallabag's updated_at, so they land here; the
            // reconciliation pass after this loop catches them.)
            upToDateCount++;
            continue;
          }
        } else {
          // INSERT new item
          console.log('[Wallabag Sync] Creating new item for entry:', entry.id);

          if (type === 'podcast_episode') {
            await query(
              `INSERT INTO content_items
                (type, title, url, transcript, is_starred, is_archived, tags, wallabag_synced_tags,
                 wallabag_synced_starred, wallabag_synced_archived,
                 preview_picture, wallabag_id, wallabag_updated_at, content_source, user_id,
                 author, published_at)
              VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
              [
                type,
                entry.title,
                entry.url,
                entry.content,  // Wallabag content = transcript
                entry.is_starred === 1,
                entry.is_archived === 1,
                remoteTags,
                remoteTags,
                entry.is_starred === 1,
                entry.is_archived === 1,
                entry.preview_picture,
                entry.id,
                entry.updated_at,
                'wallabag',  // Content from Wallabag
                userId,
                entry.published_by?.[0] || null,
                entry.published_at,
              ]
            );
          } else {
            // Articles and texts
            const insertResult = await query(
              `INSERT INTO content_items
                (type, title, url, content, html_content, is_starred, is_archived, tags, wallabag_synced_tags,
                 wallabag_synced_starred, wallabag_synced_archived,
                 preview_picture, wallabag_id, wallabag_updated_at, content_source, user_id,
                 author, published_at)
              VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
              RETURNING id`,
              [
                type,
                entry.title,
                entry.url,
                entry.content,
                entry.content,
                entry.is_starred === 1,
                entry.is_archived === 1,
                remoteTags,
                remoteTags,
                entry.is_starred === 1,
                entry.is_archived === 1,
                entry.preview_picture,
                entry.id,
                entry.updated_at,
                'wallabag',  // Content from Wallabag
                userId,
                entry.published_by?.[0] || null,
                entry.published_at,
              ]
            );

            // Auto-refetch EA Forum and LessWrong articles from the web.
            // Wallabag can't handle SPAs well: it misses comments, author, date,
            // and proper formatting. Wallacast's article-fetcher does much better.
            const entryUrl = entry.url || '';
            const isEAForum = isEAForumUrl(entryUrl);
            const isLessWrong = entryUrl.includes('lesswrong.com');
            if ((isEAForum || isLessWrong) && insertResult.rows[0]?.id) {
              const newId = insertResult.rows[0].id;
              const siteName = isEAForum ? 'EA Forum' : 'LessWrong';
              console.log(`[Wallabag Sync] Auto-refetching ${siteName} article ${newId} from web...`);

              // Fire-and-forget: don't block the sync loop
              (async () => {
                try {
                  const articleData = await fetchArticleContent(entryUrl);
                  const commentsJson = articleData.comments && articleData.comments.length > 0
                    ? JSON.stringify(articleData.comments)
                    : null;

                  await query(
                    `UPDATE content_items SET
                      html_content = $1,
                      content = $2,
                      author = COALESCE($3, author),
                      published_at = COALESCE($4, published_at),
                      karma = $5,
                      agree_votes = $6,
                      disagree_votes = $7,
                      comments = $8,
                      comment_source = $9,
                      comment_count_total = $10,
                      content_source = 'wallacast',
                      updated_at = NOW()
                    WHERE id = $11`,
                    [
                      articleData.cleaned_html,
                      articleData.content,
                      articleData.author || articleData.byline,
                      articleData.published_date,
                      articleData.karma,
                      articleData.agree_votes,
                      articleData.disagree_votes,
                      commentsJson,
                      articleData.comment_source || null,
                      articleData.comment_count_total || 0,
                      newId
                    ]
                  );
                  console.log(`[Wallabag Sync] ✅ Auto-refetch complete for ${siteName} article ${newId}`);
                } catch (refetchError) {
                  console.error(`[Wallabag Sync] Auto-refetch failed for ${siteName} article ${newId}:`, refetchError);
                  // Not critical. Wallabag content is still available as fallback.
                }
              })();
            }
          }
        }

        count++;
      } catch (error) {
        const errorMsg = `Entry ${entry.id} (${entry.title}): ${error}`;
        console.error('[Wallabag Sync]', errorMsg);
        errors.push(errorMsg);
      }
    }

    if (upToDateCount > 0) {
      console.log(`[Wallabag Sync] ${upToDateCount} items already up to date`);
    }

    // Only advance the last-sync cursor when the pull retrieved every page. If a page
    // fetch failed, advancing would permanently skip the entries we never pulled, so we
    // leave the cursor where it is and re-pull the same window on the next sync.
    if (complete) {
      await setUserSetting(userId, 'wallabag_last_sync', new Date().toISOString());
    } else {
      console.warn('[Wallabag Sync] pull incomplete (page fetch failed), last_sync NOT advanced, will re-pull next sync');
    }

    // Tag reconciliation. Wallabag never bumps an entry's updated_at for tag-only changes
    // (verified in 2.6.13: updatedAt is a Doctrine PreUpdate callback, which does not fire
    // for ManyToMany collection changes, and no tag code calls setUpdatedAt). So a tag added
    // or removed in Wallabag's UI is invisible to the `since` pull above AND to a full
    // refresh (that path also skips entries whose updated_at did not move). This pass
    // compares tag sets over the whole library using detail=metadata (no content, cheap).
    try {
      const reconciled = await reconcileTagsFromWallabag(userId, wallabag);
      count += reconciled.changed;
      errors.push(...reconciled.errors);
    } catch (error) {
      console.error('[Wallabag Sync] Tag reconciliation failed:', error);
      errors.push(`Tag reconciliation failed: ${error}`);
    }

    console.log('[Wallabag Sync] Pull complete:', count, 'items synced,', errors.length, 'errors');

    return { count, errors };
  } catch (error) {
    console.error('[Wallabag Sync] Pull failed:', error);
    errors.push(`Sync failed: ${error}`);
    return { count, errors };
  }
}

/**
 * Compare every known entry's tag set with Wallabag's and merge the differences.
 *
 * Per item: three-way merge (last synced set vs local vs Wallabag), so a tag added or
 * removed in Wallabag lands locally, a local edit is kept for the push, and nothing is
 * wiped by a response that did not carry tags (entries without a type tag are skipped).
 * nosync added in Wallabag is honored here too (it is a tag-only change, so this is the
 * only place that can see it): the local item is MARKED, never deleted. Entries missing
 * from Wallabag are left alone (deletions do not propagate). updated_at is deliberately
 * NOT bumped: doing so would manufacture a "conflict" on the next pull for an item nobody
 * touched locally.
 */
async function reconcileTagsFromWallabag(
  userId: number,
  wallabag: WallabagService
): Promise<{ changed: number; errors: string[] }> {
  const errors: string[] = [];
  let changed = 0;

  // The local side is small (ids + tag arrays), so it is loaded once and looked up by
  // wallabag_id. The Wallabag side is streamed page by page: only one page of entries is
  // in memory at a time, so the pass costs the same for a library of 500 or 50,000.
  const local = await query(
    'SELECT id, wallabag_id, tags, wallabag_synced_tags, wallabag_needs_push FROM content_items WHERE user_id = $1 AND wallabag_id IS NOT NULL',
    [userId]
  );
  if (local.rows.length === 0) return { changed, errors };
  const localByWallabagId = new Map<number, any>();
  for (const row of local.rows) localByWallabagId.set(row.wallabag_id, row);

  let checked = 0;
  let skippedNoTypeTag = 0;
  let localEditsKept = 0;
  let complete = true;
  for await (const page of wallabag.iterateEntryPages(undefined, { detail: 'metadata', perPage: 100 })) {
    if (page === null) {
      complete = false;
      break;
    }
    if (page.length > 0 && page.every(e => !Array.isArray(e.tags))) {
      // The response did not serialize a `tags` field at all. Bail out loudly rather than
      // treat that as "all tags removed". (A page whose entries merely have EMPTY tag lists
      // is normal: older entries saved in Wallabag before Wallacast existed carry no type
      // tag, and those are skipped one by one below.)
      console.warn(`[Wallabag Sync] tag reconciliation stopped: the metadata response carries no tags field (${page.length} entries on this page)`);
      complete = false;
      break;
    }
    for (const entry of page) {
      checked++;
      const row = localByWallabagId.get(entry.id);
      if (!row) continue;
      try {
        if (shouldSkip(entry)) {
          changed += await markLocalItemsNosync(userId, entry);
          continue;
        }
        if (!hasTypeTag(entry)) {
          skippedNoTypeTag++;
          continue;
        }
        const remoteTags = userTagsOf(entry);
        const localTags: string[] = row.tags || [];
        const base: string[] | null = row.wallabag_synced_tags;
        const merged = mergeTagSets(base, localTags, remoteTags);
        const baseCurrent = base !== null && sameTagSet(base, remoteTags);
        if (sameTagSet(merged, localTags) && baseCurrent) continue;
        if (!sameTagSet(merged, remoteTags)) localEditsKept++;
        // Store the merge and record Wallabag's set as the new base. If the merge still
        // differs from Wallabag's set, the item is dirty (a local tag edit set the flag)
        // and the push sends the merged list right after this pull.
        await query(
          'UPDATE content_items SET tags = $1, wallabag_synced_tags = $2 WHERE id = $3 AND user_id = $4',
          [merged, remoteTags, row.id, userId]
        );
        if (!sameTagSet(merged, localTags)) {
          console.log(`[Wallabag Sync] tags reconciled for item ${row.id}: [${localTags.join(', ')}] -> [${merged.join(', ')}] (Wallabag has [${remoteTags.join(', ')}])`);
          changed++;
        }
      } catch (error) {
        const msg = `Tag reconciliation for item ${row.id}: ${error}`;
        console.error('[Wallabag Sync]', msg);
        errors.push(msg);
      }
    }
  }

  console.log(`[Wallabag Sync] Tag reconciliation${complete ? '' : ' (incomplete)'}: ${checked} entries checked, ${changed} changed, ${localEditsKept} local edits kept for push, ${skippedNoTypeTag} skipped (no type tag)`);
  return { changed, errors };
}

/**
 * Push changes from Wallacast to Wallabag
 */
export async function syncToWallabag(userId: number): Promise<SyncResult> {
  console.log('[Wallabag Sync] Starting push for user:', userId);

  const wallabag = new WallabagService(userId);
  const errors: string[] = [];
  let count = 0;

  // Check if enabled
  if (!(await wallabag.isEnabled())) {
    console.log('[Wallabag Sync] Push not enabled');
    return { count: 0, errors: ['Wallabag sync not enabled'] };
  }

  try {
    // Find items needing push:
    // 1. wallabag_id IS NULL (never synced)
    // 2. wallabag_needs_push = TRUE (an explicit dirty flag, set on every local change)
    // We use the dirty flag instead of comparing updated_at > wallabag_updated_at, because
    // those two columns are on different clocks (wallabag_updated_at stores a foreign
    // wall-clock time), so the comparison was unreliable.
    // Explicit column list (never SELECT *): this can match MANY items at once, and
    // SELECT * would load every matched item's audio_data blob (10-50MB each) into
    // memory just to push text to Wallabag. Only the fields the loop below reads.
    const itemsResult = await query(
      `SELECT id, type, title, url, tags, wallabag_id,
              transcript, content, html_content,
              is_archived, is_starred, published_at
         FROM content_items
       WHERE user_id = $1
       AND (
         wallabag_id IS NULL
         OR wallabag_needs_push = TRUE
       )`,
      [userId]
    );

    console.log('[Wallabag Sync] Found', itemsResult.rows.length, 'items to push');

    for (const item of itemsResult.rows) {
      try {
        // Honor the nosync tag on push. Pushing a nosync-tagged item would make the very
        // next pull treat it as a nosync entry, so we must never push it. Skip entirely
        // and leave it dirty so it is re-evaluated (and skipped again) on the next sync
        // rather than silently marked pushed.
        if (hasNosyncTag(item.tags)) {
          console.log(`[Wallabag Sync] skip id=${item.id} reason=nosync tag (never pushed)`);
          continue;
        }

        // Full tag string for Wallabag: type tag first, then the user's tags. Wallabag's
        // PATCH replaces the whole set, so this is always the complete list.
        const userTags = normalizeTagList(item.tags);
        const finalTags = wallabagTagString(item.type, userTags);

        // Determine URL
        let url = item.url;
        if (!url) {
          // Generate a synthetic URL for items without one, then store it BEFORE the push.
          // A create whose answer never arrives (network drop after Wallabag accepted it)
          // used to leave the URL unsaved, so the next sync minted a FRESH uuid and created
          // a second entry for the same item. A stable URL makes the retry point at the same
          // address. `updated_at` is deliberately not touched: this is bookkeeping, not a
          // user edit, and bumping it would fake a conflict on the next pull.
          const uuid = crypto.randomUUID();
          if (item.type === 'text') {
            url = `wallacast://text/${uuid}`;
          } else if (item.type === 'podcast_episode') {
            url = `wallacast://podcast/${uuid}`;
          } else {
            url = `wallacast://content/${uuid}`;
          }
          await query('UPDATE content_items SET url = $1 WHERE id = $2 AND url IS NULL', [url, item.id]);
        }

        // Determine content to send
        // Podcasts: send transcript
        // Articles/texts: send html_content or content
        let contentToSync: string;
        if (item.type === 'podcast_episode') {
          contentToSync = item.transcript || item.content || '';
        } else {
          contentToSync = item.html_content || item.content || '';
        }

        // Podcasts have no useful text until they are transcribed. Pushing an empty-content
        // podcast makes Wallabag crawl the raw audio URL and store a "can't retrieve contents"
        // placeholder. Skip it, leave wallabag_id NULL and the dirty flag untouched, so it
        // retries automatically once the transcript exists.
        if (item.type === 'podcast_episode' && !contentToSync.trim()) {
          console.log(`[Wallabag Sync] skip id=${item.id} reason=no transcript yet (will push once transcribed)`);
          continue;
        }

        if (item.wallabag_id) {
          // UPDATE existing Wallabag entry
          console.log('[Wallabag Sync] Updating Wallabag entry:', item.wallabag_id);
          const result = await wallabag.updateEntry(item.wallabag_id, {
            title: item.title,
            content: contentToSync,
            tags: finalTags,
            archive: item.is_archived,
            starred: item.is_starred,
          });

          if (result) {
            // Update local wallabag_updated_at to match, record the pushed tag set as the
            // new merge base, and clear the dirty flag now that this item has been
            // successfully pushed. wallabag_updated_at is still written because the pull
            // phase reads it.
            await query(
              `UPDATE content_items
                  SET wallabag_updated_at = $1, wallabag_synced_tags = $2,
                      wallabag_synced_starred = $3, wallabag_synced_archived = $4,
                      wallabag_needs_push = FALSE
                WHERE id = $5`,
              [result.updated_at, userTags, item.is_starred, item.is_archived, item.id]
            );
            count++;
          } else {
            // The update failed. Before re-creating anything, find out WHY. Only a definite
            // 404 means the entry was deleted in Wallabag. An unreachable server answers
            // "unknown", and re-creating on unknown is how a short outage turns into a
            // duplicate entry for every item in the push.
            const exists = await wallabag.entryExists(item.wallabag_id);

            if (exists === null) {
              const msg = `Item ${item.id}: update failed and Wallabag could not confirm whether entry ${item.wallabag_id} still exists. Left unchanged, the next sync retries it.`;
              console.warn('[Wallabag Sync]', msg);
              errors.push(msg);
            } else if (exists === false) {
              // Re-create it
              console.log('[Wallabag Sync] Entry deleted in Wallabag, re-creating:', item.wallabag_id);
              const newEntry = await wallabag.createEntry({
                url,
                title: item.title,
                content: contentToSync,
                tags: finalTags,
                archive: item.is_archived,
                starred: item.is_starred,
              });

              if (newEntry) {
                await query(
                  `UPDATE content_items
                      SET wallabag_id = $1, wallabag_updated_at = $2, url = $3, wallabag_synced_tags = $4,
                          wallabag_synced_starred = $5, wallabag_synced_archived = $6,
                          wallabag_needs_push = FALSE
                    WHERE id = $7`,
                  [newEntry.id, newEntry.updated_at, url, userTags, item.is_starred, item.is_archived, item.id]
                );
                count++;
              } else {
                errors.push(`Failed to recreate item ${item.id} in Wallabag`);
              }
            } else {
              errors.push(`Failed to update item ${item.id} (Wallabag ID: ${item.wallabag_id})`);
            }
          }
        } else {
          // CREATE new Wallabag entry
          console.log('[Wallabag Sync] Creating new Wallabag entry for item:', item.id);
          const result = await wallabag.createEntry({
            url,
            title: item.title,
            content: contentToSync,
            tags: finalTags,
            archive: item.is_archived,
            starred: item.is_starred,
            published_at: item.published_at,
          });

          if (result) {
            // Store Wallabag ID and update URL if we generated a synthetic one, record the
            // pushed tag set as the merge base, and clear the dirty flag now that this item
            // has been successfully pushed.
            await query(
              `UPDATE content_items
                  SET wallabag_id = $1, wallabag_updated_at = $2, url = COALESCE(url, $3), wallabag_synced_tags = $4,
                      wallabag_synced_starred = $5, wallabag_synced_archived = $6,
                      wallabag_needs_push = FALSE
                WHERE id = $7`,
              [result.id, result.updated_at, url, userTags, item.is_starred, item.is_archived, item.id]
            );
            count++;
          } else {
            errors.push(`Failed to create item ${item.id} in Wallabag`);
          }
        }
      } catch (error) {
        errors.push(`Item ${item.id} (${item.title}): ${error}`);
        console.error('[Wallabag Sync] Error pushing item:', item.id, error);
      }
    }

    console.log('[Wallabag Sync] Push complete:', count, 'items synced,', errors.length, 'errors');
    return { count, errors };
  } catch (error) {
    console.error('[Wallabag Sync] Push failed:', error);
    errors.push(`Push sync failed: ${error}`);
    return { count, errors };
  }
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

// Remove a tag LABEL from Wallabag entirely (every entry loses it and the tag list drops
// it). Fire-and-forget companion of the library-wide tag rename/delete: the per-entry
// pushes re-assert each entry's new tag set, this cleans up the old label itself.
export async function deleteTagLabelFromWallabag(userId: number, label: string): Promise<boolean> {
  const wallabag = new WallabagService(userId);
  if (!(await wallabag.isEnabled())) {
    return false;
  }
  return wallabag.deleteTagLabel(label);
}
