import fetch from 'node-fetch';
import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';

export interface Comment {
  username: string;
  date?: string;
  karma?: number;
  agree_votes?: number;
  disagree_votes?: number;
  content: string;
  replies?: Comment[];
}

export interface ArticleContent {
  title: string;
  content: string;
  html: string;
  textContent: string; // Clean text for TTS (includes formatted comments)
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

function extractApolloState(html: string): any {
  try {
    const regex = /window\.__APOLLO_STATE__\s*=\s*({[\s\S]*?});\s*<\/script>/;
    const match = html.match(regex);
    if (!match || !match[1]) {
      console.log('⚠️ Apollo State script tag not found in HTML');
      return null;
    }
    const state = JSON.parse(match[1]);
    console.log('✓ Successfully extracted Apollo State');
    return state;
  } catch (error) {
    console.error('❌ Failed to parse Apollo State JSON:', error);
    return null;
  }
}

export async function fetchArticleContent(url: string): Promise<ArticleContent> {
  try {
    const response = await fetch(url);
    const html = await response.text();

    // Use jsdom for proper DOM parsing
    const dom = new JSDOM(html);
    const doc = dom.window.document;

    // Extract Apollo State for accurate metadata
    const apolloState = extractApolloState(html);

    // Extract post ID from URL (EA Forum format: /posts/[postId]/[slug])
    const postIdMatch = url.match(/\/posts\/([a-zA-Z0-9]+)/);
    const postId = postIdMatch ? postIdMatch[1] : null;

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

    // Extract EA Forum metadata from Apollo State (most reliable)
    let karma: number | undefined;
    let agreeVotes: number | undefined;
    let disagreeVotes: number | undefined;
    let commentsHtml: string | undefined;

    if (apolloState && postId) {
      const postKey = `Post:${postId}`;
      const postData = apolloState[postKey];

      if (postData) {
        console.log('✓ Found post data in Apollo State');

        // Extract karma (baseScore)
        if (postData.baseScore !== undefined) {
          karma = postData.baseScore;
          console.log(`  Karma from Apollo State: ${karma}`);
        }

        // Extract agree/disagree votes from extendedScore
        if (postData.extendedScore) {
          if (postData.extendedScore.agreementVoteScore !== undefined) {
            agreeVotes = postData.extendedScore.agreementVoteScore;
            console.log(`  Agree votes from Apollo State: ${agreeVotes}`);
          }
          if (postData.extendedScore.disagreementVoteScore !== undefined) {
            disagreeVotes = postData.extendedScore.disagreementVoteScore;
            console.log(`  Disagree votes from Apollo State: ${disagreeVotes}`);
          }
        }
      } else {
        console.log('⚠️ Post data not found in Apollo State, falling back to DOM selectors');
      }
    }

    // Fallback to DOM selectors if Apollo State failed
    if (karma === undefined) {
      const karmaElement = doc.querySelector('.PostsVoteDefault-voteScore');
      if (karmaElement) {
        const karmaText = karmaElement.textContent?.trim();
        if (karmaText) {
          karma = parseInt(karmaText);
          console.log(`  Karma from DOM fallback: ${karma}`);
        }
      }
    }

    // Extract comments section HTML and parse structured comment data
    let structuredComments: Comment[] | undefined;

    // Try multiple selectors for EA Forum comments (prioritize #comments first)
    const commentSelectors = [
      '#comments',  // EA Forum uses this
      '.CommentsListSection-root',
      '[class*="CommentsSection"]',
      '[class*="CommentsList"]',
      '.comments-section'
    ];

    let commentsSection: Element | null = null;
    for (const selector of commentSelectors) {
      commentsSection = doc.querySelector(selector);
      if (commentsSection) {
        console.log(`✓ Found comments section using selector: ${selector}`);
        break;
      }
    }

    if (commentsSection) {
      commentsHtml = commentsSection.outerHTML;
      console.log(`Comments section HTML length: ${commentsHtml.length} chars`);

      // Parse structured comment data using DOM selectors + Apollo State
      try {
        structuredComments = parseCommentsFromDOM(commentsSection, apolloState);
        console.log(`✓ Extracted ${structuredComments.length} structured comments from DOM + Apollo State`);
      } catch (error) {
        console.error('❌ Error parsing comments from DOM:', error);
      }
    } else {
      console.log('❌ No comments section found with any selector');
      console.log('Available class names in document:',
        Array.from(doc.querySelectorAll('[class*="omment"]'))
          .slice(0, 5)
          .map(el => el.className)
      );
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

    // Remove comments section before Readability to prevent duplication
    // (Readability usually excludes comments, but EA Forum structure requires explicit removal)
    if (commentsSection) {
      commentsSection.remove();
      console.log('✓ Removed comments section from article body to prevent duplication');
    }

    // Remove common non-article elements before Readability
    // IMPORTANT: Don't remove anything with "Comment" in class name!
    const selectorsToRemove = [
      '.sidebar', '.related-posts', '.newsletter-signup', '.social-share',
      '.article-footer', '.post-footer', '.author-bio', '.recommended-articles',
      'nav', 'footer', '.nav', '.footer', '[role="navigation"]', '[role="complementary"]',
      // EA Forum-specific UI elements to remove
      '.FrontpagePostsHeader-root', // "Curated and popular this week" header
      '.RecommendationsSection-root', // Recommendations sidebar
      '.SidebarAction-root', // Sidebar action buttons
      '.RecommendationsAndCurated-root', // Curated posts section
      '.SidebarInfo-root', // Sidebar info boxes
      '.SidebarHoverOver-root', // Hover overs in sidebar
      '.PostsListPlaceholder-root', // Post list placeholders
      '.RecentDiscussionThread-root', // Recent discussion threads
      '.SequencesNavigationLink-root', // Sequence navigation
      '.PostsItem-root:not(.PostsPage-postContent .PostsItem-root)', // Related posts (but not in main content)
      // Removed overly broad wildcard selectors that might match comments
    ];

    selectorsToRemove.forEach(selector => {
      doc.querySelectorAll(selector).forEach(el => el.remove());
    });

    // Use Mozilla Readability to extract clean article content
    const reader = new Readability(doc, {
      // Readability options to be more strict
      charThreshold: 100, // Minimum text length
    });
    const article = reader.parse();

    let articleText = '';
    if (article && article.textContent) {
      articleText = article.textContent;

      // Clean up extra whitespace and formatting issues
      articleText = articleText
        .replace(/\n{3,}/g, '\n\n') // Max 2 newlines
        .replace(/[ \t]+/g, ' ') // Normalize spaces
        .trim();

      console.log('✓ Readability extracted article content');
    } else {
      // Fallback to basic text extraction
      articleText = extractTextFromHTML(cleanedHtml);
      console.log('⚠ Readability failed, using fallback extraction');
    }

    // Format comments as readable text for TTS (if we have structured comments)
    let commentsText = '';
    if (structuredComments && structuredComments.length > 0) {
      commentsText = '\n\nComments section:\n\n' + formatCommentsForTTS(structuredComments);
      console.log(`✓ Formatted ${structuredComments.length} comments for TTS`);
    }

    // Combine article text and comments text for TTS
    const textContent = articleText + commentsText;

    return {
      title,
      content: extractTextFromHTML(cleanedHtml), // Keep for backwards compatibility
      html: html,
      textContent: textContent, // Clean text for TTS
      author: author,
      byline: author,
      published_date: publishedDate,
      karma: karma,
      agree_votes: agreeVotes,
      disagree_votes: disagreeVotes,
      comments_html: commentsHtml,
      comments: structuredComments,
    };
  } catch (error) {
    console.error('Error fetching article:', error);
    throw new Error('Failed to fetch article content');
  }
}

function formatCommentsForTTS(comments: Comment[], depth: number = 0): string {
  let text = '';
  const indent = '  '.repeat(depth);

  for (const comment of comments) {
    // Format comment header with metadata
    let header = `${indent}${comment.username}`;

    if (comment.date) {
      header += ` on ${comment.date}`;
    }

    const metadata: string[] = [];
    if (comment.karma !== undefined) metadata.push(`${comment.karma} karma`);
    if (comment.agree_votes !== undefined) metadata.push(`${comment.agree_votes} agree votes`);
    if (comment.disagree_votes !== undefined) metadata.push(`${comment.disagree_votes} disagree votes`);

    if (metadata.length > 0) {
      header += ` with ${metadata.join(', ')}`;
    }

    header += ':\n';

    // Add comment content
    text += header + `${indent}${comment.content}\n\n`;

    // Recursively format replies
    if (comment.replies && comment.replies.length > 0) {
      text += formatCommentsForTTS(comment.replies, depth + 1);
    }
  }

  return text;
}

function parseCommentsFromDOM(commentsSection: Element, apolloState: any): Comment[] {
  const comments: Comment[] = [];

  // Find all top-level comment items (not nested in replies)
  const topLevelComments = commentsSection.querySelectorAll('.CommentsNode-root > .CommentsItem-root');

  topLevelComments.forEach((commentElement) => {
    const comment = parseCommentElement(commentElement, apolloState);
    if (comment) {
      comments.push(comment);
    }
  });

  return comments;
}

function parseCommentElement(commentElement: Element, apolloState: any): Comment | null {
  try {
    // Extract comment ID from element's id attribute
    const commentId = commentElement.id;

    // Extract username (keep using DOM - this is reliable)
    const usernameElement = commentElement.querySelector('.CommentUserName-author') ||
                           commentElement.querySelector('.UsersNameDisplay-userName') ||
                           commentElement.querySelector('.CommentsItem-author a');
    const username = usernameElement?.textContent?.trim();
    if (!username) return null;

    // Extract date (keep using DOM)
    let date: string | undefined;
    const timeElement = commentElement.querySelector('time[dateTime]');
    if (timeElement) {
      const dateTime = timeElement.getAttribute('dateTime');
      if (dateTime) {
        date = new Date(dateTime).toISOString().split('T')[0]; // Format as YYYY-MM-DD
      }
    }

    // Extract karma/vote score from Apollo State (most reliable)
    let karma: number | undefined;
    let agreeVotes: number | undefined;
    let disagreeVotes: number | undefined;

    if (apolloState && commentId) {
      const commentKey = `Comment:${commentId}`;
      const commentData = apolloState[commentKey];

      if (commentData) {
        // Extract karma (baseScore)
        if (commentData.baseScore !== undefined) {
          karma = commentData.baseScore;
        }

        // Extract agree/disagree votes from extendedScore
        if (commentData.extendedScore) {
          if (commentData.extendedScore.agreementVoteScore !== undefined) {
            agreeVotes = commentData.extendedScore.agreementVoteScore;
          }
          if (commentData.extendedScore.disagreementVoteScore !== undefined) {
            disagreeVotes = commentData.extendedScore.disagreementVoteScore;
          }
        }
      }
    }

    // Fallback to DOM selectors if Apollo State failed
    if (karma === undefined) {
      const karmaElement = commentElement.querySelector('.OverallVoteAxis-voteScore');
      if (karmaElement) {
        const karmaText = karmaElement.textContent?.trim();
        if (karmaText) {
          const parsed = parseInt(karmaText);
          if (!isNaN(parsed)) {
            karma = parsed;
          }
        }
      }
    }

    // Extract comment content (text only, no HTML) - keep using DOM
    let content = '';
    const contentElement = commentElement.querySelector('.CommentBody-root') ||
                          commentElement.querySelector('.CommentBody-commentStyling') ||
                          commentElement.querySelector('.CommentsItem-body');
    if (contentElement) {
      content = contentElement.textContent?.trim() || '';
    }

    // Extract nested replies recursively
    const replies: Comment[] = [];
    const repliesContainer = commentElement.querySelector('.CommentReplies-root');
    if (repliesContainer) {
      const replyElements = repliesContainer.querySelectorAll(':scope > .CommentsNode-root > .CommentsItem-root');
      replyElements.forEach((replyElement) => {
        const reply = parseCommentElement(replyElement, apolloState);
        if (reply) {
          replies.push(reply);
        }
      });
    }

    const comment: Comment = {
      username,
      content,
    };

    if (date) comment.date = date;
    if (karma !== undefined) comment.karma = karma;
    if (agreeVotes !== undefined) comment.agree_votes = agreeVotes;
    if (disagreeVotes !== undefined) comment.disagree_votes = disagreeVotes;
    if (replies.length > 0) comment.replies = replies;

    return comment;
  } catch (error) {
    console.error('Error parsing comment element:', error);
    return null;
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
