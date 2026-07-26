import path from 'path';
import fs from 'fs/promises';
import { devNull } from 'os';
import ffmpeg from 'fluent-ffmpeg';
import { getAudioDir } from '../config/storage.js';

/**
 * Transient podcast-audio cache. Some hosts (SoundCloud) serve VBR files with
 * coarse seek tables, so the browser's clock drifts seconds after far seeks
 * (read-along desync) and resume-seeks abort. When a transcript is generated for
 * an episode from such a host (the file is already fully downloaded for Whisper
 * at that moment, and ONLY then), we re-encode it CBR mono with clean headers
 * (loudness-normalized like article audio) and keep it on the volume. The audio
 * route serves the cached file with exact byte ranges when present, else falls
 * back to the proxy, so uncached episodes work exactly as before.
 *
 * Bounded on purpose: evicted when the episode is archived, plus a size-capped
 * LRU (oldest mtime deleted first; serving touches mtime).
 */

// Suffix-matched hosts whose files are known to seek badly. Grow as drift is
// noticed with other hosters.
const CACHEABLE_HOSTS = ['soundcloud.com'];

const CACHE_MAX_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB

function cacheDir(): string {
  return path.join(getAudioDir(), 'podcast-cache');
}

export function shouldCachePodcastHost(audioUrl?: string | null): boolean {
  if (!audioUrl) return false;
  try {
    const host = new URL(audioUrl).hostname.toLowerCase();
    return CACHEABLE_HOSTS.some(h => host === h || host.endsWith(`.${h}`));
  } catch {
    return false;
  }
}

export function cachedPodcastAudioPath(contentId: number | string): string {
  return path.join(cacheDir(), `${contentId}.mp3`);
}

/** Size of the cached file, or null when not cached. Touches mtime for LRU. */
export async function getCachedPodcastAudioSize(contentId: number | string): Promise<number | null> {
  try {
    const p = cachedPodcastAudioPath(contentId);
    const stat = await fs.stat(p);
    fs.utimes(p, new Date(), new Date()).catch(() => {});
    return stat.size;
  } catch {
    return null;
  }
}

export async function evictCachedPodcastAudio(contentId: number | string): Promise<void> {
  try {
    await fs.unlink(cachedPodcastAudioPath(contentId));
    console.log(`[PodcastCache] Evicted cached audio for ${contentId}`);
  } catch { /* not cached */ }
}

// --- Loudness normalization (mirrors LOUDNORM_TARGET machinery in openai-tts.ts;
// duplicated here to avoid an import cycle: openai-tts -> transcription -> this file).
const LOUDNORM_TARGET = 'I=-19:TP=-1.5:LRA=11';

interface LoudnormStats {
  input_i: string;
  input_tp: string;
  input_lra: string;
  input_thresh: string;
  target_offset: string;
}

function parseLoudnormStats(stderrLines: string[]): LoudnormStats | null {
  const match = stderrLines.join('\n').match(/\{[^{}]*"input_i"[^{}]*\}/);
  if (!match) return null;
  try {
    const stats = JSON.parse(match[0]);
    for (const key of ['input_i', 'input_tp', 'input_lra', 'input_thresh', 'target_offset'] as const) {
      if (!Number.isFinite(parseFloat(stats[key]))) return null;
    }
    return stats;
  } catch {
    return null;
  }
}

function loudnormFilter(stats: LoudnormStats | null): string {
  if (!stats) return `loudnorm=${LOUDNORM_TARGET}`;
  return `loudnorm=${LOUDNORM_TARGET}:measured_I=${stats.input_i}:measured_TP=${stats.input_tp}:measured_LRA=${stats.input_lra}:measured_thresh=${stats.input_thresh}:offset=${stats.target_offset}:linear=true`;
}

async function measureFileLoudness(file: string): Promise<LoudnormStats | null> {
  return new Promise((resolve) => {
    const lines: string[] = [];
    ffmpeg(file)
      .audioFilters(`loudnorm=${LOUDNORM_TARGET}:print_format=json`)
      .format('null')
      .on('stderr', (line: string) => lines.push(line))
      .on('end', () => resolve(parseLoudnormStats(lines)))
      .on('error', () => resolve(null))
      .save(devNull);
  });
}

/**
 * Re-encode the (already downloaded) episode file into the cache. Never throws:
 * caching is quality-of-life, transcription must not fail because of it.
 */
export async function cachePodcastAudio(contentId: number, sourcePath: string): Promise<void> {
  const out = cachedPodcastAudioPath(contentId);
  const tmp = `${out}.tmp`;
  try {
    await fs.mkdir(cacheDir(), { recursive: true });
    const stats = await measureFileLoudness(sourcePath);
    await new Promise<void>((resolve, reject) => {
      ffmpeg(sourcePath)
        .audioFilters(loudnormFilter(stats))
        .audioFrequency(44100)
        .audioChannels(1)
        .audioBitrate('96k')
        .format('mp3')
        .on('end', () => resolve())
        .on('error', (err) => reject(err))
        .save(tmp);
    });
    await fs.rename(tmp, out);
    const size = (await fs.stat(out)).size;
    console.log(`[PodcastCache] Cached ${contentId}: ${(size / 1024 / 1024).toFixed(1)} MB (CBR 96k mono, normalized)`);
    await enforceCacheCap();
  } catch (e) {
    console.error(`[PodcastCache] Failed to cache ${contentId}:`, e);
    fs.unlink(tmp).catch(() => {});
  }
}

/** Delete oldest-touched files until the cache fits the cap. */
async function enforceCacheCap(): Promise<void> {
  try {
    const dir = cacheDir();
    const names = await fs.readdir(dir);
    const files: Array<{ p: string; size: number; mtime: number }> = [];
    for (const name of names) {
      if (!name.endsWith('.mp3')) continue;
      try {
        const stat = await fs.stat(path.join(dir, name));
        files.push({ p: path.join(dir, name), size: stat.size, mtime: stat.mtimeMs });
      } catch { /* raced */ }
    }
    let total = files.reduce((s, f) => s + f.size, 0);
    if (total <= CACHE_MAX_BYTES) return;
    files.sort((a, b) => a.mtime - b.mtime);
    for (const f of files) {
      if (total <= CACHE_MAX_BYTES) break;
      await fs.unlink(f.p).catch(() => {});
      total -= f.size;
      console.log(`[PodcastCache] LRU-evicted ${path.basename(f.p)} (${(f.size / 1024 / 1024).toFixed(1)} MB)`);
    }
  } catch { /* cache dir may not exist yet */ }
}
