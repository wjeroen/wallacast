import ffmpeg from 'fluent-ffmpeg';
import { devNull } from 'os';
import { query } from '../database/db.js';
import { cachedPodcastIds } from './podcast-cache.js';

/**
 * How loud a podcast episode's own file is, so it plays as loud as our TTS.
 *
 * Every number here is integrated loudness (LUFS, the average over the whole file that
 * ITU-R BS.1770 defines, silence and very quiet stretches left out) in stereo terms: a mono
 * file's measurement + 3, since a mono file played on both ears sounds 3 LU louder than it
 * measures (Apple and Auphonic: -16 for stereo, -19 for mono). Our TTS and summary audio are
 * normalized to -19 mono since 2026-07-18, so they sit at TARGET_LUFS.
 *
 * The whole file is measured once (services/transcription.ts): when the server downloads it
 * for a transcript anyway, or else once after the episode is added. Short loud parts barely
 * move the average: a 30 s jingle 10 dB louder in an hour adds about 0.3 LU.
 *
 * Decision (user choice 2026-11-21): leave QUIET_BELOW to LOUD_ABOVE alone. Louder than
 * LOUD_ABOVE: the player turns it down to TARGET_LUFS (playback_gain_db, the browser's volume
 * only goes down). Quieter than QUIET_BELOW: the server keeps a raised copy in the podcast
 * cache (podcast-cache.ts normalizes its mono copy to -19, which is TARGET_LUFS). YouTube
 * videos are left alone: YouTube itself turns loud videos down to about -14.
 */
export const TARGET_LUFS = -16;
export const LOUD_ABOVE = -14;
export const QUIET_BELOW = -18;

/** The audio stream's channel count, or null. */
function channelCount(file: string): Promise<number | null> {
  return new Promise((resolve) => {
    ffmpeg.ffprobe(file, (err, data) => {
      if (err) return resolve(null);
      const stream = data.streams.find((s) => s.codec_type === 'audio');
      resolve(stream?.channels ?? null);
    });
  });
}

/** Integrated loudness as ffmpeg's loudnorm measures it (the file's own channels), or null. */
function integratedLoudness(file: string): Promise<number | null> {
  return new Promise((resolve) => {
    const lines: string[] = [];
    ffmpeg(file)
      .noVideo()
      .audioFilters('loudnorm=print_format=json')
      .format('null')
      .on('stderr', (line: string) => lines.push(line))
      .on('end', () => {
        const match = lines.join('\n').match(/"input_i"\s*:\s*"([^"]+)"/);
        const value = match ? parseFloat(match[1]) : NaN;
        // Pure silence measures as -inf
        resolve(Number.isFinite(value) ? value : null);
      })
      .on('error', (err: Error) => {
        console.warn(`[Loudness] ffmpeg could not measure ${file}: ${err.message.split('\n').slice(-2).join(' ').slice(0, 300)}`);
        resolve(null);
      })
      .save(devNull);
  });
}

/** The whole file's integrated loudness in stereo terms, or null when it cannot be read. */
export async function measureLoudness(file: string): Promise<{ lufs: number; channels: number } | null> {
  const [measured, channels] = await Promise.all([integratedLoudness(file), channelCount(file)]);
  if (measured === null || channels === null) return null;
  const lufs = Math.round((measured + (channels === 1 ? 3 : 0)) * 10) / 10;
  return { lufs, channels };
}

/** Stores an episode's loudness. Never throws (a database without migration 035 stores nothing). */
export async function saveLoudness(contentId: number, lufs: number): Promise<void> {
  try {
    await query('UPDATE content_items SET loudness_lufs = $1, loudness_measured_at = NOW() WHERE id = $2', [lufs, contentId]);
  } catch (error) {
    console.error(`[Loudness] Could not store the loudness of ${contentId}:`, error);
  }
}

/**
 * How many dB the player turns an episode's OWN file down (0 or negative): only when it is
 * louder than LOUD_ABOVE. The server's normalized copy (has_audio_copy) needs nothing, and the
 * player applies this only while it plays the episode's own file.
 */
export function playbackGainDb(item: { type?: string; loudness_lufs?: number | null }): number {
  if (item.type !== 'podcast_episode' || item.loudness_lufs == null) return 0;
  const lufs = Number(item.loudness_lufs);
  if (!Number.isFinite(lufs) || lufs <= LOUD_ABOVE) return 0;
  return Math.round((TARGET_LUFS - lufs) * 10) / 10;
}

/** The ids of the episodes with a copy in the podcast cache, read once per answer. */
export async function audioCopyIds(): Promise<Set<number>> {
  try {
    return new Set(await cachedPodcastIds());
  } catch {
    return new Set();
  }
}

/**
 * The item with playback_gain_db and has_audio_copy for the player, next to withAudioToken at
 * every item answer. The player picks the copy or the episode's own file once per item it opens
 * (`?copy=1` or `?copy=0` on the audio address, see index.ts), so a copy made while an episode
 * plays never swaps the bytes under it. A partial answer (a position save returns a few columns,
 * no type) gets neither, so merging it never resets them.
 */
export function withPlaybackGain<T extends { id?: number; type?: string }>(item: T, copies: Set<number>): T & { playback_gain_db?: number; has_audio_copy?: boolean } {
  if (item.type === undefined) return item;
  const hasCopy = item.type === 'podcast_episode' && item.id !== undefined && copies.has(Number(item.id));
  return { ...item, playback_gain_db: playbackGainDb(item as Parameters<typeof playbackGainDb>[0]), has_audio_copy: hasCopy };
}
