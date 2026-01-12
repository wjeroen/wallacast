import fetch from 'node-fetch';
import { JSDOM } from 'jsdom';

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

    // Extract comments section HTML
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
      html: html, // Keep full HTML for GPT extraction
      author: author,
      byline: author,
      published_date: publishedDate,
      karma: karma,
      agree_votes: agreeVotes,
      disagree_votes: disagreeVotes,
      comments_html: commentsHtml,
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
