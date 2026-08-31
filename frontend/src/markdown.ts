// Shared HTML <-> Markdown conversion for the article/text editor and "Copy content".
//
// Both directions are built on battle-tested libraries (turndown for HTML->Markdown,
// marked for Markdown->HTML) so the boring 95% (escaping, nested lists, inline
// formatting, GFM tables, images) is handled correctly. On top of that we add a few
// custom rules so Wallacast's special structures round-trip losslessly AND stay
// human-readable in Obsidian:
//
//   - LessWrong/EA Forum LLM blocks (<div class="llm-content-block" data-model-name="X">)
//     <-> Obsidian callout `> [!ai] X`
//   - Tweet embeds (<blockquote class="twitter-tweet">) <-> `> [!tweet]` callout
//   - Tables -> GFM pipe tables, images -> ![alt](url) (standard, Obsidian-native)
//   - Footnotes (LessWrong/EA Forum `#fnXXX`, Substack `#footnote-N`) <-> Markdown
//     `[^n]` references and `[^n]: ...` definitions (renumbered 1..N, back-links dropped)
//   - Anything else we don't recognize (iframes, figures with captions/width) is KEPT as
//     raw HTML so no information is silently dropped, and Obsidian renders raw HTML too.
//
// Because the SAME functions power both the editor and "Copy content", what you copy is
// exactly what you'd see in the editor.

import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';
import { marked } from 'marked';
import type { ContentItem, Comment } from './types';
import { cleanHtml, displayUrl, formatDuration } from './format';
import { obsidianTag, typeTagFor } from './tags';

// Prefix every line of a block with the Markdown blockquote marker `> ` (used for callouts).
function quoteLines(text: string): string {
  return text.split('\n').map((l) => (l ? '> ' + l : '>')).join('\n');
}

function buildTurndown(): TurndownService {
  const td = new TurndownService({
    headingStyle: 'atx', // # Heading (not underline style)
    codeBlockStyle: 'fenced', // ```code``` (not indented)
    bulletListMarker: '-',
    emDelimiter: '*',
    hr: '---',
  });

  // GFM: tables, strikethrough, task lists.
  td.use(gfm);

  // LLM content block -> Obsidian callout. The callout title is the model name verbatim,
  // so it round-trips back into data-model-name exactly.
  td.addRule('llmContentBlock', {
    filter: (node) =>
      node.nodeName === 'DIV' &&
      typeof (node as HTMLElement).className === 'string' &&
      (node as HTMLElement).classList.contains('llm-content-block'),
    replacement: (content, node) => {
      const model = ((node as HTMLElement).getAttribute('data-model-name') || '').trim();
      const header = `[!ai]${model ? ' ' + model : ''}`;
      const body = content.trim();
      return '\n\n' + quoteLines([header, '', body].join('\n')) + '\n\n';
    },
  });

  // Tweet embed -> [!tweet] callout. `content` already holds the tweet text plus the
  // status link converted to Markdown, so the URL is preserved.
  td.addRule('tweetEmbed', {
    filter: (node) =>
      node.nodeName === 'BLOCKQUOTE' &&
      typeof (node as HTMLElement).className === 'string' &&
      (node as HTMLElement).classList.contains('twitter-tweet'),
    replacement: (content) => {
      const body = content.trim();
      return '\n\n' + quoteLines(['[!tweet]', '', body].join('\n')) + '\n\n';
    },
  });

  // Keep structures with no clean Markdown equivalent as raw HTML islands (no data loss).
  td.keep(['iframe', 'sup', 'sub', 'kbd', 'video', 'audio']);

  // Keep figures as raw HTML islands when they carry a caption or an explicit width. Both
  // are things Markdown can't faithfully express (a `<figcaption>`, or a percentage width on
  // the `<figure>`, e.g. LessWrong's `image_resized` / `style="width:20.8%"`). A bare
  // `<figure><img></figure>` with neither still converts to a plain Markdown image.
  td.keep((node) => {
    const el = node as HTMLElement;
    if (el.nodeName !== 'FIGURE') return false;
    const hasWidth =
      /width\s*:/i.test(el.getAttribute('style') || '') ||
      (el.getAttribute('class') || '').includes('image_resized');
    const hasCaption = !!el.querySelector('figcaption');
    return hasWidth || hasCaption;
  });

  // Images: emit Obsidian's `![alt|WIDTH](src)` when a bare image has an explicit pixel
  // width, so it keeps its size through the round-trip (standard Markdown can't carry width).
  td.addRule('imageWithWidth', {
    filter: 'img',
    replacement: (_content, node) => {
      const el = node as HTMLElement;
      const src = el.getAttribute('src') || '';
      if (!src) return '';
      const alt = (el.getAttribute('alt') || '').replace(/\n/g, ' ');
      const width = imageWidth(el);
      const label = width ? `${alt}|${width}` : alt;
      return `![${label}](${src})`;
    },
  });

  return td;
}

