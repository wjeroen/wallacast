import { gotScraping } from 'got-scraping';
import { JSDOM } from 'jsdom';
import fetch from 'node-fetch';

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
      'Referer': url,
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
  return {
    title: post.title,
    content: dom.window.document.body.textContent || '',
    html: post.htmlBody,
    cleaned_html: post.htmlBody,
    author: post.user?.displayName || '[deleted]',
    byline: post.user?.displayName || '[deleted]',
    site_name: isEAForum ? 'EA Forum' : 'LessWrong',
    published_date: post.postedAt,
    karma: post.baseScore,
    agree_votes: postReactions.agree,
    disagree_votes: postReactions.disagree,
    comments: rootComments,
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
  // Find the window._preloads assignment with flexible whitespace
  const preloadsIdx = html.indexOf('window._preloads');
  if (preloadsIdx === -1) return null;

  // Get a chunk of text after "window._preloads" to inspect the format
  const afterPreloads = html.substring(preloadsIdx + 'window._preloads'.length, preloadsIdx + 'window._preloads'.length + 200);

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

  // Unknown format — log what we see for debugging
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
    // Plain text — convert newlines to paragraphs
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
 * First tries the article page HTML (already fetched), then falls back to /comments page.
 * Uses window._preloads JSON — stable structured data, not fragile CSS selectors.
 */
async function fetchSubstackComments(articleUrl: string, articleHtml: string): Promise<Comment[]> {
  // First: try to extract from the article page we already have
  const fromArticle = extractSubstackCommentsFromHtml(articleHtml, 'article page');
  if (fromArticle.length > 0) {
    return fromArticle;
  }

  // Second: fetch the /comments page
  const commentsUrl = buildSubstackCommentsUrl(articleUrl);
  console.log(`[Fetcher] No comments on article page, trying: ${commentsUrl}`);

  try {
    const response = await fetch(commentsUrl);
    if (!response.ok) {
      console.log(`[Fetcher] Comments page HTTP ${response.status}, skipping comments`);
      return [];
    }

    const html = await response.text();
    console.log(`[Fetcher] Comments page: ${html.length} bytes`);
    return extractSubstackCommentsFromHtml(html, 'comments page');
  } catch (error) {
    console.error('[Fetcher] Failed to fetch Substack comments:', error);
    return [];
  }
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
 * Uses data-component-name, data-testid, and generic patterns — NOT hashed class names.
 */
function cleanSubstackContent(contentEl: Element): void {
  // Remove subscribe widgets (data-component-name is stable, semantic attribute)
  contentEl.querySelectorAll('[data-component-name="SubscribeWidget"]').forEach(el => el.remove());

  // Remove "Subscribe now" CTA buttons — only if they link to /subscribe
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

export async function fetchArticleContent(url: string): Promise<ArticleContent> {
  console.log(`[Fetcher] Fetching article from: ${url}`);

  const isLessWrong = url.includes('lesswrong.com');
  const isEAForum = url.includes('forum.effectivealtruism.org');

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
    const response = await fetch(url);

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

    // Substack-specific selectors (more precise) — works on custom domains too
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
        // Search all paragraphs — the dek might be anywhere in the lede wrapper
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

      // Apply Substack-specific cleanup (subscribe widgets, navbar, footer, etc.)
      if (isSubstack) {
        cleanSubstackContent(contentEl);
      }

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

    const cleanedHtml = contentEl.innerHTML;
    const textContent = contentEl.textContent || '';

    // Fetch Substack comments from /comments page (uses structured JSON, not CSS selectors)
    let comments: Comment[] | undefined;
    if (isSubstack) {
      comments = await fetchSubstackComments(url, html);
      if (comments.length === 0) comments = undefined;
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
    };

  } catch (error) {
    console.error('[Fetcher] ✗ Error fetching article:', error);
    throw new Error('Failed to fetch article content');
  }
}
