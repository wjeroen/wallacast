import { safeFetch } from './url-guard.js';
import { youtubeWatchUrl } from '../shared/format.js';

// What an added YouTube video is stored with. Two public sources, read once when the video
// is added, never for playback (the app plays the video in YouTube's embedded player):
// - oEmbed, YouTube's public lookup that needs no key: title, channel, thumbnail.
// - The watch page, the same page the article fetcher used to read for these addresses:
//   length, publish date and the description. Best effort: a consent page or a bot check
//   leaves these empty, and the player then fills the length on first play.

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

export async function fetchYouTubeMetadata(videoId: string): Promise<YouTubeMetadata> {
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
    // 16:9 without the black bars hqdefault.jpg adds
    preview_picture: `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`,
    published_at: page?.published_at ?? null,
    duration: page?.duration ?? null,
  };
}