// Read an integer pixel width from an <img>'s width attribute or inline style. Returns null
// when there's no explicit width (or it's a percentage).
function imageWidth(el: HTMLElement): number | null {
  const attr = el.getAttribute('width');
  if (attr && /^\d+$/.test(attr.trim())) return parseInt(attr.trim(), 10);
  const style = el.getAttribute('style') || '';
  const m = style.match(/(?:^|;)\s*width\s*:\s*(\d+)px/i);
  if (m) return parseInt(m[1], 10);
  return null;
}

const turndownService = buildTurndown();

/**
 * Convert article/comment HTML into readable Markdown (Obsidian-friendly).
 * Preserves headings, lists, blockquotes, bold/italic, links, images, tables, code,
 * and Wallacast's LLM blocks / tweet embeds (as callouts).
 */
export function htmlToMarkdown(html: string): string {
  if (!html) return '';
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const footnotes = extractFootnotes(doc);
  let md = turndownService.turndown(doc.body.innerHTML).trim();
  // Turn the inline marker tokens left by extractFootnotes into `[^n]`.
  md = md.replace(/XWCFNREFX(\d+)X/g, (_m, n) => `[^${n}]`);
  if (footnotes.length > 0) {
    md = md.trim() + '\n\n' + footnotes
      .map((f) => {
        // Every line after the first gets the standard 4-space indent so it stays part
        // of the footnote (blank separator lines stay blank).
        const [first, ...rest] = f.body.split('\n');
        const cont = rest.map((l) => (l.trim() ? '    ' + l : '')).join('\n');
        return `[^${f.n}]: ${first}` + (rest.length > 0 ? '\n' + cont : '');
      })
      .join('\n\n');
  }
  return md.trim();
}

interface ExtractedFootnote {
  n: number;
  body: string;
}

