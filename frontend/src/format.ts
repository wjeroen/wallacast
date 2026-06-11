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

export function formatDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  return `${minutes}m`;
}

export function getDomainFromUrl(url: string): string {
  try {
    const urlObj = new URL(url);
    return urlObj.hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
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

// Convert article HTML to readable Markdown-ish plain text (used by "Copy
// content"). Walks block elements: headings → #, lists → -, blockquotes → >,
// code → fenced. Images and other chrome are dropped.
export function htmlToMarkdown(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const out: string[] = [];

  const inlineText = (el: Element): string =>
    (el.textContent || '').replace(/\s+/g, ' ').trim();

  const hasBlockChildren = (el: Element): boolean =>
    Array.from(el.children).some(c =>
      /^(H[1-6]|P|UL|OL|LI|BLOCKQUOTE|PRE|DIV|SECTION|ARTICLE|FIGURE|TABLE)$/.test(c.tagName));

  const walk = (el: Element) => {
    const tag = el.tagName;
    if (/^H[1-6]$/.test(tag)) {
      const t = inlineText(el);
      if (t) out.push('#'.repeat(Number(tag[1])) + ' ' + t);
    } else if (tag === 'P') {
      const t = inlineText(el);
      if (t) out.push(t);
    } else if (tag === 'LI') {
      const t = inlineText(el);
      if (t) out.push('- ' + t);
    } else if (tag === 'PRE') {
      const t = (el.textContent || '').trim();
      if (t) out.push('```\n' + t + '\n```');
    } else if (tag === 'BLOCKQUOTE') {
      const inner: string[] = [];
      const prev = out.length;
      Array.from(el.children).forEach(walk);
      // Move whatever the children produced into a quoted block
      inner.push(...out.splice(prev));
      const t = inner.length > 0 ? inner.join('\n\n') : inlineText(el);
      if (t) out.push(t.split('\n').map(l => '> ' + l).join('\n'));
    } else if (tag === 'IMG' || tag === 'SCRIPT' || tag === 'STYLE') {
      // skip
    } else if (hasBlockChildren(el)) {
      Array.from(el.children).forEach(walk);
    } else {
      const t = inlineText(el);
      if (t) out.push(t);
    }
  };

  Array.from(doc.body.children).forEach(walk);
  return out.join('\n\n');
}
