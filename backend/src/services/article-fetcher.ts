import fetch from 'node-fetch';
import { JSDOM } from 'jsdom';

export interface Comment {
  id: string;
  username: string;
  date?: string;
  karma?: number;
  extendedScore?: Record<string, number>; // Dynamic reactions (agree, disagree, love, etc.)
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
  karma?: number;
  agree_votes?: number;
  disagree_votes?: number;
  comments_html?: string;
  comments?: Comment[];
}

/**
 * MASTER PARSER: Handles both "Direct Object" and "Function/IIFE" patterns
 * used by ApolloSSRDataTransport.
 */
function extractApolloSSRData(scriptContent: string): any[] {
  const results: any[] = [];
  const pushPattern = /\.push\s*\(\s*/g;
  let match;

  while ((match = pushPattern.exec(scriptContent)) !== null) {
    const startIndex = match.index + match[0].length;

    // Use bracket counting to find the end of the argument
    let openBrackets = 0;
    let inString = false;
    let stringChar = '';
    let escape = false;
    let endIndex = -1;

    for (let i = startIndex; i < scriptContent.length; i++) {
      const char = scriptContent[i];
      if (escape) { escape = false; continue; }
      if (char === '\\') { escape = true; continue; }
      if (!inString && (char === '"' || char === "'")) { inString = true; stringChar = char; continue; }
      if (inString) { if (char === stringChar) { inString = false; } continue; }

      if (char === '{' || char === '[') openBrackets++;
      if (char === '}' || char === ']') openBrackets--;

      // If we hit a closing paren and we are balanced, we are done
      if (char === ')' && openBrackets <= 0) {
        endIndex = i;
        break;
      }
    }

    if (endIndex !== -1) {
      let payloadString = scriptContent.substring(startIndex, endIndex).trim();

      // --- STRATEGY 1: Direct JSON Object ---
      // Pattern: .push({ "rehydrate": ... })
      if (payloadString.startsWith('{') || payloadString.startsWith('[')) {
        try {
          // Sanitize undefined -> null to ensure JSON validity
          const sanitized = payloadString.replace(/:\s*undefined([,}])/g, ':null$1');
          results.push(JSON.parse(sanitized));
          console.log('[LW Parser] ✓ Parsed direct JSON object');
        } catch (e) {
          console.log('[LW Parser] ✗ Failed to parse direct JSON chunk');
        }
      }

      // --- STRATEGY 2: IIFE / Function ---
      // Pattern: .push((function(){ const rehydrate = ... }))
      else if (payloadString.startsWith('(') || payloadString.startsWith('function')) {
        const extracted = extractVariablesFromFunctionString(payloadString);
        results.push(...extracted);
        if (extracted.length > 0) {
          console.log(`[LW Parser] ✓ Extracted ${extracted.length} objects from IIFE`);
        }
      }
    }
  }
  return results;
}

// Helper for Strategy 2: Extract variables from JS code string
function extractVariablesFromFunctionString(jsCode: string): any[] {
  const foundData: any[] = [];
  const targets = ['rehydrate', 'events'];

  for (const target of targets) {
    const marker = `const ${target} =`;
    let idx = jsCode.indexOf(marker);
    if (idx === -1) continue;

    idx += marker.length;

    // Find start of object/array
    let startIdx = -1;
    for (let i = idx; i < jsCode.length; i++) {
      if (jsCode[i] === '{' || jsCode[i] === '[') {
        startIdx = i;
        break;
      }
    }
    if (startIdx === -1) continue;

    // Bracket count to find end
    let open = 0;
    let endIdx = -1;
    let inStr = false;
    let strChar = '';
    let esc = false;

    for (let i = startIdx; i < jsCode.length; i++) {
      const c = jsCode[i];
      if (esc) { esc = false; continue; }
      if (c === '\\') { esc = true; continue; }
      if (!inStr && (c === '"' || c === "'")) { inStr = true; strChar = c; continue; }
      if (inStr) { if (c === strChar) inStr = false; continue; }

      if (c === '{' || c === '[') open++;
      if (c === '}' || c === ']') open--;

      if (open === 0) {
        endIdx = i + 1;
        break;
      }
    }

    if (endIdx !== -1) {
      const jsonStr = jsCode.substring(startIdx, endIdx).replace(/:\s*undefined([,}])/g, ':null$1');
      try {
        foundData.push(JSON.parse(jsonStr));
      } catch (e) { }
    }
  }
  return foundData;
}