// Convert article footnotes into Markdown footnote syntax. Handles LessWrong/EA Forum
// (`<sup><a href="#fnXXX">[1]</a></sup>` + an `<ol>` of definitions with `^` back-links) and
// Substack (`<a href="#footnote-1">1</a>` + `#footnote-anchor-1` back-links). MUTATES `doc`:
// each inline marker becomes a token (the caller swaps it for `[^n]`), and the definition
// elements are removed and returned so the caller can append `[^n]: ...` lines. References are
// renumbered 1..N by first appearance; back-reference carets are dropped.
function extractFootnotes(doc: Document): ExtractedFootnote[] {
  const isForwardRef = (href: string | null): boolean =>
    !!href && /^#(fn(?!ref)|footnote-(?!anchor))/i.test(href);

  const markers = Array.from(doc.querySelectorAll('a[href^="#"]')).filter((a) =>
    isForwardRef(a.getAttribute('href'))
  );
  if (markers.length === 0) return [];

  const targetToNum = new Map<string, number>();
  const order: Array<{ id: string; n: number }> = [];
  let counter = 0;

  for (const a of markers) {
    const id = decodeURIComponent((a.getAttribute('href') || '').slice(1));
    if (!id) continue;
    if (!targetToNum.has(id)) {
      targetToNum.set(id, ++counter);
      order.push({ id, n: counter });
    }
    const n = targetToNum.get(id)!;
    // Replace the whole <sup> wrapper if it only holds this marker, else just the <a>.
    const sup = a.closest('sup');
    const toReplace = sup && (sup.textContent || '').trim() === (a.textContent || '').trim() ? sup : a;
    toReplace.parentNode?.replaceChild(doc.createTextNode(`XWCFNREFX${n}X`), toReplace);
  }

  const footnotes: ExtractedFootnote[] = [];
  const parents = new Set<Element>();

  for (const { id, n } of order) {
    const def = doc.getElementById(id);
    if (!def) continue;
    // Drop back-reference links (and their <sup> wrappers).
    def.querySelectorAll('a[href^="#fnref"], a[href^="#footnote-anchor"]').forEach((back) => {
      const sup = back.closest('sup');
      (sup && (sup.textContent || '').trim() === (back.textContent || '').trim() ? sup : back).remove();
    });
    // Keep the block structure (multi-paragraph footnotes are real); just tame extra blanks.
    // The old `\s+ -> ' '` collapse flattened every footnote to one line, which destroyed
    // multi-paragraph footnotes on each edit round-trip.
    let body = turndownService.turndown(def.innerHTML).trim();
    body = body.replace(/^[\^↩\s]+/, '').replace(/[↩\s]+$/, '').replace(/\n{3,}/g, '\n\n').trim();
    footnotes.push({ n, body });
    if (def.parentElement) parents.add(def.parentElement);
    def.remove();
  }

  // Remove now-empty footnote containers (the <ol>, and a wrapping footnotes section).
  parents.forEach((p) => {
    if (p.childElementCount === 0) {
      const gp = p.parentElement;
      p.remove();
      // The canonical section is `<section class="footnotes"><hr><ol>…</ol></section>`.
      // With the <ol> gone, a leftover lone <hr> would round-trip into a stray `---`
      // at the end of the body (and accumulate one more per edit), so treat a section
      // whose only remains are <hr>s as empty.
      if (gp && /footnote/i.test(gp.className || '')) {
        const meaningful = Array.from(gp.children).filter((c) => c.tagName !== 'HR');
        if (meaningful.length === 0) gp.remove();
      }
    }
  });

  return footnotes.sort((a, b) => a.n - b.n);
}

/**
 * Convert Markdown back into the cleaned HTML we store in `html_content`.
 * Reconstructs `[!ai]` / `[!tweet]` callouts into the structures the player renders,
 * and strips <script>/<style> as a safety guard (the backend strips again on save).
 */
