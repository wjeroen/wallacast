import fetch from 'node-fetch';
import { JSDOM } from 'jsdom';

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
}

export async function fetchArticleContent(url: string): Promise<ArticleContent> {
  try {
    const response = await fetch(url);
    const html = await response.text();

    // Use jsdom for proper DOM parsing
    const dom = new JSDOM(html);
    const doc = dom.window.document;

    // Extract title
    const title = doc.querySelector('title')?.textContent?.replace(/ — EA Forum$/, '').trim() || 'Untitled';

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

    // Try to extract author from EA Forum metadata
    let author: string | undefined;
    const authorElement = doc.querySelector('.PostsAuthors-author');
    if (authorElement) {
      author = authorElement.textContent?.trim();
    }

    // Try to extract published date
    let publishedDate: string | undefined;
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

    return {
      title,
      content: extractTextFromHTML(html),
      html: html,
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
