import { safeFetch } from './url-guard.js';
import { getUserSetting } from './ai-providers.js';
import { youtubeWatchUrl } from '../shared/format.js';
import type { Comment } from '../shared/types.js';

// What an added YouTube video is stored with, read when the video is added or refetched and
// by the refresh job (youtube-refresh.ts), never for playback (the app plays the video in
// YouTube's embedded player):
// - The YouTube Data API, with the user's key: title, channel, description, publish date,
//   length, view and comment counts and whether the embedded player may play it
//   (videos.list), and the most relevant comments (commentThreads.list). One quota unit per
//   call, whatever parts are asked for.
// - Without a working key, oEmbed, YouTube's lookup that needs no key: title and channel.
//   The player fills the length on first play. YouTube's developer policies forbid scraping
//   YouTube (III.E.6), so the watch page is never read.

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const HEADERS_TIMEOUT_MS = 10_000;
const COMMENT_THREADS = 100; // the most commentThreads.list gives in one call

// Why YouTube's embedded player cannot play a video, so it plays only on YouTube
export type EmbedBlocked = 'not_embeddable' | 'age_restricted';

export interface YouTubeMetadata {
  title: string | null;
  author: string | null;
  // HTML: the description's plain text, escaped, with its web addresses as links
  description: string | null;
  preview_picture: string;
  published_at: string | null;
  duration: number | null;
  // Only from the Data API, null from oEmbed
  view_count: number | null;
  comment_count: number | null;
  embed_blocked: EmbedBlocked | null;
  source: 'data_api' | 'oembed';
}

export class YouTubeUnavailableError extends Error {}

interface OEmbed {
  title?: string;
  author_name?: string;
}

// The user's key for the Data API (Settings, `youtube_api_key`), or null. The Data API
// costs nothing, only daily quota (10,000 units). A Gemini key from AI Studio does not work
// here even with the API turned on in its project: Google answers "Requests to this API ...
// are blocked", because AI Studio restricts the key to Gemini (checked 2026-10-22). So it
// takes its own key.
export async function youtubeApiKey(userId: number): Promise<string | null> {
  return (await getUserSetting(userId, 'youtube_api_key'))?.trim() || null;
}

// ISO 8601 length (PT1H2M3S, P1DT2H for very long streams) in seconds, or null
function isoDurationSeconds(value: string | undefined): number | null {
  const m = (value || '').match(/^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/);
  if (!m) return null;
  const seconds = (Number(m[1] || 0) * 86400) + (Number(m[2] || 0) * 3600) + (Number(m[3] || 0) * 60) + Number(m[4] || 0);
  return seconds > 0 ? seconds : null;
}

// A count YouTube sends as a string ("12345"), or null when it sends none
function countOrNull(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function isoDateOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const date = new Date(value);
  return isNaN(date.getTime()) ? null : date.toISOString();
}

// One Data API call. The key goes in a header, never in the address, so it can never end up
// in an error message or a log line. A failed call throws with YouTube's reason
// (quotaExceeded, commentsDisabled, ...) in the message, also kept on `reason`.
export class DataApiError extends Error {
  constructor(message: string, readonly status: number, readonly reason: string) {
    super(message);
  }
}

async function dataApi(path: string, key: string): Promise<any> {
  const res = await safeFetch(
    `https://www.googleapis.com/youtube/v3/${path}`,
    { headers: { 'X-Goog-Api-Key': key } }, 5, HEADERS_TIMEOUT_MS
  );
  const body = (await res.json().catch(() => ({}))) as any;
  if (!res.ok) {
    const reason = body?.error?.errors?.[0]?.reason || body?.error?.details?.find((d: any) => d?.reason)?.reason || body?.error?.status || '';
    throw new DataApiError(`Data API answered HTTP ${res.status} ${reason}`.trim(), res.status, reason);
  }
  return body;
}

type DataApiDetails = Omit<YouTubeMetadata, 'preview_picture' | 'source'>;

// One video resource of a videos.list answer, as the app stores it (description still plain
// text). Exported for scripts/test-youtube.mts.
export function videoDetailsFromApi(video: any): DataApiDetails {
  // contentRating.ytRating is YouTube's own age restriction. Such a video asks the viewer
  // to sign in on YouTube, so the embedded player cannot play it either.
  const embedBlocked: EmbedBlocked | null = video.status?.embeddable === false ? 'not_embeddable'
    : video.contentDetails?.contentRating?.ytRating === 'ytAgeRestricted' ? 'age_restricted'
    : null;
  return {
    title: video.snippet?.title || null,
    author: video.snippet?.channelTitle || null,
    description: video.snippet?.description || null,
    published_at: isoDateOrNull(video.snippet?.publishedAt),
    duration: isoDurationSeconds(video.contentDetails?.duration),
    view_count: countOrNull(video.statistics?.viewCount),
    // YouTube leaves commentCount out when the video's comments are turned off
    comment_count: countOrNull(video.statistics?.commentCount) ?? 0,
    embed_blocked: embedBlocked,
  };
}

async function fetchDataApiDetails(videoId: string, key: string): Promise<DataApiDetails> {
  const body = await dataApi(`videos?part=snippet,contentDetails,status,statistics&id=${encodeURIComponent(videoId)}`, key);
  const video = body?.items?.[0];
  if (!video) {
    throw new YouTubeUnavailableError('YouTube has no public or unlisted video with this address. It may be private or removed.');
  }
  return videoDetailsFromApi(video);
}

