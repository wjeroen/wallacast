import { gotScraping } from 'got-scraping';
import { JSDOM } from 'jsdom';
import { safeFetch } from './url-guard.js';

// --- EA Forum domain handling ---
// The EA Forum runs a bot-friendly mirror at forum-bots.effectivealtruism.org. We rewrite
// added EA Forum links (from the Add tab or RSS) to this host so they point at the mirror.
// NOTE: "forum-bots.effectivealtruism.org" does NOT contain the substring
// "forum.effectivealtruism.org" (the "-bots" breaks it), so EA-Forum detection must check
// for BOTH hosts. Always detect with isEAForumUrl() rather than a bare .includes() check.
const EA_FORUM_HOST = 'forum.effectivealtruism.org';
const EA_FORUM_BOTS_HOST = 'forum-bots.effectivealtruism.org';

/** True for both the main EA Forum host and its bot-friendly mirror. */
export function isEAForumUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  return url.includes(EA_FORUM_HOST) || url.includes(EA_FORUM_BOTS_HOST);
}

/**
 * Rewrite an EA Forum link so it points at the bot-friendly mirror
 * (forum.effectivealtruism.org -> forum-bots.effectivealtruism.org).
 * Leaves non-EA-Forum links and already-rewritten links untouched.
 */
export function normalizeEAForumUrl<T extends string | null | undefined>(url: T): T {
  if (!url) return url;
  // Single replace: the main host appears once, and an already-rewritten forum-bots link
  // does not contain the main host, so this is safe to call more than once.
  return url.replace(EA_FORUM_HOST, EA_FORUM_BOTS_HOST) as T;
}

export interface Comment {
  id: string;
  username: string;
  date?: string;
  karma?: number;
  extendedScore?: Record<string, number>;
  content: string;
  replies?: Comment[];
}

export interface ArticleContent {
  title: string;
  content: string;
  html: string;
  cleaned_html: string;
  author?: string;
  excerpt?: string;
  byline?: string;
  site_name?: string;
  published_date?: string;
  lead_image_url?: string; // <--- ADDED THIS TO FIX BUILD ERROR
  karma?: number;
  agree_votes?: number;
  disagree_votes?: number;
  comments_html?: string;
  comments?: Comment[];
  comment_source?: string; // 'ea_forum', 'lesswrong', 'substack', or undefined
  comment_count_total?: number; // total comments including nested replies
}

// --- NEW GRAPHQL LOGIC START ---

interface GraphQLResponse {
  data?: {
    post?: {
      result: {
        _id: string;
        title: string;
        htmlBody: string;
        postedAt: string;
        baseScore: number;
        voteCount: number;
        extendedScore: any;
        user: {
          displayName: string;
          slug: string;
        } | null;
        pageUrl: string;
      } | null;
    };
    comments?: {
      results: Array<{
        _id: string;
        htmlBody: string;
        postedAt: string;
        baseScore: number;
        extendedScore: any;
        user: {
          displayName: string;
          slug: string;
        } | null;
        parentCommentId: string | null;
      }>;
    } | null;
  };
  errors?: any[];
}

function parseExtendedScore(score: any): { agree?: number; disagree?: number; raw?: any } {
  if (!score) return {};
  let data = score;
  if (typeof score === 'string') {
    try {
      data = JSON.parse(score);
    } catch (e) {
      return { raw: score };
    }
  }
  return {
    agree: data.agreement ?? data.agree ?? data.upvotes,
    disagree: data.disagreement ?? data.disagree ?? data.downvotes,
    raw: data
  };
}

