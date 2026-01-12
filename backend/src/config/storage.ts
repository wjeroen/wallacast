import path from 'path';
import fs from 'fs/promises';

/**
 * Get the base storage directory
 * Uses Railway Volume if available (/data), otherwise falls back to local storage
 */
export function getStorageDir(): string {
  // Check if running on Railway with a volume mounted at /data
  const volumePath = '/data';

  try {
    // Synchronously check if the volume exists (only safe during initialization)
    if (require('fs').existsSync(volumePath)) {
      console.log('Using Railway Volume for persistent storage:', volumePath);
      return volumePath;
    }
  } catch (e) {
    // If check fails, fall back to local storage
  }

  // Fall back to local storage (for development)
  const localPath = path.join(process.cwd(), 'public');
  console.log('Using local storage:', localPath);
  return localPath;
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