// Recursively search for comments in any object structure
function findCommentsInObject(obj: any, foundComments: Map<string, any>) {
  if (!obj || typeof obj !== 'object') return;

  // Check if this object is a Comment
  if (obj.__typename === 'Comment' && obj._id) {
    foundComments.set(obj._id, obj);
  }

  // Iterate
  if (Array.isArray(obj)) {
    obj.forEach(item => findCommentsInObject(item, foundComments));
  } else {
    for (const key in obj) {
      if (Object.prototype.hasOwnProperty.call(obj, key)) {
        findCommentsInObject(obj[key], foundComments);
      }
    }
  }
}

function extractCommentsFromData(dataRoots: any[]): Comment[] {
  const comments: Comment[] = [];
  const commentMap = new Map<string, Comment>();
  const rawCommentData = new Map<string, any>();

  // 1. Find all raw comment objects deeply nested in the data
  for (const root of dataRoots) {
    findCommentsInObject(root, rawCommentData);
  }

  console.log(`[Comments] Found ${rawCommentData.size} unique raw comments in Apollo state`);

  // 2. Convert raw data to Comment objects
  for (const [id, commentData] of rawCommentData.entries()) {
    const extendedScore = commentData.extendedScore || {};

    // User is often inline: commentData.user
    let user = commentData.user;

    const username = user?.displayName || user?.slug || commentData.author || 'Anonymous';

    // Content extraction
    let content = '';
    if (commentData.contents) {
      content = commentData.contents.html || commentData.contents.plaintextMainText || commentData.contents.plaintextDescription || '';
    } else {
      content = commentData.htmlBody || commentData.body || '';
    }

    const comment: Comment = {
      id: id,
      username: username,
      date: commentData.postedAt,
      karma: commentData.baseScore,
      extendedScore: Object.keys(extendedScore).length > 0 ? extendedScore : undefined,
      content: content,
      replies: [],
    };
    commentMap.set(id, comment);
  }

  // 3. Build the Tree
  for (const [id, commentData] of rawCommentData.entries()) {
    const comment = commentMap.get(id);
    if (!comment) continue;

    if (commentData.parentCommentId) {
      const parent = commentMap.get(commentData.parentCommentId);
      if (parent) {
        if (!parent.replies) parent.replies = [];
        if (!parent.replies.some(r => r.id === comment.id)) {
          parent.replies.push(comment);
        }
      } else {
        comments.push(comment); // Orphan or top-level
      }
    } else {
      comments.push(comment); // Top-level
    }
  }

  // 4. Sort
  comments.sort((a, b) => (b.karma || 0) - (a.karma || 0));

  const sortReplies = (c: Comment) => {
    if (c.replies?.length) {
      c.replies.sort((a, b) => (b.karma || 0) - (a.karma || 0));
      c.replies.forEach(sortReplies);
    }
  };
  comments.forEach(sortReplies);

  console.log(`[Comments] Built comment tree with ${comments.length} top-level comments`);

  return comments;
}

