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

// Site-specific extractors
function isEAForum(url: string): boolean {
  return url.includes('forum.effectivealtruism.org');
}

function isLessWrong(url: string): boolean {
  return url.includes('lesswrong.com');
}

function extractEAForumMetadata(doc: Document): Partial<ArticleContent> {
  // Extract EA Forum-specific metadata
  const karma = doc.querySelector('.PostsVoteDefault-voteScore')?.textContent?.trim();
  const agreeEl = doc.querySelector('[class*="agree"]');
  const disagreeEl = doc.querySelector('[class*="disagree"]');
  const agreeMatch = agreeEl?.textContent?.match(/\d+/);
  const disagreeMatch = disagreeEl?.textContent?.match(/\d+/);

  return {
    karma: karma ? parseInt(karma) : undefined,
    agree_votes: agreeMatch ? parseInt(agreeMatch[0]) : undefined,
    disagree_votes: disagreeMatch ? parseInt(disagreeMatch[0]) : undefined,
  };
}

function extractEAForumComments(doc: Document): CommentData[] {
  const comments: CommentData[] = [];
  const commentElements = doc.querySelectorAll('.CommentsNode-root, .CommentFrame-root, [class*="CommentNode"]');

  commentElements.forEach((commentEl) => {
    try {
      const authorEl = commentEl.querySelector('.UsersNameDisplay-noColor, .CommentUserName-author, [class*="author"]');
      const commentAuthor = authorEl?.textContent?.trim();

      const timeEl = commentEl.querySelector('time');
      const commentDate = timeEl?.getAttribute('datetime') || timeEl?.textContent?.trim();

      const karmaEl = commentEl.querySelector('.CommentsVote-voteScore, .VoteScore, [class*="voteScore"]');
      const commentKarmaText = karmaEl?.textContent?.trim();
      const commentKarma = commentKarmaText ? parseInt(commentKarmaText) : undefined;

      const contentEl = commentEl.querySelector('.ContentStyles-commentBody, .CommentBody-root, [class*="commentBody"]');
      const commentContent = contentEl?.textContent?.trim();

      const agreeEl = commentEl.querySelector('[class*="agree"]');
      const disagreeEl = commentEl.querySelector('[class*="disagree"]');
      const agreeMatch = agreeEl?.textContent?.match(/(\d+)/);
      const disagreeMatch = disagreeEl?.textContent?.match(/(\d+)/);
      const agreeVotes = agreeMatch ? parseInt(agreeMatch[1]) : undefined;
      const disagreeVotes = disagreeMatch ? parseInt(disagreeMatch[1]) : undefined;

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
      console.error('Failed to extract EA Forum comment:', error);
    }
  });

  return comments;
}

function extractLessWrongMetadata(doc: Document): Partial<ArticleContent> {
  // LessWrong has similar structure to EA Forum
  const karma = doc.querySelector('.PostsVoteDefault-voteScore')?.textContent?.trim();

  return {
    karma: karma ? parseInt(karma) : undefined,
  };
}

function extractLessWrongComments(doc: Document): CommentData[] {
  // LessWrong uses similar comment structure to EA Forum
  return extractEAForumComments(doc);
}

export async function fetchArticleContent(url: string): Promise<ArticleContent> {
  try {
    const response = await fetch(url);
    const html = await response.text();

    // Use jsdom for proper DOM parsing
    const dom = new JSDOM(html);
    const doc = dom.window.document;

    // Extract title - try multiple sources (works for all sites)
    let title = 'Untitled';
    const ogTitle = doc.querySelector('meta[property="og:title"]')?.getAttribute('content');
    const citationTitle = doc.querySelector('meta[name="citation_title"]')?.getAttribute('content');
    const h1Title = doc.querySelector('h1')?.textContent;
    const titleTag = doc.querySelector('title')?.textContent;

    if (citationTitle) {
      title = citationTitle.trim();
    } else if (ogTitle) {
      title = ogTitle.replace(/ — EA Forum$/, '').replace(/ - LessWrong$/, '').trim();
    } else if (h1Title) {
      title = h1Title.trim();
    } else if (titleTag) {
      title = titleTag.replace(/ — EA Forum$/, '').replace(/ - LessWrong$/, '').trim();
    }

    // Site-specific extraction
    let karma: number | undefined;
    let agreeVotes: number | undefined;
    let disagreeVotes: number | undefined;
    let comments: CommentData[] = [];
    let commentsHtml: string | undefined;

    if (isEAForum(url)) {
      console.log('Extracting EA Forum metadata...');
      const eaMetadata = extractEAForumMetadata(doc);
      karma = eaMetadata.karma;
      agreeVotes = eaMetadata.agree_votes;
      disagreeVotes = eaMetadata.disagree_votes;
      comments = extractEAForumComments(doc);

      const commentsSection = doc.querySelector('.CommentsListSection-root');
      if (commentsSection) {
        commentsHtml = commentsSection.outerHTML;
      }

      console.log(`Extracted ${comments.length} EA Forum comments with metadata`);
    } else if (isLessWrong(url)) {
      console.log('Extracting LessWrong metadata...');
      const lwMetadata = extractLessWrongMetadata(doc);
      karma = lwMetadata.karma;
      comments = extractLessWrongComments(doc);
      console.log(`Extracted ${comments.length} LessWrong comments with metadata`);
    } else {
      console.log('Using generic extraction for unknown site');
      // Generic sites: no karma/votes, comments will be handled by GPT if present
      comments = [];
    }

    // Extract author - works for all sites
    let author: string | undefined;
    const citationAuthor = doc.querySelector('meta[name="citation_author"]')?.getAttribute('content');
    const ogAuthor = doc.querySelector('meta[property="og:author"]')?.getAttribute('content') ||
                     doc.querySelector('meta[name="author"]')?.getAttribute('content');
    const authorLink = doc.querySelector('[rel="author"]')?.textContent;
    const authorClass = doc.querySelector('.PostsAuthors-author, .author, [class*="author"]')?.textContent;

    if (citationAuthor) {
      author = citationAuthor.trim();
    } else if (ogAuthor) {
      author = ogAuthor.trim();
    } else if (authorLink) {
      author = authorLink.trim();
    } else if (authorClass) {
      author = authorClass.trim();
    }

    // Extract published date - works for all sites
    let publishedDate: string | undefined;
    const ogPublished = doc.querySelector('meta[property="article:published_time"]')?.getAttribute('content') ||
                       doc.querySelector('meta[property="og:published_time"]')?.getAttribute('content');
    const timeElement = doc.querySelector('time');

    if (ogPublished) {
      publishedDate = ogPublished;
    } else if (timeElement) {
      const datetime = timeElement.getAttribute('datetime');
      if (datetime) {
        publishedDate = datetime;
      } else {
        const dateText = timeElement.textContent?.trim();
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
