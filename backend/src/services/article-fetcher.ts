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
 * Helper to resolve Apollo references like { __ref: "User:123" }
 */
function resolveRef(obj: any, referenceMap: Map<string, any>): any {
  if (!obj) return obj;
  if (obj.__ref && referenceMap.has(obj.__ref)) {
    return referenceMap.get(obj.__ref);
  }
  return obj;
}

/**
 * MASTER PARSER: Handles "Direct Object", "Function/IIFE", and "Reference" patterns
 */
function extractApolloSSRData(scriptContent: string): any[] {
  const results: any[] = [];
  const pushPattern = /\.push\s*\(\s*/g;
  let match;

  while ((match = pushPattern.exec(scriptContent)) !== null) {
    const startIndex = match.index + match[0].length;
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

      if (char === ')' && openBrackets <= 0) {
        endIndex = i;
        break;
      }
    }

    if (endIndex !== -1) {
      let payloadString = scriptContent.substring(startIndex, endIndex).trim();

      if (payloadString.startsWith('{') || payloadString.startsWith('[')) {
        try {
          const sanitized = payloadString.replace(/:\s*undefined([,}])/g, ':null$1');
          results.push(JSON.parse(sanitized));
        } catch (e) { /* ignore parse errors */ }
      }
      else if (payloadString.startsWith('(') || payloadString.startsWith('function')) {
        const extracted = extractVariablesFromFunctionString(payloadString);
        results.push(...extracted);
      }
    }
  }
  return results;
}

function extractVariablesFromFunctionString(jsCode: string): any[] {
  const foundData: any[] = [];
  const targets = ['rehydrate', 'events'];

  for (const target of targets) {
    const marker = `const ${target} =`;
    let idx = jsCode.indexOf(marker);
    if (idx === -1) continue;
    idx += marker.length;

    let startIdx = -1;
    for (let i = idx; i < jsCode.length; i++) {
      if (jsCode[i] === '{' || jsCode[i] === '[') {
        startIdx = i;
        break;
      }
    }
    if (startIdx === -1) continue;

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

// Recursively index all objects in the data blob by their ID/Cache Key
function buildReferenceMap(obj: any, map: Map<string, any>) {
  // CRITICAL FIX: typeof null is 'object', so explicitly check for null
  if (!obj || typeof obj !== 'object') return;

  // Apollo often uses keys like "Comment:123" or "_id"
  if (obj._id) {
    map.set(obj._id, obj);
    if (obj.__typename) {
      map.set(`${obj.__typename}:${obj._id}`, obj);
    }
  }
  
  // Also scan for keys that look like cache IDs in the root object
  if (!Array.isArray(obj)) {
      for (const key in obj) {
          // CRITICAL FIX: Check obj[key] is not null before adding
          if (key.includes(':') && typeof obj[key] === 'object' && obj[key] !== null) {
              map.set(key, obj[key]);
          }
      }
  }

  // Iterate deeper
  if (Array.isArray(obj)) {
    obj.forEach(item => buildReferenceMap(item, map));
  } else {
    for (const key in obj) {
      if (Object.prototype.hasOwnProperty.call(obj, key)) {
        buildReferenceMap(obj[key], map);
      }
    }
  }
}

function extractCommentsFromData(dataRoots: any[], isLessWrong: boolean): Comment[] {
  const comments: Comment[] = [];
  const commentMap = new Map<string, Comment>();
  const rawCommentData = new Map<string, any>();
  const referenceMap = new Map<string, any>();

  // 1. Build Reference Map (Index everything first!)
  for (const root of dataRoots) {
    buildReferenceMap(root, referenceMap);
  }
  
  // 1b. Collect raw comments
  referenceMap.forEach((val, key) => {
      // CRITICAL FIX: Add null check for 'val' to prevent crashes
      if (!val) return;

      if (val.__typename === 'Comment' || key.startsWith('Comment:')) {
          const id = val._id || key.split(':')[1] || key;
          rawCommentData.set(id, val);
      }
  });

  console.log(`[Comments] Found ${rawCommentData.size} unique raw comments`);

  // 2. Convert raw data to Comment objects (Resolving references)
  for (const [id, raw] of rawCommentData.entries()) {
    const commentData = resolveRef(raw, referenceMap);
    
    // Resolve User (References often hide here)
    let user = resolveRef(commentData.user, referenceMap);
    const username = user?.displayName || user?.slug || commentData.author || 'Anonymous';

    // Resolve Content (Often in contents.html or body)
    let contentObj = resolveRef(commentData.contents, referenceMap);
    let content = '';
    if (contentObj) {
      content = contentObj.html || contentObj.plaintextMainText || '';
    } 
    if (!content) content = commentData.htmlBody || commentData.body || '';

    // Extract Scores
    const extendedScore = commentData.extendedScore || {};
    
    // FIX FOR LESSWRONG: Non-destructive normalization
    if (isLessWrong) {
        // If 'agreement' is missing, try to find it in other common keys
        if (extendedScore.agreement === undefined) {
            const val = extendedScore.agreementScore || extendedScore.agree;
            if (typeof val === 'number') {
                extendedScore.agreement = val;
            }
        }
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
  for (const [id, raw] of rawCommentData.entries()) {
    const commentData = resolveRef(raw, referenceMap);
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
        comments.push(comment);
      }
    } else {
      comments.push(comment);
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

  return comments;
}

export async function fetchArticleContent(url: string): Promise<ArticleContent> {
  try {
    console.log(`[Fetcher] Fetching article from: ${url}`);
    const response = await fetch(url);
    const html = await response.text();
    const dom = new JSDOM(html);
    const doc = dom.window.document;

    // Detect Site Type
    const isLessWrong = url.includes('lesswrong.com');

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
      console.log(`[Comments] Found ${scriptTags.length} script tags, scanning...`);

      for (const script of Array.from(scriptTags)) {
        const scriptContent = script.textContent || '';

        // 1. Classic Apollo State
        if (scriptContent.includes('__APOLLO_STATE__')) {
          const match = scriptContent.match(/__APOLLO_STATE__\s*=\s*(\{.+\});?\s*$/s);
          if (match) {
            try {
              dataRoots.push(JSON.parse(match[1]));
            } catch (e) { }
          }
        }

        // 2. ApolloSSRDataTransport
        if (scriptContent.includes('ApolloSSRDataTransport')) {
          const extracted = extractApolloSSRData(scriptContent);
          dataRoots.push(...extracted);
        }
      }

      if (dataRoots.length > 0) {
        console.log(`[Comments] Processing data roots...`);
        // Pass the site flag to helper
        comments = extractCommentsFromData(dataRoots, isLessWrong);
        console.log(`[Comments] ✅ Final result: ${comments.length} top-level comments extracted`);
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
