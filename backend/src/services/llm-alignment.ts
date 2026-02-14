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

  // Add metadata elements (these ARE spoken in the audio)
  if (title) {
    elements.push({
      type: 'title',
      html: `<h2>${escapeHtml(title)}</h2>`,
      text: `Title: ${title}.`,
    });
  }

  // Author + date on one line (matches content tab's "By Author" display)
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
 * Flatten nested comments into a linear list with depth tracking
 */
function extractCommentElements(comments: any[], depth: number = 0): ContentElement[] {
  const elements: ContentElement[] = [];

  for (const comment of comments) {
    const username = ((comment.username || 'Anonymous') as string).trim();
    const commentHtml = comment.content || '';
    const plainText = commentHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

    // Build text for LLM matching
    let llmText = `${username}`;
    if (comment.karma !== undefined && comment.karma !== null) llmText += ` (${comment.karma} karma)`;
    llmText += `: ${plainText}`;

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
      elements.push(...extractCommentElements(comment.replies, depth + 1));
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

  if (content.comments) {
    try {
      const comments = typeof content.comments === 'string'
        ? JSON.parse(content.comments)
        : content.comments;

      if (comments && Array.isArray(comments) && comments.length > 0) {
        commentElements = extractCommentElements(comments);
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
      text: 'Comments section',
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

  // Build the elements list for the prompt (truncate long texts)
  const elementsList = allElements.map((el, i) => {
    const typeLabel = el.type === 'comment'
      ? `comment by ${el.commentMeta?.username || 'Unknown'}`
      : el.type;
    // Truncate text to keep prompt manageable
    const displayText = el.text.length > 200 ? el.text.slice(0, 200) + '...' : el.text;
    return `[${i}] (${typeLabel}) ${displayText}`;
  }).join('\n');

  console.log(`[LLM-Align] Total audio duration: ${totalAudioDuration}s`);

  const systemPrompt = `You are given ${allElements.length} CONTENT ELEMENTS and a TIMESTAMPED TRANSCRIPT of their audio narration. Your job: for each content element, find where it starts in the transcript and return its timestamp.

BACKGROUND:
- The article was converted to speech via TTS. A scriptwriter reformatted the text before speaking.
- Lists get numbering ("First, ...", "Second, ..."). Comments get headers like "A comment by Username on Date with N upvotes".
- Some words may be slightly rephrased. Match by meaning/keywords, not exact wording.

TRANSCRIPT FORMAT:
Each line is one sentence from the audio with its start time in seconds:
[0.0] Title, Do Your Job Unreasonably Well, written by Max Dalton.
[4.6] Published on 27th of January, 2026, it has 102 karma.
[10.5] I've just started a blog about effective altruism.

YOUR TASK:
- There are exactly ${allElements.length} content elements numbered [0] through [${allElements.length - 1}].
- For each element, find the transcript line where that element's text BEGINS being spoken.
- Return EXACTLY ${allElements.length} timestamps — one per content element, NOT one per transcript line.
- The transcript has many more lines than there are elements. Multiple transcript lines may correspond to a single long element.

RULES:
- Timestamps in TOTAL SECONDS (90.5 for 1min 30sec, NOT 1.30)
- Non-decreasing (each timestamp >= the previous)
- Use exact decimal values from [timestamp] markers, do NOT round
- If an element isn't spoken (e.g., decorative image), reuse the previous element's time
- Images match "An image shows..." or "An image depicts..." in the transcript
- Do NOT distribute timestamps evenly — match actual text positions
- The last element should have a timestamp near the end of the ${totalAudioDuration}s audio

OUTPUT: A JSON array of exactly ${allElements.length} numbers. Nothing else.`;

  const userPrompt = `CONTENT ELEMENTS (${allElements.length} elements — return exactly ${allElements.length} timestamps):
${elementsList}

TIMESTAMPED TRANSCRIPT (reference only — do NOT return one timestamp per line):
${timedTranscript}

Return a JSON array of EXACTLY ${allElements.length} timestamps, one for each content element [0] through [${allElements.length - 1}]. Find where each element's text begins in the transcript and use that line's [timestamp].`;

  // Call LLM
  const chatConfig = await getChatClientForUser(userId);
  if (!chatConfig) {
    throw new Error('No LLM configured. Please set up a DeepInfra or OpenAI API key in Settings.');
  }

  console.log(`[LLM-Align] Calling ${chatConfig.model} with ${allElements.length} elements...`);

  const response = await chatConfig.client.chat.completions.create({
    model: chatConfig.model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    temperature: 0.2,
    max_completion_tokens: 4000,
  });

  const responseText = response.choices[0]?.message?.content || '';
  console.log(`[LLM-Align] LLM response length: ${responseText.length} chars`);
  console.log(`[LLM-Align] Raw LLM response (first 500 chars): ${responseText.slice(0, 500)}`);

  // Parse response - extract JSON array
  let timestamps: number[];
  let usedFallback = false;
  try {
    const jsonMatch = responseText.match(/\[[\s\S]*?\]/);
    if (!jsonMatch) {
      throw new Error('No JSON array found in LLM response');
    }
    timestamps = JSON.parse(jsonMatch[0]);

    if (!Array.isArray(timestamps)) {
      throw new Error('Parsed result is not an array');
    }

    console.log(`[LLM-Align] Parsed ${timestamps.length} timestamps from LLM`);

    // Ensure all values are numbers
    timestamps = timestamps.map(t => {
      const n = typeof t === 'number' ? t : parseFloat(String(t));
      return isNaN(n) ? 0 : n;
    });

    // Detect M.SS format: if max timestamp is much smaller than audio duration,
    // the LLM likely returned minutes.seconds (e.g., 1.30 = 1min 30sec = 90s)
    const maxTs = Math.max(...timestamps);
    if (totalAudioDuration > 60 && maxTs > 0 && maxTs < totalAudioDuration * 0.25) {
      // Re-parse from raw JSON, treating values as M.SS
      console.warn(`[LLM-Align] Detected M.SS format (max ${maxTs}s vs ${totalAudioDuration}s duration). Converting...`);
      const rawValues = JSON.parse(jsonMatch[0]) as (number | string)[];
      timestamps = rawValues.map(t => {
        const str = String(t);
        // Values like "1.30" mean 1 min 30 sec, but JSON parsed it to 1.3
        // We need the original string to recover the "30" part
        const dotIndex = str.indexOf('.');
        if (dotIndex === -1) return Number(str) * 60; // whole number = minutes
        const minPart = parseInt(str.slice(0, dotIndex), 10) || 0;
        const secStr = str.slice(dotIndex + 1);
        // Pad to 2 digits: "5" → "50"? No — "0.5" meant "0:05" (5 sec), not 50.
        // The LLM writes "0.5" for 5s, "0.05" for 5s, "0.50" for 50s, "1.30" for 1:30
        // Key insight: if secStr has 1 digit, it could be ambiguous (0.5 = 5s or 50s?)
        // But in M:SS, single digit after dot = that many seconds (0.5 = 0:05 = 5s)
        const secPart = parseInt(secStr, 10) || 0;
        return minPart * 60 + secPart;
      }).map(n => isNaN(n) ? 0 : n);
      console.log(`[LLM-Align] Converted timestamps range: ${timestamps[0]}s to ${timestamps[timestamps.length - 1]}s`);
    }

    // Handle count mismatch between LLM output and expected elements
    if (timestamps.length !== allElements.length) {
      console.warn(`[LLM-Align] Expected ${allElements.length} timestamps, got ${timestamps.length}.`);

      if (timestamps.length > allElements.length) {
        // Too many: RESAMPLE instead of truncating (truncation loses end of audio!)
        // Linearly maps N_src positions → N_dst positions, preserving first AND last
        const srcLen = timestamps.length;
        const dstLen = allElements.length;
        const resampled: number[] = [];
        for (let i = 0; i < dstLen; i++) {
          const srcIdx = Math.min(Math.round(i * (srcLen - 1) / (dstLen - 1)), srcLen - 1);
          resampled.push(timestamps[srcIdx]);
        }
        console.log(`[LLM-Align] Resampled ${srcLen} → ${dstLen} timestamps (range preserved: ${timestamps[0]}→${timestamps[srcLen - 1]})`);
        timestamps = resampled;
      } else {
        // Too few: pad with the last value
        console.log(`[LLM-Align] Padding ${timestamps.length} → ${allElements.length} with last value ${timestamps[timestamps.length - 1]}`);
        while (timestamps.length < allElements.length) {
          timestamps.push(timestamps[timestamps.length - 1] || 0);
        }
      }
    }

    // Ensure non-decreasing
    for (let i = 1; i < timestamps.length; i++) {
      if (timestamps[i] < timestamps[i - 1]) {
        timestamps[i] = timestamps[i - 1];
      }
    }

    // Check audio coverage — if LLM didn't match the end, stretch the tail
    const finalTs = timestamps[timestamps.length - 1];
    if (totalAudioDuration > 60 && finalTs > 0 && finalTs < totalAudioDuration * 0.85) {
      console.warn(`[LLM-Align] Timestamps only cover ${finalTs.toFixed(0)}s of ${totalAudioDuration}s audio (${(finalTs / totalAudioDuration * 100).toFixed(0)}%). Stretching tail...`);

      // Stretch the last ~30% of timestamps proportionally to reach ~95% of audio
      const stretchIdx = Math.floor(timestamps.length * 0.7);
      const anchorTime = timestamps[stretchIdx];
      const targetEnd = totalAudioDuration * 0.95;
      const currentRange = finalTs - anchorTime;

      if (currentRange > 0) {
        const targetRange = targetEnd - anchorTime;
        const scale = targetRange / currentRange;

        for (let i = stretchIdx + 1; i < timestamps.length; i++) {
          timestamps[i] = Math.round((anchorTime + (timestamps[i] - anchorTime) * scale) * 10) / 10;
        }

        // Re-enforce non-decreasing after stretching
        for (let i = 1; i < timestamps.length; i++) {
          if (timestamps[i] < timestamps[i - 1]) {
            timestamps[i] = timestamps[i - 1];
          }
        }

        console.log(`[LLM-Align] Stretched tail: ${finalTs.toFixed(0)}s → ${timestamps[timestamps.length - 1].toFixed(0)}s (${scale.toFixed(2)}x from anchor ${anchorTime.toFixed(0)}s)`);
      }
    }

    // Final coverage warning
    const postFinalTs = timestamps[timestamps.length - 1];
    if (totalAudioDuration > 60 && postFinalTs < totalAudioDuration * 0.7) {
      console.warn(`[LLM-Align] WARNING: Even after adjustments, timestamps only cover ${postFinalTs.toFixed(0)}s of ${totalAudioDuration}s audio (${(postFinalTs / totalAudioDuration * 100).toFixed(0)}%).`);
    }

    // Detect lazy even distribution
    if (timestamps.length >= 5) {
      const diffs = timestamps.slice(1).map((t, i) => Math.round((t - timestamps[i]) * 10) / 10);
      const nonZeroDiffs = diffs.filter(d => d > 0);
      if (nonZeroDiffs.length > 0) {
        const uniqueDiffs = new Set(nonZeroDiffs);
        if (uniqueDiffs.size <= 2) {
          console.warn(`[LLM-Align] WARNING: Timestamps appear evenly distributed (intervals: ${[...uniqueDiffs].join(', ')}s). LLM may not have done real text matching.`);
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
