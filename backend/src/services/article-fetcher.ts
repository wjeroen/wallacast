import fetch from 'node-fetch';
import { JSDOM } from 'jsdom';

export interface Comment {
  id: string;
  username: string;
  date?: string;
  karma?: number;
  extendedScore?: Record<string, number>; // Kept for TS compatibility
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

// --- NEW GRAPHQL LOGIC START ---

interface GraphQLResponse {
  data: {
    post: {
      result: {
        _id: string;
        title: string;
        htmlBody: string;
        postedAt: string;
        baseScore: number;
        voteCount: number;
        user: {
          displayName: string;
          slug: string;
        } | null;
        pageUrl: string;
      } | null;
    };
    comments: {
      results: Array<{
        _id: string;
        htmlBody: string;
        postedAt: string;
        baseScore: number;
        user: {
          displayName: string;
          slug: string;
        } | null;
        parentCommentId: string | null;
      }>;
    };
  };
}

/**
 * Fetches data from LessWrong or EA Forum using their GraphQL API.
 * This is much more robust than scraping the DOM or SSR state.
 */
async function fetchForumMagnumPost(url: string, isEAForum: boolean): Promise<ArticleContent> {
  // 1. Extract Post ID from URL
  const idMatch = url.match(/\/posts\/([a-zA-Z0-9]+)/);
  if (!idMatch) {
    throw new Error('Could not extract Post ID from URL. Ensure URL format is /posts/ID/slug');
  }
  const postId = idMatch[1];
  
  const apiEndpoint = isEAForum 
    ? 'https://forum.effectivealtruism.org/graphql' 
    : 'https://www.lesswrong.com/graphql';

  // 2. Construct GraphQL Query
  const query = `
    query GetPostAndComments($postId: String!) {
      post(input: {selector: {_id: $postId}}) {
        result {
          _id
          title
          htmlBody
          postedAt
          baseScore
          voteCount
          user {
            displayName
            slug
          }
          pageUrl
        }
      }
      comments(input: {terms: {view: "postCommentsTop", postId: $postId, limit: 1000}}) {
        results {
          _id
          htmlBody
          postedAt
          baseScore
          parentCommentId
          user {
            displayName
            slug
          }
        }
      }
    }
  `;

  // 3. Execute Fetch
  const response = await fetch(apiEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query,
      variables: { postId }
    }),
  });

  if (!response.ok) {
    throw new Error(`GraphQL API error: ${response.status} ${response.statusText}`);
  }

  const json = (await response.json()) as GraphQLResponse;
  
  if (!json.data || !json.data.post || !json.data.post.result) {
    throw new Error('Post not found in GraphQL response');
  }

  const post = json.data.post.result;

  // 4. Process Comments into a Tree
  const rawComments = json.data.comments.results;
  const commentMap = new Map<string, Comment>();
  const rootComments: Comment[] = [];

  // First pass: create Comment objects
  rawComments.forEach(c => {
    commentMap.set(c._id, {
      id: c._id,
      username: c.user?.displayName || '[deleted]',
      date: c.postedAt,
      karma: c.baseScore,
      content: c.htmlBody, 
      replies: []
    });
  });

  // Second pass: link parents and children
  rawComments.forEach(c => {
    const commentNode = commentMap.get(c._id)!;
    if (c.parentCommentId && commentMap.has(c.parentCommentId)) {
      const parent = commentMap.get(c.parentCommentId)!;
      parent.replies?.push(commentNode);
    } else {
      rootComments.push(commentNode);
    }
  });

  // 5. Return ArticleContent
  const siteName = isEAForum ? 'EA Forum' : 'LessWrong';
  
  const dom = new JSDOM(post.htmlBody);
  const textContent = dom.window.document.body.textContent || '';

  return {
    title: post.title,
    content: textContent,
    html: post.htmlBody,
    cleaned_html: post.htmlBody,
    author: post.user?.displayName || '[deleted]',
    byline: post.user?.displayName || '[deleted]',
    site_name: siteName,
    published_date: post.postedAt,
    karma: post.baseScore,
    agree_votes: post.voteCount, 
    comments: rootComments,
    comments_html: '' 
  };
}

// --- NEW GRAPHQL LOGIC END ---

export async function fetchArticleContent(url: string): Promise<ArticleContent> {
  console.log(`[Fetcher] Fetching article from: ${url}`);
  
  // Identify platform
  const isLessWrong = url.includes('lesswrong.com');
  const isEAForum = url.includes('forum.effectivealtruism.org');

  // Route to the new GraphQL fetcher if applicable
  if (isLessWrong || isEAForum) {
    try {
      console.log(`[Fetcher] Detected ${isLessWrong ? 'LessWrong' : 'EA Forum'}, using GraphQL API...`);
      return await fetchForumMagnumPost(url, isEAForum);
    } catch (error) {
      console.error(`[Fetcher] GraphQL fetch failed, falling back to standard scraper: ${error}`);
      // Fall through to standard scraper below if API fails 
    }
  }

  // --- STANDARD SCRAPER (EXISTING LOGIC) ---
  
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; Wallacast/1.0; +http://localhost:3000)',
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch URL: ${response.status} ${response.statusText}`);
    }

    const html = await response.text();
    const dom = new JSDOM(html, { url });
    const doc = dom.window.document;

    // Remove scripts and styles
    const scripts = doc.querySelectorAll('script');
    scripts.forEach(script => script.remove());
    const styles = doc.querySelectorAll('style');
    styles.forEach(style => style.remove());

    // Extract metadata
    const title = 
      doc.querySelector('meta[property="og:title"]')?.getAttribute('content') ||
      doc.querySelector('title')?.textContent ||
      'Untitled';

    const siteName = 
      doc.querySelector('meta[property="og:site_name"]')?.getAttribute('content') ||
      new URL(url).hostname;

    let author: string | undefined;
    const authorMeta = doc.querySelector('meta[name="author"]')?.getAttribute('content');
    if (authorMeta) {
      author = authorMeta;
    } else {
      // Generic fallback selectors for author
      const authorSelectors = ['.author', '.byline', 'a[rel="author"]'];
      for (const selector of authorSelectors) {
        const el = doc.querySelector(selector);
        if (el) {
          author = el.textContent?.trim();
          break;
        }
      }
    }

    // Fix strict null check error here by OR-ing with undefined
    const publishedDate = 
      doc.querySelector('meta[property="article:published_time"]')?.getAttribute('content') || undefined;

    // Extract main content using Readability-like heuristics
    let contentEl = doc.querySelector('article') || doc.querySelector('main') || doc.body;
    
    const cleanedHtml = contentEl.innerHTML;
    const textContent = contentEl.textContent || '';

    return {
      title,
      content: textContent,
      html: html, 
      cleaned_html: cleanedHtml,
      author,
      byline: author,
      site_name: siteName,
      published_date: publishedDate,
    };

  } catch (error) {
    console.error('[Fetcher] ✗ Error fetching article:', error);
    throw new Error('Failed to fetch article content');
  }
}
