import fetch from 'node-fetch';
import { JSDOM } from 'jsdom';

export interface Comment {
  username: string;
  date?: string;
  karma?: number;
  agree_votes?: number;
  disagree_votes?: number;
  agreement_score?: number; // LessWrong uses this instead of separate agree/disagree
  content: string;
  replies?: Comment[];
}

export interface ArticleContent {
  title: string;
  content: string;
  html: string;
  cleaned_html: string; // Cleaned article HTML (just main content, with formatting)
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
  let debuggedFirst = false;
  for (const [key, value] of Object.entries(apolloState)) {
    if (key.startsWith('Comment:')) {
      const commentData = value as any;

      // Debug first comment to see available fields
      if (!debuggedFirst) {
        debuggedFirst = true;
        console.log('=== DEBUGGING FIRST COMMENT ===');
        console.log('Comment key:', key);
        console.log('Available fields:', Object.keys(commentData));
        console.log('user:', commentData.user);
        console.log('htmlBody:', commentData.htmlBody ? 'EXISTS' : 'MISSING');
        console.log('contents:', commentData.contents ? Object.keys(commentData.contents) : 'MISSING');
        console.log('body:', commentData.body ? 'EXISTS' : 'MISSING');
        console.log('extendedScore:', commentData.extendedScore);
        console.log('==============================');
      }

      const extendedScore = commentData.extendedScore || {};

      // Resolve user reference if it's a reference object
      let user = commentData.user;
      if (user && user.__ref) {
        user = resolveRef(user);
      }

      // Extract content: Try multiple possible field locations
      const content = commentData.htmlBody ||
                     commentData.contents?.html ||
                     commentData.body ||
                     commentData.contents?.plaintextDescription ||
                     commentData.contents?.markdown ||
                     commentData.text ||
                     commentData.content ||
                     '';

      const comment: Comment = {
        username: user?.displayName || user?.slug || commentData.author || 'Anonymous',
        date: commentData.postedAt,
        karma: commentData.baseScore,
        // EA Forum uses separate agree/disagree
        agree_votes: extendedScore.agree ?? extendedScore.agreeCount,
        disagree_votes: extendedScore.disagree ?? extendedScore.disagreeCount,
        // LessWrong uses single agreement score
        agreement_score: extendedScore.agreement,
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

    // Use jsdom for proper DOM parsing
    const dom = new JSDOM(html);
    const doc = dom.window.document;

    // Extract title - try multiple sources
    let title = 'Untitled';

    // First try og:title meta tag (most reliable)
    const ogTitle = doc.querySelector('meta[property="og:title"]')?.getAttribute('content');
    if (ogTitle) {
      title = ogTitle.replace(/ — EA Forum$/, '').trim();
    } else {
      // Fallback to <title> tag
      const titleTag = doc.querySelector('title')?.textContent;
      if (titleTag) {
        title = titleTag.replace(/ — EA Forum$/, '').trim();
      }
    }

    // Try to extract EA Forum metadata using DOM selectors
    let karma: number | undefined;
    let agreeVotes: number | undefined;
    let disagreeVotes: number | undefined;
    let commentsHtml: string | undefined;

    // Extract karma from EA Forum's vote component
    const karmaElement = doc.querySelector('.PostsVoteDefault-voteScore');
    if (karmaElement) {
      const karmaText = karmaElement.textContent?.trim();
      if (karmaText) {
        karma = parseInt(karmaText);
      }
    }

    // Extract agree and disagree votes from EA Forum reaction buttons
    const reactionButtons = doc.querySelectorAll('.EAReactsSection-button');
    reactionButtons.forEach(button => {
      // Check if this button contains a checkmark (agree) or X (disagree) SVG
      const svg = button.querySelector('svg');
      if (svg) {
        const svgContent = svg.innerHTML;
        // Look for the number in the div after the emoji preview
        const numberDiv = button.querySelector('.EAReactsSection-emojiPreview + div');
        if (numberDiv) {
          const voteCount = parseInt(numberDiv.textContent?.trim() || '0');

          // Check if it's an agree vote (checkmark path)
          if (svgContent.includes('Vector (Stroke)') || svgContent.includes('M2.5 7.5L6 11L13.5 3.5')) {
            agreeVotes = voteCount;
          }
          // Check if it's a disagree vote (X path)
          else if (svgContent.includes('Union') || svgContent.includes('M3 3L13 13M13 3L3 13')) {
            disagreeVotes = voteCount;
          }
        }
      }
    });

    // Extract comments from Apollo state JSON (EA Forum / LessWrong)
    let comments: Comment[] | undefined;
    try {
      const scriptTags = doc.querySelectorAll('script');
      let apolloState: any = null;

      // Strategy 1: Look for classic window.__APOLLO_STATE__ (EA Forum often uses this)
      for (const script of Array.from(scriptTags)) {
        const scriptContent = script.textContent || '';
        if (scriptContent.includes('__APOLLO_STATE__')) {
          // Extract JSON from the script content
          const match = scriptContent.match(/__APOLLO_STATE__\s*=\s*(\{.+\});?\s*$/s);
          if (match) {
            apolloState = JSON.parse(match[1]);
            console.log('Found classic __APOLLO_STATE__');
            break;
          }
        }
      }

      // Strategy 2: Look for ApolloSSRDataTransport (newer LessWrong uses this)
      if (!apolloState) {
        for (const script of Array.from(scriptTags)) {
          const scriptContent = script.textContent || '';
          if (scriptContent.includes('ApolloSSRDataTransport')) {
            // Try to extract the JSON - LessWrong has multiple push() calls, we need the one with comment data
            // Match pattern: .push({...})
            const pushMatches = scriptContent.matchAll(/\.push\s*\(\s*(\{[^}]+\{[\s\S]*?\}[^}]*\})\s*\)/g);

            for (const match of pushMatches) {
              try {
                let jsonString = match[1];

                // Comprehensive sanitization of JavaScript-specific values
                // Replace undefined with null (valid JSON)
                jsonString = jsonString.replace(/:\s*undefined\b/g, ': null');
                jsonString = jsonString.replace(/,\s*undefined\b/g, ', null');
                jsonString = jsonString.replace(/\bundefined\b/g, 'null');
                // Remove function calls (shouldn't be in data, but just in case)
                jsonString = jsonString.replace(/Symbol\.[^,}\]]+/g, 'null');

                const transportData = JSON.parse(jsonString);

                // The actual data might be nested in different ways
                const potentialState = transportData.rehydrate ||
                                      transportData.data ||
                                      transportData;

                // Check if this chunk has Comment data
                if (potentialState && typeof potentialState === 'object') {
                  const hasComments = Object.keys(potentialState).some(k => k.startsWith('Comment:'));
                  if (hasComments) {
                    apolloState = potentialState;
                    console.log('Found ApolloSSRDataTransport state with comments');
                    break;
                  }
                }
              } catch (e) {
                // Try next match
                continue;
              }
            }

            if (apolloState) break;
          }
        }
      }