export function markdownToHtml(markdown: string): string {
  if (!markdown) return '';

  let md = markdown;

  // Footnotes: pull out the `[^k]: body` definitions, then turn inline `[^k]` references into
  // <sup> links. Rendered back as one canonical, clickable footnote section at the end (ids
  // `fn-k` / `fnref-k`: recognized by the player's footnote click handler).
  //
  // A definition is NOT just its first line: standard Markdown continues a footnote with
  // 4-space (or tab) indented blocks, plus lazy unindented lines directly under the marker.
  // Leaving those behind made marked render them as indented CODE BLOCKS stranded above
  // the footnotes section, so we walk lines and consume the whole definition.
  const footnoteDefs = new Map<string, string>();
  {
    const lines = md.split('\n');
    const kept: string[] = [];
    let i = 0;
    while (i < lines.length) {
      const def = lines[i].match(/^[ \t]*\[\^([^\]]+)\]:[ \t]?(.*)$/);
      if (!def) {
        kept.push(lines[i]);
        i++;
        continue;
      }
      const bodyLines: string[] = [(def[2] || '').trim()];
      i++;
      // Lazy continuation: unindented non-blank lines right below the marker still belong
      // to the first paragraph (standard Markdown), until a blank line or a new definition.
      while (
        i < lines.length &&
        lines[i].trim() !== '' &&
        !/^[ \t]*\[\^[^\]]+\]:/.test(lines[i]) &&
        !/^(?: {4}|\t)/.test(lines[i])
      ) {
        bodyLines.push(lines[i].trim());
        i++;
      }
      // Indented continuation: 4-space/tab blocks belong to this footnote; blank lines
      // between them are kept as paragraph breaks (but only when more continuation follows).
      while (i < lines.length) {
        if (/^(?: {4}|\t)/.test(lines[i])) {
          bodyLines.push(lines[i].replace(/^(?: {4}|\t)/, ''));
          i++;
        } else if (lines[i].trim() === '') {
          let j = i + 1;
          while (j < lines.length && lines[j].trim() === '') j++;
          if (j < lines.length && /^(?: {4}|\t)/.test(lines[j])) {
            bodyLines.push('');
            i = j;
          } else {
            break;
          }
        } else {
          break;
        }
      }
      footnoteDefs.set(String(def[1]).trim(), bodyLines.join('\n').trim());
    }
    md = kept.join('\n');
  }
  if (footnoteDefs.size > 0) {
    md = md.replace(/\[\^([^\]]+)\]/g, (whole, key) => {
      const k = String(key).trim();
      if (!footnoteDefs.has(k)) return whole;
      return `<sup class="footnote-ref" id="fnref-${k}"><a href="#fn-${k}">[${k}]</a></sup>`;
    });
  }

  let rawHtml = marked.parse(md, { gfm: true, async: false }) as string;

  if (footnoteDefs.size > 0) {
    const items = Array.from(footnoteDefs.entries())
      .map(([key, body]) => {
        const backref = ` <a href="#fnref-${key}" class="footnote-backref" aria-label="Back to content">↩</a>`;
        // Multi-block bodies (paragraphs, rules, lists) need block parsing; the backref
        // tucks inside the last paragraph so it doesn't sit alone on its own line.
        if (/\n\s*\n/.test(body)) {
          const parsed = (marked.parse(body, { gfm: true, async: false }) as string).trim();
          const inner = /<\/p>$/.test(parsed) ? parsed.replace(/<\/p>$/, `${backref}</p>`) : parsed + backref;
          return `<li id="fn-${key}">${inner}</li>`;
        }
        return `<li id="fn-${key}">${marked.parseInline(body, { async: false }) as string}${backref}</li>`;
      })
      .join('');
    rawHtml += `<section class="footnotes"><hr><ol>${items}</ol></section>`;
  }

  const doc = new DOMParser().parseFromString(rawHtml, 'text/html');

  // Obsidian image-resize syntax: marked renders `![alt|200](url)` with alt="alt|200".
  // Split the trailing `|width` back out into a width attribute so narrow images keep size.
  doc.querySelectorAll('img').forEach((img) => {
    const alt = img.getAttribute('alt') || '';
    const m = alt.match(/^(.*)\|(\d+)$/);
    if (m) {
      img.setAttribute('alt', m[1]);
      img.setAttribute('width', m[2]);
    }
  });

  // Turn callout blockquotes back into their original structures.
  doc.querySelectorAll('blockquote').forEach((bq) => {
    const firstP = bq.querySelector(':scope > p');
    if (!firstP) return;

    const text = (firstP.textContent || '').trim();
    // Only single-line marker paragraphs (our emitter always puts the marker on its own
    // line via a blank callout line). A merged multi-line first paragraph is left as a
    // normal blockquote rather than risk mis-parsing.
    if (/\n/.test(text)) return;

    const m = text.match(/^\[!(\w+)\]\+?\s*(.*)$/);
    if (!m) return;

    const type = m[1].toLowerCase();
    const title = (m[2] || '').trim();

    if (type === 'ai') {
      const div = doc.createElement('div');
      div.className = 'llm-content-block';
      if (title) div.setAttribute('data-model-name', title);
      // Move every child except the marker paragraph into the new div.
      Array.from(bq.childNodes).forEach((ch) => {
        if (ch !== firstP) div.appendChild(ch);
      });
      bq.replaceWith(div);
    } else if (type === 'tweet') {
      bq.className = 'twitter-tweet';
      firstP.remove(); // drop the [!tweet] marker line
    }
  });

  doc.querySelectorAll('script, style').forEach((el) => el.remove());

  return doc.body.innerHTML.trim();
}

// ---------------------------------------------------------------------------
// Markdown export with Obsidian properties (YAML frontmatter), and the reverse
// ---------------------------------------------------------------------------

function yamlStr(s: string): string {
  // A JSON string literal is a valid YAML double-quoted scalar, escapes included.
  return JSON.stringify(s.replace(/\s+/g, ' ').trim());
}

