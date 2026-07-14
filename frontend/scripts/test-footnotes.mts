// Scratch test for multi-paragraph footnote parsing (run: npx tsx scripts/test-footnotes.mts)
// Not wired into any build; verifies markdownToHtml + the htmlToMarkdown round-trip.
import { JSDOM } from 'jsdom';

const dom = new JSDOM('');
(globalThis as any).DOMParser = dom.window.DOMParser;
(globalThis as any).document = dom.window.document;

const { markdownToHtml, htmlToMarkdown } = await import('../src/markdown.ts');

const sample = `Some text with a footnote.[^17] And another.[^18]

## A heading

More body text here.

[^17]: Are we really in such a race? Sort of, but not exactly.

    On our default trajectory, AI will soon become very powerful, to the point where it's more strategically important than nuclear weapons. Many people, including the CEOs of frontier AI companies, are trying hard to build smarter AI systems before their competitors do.

    However, being overly paranoid about competitors is a well-known bias.

[^18]: A footnote with a rule inside.

    * * *

    Text after the rule, still in the footnote.
`;

const html = markdownToHtml(sample);
console.log('=== HTML ===');
console.log(html);

const failures: string[] = [];
if (/<pre|<code/.test(html)) failures.push('FAIL: code block leaked into output');
if (!/id="fn-17"/.test(html)) failures.push('FAIL: fn-17 missing');
const fn17 = html.match(/<li id="fn-17">([\s\S]*?)<\/li>/)?.[1] ?? '';
if ((fn17.match(/<p>/g) || []).length < 3) failures.push(`FAIL: fn-17 should have 3 paragraphs, got: ${fn17}`);
if (!/nuclear weapons/.test(fn17)) failures.push('FAIL: fn-17 lost its second paragraph');
if (!/well-known bias/.test(fn17)) failures.push('FAIL: fn-17 lost its third paragraph');
const fn18 = html.match(/<li id="fn-18">([\s\S]*?)<\/li>/)?.[1] ?? '';
if (!/<hr\/?>/.test(fn18)) failures.push(`FAIL: fn-18 should contain an <hr>, got: ${fn18}`);
if (!/still in the footnote/.test(fn18)) failures.push('FAIL: fn-18 lost text after the rule');
// The stranded-content symptom: footnote text must not appear before the footnotes section.
const beforeSection = html.split('<section class="footnotes">')[0];
if (/nuclear weapons|well-known bias|still in the footnote/.test(beforeSection))
  failures.push('FAIL: footnote paragraphs stranded in the body');
if (!/footnote-backref/.test(fn17) || !/footnote-backref/.test(fn18)) failures.push('FAIL: backref missing');

console.log('\n=== ROUND TRIP (markdown again) ===');
const md2 = htmlToMarkdown(html);
console.log(md2);
if (!/\[\^1\]: Are we really in such a race\?/.test(md2)) failures.push('FAIL: round-trip def line wrong');
if (!/\n {4}On our default trajectory/.test(md2)) failures.push('FAIL: round-trip lost 4-space continuation indent');
// The footnotes section's decorative <hr> must not leak into the body as a stray `---`
// (the sample body contains no real rule, so no unindented --- may appear at all).
if (/^---$/m.test(md2)) failures.push('FAIL: stray --- leaked from the footnotes section');

// Second round trip must be stable (no re-mangling on the next edit-save).
const html2 = markdownToHtml(md2);
if (/<pre|<code/.test(html2)) failures.push('FAIL: second round trip produced a code block');
const fn17b = html2.match(/<li id="fn-1">([\s\S]*?)<\/li>/)?.[1] ?? '';
if (!/nuclear weapons/.test(fn17b) || !/well-known bias/.test(fn17b))
  failures.push('FAIL: second round trip lost fn-17 paragraphs');

console.log('\n=== RESULT ===');
if (failures.length) {
  failures.forEach((f) => console.log(f));
  process.exit(1);
}
console.log('ALL CHECKS PASSED');