      if (apolloState) {
        console.log('Extracting comments from Apollo state...');
        comments = extractCommentsFromApolloState(apolloState);
        console.log(`Extracted ${comments.length} top-level comments from Apollo state`);
      } else {
        console.log('No Apollo state found in page');
      }
    } catch (error) {
      console.error('Error extracting comments from Apollo state:', error);
    }

    // Extract comments section HTML (fallback for LLM parsing if Apollo state fails)
    const commentsSection = doc.querySelector('.CommentsListSection-root');
    if (commentsSection) {
      commentsHtml = commentsSection.outerHTML;
    }

    console.log('=== Article Fetcher Metadata Extraction ===');
    console.log('Karma extracted:', karma);
    console.log('Agree votes extracted:', agreeVotes);
    console.log('Disagree votes extracted:', disagreeVotes);

    // Try to extract author from multiple sources
    let author: string | undefined;

    // Try og:author meta tag first
    const ogAuthor = doc.querySelector('meta[property="og:author"]')?.getAttribute('content') ||
                    doc.querySelector('meta[name="author"]')?.getAttribute('content');
    if (ogAuthor) {
      author = ogAuthor.trim();
    } else {
      // Try the UsersNameDisplay link inside PostsAuthors-authorName
      const authorLink = doc.querySelector('.PostsAuthors-authorName .UsersNameDisplay-noColor');
      if (authorLink) {
        author = authorLink.textContent?.trim();
      } else {
        // Fallback to any link in the author section
        const authorElement = doc.querySelector('.PostsAuthors-authorName a');
        if (authorElement) {
          author = authorElement.textContent?.trim();
        }
      }
    }

    // Try to extract published date
    let publishedDate: string | undefined;

    // Try og:published_time or article:published_time meta tags
    const ogPublished = doc.querySelector('meta[property="article:published_time"]')?.getAttribute('content') ||
                       doc.querySelector('meta[property="og:published_time"]')?.getAttribute('content');
    if (ogPublished) {
      publishedDate = ogPublished;
    } else {
      // Try to find <time> element with dateTime attribute
      const timeElement = doc.querySelector('time[dateTime]');
      if (timeElement) {
        const dateTimeAttr = timeElement.getAttribute('dateTime');
        if (dateTimeAttr) {
          publishedDate = dateTimeAttr;
        }
      } else {
        // Fallback to PostsPageDate-date or PostsItemDate
        const dateElement = doc.querySelector('.PostsPageDate-date time') ||
                           doc.querySelector('[class*="PostsItemDate"]');
        if (dateElement) {
          const dateText = dateElement.textContent?.trim();
          if (dateText) {
            try {
              const date = new Date(dateText);
              if (!isNaN(date.getTime())) {
                publishedDate = date.toISOString();
              }
            } catch (e) {
              console.warn('Failed to parse date:', dateText);
            }
          }
        }
      }
    }

    // Extract main content only - try to find the main article container
    let cleanedHtml = html;
    const mainContent = doc.querySelector('.PostsPage-postContent') ||
                       doc.querySelector('[class*="PostsPage-post"]') ||
                       doc.querySelector('article') ||
                       doc.querySelector('main');

    if (mainContent) {
      cleanedHtml = mainContent.outerHTML;
      console.log('Found main content container, using cleaned HTML');
    } else {
      console.log('Could not find main content container, using full HTML');
    }

    console.log('Author extracted:', author);
    console.log('Published date extracted:', publishedDate);
    console.log('===========================================');

    return {
      title,
      content: extractTextFromHTML(cleanedHtml),
      html: html, // Full page HTML
      cleaned_html: cleanedHtml, // Cleaned article HTML with formatting
      author: author,
      byline: author,
      published_date: publishedDate,
      karma: karma,
      agree_votes: agreeVotes,
      disagree_votes: disagreeVotes,
      comments_html: commentsHtml,
      comments: comments,
    };
  } catch (error) {
    console.error('Error fetching article:', error);
    throw new Error('Failed to fetch article content');
  }
}

function extractTextFromHTML(html: string): string {
  // Very basic text extraction
  // In production, use @mozilla/readability or similar
  let text = html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return text;
}