function isoDate(value?: string | null): string | null {
  if (!value) return null;
  const d = new Date(value);
  return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

/**
 * The Obsidian-properties block for an item. Only keys Obsidian understands natively get
 * special treatment (`tags` is a real tag list, ISO dates become Date properties); the rest
 * are plain text. The first tag is always the item's type tag (article / text / podcast).
 * `source` is the human URL (the EA Forum bot mirror is rewritten back), never a synthetic
 * `wallacast://` one. No internal ids: an import creates a NEW item, it never overwrites.
 */
export function buildFrontmatter(item: ContentItem, comments: Comment[]): string {
  const out: string[] = ['---'];
  out.push(`title: ${yamlStr(item.title || '')}`);
  if (item.author) out.push(`author: ${yamlStr(item.author)}`);
  if (item.type === 'podcast_episode' && item.podcast_show_name) {
    out.push(`show: ${yamlStr(item.podcast_show_name)}`);
  }
  if (item.url && !item.url.startsWith('wallacast://')) {
    out.push(`source: ${yamlStr(displayUrl(item.url))}`);
  }
  const published = isoDate(item.published_at);
  if (published) out.push(`published: ${published}`);
  const tags = [typeTagFor(item.type)];
  for (const t of item.tags || []) {
    const o = obsidianTag(t);
    if (o && !tags.includes(o)) tags.push(o);
  }
  out.push('tags:');
  for (const t of tags) out.push(`  - ${t}`);
  // A podcast's description IS the body (see contentToMarkdown), so no property for it.
  if (item.type !== 'podcast_episode' && item.description) {
    const d = cleanHtml(item.description).replace(/\s+/g, ' ').trim();
    if (d) out.push(`description: ${yamlStr(d)}`);
  }
  if (item.type === 'podcast_episode' && item.duration) {
    out.push(`duration: ${yamlStr(formatDuration(item.duration))}`);
  }
  if (item.karma !== undefined && item.karma !== null) out.push(`upvotes: ${item.karma}`);
  const commentCount = item.comment_count || comments.length;
  if (commentCount > 0) out.push(`comments: ${commentCount}`);
  out.push('---');
  return out.join('\n');
}

export interface Frontmatter {
  meta: Record<string, string | string[]>;
  body: string; // the Markdown after the closing ---
}

function unquoteYaml(raw: string): string {
  const s = raw.trim();
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    try {
      return JSON.parse(s);
    } catch {
      return s.slice(1, -1);
    }
  }
  if (s.length >= 2 && s.startsWith("'") && s.endsWith("'")) {
    return s.slice(1, -1).replace(/''/g, "'");
  }
  return s;
}

/**
 * Read a leading YAML frontmatter block (the subset Obsidian writes: `key: value` scalars,
 * `key:` + `  - item` lists, inline `[a, b]` lists). Keys are lowercased. Returns null when
 * the text does not start with a `---` block, so callers can treat it as plain Markdown.
 */
export function parseFrontmatter(markdown: string): Frontmatter | null {
  const m = markdown.match(/^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  if (!m) return null;
  const meta: Record<string, string | string[]> = {};
  let listKey: string | null = null;
  for (const line of m[1].split(/\r?\n/)) {
    const li = line.match(/^\s+-\s*(.*)$/);
    if (li && listKey) {
      (meta[listKey] as string[]).push(unquoteYaml(li[1]));
      continue;
    }
    const kv = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1].toLowerCase();
    const val = kv[2].trim();
    if (val === '') {
      meta[key] = [];
      listKey = key;
      continue;
    }
    listKey = null;
    if (val.startsWith('[') && val.endsWith(']')) {
      meta[key] = val.slice(1, -1).split(',').map((s) => unquoteYaml(s)).filter(Boolean);
      continue;
    }
    meta[key] = unquoteYaml(val);
  }
  return { meta, body: markdown.slice(m[0].length) };
}

