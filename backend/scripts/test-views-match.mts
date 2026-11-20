// The Content tab and Copy content (which is also what the Markdown editor shows) must hold
// the same text. The Content tab is the stored HTML through frontend/src/sanitize.ts, shown
// by a browser; Copy content is the same HTML through markdown.ts. This test renders sample
// pages both ways and compares their words, so a part one view shows and the other leaves
// out (a hidden block, text for browsers without scripts, stylesheet code) fails here.
// Run from backend/: npx tsx scripts/test-views-match.mts
// Not wired into any build.
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { htmlToMarkdown, setHtmlParser } from '../src/shared/markdown.ts';

console.log('loading the sanitizer');
const { window } = new JSDOM('');
// sanitize.ts builds DOMPurify on the global window when it is first imported
(globalThis as any).window = window;
const { safeArticleHtml } = await import('../../frontend/src/sanitize.ts');
setHtmlParser(new window.DOMParser());

// The words a browser shows for sanitized HTML: what CSS would hide, a template's inert
// content and code are left out. A closed <details> counts as shown, since a tap opens it.
function contentTabWords(html: string): string[] {
  const doc = new JSDOM(`<body>${safeArticleHtml(html)}</body>`).window.document;
  const parts: string[] = [];
  const walk = (node: Node) => {
    if (node.nodeType === 3) { parts.push((node as Text).data); return; }
    if (node.nodeType !== 1) return;
    const el = node as Element;
    const style = el.getAttribute('style') || '';
    if (el.hasAttribute('hidden') || /display\s*:\s*none|visibility\s*:\s*(hidden|collapse)/i.test(style)) return;
    if (['SCRIPT', 'STYLE', 'TEMPLATE', 'NOSCRIPT', 'IFRAME'].includes(el.tagName)) return;
    if (/^(P|DIV|LI|H[1-6]|BLOCKQUOTE|SUMMARY|DETAILS|TR|TD|TH)$/.test(el.tagName)) parts.push(' ');
    el.childNodes.forEach(walk);
    if (/^(P|DIV|LI|H[1-6]|BLOCKQUOTE|SUMMARY|TD|TH)$/.test(el.tagName)) parts.push(' ');
  };
  doc.body.childNodes.forEach(walk);
  return words(parts.join(''));
}

// The words of Copy content's Markdown, without its syntax
function exportWords(html: string): string[] {
  const md = htmlToMarkdown(html)
    .replace(/<iframe[^>]*><\/iframe>/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s*(#+|>|-|\d+\.)\s+/gm, ' ')
    .replace(/[*_`]/g, '');
  return words(md);
}

const words = (text: string) => text.replace(/\\([^\w\s])/g, '$1').split(/\s+/).filter(Boolean);

const pages: Record<string, string> = {
  'plain article': '<h2>Title</h2><p>One <strong>bold</strong> and <em>soft</em> word, a <a href="https://example.com">link</a>.</p><ul><li>First</li><li>Second</li></ul><blockquote><p>Quoted.</p></blockquote>',
  'hidden attribute': '<p>Before.</p><div hidden><p>Hidden text.</p></div><p>After.</p>',
  'inline display none and visibility hidden': '<p>A.</p><div style="color: red; display: none">B.</div><span style="visibility:hidden !important">C.</span><p>D.</p>',
  'text for browsers without scripts': '<p>Story.</p><noscript>This website requires javascript.</noscript><p>More story.</p>',
  'stylesheet and script code': '<style>.math { color: red }</style><p>Words.</p><script>var x = 1;</script>',
  'template and React streamed blocks (LessWrong without its API)':
    '<div hidden=""><template id="B:0"></template></div><template id="B:1"></template>'
    + '<div hidden="" id="S:1"><h1>ACX Everywhere</h1><p>We are hosting it in SoMa.</p></div>'
    + '<div hidden="" id="S:0"><p>Please RSVP by email.</p></div>',
  'collapsed details': '<details><summary>More</summary><p>Inside the details.</p></details>',
  'embedded frame': '<p>Watch this.</p><iframe src="https://www.youtube.com/embed/abc"></iframe><p>Then this.</p>',
};

let failed = 0;
for (const [name, html] of Object.entries(pages)) {
  const shown = contentTabWords(html);
  const copied = exportWords(html);
  try {
    assert.deepEqual(copied, shown);
    console.log(`✅ ${name}`);
  } catch {
    failed++;
    console.log(`❌ ${name}\n   Content tab:  ${shown.join(' ')}\n   Copy content: ${copied.join(' ')}`);
  }
}
assert.equal(failed, 0, `${failed} page(s) differ between the Content tab and Copy content`);
console.log('\nCONTENT TAB AND COPY CONTENT MATCH');