async function fetchOEmbed(videoId: string): Promise<OEmbed> {
  const url = `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(youtubeWatchUrl(videoId))}`;
  const res = await safeFetch(url, { headers: { 'User-Agent': BROWSER_UA } }, 5, HEADERS_TIMEOUT_MS);
  if (!res.ok) throw new Error(`oEmbed answered HTTP ${res.status}`);
  return (await res.json()) as OEmbed;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// YouTube descriptions are plain text. Escaped, with links and with <br> for its line
// breaks, they show like a podcast description (chapter times become seek buttons) and
// keep their lines in the Markdown export.
function descriptionToHtml(text: string): string {
  return text
    .split(/(https?:\/\/[^\s<>"]+)/g)
    .map((part, i) => (i % 2 === 1
      ? `<a href="${escapeHtml(part)}" target="_blank" rel="noopener noreferrer">${escapeHtml(part)}</a>`
      : escapeHtml(part).replace(/\r?\n/g, '<br>')))
    .join('');
}

// 16:9 without the black bars hqdefault.jpg adds
const thumbnailFor = (videoId: string) => `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`;

// The video's details. With a key they come from the Data API. When that fails (a wrong key,
// the day's quota used up), `fallbackToOEmbed` decides: adding a video still works with
// oEmbed's title and channel, while a refresh throws, so it never stores less than it had.
export async function fetchYouTubeMetadata(videoId: string, apiKey: string | null = null, fallbackToOEmbed = true): Promise<YouTubeMetadata> {
  if (apiKey) {
    try {
      const api = await fetchDataApiDetails(videoId, apiKey);
      console.log(`[YouTube] ${videoId}: data api=ok duration=${api.duration ?? 'unknown'} embed=${api.embed_blocked ?? 'ok'}`);
      return {
        ...api,
        description: api.description?.trim() ? descriptionToHtml(api.description.trim()) : null,
        preview_picture: thumbnailFor(videoId),
        source: 'data_api',
      };
    } catch (err) {
      if (err instanceof YouTubeUnavailableError || !fallbackToOEmbed) throw err;
      console.warn(`[YouTube] ${videoId}: data api failed, using oEmbed: ${(err as Error).message}`);
    }
  }
  let oembed: OEmbed;
  try {
    oembed = await fetchOEmbed(videoId);
  } catch (err) {
    console.warn(`[YouTube] ${videoId}: ${(err as Error).message}`);
    throw new YouTubeUnavailableError('YouTube gave no details for this video. It may be private, removed, or not a video address.');
  }
  console.log(`[YouTube] ${videoId}: oembed=ok`);
  return {
    title: oembed.title || null,
    author: oembed.author_name || null,
    description: null,
    preview_picture: thumbnailFor(videoId),
    published_at: null,
    duration: null,
    view_count: null,
    comment_count: null,
    embed_blocked: null,
    source: 'oembed',
  };
}

// A comment as the app stores it (the shape of EA Forum and Substack comments), with
// YouTube's likes as its score. textDisplay is YouTube's HTML (links and line breaks), and
// its links open outside the app.
function toComment(raw: any): Comment | null {
  const s = raw?.snippet;
  const html = typeof s?.textDisplay === 'string' ? s.textDisplay.trim() : '';
  if (!html) return null;
  const comment: Comment = {
    username: s.authorDisplayName || 'Unknown',
    content: html.replace(/<a\s/gi, '<a target="_blank" rel="noopener noreferrer" '),
  };
  const date = isoDateOrNull(s.publishedAt);
  if (date) comment.date = date;
  // Like YouTube, a comment without likes shows no count
  const likes = countOrNull(s.likeCount);
  if (likes) comment.karma = likes;
  return comment;
}

// The comments of a commentThreads.list answer, each thread's replies oldest first.
// Exported for scripts/test-youtube.mts.
export function commentsFromThreads(body: any): Comment[] {
  const comments: Comment[] = [];
  for (const thread of body?.items || []) {
    const top = toComment(thread?.snippet?.topLevelComment);
    if (!top) continue;
    const replies = ((thread?.replies?.comments || []) as any[])
      .map(toComment)
      .filter((c): c is Comment => c !== null)
      .sort((a, b) => (a.date || '').localeCompare(b.date || ''));
    if (replies.length > 0) top.replies = replies;
    comments.push(top);
  }
  return comments;
}

// The video's most relevant comment threads (commentThreads.list, one quota unit), up to
// 100, each with the few replies YouTube includes in a thread. YouTube's replies list "is
// only a subset" when a thread has more, and all of them would cost a call per thread. []
// when the video's comments are turned off.
export async function fetchYouTubeComments(videoId: string, key: string): Promise<Comment[]> {
  let body: any;
  try {
    body = await dataApi(
      `commentThreads?part=snippet,replies&videoId=${encodeURIComponent(videoId)}&maxResults=${COMMENT_THREADS}&order=relevance&textFormat=html`,
      key
    );
  } catch (err) {
    if (err instanceof DataApiError && err.reason === 'commentsDisabled') return [];
    throw err;
  }
  const comments = commentsFromThreads(body);
  console.log(`[YouTube] ${videoId}: ${comments.length} comment threads`);
  return comments;
}
