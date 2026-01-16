import ffmpeg from 'fluent-ffmpeg';

/**
 * Get the duration of an audio file in seconds using ffprobe
 * @param filePath Path to the audio file
 * @returns Duration in seconds
 */
export async function getAudioDuration(filePath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) {
        reject(err);
      } else {
        resolve(metadata.format.duration || 0);
      }
    });
  });
}