export async function fetchArticleContent(url: string): Promise<ArticleContent> {
  try {
    console.log(`[Fetcher] Fetching article from: ${url}`);
    const response = await fetch(url);
    const html = await response.text();
    const dom = new JSDOM(html);
    const doc = dom.window.document;

    // --- Metadata ---
    let title = 'Untitled';
    const ogTitle = doc.querySelector('meta[property="og:title"]')?.getAttribute('content');
    if (ogTitle) {
      title = ogTitle.replace(/ — EA Forum$/, '').replace(/ — LessWrong$/, '').trim();
    } else {
      const titleTag = doc.querySelector('title')?.textContent;
      if (titleTag) {
        title = titleTag.replace(/ — EA Forum$/, '').replace(/ — LessWrong$/, '').trim();
      }
    }

    let karma: number | undefined;
    const karmaElement = doc.querySelector('.PostsVoteDefault-voteScore');
    if (karmaElement) {
      const karmaText = karmaElement.textContent?.trim();
      if (karmaText) karma = parseInt(karmaText);
    }

    // --- Comment Extraction ---
    let comments: Comment[] | undefined;
    let dataRoots: any[] = [];

    try {
      const scriptTags = doc.querySelectorAll('script');
      console.log(`[Comments] Found ${scriptTags.length} script tags, scanning for Apollo state...`);

      for (const script of Array.from(scriptTags)) {
        const scriptContent = script.textContent || '';

        // 1. Classic Apollo State (EA Forum)
        if (scriptContent.includes('__APOLLO_STATE__')) {
          console.log('[Comments] Found __APOLLO_STATE__ (EA Forum)');
          const match = scriptContent.match(/__APOLLO_STATE__\s*=\s*(\{.+\});?\s*$/s);
          if (match) {
            try {
              dataRoots.push(JSON.parse(match[1]));
              console.log('[Comments] ✓ Parsed EA Forum Apollo state');
            } catch (e) {
              console.log('[Comments] ✗ Failed to parse EA Forum Apollo state');
            }
          }
        }

        // 2. ApolloSSRDataTransport (LessWrong - Hybrid Mode)
        if (scriptContent.includes('ApolloSSRDataTransport')) {
          console.log('[Comments] Found ApolloSSRDataTransport (LessWrong)');
          const extracted = extractApolloSSRData(scriptContent);
          dataRoots.push(...extracted);
          console.log(`[Comments] Extracted ${extracted.length} data chunks from LessWrong`);
        }
      }

      if (dataRoots.length > 0) {
        console.log(`[Comments] Processing ${dataRoots.length} data roots...`);
        comments = extractCommentsFromData(dataRoots);
        console.log(`[Comments] ✅ Final result: ${comments.length} top-level comments extracted`);
      } else {
        console.log('[Comments] ⚠️  No Apollo state data found in page');
      }
    } catch (error) {
      console.error('[Comments] ✗ Error extracting comments:', error);
    }

    // --- Finalize ---
    let author: string | undefined;
    const ogAuthor = doc.querySelector('meta[property="og:author"]')?.getAttribute('content') ||
                     doc.querySelector('meta[name="author"]')?.getAttribute('content');
    if (ogAuthor) author = ogAuthor.trim();

    let publishedDate: string | undefined;
    const ogPublished = doc.querySelector('meta[property="article:published_time"]')?.getAttribute('content');
    if (ogPublished) publishedDate = ogPublished;

    let cleanedHtml = html;
    const mainContent = doc.querySelector('.PostsPage-postContent') || doc.querySelector('article');
    if (mainContent) {
      cleanedHtml = mainContent.outerHTML;
      console.log(`[Fetcher] ✓ Extracted main content (${cleanedHtml.length} chars)`);
    }

    return {
      title,
      content: extractTextFromHTML(cleanedHtml),
      html: html,
      cleaned_html: cleanedHtml,
      author,
      byline: author,
      published_date: publishedDate,
      karma,
      comments,
    };
  } catch (error) {
    console.error('[Fetcher] ✗ Error fetching article:', error);
    throw new Error('Failed to fetch article content');
  }
}

function extractTextFromHTML(html: string): string {
  let text = html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text;
}
