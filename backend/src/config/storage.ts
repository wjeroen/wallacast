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
 * attached to — prefer it, then fall back to the conventional /data. (Historic bug: this
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
      // not accessible — try the next candidate
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
 * fallback — fine for dev, but on Railway that's the container's EPHEMERAL disk: files
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

/**
 * Ensure storage directories exist
 */
export async function ensureStorageDirectories(): Promise<void> {
  await fs.mkdir(getAudioDir(), { recursive: true });
  await fs.mkdir(getTempDir(), { recursive: true });
  console.log('✓ Storage directories initialized');
}
