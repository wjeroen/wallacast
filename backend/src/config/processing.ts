/**
 * Configuration constants for audio/text processing services
 * Centralized to make tuning easier without code changes
 */

export const PROCESSING_CONFIG = {
  tts: {
    // Maximum characters per chunk for OpenAI TTS API
    // OpenAI limit is 4096, using 3500 to leave buffer for encoding
    chunkSize: 10000,

    // Default voice for text-to-speech
    voice: 'alloy' as const,
  },

  whisper: {
    // OpenAI Whisper API file size limit in megabytes
    maxFileSizeMB: 25,

    // Threshold for proactive compression (close to limit)
    compressionThresholdMB: 20,

    // Duration in minutes for splitting large audio files
    chunkDurationMinutes: 15,

    // Maximum characters of previous transcript to use as context
    // (Whisper API limit is 224 characters for prompt)
    contextPromptMaxChars: 224,
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
