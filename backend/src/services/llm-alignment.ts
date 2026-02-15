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
import { getChatClientForUser } from './ai-providers.js';
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
 * Groups words into sentences (splitting at . ? !) with one timestamp per line.
 * Long sentences (>40 words) are split at commas/semicolons.
 *
 * Output:
 * [0.0] Title, Do Your Job Unreasonably Well, written by Max Dalton.
 * [4.6] Published on 27th of January, 2026, it has 102 karma.
 * [10.5] I've just started a blog about effective altruism organization-style management.
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

    // Sentence boundary: word ends with . ? ! (optionally followed by " ' ) ])
    const isSentenceEnd = /[.!?]["')\]]?$/.test(trimmed);

    // Break very long runs (>40 words) at commas or semicolons
    const isLongBreak = currentWords.length > 40 && /[,;:]$/.test(trimmed);

    if (isSentenceEnd || isLongBreak) {
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

  // Extract content elements from HTML
  const contentElements = extractContentElements(
    content.html_content || '',
    content.title,
    content.author,
    content.published_at,
    content.karma,
    content.url,
    content.image_alt_text_data
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
  const allElements: ContentElement[] = [...contentElements];

  if (commentElements.length > 0) {
    allElements.push({
      type: 'comment-divider',
      html: '',
      text: 'Comments section:',
    });
    allElements.push(...commentElements);
  }

  console.log(`[LLM-Align] ${contentElements.length} content elements, ${commentElements.length} comment elements`);

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

  // Diagnostic: search transcript for "comment" to verify it's present
  const transcriptLines = timedTranscript.split('\n');
  const commentLines = transcriptLines.filter(line => /comment/i.test(line));
  if (commentLines.length > 0) {
    console.log(`[LLM-Align] DIAGNOSTIC: Transcript lines containing "comment":`);
    commentLines.forEach(line => console.log(`[LLM-Align]   ${line}`));
  } else {
    console.log(`[LLM-Align] DIAGNOSTIC: No transcript lines contain the word "comment"!`);
  }
  // Also log the last 5 transcript lines (where comments section should transition)
  console.log(`[LLM-Align] DIAGNOSTIC: Last 5 transcript lines:`);
  transcriptLines.slice(-5).forEach(line => console.log(`[LLM-Align]   ${line}`));
  // Log the elements list being sent to the LLM
  console.log(`[LLM-Align] DIAGNOSTIC: Elements list being sent to LLM:\n${elementsList}`);

  // Single prompt — LLM reasons through matches, marks answers with >>>
  const prompt = `I have an article that was read aloud. Below is the timestamped transcript of the audio, followed by the article's content elements.

For each element, find the transcript line where it starts being spoken. Briefly explain your reasoning, then write the answer on a line starting with >>> like this:

Element 0 is the title — I see "Title, Do Your Job" at [0.0].
>>> 0: 0.0

Only >>> lines are parsed. Everything else is for your reasoning.

The scriptwriter may have slightly rephrased text, added numbering to lists ("First, ...", "Second, ..."), or changed wording. Match by meaning, not exact wording.

TRANSCRIPT (${totalAudioDuration}s audio):
${timedTranscript}

ELEMENTS TO MATCH (${allElements.length} total):
${elementsList}

Go through each element 0 to ${allElements.length - 1}. Use exact [timestamp] values from the transcript. Each timestamp must be >= the previous one. If an element isn't spoken, reuse the previous timestamp.`;

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
    temperature: 0.1,
    max_completion_tokens: 8000,
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
