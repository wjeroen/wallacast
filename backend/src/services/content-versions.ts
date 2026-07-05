import { query } from '../database/db.js';

// Keep at most this many version snapshots per item (HTML is tiny, but don't grow forever).
export const MAX_VERSIONS_PER_ITEM = 25;

// What produced a snapshot's overwrite. content_versions.source is a plain VARCHAR(20) with
// no CHECK constraint (migration 020), so 'sync' (a Wallabag re-parse overwrite) is allowed
// alongside the original edit/refetch/restore/fetch sources.
export type ContentVersionSource = 'fetch' | 'refetch' | 'edit' | 'restore' | 'sync';

// Snapshot an item's CURRENT body into content_versions BEFORE it gets overwritten by an
// edit / refetch / restore / sync, so the change can be rolled back. Audio is never versioned.
// Best-effort: a snapshot failure must never block the actual overwrite, so callers swallow errors.
// Shared by routes/content.ts (edit/refetch/restore) and services/wallabag-sync.ts (sync).
export async function snapshotContentVersion(
  contentItemId: number | string,
  userId: number,
  row: { title?: string | null; html_content?: string | null; content?: string | null; comments?: any },
  source: ContentVersionSource
): Promise<void> {
  // Nothing worth keeping if there's no body at all.
  if (!row || (!row.html_content && !row.content)) return;

  const commentsValue =
    row.comments == null
      ? null
      : typeof row.comments === 'string'
        ? row.comments
        : JSON.stringify(row.comments);

  await query(
    `INSERT INTO content_versions (content_item_id, user_id, source, title, html_content, content, comments)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [contentItemId, userId, source, row.title ?? null, row.html_content ?? null, row.content ?? null, commentsValue]
  );

  // Prune anything beyond the most recent MAX_VERSIONS_PER_ITEM.
  await query(
    `DELETE FROM content_versions
     WHERE content_item_id = $1
       AND id NOT IN (
         SELECT id FROM content_versions
         WHERE content_item_id = $1
         ORDER BY created_at DESC
         LIMIT $2
       )`,
    [contentItemId, MAX_VERSIONS_PER_ITEM]
  );
}
