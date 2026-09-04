// Shared formatting helpers for card components (LibraryTab, FeedTab, ContentCard,
// FeedCards). These used to be duplicated per-file.

export function cleanHtml(text: string): string {
  if (!text) return '';
  // Remove CDATA wrapper
  let cleaned = text.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
  // Remove HTML tags
  cleaned = cleaned.replace(/<[^>]+>/g, ' ');
  // Decode HTML entities
  cleaned = cleaned
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
  // Clean up whitespace
  cleaned = cleaned.replace(/\s+/g, ' ').trim();
  return cleaned;
}

// "Very long" bar for the pre-generation audio warning: roughly 2x an average
// LONG article (~8-10k words ≈ 50k chars of plain text), so it fires rarely.
// Mirrors the backend scriptwriter chunking threshold in spirit (openai-tts.ts).
export const VERY_LONG_ARTICLE_CHARS = 100_000;
export function isVeryLongArticle(item: { content?: string | null }): boolean {
  return (item.content || '').length > VERY_LONG_ARTICLE_CHARS;
}

// Playback-speed toggle: the full set selectable in Settings, and the default cycle.
// The player's speed button cycles through the user's selection (setting
// 'playback_speed_options', a JSON array; blank = DEFAULT_SPEEDS).
export const SPEED_CATALOG = [0.5, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];
export const DEFAULT_SPEEDS = [1, 1.25, 1.5, 1.75, 2];
export function parseSpeedOptions(raw: string | null | undefined): number[] {
  if (!raw) return DEFAULT_SPEEDS;
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return DEFAULT_SPEEDS;
    const valid = arr
      .filter((n): n is number => typeof n === 'number' && SPEED_CATALOG.includes(n))
      .sort((a, b) => a - b);
    return valid.length > 0 ? valid : DEFAULT_SPEEDS;
  } catch {
    return DEFAULT_SPEEDS;
  }
}

// Format a playback time as m:ss (or h:mm:ss past an hour). Used by the audio players.
export function formatTime(seconds: number): string {
  if (!seconds || !isFinite(seconds)) return '0:00';

  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);

  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }
  return `${minutes}:${secs.toString().padStart(2, '0')}`;
}

export function formatDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  if (minutes < 1) {
    return `${Math.floor(seconds)}s`;
  }
  return `${minutes}m`;
}

// Cut text to a maximum length, appending '...' only when something was actually
// removed. Avoids the "New host...." look where an ellipsis is glued onto text
// that already fit.
export function truncate(text: string, max: number): string {
  if (!text || text.length <= max) return text;
  return text.slice(0, max) + '...';
}

