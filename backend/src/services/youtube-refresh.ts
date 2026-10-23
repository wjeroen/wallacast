import { query } from '../database/db.js';
import { youtubeVideoId } from '../shared/format.js';
import type { Comment } from '../shared/types.js';
import {
  fetchYouTubeComments, fetchYouTubeMetadata, youtubeApiKey, YouTubeUnavailableError, type YouTubeMetadata,
} from './youtube.js';

// Keeps a video's stored YouTube details current. YouTube's developer policies (III.E.4)
// allow keeping data from its API "for no more than 30 calendar days", after which it must
// be refreshed or deleted, and ask for "reasonable efforts" to keep it consistent with
// YouTube (view counts, edited titles). So every hour this job reads again the details of
// each video last read more than 7 days ago (content_fetched_at): with the user's YouTube
// key, the details and comments (two quota units per video); without a key, nothing can be
// read, and the details only the API gives (views, comment count, embed status, comments)
// are deleted. A video YouTube no longer has keeps its title, channel, date and length, and
// loses its description, comments and counts.

const REFRESH_AFTER_DAYS = 7;
// At most this many videos per user per run, so one run stays short. With 100 an hour, a
// library of any size is refreshed within a day of the deploy.
const VIDEOS_PER_RUN = 100;
const STALE = `type = 'video' AND (content_fetched_at IS NULL OR content_fetched_at < NOW() - make_interval(days => ${REFRESH_AFTER_DAYS}))`;

// 'set' stores YouTube's new values, 'keep' leaves the stored ones, 'clear' deletes them
type Change = 'set' | 'keep' | 'clear';

// Title, channel, description, date, length and picture keep their stored value where
// YouTube gives none (oEmbed has no description). updated_at and the Wallabag push only
// follow a change to what Wallabag shows (title, channel, description), so a weekly refresh
// with new view counts does not make every video look edited.
export async function saveVideoDetails(
  itemId: number, video: YouTubeMetadata, apiDetails: Change, comments: Comment[] | null, commentsChange: Change,
): Promise<void> {
  const changed = `(COALESCE($1, title) IS DISTINCT FROM title
    OR COALESCE($2, author) IS DISTINCT FROM author
    OR COALESCE($3, description) IS DISTINCT FROM description)`;
  await query(
    `UPDATE content_items SET
       updated_at = CASE WHEN ${changed} THEN NOW() ELSE updated_at END,
       wallabag_needs_push = wallabag_needs_push OR ${changed},
       title = COALESCE($1, title),
       author = COALESCE($2, author),
       description = COALESCE($3, description),
       published_at = COALESCE($4, published_at),
       duration = COALESCE($5, duration),
       preview_picture = COALESCE($6, preview_picture),
       view_count = CASE $7::text WHEN 'set' THEN $8::bigint WHEN 'clear' THEN NULL ELSE view_count END,
       comment_count_total = CASE $7::text WHEN 'set' THEN $9::int WHEN 'clear' THEN 0 ELSE comment_count_total END,
       embed_blocked = CASE $7::text WHEN 'set' THEN $10::text WHEN 'clear' THEN NULL ELSE embed_blocked END,
       comments = CASE $11::text WHEN 'set' THEN $12::jsonb WHEN 'clear' THEN NULL ELSE comments END,
       comment_source = CASE $11::text
         WHEN 'set' THEN CASE WHEN $12::jsonb IS NULL THEN NULL ELSE 'youtube' END
         WHEN 'clear' THEN NULL ELSE comment_source END,
       content_fetched_at = NOW()
     WHERE id = $13`,
    [
      video.title, video.author, video.description, video.published_at, video.duration, video.preview_picture,
      apiDetails, video.view_count, video.comment_count ?? 0, video.embed_blocked,
      commentsChange, comments && comments.length > 0 ? JSON.stringify(comments) : null,
      itemId,
    ]
  );
}

