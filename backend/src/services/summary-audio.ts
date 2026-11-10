import fs from 'fs/promises';
import path from 'path';
import { query } from '../database/db.js';
import { getTempDir } from '../config/storage.js';
import { getAudioDuration } from './audio-utils.js';
import { saveAudioFile, deleteAudioFile } from './audio-storage.js';
import { generateArticleAudio, buildNarrationIntro, TTSError } from './openai-tts.js';

// TTS audio of the item's stored summary text, a second independent audio per item.
// Deliberately minimal compared to the main pipeline: the summary is already plain
// spoken-friendly text, so there is no scriptwriter LLM pass, and the summary tab
// has no read-along, so there is no Whisper transcription and no LLM alignment.
// The file lives on the volume as `<id>-summary.mp3` (audio-storage accepts string
// keys, and integer item ids can never collide with the suffixed name) and is served
// by GET /api/content/:id/audio?variant=summary in index.ts.

// In-process guard against double generation (same pattern as activeGenerations in openai-tts.ts)
const activeSummaryAudioGenerations = new Set<number>();

// At most this many summary audios talk to the TTS provider at once, later ones wait in line
// (still 'generating' on their card). A batch of adds otherwise hits the provider all at once:
// 21 parallel Kokoro requests on 2026-11-10 all failed while DeepInfra was slow. Batches of 11
// worked on healthy days. Full audio has its own line in openai-tts.ts.
const SUMMARY_AUDIO_SLOTS = 5;
let summaryAudioRunning = 0;
const summaryAudioWaiting: Array<() => void> = [];

function takeSummaryAudioSlot(): Promise<void> {
  if (summaryAudioRunning < SUMMARY_AUDIO_SLOTS) {
    summaryAudioRunning++;
    return Promise.resolve();
  }
  return new Promise(resolve => summaryAudioWaiting.push(() => { summaryAudioRunning++; resolve(); }));
}

function freeSummaryAudioSlot(): void {
  summaryAudioRunning--;
  summaryAudioWaiting.shift()?.();
}

// A busy provider can hold each try for 5 minutes, so two tries free the slot sooner, and
// the automatic retry below comes back when the provider has had time to recover.
const SUMMARY_AUDIO_ATTEMPTS = 2;

// A failure because the provider was too busy gets one automatic retry this much later, if
// the card still shows the failure. Kept in memory only: a restart drops it.
const BUSY_RETRY_DELAY_MS = 15 * 60 * 1000;
const pendingBusyRetries = new Set<number>();

function scheduleBusyRetry(contentId: number): void {
  if (pendingBusyRetries.has(contentId)) return;
  pendingBusyRetries.add(contentId);
  console.log(`[SummaryAudio] Provider busy for content ${contentId}, one automatic retry in ${BUSY_RETRY_DELAY_MS / 60000} minutes`);
  setTimeout(async () => {
    pendingBusyRetries.delete(contentId);
    try {
      const result = await query('SELECT summary_audio_status FROM content_items WHERE id = $1', [contentId]);
      // Retried by hand, dismissed, or deleted in the meantime
      if (result.rows[0]?.summary_audio_status !== 'failed') return;
      console.log(`[SummaryAudio] Automatic retry for content ${contentId}`);
      await generateSummaryAudioForContent(contentId, true);
    } catch {
      // generateSummaryAudioForContent already logged and stored the failure
    }
  }, BUSY_RETRY_DELAY_MS).unref();
}

export function summaryAudioKey(contentId: number | string): string {
  return `${contentId}-summary`;
}

// Delete the stored summary-audio file and reset its columns. Called when the summary
// text is removed or regenerated, since the audio would keep narrating the stale text.
export async function clearSummaryAudio(contentId: number): Promise<void> {
  await deleteAudioFile(summaryAudioKey(contentId));
  await query(
    `UPDATE content_items
     SET summary_audio_url = NULL, summary_audio_duration = NULL, summary_audio_status = 'idle',
         summary_audio_error = NULL, summary_audio_generated_at = NULL, summary_playback_position = 0
     WHERE id = $1`,
    [contentId]
  );
}

