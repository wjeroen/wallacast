import fetch from 'node-fetch';
import { JSDOM } from 'jsdom';

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
  karma?: number;
  agree_votes?: number;
  disagree_votes?: number;
  comments_html?: string;
  comments?: Comment[];
}

/**
 * Resolves Apollo references (e.g. { __ref: "User:123" })
 */
function resolveRef(obj: any, referenceMap: Map<string, any>): any {
  if (!obj) return obj;
  if (obj.__ref && referenceMap.has(obj.__ref)) {
    return referenceMap.get(obj.__ref);
  }
  return obj;
}

/**
 * Robustly extracts variables like 'rehydrate' or 'events' from minified JS strings.
 * Handles "const rehydrate={" and "const rehydrate = {"
 */
function extractVariablesFromFunctionString(jsCode: string): any[] {
  const foundData: any[] = [];
  // Regex to find variable assignments, tolerant of whitespace
  // Matches: const rehydrate = { OR const rehydrate={
  const variableRegex = /const\s+(rehydrate|events)\s*=\s*([{\[])/g;
  
  let match;
  while ((match = variableRegex.exec(jsCode)) !== null) {
    const startChar = match[2]; // '{' or '['
    const startIndex = match.index + match[0].length - 1; // Start at the bracket
    
    // Bracket balancing
    let open = 0;
    let endIdx = -1;
    let inStr = false;
    let strChar = '';
    let esc = false;

    for (let i = startIndex; i < jsCode.length; i++) {
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
      const jsonStr = jsCode.substring(startIndex, endIdx).replace(/:\s*undefined([,}])/g, ':null$1');
      try {
        foundData.push(JSON.parse(jsonStr));
      } catch (e) {
        // console.warn('JSON Parse failed', e);
      }
    }
  }
  return foundData;
}

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

      // Case A: Direct Object
      if (payloadString.startsWith('{') || payloadString.startsWith('[')) {
        try {
          const sanitized = payloadString.replace(/:\s*undefined([,}])/g, ':null$1');
          results.push(JSON.parse(sanitized));
        } catch (e) { }
      }
      // Case B: Function/IIFE (LessWrong uses this heavily)
      else if (payloadString.startsWith('(') || payloadString.startsWith('function')) {
        const extracted = extractVariablesFromFunctionString(payloadString);
        results.push(...extracted);
      }
    }
  }
  return results;
}

