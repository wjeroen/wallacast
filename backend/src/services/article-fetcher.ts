import { gotScraping } from 'got-scraping';
import { JSDOM } from 'jsdom';
import { safeFetch, safeFetchWithCookies, browserHeadersFetch, readerProxyFetch, readerProxyMarkdown, waybackSnapshotFetch, archiveTodayFetch } from './url-guard.js';
import { markdownToHtml, setHtmlParser } from '../shared/markdown.js';

// --- EA Forum domain handling ---
// The EA Forum runs a bot-friendly mirror at forum-bots.effectivealtruism.org. We rewrite
// added EA Forum links (from the Add tab or RSS) to this host so they point at the mirror.
// NOTE: "forum-bots.effectivealtruism.org" does NOT contain the substring
// "forum.effectivealtruism.org" (the "-bots" breaks it), so EA-Forum detection must check
// for BOTH hosts. Always detect with isEAForumUrl() rather than a bare .includes() check.
export const EA_FORUM_HOST = 'forum.effectivealtruism.org';
export const EA_FORUM_BOTS_HOST = 'forum-bots.effectivealtruism.org';

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
  // The post id appears as /posts/<id>/<slug> on normal links and as /s/<sequenceId>/p/<id>
  // on sequence-navigation links (both Forum Magnum forums use both shapes; a sequence URL
  // used to fail here, silently fall back to the standard scraper, and store a random
  // comment as the article body).
  const idMatch = url.match(/\/posts\/([a-zA-Z0-9]+)/) || url.match(/\/p\/([a-zA-Z0-9]+)/);
  if (!idMatch) {
    throw new Error('Post ID extraction failed from URL; expected /posts/<id>/<slug> or /s/<seq>/p/<id>');
  }
  const postId = idMatch[1];
  const baseUrl = isEAForum ? 'https://forum.effectivealtruism.org' : 'https://www.lesswrong.com';
  const apiEndpoint = `${baseUrl}/graphql`;
  // Keep the Referer on the same host as Origin/apiEndpoint. The stored link may be the
  // forum-bots mirror, but the GraphQL API lives on the main host, so send a main-host
  // Referer to preserve the same-origin request shape the API expects. Built from the
  // canonical /posts/<id> form so sequence URLs get a plausible referer too.
  const refererUrl = `${baseUrl}/posts/${postId}`;

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
  stripLayoutStyles(dom.window.document.body);
  normalizeTweetEmbeds(dom.window.document.body);
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

// A note reply's plain-text body as paragraphs. The text is escaped, since a reply that says
// "a < b" is not HTML.
function noteReplyComment(raw: any): Comment {
  const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const content = String(raw.body || '')
    .split(/\n\s*\n/).map(part => part.trim()).filter(Boolean)
    .map(part => `<p>${escape(part).replace(/\n/g, '<br>')}</p>`)
    .join('');
  return {
    id: String(raw.id),
    username: raw.name || 'Anonymous',
    date: raw.date || undefined,
    karma: raw.reaction_count || undefined,
    content,
  };
}

const NOTE_REPLY_MAX_REQUESTS = 30;

/**
 * The replies to a Substack note as a comment tree. A note page has no `/comments` page, but
 * `substack.com/api/v1/reader/comment/<id>/replies` answers without a login (checked
 * 2026-10-06). Each answer holds a page of reply branches, each a reply with a few of its own
 * replies, plus `nextCursor` for the next page. That cursor only works with the cookies of the
 * first answer (without them the same first page comes back), so they are sent along. A reply
 * with more replies than its branch shows gets its own request. The parent of each reply is the
 * last id in its `ancestor_path`. At most 30 requests per note, and a failure keeps what was
 * collected so far.
 */
async function fetchSubstackNoteReplies(noteId: string): Promise<Comment[]> {
  const raws = new Map<string, any>();
  const cookies = new Map<string, string>();
  let requests = 0;

  const loadThread = async (id: string) => {
    let cursor: string | undefined;
    do {
      if (requests >= NOTE_REPLY_MAX_REQUESTS) return;
      requests++;
      const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
      const res = await safeFetch(`https://substack.com/api/v1/reader/comment/${id}/replies${query}`, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'application/json',
          ...(cookies.size ? { 'Cookie': Array.from(cookies, ([name, value]) => `${name}=${value}`).join('; ') } : {}),
        },
      });
      for (const header of res.headers.raw()['set-cookie'] || []) {
        const [pair] = header.split(';');
        const eq = pair.indexOf('=');
        if (eq > 0) cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
      }
      if (!res.ok) throw new Error(`replies of ${id} answered HTTP ${res.status}`);
      const data: any = await res.json();
      const before = raws.size;
      const add = (comment: any) => {
        if (comment?.id != null && !raws.has(String(comment.id))) raws.set(String(comment.id), comment);
      };
      for (const branch of data?.commentBranches || []) {
        add(branch?.comment);
        for (const descendant of branch?.descendantComments || []) {
          if (descendant?.type === 'comment') add(descendant.comment);
        }
      }
      // A cursor that brings nothing new would loop forever
      cursor = raws.size > before ? data?.nextCursor || undefined : undefined;
    } while (cursor);
  };

  const parentOf = (raw: any) => String(raw.ancestor_path || '').split('.').filter(Boolean);
  try {
    await loadThread(noteId);
    // A Map visits entries added during the loop, so replies found deeper get their turn too
    for (const [id, raw] of raws) {
      const shown = Array.from(raws.values()).filter(other => parentOf(other).pop() === id).length;
      if ((raw.children_count || 0) > shown) await loadThread(id);
    }
  } catch (error: any) {
    console.log(`[Fetcher] Note replies stopped early: ${error.message}`);
  }

  // Build the tree. A reply whose parent was not loaded (the request cap) hangs under its
  // nearest loaded ancestor, or at the top.
  const nodes = new Map<string, Comment>();
  for (const [id, raw] of raws) {
    if (raw.deleted || !String(raw.body || '').trim()) continue;
    nodes.set(id, noteReplyComment(raw));
  }
  const top: Comment[] = [];
  for (const [id, raw] of raws) {
    const node = nodes.get(id);
    if (!node) continue;
    const parentId = parentOf(raw).reverse().find(ancestor => ancestor !== noteId && nodes.has(ancestor));
    const parent = parentId ? nodes.get(parentId) : undefined;
    if (parent) (parent.replies ||= []).push(node);
    else top.push(node);
  }
  console.log(`[Fetcher] Note replies: ${nodes.size} in ${requests} request(s), ${top.length} at the top`);
  return top;
}

export interface SubstackNote {
  id: string;
  title?: string;
  author?: string;
  publishedDate?: string;
  content: Element;
}

/**
 * A Substack note (`substack.com/@name/note/c-123`): a short post without a title, inside
 * Substack's app shell. The page has no `.body.markup` box like a post, so the generic fallback
 * kept the whole shell: a promo banner, loading placeholders, "Log in or sign up", and a wrapper
 * with a fixed 420px right margin that pressed the text against the left edge on a phone (Will
 * MacAskill's note, 2026-10-06). The note's own text is the page's first `.FeedProseMirror` box:
 * a reply's page shows only the reply, and a quoted note comes after the note. The author, the
 * date, the text as plain paragraphs, and the attachments are in
 * `_preloads.feedData.feedItem.comment`. Attachments are appended after the text: an image, a
 * link to an attached post or page, and a quoted note as a blockquote. A video is left out.
 * Returns null for any page that is not a note.
 */
