import { query } from '../database/db.js';
import { deleteAudioFile } from './audio-storage.js';
import { evictCachedPodcastAudio, cachedPodcastIds } from './podcast-cache.js';
import { summaryAudioKey } from './summary-audio.js';

/**
 * Archiving, and the delayed removal of archived audio.
 *
 * Archiving an item only sets is_archived. The trigger from migration 033 stamps archived_at,
 * whatever sets the flag (the app, an API token, the Wallabag sync). The generated audio of a
 * non-starred article or text, with its read-along, transcript and word timestamps, stays for
 * ARCHIVED_AUDIO_GRACE_DAYS: unarchiving within that time (the app, or Undo on a token's change)
 * keeps it. After that, the hourly purgeArchivedAudio() deletes it to free the volume. Starred
 * items keep their audio, starred at the time of the purge, so starring an archived item within
 * the 7 days also saves it. A podcast episode's cached copy (podcast-cache.ts: a host that
 * seeks badly or inserts ads, or a raised copy of a quiet episode) follows the same rule, so an
 * episode archived while it plays goes on from the same bytes. Videos have neither. Summary
 * audio (every type) follows the same rule too, and also goes for an item archived before
 * migration 033 (no archived_at), which held about 0.7 GB of it on 2026-11-23.
 */

export const ARCHIVED_AUDIO_GRACE_DAYS = 7;

/** Archive the user's items with these ids. Returns the ids that were archived. */
export async function archiveItems(userId: number, ids: number[]): Promise<number[]> {
  if (ids.length === 0) return [];
  const r = await query(
    `UPDATE content_items SET is_archived = true, updated_at = NOW(), wallabag_needs_push = TRUE
      WHERE user_id = $1 AND id = ANY($2::int[])
      RETURNING id`,
    [userId, ids]
  );
  return r.rows.map((row: any) => row.id);
}

/** Unarchive the user's items with these ids. Returns the ids that were unarchived. Audio that
 *  was already removed is not made again here (a bulk unarchive starting many paid jobs would
 *  be a surprise); the single-item PATCH does that when auto-generation is on. */
export async function unarchiveItems(userId: number, ids: number[]): Promise<number[]> {
  if (ids.length === 0) return [];
  const r = await query(
    `UPDATE content_items SET is_archived = false, updated_at = NOW(), wallabag_needs_push = TRUE
      WHERE user_id = $1 AND id = ANY($2::int[])
      RETURNING id`,
    [userId, ids]
  );
  return r.rows.map((row: any) => row.id);
}

/** Delete the generated audio of articles and texts archived more than
 *  ARCHIVED_AUDIO_GRACE_DAYS ago that are not starred. Items archived before migration 033
 *  have no archived_at and are left alone. */
export async function purgeArchivedAudio(): Promise<number> {
  const r = await query(
    `UPDATE content_items
        SET audio_data = NULL, audio_url = NULL, duration = NULL, content_alignment = NULL,
            transcript = NULL, transcript_words = NULL, tts_chunks = NULL
      WHERE is_archived = true AND is_starred = false
        AND type IN ('article', 'text')
        AND archived_at IS NOT NULL
        AND archived_at < NOW() - make_interval(days => ${ARCHIVED_AUDIO_GRACE_DAYS})
        AND (audio_url IS NOT NULL OR audio_data IS NOT NULL)
      RETURNING id`
  );
  for (const row of r.rows) await deleteAudioFile(row.id);
  if (r.rows.length > 0) {
    console.log(`🗄️ [Archive] Removed the audio of ${r.rows.length} item(s) archived more than ${ARCHIVED_AUDIO_GRACE_DAYS} days ago: ${r.rows.map((row: any) => row.id).join(', ')}`);
  }
  return r.rows.length;
}

/** Delete the summary audio of items archived more than ARCHIVED_AUDIO_GRACE_DAYS ago, or
 *  before migration 033, that are not starred. "Generate summary audio" makes it again. */
export async function purgeArchivedSummaryAudio(): Promise<number> {
  const r = await query(
    `UPDATE content_items
        SET summary_audio_url = NULL, summary_audio_duration = NULL, summary_audio_status = 'idle',
            summary_audio_error = NULL, summary_audio_generated_at = NULL, summary_playback_position = 0
      WHERE is_archived = true AND is_starred = false
        AND (archived_at IS NULL OR archived_at < NOW() - make_interval(days => ${ARCHIVED_AUDIO_GRACE_DAYS}))
        AND summary_audio_url IS NOT NULL
        AND summary_audio_status IS DISTINCT FROM 'generating'
      RETURNING id`
  );
  for (const row of r.rows) await deleteAudioFile(summaryAudioKey(row.id));
  if (r.rows.length > 0) {
    console.log(`🗄️ [Archive] Removed the summary audio of ${r.rows.length} archived item(s)`);
  }
  return r.rows.length;
}

/** Delete the cached copies of podcast episodes archived more than ARCHIVED_AUDIO_GRACE_DAYS
 *  ago that are not starred. Only the episodes that have a copy are looked up. */
export async function purgeArchivedPodcastCopies(): Promise<number> {
  const ids = await cachedPodcastIds();
  if (ids.length === 0) return 0;
  const r = await query(
    `SELECT id FROM content_items
      WHERE id = ANY($1::int[]) AND is_archived = true AND is_starred = false
        AND archived_at IS NOT NULL
        AND archived_at < NOW() - make_interval(days => ${ARCHIVED_AUDIO_GRACE_DAYS})`,
    [ids]
  );
  for (const row of r.rows) await evictCachedPodcastAudio(row.id);
  return r.rows.length;
}

async function runPurge(): Promise<void> {
  try {
    await purgeArchivedAudio();
    await purgeArchivedSummaryAudio();
    await purgeArchivedPodcastCopies();
  } catch (error) {
    // A database without migration 033 has no archived_at: nothing is removed, nothing breaks
    console.error('🗄️ [Archive] Removing old archived audio failed:', error);
  }
}

/** Run the purge 3 minutes after startup, then every hour. */
export function startArchiveCleanup(): void {
  setTimeout(() => void runPurge(), 3 * 60 * 1000).unref();
  setInterval(() => void runPurge(), 60 * 60 * 1000).unref();
}