// Reads the video's details again and stores them: Refetch, and the refresh job. With a key
// a failing Data API throws (the day's quota used up, a wrong key) instead of storing less,
// and YouTubeUnavailableError means YouTube has no such video any more. Comments that fail
// for any other reason than the quota are deleted, since they could not be refreshed.
export async function refreshVideoDetails(itemId: number, videoId: string, key: string | null): Promise<void> {
  const video = await fetchYouTubeMetadata(videoId, key, false);
  if (!key) {
    await saveVideoDetails(itemId, video, 'clear', null, 'clear');
    return;
  }
  let comments: Comment[] | null = null;
  let commentsChange: Change = 'set';
  try {
    comments = await fetchYouTubeComments(videoId, key);
  } catch (err) {
    if (/quota/i.test((err as Error).message)) throw err;
    console.warn(`[YouTube] ${videoId}: comments failed, deleting the stored ones: ${(err as Error).message}`);
    commentsChange = 'clear';
  }
  await saveVideoDetails(itemId, video, 'set', comments, commentsChange);
}

// YouTube no longer has the video (removed, or made private)
async function forgetGoneVideo(itemId: number): Promise<void> {
  await query(
    `UPDATE content_items SET
       updated_at = CASE WHEN description IS NOT NULL THEN NOW() ELSE updated_at END,
       wallabag_needs_push = wallabag_needs_push OR description IS NOT NULL,
       description = NULL,
       view_count = NULL,
       comment_count_total = 0,
       embed_blocked = NULL,
       comments = CASE WHEN comment_source = 'youtube' THEN NULL ELSE comments END,
       comment_source = CASE WHEN comment_source = 'youtube' THEN NULL ELSE comment_source END,
       content_fetched_at = NOW()
     WHERE id = $1`,
    [itemId]
  );
}

async function refreshUserVideos(userId: number): Promise<void> {
  const key = await youtubeApiKey(userId);
  if (!key) {
    // Nothing to read without a key. What only the Data API gives is deleted, which changes
    // nothing for videos that never had it.
    const cleared = await query(
      `UPDATE content_items SET
         view_count = NULL,
         comment_count_total = 0,
         embed_blocked = NULL,
         comments = CASE WHEN comment_source = 'youtube' THEN NULL ELSE comments END,
         comment_source = CASE WHEN comment_source = 'youtube' THEN NULL ELSE comment_source END,
         content_fetched_at = NOW()
       WHERE user_id = $1 AND ${STALE}`,
      [userId]
    );
    console.log(`[YouTubeRefresh] user ${userId}: no YouTube key, ${cleared.rowCount ?? 0} video(s) marked checked`);
    return;
  }
  const items = await query(
    `SELECT id, url FROM content_items WHERE user_id = $1 AND ${STALE}
      ORDER BY content_fetched_at ASC NULLS FIRST LIMIT $2`,
    [userId, VIDEOS_PER_RUN]
  );
  let refreshed = 0;
  let gone = 0;
  for (const item of items.rows) {
    const videoId = youtubeVideoId(item.url);
    if (!videoId) continue;
    try {
      await refreshVideoDetails(item.id, videoId, key);
      refreshed++;
    } catch (err) {
      if (err instanceof YouTubeUnavailableError) {
        await forgetGoneVideo(item.id);
        gone++;
        continue;
      }
      // The key or the day's quota: the next run tries again
      console.warn(`[YouTubeRefresh] user ${userId}: stopped at item ${item.id}: ${(err as Error).message}`);
      break;
    }
  }
  console.log(`[YouTubeRefresh] user ${userId}: ${refreshed} refreshed, ${gone} no longer on YouTube, ${items.rows.length - refreshed - gone} left for the next run`);
}

let running = false;

export async function refreshStaleVideos(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const users = await query(`SELECT DISTINCT user_id FROM content_items WHERE ${STALE}`);
    for (const row of users.rows) {
      await refreshUserVideos(row.user_id).catch((err) => {
        console.error(`[YouTubeRefresh] user ${row.user_id} failed:`, err);
      });
    }
  } catch (err) {
    console.error('[YouTubeRefresh] run failed:', err);
  } finally {
    running = false;
  }
}

// Every hour, the first run 5 minutes after the server starts. Runs that find nothing stale
// cost one small query. unref() lets the process exit without waiting.
export function startYouTubeRefresh(): void {
  setTimeout(() => void refreshStaleVideos(), 5 * 60 * 1000).unref();
  setInterval(() => void refreshStaleVideos(), 60 * 60 * 1000).unref();
}
