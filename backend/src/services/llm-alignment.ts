/**
 * LLM-based Content Alignment Service (v2)
 *
 * Replaces the Needleman-Wunsch algorithm approach with an LLM that maps
 * original HTML content elements to their audio timestamps.
 *
 * How it works:
 * 1. Extract block-level elements from HTML (paragraphs, headings, images, etc.)
 * 2. Extract comments as individual elements with metadata
 * 3. Build a transcript with inline per-word timestamps from Whisper
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
 * Build transcript with inline per-word timestamp markers.
 * Instead of grouping into time buckets (which limits LLM to bucket-boundary precision),
 * this embeds actual Whisper timestamps every N words, giving sub-second precision.
 *
 * Output: "[0.0] Title, Do Your Job [1.5] Unreasonably Well, written [2.8] by Max Dalton..."
 */
function buildTimedTranscript(words: TranscriptWord[], wordsPerMarker: number = 5): string {
  if (words.length === 0) return '';

  const parts: string[] = [];

  for (let i = 0; i < words.length; i++) {
    if (i % wordsPerMarker === 0) {
      parts.push(`[${words[i].start.toFixed(1)}]`);
    }
    parts.push((words[i].word || '').trim());
  }

  return parts.join(' ');
}

/**
 * Post-process LLM timestamps using algorithmic text matching to catch gross errors.
 * For each element, searches the transcript for the element's distinctive words.
 * If the best match is significantly different from the LLM's timestamp, uses the
 * algorithmic match instead. This catches cases where the LLM skipped elements,
 * matched to the wrong section, or got off-by-one on comments.
 *
 * NOT the same as global Needleman-Wunsch alignment — this only finds ~N anchor
 * points with a simple sliding window, and only overrides when the LLM is clearly wrong.
 */
