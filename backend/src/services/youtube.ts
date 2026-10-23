import { safeFetch } from './url-guard.js';
import { getUserSetting } from './ai-providers.js';
import { youtubeWatchUrl } from '../shared/format.js';

// What an added YouTube video is stored with, read when the video is added or refetched,
// never for playback (the app plays the video in YouTube's embedded player):
// - The YouTube Data API (videos.list), with the user's key: title, channel, description,
//   publish date and length. The official route, and the one that works from Railway.
// - Without a working key, two public sources: oEmbed, YouTube's lookup that needs no key
//   (title, channel), and the watch page (length, publish date, description). The watch
//   page is best effort: YouTube often answers a datacenter address with HTTP 429 (seen on
//   Railway 2026-10-22), and then the player fills the length on first play.

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const HEADERS_TIMEOUT_MS = 10_000;

export interface YouTubeMetadata {
  title: string | null;
  author: string | null;
  // HTML: the description's plain text, escaped, with its web addresses as links
  description: string | null;
  preview_picture: string;
  published_at: string | null;
  duration: number | null;
}

export class YouTubeUnavailableError extends Error {}

interface OEmbed {
  title?: string;
  author_name?: string;
}

// The user's key for the Data API (Settings, `youtube_api_key`), or null. The Data API
// costs nothing, only daily quota (10,000 units, one per video). A Gemini key from AI
// Studio does not work here even with the API turned on in its project: Google answers
// "Requests to this API ... are blocked", because AI Studio restricts the key to Gemini
// (checked 2026-10-22). So it takes its own key.
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

// One videos.list call (1 quota unit). The key goes in a header, never in the address, so
// it can never end up in an error message or a log line.
async function fetchDataApiDetails(videoId: string, key: string): Promise<PageDetails> {
  const res = await safeFetch(
    `https://www.googleapis.com/youtube/v3/videos?part=snippet,contentDetails&id=${encodeURIComponent(videoId)}`,
    { headers: { 'X-Goog-Api-Key': key } }, 5, HEADERS_TIMEOUT_MS
  );
  const body = (await res.json().catch(() => ({}))) as any;
  if (!res.ok) {
    const reason = body?.error?.details?.find((d: any) => d?.reason)?.reason || body?.error?.errors?.[0]?.reason || body?.error?.status || '';
    throw new Error(`Data API answered HTTP ${res.status} ${reason}`.trim());
  }
  const video = body?.items?.[0];
  if (!video) {
    throw new YouTubeUnavailableError('YouTube has no public or unlisted video with this address. It may be private or removed.');
  }
  const published = video.snippet?.publishedAt;
  return {
    title: video.snippet?.title || null,
    author: video.snippet?.channelTitle || null,
    description: video.snippet?.description || null,
    published_at: published && !isNaN(new Date(published).getTime()) ? new Date(published).toISOString() : null,
    duration: isoDurationSeconds(video.contentDetails?.duration),
  };
}

async function fetchOEmbed(videoId: string): Promise<OEmbed> {
  const url = `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(youtubeWatchUrl(videoId))}`;
  const res = await safeFetch(url, { headers: { 'User-Agent': BROWSER_UA } }, 5, HEADERS_TIMEOUT_MS);
  if (!res.ok) throw new Error(`oEmbed answered HTTP ${res.status}`);
  return (await res.json()) as OEmbed;
}

interface PageDetails {
  title: string | null;
  author: string | null;
  description: string | null;
  published_at: string | null;
  duration: number | null;
}

// A JSON string value in the page's player data, decoded. The value is read with a plain
// pattern, not by parsing the whole page (1.4 MB of HTML and script).
function jsonStringField(html: string, name: string): string | null {
  const m = html.match(new RegExp(`"${name}":"((?:[^"\\\\]|\\\\.)*)"`));
  if (!m) return null;
  try {
    return JSON.parse(`"${m[1]}"`);
  } catch {
    return null;
  }
}

async function fetchWatchPageDetails(videoId: string): Promise<PageDetails> {
  const res = await safeFetch(youtubeWatchUrl(videoId), {
    headers: {
      'User-Agent': BROWSER_UA,
      'Accept-Language': 'en',
      // Skips the EU cookie consent page, which carries none of the video's details
      Cookie: 'SOCS=CAI',
    },
  }, 5, HEADERS_TIMEOUT_MS);
  if (!res.ok) throw new Error(`watch page answered HTTP ${res.status}`);
  const html = await res.text();
  const start = html.indexOf('"videoDetails"');
  if (start < 0) throw new Error('watch page has no video details (consent page or bot check)');
  // The player data's own block, so a "title" elsewhere on the page is never taken
  const details = html.slice(start, start + 60_000);
  const length = Number(jsonStringField(details, 'lengthSeconds'));
  const published = jsonStringField(html, 'publishDate') || jsonStringField(html, 'uploadDate');
  return {
    title: jsonStringField(details, 'title'),
    author: jsonStringField(details, 'author') || jsonStringField(html, 'ownerChannelName'),
    description: jsonStringField(details, 'shortDescription'),
    published_at: published && !isNaN(new Date(published).getTime()) ? new Date(published).toISOString() : null,
    duration: Number.isFinite(length) && length > 0 ? length : null,
  };
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

export async function fetchYouTubeMetadata(videoId: string, apiKey: string | null = null): Promise<YouTubeMetadata> {
  if (apiKey) {
    try {
      const api = await fetchDataApiDetails(videoId, apiKey);
      console.log(`[YouTube] ${videoId}: data api=ok duration=${api.duration ?? 'unknown'}`);
      return {
        title: api.title,
        author: api.author,
        description: api.description?.trim() ? descriptionToHtml(api.description.trim()) : null,
        preview_picture: thumbnailFor(videoId),
        published_at: api.published_at,
        duration: api.duration,
      };
    } catch (err) {
      if (err instanceof YouTubeUnavailableError) throw err;
      console.warn(`[YouTube] ${videoId}: data api failed, using the public sources: ${(err as Error).message}`);
    }
  }
  const [oembed, page] = await Promise.all([
    fetchOEmbed(videoId).catch((err: Error) => {
      console.warn(`[YouTube] ${videoId}: ${err.message}`);
      return null;
    }),
    fetchWatchPageDetails(videoId).catch((err: Error) => {
      console.warn(`[YouTube] ${videoId}: ${err.message}`);
      return null;
    }),
  ]);
  if (!oembed && !page) {
    throw new YouTubeUnavailableError('YouTube gave no details for this video. It may be private, removed, or not a video address.');
  }
  console.log(`[YouTube] ${videoId}: oembed=${oembed ? 'ok' : 'failed'} page=${page ? 'ok' : 'failed'} duration=${page?.duration ?? 'unknown'}`);
  return {
    title: oembed?.title || page?.title || null,
    author: oembed?.author_name || page?.author || null,
    description: page?.description?.trim() ? descriptionToHtml(page.description.trim()) : null,
    preview_picture: thumbnailFor(videoId),
    published_at: page?.published_at ?? null,
    duration: page?.duration ?? null,
  };
}
