/**
 * Shared Whisper prompt builder.
 *
 * HISTORY: We used to pack this with title, author, comment usernames, dates,
 * etc.  Turns out Whisper's "initial prompt" only conditions the first ~30-60
 * seconds of audio.  For a 30-minute article where comments start at minute 25,
 * none of that metadata helps.  Worse, the prompt seemed to cause Whisper to
 * "consume" the title (dropping the first ~7 seconds of word timestamps).
 *
 * Current strategy: return an empty string.  For chunked transcription (>25 MB
 * files), the continuity strategy in transcription.ts (feeding the previous
 * chunk's text as prompt) handles context naturally.
 *
 * Used by:
 *   - POST  /api/content       (auto-transcribe on podcast add)
 *   - PATCH /api/content/:id   (regenerate transcript)
 *   - POST  /api/transcription/content/:id  (explicit transcribe button)
 */

interface WhisperPromptInput {
  title?: string | null;
  author?: string | null;
  published_at?: string | Date | null;
  podcast_show_name?: string | null;
  comments?: string | object | null;
}

export function buildWhisperPrompt(_item: WhisperPromptInput): string {
  // Intentionally empty — see module docstring for rationale.
  return '';
}
