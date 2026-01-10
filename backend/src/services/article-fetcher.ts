import fetch from 'node-fetch';

export interface ArticleContent {
  title: string;
  content: string;
  html: string;
  author?: string;
  excerpt?: string;
  byline?: string;
  site_name?: string;
}

export async function fetchArticleContent(url: string): Promise<ArticleContent> {
  try {
    // Using Mozilla's Readability API or similar service
    // For now, we'll use a simple fetch and basic parsing
    // In production, you'd want to use a service like Diffbot, Mercury, or self-hosted Readability

    const response = await fetch(url);
    const html = await response.text();

    // Basic extraction - in production, use proper parsing library
    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    const title = titleMatch ? titleMatch[1] : 'Untitled';

    // For a real implementation, you'd want to use:
    // - @mozilla/readability for content extraction
    // - jsdom for DOM parsing
    // - or a paid API like Diffbot

    return {
      title,
      content: extractTextFromHTML(html),
      html: html,
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
