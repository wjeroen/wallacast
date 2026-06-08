import { JSDOM } from 'jsdom';
import { query } from '../database/db.js';
import { getChatClientForUser, getUserSetting } from './ai-providers.js';

/**
 * Article + comment summaries ("Twitter thread" style).
 *
 * Two separate summaries are produced:
 *   1. Article body summary — the LLM only sees the article.
 *   2. Comment discussion summary — the LLM sees the article as CONTEXT, then the comments.
 *
 * IMPORTANT (see CLAUDE.md / task spec): we NEVER ask the model to count characters.
 * We count the text length in code, look up the matching tier to get `maxTweets`, and
 * inject that number into the prompt as a variable.
 */

export interface SummaryTier {
  maxChars: number; // may be Infinity for the unbounded catch-all tier
  maxTweets: number;
}

// Default tiers — users can edit these in Settings (stored as JSON under `summary_tiers`).
export const DEFAULT_SUMMARY_TIERS: SummaryTier[] = [
  { maxChars: 1500, maxTweets: 1 },
  { maxChars: 3500, maxTweets: 2 },
  { maxChars: 7000, maxTweets: 3 },
  { maxChars: 12000, maxTweets: 4 },
  { maxChars: 18000, maxTweets: 5 },
  { maxChars: 28000, maxTweets: 6 },
  { maxChars: Infinity, maxTweets: 7 },
];

/**
 * Parse the stored `summary_tiers` JSON. Infinity is not valid JSON, so the unbounded
 * tier is stored with `maxChars: null` — we map it back to Infinity here.
 * Returns DEFAULT_SUMMARY_TIERS on any problem so a bad setting can never break generation.
 */
export function parseTiers(raw: string | null): SummaryTier[] {
  if (!raw) return DEFAULT_SUMMARY_TIERS;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0) return DEFAULT_SUMMARY_TIERS;
    const tiers: SummaryTier[] = parsed.map((t: any) => ({
      maxChars: t.maxChars === null || t.maxChars === undefined ? Infinity : Number(t.maxChars),
      maxTweets: Math.max(1, Math.round(Number(t.maxTweets) || 1)),
    }));
    // Must have at least one valid tier
    if (tiers.some(t => Number.isNaN(t.maxChars))) return DEFAULT_SUMMARY_TIERS;
    return tiers;
  } catch {
    return DEFAULT_SUMMARY_TIERS;
  }
}

/**
 * Look up the max number of paragraphs ("tweets") for a given character count.
 * Tiers are sorted ascending by maxChars; the first tier whose threshold the text
 * fits under wins. Anything larger than every finite tier uses the last (catch-all) tier.
 */
export function maxTweetsForChars(charCount: number, tiers: SummaryTier[]): number {
  const sorted = [...tiers].sort((a, b) => a.maxChars - b.maxChars);
  for (const t of sorted) {
    if (charCount <= t.maxChars) return t.maxTweets;
  }
  return sorted[sorted.length - 1].maxTweets;
}

// Strip HTML to readable plain text (used for char counting AND as the LLM input).
function htmlToPlainText(html: string): string {
  try {
    const dom = new JSDOM(html);
    const doc = dom.window.document;
    doc.querySelectorAll('script, style, noscript, iframe, svg, path, meta, link').forEach(el => el.remove());
    const text = doc.body?.textContent || '';
    return text.replace(/\s+/g, ' ').trim();
  } catch {
    return (html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  }
}

interface CommentLike {
  username?: string;
  date?: string;
  content?: string;
  replies?: CommentLike[];
}

// Flatten comments (including nested replies) into plain text for the summarizer.
function commentsToText(comments: CommentLike[], depth = 0): string {
  let out = '';
  for (const c of comments) {
    const who = c.username || 'Anonymous';
    const body = htmlToPlainText(c.content || '');
    if (body) out += `${'  '.repeat(depth)}${who}: ${body}\n`;
    if (c.replies && c.replies.length > 0) {
      out += commentsToText(c.replies, depth + 1);
    }
  }
  return out;
}

// Split a summary into paragraphs ("tweets"). Prefers blank-line separation (what we ask
// the model for) but falls back to single newlines so we never mis-count.
function splitParagraphs(text: string | null): string[] {
  const t = (text || '').trim();
  if (!t) return [];
  let parts = t.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);
  if (parts.length <= 1) parts = t.split(/\n+/).map(p => p.trim()).filter(Boolean);
  return parts;
}