export function substackNote(html: string, doc: Document, url: string): SubstackNote | null {
  let path = '';
  try { path = new URL(url).pathname; } catch { return null; }
  const id = path.match(/\/note\/c-(\d+)/)?.[1];
  if (!id) return null;

  const comment = parseSubstackPreloads(html)?.feedData?.feedItem?.comment;
  const box = doc.querySelector('.FeedProseMirror');
  if (!comment && !box) return null;

  const content = doc.createElement('div');
  const addParagraphs = (parent: Element, text: string) => {
    text.split(/\n\s*\n/).map(part => part.trim()).filter(Boolean).forEach(part => {
      const p = doc.createElement('p');
      part.split('\n').forEach((line, i) => {
        if (i > 0) p.appendChild(doc.createElement('br'));
        p.appendChild(doc.createTextNode(line));
      });
      parent.appendChild(p);
    });
  };
  const addLink = (href: unknown, text: unknown) => {
    if (typeof href !== 'string' || !/^https?:\/\//i.test(href)) return;
    const p = doc.createElement('p');
    const a = doc.createElement('a');
    a.setAttribute('href', href);
    a.textContent = typeof text === 'string' && text.trim() ? text.trim() : href;
    p.appendChild(a);
    content.appendChild(p);
  };

  if (box) {
    content.append(...Array.from(box.childNodes));
  } else {
    addParagraphs(content, String(comment.body || ''));
  }

  for (const attachment of Array.isArray(comment?.attachments) ? comment.attachments : []) {
    if (attachment?.type === 'image' && typeof attachment.imageUrl === 'string') {
      const figure = doc.createElement('figure');
      const img = doc.createElement('img');
      img.setAttribute('src', attachment.imageUrl);
      img.setAttribute('alt', '');
      figure.appendChild(img);
      content.appendChild(figure);
    } else if (attachment?.type === 'post') {
      addLink(attachment.post?.canonical_url, attachment.post?.title);
    } else if (attachment?.type === 'link') {
      addLink(attachment.linkMetadata?.url, attachment.linkMetadata?.title);
    } else if (attachment?.type === 'comment' && attachment.comment?.body) {
      const quote = doc.createElement('blockquote');
      const name = attachment.comment.user?.name;
      if (typeof name === 'string' && name.trim()) {
        const p = doc.createElement('p');
        const strong = doc.createElement('strong');
        strong.textContent = name.trim();
        p.appendChild(strong);
        quote.appendChild(p);
      }
      addParagraphs(quote, String(attachment.comment.body));
      content.appendChild(quote);
    }
  }

  // A note has no title, so its first line stands in for one (cut at a word after 100
  // characters). Without any text the caller keeps the page title.
  const firstLine = String(comment?.body || box?.textContent || '')
    .split('\n').map(line => line.trim()).find(Boolean);
  const title = !firstLine || firstLine.length <= 100
    ? firstLine
    : firstLine.slice(0, 100).replace(/\s+\S*$/, '') + '...';
  const author = typeof comment?.name === 'string' && comment.name.trim() ? comment.name.trim() : undefined;
  const publishedDate = typeof comment?.date === 'string' ? comment.date : undefined;
  console.log(`[Fetcher] Substack note by ${author || '(unknown)'}, ${content.querySelectorAll('p').length} paragraph(s), ${comment?.attachments?.length || 0} attachment(s)`);
  return { id, title, author, publishedDate, content };
}

// --- SUBSTACK HELPERS END ---

// Flatten email-newsletter layout into normal block flow. Newsletters are built from
// nested fixed-width tables (600px scaffolding marked role="presentation") which refuse
// to shrink on narrow screens (horizontal scrollbar) and turn the whole email into ONE
// giant block for the read-along extractor. Gated on the presence of presentation
// tables, so ordinary articles pass through untouched. Runs at fetch/add time only;
// already-stored items keep their HTML (refetch to heal them).
// Normalize tweet embeds into ONE canonical structure so every later stage can
// rely on it: the reader CSS styles it as a card, the narration scriptwriter
// announces "A tweet by [author]", and read-along alignment keeps the whole
// tweet as a single element. Two shapes exist in the wild:
//  (A) Substack's server-rendered card: <div class="... twitter-embed" data-attrs="{json}">.
//      The data-attrs JSON carries the full structured tweet (name, username,
//      full_text, date, photos, like/reply counts, status url), so no fragile
//      HTML scraping is needed.
//  (B) The classic oEmbed fallback used by most other sites:
//      <blockquote class="twitter-tweet"><p>text</p>(dash) Name (@handle) <a>date</a></blockquote>.
// Both become:
//   <blockquote class="twitter-tweet">
//     <p class="tweet-author"><strong>Name</strong> <span class="tweet-handle">@handle</span></p>
//     <p>tweet text</p>
//     [<img class="tweet-photo" src="...">]
//     [nested quoted tweet]
//     <p class="tweet-footer"><a href="status-url">Month D, YYYY</a> • N likes • N replies</p>
//   </blockquote>
// Anything unparseable is left untouched (graceful degradation). Future fetches
// only, existing items need a refetch.
export function normalizeTweetEmbeds(root: Element): void {
  const doc = root.ownerDocument;
  if (!doc) return;

  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
    'August', 'September', 'October', 'November', 'December'];
  const formatDate = (iso: string | undefined): string | null => {
    if (!iso) return null;
    const d = new Date(iso);
    if (isNaN(d.getTime())) return null;
    return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
  };

  interface TweetData {
    name?: string;
    username?: string;
    text?: string;
    url?: string;
    dateIso?: string;
    dateText?: string;
    photos?: string[];
    likeCount?: number;
    replyCount?: number;
    quoted?: TweetData | null;
  }

  const buildTweet = (t: TweetData): HTMLElement | null => {
    if (!t.text?.trim() || !(t.name || t.username)) return null;
    const bq = doc.createElement('blockquote');
    bq.className = 'twitter-tweet';

    // Author line FIRST (like a real tweet card), so both the reader and the
    // narration lead with who is speaking.
    const author = doc.createElement('p');
    author.className = 'tweet-author';
    if (t.name) {
      const strong = doc.createElement('strong');
      strong.textContent = t.name;
      author.appendChild(strong);
    }
    if (t.username) {
      if (t.name) author.appendChild(doc.createTextNode(' '));
      const handle = doc.createElement('span');
      handle.className = 'tweet-handle';
      handle.textContent = `@${t.username}`;
      author.appendChild(handle);
    }
    bq.appendChild(author);

    for (const line of t.text.split(/\n+/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const p = doc.createElement('p');
      p.textContent = trimmed; // textContent, so raw tweet text can never inject HTML
      bq.appendChild(p);
    }

    for (const src of t.photos || []) {
      const img = doc.createElement('img');
      img.className = 'tweet-photo';
      img.setAttribute('src', src);
      img.setAttribute('alt', '');
      bq.appendChild(img);
    }

    if (t.quoted?.text) {
      const inner = buildTweet({ name: t.quoted.name, username: t.quoted.username, text: t.quoted.text });
      if (inner) {
        inner.className = 'twitter-tweet tweet-quoted';
        bq.appendChild(inner);
      }
    }

    const footerParts: (HTMLElement | string)[] = [];
    const dateText = t.dateText || formatDate(t.dateIso);
    if (dateText) {
      if (t.url) {
        const a = doc.createElement('a');
        a.setAttribute('href', t.url);
        a.textContent = dateText;
        footerParts.push(a);
      } else {
        footerParts.push(dateText);
      }
    }
    if (typeof t.likeCount === 'number' && t.likeCount > 0) {
      footerParts.push(`${t.likeCount} ${t.likeCount === 1 ? 'like' : 'likes'}`);
    }
    if (typeof t.replyCount === 'number' && t.replyCount > 0) {
      footerParts.push(`${t.replyCount} ${t.replyCount === 1 ? 'reply' : 'replies'}`);
    }
    if (footerParts.length > 0) {
      const footer = doc.createElement('p');
      footer.className = 'tweet-footer';
      footerParts.forEach((part, i) => {
        if (i > 0) footer.appendChild(doc.createTextNode(' • '));
        if (typeof part === 'string') footer.appendChild(doc.createTextNode(part));
        else footer.appendChild(part);
      });
      bq.appendChild(footer);
    }
    return bq;
  };

  // (A) Substack rich cards (modern "twitter-embed" and older "tweet" class names)
  root.querySelectorAll('div.twitter-embed[data-attrs], div.tweet[data-attrs]').forEach(el => {
    try {
      const attrs = JSON.parse(el.getAttribute('data-attrs') || '');
      const photos = Array.isArray(attrs.photos)
        ? attrs.photos
          .map((p: any) => (typeof p === 'string' ? p : p?.url || p?.media_url_https))
          .filter((s: any) => typeof s === 'string' && /^https?:\/\//.test(s))
        : [];
      const quoted = attrs.quoted_tweet?.full_text
        ? { name: attrs.quoted_tweet.name, username: attrs.quoted_tweet.username, text: attrs.quoted_tweet.full_text }
        : null;
      const bq = buildTweet({
        name: attrs.name,
        username: attrs.username,
        text: attrs.full_text,
        url: attrs.url,
        dateIso: attrs.date,
        photos,
        likeCount: attrs.like_count,
        replyCount: attrs.reply_count,
        quoted,
      });
      if (bq) el.replaceWith(bq);
    } catch {
      // Malformed data-attrs: leave the original markup in place
    }
  });

  // (B) Classic oEmbed blockquotes: restructure so the author leads. The
  // attribution line looks like "(em/en dash or hyphen) Name (@handle)" with the
  // status link holding the date.
  root.querySelectorAll('blockquote.twitter-tweet').forEach(el => {
    if (el.querySelector('.tweet-author')) return; // already canonical
    const m = (el.textContent || '').match(/[\u2014\u2013-]\s*([^(\u2014\u2013]+?)\s*\(@([A-Za-z0-9_]+)\)/);
    if (!m) return; // unknown shape, leave as-is
    const statusLink = Array.from(el.querySelectorAll('a'))
      .find(a => /(?:twitter\.com|x\.com)\/[^/]+\/status\//.test(a.getAttribute('href') || ''));
    const text = Array.from(el.querySelectorAll('p'))
      .map(p => p.textContent?.trim() || '')
      .filter(Boolean)
      .join('\n');
    if (!text) return;
    const bq = buildTweet({
      name: m[1].trim(),
      username: m[2],
      text,
      url: statusLink?.getAttribute('href') || undefined,
      dateText: statusLink?.textContent?.trim() || undefined,
    });
    if (bq) el.replaceWith(bq);
  });
}

// Layout tables used by email builders. `role="presentation"` is the standards-based
// marker, but Mailchimp never sets it: it uses its own ids and classes instead
// (#bodyTable, .templateContainer, .columnWrapper, and the mcn* block classes). One real
// campaign page held 31 tables, 29 of which match this list and none of which held data.
const EMAIL_LAYOUT_TABLES =
  'table[role="presentation"], table#bodyTable, table.templateContainer, table.columnWrapper, table[class*="mcn"]';

export function flattenEmailTables(root: Element): void {
  if (!root.querySelector(EMAIL_LAYOUT_TABLES)) return;
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
  const tables = Array.from(root.querySelectorAll(EMAIL_LAYOUT_TABLES)).reverse();
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

// Elements whose inline sizing describes the media itself. The reader's CSS already caps and
// unpositions images, and the Markdown export keeps a figure's percentage width.
const MEDIA_TAGS = new Set(['img', 'picture', 'source', 'video', 'audio', 'iframe', 'svg', 'canvas', 'figure']);

// The lengths in a CSS value, in px (em and rem as 16px, pt as 4/3 px). Percentages and
// viewport units are reported separately, since they size against the site's own layout.
function cssLengths(value: string): { px: number[]; relative: boolean } {
  const px: number[] = [];
  let relative = false;
  for (const m of value.matchAll(/(-?\d*\.?\d+)(px|em|rem|pt|%|vw|vh|vmin|vmax)/gi)) {
    const n = Math.abs(parseFloat(m[1]));
    const unit = m[2].toLowerCase();
    if (unit === 'px') px.push(n);
    else if (unit === 'em' || unit === 'rem') px.push(n * 16);
    else if (unit === 'pt') px.push(n * 4 / 3);
    else relative = true;
  }
  return { px, relative };
}

/**
 * Strip inline page-layout styles that a phone reader cannot carry. Sites set them for their
 * own desktop layout: a Substack note's wrapper had `margin-right: 420px`, which pressed the
 * text against the left edge on a phone (2026-10-06), and image wrappers use
 * `position: relative; padding-bottom: 56.25%; height: 0`. A survey of 45 articles
 * (2026-10-06, the newest item of 24 feeds, the Hacker News front page, and known odd pages)
 * found these on 10 sites. Removed:
 * - positioning: position, top, right, bottom, left, inset, z-index, transform, float,
 * - multi-column and flex/grid layout: columns, and display flex/grid (blocks stack instead),
 * - white-space: nowrap (one line that scrolls sideways), while pre, pre-wrap, pre-line stay,
 * - margins and paddings with a percentage, a viewport unit, or a length over 48px
 *   (small ones stay, so an indent of 40px survives),
 * - on anything but media: widths over 320px and fixed heights.
 * Everything else stays: text styling, max-width, overflow, display none (hidden content), and
 * the sizes of images, figures and other media. Only `style` attributes change, never the text.
 */
export function stripLayoutStyles(root: Element | Document): void {
  root.querySelectorAll('[style]').forEach((el) => {
    const style = el.getAttribute('style');
    if (!style) return;
    const isMedia = MEDIA_TAGS.has(el.tagName.toLowerCase());
    const kept = style
      .split(';')
      .map((d) => d.trim())
      .filter(Boolean)
      .filter((d) => {
        const colon = d.indexOf(':');
        if (colon < 0) return true;
        const prop = d.slice(0, colon).trim().toLowerCase();
        const value = d.slice(colon + 1).trim().toLowerCase();
        if (/^(position|top|right|bottom|left|inset|z-index|transform|float|columns|column-count|column-width)$/.test(prop)) return false;
        if (prop === 'display' && /\b(flex|grid)\b/.test(value)) return false;
        if (prop === 'white-space' && value.startsWith('nowrap')) return false;
        if (/^(margin|padding)(-(top|right|bottom|left|block|inline)(-(start|end))?)?$/.test(prop)) {
          const { px, relative } = cssLengths(value);
          return !relative && px.every((n) => n <= 48);
        }
        if (!isMedia && (prop === 'width' || prop === 'min-width')) {
          const { px, relative } = cssLengths(value);
          return !/v(w|h|min|max)/.test(value) && (relative || px.every((n) => n <= 320));
        }
        if (!isMedia && /^(min-|max-)?height$/.test(prop)) {
          return cssLengths(value).px.length === 0 && !/v(h|w|min|max)/.test(value);
        }
        return true;
      });
    if (kept.length > 0) el.setAttribute('style', kept.join('; '));
    else el.removeAttribute('style');
  });
}

/**
 * Author from the page's schema.org JSON-LD block.
 *
 * Used as a last resort, only when no author meta tag and no byline element carried one.
 * Compact publishes the author ONLY here (`{"@type":"Article","author":{"@type":"Person",
 * "name":"William Thibeau"}}`, no `meta[name="author"]`), which is why its byline came back
 * empty. Reading the standard block fixes that site and every other one that follows the
 * same schema, instead of a selector that only ever works on one domain.
 *
 * Only Article-shaped nodes are read and only a name is returned, so a publisher or a
 * website node can never land in the author field. A malformed block is skipped, never
 * thrown: a broken script tag must not break the whole fetch.
 *
 * MUST be called BEFORE the fetcher strips <script> elements from the document.
 */
export function authorFromJsonLd(doc: Document): string | undefined {
  const ARTICLE_TYPES = new Set([
    'article', 'newsarticle', 'blogposting', 'report', 'techarticle', 'socialmediaposting',
  ]);

  for (const script of Array.from(doc.querySelectorAll('script[type="application/ld+json"]'))) {
    let parsed: any;
    try {
      parsed = JSON.parse(script.textContent || '');
    } catch {
      continue;
    }

    // A block holds one object, an array of them, or a @graph wrapper.
    const nodes: any[] = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed?.['@graph'])
        ? parsed['@graph']
        : [parsed];

    for (const node of nodes) {
      const types = [node?.['@type']].flat().filter(Boolean).map((t: any) => String(t).toLowerCase());
      if (!types.some(t => ARTICLE_TYPES.has(t))) continue;

      for (const candidate of [node?.author].flat().filter(Boolean)) {
        const name = typeof candidate === 'string'
          ? candidate
          : typeof candidate?.name === 'string' ? candidate.name : '';
        const trimmed = name.trim();
        if (trimmed && trimmed.length <= 120) return trimmed;
      }
    }
  }

  return undefined;
}

/** archive.is and its mirror domains, which all serve the same rebuilt-page markup. */
export function isArchiveMirrorUrl(url: string): boolean {
  try {
    return /(^|\.)archive\.(is|ph|today|li|vn|fo|md)$/i.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

/**
 * True when an archive.is answer holds a real snapshot. archive.is puts every copy it serves
 * inside `<div id="CONTENT">`, and a server placeholder has no such box (seen 2026-09-14: a
 * plain fetch of a snapshot came back as nginx's 612-byte "Welcome to nginx" page, HTTP 200).
 */
export function isArchiveSnapshot(doc: Document): boolean {
  return !!doc.querySelector('#CONTENT');
}

/**
 * An element that holds a page's reader comments. Judged by id only, because an archive.is copy
 * keeps ids and drops every class name: any id containing "comments" (FT's `#o-comments-stream`,
 * the common `#comments`), the Coral embed (`#coral...`) and Disqus (`#disqus_thread`).
 * Wallacast collects comments itself only for the forums and Substack. Comments embedded in any
 * other page are noise that would otherwise be narrated as part of the article.
 *
 * An aria-label is deliberately NOT read: the New York Times labels a reporter's note inside its
 * story "Comments" (`<ol aria-label="Comments">`, the reporter writing about the interview), and
 * that is editorial text, not reader comments.
 */
export function isCommentArea(el: Element): boolean {
  const id = el.id || '';
  return /comments/i.test(id) || /^coral/i.test(id) || id === 'disqus_thread';
}

/** True when el, or one of its ancestors below `stop`, is a comment area. */
function insideCommentArea(el: Element, stop: Element | null = null): boolean {
  for (let x: Element | null = el; x && x !== stop; x = x.parentElement) {
    if (isCommentArea(x)) return true;
  }
  return false;
}

/** Removes every comment area inside root (see isCommentArea). Returns how many went. */
export function removeCommentAreas(root: Element): number {
  let removed = 0;
  for (const el of Array.from(root.querySelectorAll('[id]'))) {
    if (!root.contains(el) || !isCommentArea(el)) continue; // already gone with an outer area
    el.remove();
    removed++;
  }
  return removed;
}

// Links that open a share dialog on another service. Judged by the address, because the link
// text varies per site ("Share on X", FT's "<title> on x (opens in a new window)") and archive.is
// drops the class names a share bar usually carries, while the address survives both (archive.is
// keeps it inside its own `/o/<id>/` redirect). A `mailto:` share has no recipient, so an
// ordinary "email the author" link never matches.
const SHARE_LINK_PATTERNS: RegExp[] = [
  /(?:^|[/.])(?:twitter|x)\.com\/(?:intent\/(?:tweet|post)|share)(?:[/?#]|$)/i,
  /(?:^|[/.])facebook\.com\/(?:sharer|share\.php|dialog\/(?:share|feed))/i,
  /(?:^|[/.])linkedin\.com\/(?:sharing\/share-offsite|shareArticle)/i,
  /^whatsapp:\/\/send/i,
  /(?:^|[/.])(?:api\.whatsapp\.com\/send|wa\.me\/\?)/i,
  /(?:^|[/.])reddit\.com\/submit/i,
  /(?:^|[/.])(?:t|telegram)\.me\/share/i,
  /(?:^|[/.])bsky\.app\/intent\/compose/i,
  /(?:^|[/.])pinterest\.[a-z.]+\/pin\/create/i,
  /(?:^|[/.])threads\.(?:net|com)\/intent\/post/i,
  /(?:^|[/.])news\.ycombinator\.com\/submitlink/i,
  /^mailto:\?/i,
];

/**
 * Removes share links (see SHARE_LINK_PATTERNS), plus the list items, lists and bars they leave
 * with nothing in them. Returns how many links went.
 */
export function removeShareLinks(root: Element): number {
  let removed = 0;
  for (const link of Array.from(root.querySelectorAll('a[href]'))) {
    const href = link.getAttribute('href') || '';
    if (!SHARE_LINK_PATTERNS.some(re => re.test(href))) continue;
    let parent: Element | null = link.parentElement;
    link.remove();
    removed++;
    while (
      parent && parent !== root &&
      !(parent.textContent || '').trim() &&
      !parent.querySelector('img, picture, video, audio, iframe')
    ) {
      const up: Element | null = parent.parentElement;
      parent.remove();
      parent = up;
    }
  }
  return removed;
}

// Class names that hide an element in the site's own print stylesheet: Nine's `noPrint`
// (smh.com.au, The Age), Bootstrap's `d-print-none` and `hidden-print`, Tailwind's
// `print:hidden`, and the usual spellings. A site leaves out of print exactly what is not the
// article: ads, video players, save and share bars, related-story boxes.
const PRINT_HIDDEN_SELECTOR =
  '.noPrint, .noprint, .no-print, .d-print-none, .hidden-print, .print-hidden, .print\\:hidden';

/** Characters of text inside el, whitespace not counted (page markup is full of indentation). */
const textChars = (el: Element) => (el.textContent || '').replace(/\s+/g, '').length;

/**
 * Removes what the site hides when printing (see PRINT_HIDDEN_SELECTOR). An element holding more
 * than a third of the text stays, so a site that marks its whole story body never loses it.
 * Returns how many elements went.
 *
 * smh.com.au, 2026-10-07: every piece of furniture inside its story box carries `noPrint` (7
 * "Advertisement" labels, an empty video player, two "maximum number of saved items" tooltips,
 * related-story boxes, ad widgets), and no paragraph of the story does.
 */
export function removePrintHidden(root: Element): number {
  const totalText = textChars(root);
  let removed = 0;
  for (const el of Array.from(root.querySelectorAll(PRINT_HIDDEN_SELECTOR))) {
    if (!root.contains(el)) continue; // already gone with an outer match
    if (textChars(el) > totalText / 3) continue;
    el.remove();
    removed++;
  }
  return removed;
}

// Text a player box may hold besides its video ("Loading", "Play", a duration) before it counts
// as holding something else, such as a caption worth keeping.
const PLAYER_TEXT_MAX_CHARS = 30;

/**
 * Removes video players with no video file: a `<video>` without `src` and without a
 * `<source src>`, whose file only the site's own script loads (Brightcove, JW Player). The reader
 * shows them as an empty player with the site's "Loading" text. The player box goes too, up to
 * the first ancestor that holds more than a few words or any other media. A video with a file
 * stays. Returns how many players went.
 */
export function removeEmptyVideoPlayers(root: Element): number {
  let removed = 0;
  for (const video of Array.from(root.querySelectorAll('video'))) {
    if (!root.contains(video)) continue;
    if (video.getAttribute('src') || video.querySelector('source[src]')) continue;
    let box: Element = video;
    for (let parent = box.parentElement; parent && parent !== root; parent = parent.parentElement) {
      const otherText = textChars(parent) - textChars(box);
      const otherMedia = Array.from(parent.querySelectorAll('img, picture, video, audio, iframe'))
        .some(m => !box.contains(m));
      if (otherText > PLAYER_TEXT_MAX_CHARS || otherMedia) break;
      box = parent;
    }
    box.remove();
    removed++;
  }
  return removed;
}

// Names pages give their story body. They are ids and attributes, not class names, so an
// archive.is copy keeps them: FT's `#article-body`, the New York Times' `<section
// name="articleBody">`, and schema.org's `itemprop="articleBody"`.
const STORY_BODY_MARKERS =
  '[itemprop="articleBody"], section[name="articleBody"], #article-body, #articleBody, #article_body';
const MIN_STORY_BODY_CHARS = 500;

/**
 * The element a page marks as its story body (see STORY_BODY_MARKERS), or null.
 *
 * Only an unambiguous marker counts: exactly one outermost match (a marker inside another marker
 * is part of the same body), outside the comments, with at least 500 characters of text. A body
 * split over several markers gives null, since keeping one part would drop the rest.
 */
export function findStoryBody(doc: Document): Element | null {
  return singleMarkedBox(doc, STORY_BODY_MARKERS);
}

function singleMarkedBox(doc: Document, markers: string): Element | null {
  const found = Array.from(doc.querySelectorAll(markers));
  const outermost = found.filter(el => !found.some(other => other !== el && other.contains(el)));
  if (outermost.length !== 1) return null;
  const body = outermost[0];
  if (insideCommentArea(body)) return null;
  return (body.textContent || '').trim().length >= MIN_STORY_BODY_CHARS ? body : null;
}

// The box that blog templates put one post in: Blogger's `.post` (with `.post-body` inside),
// WordPress's `.entry-content`, and the `.post` and `.post-content` of Jekyll and Ghost themes.
const BLOG_POST_MARKERS = '.post, .post-body, .post-content, .entry-content';

/**
 * The one blog post on a page that has neither an `<article>` nor a `<main>`, or null. Such a
 * page used to be kept whole: robert.ocallahan.org puts its full archive of post titles (120 KB
 * of links) before the post, so a copy to Obsidian opened with years of titles (2026-10-06).
 * The same rule as findStoryBody applies: exactly one outermost match, outside the comments,
 * with at least 500 characters of text.
 */
export function blogPostBox(doc: Document): Element | null {
  return singleMarkedBox(doc, BLOG_POST_MARKERS);
}

const MIN_NESTED_STORY_CHARS = 1000;

/**
 * The story inside a page-sized <article>, or null.
 *
 * FT wraps its WHOLE page in `<article id="site-content">` (the photo, two share bars, the
 * byline, a newsletter ad, the story, the topic list, 97 reader comments) and puts the story
 * itself in a second `<article>` inside it, so taking the outer one kept all of that. The inner
 * one wins when it is the only nested article of real length (1,000+ characters, so teaser cards
 * never qualify) outside the comments, and it holds at least half of the outer article's text
 * once the comment areas are left out (on FT the comments alone were 87% of the page).
 */
export function nestedStoryArticle(article: Element): Element | null {
  const long = Array.from(article.querySelectorAll('article')).filter(el =>
    !insideCommentArea(el, article) && (el.textContent || '').trim().length >= MIN_NESTED_STORY_CHARS);
  const candidates = long.filter(el => !long.some(other => other !== el && other.contains(el)));
  if (candidates.length !== 1) return null;
  const story = candidates[0];
  const withoutComments = article.cloneNode(true) as Element;
  removeCommentAreas(withoutComments);
  const outerLen = (withoutComments.textContent || '').trim().length;
  return (story.textContent || '').trim().length >= outerLen * 0.5 ? story : null;
}

/**
 * The publication date an archive.is copy still carries in its own page, or null.
 *
 * archive.is replaces a page's meta tags with its own, so `article:published_time` becomes the
 * moment of archiving (FT, 2026-09-14: 23:43 UTC for a piece published at 17:16 UTC, and a New
 * York Times copy was five days off). The page's own `<time datetime>` survives inside the
 * snapshot box. Exactly ONE candidate is read: the first one outside the comments within the
 * page's first `<article>`, or within the whole snapshot when that article has none. It is never
 * passed over for a later one, because a later date on the page usually belongs to a
 * related-story teaser (The Information's did). The candidate is rejected when it does not parse
 * or is later than the archiving itself, and the caller then keeps the archive time. A date
 * without a time becomes noon UTC, so it shows as the same day in every time zone.
 */
export function archivedPublishedDate(doc: Document, archivedAt?: string | null): string | null {
  const snapshot = doc.querySelector('#CONTENT');
  if (!snapshot) return null;
  const firstDate = (scope: Element) =>
    Array.from(scope.querySelectorAll('time[datetime]')).find(t => !insideCommentArea(t, snapshot)) || null;
  const article = snapshot.querySelector('article');
  const time = (article && firstDate(article)) || firstDate(snapshot);
  if (!time) return null;

  let raw = (time.getAttribute('datetime') || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) raw += 'T12:00:00Z';
  // "5:40pm PDT" only parses with a space before the am/pm, and The Information writes none.
  const ms = Date.parse(raw.replace(/(\d)([ap]m)\b/i, '$1 $2'));
  if (Number.isNaN(ms)) return null;
  const archivedMs = archivedAt ? Date.parse(archivedAt) : NaN;
  if (!Number.isNaN(archivedMs) && ms > archivedMs + 60_000) return null;
  return new Date(ms).toISOString();
}

/**
 * The lead photo of an archive.is copy: the first `<figure>` holding an image that comes before
 * the story's first paragraph, outside the comments. Null when there is none.
 *
 * archive.is swaps the page's `og:image` for a screenshot of the archived page, which then became
 * the library thumbnail. Checked on five archive copies (2026-09-14): FT, the New York Times, the
 * Washington Post and The Information each got their real lead photo, and Compact (no figure
 * before its story) got none. "The first image on the page" would have been wrong: on the Times
 * the first two images are archive.is's pictures of a blocked embed (Chromium's
 * "static01.nyt.com is blocked" page), which is why only a <figure> counts.
 */
export function archivedLeadFigure(doc: Document, storyStart: Element | null): Element | null {
  const snapshot = doc.querySelector('#CONTENT');
  if (!snapshot || !storyStart) return null;
  for (const figure of Array.from(snapshot.querySelectorAll('figure'))) {
    // Figures come in document order, so the first one at or after the story text ends the search.
    if (!(figure.compareDocumentPosition(storyStart) & 4 /* DOCUMENT_POSITION_FOLLOWING */)) break;
    if (insideCommentArea(figure, snapshot)) continue;
    if (figure.querySelector('img[src]')) return figure;
  }
  return null;
}

/**
 * Tufte-style sidenotes become an ordinary footnote section.
 *
 * Sites built on Tufte CSS (collusion.wiki, many research blogs) put the whole note inside
 * the sentence and lean on their own stylesheet to place it:
 *
 *   <label for="fn-1" class="margin-toggle sidenote-number" data-n="1"></label>
 *   <input type="checkbox" id="fn-1" class="margin-toggle">
 *   <span class="sidenote" data-n="1">the note</span>
 *
 * The label is EMPTY (its number is drawn by CSS from data-n) and the checkbox only exists so
 * a phone can toggle the note. We keep the body but not the site's stylesheet, so all of that
 * arrived as bare checkboxes scattered through the text, with the note itself spliced into the
 * middle of the sentence and no marker anywhere. The narration read it that way too.
 *
 * Each note becomes the canonical shape the reader and the Markdown export already handle: a
 * numbered `<sup>` marker where the note sat, and the note in a `<section class="footnotes">`
 * at the end with a back-link. Notes are renumbered 1..N in document order, so a Tufte dagger
 * or asterisk becomes a number like every other footnote.
 */
export function normalizeSidenotes(root: Element): void {
  const doc = root.ownerDocument;
  if (!doc) return;
  const notes = Array.from(root.querySelectorAll('span.sidenote, span.marginnote'));
  if (notes.length === 0) return;

  const list = doc.createElement('ol');

  notes.forEach((note, i) => {
    const n = i + 1;

    // The toggle pair sits immediately before the note and carries no text of its own.
    let prev = note.previousElementSibling;
    while (
      prev &&
      (prev.nodeName === 'INPUT' || prev.nodeName === 'LABEL') &&
      (prev.getAttribute('class') || '').includes('margin-toggle')
    ) {
      const before = prev.previousElementSibling;
      prev.remove();
      prev = before;
    }

    const body = note.innerHTML;

    const sup = doc.createElement('sup');
    sup.className = 'footnote-ref';
    sup.id = `fnref-side-${n}`;
    const link = doc.createElement('a');
    link.setAttribute('href', `#fn-side-${n}`);
    link.textContent = `[${n}]`;
    sup.appendChild(link);
    note.replaceWith(sup);

    const li = doc.createElement('li');
    li.id = `fn-side-${n}`;
    li.innerHTML = body;
    li.appendChild(doc.createTextNode(' '));
    const back = doc.createElement('a');
    back.setAttribute('href', `#fnref-side-${n}`);
    back.className = 'footnote-backref';
    back.textContent = '↩';
    li.appendChild(back);
    list.appendChild(li);
  });

  const section = doc.createElement('section');
  section.className = 'footnotes';
  section.appendChild(doc.createElement('hr'));
  section.appendChild(list);
  root.appendChild(section);

  console.log(`[Fetcher] Converted ${notes.length} sidenote(s) into a footnotes section`);
}

/**
 * Rebuild paragraphs in an archive.is-style mirror.
 *
 * The mirror keeps the words but throws away the structure: every block becomes a generic
 * <div> carrying a wall of inline styles (fixed widths, flex, colours), and the copy holds
 * zero <p> elements. The reader then shows one undivided wall of text, and read-along gets
 * a single element for the whole article. For these hosts only, the mirror's inline styles
 * are dropped (our reader supplies its own) and every text-only <div> becomes a <p>.
 *
 * UNTESTED beyond one Compact mirror (2026-08-28). Menu lines and captions inside the
 * mirror become paragraphs too, so expect some leftover noise at the top of such items.
 */
export function restoreArchivedParagraphs(root: Element): void {
  const doc = root.ownerDocument!;

  // The mirror's inline styles fight the reader's own layout, and none of them carry
  // meaning we want to keep.
  root.querySelectorAll('[style]').forEach(el => el.removeAttribute('style'));

  const BLOCK_CHILD = 'div, p, section, article, main, ul, ol, table, blockquote, figure, pre, h1, h2, h3, h4, h5, h6';
  for (const div of Array.from(root.querySelectorAll('div'))) {
    if (div.querySelector(BLOCK_CHILD)) continue;          // a wrapper, not a leaf
    if (!(div.textContent || '').trim()) continue;         // empty spacer
    const p = doc.createElement('p');
    while (div.firstChild) p.appendChild(div.firstChild);
    div.replaceWith(p);
  }
}

/** The text a page shows: scripts, styles and tags removed, whitespace collapsed. */
function visiblePageText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Titles of bot-check pages, also checked on the reader proxy's Markdown answer
const BOT_CHECK_TITLE = /^(just a moment|attention required|verifying you are human|checking your browser|access denied|human verification)/i;

/**
 * A bot-check page served in place of the article: Cloudflare's "Just a moment..." JavaScript
 * challenge, its older "Attention Required!" block page, DataDome's "Please enable JS and
 * disable any ad blocker" page (wsj.com answers our requests with it and HTTP 401, seen
 * 2026-10-06), AWS WAF's "Human Verification" captcha (knack.be answers with it and HTTP 405,
 * 2026-10-07), and similar walls. Such a page has almost no visible text. Most normal pages
 * behind Cloudflare also load its challenge-platform script, so that script alone never counts,
 * only a short page with a bot-check title or text.
 */
export function isBotCheckPage(html: string): boolean {
  const title = (html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] || '').trim();
  const text = visiblePageText(html);
  if (text.length > 3000) return false;
  return BOT_CHECK_TITLE.test(title)
    || /enable javascript and cookies to continue|verifying you are human|checking if the site connection is secure|checking your browser before accessing|please enable js and disable any ad blocker/i.test(text);
}

/**
 * A login form served in place of the article: a password field on a page with little text.
 * knack.be answered our server with Roularta's "Vul hier je e-mailadres en wachtwoord in"
 * login page (12.8 KB, 2026-10-07), which was stored as the article. A real article page that
 * hides a login dialog in its markup holds far more text than 3,000 characters.
 */
export function isLoginWall(html: string): boolean {
  return /<input\b[^>]*\btype\s*=\s*["']?password\b/i.test(html) && visiblePageText(html).length < 3000;
}

/** True when a page body shows (almost) no text: fewer than 20 letters and digits, the title not counted. */
export function hasNoText(html: string): boolean {
  const body = html.replace(/<head[\s\S]*?<\/head>/i, ' ');
  return (visiblePageText(body).match(/[\p{L}\p{N}]/gu) || []).length < 20;
}

/**
 * The continue link of DPG Media's cookie consent page, or null for any other page. DPG sites
 * (hln.be, demorgen.be, humo.be, ad.nl, volkskrant.nl and more) redirect a visitor without the
 * consent cookie to myprivacy.dpgmedia.be, whose script sends the browser on to
 * `callbackUrl`: the site's own `privacy-gate/accept-tcf2` (or `privacygate-confirm`) address
 * with an `authId`. That address sets the cookie and redirects to the article. The page writes
 * the link as `decodeURIComponent('...')`. Only a link back to an https site counts.
 */
export function dpgPrivacyGateCallback(pageUrl: string, html: string): string | null {
  let host = '';
  try { host = new URL(pageUrl).hostname; } catch { return null; }
  if (host !== 'myprivacy.dpgmedia.be' && !/<title>\s*DPG Media Privacy Gate\s*<\/title>/i.test(html)) return null;
  const encoded = html.match(/callbackUrl\s*=\s*new URL\(decodeURIComponent\('([^']+)'\)\)/)?.[1];
  if (!encoded) return null;
  try {
    const callback = new URL(decodeURIComponent(encoded));
    if (callback.protocol !== 'https:' || callback.hostname.endsWith('dpgmedia.be')) return null;
    return callback.toString();
  } catch {
    return null;
  }
}

/** An archive.ph address that opens its "archive this page" form with url filled in and starts it. */
export function archiveSubmitUrl(url: string): string {
  return `https://archive.ph/?run=1&url=${encodeURIComponent(url)}`;
}

/**
 * A fetch that found no usable copy of the article (a bot check, a login form, or a page
 * without text, with no other copy anywhere). Carries the archive.ph address that makes a copy,
 * so the Add tab can offer it: once archive.ph holds a copy, adding the article again finds it.
 */
export class ArticleUnavailableError extends Error {
  readonly archiveSubmitUrl: string;
  constructor(message: string, url: string) {
    super(message);
    this.name = 'ArticleUnavailableError';
    this.archiveSubmitUrl = archiveSubmitUrl(url);
  }
}

/**
 * True when a page says part of it is for subscribers only and that part is missing from the
 * HTML we got. News sites mark the paid part for search engines with schema.org JSON-LD:
 * `hasPart: { isAccessibleForFree: false, cssSelector: ".paywall" }`. A copy made without a
 * subscription (the Wayback Machine's copy of a wsj.com article, 2026-10-06) leaves that
 * element out and holds only the first few paragraphs. A page that ships the paid part and
 * hides it with CSS still has the element, so it does not count.
 */
export function isPaywallPreview(html: string): boolean {
  if (!/isAccessibleForFree/i.test(html)) return false;
  const doc = new JSDOM(html).window.document;
  const selectors: string[] = [];
  const visit = (node: any): void => {
    if (Array.isArray(node)) { node.forEach(visit); return; }
    if (!node || typeof node !== 'object') return;
    const free = node.isAccessibleForFree;
    if ((free === false || String(free).toLowerCase() === 'false') && typeof node.cssSelector === 'string') {
      selectors.push(node.cssSelector);
    }
    Object.values(node).forEach(visit);
  };
  doc.querySelectorAll('script[type="application/ld+json"]').forEach(script => {
    try {
      visit(JSON.parse(script.textContent || ''));
    } catch {
      // A malformed block says nothing about a paywall
    }
  });
  if (selectors.length === 0) return false;
  return selectors.every(selector => {
    try {
      const parts = Array.from(doc.querySelectorAll(selector));
      return parts.every(el => (el.textContent || '').trim().length < 200);
    } catch {
      return false; // A selector jsdom cannot read proves nothing
    }
  });
}

// markdownToHtml() needs a DOMParser, which Node lacks. markdown-export.ts installs the same
// jsdom parser, installing it here too keeps the fetcher independent of import order.
setHtmlParser(new (new JSDOM('').window.DOMParser)());

// The reader proxy's Markdown answer as a small HTML page, so the usual pipeline reads its
// title, date, and lead image from the same meta tags a real page carries.
export function readerMarkdownPage(md: { title: string | null; publishedTime: string | null; markdown: string }): string {
  const attr = (value: string) => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  const leadImage = md.markdown.match(/!\[[^\]]*\]\((https?:\/\/[^)\s]+)/)?.[1];
  const head = [
    md.title ? `<title>${attr(md.title)}</title><meta property="og:title" content="${attr(md.title)}">` : '',
    md.publishedTime ? `<meta property="article:published_time" content="${attr(md.publishedTime)}">` : '',
    leadImage ? `<meta property="og:image" content="${attr(leadImage)}">` : '',
  ].join('');
  return `<!DOCTYPE html><html><head>${head}</head><body><article>${markdownToHtml(md.markdown)}</article></body></html>`;
}

// A paid page without a selector for its paid part holds only its preview below this much
// story text (see isPaidPreview). HLN+ ships 850 characters for an article of 5,132.
const PAID_PREVIEW_MAX_STORY_CHARS = 1500;
// A copy found for a paid preview must hold this much more story text than the preview did,
// or it is the same preview again (archive copies of a paywall page exist too).
const PAID_COPY_MIN_EXTRA_CHARS = 1000;

/** Text characters inside root outside links, scripts and styles, whitespace not counted. */
function nonLinkTextChars(root: Element): number {
  let chars = 0;
  const walker = root.ownerDocument.createTreeWalker(root, 4 /* NodeFilter.SHOW_TEXT */);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.parentElement?.closest('a, script, style, noscript')) continue;
    chars += (node.nodeValue || '').replace(/\s+/g, '').length;
  }
  return chars;
}

/**
 * How much reader text the page's story holds: the most non-link text of any `<article>`,
 * `<main>` or schema.org articleBody box, else of the body. Link text never counts, because
 * menus and lists of other articles are links: on HLN's article page the story box counts 850
 * characters (the intro, the byline, labels) and its 17 teaser links count nothing.
 */
export function storyTextChars(html: string): number {
  const doc = new JSDOM(html).window.document;
  const boxes = Array.from(doc.querySelectorAll('article, main, [itemprop="articleBody"]'));
  if (boxes.length === 0) return doc.body ? nonLinkTextChars(doc.body) : 0;
  return Math.max(...boxes.map(nonLinkTextChars));
}

/**
 * True when the page is a paid article and holds only its preview: either isPaywallPreview (the
 * paid part named by its selector is missing), or a JSON-LD node says `isAccessibleForFree`
 * false (a boolean, or a string in any case) without naming the paid part, and the story holds
 * under 1,500 characters. HLN+ marks its articles that second way and ships only the intro
 * (2026-10-07). Sites that ship the whole paid part and hide it with CSS (smh.com.au, axios.com,
 * demorgen.be) are never previews.
 */
export function isPaidPreview(html: string): boolean {
  if (!/isAccessibleForFree/i.test(html)) return false;
  if (isPaywallPreview(html)) return true;
  const doc = new JSDOM(html).window.document;
  let paid = false;
  let named = false;
  const visit = (node: any): void => {
    if (Array.isArray(node)) { node.forEach(visit); return; }
    if (!node || typeof node !== 'object') return;
    const free = node.isAccessibleForFree;
    if (free === false || String(free).toLowerCase() === 'false') {
      paid = true;
      if (typeof node.cssSelector === 'string') named = true;
    }
    Object.values(node).forEach(visit);
  };
  doc.querySelectorAll('script[type="application/ld+json"]').forEach(script => {
    try {
      visit(JSON.parse(script.textContent || ''));
    } catch {
      // A malformed block says nothing about a paywall
    }
  });
  return paid && !named && storyTextChars(html) < PAID_PREVIEW_MAX_STORY_CHARS;
}

type Wall = 'bot check' | 'login' | 'no text' | 'paywall';

/**
 * For a page that is not the article: a bot-check page, a login form, a page without text, or
 * the preview of a paid article (`wall` names which). It looks for another copy, each step
 * running only when the one before failed or gave a copy that is no good:
 * - the reader proxy's HTML (the whole page, so the usual cleanup and metadata apply),
 * - the newest Wayback Machine copy (the page's own HTML, author and date included),
 * - the newest archive.ph copy (the full text of paywalled articles, where the Wayback copy of
 *   a wsj.com article held only its first four paragraphs, 2026-10-06),
 * - the reader proxy's Markdown, rendered in a real browser (works for brand-new articles the
 *   archives do not hold yet, but names no author).
 * For a paid preview archive.ph goes first, since it is the step that holds paid text, and the
 * reader proxy's Markdown is left out, because nothing in it shows whether it is the preview
 * again. A copy is no good when it is a bot-check page, a login form, a page without text or a
 * paid preview, and for a paid preview also when it holds less than 1,000 characters more story
 * than the preview (`previewChars`).
 *
 * Throws an ArticleUnavailableError when no step yields the article, so none of these pages is
 * ever stored as the article. Returns the HTML and the address to read it as: the article's own,
 * or the archive.ph snapshot's, since an archive.ph copy has its own markup and links and is
 * read exactly like a pasted archive link.
 */
async function fetchPastBotWall(
  url: string,
  wall: Wall = 'bot check',
  previewChars = 0
): Promise<{ html: string; pageUrl: string }> {
  const tried: string[] = [];
  // Why a copy is no good, or null when it is
  const unusable = (html: string): string | null => {
    if (isBotCheckPage(html)) return 'bot-check page';
    if (isLoginWall(html)) return 'login form';
    if (hasNoText(html)) return 'no text';
    if (isPaidPreview(html)) return 'paywall preview';
    if (wall === 'paywall' && storyTextChars(html) < previewChars + PAID_COPY_MIN_EXTRA_CHARS) return 'the same preview';
    return null;
  };

  const readerHtml = async (): Promise<{ html: string; pageUrl: string } | null> => {
    console.log('[Fetcher] Trying the reader proxy (r.jina.ai) HTML');
    try {
      const html = await readerProxyFetch(url);
      const problem = unusable(html);
      if (!problem) {
        console.log(`[Fetcher] Reader proxy succeeded: ${html.length} bytes of HTML`);
        return { html, pageUrl: url };
      }
      console.log(`[Fetcher] Reader proxy HTML is no good: ${problem}`);
      tried.push(`reader proxy HTML: ${problem}`);
    } catch (error: any) {
      console.log(`[Fetcher] Reader proxy HTML failed: ${error.message}`);
      tried.push(`reader proxy HTML: ${error.message}`);
    }
    return null;
  };

  const wayback = async (): Promise<{ html: string; pageUrl: string } | null> => {
    console.log('[Fetcher] Trying the newest Wayback Machine copy');
    try {
      const snapshot = await waybackSnapshotFetch(url);
      if (!snapshot) {
        console.log('[Fetcher] The Wayback Machine holds no copy of this page');
        tried.push('Wayback Machine: no copy');
        return null;
      }
      const problem = unusable(snapshot.html);
      if (!problem) {
        console.log(`[Fetcher] Using the Wayback copy from ${snapshot.timestamp}: ${snapshot.html.length} bytes of HTML`);
        return { html: snapshot.html, pageUrl: url };
      }
      console.log(`[Fetcher] The Wayback copy from ${snapshot.timestamp} is no good: ${problem}`);
      tried.push(`Wayback Machine: ${problem}`);
    } catch (error: any) {
      console.log(`[Fetcher] Wayback Machine failed: ${error.message}`);
      tried.push(`Wayback Machine: ${error.message}`);
    }
    return null;
  };

  const archivePh = async (): Promise<{ html: string; pageUrl: string } | null> => {
    // Not for an archive link itself: asking archive.ph for its own copy of a copy is pointless
    if (isArchiveMirrorUrl(url)) return null;
    console.log('[Fetcher] Trying the newest archive.ph copy');
    try {
      const copy = await archiveTodayFetch(url);
      if (!copy) {
        console.log('[Fetcher] archive.ph holds no copy of this page');
        tried.push('archive.ph: no copy');
        return null;
      }
      if (!/id="CONTENT"/.test(copy.html)) {
        // The snapshot box isArchiveSnapshot() looks for, checked here without a second parse
        const pageTitle = (copy.html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] || '').trim().slice(0, 80);
        console.log(`[Fetcher] archive.ph answered "${pageTitle}" instead of a snapshot`);
        tried.push(`archive.ph: "${pageTitle}" instead of a snapshot`);
        return null;
      }
      const problem = unusable(copy.html);
      if (!problem) {
        console.log(`[Fetcher] Using the archive.ph copy ${copy.url}: ${copy.html.length} bytes of HTML`);
        return { html: copy.html, pageUrl: copy.url };
      }
      console.log(`[Fetcher] The archive.ph copy is no good: ${problem}`);
      tried.push(`archive.ph: ${problem}`);
    } catch (error: any) {
      console.log(`[Fetcher] archive.ph failed: ${error.message}`);
      tried.push(`archive.ph: ${error.message}`);
    }
    return null;
  };

  const readerMarkdown = async (): Promise<{ html: string; pageUrl: string } | null> => {
    console.log('[Fetcher] Trying the reader proxy Markdown (browser-rendered)');
    try {
      const md = await readerProxyMarkdown(url);
      if (md.title && BOT_CHECK_TITLE.test(md.title)) {
        console.log('[Fetcher] Reader proxy Markdown is the bot-check page too');
        tried.push('reader proxy Markdown: bot-check page');
        return null;
      }
      console.log(`[Fetcher] Using the reader proxy Markdown: ${md.markdown.length} characters, title "${md.title || '(none)'}"`);
      return { html: readerMarkdownPage(md), pageUrl: url };
    } catch (error: any) {
      console.log(`[Fetcher] Reader proxy Markdown failed: ${error.message}`);
      tried.push(`reader proxy Markdown: ${error.message}`);
    }
    return null;
  };

  const steps = wall === 'paywall'
    ? [archivePh, wayback, readerHtml]
    : [readerHtml, wayback, archivePh, readerMarkdown];
  for (const step of steps) {
    const found = await step();
    if (found) return found;
  }

  console.log(`[Fetcher] No way past the ${wall}: ${tried.join(' | ')}`);
  const reason = wall === 'login' ? 'This article is behind a login'
    : wall === 'no text' ? 'This page has no article text'
      : wall === 'paywall' ? 'This article is behind a paywall'
        : 'This site blocks automated reading with a bot check';
  const copy = wall === 'paywall' ? 'no copy with the full text could be found' : 'no other copy of the article could be found';
  throw new ArticleUnavailableError(`${reason}, and ${copy}.`, url);
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

    // The address the page is read as: the article's own, or the archive.ph snapshot's when the
    // bot-wall routes ended there (see fetchPastBotWall).
    let pageUrl = url;
    const pastBotWall = async (wall: Wall = 'bot check', previewChars = 0) => {
      const copy = await fetchPastBotWall(url, wall, previewChars);
      pageUrl = copy.pageUrl;
      return copy.html;
    };
    // A page the site itself answered with may still not be the article: a bot check, a login
    // form, a page without text, or the preview of a paid article. Each goes to the other copies.
    const checkSitePage = async (page: string, status: number): Promise<string> => {
      if (isBotCheckPage(page)) {
        console.log(`[Fetcher] HTTP ${status} but the page is a bot check`);
        return pastBotWall();
      }
      if (isLoginWall(page)) {
        console.log(`[Fetcher] HTTP ${status} but the page is a login form`);
        return pastBotWall('login');
      }
      if (hasNoText(page) && !isSubstackPage(page)) {
        // A consent page that could not be passed, or a page built entirely by scripts. Not a
        // Substack page: a note can carry its text in the page data only.
        console.log(`[Fetcher] HTTP ${status} but the page has no text`);
        return pastBotWall('no text');
      }
      if (isPaidPreview(page)) {
        const previewChars = storyTextChars(page);
        console.log(`[Fetcher] HTTP ${status} but the page is the preview of a paid article (${previewChars} characters of story)`);
        return pastBotWall('paywall', previewChars);
      }
      return page;
    };

    let html: string;
    if (response.ok) {
      html = await response.text();
      // DPG Media's cookie consent page (hln.be, demorgen.be) stands in for the article until
      // its continue link is followed with the cookie it sets (see dpgPrivacyGateCallback).
      const gateCallback = dpgPrivacyGateCallback(response.url, html);
      if (gateCallback) {
        console.log('[Fetcher] DPG Media privacy gate, following its continue link');
        const passed = await safeFetchWithCookies(gateCallback);
        const passedHtml = await passed.text();
        if (passed.ok && !dpgPrivacyGateCallback(passed.url, passedHtml)) {
          console.log(`[Fetcher] Past the privacy gate: ${passedHtml.length} bytes of HTML`);
          html = passedHtml;
        } else {
          console.log(`[Fetcher] The privacy gate let nothing through (HTTP ${passed.status})`);
        }
      }
      html = await checkSitePage(html, response.status);
    } else if (response.status === 403) {
      // Cloudflare-style bot walls answer the plain fetch with an instant 403 (openai.com
      // does, seen live 2026-09-03). One retry with browser-like headers usually gets the
      // real page. Only on 403, so the plain fetch stays the first choice for every site
      // that already works.
      console.log('[Fetcher] HTTP 403 from simple fetch, retrying once with browser-like headers');
      const retry = await browserHeadersFetch(url);
      if (retry.statusCode < 200 || retry.statusCode >= 300) {
        // Diagnostic detail for ANY site that blocks both attempts: `cf-mitigated: challenge`
        // means a Cloudflare JavaScript challenge, which no header set can ever pass (we do
        // not run JavaScript), so header tuning is pointless for that site.
        const mitigated = retry.headers['cf-mitigated'] || 'none';
        const server = retry.headers['server'] || 'unknown';
        const snippet = (retry.body || '').replace(/\s+/g, ' ').slice(0, 200);
        console.log(`[Fetcher] Browser-like retry blocked too: HTTP ${retry.statusCode}`);
        console.log(`[Fetcher] Block details: cf-mitigated=${mitigated}, server=${server}, body starts: ${snippet}`);
        html = await pastBotWall();
      } else {
        console.log(`[Fetcher] Browser-like retry answered HTTP ${retry.statusCode}`);
        html = await checkSitePage(retry.body, retry.statusCode);
      }
    } else {
      // Other bot walls answer with another status and their own bot-check page. DataDome on
      // wsj.com answers HTTP 401 (seen 2026-10-06), and the browser-like retry above gets the
      // same 401, so it goes straight to the other routes.
      const body = await response.text();
      if (isBotCheckPage(body)) {
        const wall = response.headers.get('x-datadome') ? 'DataDome' : (response.headers.get('server') || 'unknown');
        console.log(`[Fetcher] HTTP ${response.status} with a bot-check page (${wall})`);
        html = await pastBotWall();
      } else if (isLoginWall(body)) {
        console.log(`[Fetcher] HTTP ${response.status} with a login form`);
        html = await pastBotWall('login');
      } else {
        console.log(`[Fetcher] HTTP error: ${response.status} ${response.statusText}`);
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
    }
    console.log(`[Fetcher] Received ${html.length} bytes of HTML`);

    // Detect Substack BEFORE removing scripts (needs to check for substackcdn.com links)
    const isSubstack = isSubstackPage(html);
    if (isSubstack) {
      console.log('[Fetcher] Detected Substack page (via substackcdn.com references)');
    }

    const dom = new JSDOM(html, { url: pageUrl });
    const doc = dom.window.document;

    // Read the schema.org JSON-LD author BEFORE the scripts are stripped below (it lives
    // in a <script type="application/ld+json">). Only used further down if nothing better
    // is found.
    const jsonLdAuthor = authorFromJsonLd(doc);

    // Remove scripts and styles globally
    const scripts = doc.querySelectorAll('script');
    scripts.forEach(script => script.remove());
    const styles = doc.querySelectorAll('style');
    styles.forEach(style => style.remove());

    // archive.is sometimes answers with a server placeholder instead of the snapshot (nginx's
    // "Welcome to nginx" page with HTTP 200, seen 2026-09-14). Storing that would replace a good
    // article with junk on a refetch, so a short answer without the snapshot box counts as a
    // failed fetch: a refetch keeps the old body and the Add tab shows an error to retry. A long
    // answer without the box (an archive link that redirects on to the original site) is used
    // as before.
    if (isArchiveMirrorUrl(pageUrl) && !isArchiveSnapshot(doc)) {
      const bodyChars = (doc.body?.textContent || '').trim().length;
      if (bodyChars < 1000) {
        const pageTitle = (doc.querySelector('title')?.textContent || '').trim().slice(0, 80);
        console.log(`[Fetcher] archive mirror answered without a snapshot (title "${pageTitle}", ${bodyChars} characters), treating it as a failed fetch`);
        throw new Error(`The archive answered with "${pageTitle}" instead of the snapshot`);
      }
    }

    // A Substack note brings its own text, author and date (see substackNote).
    const note = isSubstack ? substackNote(html, doc, url) : null;

    // Extract metadata from meta tags
    const title =
      note?.title ||
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

    // Last resort: the schema.org block captured above. Purely additive, it only fills a
    // byline that would otherwise be empty, so no site that already resolves an author
    // changes behaviour.
    if (!author?.trim() && jsonLdAuthor) {
      console.log(`[Fetcher] Author taken from JSON-LD: ${jsonLdAuthor}`);
      author = jsonLdAuthor;
    }

    // A note page's meta author is "Substack" itself
    if (note?.author) author = note.author;

    let publishedDate =
      note?.publishedDate ||
      doc.querySelector('meta[property="article:published_time"]')?.getAttribute('content') || undefined;

    // An archive.is copy's meta date is the moment of archiving. Prefer the date the archived
    // page itself shows (see archivedPublishedDate), and keep the archive time when it has none.
    if (isArchiveMirrorUrl(pageUrl)) {
      const pageDate = archivedPublishedDate(doc, publishedDate);
      if (pageDate) {
        console.log(`[Fetcher] archive copy: publication date ${pageDate} from the page, not the archive time ${publishedDate || '(none)'}`);
        publishedDate = pageDate;
      }
    }

    // --- ADDED IMAGE EXTRACTION HERE ---
    let leadImageUrl =
      doc.querySelector('meta[property="og:image"]')?.getAttribute('content') ||
      doc.querySelector('meta[name="twitter:image"]')?.getAttribute('content') ||
      undefined;

    // Smart content selection
    let contentEl;

    // Substack-specific selectors (more precise). Works on custom domains too.
    if (note) {
      contentEl = note.content;
    } else if (isSubstack) {
      console.log('[Fetcher] Using Substack-specific content selectors');
      contentEl = doc.querySelector('.available-content .body.markup') ||
                  doc.querySelector('.body.markup') ||
                  doc.querySelector('.available-content');
    }

    // A page that names its story body gets exactly that element (see findStoryBody). This runs
    // before the <article> guess below, because one <article> can hold the whole page.
    if (!contentEl) {
      const storyBody = findStoryBody(doc);
      if (storyBody) {
        const marker = storyBody.id ? `#${storyBody.id}` : `<${storyBody.tagName.toLowerCase()}> articleBody`;
        console.log(`[Fetcher] Using the marked story body (${marker})`);
        contentEl = storyBody;
      }
    }

    // Fallback to generic selectors
    if (!contentEl) {
      const article = doc.querySelector('article');
      // A page-sized <article> with the story in a second <article> inside it (FT): take the
      // inner one (see nestedStoryArticle).
      const nestedStory = article ? nestedStoryArticle(article) : null;
      if (nestedStory) {
        console.log('[Fetcher] Using the story <article> nested inside the page <article>');
        contentEl = nestedStory;
      } else {
        // Some sites (Compact, for one) put BOTH a page header and the story inside a single
        // <article>, with the story itself in a <main> within it. Taking the <article> then
        // drags the header (author line, date, share menu) into the body. Prefer that inner
        // <main>, but only when it holds most of the article's text: a small inner <main> is
        // a nav or a teaser, not the story.
        const innerMain = article?.querySelector('main') || null;
        const articleTextLen = (article?.textContent || '').trim().length;
        const innerMainTextLen = (innerMain?.textContent || '').trim().length;
        const preferInnerMain = !!innerMain && articleTextLen > 0 && innerMainTextLen >= articleTextLen * 0.5;
        if (preferInnerMain) {
          console.log('[Fetcher] Using the <main> inside <article> (page header excluded)');
        }
        contentEl = (preferInnerMain ? innerMain : article) || doc.querySelector('main');
        if (!contentEl) {
          // Neither <article> nor <main>: a blog post box beats the whole <body> (see blogPostBox)
          const post = blogPostBox(doc);
          if (post) console.log(`[Fetcher] No <article> or <main>, using the blog post box (.${post.classList[0] || post.tagName.toLowerCase()})`);
          contentEl = post || doc.body;
        }
      }
    }

    // archive.is and friends rebuild a page as generic <div>s, so the mirrored copy has no
    // paragraphs at all. Restore them before the cleanup below runs.
    if (contentEl && isArchiveMirrorUrl(pageUrl)) {
      console.log('[Fetcher] archive mirror detected, restoring paragraphs');
      restoreArchivedParagraphs(contentEl);

      // archive.is swaps the page's og:image for a screenshot of the archived page. Use the
      // page's own lead photo instead (see archivedLeadFigure), and put it back at the top of
      // the story when the story box chosen above left it out.
      const storyStart = (Array.from(contentEl.querySelectorAll('p')) as Element[])
        .find(p => (p.textContent || '').trim().length >= 150) || null;
      const leadFigure = archivedLeadFigure(doc, storyStart);
      const leadSrc = leadFigure?.querySelector('img[src]')?.getAttribute('src');
      if (leadFigure && leadSrc) {
        try {
          leadImageUrl = new URL(leadSrc, pageUrl).toString();
          console.log(`[Fetcher] archive copy: lead photo ${leadImageUrl} replaces the archive screenshot`);
        } catch {
          // An unparseable src keeps the screenshot as the thumbnail
        }
        if (!contentEl.contains(leadFigure)) {
          // Outside the story box, the figure still carries the mirror's inline styles
          [leadFigure, ...Array.from(leadFigure.querySelectorAll('[style]'))].forEach(el => el.removeAttribute('style'));
          contentEl.insertBefore(leadFigure, contentEl.firstChild);
        }
      }
    }

    // Tufte sidenotes hold the note inside the sentence and hide it with the site's own CSS,
    // which we do not keep. Turn them into a real footnote section before the cleanup below
    // strips the toggles it leaves behind.
    if (contentEl) normalizeSidenotes(contentEl);

    // Clean up UI noise (keep this gentle - only remove obvious UI chrome)
    if (contentEl) {
      // What the site leaves out of print, and video players with no video file (see both
      // functions). First, so the rules below work on the story alone.
      const printHidden = removePrintHidden(contentEl);
      const emptyPlayers = removeEmptyVideoPlayers(contentEl);
      if (printHidden || emptyPlayers) {
        console.log(`[Fetcher] Removed ${printHidden} print-hidden element(s) and ${emptyPlayers} empty video player(s)`);
      }

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

      // Remove share menus. Many sites render "Share", "Share via X", "Share via email",
      // "Copy link" as ordinary links inside the article, and they are read aloud as body
      // text. Same text-based approach as the Previous/Next removal above.
      contentEl.querySelectorAll('button, a').forEach(el => {
        const text = (el.textContent || '').trim();
        if (/^(share|share via .{1,20}|copy link|copy the link)$/i.test(text)) {
          el.remove();
        }
      });

      // Share links recognised by their address (see SHARE_LINK_PATTERNS). This catches share
      // bars whose wording the rule above cannot know, and it works on archive.is copies, which
      // keep the address but drop the class names the share-container rule further down needs.
      // Reader comments embedded in the page go too (see isCommentArea).
      const shareLinks = removeShareLinks(contentEl);
      const commentAreas = removeCommentAreas(contentEl);
      if (shareLinks || commentAreas) {
        console.log(`[Fetcher] Removed ${shareLinks} share link(s) and ${commentAreas} comment area(s)`);
      }

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

      // Remove the first <h1> if it matches the already-extracted title (prevents title being
      // narrated twice). Without an <h1>, the first <h2> (a blog post box titles its post with one).
      if (title && title !== 'Untitled') {
        const firstH1 = contentEl.querySelector('h1') || contentEl.querySelector('h2');
        if (firstH1) {
          const h1Text = firstH1.textContent?.trim() || '';
          // Normalize both for comparison (collapse whitespace, ignore case)
          const normalizeText = (t: string) => t.replace(/\s+/g, ' ').trim().toLowerCase();
          if (normalizeText(h1Text) === normalizeText(title)) {
            firstH1.remove();
          }
        }
      }

      // Remove subtitle/dek that matches the og:description (often repeated under title in lede
      // sections). Not on a Substack note, whose og:description is the note itself, so a note of
      // one paragraph would lose all its text.
      const ogDescription = doc.querySelector('meta[property="og:description"]')?.getAttribute('content');
      if (ogDescription && !note) {
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

      // Interactive controls are page furniture, never article text, and without the site's
      // stylesheet they render as bare widgets in the reader (this page's carousel buttons,
      // and any collapsible built on the checkbox hack). Tufte sidenote toggles are already
      // gone by now, normalizeSidenotes consumed them along with their notes.
      contentEl.querySelectorAll('input, button, select, textarea').forEach(el => el.remove());

      // Apply Substack-specific cleanup (subscribe widgets, navbar, footer, etc.)
      if (isSubstack) {
        cleanSubstackContent(contentEl);
      }

      // Resolve relative URLs in img/a/srcset to absolute, using the page's address
      // (the article's, or the archive.ph snapshot's) as base. Sites like jefftk.com use root-relative paths ("/foo.jpg") that
      // would otherwise resolve against wallacast.com and 404. Done before dedup
      // so the seenImageSrcs Set sees the resolved URLs.
      const resolveUrl = (raw: string): string | null => {
        const trimmed = raw.trim();
        if (!trimmed || trimmed.startsWith('data:') || trimmed.startsWith('#')) return null;
        try { return new URL(trimmed, pageUrl).toString(); } catch { return null; }
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
    stripLayoutStyles(contentEl);
    normalizeTweetEmbeds(contentEl);
    const cleanedHtml = contentEl.innerHTML;
    const textContent = contentEl.textContent || '';

    // An article without text or pictures is never stored: before 2026-10-07 DPG Media's consent
    // page was saved as two empty articles. A comic or a Substack note may be just a picture.
    if (!note && (textContent.match(/[\p{L}\p{N}]/gu) || []).length < 20 && !contentEl.querySelector('img, picture, video')) {
      console.log('[Fetcher] The page holds no article text after cleanup');
      throw new ArticleUnavailableError('This page has no article text.', url);
    }

    // Fetch Substack comments from /comments page (uses structured JSON, not CSS selectors)
    let comments: Comment[] | undefined;
    let comment_source: string | undefined;
    let comment_count_total: number | undefined;
    // A note's replies come from Substack's replies API (a note page has no /comments page)
    if (isSubstack) {
      comments = note ? await fetchSubstackNoteReplies(note.id) : await fetchSubstackComments(url, html);
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
    // The message says why (a bot check, an HTTP status, a timeout). The Add tab and a failed
    // refetch's card show it, so it is passed on as it is.
    console.error('[Fetcher] ✗ Error fetching article:', error);
    throw error instanceof Error && error.message ? error : new Error('Failed to fetch article content');
  }
}
