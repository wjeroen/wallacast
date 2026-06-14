// Shared HTML <-> Markdown conversion for the article/text editor and "Copy content".
//
// Both directions are built on battle-tested libraries (turndown for HTML->Markdown,
// marked for Markdown->HTML) so the boring 95% — escaping, nested lists, inline
// formatting, GFM tables, images — is handled correctly. On top of that we add a few
// custom rules so Wallacast's special structures round-trip losslessly AND stay
// human-readable in Obsidian:
//
//   - LessWrong/EA Forum LLM blocks (<div class="llm-content-block" data-model-name="X">)
//     <-> Obsidian callout `> [!ai] X`
//   - Tweet embeds (<blockquote class="twitter-tweet">) <-> `> [!tweet]` callout
//   - Tables -> GFM pipe tables, images -> ![alt](url) (standard, Obsidian-native)
//   - Anything we don't recognize (iframes, footnote markers) is KEPT as raw HTML so
//     no information is silently dropped — Obsidian renders raw HTML too.
//
// Because the SAME functions power both the editor and "Copy content", what you copy is
// exactly what you'd see in the editor.

import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';
import { marked } from 'marked';

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

  return td;
}

const turndownService = buildTurndown();

/**
 * Convert article/comment HTML into readable Markdown (Obsidian-friendly).
 * Preserves headings, lists, blockquotes, bold/italic, links, images, tables, code,
 * and Wallacast's LLM blocks / tweet embeds (as callouts).
 */
export function htmlToMarkdown(html: string): string {
  if (!html) return '';
  return turndownService.turndown(html).trim();
}

/**
 * Convert Markdown back into the cleaned HTML we store in `html_content`.
 * Reconstructs `[!ai]` / `[!tweet]` callouts into the structures the player renders,
 * and strips <script>/<style> as a safety guard (the backend strips again on save).
 */
export function markdownToHtml(markdown: string): string {
  if (!markdown) return '';

  const rawHtml = marked.parse(markdown, { gfm: true, async: false }) as string;
  const doc = new DOMParser().parseFromString(rawHtml, 'text/html');

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
