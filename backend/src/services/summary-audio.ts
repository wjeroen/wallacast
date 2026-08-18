import fs from 'fs/promises';
import path from 'path';
import { query } from '../database/db.js';
import { getTempDir } from '../config/storage.js';
import { getAudioDuration } from './audio-utils.js';
import { saveAudioFile, deleteAudioFile } from './audio-storage.js';
import { generateArticleAudio } from './openai-tts.js';

// TTS audio of the item's stored summary text, a second independent audio per item.
// Deliberately minimal compared to the main pipeline: the summary is already plain
// spoken-friendly text, so there is no scriptwriter LLM pass, and the summary tab
// has no read-along, so there is no Whisper transcription and no LLM alignment.
// The file lives on the volume as `<id>-summary.mp3` (audio-storage accepts string
// keys, and integer item ids can never collide with the suffixed name) and is served
// by GET /api/content/:id/audio?variant=summary in index.ts.

// In-process guard against double generation (same pattern as activeGenerations in openai-tts.ts)
const activeSummaryAudioGenerations = new Set<number>();

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

export async function generateSummaryAudioForContent(contentId: number): Promise<void> {
  if (activeSummaryAudioGenerations.has(contentId)) {
    console.log(`[SummaryAudio] Generation already running for content ${contentId}`);
    return;
  }
  activeSummaryAudioGenerations.add(contentId);
  try {
    const result = await query(
      'SELECT user_id, summary, comment_summary FROM content_items WHERE id = $1',
      [contentId]
    );
    if (result.rows.length === 0) {
      throw new Error('Content not found');
    }
    const { user_id: userId, summary, comment_summary: commentSummary } = result.rows[0];
    if (!summary || !summary.trim()) {
      throw new Error('No summary to generate audio from');
    }

    await query(
      `UPDATE content_items SET summary_audio_status = 'generating', summary_audio_error = NULL WHERE id = $1`,
      [contentId]
    );

    // Comment summary rides along with a short spoken divider, mirroring the
    // "Comments" label the summary tab shows between the two summaries.
    const parts = [summary.trim()];
    if (commentSummary && commentSummary.trim()) {
      parts.push('Comments summary.');
      parts.push(commentSummary.trim());
    }
    const narrationText = parts.join('\n\n');

    console.log(`[SummaryAudio] Generating for content ${contentId} (${narrationText.length} chars)`);
    // No options.contentId: generateArticleAudio must not touch the main audio's
    // generation_status/progress columns while narrating the summary.
    const { buffer } = await generateArticleAudio(narrationText, userId, {});

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
    await query(
      `UPDATE content_items SET summary_audio_status = 'failed', summary_audio_error = $1 WHERE id = $2`,
      [message, contentId]
    ).catch(() => {});
    throw error;
  } finally {
    activeSummaryAudioGenerations.delete(contentId);
  }
}
