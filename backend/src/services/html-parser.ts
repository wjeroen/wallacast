import { JSDOM } from 'jsdom';

// How many pages one jsdom window parses before a new one takes over
const PAGES_PER_WINDOW = 500;

/**
 * A DOMParser for code that parses many small pages (feed descriptions, teasers, Markdown
 * conversions). A jsdom DOMParser keeps about 7 KB for every page it parses, for as long as its
 * window lives: over 10,000 pages the heap grew from 42 to 110 MB and each parse took twice as
 * long (measured 2026-10-18). One parser reused for the life of the server made the backend
 * slower every day after a deploy, until a feed refresh took 46 minutes instead of about one.
 * A new window for every page keeps nothing, but makes each parse about 2.5 times slower. This
 * parser moves to a new window every 500 pages and drops the old one, which the garbage
 * collector then frees with everything it kept. The old window is not closed, so a document a
 * caller still holds keeps working.
 */
export function renewingHtmlParser(): { parseFromString(html: string, type: 'text/html'): Document } {
  let parser = new (new JSDOM('').window.DOMParser)();
  let pages = 0;
  return {
    parseFromString(html: string, type: 'text/html'): Document {
      if (pages >= PAGES_PER_WINDOW) {
        parser = new (new JSDOM('').window.DOMParser)();
        pages = 0;
      }
      pages++;
      return parser.parseFromString(html, type);
    },
  };
}