// Helper to create a human-like delay
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function fetchForumMagnumPost(url: string, isEAForum: boolean): Promise<ArticleContent> {
  const idMatch = url.match(/\/posts\/([a-zA-Z0-9]+)/);
  if (!idMatch) {
    throw new Error('Post ID extraction failed from URL; check the /posts/ID/slug format');
  }
  const postId = idMatch[1];
  const baseUrl = isEAForum ? 'https://forum.effectivealtruism.org' : 'https://www.lesswrong.com';
  const apiEndpoint = `${baseUrl}/graphql`;
  // Keep the Referer on the same host as Origin/apiEndpoint. The stored link may be the
  // forum-bots mirror, but the GraphQL API lives on the main host, so send a main-host
  // Referer to preserve the same-origin request shape the API expects.
  const refererUrl = `${baseUrl}${idMatch[0]}`;

  // Randomized wait between 1.5 and 4 seconds
  await sleep(1500 + Math.random() * 2500);

  const query = `
    query GetPostAndComments($postId: String!, $terms: JSON) {
      post(input: {selector: {_id: $postId}}) {
        result {
          _id
          title
          htmlBody
          postedAt
          baseScore
          voteCount
          extendedScore
          user { displayName slug }
          pageUrl
        }
      }
      comments(input: {terms: $terms}) {
        results {
          _id
          htmlBody
          postedAt
          baseScore
          extendedScore
          parentCommentId
          user { displayName slug }
        }
      }
    }
  `;

  const variables = { 
    postId,
    terms: { view: "postCommentsTop", postId, limit: 500 }
  };

  const response = await gotScraping.post(apiEndpoint, {
    json: { query, variables },
    responseType: 'json',
    headerGeneratorOptions: {
      browsers: [{ name: 'chrome', minVersion: 120 }],
      devices: ['desktop'],
      locales: ['en-US', 'en'],
      operatingSystems: ['windows', 'macos'],
    },
    headers: {
      'Origin': baseUrl,
      'Referer': refererUrl,
      'Accept': '*/*',
      'Accept-Language': 'en-US,en;q=0.9',
      'Sec-Fetch-Dest': 'empty',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Site': 'same-origin',
    },
    retry: { limit: 2 }
  });

  const json = response.body as GraphQLResponse;

  if (typeof json === 'string') {
     throw new Error('The WAF returned an HTML challenge instead of JSON data');
  }

  if (!json.data || !json.data.post || !json.data.post.result) {
    throw new Error('The GraphQL response does not contain the expected post data');
  }

  const post = json.data.post.result;
  const rawComments = json.data.comments?.results || [];
  // The query caps at limit: 500. If exactly 500 come back, there are probably more that we
  // are silently dropping, so warn (visible in Railway logs) instead of failing quietly.
  if (rawComments.length === 500) {
    console.warn('[Fetcher] Got exactly 500 comments (the query limit). The comment list may be truncated.');
  }
  const postReactions = parseExtendedScore(post.extendedScore);
  const commentMap = new Map<string, Comment>();
  const rootComments: Comment[] = [];

  rawComments.forEach((c: any) => {
    const commentReactions = parseExtendedScore(c.extendedScore);
    commentMap.set(c._id, {
      id: c._id,
      username: c.user?.displayName || '[deleted]',
      date: c.postedAt,
      karma: c.baseScore,
      extendedScore: commentReactions.raw, 
      content: c.htmlBody, 
      replies: []
    });
  });

  rawComments.forEach((c: any) => {
    const commentNode = commentMap.get(c._id)!;
    if (c.parentCommentId && commentMap.has(c.parentCommentId)) {
      const parent = commentMap.get(c.parentCommentId)!;
      parent.replies?.push(commentNode);
    } else {
      rootComments.push(commentNode);
    }
  });

  const dom = new JSDOM(post.htmlBody);
  stripInlineColors(dom.window.document.body);
  return {
    title: post.title,
    content: dom.window.document.body.textContent || '',
    html: post.htmlBody,
    cleaned_html: dom.window.document.body.innerHTML,
    author: post.user?.displayName || '[deleted]',
    byline: post.user?.displayName || '[deleted]',
    site_name: isEAForum ? 'EA Forum' : 'LessWrong',
    published_date: post.postedAt,
    karma: post.baseScore,
    agree_votes: postReactions.agree,
    disagree_votes: postReactions.disagree,
    comments: rootComments,
    comment_source: isEAForum ? 'ea_forum' : 'lesswrong',
    comment_count_total: countCommentsRecursive(rootComments),
    comments_html: ''
  };
}

// --- NEW GRAPHQL LOGIC END ---

// --- SUBSTACK HELPERS START ---

/**
 * Detect if a page is Substack by checking for substackcdn.com references.
 * Works on custom domains too (e.g., www.update.news uses Substack).
 */
function isSubstackPage(html: string): boolean {
  return html.includes('substackcdn.com');
}

/**
 * Build the /comments URL from an article URL.
 * Strips query params, fragments, existing /comments, then appends /comments.
 */
function buildSubstackCommentsUrl(articleUrl: string): string {
  const parsed = new URL(articleUrl);
  // Strip query params and fragment
  let path = parsed.pathname;
  // Strip trailing slash
  path = path.replace(/\/+$/, '');
  // Strip /comments if already present
  path = path.replace(/\/comments$/, '');
  return `${parsed.origin}${path}/comments`;
}

/**
 * Extract window._preloads JSON from raw HTML.
 * Substack embeds hydration data in various formats:
 *   - window._preloads = JSON.parse("...escaped...")
 *   - window._preloads = JSON.parse('...escaped...')
 *   - window._preloads = {...}  (direct assignment)
 * Handles whitespace variations and different quote styles.
 */
