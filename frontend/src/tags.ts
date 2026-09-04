// Tag rules shared by the library, the player, the tag editor, and the Markdown export.
// Mirrors backend/src/services/tags.ts: labels are normalized the way Wallabag does it
// (trim + lowercase, no commas), the type tags are derived from the item type and never
// stored, and nosync is managed in Wallabag only.
import type { ContentItem } from './types';

export const TYPE_TAGS = ['article', 'text', 'podcast'] as const;
export const RESERVED_TAGS = new Set<string>([...TYPE_TAGS, 'nosync', '#nosync']);
export const MAX_TAG_LENGTH = 100;

export function normalizeTag(label: string): string {
  return (label || '')
    .replace(/,/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .slice(0, MAX_TAG_LENGTH)
    .trim();
}

// Why a name cannot be used as a tag, or null when it can.
export function reservedTagReason(label: string): string | null {
  const t = normalizeTag(label);
  if (!t) return null;
  if ((TYPE_TAGS as readonly string[]).includes(t)) {
    return `"${t}" is a type tag. It is set automatically from the item type.`;
  }
  if (t === 'nosync' || t === '#nosync') {
    return 'nosync can only be set in Wallabag (it stops an item from syncing).';
  }
  return null;
}

export function typeTagFor(type: ContentItem['type']): string {
  if (type === 'podcast_episode') return 'podcast';
  if (type === 'text') return 'text';
  return 'article';
}

export interface TagCount {
  tag: string;
  count: number;
}

// Every tag in use across the library with its item count, most used first,
// alphabetical within a count. Source of the picker list and the filter menu.
export function collectTagCounts(items: readonly ContentItem[]): TagCount[] {
  const counts = new Map<string, number>();
  for (const item of items) {
    for (const tag of item.tags || []) {
      counts.set(tag, (counts.get(tag) || 0) + 1);
    }
  }
  return Array.from(counts.entries())
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

// Obsidian tags cannot contain spaces or most punctuation. Spaces become hyphens,
// anything outside letters/digits/_/-// is dropped. Export-only: the stored label and
// the Wallabag label are never changed.
export function obsidianTag(label: string): string {
  return normalizeTag(label)
    .replace(/\s+/g, '-')
    .replace(/[^\p{L}\p{N}_\-/]/gu, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
}

// Parse a comma-separated tags field (Add tab input) into a clean list.
export function parseTagInput(text: string): string[] {
  const out: string[] = [];
  for (const raw of (text || '').split(',')) {
    const t = normalizeTag(raw);
    if (!t || RESERVED_TAGS.has(t) || out.includes(t)) continue;
    out.push(t);
  }
  return out;
}
