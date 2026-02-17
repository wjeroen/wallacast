/**
 * LLM-based Content Alignment Service (v2)
 *
 * Replaces the Needleman-Wunsch algorithm approach with an LLM that maps
 * original HTML content elements to their audio timestamps.
 *
 * How it works:
 * 1. Extract block-level elements from HTML (paragraphs, headings, images, etc.)
 * 2. Extract comments as individual elements with metadata
 * 3. Build a sentence-chunked transcript with timestamps from Whisper
 * 4. Send elements + transcript to the user's selected LLM
 * 5. LLM returns a start time for each element
 * 6. Store as content_alignment JSONB with version: 'llm-v1'
 *
 * The frontend renders these elements using the same CSS as content + comments tabs,
 * with per-element highlighting and autoscroll.
 */

import { JSDOM } from 'jsdom';
import { getChatClientForUser, getUserSetting } from './ai-providers.js';
import { query } from '../database/db.js';

interface TranscriptWord {
  word: string;
  start: number;
  end: number;
}

interface ContentElement {
  type: 'title' | 'meta' | 'heading' | 'paragraph' | 'image' | 'blockquote' | 'list' | 'code-block' | 'comment-divider' | 'comment';
  html: string;
  text: string; // Plain text for LLM matching (not stored in final result)
  commentMeta?: {
    username: string;
    date?: string;
    karma?: number;
    extendedScore?: Record<string, number>;
    depth: number;
  };
}

export interface LLMAlignmentElement {
  type: string;
  html: string;
  startTime: number;
  commentMeta?: {
    username: string;
    date?: string;
    karma?: number;
    extendedScore?: Record<string, number>;
    depth: number;
  };
}

export interface LLMAlignmentResult {
  version: string;
  elements: LLMAlignmentElement[];
  commentsStartTime: number | null;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Find image description from alt-text data, trying multiple URL matching strategies
 */
function findImageDescription(src: string, descriptions: Record<string, string>, contentUrl?: string): string | null {
  if (!src) return null;

  // Direct match
  if (descriptions[src]) return descriptions[src];

  // Try absolute URL
  if (contentUrl) {
    try {
      const absoluteSrc = new URL(src, contentUrl).href;
      if (descriptions[absoluteSrc]) return descriptions[absoluteSrc];
    } catch { /* ignore */ }
  }

  // Fuzzy match (ignore query params)
  const cleanSrc = src.split('?')[0];
  for (const [storedUrl, desc] of Object.entries(descriptions)) {
    if (storedUrl.split('?')[0] === cleanSrc) return desc;
  }

  return null;
}

/**
 * Extract block-level elements from HTML content.
 * Returns elements in document order, filtering out nested duplicates.
 */
function extractContentElements(
  htmlContent: string,
  title?: string,
  author?: string,
  publishedAt?: string,
  karma?: number,
  url?: string,
  imageAltTextData?: any
): ContentElement[] {
  const elements: ContentElement[] = [];

  // Add metadata elements (these ARE spoken in the audio, kept as separate
  // elements so they display individually in the read-along tab)
  if (title) {
    elements.push({
      type: 'title',
      html: `<h2>${escapeHtml(title)}</h2>`,
      text: `Title: ${title}.`,
    });
  }

  // Author + date on one line
  if (author) {
    const cleanAuthor = author.replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu, '').trim();
    let metaText = `Written by ${cleanAuthor}.`;
    let metaHtml = `By ${escapeHtml(cleanAuthor)}`;
    if (publishedAt) {
      try {
        const date = new Date(publishedAt);
        const formatted = date.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
        metaText += ` Published on ${formatted}.`;
        metaHtml += ` · ${escapeHtml(formatted)}`;
      } catch { /* ignore */ }
    }
    elements.push({
      type: 'meta',
      html: `<p class="content-author">${metaHtml}</p>`,
      text: metaText,
    });
  } else if (publishedAt) {
    try {
      const date = new Date(publishedAt);
      const formatted = date.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
      elements.push({
        type: 'meta',
        html: `<p class="content-author">${escapeHtml(formatted)}</p>`,
        text: `Published on ${formatted}.`,
      });
    } catch { /* ignore */ }
  }

  // Karma for EA Forum/LW
  const isEAForumOrLW = url && (url.includes('forum.effectivealtruism.org') || url.includes('lesswrong.com'));
  if (isEAForumOrLW && karma !== undefined && karma !== null) {
    elements.push({
      type: 'meta',
      html: `<p class="content-author">${karma} karma</p>`,
      text: `It has ${karma} karma.`,
    });
  }

  if (!htmlContent) return elements;

  // Parse HTML body into block elements
  const dom = new JSDOM(htmlContent);
  const doc = dom.window.document;

  // Remove non-content elements
  doc.querySelectorAll('script, style, nav, footer, aside, noscript, iframe, svg').forEach(el => el.remove());

  // Get image descriptions for matching
  const imageDescriptions: Record<string, string> = imageAltTextData?.descriptions || {};

