import { getUserSetting } from './ai-providers.js';
import { isEAForumUrl } from './article-fetcher.js';
import { commentChars } from './token-limits.js';

/** The item fields that decide what an article's audio narrates. */
export interface NarratedItem {
  user_id: number;
  url?: string | null;
  content?: string | null;
  html_content?: string | null;
  comments?: unknown;
  comment_source?: string | null;
}

/** Characters an article may have before "Only under N characters" skips its automatic
 *  audio, when the setting is on but holds no valid number. */
export const DEFAULT_AUTO_AUDIO_MAX_CHARS = 30000;

/** Whether the user's settings narrate this item's comments. EA Forum and LessWrong comments
 *  follow narrate_ea_forum_comments, Substack comments narrate_substack_comments (both on by
 *  default), and comments from anywhere else are always narrated. */
export async function settingsNarrateComments(item: NarratedItem): Promise<boolean> {
  const isLessWrong = item.comment_source === 'lesswrong' || (item.url ? item.url.includes('lesswrong.com') : false);
  const isEAForum = item.comment_source === 'ea_forum' || isEAForumUrl(item.url);
  const isSubstack = item.comment_source === 'substack'
    || (!item.comment_source && (!!item.url?.includes('substack.com') || !!item.html_content?.includes('substackcdn.com')));
  if (isLessWrong || isEAForum) return (await getUserSetting(item.user_id, 'narrate_ea_forum_comments')) !== 'false';
  if (isSubstack) return (await getUserSetting(item.user_id, 'narrate_substack_comments')) !== 'false';
  return true;
}

/** The characters the length cap counts: the body's text, plus its comments when the
 *  settings narrate them. */
export async function narratedChars(item: NarratedItem): Promise<number> {
  const body = String(item.content || item.html_content || '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim().length;
  const comments = item.comments && (await settingsNarrateComments(item)) ? commentChars(item.comments) : 0;
  return body + comments;
}

/** The length cap on automatic article audio (auto_audio_cap_enabled with
 *  auto_audio_max_chars): `{ chars, max }` when the item is over it, null when it fits or
 *  the cap is off. Manual generation never checks it. */
export async function overAutoAudioCap(item: NarratedItem): Promise<{ chars: number; max: number } | null> {
  const [on, maxSetting] = await Promise.all([
    getUserSetting(item.user_id, 'auto_audio_cap_enabled'),
    getUserSetting(item.user_id, 'auto_audio_max_chars'),
  ]);
  if (on !== 'true') return null;
  const parsed = parseInt(maxSetting || '', 10);
  const max = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_AUTO_AUDIO_MAX_CHARS;
  const chars = await narratedChars(item);
  return chars > max ? { chars, max } : null;
}
