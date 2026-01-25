import fetch from 'node-fetch';
import { JSDOM } from 'jsdom';

export interface Comment {
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

// Helper: robustly extract JS objects from .push(...) calls
// Handles single quotes, double quotes, and cleans 'undefined' values
function extractApolloSSRData(scriptContent: string): any[] {
  const results: any[] = [];
  const pushPattern = /\.push\s*\(\s*/g;
  let match;

  while ((match = pushPattern.exec(scriptContent)) !== null) {
    const startIndex = match.index + match[0].length;
    let openBrackets = 0;
    let inString = false;
    let stringChar = ''; // ' or "
    let escape = false;
    let endIndex = -1;

    for (let i = startIndex; i < scriptContent.length; i++) {
      const char = scriptContent[i];

      if (escape) {
        escape = false;
        continue;
      }

      if (char === '\\') {
        escape = true;
        continue;
      }

      // Handle strings (both single and double quotes)
      if (!inString && (char === '"' || char === "'")) {
        inString = true;
        stringChar = char;
        continue;
      }

      if (inString) {
        if (char === stringChar) {
          inString = false;
        }
        continue;
      }

      // Bracket counting (only when not in string)
      if (char === '{' || char === '[') openBrackets++;
      if (char === '}' || char === ']') openBrackets--;

      // Check for end of function argument: )
      if (char === ')' && openBrackets <= 0) {
        endIndex = i;
        break;
      }
    }

    if (endIndex !== -1) {
      let payloadString = scriptContent.substring(startIndex, endIndex).trim();

      // 1. Handle IIFEs (Functions)
      // The massive data chunk often lives inside: .push((function(){ ... const rehydrate = {...}; return ... })())
      if (payloadString.startsWith('(') || payloadString.startsWith('function')) {
        // Try to extract the 'rehydrate' object definition from the function body
        // Looking for: const rehydrate = { ... };
        const rehydrateMatch = payloadString.match(/const\s+rehydrate\s*=\s*(\{[\s\S]*?\n\s*\}\s*);/);
        if (rehydrateMatch) {
          payloadString = rehydrateMatch[1]; // Use the extracted object instead of the function
        } else {
          // If we can't extract specific data, skip the function to avoid crashing
          console.log('Skipping ApolloSSRDataTransport function block (no rehydrate object found)');
          continue;
        }
      }

      // 2. Sanitize "Loose JSON" to valid JSON
      // Replace 'undefined' values with 'null' (Fixes "Unexpected token 'u'")
      // Regex looks for: : undefined (followed by comma, end brace, or newline)
      payloadString = payloadString.replace(/:\s*undefined([,}\]])/g, ':null$1');

      // 3. Attempt Parsing
      try {
        const json = JSON.parse(payloadString);
        results.push(json);
      } catch (e) {
        // Silent fail: some chunks might be code or complex refs we can't parse easily
        console.warn('JSON Parse failed on chunk:', (e as Error).message.substring(0, 100));
      }
    }
  }
  return results;
}

function extractCommentsFromApolloState(apolloState: any): Comment[] {
  const comments: Comment[] = [];
  const commentMap = new Map<string, Comment>();

  const resolveRef = (refObj: any) => {
    if (refObj && refObj.__ref && apolloState[refObj.__ref]) {
      return apolloState[refObj.__ref];
    }
    return refObj;
  };

  // Pass 1: Create Objects
  for (const [key, value] of Object.entries(apolloState)) {
    if (key.startsWith('Comment:')) {
      const commentData = value as any;

      let user = commentData.user;
      if (user && user.__ref) {
        user = resolveRef(user);
      }

      // Resolve contents reference if it exists (EA Forum uses this)
      let contents = commentData.contents;
      if (contents && contents.__ref) {
        contents = resolveRef(contents);
      }

      // Extract Content: Prefer HTML for formatting
      const content = commentData.htmlBody ||
                     contents?.html ||
                     contents?.plaintextDescription ||
                     commentData.body ||
                     commentData.text ||
                     commentData.content ||
                     '';

      // Extract all reactions from extendedScore dynamically
      const extendedScore = commentData.extendedScore || {};

      const comment: Comment = {
        username: user?.displayName || user?.slug || commentData.author || 'Anonymous',
        date: commentData.postedAt,
        karma: commentData.baseScore,
        extendedScore: Object.keys(extendedScore).length > 0 ? extendedScore : undefined,
        content: content,
        replies: [],
      };
      commentMap.set(key, comment);
    }
  }

  // Pass 2: Threading
  for (const [key, value] of Object.entries(apolloState)) {
    if (key.startsWith('Comment:')) {
      const commentData = value as any;
      const comment = commentMap.get(key);

      if (comment && commentData.parentCommentId) {
        const parentKey = `Comment:${commentData.parentCommentId}`;
        const parentComment = commentMap.get(parentKey);
        if (parentComment) {
          if (!parentComment.replies) parentComment.replies = [];
          parentComment.replies.push(comment);
        }
      } else if (comment && !commentData.parentCommentId) {
        comments.push(comment);
      }
    }
  }

  // Sort
  comments.sort((a, b) => (b.karma || 0) - (a.karma || 0));
  const sortReplies = (comment: Comment) => {
    if (comment.replies?.length) {
      comment.replies.sort((a, b) => (b.karma || 0) - (a.karma || 0));
      comment.replies.forEach(sortReplies);
    }
  };
  comments.forEach(sortReplies);

  return comments;
}

export async function fetchArticleContent(url: string): Promise<ArticleContent> {
  try {
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
    let fullApolloState: any = {};

    try {
      const scriptTags = doc.querySelectorAll('script');

      for (const script of Array.from(scriptTags)) {
        const scriptContent = script.textContent || '';

        // 1. Classic Apollo State (EA Forum)
        if (scriptContent.includes('__APOLLO_STATE__')) {
          const match = scriptContent.match(/__APOLLO_STATE__\s*=\s*(\{.+\});?\s*$/s);
          if (match) {
            try {
              const state = JSON.parse(match[1]);
              fullApolloState = { ...fullApolloState, ...state };
              console.log('Merged classic Apollo state');
            } catch (e) {
              console.warn('Failed to parse classic Apollo state', e);
            }
          }
        }

        // 2. ApolloSSRDataTransport (LessWrong)
        if (scriptContent.includes('ApolloSSRDataTransport')) {
          const chunks = extractApolloSSRData(scriptContent);
          for (const chunk of chunks) {
            if (chunk.rehydrate) {
              fullApolloState = { ...fullApolloState, ...chunk.rehydrate };
              console.log('Merged ApolloSSRDataTransport rehydrate chunk');
            } else {
              fullApolloState = { ...fullApolloState, ...chunk };
              console.log('Merged ApolloSSRDataTransport chunk');
            }
          }
        }
      }

      if (Object.keys(fullApolloState).length > 0) {
        comments = extractCommentsFromApolloState(fullApolloState);
        console.log(`Extracted ${comments.length} comments from combined Apollo state`);
      }
    } catch (error) {
      console.error('Error extracting comments:', error);
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
      console.log('Found main content container');
      console.log('Cleaned HTML length:', cleanedHtml.length, 'characters');
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
