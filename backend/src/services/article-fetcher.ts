import fetch from 'node-fetch';
import { JSDOM } from 'jsdom';

export interface CommentData {
  author: string;
  date?: string;
  karma?: number;
  agree_votes?: number;
  disagree_votes?: number;
  content: string;
}

export interface ArticleContent {
  title: string;
  content: string;
  html: string;
  author?: string;
  excerpt?: string;
  byline?: string;
  site_name?: string;
  published_date?: string;
  karma?: number;
  agree_votes?: number;
  disagree_votes?: number;
  comments_html?: string;
  comments?: CommentData[];
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

    // Extract agree votes
    const agreeElement = doc.querySelector('[class*="agree"]');
    if (agreeElement) {
      const agreeMatch = agreeElement.textContent?.match(/\d+/);
      if (agreeMatch) {
        agreeVotes = parseInt(agreeMatch[0]);
      }
    }

    // Extract disagree votes
    const disagreeElement = doc.querySelector('[class*="disagree"]');
    if (disagreeElement) {
      const disagreeMatch = disagreeElement.textContent?.match(/\d+/);
      if (disagreeMatch) {
        disagreeVotes = parseInt(disagreeMatch[0]);
      }
    }

    // Extract comments section HTML
    const commentsSection = doc.querySelector('.CommentsListSection-root');
    if (commentsSection) {
      commentsHtml = commentsSection.outerHTML;
    }

    // Extract ALL comments with metadata using DOM parsing
    const comments: CommentData[] = [];

    // EA Forum comment selectors - try multiple patterns
    const commentElements = doc.querySelectorAll('.CommentsNode-root, .CommentFrame-root, [class*="CommentNode"]');

    commentElements.forEach((commentEl) => {
      try {
        // Extract comment author
        const authorEl = commentEl.querySelector('.UsersNameDisplay-noColor, .CommentUserName-author, [class*="author"]');
        const commentAuthor = authorEl?.textContent?.trim();

        // Extract comment date
        const timeEl = commentEl.querySelector('time');
        const commentDate = timeEl?.getAttribute('datetime') || timeEl?.textContent?.trim();

        // Extract comment karma
        const karmaEl = commentEl.querySelector('.CommentsVote-voteScore, .VoteScore, [class*="voteScore"]');
        const commentKarmaText = karmaEl?.textContent?.trim();
        const commentKarma = commentKarmaText ? parseInt(commentKarmaText) : undefined;

        // Extract comment content (the actual text)
        const contentEl = commentEl.querySelector('.ContentStyles-commentBody, .CommentBody-root, [class*="commentBody"]');
        const commentContent = contentEl?.textContent?.trim();

        // Try to find agree/disagree votes
        const agreeEl = commentEl.querySelector('[class*="agree"]');
        const disagreeEl = commentEl.querySelector('[class*="disagree"]');
        const agreeMatch = agreeEl?.textContent?.match(/(\d+)/);
        const disagreeMatch = disagreeEl?.textContent?.match(/(\d+)/);
        const agreeVotes = agreeMatch ? parseInt(agreeMatch[1]) : undefined;
        const disagreeVotes = disagreeMatch ? parseInt(disagreeMatch[1]) : undefined;

        // Only add comment if we have author and content
        if (commentAuthor && commentContent) {
          comments.push({
            author: commentAuthor,
            date: commentDate,
            karma: commentKarma,
            agree_votes: agreeVotes,
            disagree_votes: disagreeVotes,
            content: commentContent,
          });
        }
      } catch (error) {
        console.error('Failed to extract comment:', error);
      }
    });

    console.log(`Extracted ${comments.length} comments with metadata`);

    // Try to extract author from multiple sources
    let author: string | undefined;

    // Try og:author meta tag first
    const ogAuthor = doc.querySelector('meta[property="og:author"]')?.getAttribute('content') ||
                    doc.querySelector('meta[name="author"]')?.getAttribute('content');
    if (ogAuthor) {
      author = ogAuthor.trim();
    } else {
      // Fallback to class selector
      const authorElement = doc.querySelector('.PostsAuthors-author');
      if (authorElement) {
        author = authorElement.textContent?.trim();
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
      // Fallback to date element
      const dateElement = doc.querySelector('[class*="PostsItemDate"]');
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

    return {
      title,
      content: extractTextFromHTML(cleanedHtml),
      html: html, // Keep full HTML for GPT extraction
      author: author,
      byline: author,
      published_date: publishedDate,
      karma: karma,
      agree_votes: agreeVotes,
      disagree_votes: disagreeVotes,
      comments_html: commentsHtml,
      comments: comments, // Include extracted comments with metadata
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
