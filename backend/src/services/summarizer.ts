import type OpenAI from 'openai';
import { JSDOM } from 'jsdom';
import { query } from '../database/db.js';
import { PROCESSING_CONFIG } from '../config/processing.js';
import { getChatClientForJob, getUserSetting } from './ai-providers.js';

// Retry a chat-completion call with exponential backoff. Connection-level failures (e.g.
// "Premature close" / ECONNRESET on a reused keep-alive socket — see Node #63989) and
// 429/5xx are transient and almost always succeed on a fresh attempt. 4xx (bad request /
// auth) are NOT retried. Summaries previously had no retry, so these surfaced as failures
// while TTS/transcription (which already retry) silently recovered.
async function chatCreateWithRetry(
  client: OpenAI,
  params: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
  label: string
): Promise<OpenAI.Chat.Completions.ChatCompletion> {
  const { maxAttempts, baseDelayMs, maxDelayMs } = PROCESSING_CONFIG.retry;
  let lastErr: any;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await client.chat.completions.create(params);
    } catch (err: any) {
      lastErr = err;
      const status: number | undefined = err?.status;
      // Retry connection errors (no status) and 429/5xx; give up on 4xx.
      const retryable = status === undefined || status === 429 || (status >= 500 && status < 600);
      if (!retryable || attempt === maxAttempts) throw err;
      const delay = Math.min(baseDelayMs * Math.pow(2, attempt - 1), maxDelayMs);
      console.warn(`[Summary] ${label} attempt ${attempt}/${maxAttempts} failed (${status ?? 'conn'}): ${err?.message}. Retrying in ${delay}ms`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

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

// Log the word count of each paragraph so we can see in the Railway logs whether the model
// is keeping tweets under the word limit.
function logTweetLengths(label: string, text: string | null, limit: number): void {
  const paras = splitParagraphs(text);
  if (paras.length === 0) return;
  const counts = paras.map(p => p.split(/\s+/).filter(Boolean).length);
  const over = counts.filter(c => c > limit).length;
  console.log(`[Summary] ${label}: ${paras.length} paragraph(s), words=[${counts.join(', ')}]${over ? ` — ${over} OVER ${limit}` : ''}`);
}

// Default per-paragraph length target, in WORDS, used when the user hasn't set
// `summary_max_words`. Words are a more natural unit for the model to gauge than characters
// (which it tends to overshoot), so we cap by word count instead.
const DEFAULT_MAX_TWEET_WORDS = 40;

// Read the user's per-paragraph word cap, falling back to the default. Clamped to a sane
// range so a bad setting can't produce a nonsensical prompt.
function parseMaxWords(raw: string | null): number {
  const n = parseInt(raw || '', 10);
  if (!Number.isFinite(n)) return DEFAULT_MAX_TWEET_WORDS;
  return Math.min(500, Math.max(5, n));
}

// Fill a prompt template's {maxTweets}/{maxWords} placeholders with the real numbers. Used for
// both the built-in default templates below and any user-supplied custom prompt from Settings.
function fillTemplate(tpl: string, maxTweets: number, maxWords: number): string {
  return tpl
    .replace(/\{maxTweets\}/g, String(maxTweets))
    .replace(/\{maxWords\}/g, String(maxWords));
}

// Default multi-paragraph prompt templates. These double as the pre-fill text for the Settings
// "Custom prompts" boxes (served via GET /api/users/summary-prompt-defaults), so the user always
// starts editing from the exact current default. Use {maxTweets}/{maxWords} placeholders — keep
// these byte-identical to what ARTICLE/COMMENT/PODCAST_SUMMARY_PROMPT(>1) emit.
export const ARTICLE_SUMMARY_TEMPLATE = `You write a concise summary of an article as a short thread of tweet-style paragraphs, in the author's own voice — as if the author wrote the thread to summarize their own piece. The title and author are given at the top of the input.
- The first paragraph states the central thesis or main takeaway.
- The remaining paragraphs develop that thesis as a single line of reasoning, so reading top to bottom follows the argument rather than a list of disconnected facts.
- Write in the author's voice. The first person is allowed, but keep "I" to a minimum: do not open paragraphs with "I argue" or lean on "I" in every sentence. Let the points carry themselves.
- If the article is itself a roundup of several news stories, just highlight the most interesting ones rather than trying to cover them all.
- Write at most {maxTweets} paragraphs. Use fewer when the article is simple; do not pad to reach the limit.
- Each paragraph is at most {maxWords} words and reads on its own, but together they form one coherent line of reasoning.
- Use plain, direct language. Within a paragraph, prefer several short, simple sentences over one long sentence.
- Do not use em dashes or hyphens to break up sentences; write separate sentences instead.
- Keep all facts, numbers, and names accurate, and never add anything not in the article. Focus on the main argument and key points, not minor details.
- Separate paragraphs with a single blank line.
- Output only the summary. No introductions, labels, headers, or sign-offs of any kind.`;

export const COMMENT_SUMMARY_TEMPLATE = `You write a concise summary of the COMMENT DISCUSSION beneath an article, as a short thread of tweet-style paragraphs. The article's title and author are given at the top for context only. Do NOT summarize the article itself; summarize what the commenters say.
- The first paragraph captures the overall vibe of the discussion: its general tenor and where the room lands (broad agreement, sharp disagreement, mixed, mostly minor quibbles, etc.).
- The remaining paragraphs cover the main threads: key points, agreements, disagreements, questions, and notable additions. Group related points together rather than listing comments one by one.
- Write at most {maxTweets} paragraphs. Use fewer when the discussion is simple; do not pad to reach the limit.
- Each paragraph is at most {maxWords} words and reads on its own, but together they form one coherent overview.
- Use plain, direct language. Within a paragraph, prefer several short, simple sentences over one long sentence.
- Do not use em dashes or hyphens to break up sentences; write separate sentences instead.
- Keep all facts, numbers, and names accurate, and never add anything not in the comments.
- Separate paragraphs with a single blank line.
- Output only the summary. No introductions, labels, headers, or sign-offs of any kind.`;

export const PODCAST_SUMMARY_TEMPLATE = `You write a concise summary of a podcast episode based on its transcript, as a short thread of tweet-style paragraphs. The episode title, show name, and host are given at the top of the input. An EPISODE DESCRIPTION from the podcast feed may also be included: use it only as context — it usually spells host and guest names correctly — but do not summarize it (it can be promotional).
- The first paragraph states the episode's central topic or main takeaway.
- The remaining paragraphs cover the main threads of the conversation in the order that best conveys the substance, not necessarily chronological order.
- Name the hosts and guests where it helps; never guess names that aren't in the input. The transcript is auto-generated and may contain transcription mistakes, especially in names — when the description and transcript disagree on a name, trust the description's spelling.
- Write at most {maxTweets} paragraphs. Use fewer when the episode is simple; do not pad to reach the limit.
- Each paragraph is at most {maxWords} words and reads on its own, but together they form one coherent overview.
- Use plain, direct language. Within a paragraph, prefer several short, simple sentences over one long sentence.
- Do not use em dashes or hyphens to break up sentences; write separate sentences instead.
- Keep all facts, numbers, and names accurate, and never add anything not in the input. Ignore ads, sponsor reads, and housekeeping.
- Separate paragraphs with a single blank line.
- Output only the summary. No introductions, labels, headers, or sign-offs of any kind.`;

const ARTICLE_SUMMARY_PROMPT = (maxTweets: number, maxWords: number): string => {
  if (maxTweets <= 1) {
    return `You write a one-paragraph, tweet-style summary of an article, in the author's own voice — as if the author wrote it to summarize their own piece. The title and author are given at the top of the input.
- Write a single paragraph, at most ${maxWords} words, that captures the article's central thesis or main takeaway.
- Write in the author's voice. The first person is allowed, but keep "I" to a minimum: do not open with "I argue" or lean on "I" in every sentence. Let the points carry themselves.
- Use plain, direct language. Prefer several short, simple sentences over one long sentence.
- Do not use em dashes or hyphens to break up sentences; write separate sentences instead.
- Keep all facts, numbers, and names accurate, and never add anything not in the article. Focus on the main argument, not minor details.
- Output only the summary. No introductions, labels, headers, or sign-offs of any kind.`;
  }
  return fillTemplate(ARTICLE_SUMMARY_TEMPLATE, maxTweets, maxWords);
};

const COMMENT_SUMMARY_PROMPT = (maxTweets: number, maxWords: number): string => {
  if (maxTweets <= 1) {
    return `You write a one-paragraph, tweet-style summary of the COMMENT DISCUSSION beneath an article. The article's title and author are given at the top for context only. Do NOT summarize the article itself; summarize what the commenters say.
- Write a single paragraph, at most ${maxWords} words, capturing the overall gist of the discussion: its general tenor and the main point or two raised.
- Use plain, direct language. Prefer several short, simple sentences over one long sentence.
- Do not use em dashes or hyphens to break up sentences; write separate sentences instead.
- Keep all facts, numbers, and names accurate, and never add anything not in the comments.
- Output only the summary. No introductions, labels, headers, or sign-offs of any kind.`;
  }
  return fillTemplate(COMMENT_SUMMARY_TEMPLATE, maxTweets, maxWords);
};

const PODCAST_SUMMARY_PROMPT = (maxTweets: number, maxWords: number): string => {
  if (maxTweets <= 1) {
    return `You write a one-paragraph, tweet-style summary of a podcast episode based on its transcript. The episode title, show name, and host are given at the top of the input. An EPISODE DESCRIPTION from the podcast feed may also be included: use it only as context — it usually spells host and guest names correctly — but do not summarize it (it can be promotional).
- Write a single paragraph, at most ${maxWords} words, that captures the episode's central topic or main takeaway.
- Name the hosts and guests where it helps; never guess names that aren't in the input. The transcript is auto-generated and may contain transcription mistakes, especially in names — when the description and transcript disagree on a name, trust the description's spelling.
- Use plain, direct language. Prefer several short, simple sentences over one long sentence.
- Do not use em dashes or hyphens to break up sentences; write separate sentences instead.
- Keep all facts, numbers, and names accurate, and never add anything not in the input. Ignore ads, sponsor reads, and housekeeping.
- Output only the summary. No introductions, labels, headers, or sign-offs of any kind.`;
  }
  return fillTemplate(PODCAST_SUMMARY_TEMPLATE, maxTweets, maxWords);
};

// Resolve the system prompt for a summary job. A non-empty custom prompt from Settings overrides
// the built-in default for ALL tier sizes (the user's template should include {maxTweets}/{maxWords}
// placeholders; any it omits are simply left untouched). Blank/whitespace = use the default.
function resolveSummaryPrompt(
  custom: string | null,
  defaultFn: (maxTweets: number, maxWords: number) => string,
  maxTweets: number,
  maxWords: number
): string {
  const c = (custom || '').trim();
  return c ? fillTemplate(c, maxTweets, maxWords) : defaultFn(maxTweets, maxWords);
}

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
      'SELECT id, type, title, author, description, html_content, content, comments, transcript, podcast_show_name, user_id FROM content_items WHERE id = $1',
      [contentId]
    );
    if (result.rows.length === 0) {
      console.warn(`[Summary] Content ${contentId} not found`);
      return;
    }
    const item = result.rows[0];
    const userId = item.user_id;
    const isPodcast = item.type === 'podcast_episode';

    // 1. Source text + char count (counted in code, NOT by the model).
    // Podcasts summarize their Whisper transcript; articles/texts their body.
    const articleText = isPodcast
      ? (item.transcript || '').trim()
      : item.html_content ? htmlToPlainText(item.html_content) : (item.content || '').trim();
    if (!articleText) {
      throw new Error(isPodcast ? 'No transcript available to summarize' : 'No article text available to summarize');
    }
    const articleChars = articleText.length;

    // Title + author header so the model can name the author instead of guessing a gender.
    const metaHeader = isPodcast
      ? `EPISODE: ${item.title || 'Untitled'}\n${item.podcast_show_name ? `SHOW: ${item.podcast_show_name}\n` : ''}${item.author ? `HOST: ${item.author}\n` : ''}\n`
      : `TITLE: ${item.title || 'Untitled'}\n${item.author ? `AUTHOR: ${item.author}\n` : ''}\n`;

    // 2. Tier lookup → maxTweets for the article; per-paragraph word cap from settings
    const tiers = parseTiers(await getUserSetting(userId, 'summary_tiers'));
    const maxTweetsArticle = maxTweetsForChars(articleChars, tiers);
    const maxWords = parseMaxWords(await getUserSetting(userId, 'summary_max_words'));

    // Optional per-user custom prompts (blank = use the built-in default). The article/episode
    // prompt key depends on the content type; comments have their own key.
    const customArticlePrompt = await getUserSetting(userId, isPodcast ? 'summary_podcast_prompt' : 'summary_article_prompt');
    const customCommentPrompt = await getUserSetting(userId, 'summary_comment_prompt');

    // 3. LLM client for the Summaries job (provider/model/reasoning configurable in Settings)
    const chat = await getChatClientForJob(userId, 'summary');
    if (!chat) {
      throw new Error('No AI API key set. Configure a provider for Summaries in Settings.');
    }
    console.log(`[Summary] articleChars=${articleChars} -> maxTweetsArticle=${maxTweetsArticle} maxWords=${maxWords} model=${chat.model}`);

    // 4. Article/episode summary
    // Podcasts get the RSS episode description as labeled context: it usually
    // contains the correctly-spelled guest names, while the Whisper transcript
    // routinely mangles them. The description is NOT part of the char count for
    // the tier lookup and is never summarized itself.
    const descriptionContext = isPodcast && item.description
      ? htmlToPlainText(item.description).slice(0, 2000)
      : '';
    const userContent = isPodcast
      ? metaHeader +
        (descriptionContext
          ? `EPISODE DESCRIPTION (context only — do not summarize; names here are spelled correctly):\n${descriptionContext}\n\n`
          : '') +
        `TRANSCRIPT (auto-generated — may contain transcription mistakes, especially in names):\n${articleText.slice(0, ARTICLE_INPUT_CAP)}`
      : metaHeader + articleText.slice(0, ARTICLE_INPUT_CAP);

    const articleResponse = await chatCreateWithRetry(chat.client, {
      model: chat.model,
      ...chat.extraParams,
      messages: [
        {
          role: 'system',
          content: resolveSummaryPrompt(
            customArticlePrompt,
            isPodcast ? PODCAST_SUMMARY_PROMPT : ARTICLE_SUMMARY_PROMPT,
            maxTweetsArticle,
            maxWords
          ),
        },
        { role: 'user', content: userContent },
      ],
    }, 'article');
    const summary = (articleResponse.choices[0]?.message?.content || '').trim();
    logTweetLengths('article', summary, maxWords);

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
        const commentResponse = await chatCreateWithRetry(chat.client, {
          model: chat.model,
          ...chat.extraParams,
          messages: [
            { role: 'system', content: resolveSummaryPrompt(customCommentPrompt, COMMENT_SUMMARY_PROMPT, maxTweetsComments, maxWords) },
            {
              role: 'user',
              content:
                metaHeader +
                `ARTICLE (context only — do not summarize this):\n${articleText.slice(0, ARTICLE_CONTEXT_CAP)}\n\n` +
                `COMMENTS TO SUMMARIZE:\n${commentsText.slice(0, COMMENTS_INPUT_CAP)}`,
            },
          ],
        }, 'comments');
        commentSummary = (commentResponse.choices[0]?.message?.content || '').trim() || null;
        logTweetLengths('comments', commentSummary, maxWords);
      }
    } else {
      console.log(`[Summary] Skipping comment summary (enabled=${summarizeComments}, comments=${Array.isArray(comments) ? comments.length : 0})`);
    }

    await query(
      `UPDATE content_items
       SET summary = $1, comment_summary = $2, summary_status = 'completed', summary_generated_at = NOW(), summary_error = NULL
       WHERE id = $3`,
      [summary, commentSummary, contentId]
    );
    console.log(`[Summary] ===== Done for content ${contentId} (article + ${commentSummary ? 'comment' : 'no comment'} summary) =====`);
  } catch (error: any) {
    console.error(`[Summary] Failed for content ${contentId}:`, error?.message || error);
    const errMsg = (error?.message || 'Summary generation failed').toString().slice(0, 500);
    await query(
      `UPDATE content_items SET summary_status = 'failed', summary_error = $2 WHERE id = $1`,
      [contentId, errMsg]
    ).catch(() => { /* swallow */ });
  }
}