// Log the real character length of each paragraph (spaces included) so we can see in the
// Railway logs whether the model is keeping tweets under the limit.
function logTweetLengths(label: string, text: string | null, limit: number): void {
  const paras = splitParagraphs(text);
  if (paras.length === 0) return;
  const lengths = paras.map(p => p.length);
  const over = lengths.filter(l => l > limit).length;
  console.log(`[Summary] ${label}: ${paras.length} paragraph(s), lengths=[${lengths.join(', ')}]${over ? ` — ${over} OVER ${limit}` : ''}`);
}

// Default per-paragraph length target, used when the user hasn't set `summary_max_chars`.
// We aim BELOW Twitter's real 280 limit because LLMs estimate length rather than count
// exactly, so they tend to overshoot — 240 keeps the actual output comfortably under 280.
const DEFAULT_MAX_TWEET_CHARS = 240;

// Read the user's per-paragraph character cap, falling back to the default. Clamped to a
// sane range so a bad setting can't produce a nonsensical prompt.
function parseMaxChars(raw: string | null): number {
  const n = parseInt(raw || '', 10);
  if (!Number.isFinite(n)) return DEFAULT_MAX_TWEET_CHARS;
  return Math.min(2000, Math.max(50, n));
}

const ARTICLE_SUMMARY_PROMPT = (maxTweets: number, maxChars: number): string => {
  if (maxTweets <= 1) {
    return `You write a one-paragraph, tweet-style summary of an article.
- Write a single paragraph, at most ${maxChars} characters (counting spaces and punctuation), that captures the article's central thesis or main takeaway.
- Use plain, direct language. Keep all facts, numbers, and names accurate, and never add anything not in the article. Prioritize the author's core claim over minor details.
- Output only the summary. No introductions, labels, headers, or sign-offs of any kind.`;
  }
  return `You write a concise summary of an article as a short thread of tweet-style paragraphs that together convey the article's main argument.
- The FIRST paragraph states the article's central thesis or main takeaway.
- The remaining paragraphs develop that thesis as a single line of reasoning, so reading top to bottom follows the argument rather than a list of disconnected facts.
- Write at most ${maxTweets} paragraphs. Use fewer when the article is simple; do not pad to reach the limit.
- Each paragraph is at most ${maxChars} characters (counting spaces and punctuation) and reads on its own, but together they must form one coherent line of reasoning.
- Use plain, direct language. Keep all facts, numbers, and names accurate, and never add anything not in the article. Prioritize the author's core claims and reasoning over minor details.
- Separate paragraphs with a single blank line.
- Output only the summary. No introductions, labels, headers, or sign-offs of any kind.`;
};

const COMMENT_SUMMARY_PROMPT = (maxTweets: number, maxChars: number): string => {
  if (maxTweets <= 1) {
    return `You write a one-paragraph, tweet-style summary of the COMMENT DISCUSSION beneath an article. The article is provided only as context. Do NOT summarize the article itself; summarize what the commenters say.
- Write a single paragraph, at most ${maxChars} characters (counting spaces and punctuation), capturing the overall gist of the discussion — its general tenor and the main point or two raised.
- Use plain, direct language. Keep all facts, numbers, and names accurate, and never add anything not in the comments.
- Output only the summary. No introductions, labels, headers, or sign-offs of any kind.`;
  }
  return `You write a concise summary of the COMMENT DISCUSSION beneath an article, as a short thread of tweet-style paragraphs. The article is provided only as context. Do NOT summarize the article itself; summarize what the commenters say.
- The FIRST paragraph captures the overall vibe of the discussion: its general tenor and where the room lands (broad agreement, sharp disagreement, mixed, mostly minor quibbles, etc.).
- The remaining paragraphs cover the main threads: key points, agreements, disagreements, questions, and notable additions. Group related points together rather than listing comments one by one.
- Write at most ${maxTweets} paragraphs. Use fewer when the discussion is simple; do not pad to reach the limit.
- Each paragraph is at most ${maxChars} characters (counting spaces and punctuation) and reads on its own, but together they form one coherent overview.
- Use plain, direct language. Keep all facts, numbers, and names accurate, and never add anything not in the comments.
- Separate paragraphs with a single blank line.
- Output only the summary. No introductions, labels, headers, or sign-offs of any kind.`;
};

const ARTICLE_INPUT_CAP = 200000;       // chars sent to the article summarizer
const ARTICLE_CONTEXT_CAP = 50000;      // chars of article context for the comment summarizer
const COMMENTS_INPUT_CAP = 200000;      // chars of comments sent to the comment summarizer