  // Select meaningful block elements
  const BLOCK_SELECTOR = 'h1, h2, h3, h4, h5, h6, p, ul, ol, blockquote, figure, img, pre, table';
  const allBlocks = Array.from(doc.querySelectorAll(BLOCK_SELECTOR));

  // Filter out elements that are descendants of other selected elements
  // e.g., a <p> inside a <blockquote> should be skipped (blockquote captures it)
  const topLevelBlocks = allBlocks.filter((el) => {
    for (const other of allBlocks) {
      if (other !== el && other.contains(el)) {
        return false;
      }
    }
    return true;
  });

  for (const el of topLevelBlocks) {
    const tagName = el.tagName.toLowerCase();
    const text = (el.textContent || '').trim();

    if (tagName === 'img') {
      const src = el.getAttribute('src') || '';
      const alt = el.getAttribute('alt') || '';
      const description = findImageDescription(src, imageDescriptions, url) || alt;

      el.setAttribute('style', 'max-width: 100%; height: auto; border-radius: 0.5rem; margin: 0.5em 0;');

      elements.push({
        type: 'image',
        html: (el as Element).outerHTML,
        text: description ? `[Image: ${description.slice(0, 150)}]` : '[Image]',
      });
    } else if (tagName === 'figure') {
      const img = el.querySelector('img');
      if (img) {
        const src = img.getAttribute('src') || '';
        const alt = img.getAttribute('alt') || '';
        const description = findImageDescription(src, imageDescriptions, url) || alt;
        img.setAttribute('style', 'max-width: 100%; height: auto; border-radius: 0.5rem;');
        elements.push({
          type: 'image',
          html: (el as Element).outerHTML,
          text: description ? `[Image: ${description.slice(0, 150)}]` : '[Image]',
        });
      } else if (text) {
        elements.push({ type: 'paragraph', html: (el as Element).outerHTML, text });
      }
    } else if (tagName.startsWith('h')) {
      if (text) {
        elements.push({ type: 'heading', html: (el as Element).outerHTML, text });
      }
    } else if (tagName === 'blockquote') {
      if (text) {
        elements.push({ type: 'blockquote', html: (el as Element).outerHTML, text: `Quote: ${text}` });
      }
    } else if (tagName === 'ul' || tagName === 'ol') {
      if (text) {
        elements.push({ type: 'list', html: (el as Element).outerHTML, text });
      }
    } else if (tagName === 'pre') {
      if (text) {
        elements.push({ type: 'code-block', html: (el as Element).outerHTML, text: text.slice(0, 200) });
      }
    } else if (tagName === 'table') {
      if (text) {
        elements.push({ type: 'paragraph', html: (el as Element).outerHTML, text: text.slice(0, 300) });
      }
    } else {
      // p, div, etc.
      if (text) {
        elements.push({ type: 'paragraph', html: (el as Element).outerHTML, text });
      }
    }
  }

  return elements;
}

/**
 * Format a date string into ordinal narration form: "23rd of January 2026"
 * Must match openai-tts.ts formatDateForNarration() exactly.
 */
function formatDateForLLM(dateString: string): string {
  try {
    const date = new Date(dateString);
    const day = date.getDate();
    const month = date.toLocaleDateString('en-US', { month: 'long' });
    const year = date.getFullYear();
    const suffix = ['th', 'st', 'nd', 'rd'];
    const v = day % 100;
    const ordinalDay = day + (suffix[(v - 20) % 10] || suffix[v] || suffix[0]);
    return `${ordinalDay} of ${month} ${year}`;
  } catch {
    return dateString;
  }
}

/**
 * Format karma/reactions into narration text: "8 upvotes, 3 agreement"
 * Must match openai-tts.ts formatReactionsForNarration() exactly.
 */
function formatReactionsForLLM(karma?: number, extendedScore?: Record<string, number>, isLessWrong: boolean = false): string {
  const parts: string[] = [];
  if (karma !== undefined && karma !== null) {
    parts.push(`${karma} ${karma === 1 ? 'upvote' : 'upvotes'}`);
  }
  if (extendedScore) {
    if (isLessWrong) {
      if (typeof extendedScore.agreement === 'number') {
        parts.push(`${extendedScore.agreement} agreement`);
      }
    } else {
      for (const [reaction, count] of Object.entries(extendedScore)) {
        if (count > 0 && reaction !== 'baseScore') {
          parts.push(`${count} ${reaction}`);
        }
      }
    }
  }
  return parts.join(', ');
}

/**
 * Flatten nested comments into a linear list with depth tracking.
 * The `text` field matches the TTS scriptwriter's spoken format so the LLM
 * can find the comment HEADER ("Username on Date with N upvotes:") in the transcript,
 * not just the comment body text.
 */
