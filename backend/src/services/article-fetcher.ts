import { gotScraping } from 'got-scraping';
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
        extendedScore: number | null; // Often a JSON string or object depending on API version
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
        extendedScore: number | null;
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
 * Helper to parse the extendedScore field which can be somewhat dynamic.
 * On LessWrong: { agreement: 5, disagreement: 2 }
 * On EA Forum: { like: 10, love: 5 } (schema varies)
 */
function parseExtendedScore(score: any): { agree?: number; disagree?: number; raw?: any } {
  if (!score) return {};
  
  // Sometimes it's a JSON string, sometimes an object
  let data = score;
  if (typeof score === 'string') {
    try {
      data = JSON.parse(score);
    } catch (e) {
      return { raw: score };
    }
  }

  // Map common keys to agree/disagree for your UI
  // You can inspect 'data' to see exact EA Forum keys like 'love', 'creative', etc.
  return {
    agree: data.agreement ?? data.agree ?? data.upvotes,
    disagree: data.disagreement ?? data.disagree ?? data.downvotes,
    raw: data
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
  // CHANGED: Added 'extendedScore' to fetch reactions
  // CHANGED: Switched view to 'postCommentsNew' to fix EA Forum random comments bug
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
          extendedScore
          user {
            displayName
            slug
          }
          pageUrl
        }
      }
      comments(input: {terms: {view: "postCommentsNew", postId: $postId, limit: 500}}) {
        results {
          _id
          htmlBody
          postedAt
          baseScore
          extendedScore
          parentCommentId
          user {
            displayName
            slug
          }
        }
      }
    }
  `;

  // 3. Execute Fetch using got-scraping
  const response = await gotScraping.post(apiEndpoint, {
    json: {
      query,
      variables: { postId }
    },
    responseType: 'json',
    headers: {
      'Origin': baseUrl,
      'Referer': url,
    }
  });

  const json = response.body as GraphQLResponse;
  
  if (!json.data || !json.data.post || !json.data.post.result) {
    throw new Error('Post not found in GraphQL response');
  }

  const post = json.data.post.result;
  const rawComments = json.data.comments.results;

  // Process Post Extended Score
  const postReactions = parseExtendedScore(post.extendedScore);

  // 4. Process Comments into a Tree
  const commentMap = new Map<string, Comment>();
  const rootComments: Comment[] = [];

  rawComments.forEach(c => {
    const commentReactions = parseExtendedScore(c.extendedScore);
    
    commentMap.set(c._id, {
      id: c._id,
      username: c.user?.displayName || '[deleted]',
      date: c.postedAt,
      karma: c.baseScore,
      // Pass the raw object so your frontend can choose what to render (e.g. "Love")
      extendedScore: commentReactions.raw, 
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
    agree_votes: postReactions.agree,
    disagree_votes: postReactions.disagree,
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
      console.log(`[Fetcher] Detected ${isLessWrong ? 'LessWrong' : 'EA Forum'}, using GraphQL API with TLS spoofing...`);
      return await fetchForumMagnumPost(url, isEAForum);
    } catch (error: any) {
      console.error(`[Fetcher] GraphQL fetch failed: ${error.message}`);
      console.log('[Fetcher] Attempting fallback to standard scraper...');
    }
  }

  // --- STANDARD SCRAPER (got-scraping) ---
  
  try {
    const response = await gotScraping.get(url);
    const html = response.body;
    
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
