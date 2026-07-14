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
import { displayUrl } from './format';

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

// Readable Markdown export of an item (title, meta line, link, body, comments).
// What Ctrl+A/Ctrl+C *should* give you without the app chrome. Powers the
// "Copy content" action in both the fullscreen player and the library dropdown.
// Needs the FULL item (html_content/transcript), the list payload is not enough.
export function contentToMarkdown(item: ContentItem, comments: Comment[]): string {
  const lines: string[] = [`# ${item.title}`];
  const meta: string[] = [];
  if (item.author) meta.push(`By ${item.author}`);
  if (item.type === 'podcast_episode' && item.podcast_show_name) meta.push(item.podcast_show_name);
  if (item.published_at) meta.push(new Date(item.published_at).toLocaleDateString('en-GB'));
  if (item.karma !== undefined && item.karma !== null) meta.push(`${item.karma} upvotes`);
  if (meta.length > 0) lines.push(meta.join(' • '));
  if (item.url) lines.push(displayUrl(item.url));

  const body = item.html_content
    ? htmlToMarkdown(item.html_content)
    : item.type === 'podcast_episode' && item.transcript
      ? item.transcript
      : (item.content || '');
  if (body.trim()) lines.push('', body.trim());

  if (comments.length > 0) {
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