function extractCommentElements(comments: any[], depth: number = 0, parentUsername?: string, isLessWrong: boolean = false): ContentElement[] {
  const elements: ContentElement[] = [];

  for (const comment of comments) {
    // Strip emojis from username (same as TTS scriptwriter)
    const username = ((comment.username || 'Anonymous') as string)
      .replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu, '').trim();
    const commentHtml = comment.content || '';
    const plainText = commentHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

    // Build intro matching TTS scriptwriter format exactly:
    // Top-level: "Username on 23rd of January 2026 with 8 upvotes"
    // Reply:     "A reply to ParentUser by Username on 23rd of January 2026 with 3 upvotes"
    let intro = '';
    if (depth > 0 && parentUsername) {
      intro = `A reply to ${parentUsername} by ${username}`;
    } else {
      intro = `${username}`;
    }
    const date = comment.date ? formatDateForLLM(comment.date) : '';
    if (date) intro += ` on ${date}`;
    const reactions = formatReactionsForLLM(comment.karma, comment.extendedScore, isLessWrong);
    if (reactions) intro += ` with ${reactions}`;

    const llmText = `${intro}: ${plainText}`;

    elements.push({
      type: 'comment',
      html: commentHtml,
      text: llmText.slice(0, 500),
      commentMeta: {
        username,
        date: comment.date,
        karma: comment.karma,
        extendedScore: comment.extendedScore,
        depth,
      },
    });

    if (comment.replies && comment.replies.length > 0) {
      elements.push(...extractCommentElements(comment.replies, depth + 1, username, isLessWrong));
    }
  }

  return elements;
}

/**
 * Build sentence-chunked transcript from word-level timestamps.
 * Groups words into clauses, splitting at sentence-ending punctuation
 * (. ? ! : ,) so each line gets its own timestamp.
 *
 * Treating : and , as boundaries is critical because:
 * - "Comments section:" needs its own line to be matchable
 * - "Username on Date with N upvotes:" needs its own line (comment headers)
 * - "Title, Do Your Job," separates from "written by Max Dalton."
 *
 * Output:
 * [0.0] Title,
 * [0.2] Do Your Job Unreasonably Well,
 * [1.1] written by Max Dalton.
 * [2.8] Published on 27th of January, 2026,
 * [4.6] it has 102 karma.
 */