function buildReferenceMap(obj: any, map: Map<string, any>) {
  if (!obj || typeof obj !== 'object') return;

  if (obj._id) {
    map.set(obj._id, obj);
    if (obj.__typename) {
      map.set(`${obj.__typename}:${obj._id}`, obj);
    }
  }
  
  if (!Array.isArray(obj)) {
      for (const key in obj) {
          if (key.includes(':') && typeof obj[key] === 'object' && obj[key] !== null) {
              map.set(key, obj[key]);
          }
      }
  }

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

/**
 * Unified extractor for Comments AND Post Metadata
 */
function extractCommentsFromData(dataRoots: any[], isLessWrong: boolean): { comments: Comment[], postMeta?: { author: string, publishedDate: string } } {
  const comments: Comment[] = [];
  const commentMap = new Map<string, Comment>();
  const rawCommentData = new Map<string, any>();
  const referenceMap = new Map<string, any>();

  // 1. Index everything
  for (const root of dataRoots) {
    buildReferenceMap(root, referenceMap);
  }

  // 2. Find Main Post Metadata (Fix for missing Author/Date)
  let postMeta: { author: string, publishedDate: string } | undefined;
  
  for (const val of referenceMap.values()) {
    if (val && val.__typename === 'Post') {
      // Logic: A valid post usually has a title AND (body OR contents reference)
      const hasContent = val.htmlBody || val.body || val.contents;
      
      if (val.title && hasContent) {
        const user = resolveRef(val.user || val.author, referenceMap);
        const authorName = user?.displayName || user?.slug || user?.username || val.author || 'Unknown';
        
        postMeta = {
          author: authorName,
          publishedDate: val.postedAt
        };
        // If we found a post with a real title, we assume it's the main one.
        break;
      }
    }
  }

  // 3. Identify Comments
  referenceMap.forEach((val, key) => {
      if (!val) return;
      if (val.__typename === 'Comment' || key.startsWith('Comment:')) {
          const id = val._id || key.split(':')[1] || key;
          rawCommentData.set(id, val);
      }
  });

  // 4. Process Comments
  for (const [id, raw] of rawCommentData.entries()) {
    const commentData = resolveRef(raw, referenceMap);
    
    let user = resolveRef(commentData.user, referenceMap);
    const username = user?.displayName || user?.slug || commentData.author || 'Anonymous';

    // Content: Handle LW 'contents' reference or EA 'htmlBody'
    let contentObj = resolveRef(commentData.contents, referenceMap);
    let content = '';
    if (contentObj) {
      content = contentObj.html || contentObj.plaintextMainText || '';
    } 
    if (!content) content = commentData.htmlBody || commentData.body || '';

    const extendedScore = commentData.extendedScore || {};
    
    if (isLessWrong) {
        if (extendedScore.agreement === undefined) {
            const val = extendedScore.agreementScore || extendedScore.agree;
            if (typeof val === 'number') extendedScore.agreement = val;
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

  // 5. Threading
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

  // 6. Sort
  comments.sort((a, b) => (b.karma || 0) - (a.karma || 0));
  const sortReplies = (c: Comment) => {
    if (c.replies?.length) {
      c.replies.sort((a, b) => (b.karma || 0) - (a.karma || 0));
      c.replies.forEach(sortReplies);
    }
  };
  comments.forEach(sortReplies);

  return { comments, postMeta };
}

export async function fetchArticleContent(url: string): Promise<ArticleContent> {
  try {
    const response = await fetch(url);
    const html = await response.text();
    const dom = new JSDOM(html);
    const doc = dom.window.document;
    const isLessWrong = url.includes('lesswrong.com');

    // --- Initial Metadata (Fallback) ---
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

    // --- Data Extraction ---
    let comments: Comment[] | undefined;
    let apolloMeta: { author: string, publishedDate: string } | undefined;
    let dataRoots: any[] = [];

    try {
      const scriptTags = doc.querySelectorAll('script');
      
      for (const script of Array.from(scriptTags)) {
        const scriptContent = script.textContent || '';

        // Standard Apollo State
        if (scriptContent.includes('__APOLLO_STATE__')) {
          const match = scriptContent.match(/__APOLLO_STATE__\s*=\s*(\{.+\});?\s*$/s);
          if (match) {
            try { dataRoots.push(JSON.parse(match[1])); } catch (e) { }
          }
        }
        
        // SSR Data Transport (LessWrong / EA Forum)
        if (scriptContent.includes('ApolloSSRDataTransport')) {
          const extracted = extractApolloSSRData(scriptContent);
          dataRoots.push(...extracted);
        }
      }

      if (dataRoots.length > 0) {
        const result = extractCommentsFromData(dataRoots, isLessWrong);
        comments = result.comments;
        apolloMeta = result.postMeta;
      }
    } catch (error) {
      console.error('Extraction error:', error);
    }

    // --- Finalize Metadata ---
    let author: string | undefined;
    if (apolloMeta?.author) {
        author = apolloMeta.author;
    } else {
        const ogAuthor = doc.querySelector('meta[property="og:author"]')?.getAttribute('content') ||
                         doc.querySelector('meta[name="author"]')?.getAttribute('content');
        if (ogAuthor) author = ogAuthor.trim();
    }

    let publishedDate: string | undefined;
    if (apolloMeta?.publishedDate) {
        publishedDate = apolloMeta.publishedDate;
    } else {
        const ogPublished = doc.querySelector('meta[property="article:published_time"]')?.getAttribute('content');
        if (ogPublished) publishedDate = ogPublished;
    }

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
    console.error('Error fetching article:', error);
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
