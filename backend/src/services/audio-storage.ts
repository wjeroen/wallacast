import path from 'path';
import fs from 'fs/promises';
import { createReadStream, type ReadStream } from 'fs';
import { getAudioDir, isPersistentVolume } from '../config/storage.js';
import { query } from '../database/db.js';

/**
 * File-based storage for generated article/text audio.
 *
 * WHY THIS EXISTS: audio used to live inside Postgres as a BYTEA blob (`audio_data`),
 * 10-50MB per item. Postgres pulled those blobs into its RAM cache and held the memory
 * for days. Railway bills RAM at ~$10/GB/month vs. ~$0.15-0.25/GB/month for volume disk.
 * Generated audio now lives as plain .mp3 files on the Railway volume (mounted at /data,
 * see config/storage.ts), so Postgres never touches it.
 *
 * BACKWARD COMPATIBILITY: items generated before the migration still have their bytes in
 * the `audio_data` column. Serving checks the disk file FIRST and falls back to the DB blob,
 * so nothing breaks during/after migration. Podcast episodes are unaffected. Their audio is
 * an external `audio_url`, never stored here.
 */

/** Absolute path to an item's audio file on the volume (or local ./public/audio in dev). */
export function getAudioFilePath(contentId: number | string): string {
  return path.join(getAudioDir(), `${contentId}.mp3`);
}

/**
 * Write an item's audio to disk. Returns true on success, false on failure (caller should
 * fall back to storing the blob in the DB so audio is never lost).
 */
export async function saveAudioFile(contentId: number | string, buffer: Buffer): Promise<boolean> {
  try {
    await fs.mkdir(getAudioDir(), { recursive: true });
    await fs.writeFile(getAudioFilePath(contentId), buffer);
    return true;
  } catch (error) {
    console.error(`[AudioStorage] Failed to write audio file for ${contentId}:`, error);
    return false;
  }
}

/** Size in bytes of an item's on-disk audio, or null if there is no file. */
export async function getAudioFileSize(contentId: number | string): Promise<number | null> {
  try {
    const stat = await fs.stat(getAudioFilePath(contentId));
    return stat.size;
  } catch {
    return null; // no file (not migrated, or never had generated audio)
  }
}

/** Delete an item's on-disk audio. Best-effort: a missing file is not an error. */
export async function deleteAudioFile(contentId: number | string): Promise<void> {
  try {
    await fs.unlink(getAudioFilePath(contentId));
  } catch {
    // file already gone, nothing to do
  }
}

/**
 * Stream a byte range (or the whole file) from disk. `start`/`end` are inclusive byte
 * offsets, matching HTTP Range semantics and fs.createReadStream's options.
 */
export function createAudioReadStream(
  contentId: number | string,
  start?: number,
  end?: number
): ReadStream {
  if (start === undefined) {
    return createReadStream(getAudioFilePath(contentId));
  }
  return createReadStream(getAudioFilePath(contentId), { start, end });
}

/**
 * ONE-TIME (idempotent) migration: copy every item's `audio_data` blob to a disk file.
 * Non-destructive: the DB blob is KEPT. Reads ONE blob at a time so RAM stays low even
 * for a large library. Items already on disk are skipped (so re-running is cheap). Run
 * automatically at startup; safe to run on every boot.
 */
export async function migrateAudioBlobsToDisk(): Promise<{ migrated: number; skipped: number; failed: number; mb: string }> {
  const idsRes = await query(`SELECT id FROM content_items WHERE audio_data IS NOT NULL ORDER BY id`);
  let migrated = 0, skipped = 0, failed = 0, bytes = 0;
  for (const { id } of idsRes.rows) {
    if ((await getAudioFileSize(id)) !== null) { skipped++; continue; } // already on disk
    const blobRes = await query('SELECT audio_data FROM content_items WHERE id = $1', [id]);
    const buf = blobRes.rows[0]?.audio_data as Buffer | undefined;
    if (!buf) { skipped++; continue; }
    const ok = await saveAudioFile(id, buf);
    if (ok) { migrated++; bytes += buf.length; } else { failed++; }
  }
  return { migrated, skipped, failed, mb: (bytes / 1048576).toFixed(1) };
}

/**
 * DESTRUCTIVE second stage: NULL the `audio_data` blob for items whose audio is verified
 * to exist on disk. This is what actually frees Postgres of the blobs. ONLY clears a blob
 * when the disk file is present (never leaves an item with no audio). Env-gated so it never
 * runs by accident.
 */
export async function clearMigratedAudioBlobs(): Promise<{ cleared: number; kept: number }> {
  // HARD SAFETY GUARD: only clear blobs when the disk files live on the persistent
  // volume. On the local/ephemeral fallback the files vanish on the next redeploy.
  // Clearing the DB blobs in that state would permanently lose all generated audio.
  if (!isPersistentVolume()) {
    throw new Error(
      'Refusing to clear audio blobs: storage is NOT the persistent volume (/data). ' +
      'The disk files are on the container\'s ephemeral disk and would be lost on redeploy. ' +
      'Fix the volume mount (must be exactly /data) first.'
    );
  }
  const idsRes = await query(`SELECT id FROM content_items WHERE audio_data IS NOT NULL ORDER BY id`);
  let cleared = 0, kept = 0;
  for (const { id } of idsRes.rows) {
    if ((await getAudioFileSize(id)) !== null) {
      await query('UPDATE content_items SET audio_data = NULL WHERE id = $1', [id]);
      cleared++;
    } else {
      kept++; // no disk file, leave the blob alone
    }
  }
  return { cleared, kept };
}