export async function generateSummaryAudioForContent(contentId: number, isAutoRetry = false): Promise<void> {
  if (activeSummaryAudioGenerations.has(contentId)) {
    console.log(`[SummaryAudio] Generation already running for content ${contentId}`);
    return;
  }
  activeSummaryAudioGenerations.add(contentId);
  let holdsSlot = false;
  try {
    await query(
      `UPDATE content_items SET summary_audio_status = 'generating', summary_audio_error = NULL WHERE id = $1`,
      [contentId]
    );
    if (summaryAudioRunning >= SUMMARY_AUDIO_SLOTS) {
      console.log(`[SummaryAudio] ${summaryAudioRunning} running, content ${contentId} waits in line`);
    }
    await takeSummaryAudioSlot();
    holdsSlot = true;

    // The metadata columns feed the spoken header. Read fresh on every run, after the wait
    // in line, so regenerating after a title or author edit narrates the corrected version.
    const result = await query(
      `SELECT user_id, type, title, author, published_at, karma, url, podcast_show_name,
              summary, comment_summary, comment_count_total
         FROM content_items WHERE id = $1`,
      [contentId]
    );
    if (result.rows.length === 0) {
      throw new Error('Content not found');
    }
    const item = result.rows[0];
    const { user_id: userId, summary, comment_summary: commentSummary } = item;
    if (!summary || !summary.trim()) {
      throw new Error('No summary to generate audio from');
    }

    // Same spoken header the full audio uses, with "Summary of" in place of the
    // "Title:" announcement. Untitled items get no header at all.
    const parts: string[] = [];
    const intro = buildNarrationIntro(item, 'summary').trim();
    if (intro) parts.push(intro);
    parts.push(summary.trim());

    // Comment summary rides along with a short spoken divider, mirroring the
    // "Comments" label the summary tab shows between the two summaries. The count
    // is comment_count_total, the same number the full audio announces at its own
    // comments divider (both include nested replies).
    if (commentSummary && commentSummary.trim()) {
      const commentCount = Number(item.comment_count_total) || 0;
      parts.push(
        commentCount > 0
          ? `Summary of ${commentCount} ${commentCount === 1 ? 'comment' : 'comments'}.`
          : 'Summary of the comments.'
      );
      parts.push(commentSummary.trim());
    }
    const narrationText = parts.join('\n\n');

    console.log(`[SummaryAudio] Generating for content ${contentId} (${narrationText.length} chars)`);
    // No options.contentId: generateArticleAudio must not touch the main audio's
    // generation_status/progress columns while narrating the summary.
    const { buffer } = await generateArticleAudio(narrationText, userId, { maxAttempts: SUMMARY_AUDIO_ATTEMPTS });

    const savedToDisk = await saveAudioFile(summaryAudioKey(contentId), buffer);
    if (!savedToDisk) {
      throw new Error('Failed to write summary audio file to storage');
    }

    const tempFilePath = path.join(getTempDir(), `summary_${contentId}.mp3`);
    let audioDuration = 0;
    try {
      await fs.writeFile(tempFilePath, buffer);
      audioDuration = Math.floor(await getAudioDuration(tempFilePath));
      await fs.unlink(tempFilePath).catch(() => {});
    } catch (e) {
      console.error(e);
    }

    const port = process.env.PORT || '8080';
    const backendUrl = process.env.BACKEND_URL
      || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : null)
      || `http://localhost:${port}`;
    // Stored token-less like audio_url; withAudioToken appends ?t= at serialization.
    const summaryAudioUrl = `${backendUrl}/api/content/${contentId}/audio?variant=summary`;

    await query(
      `UPDATE content_items
       SET summary_audio_url = $1, summary_audio_duration = $2, summary_audio_status = 'completed',
           summary_audio_error = NULL, summary_audio_generated_at = NOW(), summary_playback_position = 0
       WHERE id = $3`,
      [summaryAudioUrl, audioDuration, contentId]
    );
    console.log(`✓ Summary audio stored for content ${contentId} (${(buffer.length / 1048576).toFixed(1)} MB, ${audioDuration}s)`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[SummaryAudio] Generation failed for content ${contentId}:`, message);
    const busy = error instanceof TTSError && error.busy;
    // The raw "terminated" or "429 status code" means nothing on the card
    const cardMessage = busy ? `${(error as TTSError).provider ?? 'The TTS provider'} was too busy. Tap Retry.` : message;
    await query(
      `UPDATE content_items SET summary_audio_status = 'failed', summary_audio_error = $1 WHERE id = $2`,
      [cardMessage, contentId]
    ).catch(() => {});
    if (busy && !isAutoRetry) scheduleBusyRetry(contentId);
    throw error;
  } finally {
    if (holdsSlot) freeSummaryAudioSlot();
    activeSummaryAudioGenerations.delete(contentId);
  }
}
