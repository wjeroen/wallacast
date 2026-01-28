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

// Mimic a real Chrome browser to avoid 429 Rate Limiting
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36';

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

async function fetchForumMagnumPost(url: string, isEAForum: boolean): Promise<ArticleContent> {
  // 1. Extract Post ID
  const idMatch = url.match(/\/posts\/([a-zA-Z0-9]+)/);
  if (!idMatch) {
    throw new Error('Could not extract Post ID from URL. Ensure URL format is /posts/ID/slug');
  }
  const postId = idMatch[1];
  
  const baseUrl = isEAForum 
    ? 'https://forum.effectivealtruism.org' 
    : 'https://www.lesswrong.com';
    
  const apiEndpoint = `${baseUrl}/graphql`;

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
      comments(input: {terms: {view: "postCommentsTop", postId: $postId, limit: 500}}) {
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

  // 3. Execute Fetch with Browser-like Headers
  const response = await fetch(apiEndpoint, {
    method: 'POST',
    headers: { 
      'Content-Type': 'application/json',
      'User-Agent': USER_AGENT,
      'Origin': baseUrl,
      'Referer': url,
      'Accept': 'application/json',
      'Cache-Control': 'no-cache'
    },
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
  const rawComments = json.data.comments.results;
  
  // 4. Process Comments into a Tree
  const commentMap = new Map<string, Comment>();
  const rootComments: Comment[] = [];

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
  
  const isLessWrong = url.includes('lesswrong.com');
  const isEAForum = url.includes('forum.effectivealtruism.org');

  if (isLessWrong || isEAForum) {
    try {
      console.log(`[Fetcher] Detected ${isLessWrong ? 'LessWrong' : 'EA Forum'}, using GraphQL API...`);
      return await fetchForumMagnumPost(url, isEAForum);
    } catch (error) {
      console.error(`[Fetcher] GraphQL fetch failed, falling back to standard scraper: ${error}`);
    }
  }

  // --- STANDARD SCRAPER (EXISTING LOGIC) ---
  
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Referer': 'https://www.google.com/',
        'Accept-Language': 'en-US,en;q=0.9'
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch URL: ${response.status} ${response.statusText}`);
    }

    const html = await response.text();
    const dom = new JSDOM(html, { url });
    const doc = dom.window.document;

    const scripts = doc.querySelectorAll('script');
    scripts.forEach(script => script.remove());
    const styles = doc.querySelectorAll('style');
    styles.forEach(style => style.remove());

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
      const authorSelectors = ['.author', '.byline', 'a[rel="author"]'];
      for (const selector of authorSelectors) {
        const el = doc.querySelector(selector);
        if (el) {
          author = el.textContent?.trim();
          break;
        }
      }
    }

    const publishedDate = 
      doc.querySelector('meta[property="article:published_time"]')?.getAttribute('content') || undefined;

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