/** Drop a first-line `# Title` that repeats the given title (an export puts one there). */
export function stripLeadingTitle(body: string, title: string): string {
  const m = body.match(/^\s*#\s+(.+?)\s*\r?\n/);
  if (!m) return body;
  if (m[1].trim().toLowerCase() !== (title || '').trim().toLowerCase()) return body;
  return body.slice(m[0].length).replace(/^\s*\n/, '');
}

/**
 * The reverse of the summary blocks contentToMarkdown emits: when the text (after the
 * properties block) STARTS with a fenced code block, that block is the summary, and a
 * fenced block right after it whose first line is "Comments summary:" is the comment
 * summary. Any label is accepted (the user picks it in Settings), so callers should only
 * use this on text that had a properties block, which is what makes a leading code block
 * unambiguous. Returns the text with the blocks removed.
 */
export function splitExportedSummary(markdown: string): { body: string; summary?: string; comment_summary?: string } {
  const FENCE_RE = /^\s*(`{3,})[^\n]*\n([\s\S]*?)\n\1[ \t]*(?:\r?\n|$)/;
  let rest = markdown;
  const first = rest.match(FENCE_RE);
  if (!first) return { body: markdown };
  const summary = first[2].trim();
  if (!summary) return { body: markdown };
  rest = rest.slice(first[0].length);
  let comment_summary: string | undefined;
  const second = rest.match(FENCE_RE);
  if (second && second[2].trimStart().startsWith(COMMENT_SUMMARY_MARKER)) {
    comment_summary = second[2].trimStart().slice(COMMENT_SUMMARY_MARKER.length).trim() || undefined;
    rest = rest.slice(second[0].length);
  }
  return { body: rest.replace(/^\s*\n/, ''), summary, comment_summary };
}

const COMMENT_HEADER_RE = /^\*\*(.+?)\*\*$/;
const COMMENTS_HEADING_RE = /^## Comments(?: \(\d+\))?[ \t]*$/m;

// Parse one exported comment header line ("**name • 12 points • 14/03/2026**").
function parseCommentHeader(text: string): Comment | null {
  const m = text.trim().match(COMMENT_HEADER_RE);
  if (!m) return null;
  const parts = m[1].split(' • ').map((p) => p.trim());
  const username = parts.shift() || '';
  if (!username) return null;
  const c: Comment = { username, content: '' };
  for (const p of parts) {
    const pts = p.match(/^(-?\d+) points?$/);
    if (pts) {
      c.karma = parseInt(pts[1], 10);
      continue;
    }
    const gb = p.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    if (gb) {
      c.date = `${gb[3]}-${gb[2]}-${gb[1]}`;
      continue;
    }
    if (/^\d{4}-\d{2}-\d{2}/.test(p)) c.date = p;
  }
  return c;
}

function stripQuoteMarkers(line: string): { depth: number; text: string } {
  let depth = 0;
  let text = line;
  for (;;) {
    const m = text.match(/^>[ ]?/);
    if (!m) break;
    depth++;
    text = text.slice(m[0].length);
  }
  return { depth, text };
}

// One top-level comment block (between `---` separators): the root comment plus its
// replies, which the export nests as `> ` quotes one level per depth. A reply starts
// wherever a header line appears at a deeper quote level; lines that are not headers
// belong to the comment currently open at their level (extra `>` markers are kept, so a
// quote inside a comment survives).
function parseCommentBlock(block: string): Comment[] {
  interface Node { depth: number; comment: Comment; lines: string[] }
  const roots: Comment[] = [];
  const stack: Node[] = [];
  const finish = (node: Node) => {
    node.comment.content = markdownToHtml(node.lines.join('\n').trim());
  };
  for (const raw of block.split('\n')) {
    const { depth, text } = stripQuoteMarkers(raw);
    const header = parseCommentHeader(text);
    if (header) {
      while (stack.length > 0 && stack[stack.length - 1].depth >= depth) finish(stack.pop()!);
      const parent = stack.length > 0 ? stack[stack.length - 1].comment : null;
      if (parent) (parent.replies ||= []).push(header);
      else roots.push(header);
      stack.push({ depth, comment: header, lines: [] });
      continue;
    }
    if (stack.length === 0) continue; // text before any header: not a comment
    const node = stack[stack.length - 1];
    const extra = Math.max(0, depth - node.depth);
    node.lines.push(('> '.repeat(extra) + text).trimEnd());
  }
  while (stack.length > 0) finish(stack.pop()!);
  return roots;
}

/**
 * Split an exported "## Comments" section back into structured comments (the reverse of
 * contentToMarkdown's comment rendering), so an imported export gets real comments again:
 * shown in the Comments area, counted on the card, and narrated. When the section does
 * not parse as our format, it is left in the body untouched and no comments are returned.
 */
export function splitExportedComments(markdown: string): { body: string; comments: Comment[] } {
  const idx = markdown.search(COMMENTS_HEADING_RE);
  if (idx < 0) return { body: markdown, comments: [] };
  const section = markdown.slice(idx).replace(/^## Comments(?: \(\d+\))?[ \t]*\r?\n?/, '');
  const comments = section
    .split(/\r?\n[ \t]*---[ \t]*\r?\n/)
    .flatMap((block) => parseCommentBlock(block.replace(/\r/g, '')));
  if (comments.length === 0) return { body: markdown, comments: [] };
  return { body: markdown.slice(0, idx).trimEnd(), comments };
}

// Readable Markdown export of an item: Obsidian properties, title, body, comments.
// What Ctrl+A/Ctrl+C *should* give you without the app chrome. Powers the
// "Copy content" action in both the fullscreen player and the library dropdown.
// Needs the FULL item (html_content/transcript), the list payload is not enough.
// The byline/link that used to sit under the title now live in the frontmatter, so
// an import of this text round-trips them as fields instead of body paragraphs.
export interface CopyContentOptions {
  // Put the item's summary at the very top, right under the properties block and before
  // the title, inside a fenced code block. `summaryCodeLabel` is the text after the
  // opening backticks (some Obsidian plugins style blocks by it); empty = a plain block.
  includeSummary?: boolean;
  summaryCodeLabel?: string;
  // Also the comment summary, as a second block right after (default true; only used
  // when includeSummary is on).
  includeCommentSummary?: boolean;
  // Append the "## Comments" section (default true).
  includeComments?: boolean;
}

const COMMENT_SUMMARY_MARKER = 'Comments summary:';

function fencedBlock(label: string, body: string): string {
  // A body that itself contains a triple backtick would end the fence early, so use a
  // longer fence in that case (CommonMark allows any length >= 3).
  const longest = Math.max(2, ...Array.from(body.matchAll(/`{3,}/g), (m) => m[0].length));
  const fence = '`'.repeat(longest + 1);
  return `${fence}${label.trim()}\n${body.trim()}\n${fence}`;
}

