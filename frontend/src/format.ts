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

// Split a summary into tweet paragraphs. Prefers blank-line separation (what the summarizer is
// asked for), falling back to single newlines.
export function toTweets(text: string): string[] {
  const t = (text || '').trim();
  if (!t) return [];
  let parts = t.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);
  if (parts.length <= 1) parts = t.split(/\n+/).map(p => p.trim()).filter(Boolean);
  return parts;
}

// NOTE: htmlToMarkdown moved to ./markdown.ts (now turndown-based, with full inline
// formatting, images, links, tables, and LLM-block/tweet callouts) and is paired
// there with markdownToHtml for the editor. Import it from '../markdown'.
