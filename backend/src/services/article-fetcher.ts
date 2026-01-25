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

function extractCommentsFromApolloState(apolloState: any): Comment[] {
  const comments: Comment[] = [];
  const commentMap = new Map<string, Comment>();

  // Helper to resolve references like { __ref: 'User:123' }
  const resolveRef = (refObj: any) => {
    if (refObj && refObj.__ref && apolloState[refObj.__ref]) {
      return apolloState[refObj.__ref];
    }
    return refObj;
  };

  // First pass: Create all comment objects
  for (const [key, value] of Object.entries(apolloState)) {
    if (key.startsWith('Comment:')) {
      const commentData = value as any;

      // Resolve User Reference
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

  // Second pass: Build the comment tree
  for (const [key, value] of Object.entries(apolloState)) {
    if (key.startsWith('Comment:')) {
      const commentData = value as any;
      const comment = commentMap.get(key);

      if (comment && commentData.parentCommentId) {
        const parentKey = `Comment:${commentData.parentCommentId}`;
        const parentComment = commentMap.get(parentKey);
        if (parentComment) {
          if (!parentComment.replies) {
            parentComment.replies = [];
          }
          parentComment.replies.push(comment);
        }
      } else if (comment && !commentData.parentCommentId) {
        // Top-level comment
        comments.push(comment);
      }
    }
  }

  // Sort comments by karma (highest first)
  comments.sort((a, b) => (b.karma || 0) - (a.karma || 0));

  // Recursively sort replies
  function sortReplies(comment: Comment) {
    if (comment.replies && comment.replies.length > 0) {
      comment.replies.sort((a, b) => (b.karma || 0) - (a.karma || 0));
      comment.replies.forEach(sortReplies);
    }
  }
  comments.forEach(sortReplies);

  return comments;
}

export async function fetchArticleContent(url: string): Promise<ArticleContent> {
  try {
    const response = await fetch(url);
    const html = await response.text();

    const dom = new JSDOM(html);
    const doc = dom.window.document;

    // --- Metadata Extraction ---
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

    // We will accumulate state from ALL found chunks here
    let fullApolloState: any = {};

    try {
      const scriptTags = doc.querySelectorAll('script');

      for (const script of Array.from(scriptTags)) {
        const scriptContent = script.textContent || '';

        // Strategy 1: Classic Apollo State (EA Forum)
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

        // Strategy 2: ApolloSSRDataTransport (LessWrong) - Handle Multiple Pushes
        if (scriptContent.includes('ApolloSSRDataTransport')) {
          // Find ALL pushes in this script tag
          const pushMatches = scriptContent.matchAll(/\.push\s*\(([\s\S]*?)\)\s*;?/g);

          for (const match of pushMatches) {
            const content = match[1].trim();

            // CRITICAL FIX: Skip function calls!
            // We only want: .push({ ... })
            // We skip: .push((function(){ ... })())
            if (content.startsWith('(') || content.startsWith('function')) {
              console.log('Skipping ApolloSSRDataTransport function block (contains JS, not JSON)');
              continue;
            }

            try {
              const json = JSON.parse(content);
              // The state is usually inside a 'rehydrate' property
              if (json.rehydrate) {
                fullApolloState = { ...fullApolloState, ...json.rehydrate };
                console.log('Merged ApolloSSRDataTransport JSON chunk');
              } else {
                fullApolloState = { ...fullApolloState, ...json };
              }
            } catch (e) {
              // This is expected if the content is JS code but didn't start with ( or function
              // or if JSON.parse fails for other reasons.
              console.warn('Failed to parse ApolloSSRDataTransport chunk:', (e as Error).message);
            }
          }
        }
      }

      // If we found any state, extract comments
      if (Object.keys(fullApolloState).length > 0) {
        comments = extractCommentsFromApolloState(fullApolloState);
        console.log(`Extracted ${comments.length} comments from combined Apollo state`);
      }

    } catch (error) {
      console.error('Error extracting comments from Apollo state:', error);
    }

    // --- HTML Cleaning & Finalizing ---
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