export function getDomainFromUrl(url: string): string {
  try {
    const urlObj = new URL(url);
    return urlObj.hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

// EA Forum links are STORED pointing at the bot-friendly mirror
// (forum-bots.effectivealtruism.org) so fetching is reliable, but we show humans the normal
// forum.effectivealtruism.org link. This is display-only: it rewrites the mirror host back to
// the human host for the visible domain text and the clickable href. The stored URL is untouched
// (and the backend never fetches through this value, GraphQL uses the main host directly).
export function displayUrl(url: string): string {
  if (!url) return url;
  return url.replace('forum-bots.effectivealtruism.org', 'forum.effectivealtruism.org');
}

// archive.is and its mirror domains, all serving the same rebuilt-page markup. Kept in step
// with isArchiveMirrorUrl() in backend/src/services/article-fetcher.ts (a case in
// backend/scripts/test-markdown-export.mts fails when the two lists disagree).
const ARCHIVE_MIRROR_HOSTS = /(^|\.)archive\.(is|ph|today|li|vn|fo|md)$/i;

/**
 * The original article URL an archive.is-style address carries inside itself.
 *
 * These mirrors address a snapshot as `/<snapshot>/<original url>` (also `/newest/<url>`,
 * and `?url=<url>` when submitting), so the real address is right there in the path:
 * `https://archive.ph/2026.05.01-120000/https://www.wsj.com/x` gives `https://www.wsj.com/x`.
 * Percent-encoded targets are decoded. A short-code snapshot (`https://archive.is/aBc12`)
 * carries nothing to recover and returns null, and so does any non-archive URL.
 */
export function archivedOriginalUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (!ARCHIVE_MIRROR_HOSTS.test(u.hostname)) return null;
  const rest = u.pathname + u.search + u.hash;
  let candidate = rest.match(/https?:\/\/.+/i)?.[0];
  if (!candidate) {
    const encoded = rest.match(/https?%3A%2F%2F.+/i)?.[0];
    if (encoded) {
      try {
        candidate = decodeURIComponent(encoded);
      } catch {
        return null;
      }
    }
  }
  if (!candidate) return null;
  try {
    // A snapshot of a snapshot is not worth unwrapping further, and a target that does not
    // parse is not an address we can hand to anyone.
    const target = new URL(candidate);
    if (ARCHIVE_MIRROR_HOSTS.test(target.hostname)) return null;
  } catch {
    return null;
  }
  return candidate;
}

export interface SourceUrls {
  /** The article's own address, what a note's `source` property holds. */
  source: string | null;
  /** A second address for the SAME article, what a note's `alt-source` property holds. */
  altSource: string | null;
}

/**
 * The URL properties an export writes for an item.
 *
 * Normally there is just `source`, the stored URL in its human form. When the stored URL is
 * an archive.is-style mirror that names the original article (see archivedOriginalUrl), the
 * two swap roles: the real article becomes `source` and the mirror becomes `alt-source`, so
 * a vault note is filed under the address the article actually lives at while still
 * recording the copy Wallacast read. Both are matched when an outside tool looks an item up
 * by URL, so a note keeps resolving whichever of the two it carries. A synthetic
 * `wallacast://` address (an item that never had a URL) yields neither.
 */
export function sourceUrls(url: string | null | undefined): SourceUrls {
  if (!url || url.startsWith('wallacast://')) return { source: null, altSource: null };
  const original = archivedOriginalUrl(url);
  if (original) return { source: displayUrl(original), altSource: displayUrl(url) };
  return { source: displayUrl(url), altSource: null };
}

// Split a summary into tweet paragraphs. Prefers blank-line separation (what the summarizer is
// asked for), falling back to single newlines.
export function toTweets(text: string): string[] {
  const t = (text || '').trim();
  if (!t) return [];
  let parts = t.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);
  if (parts.length <= 1) parts = t.split(/\n+/).map(p => p.trim()).filter(Boolean);
  return parts;
}

// ---- Audio variant selection (summary audio) ----------------------------------
// One shared rule for "which audio does this item play": the "Prefer summary audio"
// mode only matters when BOTH audios exist; with a single audio, that one plays
// regardless of the mode. Used by the player (src selection), the play flow in
// App.tsx, and the queue's playability checks, so they can never disagree.

export type AudioVariant = 'original' | 'summary';

export function hasAnyAudio(item: { audio_url?: string | null; summary_audio_url?: string | null }): boolean {
  return !!item.audio_url || !!item.summary_audio_url;
}

export function getEffectiveAudio(
  item: { audio_url?: string | null; summary_audio_url?: string | null },
  preferSummaryAudio: boolean
): AudioVariant | null {
  const hasOriginal = !!item.audio_url;
  const hasSummary = !!item.summary_audio_url;
  if (hasOriginal && hasSummary) return preferSummaryAudio ? 'summary' : 'original';
  if (hasSummary) return 'summary';
  if (hasOriginal) return 'original';
  return null;
}

// NOTE: htmlToMarkdown moved to ./markdown.ts (now turndown-based, with full inline
// formatting, images, links, tables, and LLM-block/tweet callouts) and is paired
// there with markdownToHtml for the editor. Import it from '../markdown'.