function verifyAndFixTimestamps(
  timestamps: number[],
  elements: ContentElement[],
  transcriptWords: TranscriptWord[]
): number[] {
  const fixed = [...timestamps];
  const STOP_WORDS = new Set([
    'the', 'a', 'an', 'is', 'are', 'was', 'were', 'of', 'in', 'to',
    'and', 'for', 'on', 'at', 'by', 'it', 'i', 'that', 'this', 'with',
    'be', 'has', 'have', 'had', 'do', 'does', 'did', 'will', 'would',
    'can', 'could', 'should', 'may', 'might', 'not', 'no', 'but', 'or',
    'if', 'so', 'as', 'its', 'my', 'your', 'their', 'our', 'his', 'her',
  ]);

  // Pre-normalize transcript words
  const normalizedTranscript = transcriptWords.map(w =>
    w.word.toLowerCase().replace(/[^\w]/g, '').trim()
  );

  let corrections = 0;

  for (let elIdx = 0; elIdx < elements.length; elIdx++) {
    const el = elements[elIdx];

    // Skip non-text elements
    if (el.type === 'comment-divider' || el.type === 'image') continue;

    // Extract distinctive words from element text
    const elementWords = el.text.toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 2 && !STOP_WORDS.has(w))
      .slice(0, 8);

    if (elementWords.length < 2) continue;

    // Search forward from a bit before the previous element's position
    // (the -5s buffer handles cases where an earlier correction shifted things)
    const searchStartTime = elIdx > 0 ? Math.max(0, fixed[elIdx - 1] - 5) : 0;
    const searchStartIdx = transcriptWords.findIndex(w => w.start >= searchStartTime);
    const startIdx = Math.max(0, searchStartIdx);

    let bestScore = 0;
    let bestIdx = -1;
    const windowSize = 25;

    for (let i = startIdx; i < normalizedTranscript.length - 1; i++) {
      const endJ = Math.min(i + windowSize, normalizedTranscript.length);
      const window = normalizedTranscript.slice(i, endJ);
      let score = 0;
      for (const ew of elementWords) {
        if (window.some(tw => tw === ew || (tw.length > 4 && ew.length > 4 && tw.startsWith(ew.slice(0, 4))))) {
          score++;
        }
      }
      if (score > bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    }

    if (bestIdx < 0) continue;

    const matchRatio = bestScore / elementWords.length;
    const algorithmicTs = transcriptWords[bestIdx].start;
    const diff = Math.abs(algorithmicTs - fixed[elIdx]);

    // High confidence match (>60% words): correct if >5s off
    // Medium confidence match (>40% words): correct if >15s off
    const shouldCorrect = (matchRatio >= 0.6 && diff > 5) || (matchRatio >= 0.4 && diff > 15);

    if (shouldCorrect) {
      console.log(`[LLM-Align] CORRECTED [${elIdx}] (${el.type}): ${fixed[elIdx].toFixed(1)}s → ${algorithmicTs.toFixed(1)}s (${bestScore}/${elementWords.length} words, diff=${diff.toFixed(1)}s)`);
      fixed[elIdx] = algorithmicTs;
      corrections++;
    }
  }

  if (corrections > 0) {
    console.log(`[LLM-Align] Applied ${corrections} algorithmic corrections to LLM timestamps`);
  } else {
    console.log(`[LLM-Align] All LLM timestamps verified — no corrections needed`);
  }

  // Re-enforce non-decreasing after corrections
  for (let i = 1; i < fixed.length; i++) {
    if (fixed[i] < fixed[i - 1]) {
      fixed[i] = fixed[i - 1];
    }
  }

  return fixed;
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

  const systemPrompt = `You match article content to its audio narration by finding where each piece of text is spoken.

The article was converted to speech via TTS. The audio reads: title, author/date, article body, then optionally a comments section.

TRANSCRIPT FORMAT:
The transcript has inline timestamp markers like [14.2] every few words, showing the exact time in seconds at that point. Use these markers to pinpoint precise timestamps.

YOUR METHOD:
1. For each content element, find its first distinctive words in the transcript
2. Note the nearest [timestamp] marker at or before that location
3. Return that timestamp value

Example: If element text is "I've just started a blog" and you find in the transcript "[14.2] I've just started a [16.8] blog about", return 14.2.

CRITICAL: You MUST actually search for text matches. Do NOT distribute timestamps evenly — different paragraphs have very different lengths in the audio. Short paragraphs might be 2 seconds apart, long ones might be 60+ seconds apart.

BAD output (evenly spaced, round numbers): [0, 15, 30, 45, 60, 75, 90]
GOOD output (from actual [timestamp] markers): [0.0, 3.2, 7.1, 14.2, 52.8, 58.1, 103.4]

The total audio is ${totalAudioDuration} seconds. The last element should have a timestamp near ${totalAudioDuration}.

RULES:
- Timestamps are in TOTAL SECONDS (e.g., 90.5 for ~1min 30sec, NOT 1.30)
- Times must be non-decreasing
- Use the decimal values from the [timestamp] markers — do NOT round to whole numbers
- If an element isn't spoken (e.g., decorative image), use the same time as the previous element
- Images correspond to "An image shows..." or "An image depicts..." in the audio
- The array must have exactly ${allElements.length} numbers`;

  const userPrompt = `CONTENT ELEMENTS (${allElements.length} total):
${elementsList}

TIMESTAMPED TRANSCRIPT (total duration: ${totalAudioDuration}s):
${timedTranscript}

For each element, find where its text appears in the transcript using the [timestamp] markers. Return ONLY a JSON array of ${allElements.length} timestamps in seconds, using the decimal values from the markers.`;

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
    temperature: 0.1,
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

    // Pad or trim to match element count
    if (timestamps.length !== allElements.length) {
      console.warn(`[LLM-Align] Expected ${allElements.length} timestamps, got ${timestamps.length}. Adjusting...`);
      while (timestamps.length < allElements.length) {
        timestamps.push(timestamps[timestamps.length - 1] || 0);
      }
      timestamps = timestamps.slice(0, allElements.length);
    }

    // Ensure non-decreasing
    for (let i = 1; i < timestamps.length; i++) {
      if (timestamps[i] < timestamps[i - 1]) {
        timestamps[i] = timestamps[i - 1];
      }
    }

    // Algorithmic post-processing: verify timestamps by searching for element text
    // in the transcript. Corrects gross LLM errors (>5-15s off) while keeping
    // good LLM matches intact.
    timestamps = verifyAndFixTimestamps(timestamps, allElements, transcriptWords);

    // Validate: check if timestamps actually cover the full audio
    const finalTs = timestamps[timestamps.length - 1];
    if (totalAudioDuration > 60 && finalTs < totalAudioDuration * 0.7) {
      console.warn(`[LLM-Align] WARNING: Timestamps only cover ${finalTs.toFixed(0)}s of ${totalAudioDuration}s audio (${(finalTs / totalAudioDuration * 100).toFixed(0)}%). LLM may not have matched the full transcript.`);
    }

    // Validate: detect lazy even distribution (all same interval)
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