/**
 * Generate (or regenerate) the article + comment summaries for a content item.
 * Sets `summary_status` to 'completed' or 'failed' when done. Safe to fire-and-forget.
 */
export async function generateSummaryForContent(contentId: number): Promise<void> {
  console.log(`[Summary] ===== Generating summary for content ${contentId} =====`);
  try {
    const result = await query(
      'SELECT id, type, html_content, content, comments, user_id FROM content_items WHERE id = $1',
      [contentId]
    );
    if (result.rows.length === 0) {
      console.warn(`[Summary] Content ${contentId} not found`);
      return;
    }
    const item = result.rows[0];
    const userId = item.user_id;

    // 1. Article text + char count (counted in code, NOT by the model)
    const articleText = item.html_content ? htmlToPlainText(item.html_content) : (item.content || '').trim();
    if (!articleText) {
      throw new Error('No article text available to summarize');
    }
    const articleChars = articleText.length;

    // 2. Tier lookup → maxTweets for the article; per-paragraph char cap from settings
    const tiers = parseTiers(await getUserSetting(userId, 'summary_tiers'));
    const maxTweetsArticle = maxTweetsForChars(articleChars, tiers);
    const maxChars = parseMaxChars(await getUserSetting(userId, 'summary_max_chars'));

    // 3. LLM client (same router the narration scriptwriter uses)
    const chat = await getChatClientForUser(userId);
    if (!chat) {
      throw new Error('No AI API key set. Configure OpenAI or DeepInfra in Settings.');
    }
    console.log(`[Summary] articleChars=${articleChars} -> maxTweetsArticle=${maxTweetsArticle} maxChars=${maxChars} model=${chat.model}`);

    // 4. Article summary
    const articleResponse = await chat.client.chat.completions.create({
      model: chat.model,
      messages: [
        { role: 'system', content: ARTICLE_SUMMARY_PROMPT(maxTweetsArticle, maxChars) },
        { role: 'user', content: articleText.slice(0, ARTICLE_INPUT_CAP) },
      ],
    });
    const summary = (articleResponse.choices[0]?.message?.content || '').trim();
    logTweetLengths('article', summary, maxChars);

    // 5. Comment summary (optional) — only if enabled AND the item has comments
    let commentSummary: string | null = null;
    const summarizeComments = (await getUserSetting(userId, 'summarize_comments')) !== 'false'; // default ON
    let comments: CommentLike[] = [];
    if (item.comments) {
      comments = typeof item.comments === 'string' ? JSON.parse(item.comments) : item.comments;
    }
    if (summarizeComments && Array.isArray(comments) && comments.length > 0) {
      const commentsText = commentsToText(comments).trim();
      if (commentsText) {
        const commentChars = commentsText.length;
        const maxTweetsComments = maxTweetsForChars(commentChars, tiers);
        console.log(`[Summary] commentChars=${commentChars} -> maxTweetsComments=${maxTweetsComments}`);
        const commentResponse = await chat.client.chat.completions.create({
          model: chat.model,
          messages: [
            { role: 'system', content: COMMENT_SUMMARY_PROMPT(maxTweetsComments, maxChars) },
            {
              role: 'user',
              content:
                `ARTICLE (context only — do not summarize this):\n${articleText.slice(0, ARTICLE_CONTEXT_CAP)}\n\n` +
                `COMMENTS TO SUMMARIZE:\n${commentsText.slice(0, COMMENTS_INPUT_CAP)}`,
            },
          ],
        });
        commentSummary = (commentResponse.choices[0]?.message?.content || '').trim() || null;
        logTweetLengths('comments', commentSummary, maxChars);
      }
    } else {
      console.log(`[Summary] Skipping comment summary (enabled=${summarizeComments}, comments=${Array.isArray(comments) ? comments.length : 0})`);
    }

    await query(
      `UPDATE content_items
       SET summary = $1, comment_summary = $2, summary_status = 'completed', summary_generated_at = NOW()
       WHERE id = $3`,
      [summary, commentSummary, contentId]
    );
    console.log(`[Summary] ===== Done for content ${contentId} (article + ${commentSummary ? 'comment' : 'no comment'} summary) =====`);
  } catch (error: any) {
    console.error(`[Summary] Failed for content ${contentId}:`, error?.message || error);
    await query(
      `UPDATE content_items SET summary_status = 'failed' WHERE id = $1`,
      [contentId]
    ).catch(() => { /* swallow */ });
  }
}
