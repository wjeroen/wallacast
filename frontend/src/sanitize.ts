// Single choke point for rendering fetched / third-party HTML with dangerouslySetInnerHTML.
//
// Article bodies and (especially) forum/Substack comments come straight from the open web, so
// without sanitizing them a poisoned comment or article could run script in our origin and
// steal the JWT access + refresh tokens from localStorage (= full account takeover). The
// shared read-only demo renders the same fetched content, so one payload would hit every demo
// visitor too.
//
// DOMPurify's defaults already remove the real XSS vectors: <script>, on* event handlers
// (onerror/onload/...), and javascript:/data: URLs. We keep class/id/data-* (defaults) so the
// read-along structure, footnote anchors (#fn-N), and our llm-content-block styling survive.
// <iframe>/<object>/<embed>/<form> are dropped, so third-party embeds do not render. That is a
// deliberate trade: no YouTube/Twitter embeds, but no clickjacking or phishing frames either.

import DOMPurify from 'dompurify';

// Strict: for third-party COMMENTS and podcast descriptions, which never need a stylesheet.
export function safeHtml(dirty: string | null | undefined): string {
  if (!dirty) return '';
  return DOMPurify.sanitize(dirty, { ADD_ATTR: ['target'] });
}

// Rich: for ARTICLE BODIES. Same as safeHtml but also keeps <style>, because LessWrong /
// EA Forum posts ship an inline stylesheet that MathJax needs to position equations. DOMPurify
// still sanitizes the CSS inside that <style> (it strips expression(), url(javascript:), etc.).
export function safeArticleHtml(dirty: string | null | undefined): string {
  if (!dirty) return '';
  return DOMPurify.sanitize(dirty, { ADD_TAGS: ['style'], ADD_ATTR: ['target'] });
}
