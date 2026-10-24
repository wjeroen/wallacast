import path from 'path';
import fs from 'fs/promises';
import { existsSync } from 'fs';

// Cache the storage directory to avoid repeated checks and logs
let cachedStorageDir: string | null = null;
let usingPersistentVolume = false;

/**
 * Get the base storage directory.
 * Uses the Railway volume if one is mounted, otherwise falls back to local ./public.
 *
 * Detection: Railway injects RAILWAY_VOLUME_MOUNT_PATH into the service the volume is
 * attached to. Prefer it, then fall back to the conventional /data. (Historic bug: this
 * used `require('fs')`, which throws in our ESM build, so the volume was NEVER detected and
 * storage always fell back to ephemeral ./public. Fixed by importing existsSync properly.)
 */
export function getStorageDir(): string {
  if (cachedStorageDir) {
    return cachedStorageDir;
  }

  const candidates = [process.env.RAILWAY_VOLUME_MOUNT_PATH, '/data'].filter(Boolean) as string[];
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate)) {
        console.log('Using persistent volume for storage:', candidate);
        cachedStorageDir = candidate;
        usingPersistentVolume = true;
        return candidate;
      }
    } catch {
      // not accessible, try the next candidate
    }
  }

  // Fall back to local storage (development, or no volume mounted)
  const localPath = path.join(process.cwd(), 'public');
  console.log('Using local storage:', localPath);
  cachedStorageDir = localPath;
  usingPersistentVolume = false;
  return localPath;
}

/**
 * True when storage is a persistent Railway volume. False means the local ./public
 * fallback: fine for dev, but on Railway that's the container's EPHEMERAL disk. Files
 * written there vanish on every redeploy. Destructive migration steps (clearing DB audio
 * blobs) must NEVER run in that state.
 */
export function isPersistentVolume(): boolean {
  getStorageDir(); // ensure detection has run and the flag is set
  return usingPersistentVolume;
}

/**
 * Get the audio storage directory
 */
export function getAudioDir(): string {
  return path.join(getStorageDir(), 'audio');
}

/**
 * Get the temp directory
 */
export function getTempDir(): string {
  return path.join(getStorageDir(), 'temp');
}

/** Free space on the storage volume in bytes, or null when it cannot be read. */
export async function freeVolumeBytes(): Promise<number | null> {
  try {
    const st = await fs.statfs(getStorageDir());
    return st.bavail * st.bsize;
  } catch {
    return null;
  }
}

async function folderBytes(dir: string): Promise<{ bytes: number; files: number }> {
  let bytes = 0;
  let files = 0;
  try {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      try {
        bytes += (await fs.stat(path.join(dir, entry.name))).size;
        files++;
      } catch { /* raced */ }
    }
  } catch { /* the folder does not exist yet */ }
  return { bytes, files };
}

// No job runs this long, so an older temp file was left by a job that crashed or ran out of
// disk halfway
const STALE_TEMP_MS = 6 * 60 * 60 * 1000;

/**
 * Startup report of what fills the volume, one `💽 [Volume]` line: generated audio, the
 * podcast cache, temp files and the free space. Stale temp files are deleted first. Never
 * throws.
 */
export async function reportVolume(): Promise<void> {
  try {
    let staleFiles = 0;
    let staleBytes = 0;
    try {
      for (const name of await fs.readdir(getTempDir())) {
        const p = path.join(getTempDir(), name);
        try {
          const stat = await fs.stat(p);
          if (!stat.isFile() || Date.now() - stat.mtimeMs < STALE_TEMP_MS) continue;
          await fs.unlink(p);
          staleFiles++;
          staleBytes += stat.size;
        } catch { /* raced */ }
      }
    } catch { /* no temp folder yet */ }
    const gb = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(2)} GB`;
    const audio = await folderBytes(getAudioDir());
    const cache = await folderBytes(path.join(getAudioDir(), 'podcast-cache'));
    const temp = await folderBytes(getTempDir());
    const st = await fs.statfs(getStorageDir()).catch(() => null);
    const space = st ? `, free ${gb(st.bavail * st.bsize)} of ${gb(st.blocks * st.bsize)}` : '';
    console.log(
      `💽 [Volume] audio ${gb(audio.bytes)} (${audio.files} files), podcast cache ${gb(cache.bytes)} (${cache.files}), ` +
      `temp ${gb(temp.bytes)} (${temp.files})${space}` +
      (staleFiles > 0 ? `. Deleted ${staleFiles} stale temp file(s), ${gb(staleBytes)}` : '')
    );
  } catch (e) {
    console.error('💽 [Volume] Report failed:', e);
  }
}

/**
 * Ensure storage directories exist
 */
export async function ensureStorageDirectories(): Promise<void> {
  await fs.mkdir(getAudioDir(), { recursive: true });
  await fs.mkdir(getTempDir(), { recursive: true });
  console.log('✓ Storage directories initialized');
}
