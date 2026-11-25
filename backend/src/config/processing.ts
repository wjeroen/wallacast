/**
 * Configuration constants for audio/text processing services
 * Centralized to make tuning easier without code changes
 */

export const PROCESSING_CONFIG = {
  tts: {
    // Maximum characters per chunk for OpenAI TTS API
    // OpenAI limit is 4096, using 3500 to leave buffer for encoding
    chunkSize: 3500,
  },

  whisper: {
    // OpenAI Whisper API file size limit in megabytes
    maxFileSizeMB: 25,

    // Threshold for proactive compression (close to limit)
    compressionThresholdMB: 20,

    // Duration in minutes for splitting large audio files
    chunkDurationMinutes: 15,
  },

  retry: {
    // Maximum number of retry attempts for API calls
    maxAttempts: 5,

    // Initial delay in milliseconds before first retry
    baseDelayMs: 1000,

    // Maximum delay in milliseconds (exponential backoff cap)
    maxDelayMs: 30000,
  },
};

/**
 * How much of each item's text the library list (GET /api/content) and the queue send. The
 * app searches it and shows it in the Content tab until the full item arrives. 50,000
 * characters sends 94% of texts whole and cut a library load from 34.9 to 22.9 MB
 * (2026-11-23). `content_chars` carries the full length.
 */
export const LIST_TEXT_CHARS = 50_000;

/**
 * MP3 bitrate of generated speech (narration, summary audio) and of saved podcast copies, all
 * mono. 64 kbps sounded the same as 96 to the user on good headphones, for TTS and a podcast,
 * while 48 was clearly worse for the podcast (2026-11-23). A third smaller than 96.
 */
export const SPEECH_BITRATE = '64k';
