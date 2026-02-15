/**
 * Shared Whisper prompt builder.
 *
 * Whisper uses an "initial prompt" to prime its vocabulary — if you tell it
 * the names and phrases that will appear in the audio, it's much more likely
 * to transcribe them correctly (instead of skipping or garbling them).
 *
 * This function takes metadata about the content item (title, author, date,
 * comments) and builds a short prompt string that tells Whisper what to
 * expect.  It's used everywhere we call `transcribeWithTimestamps`:
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

/**
 * Strip emoji from a string so Whisper doesn't try to pronounce them.
 */
function stripEmoji(str: string): string {
  return str.replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu, '').trim();
}

export function buildWhisperPrompt(item: WhisperPromptInput): string {
  let prompt = '';

  // 1. Article / episode metadata
  if (item.title) prompt += `Title: ${item.title}. `;
  if (item.author) prompt += `Written by ${stripEmoji(item.author)}. `;
  if (item.podcast_show_name) prompt += `Show: ${item.podcast_show_name}. `;

  // Date — use real date if available, otherwise a generic fallback
  const dateStr = item.published_at
    ? new Date(item.published_at as string).toLocaleDateString('en-US')
    : 'recent date';
  prompt += `Published on ${dateStr}. `;

  // 2. Comments section — give Whisper the first two commenter names/dates
  //    so it doesn't skip the "comment section:" announcements.
  if (item.comments) {
    try {
      const commentsData: any[] =
        typeof item.comments === 'string'
          ? JSON.parse(item.comments)
          : (item.comments as any[]);

      if (Array.isArray(commentsData) && commentsData.length > 0) {
        prompt += 'Comments section: ';

        // First commenter
        const first = commentsData[0];
        const user1 = stripEmoji(first.username || 'User');
        const date1 = first.date
          ? new Date(first.date).toLocaleDateString('en-US')
          : 'recently';
        const upvotes1 = first.karma || 0;
        prompt += `${user1} on ${date1} with ${upvotes1} upvotes. `;

        // Second commenter (reply to first, or next top-level comment)
        let second: any = null;
        let isReply = false;

        if (first.replies && first.replies.length > 0) {
          second = first.replies[0];
          isReply = true;
        } else if (commentsData.length > 1) {
          second = commentsData[1];
        }

        if (second) {
          const user2 = stripEmoji(second.username || 'User');
          const date2 = second.date
            ? new Date(second.date).toLocaleDateString('en-US')
            : 'recently';
          const upvotes2 = second.karma || 0;

          // Handle agree votes from extendedScore
          let agree2 = 0;
          if (second.extendedScore) {
            const es =
              typeof second.extendedScore === 'string'
                ? JSON.parse(second.extendedScore)
                : second.extendedScore;
            agree2 = es.agreement || es.agree || 0;
          }

          if (isReply) {
            prompt += `A reply to ${user1} by ${user2} on ${date2} with ${upvotes2} upvotes, ${agree2} agree.`;
          } else {
            prompt += `${user2} on ${date2} with ${upvotes2} upvotes.`;
          }
        }
      }
    } catch {
      /* ignore parsing errors */
    }
  }

  return prompt;
}
