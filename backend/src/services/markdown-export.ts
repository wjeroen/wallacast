import { JSDOM } from 'jsdom';
import { query } from '../database/db.js';
import { withAudioToken } from './audio-token.js';
import { setHtmlParser, contentToMarkdown, type CopyContentOptions } from '../shared/markdown.js';
import { cleanHtml } from '../shared/format.js';
import type { ContentItem, Comment } from '../shared/types.js';

/**
 * "Copy content" as a server-side function, for the Markdown endpoints in routes/content.ts.
 *
 * The conversion itself is the frontend's `contentToMarkdown` running unchanged: the files
 * in backend/src/shared/ are byte-identical copies of frontend/src/{markdown,format,tags,
 * types}.ts (backend/scripts/test-markdown-export.mts fails when a copy drifts). The only
 * things this module supplies are what the browser has and Node lacks: an HTML parser
 * (jsdom's DOMParser), the user's copy settings, and the item row in the shape GET /:id
 * serves.
 *
 * Same item, same settings, byte-identical output to the Copy content button. That is the
 * contract the Obsidian import relies on. One known exception: comment dates are printed
 * with `toLocaleDateString('en-GB')`, which uses the clock zone of whoever renders, so a
 * comment posted within a few hours of midnight UTC can show the neighbouring day here
 * compared with a browser in another zone.
 */

// jsdom stands in for the browser's DOMParser. One parser for the whole process, installed
// once at import time, before the first conversion can run.
setHtmlParser(new (new JSDOM('').window.DOMParser)());

/** The four "Copy & export" settings, with the same defaults as frontend/src/copy-settings.ts. */
export const COPY_SETTING_KEYS = [
  'copy_include_summary',
  'copy_include_comment_summary',
  'copy_summary_code_label',
  'copy_include_comments',
] as const;

/** Map raw setting values to CopyContentOptions. Mirrors frontend/src/copy-settings.ts. */
export function copyOptionsFromSettings(s: Record<string, string | null | undefined>): CopyContentOptions {
  return {
    includeSummary: s.copy_include_summary === 'true',
    includeCommentSummary: s.copy_include_comment_summary !== 'false',
    summaryCodeLabel: (s.copy_summary_code_label || '').trim(),
    includeComments: s.copy_include_comments !== 'false',
  };
}

export async function loadCopyContentOptions(userId: number): Promise<CopyContentOptions> {
  const r = await query(
    'SELECT setting_key, setting_value FROM user_settings WHERE user_id = $1 AND setting_key = ANY($2::text[])',
    [userId, [...COPY_SETTING_KEYS]]
  );
  const map: Record<string, string | null> = {};
  for (const row of r.rows) map[row.setting_key] = row.setting_value;
  return copyOptionsFromSettings(map);
}

/**
 * The columns Copy content reads, plus the small fields the Markdown endpoints echo back.
 * Never audio_data, and none of the read-along columns (content_alignment, tts_chunks).
 */
export const MARKDOWN_ITEM_COLUMNS =
  'id, type, title, url, content, html_content, author, description, audio_url, transcript, ' +
  'transcript_words, duration, podcast_id, podcast_show_name, published_at, is_starred, ' +
  'is_archived, tags, created_at, updated_at, karma, comments, summary, comment_summary, ' +
  'summary_status, summary_audio_url, COALESCE(comment_count_total, 0) AS comment_count';

/** The comments column as the array Copy content expects. Mirrors the frontend's
 *  parsedComments: a JSONB array, a JSON string, or nothing. */
export function parseComments(raw: unknown): Comment[] {
  if (!raw) return [];
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Render one item row (MARKDOWN_ITEM_COLUMNS) exactly as the Copy content button would. */
export function renderItemMarkdown(row: Record<string, unknown>, opts: CopyContentOptions): string {
  // withAudioToken first, so the item carries the same audio_url the browser sees.
  const item = withAudioToken(row as unknown as ContentItem);
  return contentToMarkdown(item, parseComments(row.comments), opts);
}

/**
 * The description as the library index sends it: HTML stripped (the same cleanHtml the
 * frontmatter uses), then cut to `max` characters. The route reads only the first 1500
 * characters of the column, so a cut-off opening tag at the end is dropped before cleaning.
 */
export function shortDescription(raw: string | null | undefined, max = 300): string | null {
  if (!raw) return null;
  const text = cleanHtml(raw.replace(/<[^>]*$/, ''));
  if (!text) return null;
  return text.length > max ? text.slice(0, max) : text;
}

/**
 * The file name of an item inside a bulk Copy content zip: the title with the characters
 * Windows, macOS and Obsidian refuse in a file name taken out (`\ / : * ? " < > |`, plus
 * `# ^ [ ]`, which break Obsidian links), control characters and whitespace collapsed,
 * trailing dots dropped (illegal on Windows), capped at 120 characters. Unicode letters
 * stay, so "Café" is still "Café". Matches the link names the Obsidian inbox builds from
 * the same titles.
 */
export function markdownFileName(title: string | null | undefined): string {
  const cleaned = (title || '')
    .replace(/[\/:*?"<>|#^\[\]]/g, ' ')
    .replace(/\p{Cc}/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\.+$/, '')
    .trim();
  const base = (cleaned || 'Untitled').slice(0, 120).trim();
  return `${base}.md`;
}

/**
 * Make a file name unique within one zip: the second "Title.md" becomes "Title (2).md", the
 * third "Title (3).md". Compared case-insensitively, because most file systems are.
 * `used` is the set of lower-cased names already handed out, updated in place.
 */
export function uniqueFileName(name: string, used: Set<string>): string {
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  let candidate = name;
  for (let n = 2; used.has(candidate.toLowerCase()); n++) candidate = `${stem} (${n})${ext}`;
  used.add(candidate.toLowerCase());
  return candidate;
}