export function contentToMarkdown(item: ContentItem, comments: Comment[], opts: CopyContentOptions = {}): string {
  const lines: string[] = [buildFrontmatter(item, comments)];

  // Summary blocks sit at the very top, between the properties and the title.
  if (opts.includeSummary && item.summary?.trim()) {
    const label = opts.summaryCodeLabel || '';
    lines.push('', fencedBlock(label, item.summary));
    if (opts.includeCommentSummary !== false && item.comment_summary?.trim()) {
      lines.push('', fencedBlock(label, `${COMMENT_SUMMARY_MARKER}\n\n${item.comment_summary.trim()}`));
    }
  }

  lines.push('', `# ${item.title}`);

  // Podcasts: description first, then the transcript, each only when present
  // (the `content` field is deliberately not used for podcasts). Articles/texts
  // keep the html_content body with the plain-content fallback.
  const body = item.type === 'podcast_episode'
    ? [
        item.description ? htmlToMarkdown(item.description) : '',
        item.transcript ? `## Transcript\n\n${item.transcript.trim()}` : '',
      ].filter(part => part.trim()).map(part => part.trim()).join('\n\n')
    : item.html_content
      ? htmlToMarkdown(item.html_content)
      : (item.content || '');
  if (body.trim()) lines.push('', body.trim());

  if (opts.includeComments !== false && comments.length > 0) {
    const renderComment = (c: Comment, depth: number): string => {
      const head: string[] = [c.username];
      if (c.karma !== undefined && c.karma !== null) head.push(`${c.karma} points`);
      if (c.date) head.push(new Date(c.date).toLocaleDateString('en-GB'));
      const block = `**${head.join(' • ')}**\n\n${htmlToMarkdown(c.content)}`;
      // Replies become nested Markdown quotes
      const prefixed = depth > 0
        ? block.split('\n').map(l => `${'>'.repeat(depth)} ${l}`.trimEnd()).join('\n')
        : block;
      const replies = (c.replies || []).map(r => renderComment(r, depth + 1));
      return [prefixed, ...replies].join('\n\n');
    };
    lines.push('', `## Comments (${item.comment_count || comments.length})`, '');
    lines.push(comments.map(c => renderComment(c, 0)).join('\n\n---\n\n'));
  }

  return lines.join('\n');
}