function parseSubstackPreloads(html: string): any | null {
  // Find the window._preloads ASSIGNMENT (not property accesses like window._preloads.sentry_dsn)
  // We need to find "window._preloads" followed by optional whitespace then "=" (not ".something")
  const needle = 'window._preloads';
  let searchFrom = 0;
  let preloadsIdx = -1;
  let afterPreloads = '';

  while (true) {
    const idx = html.indexOf(needle, searchFrom);
    if (idx === -1) break;

    // Check what follows: skip property accesses (window._preloads.foo)
    const after = html.substring(idx + needle.length, idx + needle.length + 200);
    const firstNonSpace = after.match(/^\s*(.)/);
    if (firstNonSpace && firstNonSpace[1] === '=') {
      // This is an assignment. Use it.
      preloadsIdx = idx;
      afterPreloads = after;
      break;
    }
    // Not an assignment (property access like .sentry_dsn), keep searching
    searchFrom = idx + needle.length;
  }

  if (preloadsIdx === -1) {
    console.log('[Fetcher] _preloads: found references but no assignment (window._preloads = ...)');
    return null;
  }

  // Try Format 1: JSON.parse("...") or JSON.parse('...')
  const jsonParseMatch = afterPreloads.match(/^\s*=\s*JSON\.parse\((['"])/);
  if (jsonParseMatch) {
    const quoteChar = jsonParseMatch[1]; // " or '
    const contentStart = preloadsIdx + 'window._preloads'.length + jsonParseMatch[0].length;

    // Walk forward to find the closing quote, accounting for backslash escapes
    let i = contentStart;
    while (i < html.length) {
      if (html[i] === '\\') {
        i += 2; // Skip escaped character
      } else if (html[i] === quoteChar) {
        break;
      } else {
        i++;
      }
    }

    if (i >= html.length) {
      console.log(`[Fetcher] _preloads: found JSON.parse(${quoteChar}) but couldn't find closing quote`);
      return null;
    }

    const escapedJson = html.substring(contentStart, i);
    try {
      // Unescape the JavaScript string literal, then parse the JSON
      const unescaped = JSON.parse(quoteChar + escapedJson + quoteChar);
      return JSON.parse(unescaped);
    } catch (e: any) {
      console.log(`[Fetcher] _preloads: JSON.parse format found but parse failed: ${e.message?.substring(0, 100)}`);
      // Try alternative: maybe the escaped content needs different unescaping
      try {
        // Some Substack pages double-encode: try just one JSON.parse
        return JSON.parse(escapedJson);
      } catch {
        // Show a snippet of what we're trying to parse
        console.log(`[Fetcher] _preloads content starts with: ${escapedJson.substring(0, 150)}`);
        return null;
      }
    }
  }

  // Try Format 2: Direct assignment: window._preloads = {...}
  const directMatch = afterPreloads.match(/^\s*=\s*(\{)/);
  if (directMatch) {
    console.log('[Fetcher] _preloads: found direct assignment format');
    // Find the matching closing brace by counting depth
    const objStart = preloadsIdx + 'window._preloads'.length + afterPreloads.indexOf('{');
    let depth = 0;
    let inString = false;
    let stringChar = '';
    let i = objStart;

    while (i < html.length) {
      const ch = html[i];
      if (inString) {
        if (ch === '\\') {
          i += 2;
          continue;
        }
        if (ch === stringChar) inString = false;
      } else {
        if (ch === '"' || ch === "'") {
          inString = true;
          stringChar = ch;
        } else if (ch === '{') {
          depth++;
        } else if (ch === '}') {
          depth--;
          if (depth === 0) {
            try {
              const jsonStr = html.substring(objStart, i + 1);
              return JSON.parse(jsonStr);
            } catch (e: any) {
              console.log(`[Fetcher] _preloads: direct assignment parse failed: ${e.message?.substring(0, 100)}`);
              return null;
            }
          }
        }
      }
      i++;
    }
    console.log('[Fetcher] _preloads: could not find matching closing brace');
    return null;
  }

  // Unknown format. Log what we see for debugging.
  console.log(`[Fetcher] _preloads: unknown format after "window._preloads": ${afterPreloads.substring(0, 80)}`);
  return null;
}

/**
 * Convert a Substack comment from _preloads JSON to our Comment interface.
 * Recursively processes children (replies).
 */
function mapSubstackComment(raw: any): Comment {
  // body can be plain text or HTML. Wrap plain text in <p> tags for consistency.
  let content = raw.body || '';
  if (content && !content.includes('<')) {
    // Plain text. Convert newlines to paragraphs.
    content = content.split(/\n\n+/).map((p: string) => `<p>${p.replace(/\n/g, '<br>')}</p>`).join('');
  }

  const replies: Comment[] = [];
  if (raw.children && Array.isArray(raw.children) && raw.children.length > 0) {
    for (const child of raw.children) {
      replies.push(mapSubstackComment(child));
    }
  }

  return {
    id: String(raw.id),
    username: raw.name || 'Anonymous',
    date: raw.date || undefined,
    karma: raw.reaction_count || undefined,
    content,
    replies: replies.length > 0 ? replies : undefined,
  };
}

/**
 * Extract comments from a Substack _preloads object.
 * Searches for comment data under various possible key names.
 */
function extractCommentsFromPreloads(preloads: any): any[] | null {
  // Try known key names for comments
  const commentKeys = ['initialComments', 'comments', 'postComments', 'commentList'];
  for (const key of commentKeys) {
    if (preloads[key] && Array.isArray(preloads[key]) && preloads[key].length > 0) {
      console.log(`[Fetcher] Found Substack comments under _preloads.${key} (${preloads[key].length} items)`);
      return preloads[key];
    }
  }

  // Deep search: look for any array of objects that have comment-like shape (id + body/name fields)
  for (const key of Object.keys(preloads)) {
    const val = preloads[key];
    if (Array.isArray(val) && val.length > 0 && val[0] && typeof val[0] === 'object') {
      if ('body' in val[0] && ('name' in val[0] || 'user_id' in val[0])) {
        console.log(`[Fetcher] Found comment-like array under _preloads.${key} (${val.length} items)`);
        return val;
      }
    }
  }

  return null;
}

/**
 * Extract Substack comments from raw HTML.
 * Tries _preloads JSON first. Returns empty array if no comments found.
 */
function extractSubstackCommentsFromHtml(html: string, source: string): Comment[] {
  const preloads = parseSubstackPreloads(html);

  if (!preloads) {
    console.log(`[Fetcher] No _preloads found in ${source} HTML`);
    // Log what data hydration patterns exist
    if (html.includes('window._preloads')) {
      console.log(`[Fetcher] window._preloads IS present but parsing failed`);
    }
    if (html.includes('__NEXT_DATA__')) {
      console.log(`[Fetcher] __NEXT_DATA__ found in ${source} (Next.js hydration)`);
    }
    return [];
  }

  // Log available top-level keys for debugging
  const topKeys = Object.keys(preloads);
  console.log(`[Fetcher] _preloads from ${source} has keys: ${topKeys.join(', ')}`);

  const rawComments = extractCommentsFromPreloads(preloads);
  if (!rawComments) {
    console.log(`[Fetcher] No comment arrays found in ${source} _preloads`);
    return [];
  }

  // Log the shape of the first comment for debugging
  const first = rawComments[0];
  console.log(`[Fetcher] First comment shape: ${JSON.stringify(Object.keys(first))}`);
  if (first.name) console.log(`[Fetcher] First comment by: ${first.name}`);

  const comments = rawComments.map(mapSubstackComment);
  const totalCount = countCommentsRecursive(comments);
  console.log(`[Fetcher] Extracted ${comments.length} top-level comments (${totalCount} total with replies) from Substack ${source}`);
  return comments;
}

/**
 * Fetch and extract comments from a Substack article.
 * Always fetches the /comments page first (it has ALL comments).
 * Falls back to article page HTML if /comments fails.
 * Uses window._preloads JSON (stable structured data, not fragile CSS selectors).
 */
async function fetchSubstackComments(articleUrl: string, articleHtml: string): Promise<Comment[]> {
  // First: always fetch the /comments page (has the full comment thread)
  const commentsUrl = buildSubstackCommentsUrl(articleUrl);
  console.log(`[Fetcher] Fetching Substack comments from: ${commentsUrl}`);

  try {
    // Send a browser User-Agent so Substack doesn't serve a bot/challenge page. The GraphQL
    // feed fetch above generates one via got-scraping; a bare fetch() sends none.
    const response = await safeFetch(commentsUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
    });
    if (response.ok) {
      const html = await response.text();
      console.log(`[Fetcher] Comments page: ${html.length} bytes`);
      const fromCommentsPage = extractSubstackCommentsFromHtml(html, 'comments page');
      if (fromCommentsPage.length > 0) {
        return fromCommentsPage;
      }
    } else {
      console.log(`[Fetcher] Comments page HTTP ${response.status}`);
    }
  } catch (error) {
    console.error('[Fetcher] Failed to fetch Substack comments page:', error);
  }

  // Fallback: try to extract from the article page we already have
  console.log('[Fetcher] Trying article page HTML as fallback for comments');
  return extractSubstackCommentsFromHtml(articleHtml, 'article page');
}

function countCommentsRecursive(comments: Comment[]): number {
  let count = 0;
  for (const c of comments) {
    count++;
    if (c.replies) count += countCommentsRecursive(c.replies);
  }
  return count;
}

/**
 * Apply Substack-specific HTML cleanup using stable selectors.
 * Uses data-component-name, data-testid, and generic patterns. NOT hashed class names.
 */
function cleanSubstackContent(contentEl: Element): void {
  // Remove subscribe widgets (data-component-name is stable, semantic attribute)
  contentEl.querySelectorAll('[data-component-name="SubscribeWidget"]').forEach(el => el.remove());

  // Remove "Subscribe now" CTA buttons (only if they link to /subscribe)
  contentEl.querySelectorAll('[data-component-name="ButtonCreateButton"]').forEach(el => {
    const link = el.querySelector('a');
    if (link && (link.getAttribute('href') || '').includes('/subscribe')) {
      el.remove();
    }
  });

  // Remove top navbar (data-testid is stable, used for testing)
  contentEl.querySelectorAll('[data-testid="navbar"]').forEach(el => {
    // Also remove the spacer div that follows it
    const next = el.nextElementSibling;
    if (next && next.getAttribute('style')?.includes('height:88px') || next?.getAttribute('style')?.includes('height: 88px')) {
      next.remove();
    }
    el.remove();
  });

  // Remove footer
  contentEl.querySelectorAll('.footer-wrap').forEach(el => el.remove());

  // Remove notification regions
  contentEl.querySelectorAll('[role="region"][aria-label*="Notification"]').forEach(el => el.remove());

  // Remove comment input forms
  contentEl.querySelectorAll('form').forEach(el => {
    const hasCommentTextarea = el.querySelector('textarea[name="body"], textarea[placeholder*="comment"]');
    if (hasCommentTextarea) {
      el.remove();
    }
  });

  // Remove share dialog overlays
  contentEl.querySelectorAll('[data-component-name="ShareMenuDialog"]').forEach(el => el.remove());
}

// --- SUBSTACK HELPERS END ---

// Flatten email-newsletter layout into normal block flow. Newsletters are built from
// nested fixed-width tables (600px scaffolding marked role="presentation") which refuse
// to shrink on narrow screens (horizontal scrollbar) and turn the whole email into ONE
// giant block for the read-along extractor. Gated on the presence of presentation
// tables, so ordinary articles pass through untouched. Runs at fetch/add time only;
// already-stored items keep their HTML (refetch to heal them).
export function flattenEmailTables(root: Element): void {
  if (!root.querySelector('table[role="presentation"]')) return;
  const doc = root.ownerDocument!;

  // 1. Drop hidden elements FIRST: emails duplicate content in mobile/desktop variants
  // suppressed only by inline styles, so flattening without this step would surface
  // (and narrate) everything twice. Also removes invisible preview-text preheaders.
  root.querySelectorAll('[style]').forEach(el => {
    const s = (el.getAttribute('style') || '').toLowerCase();
    if (/display\s*:\s*none/.test(s) || (/max-height\s*:\s*0/.test(s) && /overflow\s*:\s*hidden/.test(s))) {
      el.remove();
    }
  });

  // 2. Drop tracking beacons: 1-2px images and images whose URL carries
  // per-recipient tracking parameters (these embed the subscriber's email address).
  root.querySelectorAll('img').forEach(img => {
    const w = parseInt(img.getAttribute('width') || '', 10);
    const h = parseInt(img.getAttribute('height') || '', 10);
    const src = img.getAttribute('src') || '';
    if ((w > 0 && w <= 2) || (h > 0 && h <= 2) || /[?&](cs_email|cs_sendid)=/i.test(src)) {
      img.remove();
    }
  });

  // 3. Unwrap presentation tables bottom-up (inner first). Each cell becomes its own
  // div so adjacent cells' inline content stays visually separated. `table.rows` and
  // `row.cells` only cover the table's OWN rows per spec, so a genuine data table
  // nested inside survives intact.
  const tables = Array.from(root.querySelectorAll('table[role="presentation"]')).reverse();
  for (const table of tables) {
    const container = doc.createElement('div');
    // The email's visual rhythm lived in table padding, which the unwrap discards;
    // a margin per block restores it (nested blocks collapse margins, so spacing
    // between the user-visible sections stays ~one line, not cumulative).
    container.setAttribute('style', 'margin-bottom: 1em');
    for (const row of Array.from((table as HTMLTableElement).rows)) {
      for (const cell of Array.from(row.cells)) {
        const cellDiv = doc.createElement('div');
        while (cell.firstChild) cellDiv.appendChild(cell.firstChild);
        if (cellDiv.childNodes.length > 0) container.appendChild(cellDiv);
      }
    }
    table.replaceWith(container);
  }

  // 4. Prune the leftover scaffolding debris: spacer cells, nbsp-only paragraphs,
  // and wrappers emptied by the steps above. Repeat until stable (emptying a child
  // can empty its parent).
  let removedAny = true;
  while (removedAny) {
    removedAny = false;
    root.querySelectorAll('div, p, span, a').forEach(el => {
      if (el.querySelector('img, video, iframe, audio')) return;
      if ((el.textContent || '').replace(/\u00a0/g, ' ').trim() !== '') return;
      el.remove();
      removedAny = true;
    });
  }
}

// Strip author-set colours from inline styles so the reader's theme controls text colour.
// Removes `color` / `background-color` declarations from `style` attributes (keeping other
// props like width) and drops Substack's `data-color` attribute. Otherwise an explicit
// colour (often black) overrides the theme and renders e.g. black-on-dark in dark mode.
function stripInlineColors(root: Element | Document): void {
  root.querySelectorAll('[style], [data-color]').forEach((el) => {
    if (el.hasAttribute('data-color')) el.removeAttribute('data-color');
    const style = el.getAttribute('style');
    if (!style) return;
    const kept = style
      .split(';')
      .map((d) => d.trim())
      .filter(Boolean)
      .filter((d) => {
        const prop = d.split(':')[0].trim().toLowerCase();
        return prop !== 'color' && prop !== 'background-color';
      });
    if (kept.length > 0) el.setAttribute('style', kept.join('; '));
    else el.removeAttribute('style');
  });
}

export async function fetchArticleContent(url: string): Promise<ArticleContent> {
  console.log(`[Fetcher] Fetching article from: ${url}`);

  const isLessWrong = url.includes('lesswrong.com');
  const isEAForum = isEAForumUrl(url);

  // Use GraphQL for EA Forum/LessWrong
  if (isLessWrong || isEAForum) {
    try {
      console.log(`[Fetcher] Detected ${isLessWrong ? 'LessWrong' : 'EA Forum'}, using GraphQL API...`);
      return await fetchForumMagnumPost(url, isEAForum);
    } catch (error: any) {
      console.error(`[Fetcher] GraphQL fetch failed: ${error.message}`);
      console.log('[Fetcher] Attempting fallback to standard scraper...');
    }
  }

  // --- STANDARD SCRAPER for all other sites (including Substack) ---
  try {
    console.log('[Fetcher] Using simple fetch for standard scraping');
    const response = await safeFetch(url);

    if (!response.ok) {
      console.log(`[Fetcher] HTTP error: ${response.status} ${response.statusText}`);
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const html = await response.text();
    console.log(`[Fetcher] Received ${html.length} bytes of HTML`);

    // Log if potential Cloudflare challenge but continue anyway
    if (html.includes('challenge-platform') || html.includes('Verifying you are human')) {
      console.log('[Fetcher] ⚠️ Potential Cloudflare challenge detected, but attempting to parse anyway');
    }

    // Detect Substack BEFORE removing scripts (needs to check for substackcdn.com links)
    const isSubstack = isSubstackPage(html);
    if (isSubstack) {
      console.log('[Fetcher] Detected Substack page (via substackcdn.com references)');
    }

    const dom = new JSDOM(html, { url });
    const doc = dom.window.document;

    // Remove scripts and styles globally
    const scripts = doc.querySelectorAll('script');
    scripts.forEach(script => script.remove());
    const styles = doc.querySelectorAll('style');
    styles.forEach(style => style.remove());

    // Extract metadata from meta tags
    const title =
      doc.querySelector('meta[property="og:title"]')?.getAttribute('content') ||
      doc.querySelector('title')?.textContent ||
      'Untitled';

    const siteName =
      doc.querySelector('meta[property="og:site_name"]')?.getAttribute('content') ||
      new URL(url).hostname;

    let author: string | undefined;
    const authorMeta = doc.querySelector('meta[name="author"]')?.getAttribute('content');
    if (authorMeta) {
      author = authorMeta;
    } else {
      const authorSelectors = ['.author', '.byline', 'a[rel="author"]'];
      for (const selector of authorSelectors) {
        const el = doc.querySelector(selector);
        if (el) {
          author = el.textContent?.trim();
          break;
        }
      }
    }

    const publishedDate =
      doc.querySelector('meta[property="article:published_time"]')?.getAttribute('content') || undefined;

    // --- ADDED IMAGE EXTRACTION HERE ---
    const leadImageUrl =
      doc.querySelector('meta[property="og:image"]')?.getAttribute('content') ||
      doc.querySelector('meta[name="twitter:image"]')?.getAttribute('content') ||
      undefined;

    // Smart content selection
    let contentEl;

    // Substack-specific selectors (more precise). Works on custom domains too.
    if (isSubstack) {
      console.log('[Fetcher] Using Substack-specific content selectors');
      contentEl = doc.querySelector('.available-content .body.markup') ||
                  doc.querySelector('.body.markup') ||
                  doc.querySelector('.available-content');
    }

    // Fallback to generic selectors
    if (!contentEl) {
      contentEl = doc.querySelector('article') || doc.querySelector('main') || doc.body;
    }

    // Clean up UI noise (keep this gentle - only remove obvious UI chrome)
    if (contentEl) {
      // Remove social interaction bars (like/comment/share buttons)
      contentEl.querySelectorAll('.post-ufi, .ufi, .pencraft-ufi').forEach(el => el.remove());

      // Remove navigation footers
      contentEl.querySelectorAll('.post-footer, .pencraft-footer').forEach(el => el.remove());

      // Remove image overlays (restack/expand buttons on images)
      contentEl.querySelectorAll('.image-link-expand, .pencraft-image-expand').forEach(el => el.remove());

      // Remove post headers if they're in the content (we extract metadata separately)
      contentEl.querySelectorAll('.post-header').forEach(el => el.remove());

      // Remove Substack subscription widgets (email signup forms)
      contentEl.querySelectorAll('.subscription-widget-wrap, .subscription-widget').forEach(el => el.remove());

      // Remove header anchor buttons (link icons next to headings)
      contentEl.querySelectorAll('.header-anchor-parent').forEach(el => el.remove());

      // Remove Previous/Next navigation buttons (Substack articles)
      contentEl.querySelectorAll('button, a').forEach(el => {
        const text = el.textContent?.trim() || '';
        // Match "Previous", "Next", with optional arrows like "← Previous" or "Next →"
        if (/^(←\s*)?previous(\s*→)?$/i.test(text) || /^(←\s*)?next(\s*→)?$/i.test(text)) {
          el.remove();
        }
      });

      // Remove SVG elements (icons, share buttons, decorative graphics - never article content)
      contentEl.querySelectorAll('svg').forEach(el => el.remove());

      // Remove newsletter/email signup forms (Vox, Substack, etc.)
      contentEl.querySelectorAll('form').forEach(el => {
        const hasEmailInput = el.querySelector('input[type="email"], input[name="email"]');
        if (hasEmailInput) {
          el.remove();
        }
      });

      // Remove "Related" article boxes (Vox and other sites)
      contentEl.querySelectorAll('[class*="related"]').forEach(el => {
        const heading = el.querySelector('h2, h3, h4');
        if (heading && /^related$/i.test(heading.textContent?.trim() || '')) {
          el.remove();
        }
      });

      // Remove share button containers
      contentEl.querySelectorAll('[class*="share-buttons"], [class*="share-tools"], [class*="social-share"]').forEach(el => el.remove());

      // Remove the first <h1> if it matches the already-extracted title (prevents title being narrated twice)
      if (title && title !== 'Untitled') {
        const firstH1 = contentEl.querySelector('h1');
        if (firstH1) {
          const h1Text = firstH1.textContent?.trim() || '';
          // Normalize both for comparison (collapse whitespace, ignore case)
          const normalizeText = (t: string) => t.replace(/\s+/g, ' ').trim().toLowerCase();
          if (normalizeText(h1Text) === normalizeText(title)) {
            firstH1.remove();
          }
        }
      }

      // Remove subtitle/dek that matches the og:description (often repeated under title in lede sections)
      const ogDescription = doc.querySelector('meta[property="og:description"]')?.getAttribute('content');
      if (ogDescription) {
        const normalizeText = (t: string) => t.replace(/\s+/g, ' ').trim().toLowerCase();
        const normalizedDesc = normalizeText(ogDescription);
        // Search all paragraphs. The dek might be anywhere in the lede wrapper.
        contentEl.querySelectorAll('p').forEach(p => {
          const pText = p.textContent?.trim() || '';
          if (normalizeText(pText) === normalizedDesc) {
            p.remove();
          }
        });
      }

      // Remove author byline/bio sections from article body (we already extract author from metadata)
      // These typically contain a small headshot image + bio text
      contentEl.querySelectorAll('[class*="byline"], [class*="author-bio"], [class*="article-byline"]').forEach(el => el.remove());

      // Remove article timestamp elements (we already extract published_date from meta)
      contentEl.querySelectorAll('[class*="article--timestamp"]').forEach(el => el.remove());

      // Remove lede metadata sections (Vox-style: category labels, author cards with headshots)
      // The lede wrapper contains title/subtitle/byline/author which we extract separately
      contentEl.querySelectorAll('[class*="article--lede"], [class*="lede--standard"]').forEach(el => {
        // Only remove if it does NOT contain actual article body paragraphs
        const hasArticleBody = el.querySelector('[class*="article-body"], [class*="entry-body"]');
        if (!hasArticleBody) {
          el.remove();
        }
      });

      // Remove small author avatar/headshot images (typically ≤48px) and their containers
      // These are author profile pictures, not article content images
      contentEl.querySelectorAll('img').forEach(img => {
        const w = parseInt(img.getAttribute('width') || '0', 10);
        const h = parseInt(img.getAttribute('height') || '0', 10);
        if ((w > 0 && w <= 48) || (h > 0 && h <= 48)) {
          // Walk up to find the nearest meaningful container to remove
          let container = img.parentElement;
          // Go up a few levels if parents are just wrappers with no other content
          for (let depth = 0; depth < 4 && container; depth++) {
            const parent = container.parentElement;
            if (!parent) break;
            // If this container has sibling elements with article text, stop here
            const siblingText = Array.from(parent.children)
              .filter(c => c !== container)
              .some(c => (c.textContent?.trim().length || 0) > 50);
            if (siblingText) break;
            container = parent;
          }
          if (container) container.remove();
          else img.remove();
        }
      });

      // Remove <aside> elements (membership pitches, supplementary content, never article body)
      contentEl.querySelectorAll('aside').forEach(el => el.remove());

      // Remove sidebar rails (Vox "Most Popular", ad slots, etc.)
      contentEl.querySelectorAll('[class*="layout--rail"]').forEach(el => el.remove());

      // Remove ad containers (Vox uses data-concert attribute for ad slots)
      contentEl.querySelectorAll('[data-concert]').forEach(el => {
        // Walk up to remove the ad wrapper too
        let container = el.parentElement;
        if (container && !container.textContent?.trim() && !container.querySelector('p, h1, h2, h3, h4, img')) {
          container.remove();
        } else {
          el.remove();
        }
      });

      // Remove native ad containers
      contentEl.querySelectorAll('[class*="native-ad"]').forEach(el => el.remove());

      // Remove "See More" / category tag sections at end of articles
      contentEl.querySelectorAll('[class*="see-more"], [class*="tag-list"]').forEach(el => el.remove());

      // Remove all remaining forms (membership, donation, etc.). We already extracted email forms above.
      contentEl.querySelectorAll('form').forEach(el => el.remove());

      // Apply Substack-specific cleanup (subscribe widgets, navbar, footer, etc.)
      if (isSubstack) {
        cleanSubstackContent(contentEl);
      }

      // Resolve relative URLs in img/a/srcset to absolute, using the article URL
      // as base. Sites like jefftk.com use root-relative paths ("/foo.jpg") that
      // would otherwise resolve against wallacast.com and 404. Done before dedup
      // so the seenImageSrcs Set sees the resolved URLs.
      const resolveUrl = (raw: string): string | null => {
        const trimmed = raw.trim();
        if (!trimmed || trimmed.startsWith('data:') || trimmed.startsWith('#')) return null;
        try { return new URL(trimmed, url).toString(); } catch { return null; }
      };
      contentEl.querySelectorAll('img').forEach(img => {
        const src = img.getAttribute('src');
        if (src) {
          const resolved = resolveUrl(src);
          if (resolved) img.setAttribute('src', resolved);
        }
        const srcset = img.getAttribute('srcset');
        if (srcset) {
          // srcset format: "url1 1x, url2 2x" or "url1 100w, url2 200w"
          const fixed = srcset.split(',').map(part => {
            const trimmed = part.trim();
            const match = trimmed.match(/^(\S+)(\s+.+)?$/);
            if (!match) return trimmed;
            const resolved = resolveUrl(match[1]);
            return resolved ? `${resolved}${match[2] || ''}` : trimmed;
          }).join(', ');
          img.setAttribute('srcset', fixed);
        }
      });
      contentEl.querySelectorAll('a').forEach(a => {
        const href = a.getAttribute('href');
        if (href) {
          const resolved = resolveUrl(href);
          if (resolved) a.setAttribute('href', resolved);
        }
      });

      // Deduplicate images with the same src URL (e.g., Vox uses two <img> for responsive - mobile + desktop)
      const seenImageSrcs = new Set<string>();
      contentEl.querySelectorAll('img').forEach(img => {
        const src = (img.getAttribute('src') || '').split('?')[0].split('#')[0];
        if (!src) return;
        if (seenImageSrcs.has(src)) {
          // Remove the duplicate image. Also remove parent container if it's now empty.
          const parent = img.parentElement;
          img.remove();
          if (parent && !parent.textContent?.trim() && !parent.querySelector('img, video, iframe')) {
            parent.remove();
          }
        } else {
          seenImageSrcs.add(src);
        }
      });
    }

    flattenEmailTables(contentEl);
    stripInlineColors(contentEl);
    const cleanedHtml = contentEl.innerHTML;
    const textContent = contentEl.textContent || '';

    // Fetch Substack comments from /comments page (uses structured JSON, not CSS selectors)
    let comments: Comment[] | undefined;
    let comment_source: string | undefined;
    let comment_count_total: number | undefined;
    if (isSubstack) {
      comments = await fetchSubstackComments(url, html);
      if (comments.length === 0) {
        comments = undefined;
      } else {
        comment_source = 'substack';
        comment_count_total = countCommentsRecursive(comments);
      }
    }

    return {
      title,
      content: textContent,
      html: html,
      cleaned_html: cleanedHtml,
      author,
      byline: author,
      site_name: siteName,
      published_date: publishedDate,
      lead_image_url: leadImageUrl,
      comments,
      comment_source,
      comment_count_total,
    };

  } catch (error) {
    console.error('[Fetcher] ✗ Error fetching article:', error);
    throw new Error('Failed to fetch article content');
  }
}