function buildTimedTranscript(words: TranscriptWord[]): string {
  if (words.length === 0) return '';

  const sentences: string[] = [];
  let currentWords: string[] = [];
  let sentenceStart: number = words[0].start;

  for (const word of words) {
    const trimmed = (word.word || '').trim();
    if (!trimmed) continue;

    if (currentWords.length === 0) {
      sentenceStart = word.start;
    }
    currentWords.push(trimmed);

    // Break at all punctuation: . ? ! : , ; (optionally followed by " ' ) ])
    const isClauseEnd = /[.!?:,;]["')\]]?$/.test(trimmed);

    if (isClauseEnd) {
      sentences.push(`[${sentenceStart.toFixed(1)}] ${currentWords.join(' ')}`);
      currentWords = [];
    }
  }

  // Remaining words
  if (currentWords.length > 0) {
    sentences.push(`[${sentenceStart.toFixed(1)}] ${currentWords.join(' ')}`);
  }

  return sentences.join('\n');
}

/**
 * Main entry point: generate LLM-based content alignment.
 * Extracts content elements, builds timed transcript, calls LLM,
 * and returns structured alignment data for the read-along tab.
 */
export async function generateLLMAlignment(
  contentId: number,
  userId: number,
  transcriptWords: TranscriptWord[]
): Promise<LLMAlignmentResult> {
  console.log('[LLM-Align] Starting LLM-based content alignment...');

  // Get content from DB
  const result = await query(
    'SELECT title, author, published_at, karma, url, html_content, comments, image_alt_text_data FROM content_items WHERE id = $1',
    [contentId]
  );

  if (result.rows.length === 0) {
    throw new Error('Content not found');
  }

  const content = result.rows[0];

  // Check if image descriptions are enabled — if disabled, don't pass old Gemini data
  // to extractContentElements. When disabled, images show as plain [Image] in the element
  // list (matching what's in the audio, since injectImageNarrations also checks this toggle).
  const imageAltTextEnabled = await getUserSetting(userId, 'image_alt_text_enabled');
  const imageAltTextData = imageAltTextEnabled !== 'false' ? content.image_alt_text_data : null;

  // Extract content elements from HTML
  const contentElements = extractContentElements(
    content.html_content || '',
    content.title,
    content.author,
    content.published_at,
    content.karma,
    content.url,
    imageAltTextData
  );

  // Extract comment elements
  let commentElements: ContentElement[] = [];
  const isLessWrong = content.url && content.url.includes('lesswrong.com');

  if (content.comments) {
    try {
      const comments = typeof content.comments === 'string'
        ? JSON.parse(content.comments)
        : content.comments;

      if (comments && Array.isArray(comments) && comments.length > 0) {
        commentElements = extractCommentElements(comments, 0, undefined, isLessWrong);
      }
    } catch (e) {
      console.error('[LLM-Align] Failed to parse comments:', e);
    }
  }

  // Combine all elements
  // Filter out bare image placeholders when image descriptions are disabled —
  // they aren't spoken in the audio, so including them confuses the LLM and
  // causes the frontend to highlight images instead of the text being spoken.
  const filteredContentElements = imageAltTextEnabled !== 'false'
    ? contentElements
    : contentElements.filter(el => el.type !== 'image');

  const allElements: ContentElement[] = [...filteredContentElements];

  if (commentElements.length > 0) {
    allElements.push({
      type: 'comment-divider',
      html: '',
      text: 'Comments section:',
    });
    allElements.push(...commentElements);
  }

  const filteredCount = contentElements.length - filteredContentElements.length;
  console.log(`[LLM-Align] ${filteredContentElements.length} content elements${filteredCount > 0 ? ` (${filteredCount} images filtered out — descriptions disabled)` : ''}, ${commentElements.length} comment elements`);

  // Build timed transcript
  const timedTranscript = buildTimedTranscript(transcriptWords);

  // Calculate total audio duration
  const totalAudioDuration = transcriptWords.length > 0
    ? Math.ceil(transcriptWords[transcriptWords.length - 1].end)
    : 0;

  // Build element list for the prompt
  const elementsList = allElements.map((el, i) => {
    const typeLabel = el.type === 'comment'
      ? `comment by ${el.commentMeta?.username || 'Unknown'}`
      : el.type;
    const maxLen = el.type === 'comment' ? 300 : 200;
    const displayText = el.text.length > maxLen ? el.text.slice(0, maxLen) + '...' : el.text;
    return `${i}. (${typeLabel}) ${displayText}`;
  }).join('\n');

  console.log(`[LLM-Align] Total audio duration: ${totalAudioDuration}s`);

  // Diagnostic: search CHUNKED transcript lines for "comment"
  const transcriptLines = timedTranscript.split('\n');
  const commentLines = transcriptLines.filter(line => /comment/i.test(line));
  if (commentLines.length > 0) {
    console.log(`[LLM-Align] DIAGNOSTIC: Transcript lines containing "comment":`);
    commentLines.forEach(line => console.log(`[LLM-Align]   ${line}`));
  } else {
    console.log(`[LLM-Align] DIAGNOSTIC: No transcript lines contain the word "comment"!`);
  }

  // Diagnostic: search RAW Whisper words for comment/section variations
  // This catches cases where sentence-chunking might split "Comments" and "section" across lines
  const commentWordMatches = transcriptWords.filter(w =>
    /comm|sect|comment|section/i.test((w.word || '').trim())
  );
  if (commentWordMatches.length > 0) {
    console.log(`[LLM-Align] DIAGNOSTIC: Raw Whisper words matching comm/sect:`);
    commentWordMatches.forEach(w => console.log(`[LLM-Align]   "${w.word.trim()}" at ${w.start.toFixed(1)}s`));
  } else {
    console.log(`[LLM-Align] DIAGNOSTIC: No raw Whisper words match comm/sect! Whisper may have dropped "Comments section" entirely.`);
  }

  // Log last 5 transcript lines (comment section transition area)
  console.log(`[LLM-Align] DIAGNOSTIC: Last 5 transcript lines:`);
  transcriptLines.slice(-5).forEach(line => console.log(`[LLM-Align]   ${line}`));

  // Diagnostic: dump raw Whisper words in the transition zone (last content → first comment)
  // This shows EXACTLY what Whisper captured, word by word, including the "Comments section" gap
  const lastTranscriptLine = transcriptLines[transcriptLines.length - 1];
  const lastTimestampMatch = lastTranscriptLine?.match(/^\[([\d.]+)\]/);
  const lastContentTime = lastTimestampMatch ? parseFloat(lastTimestampMatch[1]) : 0;
  // Show words from 30s before end to 10s after (covers the transition to first comment)
  const transitionStart = Math.max(0, lastContentTime - 30);
  const transitionEnd = lastContentTime + 10;
  const transitionWords = transcriptWords.filter(w => w.start >= transitionStart && w.start <= transitionEnd);
  if (transitionWords.length > 0) {
    console.log(`[LLM-Align] DIAGNOSTIC: Raw Whisper words from ${transitionStart.toFixed(0)}s to ${transitionEnd.toFixed(0)}s (article→comments transition):`);
    // Group by ~2 second windows for readability
    let currentWindowStart = transitionWords[0].start;
    let windowWords: string[] = [];
    for (const w of transitionWords) {
      if (w.start - currentWindowStart > 2 && windowWords.length > 0) {
        console.log(`[LLM-Align]   [${currentWindowStart.toFixed(1)}] ${windowWords.join(' ')}`);
        windowWords = [];
        currentWindowStart = w.start;
      }
      windowWords.push((w.word || '').trim());
    }
    if (windowWords.length > 0) {
      console.log(`[LLM-Align]   [${currentWindowStart.toFixed(1)}] ${windowWords.join(' ')}`);
    }
  }

  // Log the elements list being sent to the LLM (first 10 + last 10)
  const elementsLines = elementsList.split('\n');
  if (elementsLines.length <= 20) {
    console.log(`[LLM-Align] DIAGNOSTIC: Elements list being sent to LLM (${elementsLines.length} total):\n${elementsList}`);
  } else {
    const first10 = elementsLines.slice(0, 10).join('\n');
    const last10 = elementsLines.slice(-10).join('\n');
    console.log(`[LLM-Align] DIAGNOSTIC: Elements list being sent to LLM (${elementsLines.length} total, showing first 10 + last 10):\n${first10}\n  ... (${elementsLines.length - 20} more) ...\n${last10}`);
  }

  // Log first 500 chars of the timed transcript sent to LLM
  console.log(`[LLM-Align] DIAGNOSTIC: Timed transcript preview (first 500 chars of ${timedTranscript.length} total):\n${timedTranscript.slice(0, 500)}${timedTranscript.length > 500 ? '\n  ...' : ''}`);

  // Single prompt — LLM reasons through each match, marks answers with >>>
  // Elements come FIRST so the LLM knows what to look for, then the transcript.
  const prompt = `I have an article that was read aloud as audio. Below are the article's content elements, followed by the timestamped transcript from the audio. Your job is to find where each element starts being spoken in the transcript, so that we can sync the original text with the audio.
Keep in mind that the transcription is generated by AI, so some words and names won't always be transcribed accurately. You need to find the best matches, not exact matches. 
If you are struggling with this task because you can't find good matches, please explain what is going wrong first and what you are struggling with, but then still try to continue and find the best matches and follow all of these rules. 

For each element, explain which transcript line matches it and why, then write the answer on a new line starting with >>>.

CRITICAL: Process elements STRICTLY in sequential order: element 0, then 1, then 2, then 3, etc. Do NOT skip ahead or go back. After matching element N, start searching for element N+1 from where you left off.

IMPORTANT RULES:
- Each timestamp must be >= the previous one. If an element isn't spoken, reuse the previous timestamp.
- Make sure you process every single element strictly in sequential order. 
- The title, author attribution ("Written by ..."), and karma count are ALWAYS spoken at the very START of the audio (first ~15 seconds). Do NOT confuse them with later mentions of the same author name in comments.
- For comments, first try to match the HEADER (the "Username on Date with N upvotes:" line).
- If the header is NOT in the transcript (Whisper sometimes drops comment headers), match the START of the comment BODY text instead.
- Note: A username like "Johnny Bravo" might appear in ANOTHER comment's header (e.g. "A reply to Johnny Bravo by Car McVroom"). That is NOT Johnny Bravo's own comment!
- For the comment-divider, look for "Comments section:" in the transcript. If the phrase isn't there, use the timestamp just before the first comment starts.
- The scriptwriter may have rephrased text, added numbering to lists ("First, ...", "Second, ..."), or changed wording. Match by meaning, not exact wording.
- Images (if present in the elements list) are spoken in the audio as "An image shows [description]. End of description." Match images by looking for "an image shows" followed by similar description words in the transcript. If no image elements appear in the list, ignore this rule.
- CRITICAL: Use ONLY real [timestamp] values from the TRANSCRIPT section below. The two examples below are from DIFFERENT articles and their timestamps do NOT apply here. You MUST find timestamps from YOUR transcript, not from these examples.

Below are two examples from other articles showing the expected output format.

EXAMPLE 1 (from an article about cars):
"Element 0 is the title "How To Flex Your Car" — the transcript has "How To Flex Your Car," at [0.0] which matches.
>>> 0: 0.0

Element 1 is "Written by Car McVroom" — I see "written by Car McVroom." at [2.8].
>>> 1: 2.8

Element 2 is an image — looking for "an image shows" in the transcript... found at [18.5].
>>> 2: 18.5

Element 3 is a comment-divider — I see "comments section" at [35.1].
>>> 3: 35.1

Element 4 is a comment by SmartyPants — found "SmartyPants on 28th of January" at [35.1].
>>> 4: 35.1"

EXAMPLE 2 (from a longer article about cooking):
"Element 0 is the title "The Science of Baking Bread" — transcript line at 0.0s says "The Science of Baking Bread."
>>> 0: 0.0

Element 1 is "Written by Mr. Chef" — I see "written by Mr. Chef." at 3.2s.
>>> 1: 3.2

Element 2 is an image — I see "an image shows" in the transcript at 14.3s.
>>> 2: 14.3

Element 3 is a heading "Ingredients" — transcript has "Ingredients." at 47.9s.
>>> 3: 47.9

Element 4 is a footnote — not spoken in audio, reusing previous timestamp.
>>> 4: 47.9

Element 5 is a comment by BreadLover — can't find header, but body text "This recipe changed my life" appears at 203.6s.
>>> 5: 203.6"

Remember: these example timestamps (0.0, 2.8, 18.5, 35.1, 3.2, 47.9, 203.6) are from DIFFERENT articles. Do NOT use any of these numbers. Find timestamps from the transcript provided below.

ELEMENTS TO MATCH (${allElements.length} total):
${elementsList}

TRANSCRIPT (${totalAudioDuration}s audio):
${timedTranscript}

Now go through each element 0 to ${allElements.length - 1} IN ORDER. For every single one of them, explain your reasoning, then write >>> followed by the element number and timestamp.`;

  // Call LLM
  const chatConfig = await getChatClientForUser(userId);
  if (!chatConfig) {
    throw new Error('No LLM configured. Please set up a DeepInfra or OpenAI API key in Settings.');
  }

  console.log(`[LLM-Align] Calling ${chatConfig.model} with ${allElements.length} elements...`);

  const response = await chatConfig.client.chat.completions.create({
    model: chatConfig.model,
    messages: [
      { role: 'user', content: prompt },
    ],
    max_completion_tokens: 128000,
  });

  const responseText = response.choices[0]?.message?.content || '';
  console.log(`[LLM-Align] LLM response length: ${responseText.length} chars`);
  // Log full response so reasoning is visible in Railway logs
  console.log(`[LLM-Align] Full LLM response:\n${responseText}`);

  // Parse response — only extract lines starting with >>>
  let timestamps: number[];
  let usedFallback = false;
  try {
    const timestampMap = new Map<number, number>();
    const lines = responseText.split('\n');
    for (const line of lines) {
      // Primary: match ">>> 0: 0.0" lines (the marked answers)
      const markedMatch = line.match(/^>>>\s*(\d+)\s*:\s*([\d.]+)/);
      if (markedMatch) {
        const index = parseInt(markedMatch[1], 10);
        const timestamp = parseFloat(markedMatch[2]);
        if (!isNaN(index) && !isNaN(timestamp) && index >= 0 && index < allElements.length) {
          timestampMap.set(index, timestamp);
        }
      }
    }

    console.log(`[LLM-Align] Parsed ${timestampMap.size}/${allElements.length} >>> markers`);

    // Fallback 1: if no >>> markers, try plain "0: 0.0" lines
    if (timestampMap.size === 0) {
      console.warn('[LLM-Align] No >>> markers found, trying plain index:timestamp lines...');
      for (const line of lines) {
        const match = line.match(/^\s*\[?(\d+)\]?\s*[:=]\s*([\d.]+)/);
        if (match) {
          const index = parseInt(match[1], 10);
          const timestamp = parseFloat(match[2]);
          if (!isNaN(index) && !isNaN(timestamp) && index >= 0 && index < allElements.length) {
            timestampMap.set(index, timestamp);
          }
        }
      }
      if (timestampMap.size > 0) {
        console.log(`[LLM-Align] Plain format fallback: parsed ${timestampMap.size} pairs`);
      }
    }

    // Fallback 2: try JSON array
    if (timestampMap.size === 0) {
      console.warn('[LLM-Align] No index:timestamp pairs found, trying JSON array fallback...');
      const jsonMatch = responseText.match(/\[[\s\S]*?\]/);
      if (!jsonMatch) {
        throw new Error('No timestamps found in LLM response');
      }
      const parsed = JSON.parse(jsonMatch[0]);
      if (!Array.isArray(parsed)) throw new Error('Parsed result is not an array');
      parsed.forEach((val: any, i: number) => {
        const n = typeof val === 'number' ? val : parseFloat(String(val));
        if (!isNaN(n) && i < allElements.length) timestampMap.set(i, n);
      });
      console.log(`[LLM-Align] JSON fallback: parsed ${timestampMap.size} timestamps`);
    }

    // Build timestamps array from map — missing elements get previous value
    timestamps = [];
    let missingCount = 0;
    for (let i = 0; i < allElements.length; i++) {
      if (timestampMap.has(i)) {
        timestamps.push(timestampMap.get(i)!);
      } else {
        const prev = timestamps.length > 0 ? timestamps[timestamps.length - 1] : 0;
        timestamps.push(prev);
        missingCount++;
      }
    }
    if (missingCount > 0) {
      console.warn(`[LLM-Align] ${missingCount} elements missing from LLM response, filled with previous timestamps`);
    }

    // M.SS safety net: if all timestamps are way too small, LLM used minutes.seconds
    const maxTs = Math.max(...timestamps);
    if (totalAudioDuration > 60 && maxTs > 0 && maxTs < totalAudioDuration * 0.25) {
      console.warn(`[LLM-Align] Detected M.SS format (max ${maxTs}s vs ${totalAudioDuration}s). Converting...`);
      timestamps = timestamps.map(t => {
        const minutes = Math.floor(t);
        const seconds = Math.round((t - minutes) * 100);
        return minutes * 60 + seconds;
      });
    }

    // Ensure non-decreasing
    for (let i = 1; i < timestamps.length; i++) {
      if (timestamps[i] < timestamps[i - 1]) {
        timestamps[i] = timestamps[i - 1];
      }
    }

    // Coverage check — if LLM didn't match the end, stretch the tail
    const finalTs = timestamps[timestamps.length - 1];
    if (totalAudioDuration > 60 && finalTs > 0 && finalTs < totalAudioDuration * 0.85) {
      console.warn(`[LLM-Align] Timestamps only cover ${finalTs.toFixed(0)}s of ${totalAudioDuration}s audio (${(finalTs / totalAudioDuration * 100).toFixed(0)}%). Stretching tail...`);
      const stretchIdx = Math.floor(timestamps.length * 0.7);
      const anchorTime = timestamps[stretchIdx];
      const targetEnd = totalAudioDuration * 0.95;
      const currentRange = finalTs - anchorTime;
      if (currentRange > 0) {
        const scale = (targetEnd - anchorTime) / currentRange;
        for (let i = stretchIdx + 1; i < timestamps.length; i++) {
          timestamps[i] = Math.round((anchorTime + (timestamps[i] - anchorTime) * scale) * 10) / 10;
        }
        for (let i = 1; i < timestamps.length; i++) {
          if (timestamps[i] < timestamps[i - 1]) timestamps[i] = timestamps[i - 1];
        }
        console.log(`[LLM-Align] Stretched: ${finalTs.toFixed(0)}s → ${timestamps[timestamps.length - 1].toFixed(0)}s`);
      }
    }

    // Post-processing: fix comment-divider and first comment when Whisper drops headers
    // Whisper sometimes drops "Comments section:" and the first comment's header entirely,
    // causing the LLM to assign the same timestamp to both (usually too late).
    const commentDividerIdx = allElements.findIndex(el => el.type === 'comment-divider');
    if (commentDividerIdx >= 0) {
      const firstCommentIdx = allElements.findIndex((el, i) => i > commentDividerIdx && el.type === 'comment');
      if (firstCommentIdx >= 0) {
        const lastContentIdx = commentDividerIdx - 1;
        const lastContentTime = lastContentIdx >= 0 ? timestamps[lastContentIdx] : 0;
        const firstCommentTime = timestamps[firstCommentIdx];

        // If comment-divider and first comment have the same timestamp, or if the first comment
        // is much later than the last content (>10s gap suggesting Whisper dropped the header),
        // try to find the comment body text in the raw transcript
        if (timestamps[commentDividerIdx] >= firstCommentTime) {
          // Comment-divider should always be before first comment
          // Set it to just after the last content element
          const betterDividerTime = Math.round((lastContentTime + 1) * 10) / 10;
          console.log(`[LLM-Align] Post-fix: comment-divider ${timestamps[commentDividerIdx]}s → ${betterDividerTime}s (placed after last content at ${lastContentTime}s)`);
          timestamps[commentDividerIdx] = betterDividerTime;
        }

        // If first comment's timestamp is much later than last content (>15s gap),
        // search for the first comment's body text in the raw transcript
        if (firstCommentTime - lastContentTime > 15) {
          const firstComment = allElements[firstCommentIdx];
          // Get first few words of the comment body (after the header "Username on Date with N upvotes:")
          const colonIdx = firstComment.text.indexOf(':');
          const bodyStart = colonIdx >= 0 ? firstComment.text.slice(colonIdx + 1).trim() : firstComment.text;
          const firstWords = bodyStart.split(/\s+/).slice(0, 5).join(' ').toLowerCase().replace(/[^\w\s]/g, '');

          if (firstWords.length > 8) {
            // Search raw transcript words for a match
            for (let wi = 0; wi < transcriptWords.length - 4; wi++) {
              const windowText = transcriptWords.slice(wi, wi + 5)
                .map(w => (w.word || '').trim().toLowerCase().replace(/[^\w\s]/g, ''))
                .join(' ');
              if (windowText.includes(firstWords.slice(0, 15))) {
                const betterTime = transcriptWords[wi].start;
                // Only use if it's between last content and current assignment
                if (betterTime > lastContentTime && betterTime < firstCommentTime) {
                  console.log(`[LLM-Align] Post-fix: first comment "${allElements[firstCommentIdx].commentMeta?.username}" ${firstCommentTime}s → ${betterTime}s (matched body text "${firstWords.slice(0, 30)}")`);
                  timestamps[firstCommentIdx] = betterTime;
                  break;
                }
              }
            }
          }
        }

        // Extended post-processing: fix ALL comments where headers were dropped.
        // When Whisper drops a comment header, the LLM assigns the same timestamp as
        // the previous element (it couldn't find the header in the transcript). We search
        // for the comment's body text in the raw Whisper words as a fallback.
        let bodyFixCount = 0;
        for (let ci = commentDividerIdx + 1; ci < allElements.length; ci++) {
          if (allElements[ci].type !== 'comment') continue;
          if (ci === firstCommentIdx) continue; // Already handled above

          // If this comment has the same timestamp as the previous element,
          // the LLM likely couldn't find its header — search for body text
          const prevTime = ci > 0 ? timestamps[ci - 1] : 0;
          if (timestamps[ci] <= prevTime) {
            const comment = allElements[ci];
            const colonIdx = comment.text.indexOf(':');
            const bodyStart = colonIdx >= 0 ? comment.text.slice(colonIdx + 1).trim() : comment.text;
            const firstWords = bodyStart.split(/\s+/).slice(0, 6).join(' ').toLowerCase().replace(/[^\w\s]/g, '');

            if (firstWords.length > 8) {
              // Search raw transcript words starting AFTER the previous timestamp
              for (let wi = 0; wi < transcriptWords.length - 5; wi++) {
                if (transcriptWords[wi].start <= prevTime) continue;
                const windowText = transcriptWords.slice(wi, wi + 6)
                  .map(w => (w.word || '').trim().toLowerCase().replace(/[^\w\s]/g, ''))
                  .join(' ');
                if (windowText.includes(firstWords.slice(0, 20))) {
                  const betterTime = transcriptWords[wi].start;
                  timestamps[ci] = betterTime;
                  bodyFixCount++;
                  break;
                }
              }
            }
          }
        }
        if (bodyFixCount > 0) {
          console.log(`[LLM-Align] Post-fix: fixed ${bodyFixCount} additional comments via body text search`);
        }

        // Re-enforce non-decreasing after all fixes
        for (let i = 1; i < timestamps.length; i++) {
          if (timestamps[i] < timestamps[i - 1]) {
            timestamps[i] = timestamps[i - 1];
          }
        }
      }
    }

  } catch (parseError) {
    usedFallback = true;
    console.error('[LLM-Align] Failed to parse LLM response, using FALLBACK even distribution:', parseError);
    console.error('[LLM-Align] Full LLM response was:', responseText);
    // Fallback: distribute timestamps evenly across the audio duration
    const totalDuration = transcriptWords.length > 0
      ? transcriptWords[transcriptWords.length - 1].end
      : 0;
    timestamps = allElements.map((_, i) => Math.round((i / Math.max(allElements.length, 1)) * totalDuration * 10) / 10);
  }

  // Helper: find transcript text near a timestamp for logging
  function findTranscriptNearTime(time: number, words: TranscriptWord[], windowSeconds: number = 10): string {
    const matches = words.filter(w => Math.abs(w.start - time) < windowSeconds);
    if (matches.length === 0) return '[no match found]';
    return matches.slice(0, 15).map(w => w.word).join(' ').trim() + '...';
  }

  // Log sample timestamps for debugging
  const sampleTimestamps = timestamps.length <= 10
    ? timestamps
    : [...timestamps.slice(0, 5), '...', ...timestamps.slice(-3)];
  console.log(`[LLM-Align] ${usedFallback ? 'FALLBACK' : 'LLM'} timestamps (sample): [${sampleTimestamps.join(', ')}]`);
  console.log(`[LLM-Align] Timestamp range: ${timestamps[0]}s to ${timestamps[timestamps.length - 1]}s`);

  // Log element-to-timestamp mapping for first few elements
  for (let i = 0; i < Math.min(allElements.length, 8); i++) {
    const el = allElements[i];
    const typeLabel = el.type === 'comment' ? `comment by ${el.commentMeta?.username}` : el.type;
    console.log(`[LLM-Align]   [${i}] ${typeLabel} → ${timestamps[i]}s: "${el.text.slice(0, 60)}..."`);
  }
  if (allElements.length > 8) {
    console.log(`[LLM-Align]   ... (${allElements.length - 8} more elements)`);
  }

  // Log example matches to verify LLM is actually matching text
  console.log(`[LLM-Align] Example matches (element text → transcript at timestamp):`);
  const exampleIndices = [0, 1, allElements.length - 1].filter(i => i < allElements.length && i >= 0);
  for (const i of exampleIndices) {
    const el = allElements[i];
    const typeLabel = el.type === 'comment' ? `comment by ${el.commentMeta?.username}` : el.type;
    const elementText = el.text.slice(0, 80).replace(/\n/g, ' ');
    const transcriptText = findTranscriptNearTime(timestamps[i], transcriptWords);
    console.log(`[LLM-Align]   [${i}] ${typeLabel} @ ${timestamps[i]}s:`);
    console.log(`[LLM-Align]     Element: "${elementText}"`);
    console.log(`[LLM-Align]     Transcript: "${transcriptText}"`);
  }

  // Build result elements (strip the `text` field - only needed for LLM prompt)
  const resultElements: LLMAlignmentElement[] = allElements.map((el, i) => ({
    type: el.type,
    html: el.html,
    startTime: timestamps[i],
    ...(el.commentMeta ? { commentMeta: el.commentMeta } : {}),
  }));

  // Find comments start time
  let commentsStartTime: number | null = null;
  const commentDividerIndex = resultElements.findIndex(el => el.type === 'comment-divider');
  if (commentDividerIndex >= 0) {
    commentsStartTime = resultElements[commentDividerIndex].startTime;
  }

  const alignmentResult: LLMAlignmentResult = {
    version: 'llm-v1',
    elements: resultElements,
    commentsStartTime,
  };

  console.log(`[LLM-Align] Alignment complete: ${resultElements.length} elements timestamped`);
  if (commentsStartTime !== null) {
    console.log(`[LLM-Align] Comments start at ${commentsStartTime.toFixed(1)}s`);
  }

  return alignmentResult;
}
