import fs from 'fs/promises';
import path from 'path';
import ffmpeg from 'fluent-ffmpeg';
// RESTORED: JSDOM for robust HTML cleaning (fixes empty comments)
import { JSDOM } from 'jsdom';
import { query } from '../database/db.js';
import { getTempDir } from '../config/storage.js';
import { getAudioDuration } from './audio-utils.js';
import { PROCESSING_CONFIG } from '../config/processing.js';
import { getTTSClientForUser, getTTSOptionsForUser, getChatClientForUser, getUserSetting } from './ai-providers.js';
import { transcribeWithTimestamps } from './transcription.js';
import { ImageAltTextService } from './image-alt-text.js';
import { generateLLMAlignment } from './llm-alignment.js';

interface Comment {
  id?: string;
  username: string;
  date?: string;
  karma?: number;
  extendedScore?: Record<string, number>;
  content: string;
  replies?: Comment[];
}

interface ChunkMetadata {
  text: string;
  startWord: number;
  endWord: number;
  duration: number;
  startTime: number;
}

// --- HELPER FUNCTIONS ---

function splitTextIntoChunks(text: string, maxLength: number): string[] {
  if (text.length <= maxLength) return [text];

  const chunks: string[] = [];
  let currentPos = 0;

  while (currentPos < text.length) {
    let chunkEnd = currentPos + maxLength;

    if (chunkEnd >= text.length) {
      chunks.push(text.slice(currentPos));
      break;
    }

    const chunk = text.slice(currentPos, chunkEnd);
    const lastSentenceEnd = Math.max(
      chunk.lastIndexOf('. '),
      chunk.lastIndexOf('! '),
      chunk.lastIndexOf('? ')
    );

    if (lastSentenceEnd > maxLength * 0.6) {
      chunkEnd = currentPos + lastSentenceEnd + 1;
    } else {
      const lastSpace = chunk.lastIndexOf(' ');
      if (lastSpace > maxLength * 0.8) {
        chunkEnd = currentPos + lastSpace;
      }
    }

    chunks.push(text.slice(currentPos, chunkEnd).trim());
    currentPos = chunkEnd;
  }

  return chunks;
}

// FIXED: Seamless concatenation using complexFilter to physically remove MP3 padding
async function concatenateAudioFiles(inputFiles: string[], outputFile: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (inputFiles.length === 0) {
      reject(new Error('No input files provided for concatenation'));
      return;
    }

    const command = ffmpeg();
    inputFiles.forEach(f => command.input(f));

    // Create a filter chain: [0:a][1:a]...concat=n=X:v=0:a=1[out]
    // This decodes the MP3s and joins the raw audio samples perfectly
    const filterInput = inputFiles.map((_, i) => `[${i}:a]`).join('');

    command
      .complexFilter(`${filterInput}concat=n=${inputFiles.length}:v=0:a=1[out]`)
      .map('[out]')
      .audioFrequency(24000)
      .audioBitrate('96k')
      .format('mp3')
      .on('end', () => resolve())
      .on('error', (err) => {
        console.error('[FFmpeg] Error during seamless concatenation:', err);
        reject(err);
      })
      .save(outputFile);
  });
}

/**
 * Count all comments including nested replies.
 */
function countAllComments(comments: any[]): number {
  let count = 0;
  for (const c of comments) {
    count += 1;
    if (c.replies && Array.isArray(c.replies) && c.replies.length > 0) {
      count += countAllComments(c.replies);
    }
  }
  return count;
}

function formatDateForNarration(dateString: string): string {
  try {
    const date = new Date(dateString);
    const day = date.getDate();
    const month = date.toLocaleDateString('en-US', { month: 'long' });
    const year = date.getFullYear();

    const suffix = ['th', 'st', 'nd', 'rd'];
    const v = day % 100;
    const ordinalDay = day + (suffix[(v - 20) % 10] || suffix[v] || suffix[0]);

    return `${ordinalDay} of ${month} ${year}`;
  } catch (e) {
    return dateString;
  }
}

function formatReactionsForNarration(karma?: number, extendedScore?: Record<string, number>, isLessWrong: boolean = false): string {
  const parts: string[] = [];

  // Always show karma as "upvotes"
  if (karma !== undefined && karma !== null) {
    parts.push(`${karma} ${karma === 1 ? 'upvote' : 'upvotes'}`);
  }

  // Handle extended scores (reactions) - same logic as FullscreenPlayer.tsx
  if (extendedScore) {
    if (isLessWrong) {
      // LessWrong: Only show 'agreement' score (ignore internal fields like approvalVoteCount)
      if (typeof extendedScore.agreement === 'number') {
        parts.push(`${extendedScore.agreement} agreement`);
      }
    } else {
      // EA Forum (and others): Show ALL reactions
      for (const [reaction, count] of Object.entries(extendedScore)) {
        if (count > 0 && reaction !== 'baseScore') {
          parts.push(`${count} ${reaction}`);
        }
      }
    }
  }
  return parts.join(', ');
}

// RESTORED: JSDOM-based cleaning from openai-tts-1.ts
// This fixes the "Empty Comments" issue caused by the weak Regex
function htmlToNarrationText(html: string): string {
  try {
    const dom = new JSDOM(html);
    const doc = dom.window.document;

    // Remove scripts, styles, and other non-content elements
    const unwanted = doc.querySelectorAll('script, style, noscript, iframe');
    unwanted.forEach(el => el.remove());

    // Handle links: Replace with anchor text + domain name
    // If the anchor text itself IS a URL (common in LessWrong/EA Forum comments),
    // replace it with just the domain name to avoid Kokoro reading full URLs
    const links = doc.querySelectorAll('a[href]');
    links.forEach(link => {
      const anchorText = link.textContent?.trim() || '';
      const href = link.getAttribute('href') || '';

      // Extract domain name from href
      let domain = '';
      try {
        const url = new URL(href, 'https://example.com');
        const hostname = url.hostname;
        domain = hostname.replace(/^www\./, '');
      } catch (e) {
        domain = '';
      }

      // Check if anchor text itself looks like a URL
      const anchorIsUrl = /^https?:\/\//i.test(anchorText) || /^www\./i.test(anchorText);

      let replacement: string;
      if (anchorIsUrl) {
        // Anchor text IS a URL — just say "link to domain.com"
        replacement = `link to ${domain || 'a website'}`;
      } else if (anchorText && domain && domain !== 'example.com') {
        replacement = `${anchorText}, link to ${domain}`;
      } else if (anchorText) {
        replacement = anchorText;
      } else {
        replacement = domain ? `link to ${domain}` : 'a link is shown here';
      }

      const textNode = doc.createTextNode(replacement);
      link.replaceWith(textNode);
    });

    // Mark LLM content blocks (LessWrong/EA Forum AI-generated sections)
    // with spoken attribution before text extraction
    const llmBlocks = doc.querySelectorAll('div.llm-content-block');
    llmBlocks.forEach(block => {
      const modelName = block.getAttribute('data-model-name') || 'AI';
      const llmStart = doc.createTextNode(` <<<LLMBLOCK:${modelName}>>> `);
      const llmEnd = doc.createTextNode(' <<<ENDLLMBLOCK>>> ');
      block.insertBefore(llmStart, block.firstChild);
      block.appendChild(llmEnd);
    });

    // Mark quote blocks with special delimiters before text extraction
    // This preserves quote structure in the narration
    const blockquotes = doc.querySelectorAll('blockquote');
    blockquotes.forEach(blockquote => {
      // Create text nodes for "Quote" and "End quote" markers
      const quoteStart = doc.createTextNode(' <<<QUOTE>>> ');
      const quoteEnd = doc.createTextNode(' <<<ENDQUOTE>>> ');

      // Insert markers before and after the blockquote content
      blockquote.insertBefore(quoteStart, blockquote.firstChild);
      blockquote.appendChild(quoteEnd);
    });

    // Get text content (handles entities like &quot; correctly)
    let text = doc.body.textContent || '';

    // Replace LLM block markers with spoken attribution
    text = text.replace(/<<<LLMBLOCK:(.*?)>>>/g, (_match, modelName) => `The following was written by ${modelName}:`);
    text = text.replace(/<<<ENDLLMBLOCK>>>/g, 'End of AI-generated section.');

    // Replace quote markers with spoken announcements
    text = text.replace(/<<<QUOTE>>>/g, 'Start of a quote:');
    text = text.replace(/<<<ENDQUOTE>>>/g, 'End of the quote.');

    // Remove emojis (for narration only - they don't render well in TTS)
    text = text.replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu, '');

    // Replace bare URLs in text (not caught by <a> tag handling above)
    // with just "link to domain.com"
    text = text.replace(/https?:\/\/[^\s)>\]]+/gi, (url) => {
      try {
        const parsed = new URL(url);
        const domain = parsed.hostname.replace(/^www\./, '');
        return `link to ${domain}`;
      } catch {
        return 'a link';
      }
    });

    // Clean up whitespace (including any gaps left by emoji removal)
    text = text.replace(/\s+/g, ' ').trim();
    return text;
  } catch (e) {
    console.error('JSDOM parsing failed, falling back to regex:', e);
    let fallbackText = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    // Also remove emojis in fallback
    fallbackText = fallbackText.replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu, '');
    return fallbackText;
  }
}

/**
 * Replace images with narration text BEFORE scriptwriting
 * Uses contentUrl to resolve relative paths and fuzzy matching for robustness
 */
function injectImageNarrations(html: string, imageDescriptions: { [url: string]: string }, contentUrl?: string): string {
  try {
    const dom = new JSDOM(html);
    const doc = dom.window.document;
    const images = Array.from(doc.querySelectorAll('img'));
    
    console.log(`[TTS] Injecting narrations for ${images.length} images`);
    
    images.forEach((img, index) => {
      const src = img.getAttribute('src');
      if (!src) return;
      
      let description = null;
      let absoluteSrc = src;

      // 1. Try to resolve relative URLs using the article's base URL
      if (contentUrl && !src.match(/^https?:\/\//i) && !src.startsWith('data:')) {
        try {
          absoluteSrc = new URL(src, contentUrl).href;
        } catch (e) { /* ignore invalid urls */ }
      }

      // 2. Strategy A: Exact Match (Best for preventing duplicates)
      // Check both the raw source and the resolved absolute source
      if (imageDescriptions[src]) description = imageDescriptions[src];
      if (!description && imageDescriptions[absoluteSrc]) description = imageDescriptions[absoluteSrc];

      // 3. Strategy B: Fuzzy Match (Ignore Query Params) 
      // Only runs if exact match failed. Helps match "img.jpg?w=500" to "img.jpg"
      if (!description) {
        const cleanSrc = src.split('?')[0];
        const cleanAbs = absoluteSrc.split('?')[0];
        
        for (const [storedUrl, desc] of Object.entries(imageDescriptions)) {
           const cleanStored = storedUrl.split('?')[0];
           // Only match if the clean paths are identical
           if (cleanStored === cleanSrc || cleanStored === cleanAbs) {
             description = desc;
             break;
           }
        }
      }

      // 4. Fallback: Use existing Alt Text if Gemini failed
      if (!description) {
         const alt = img.getAttribute('alt');
         if (alt && alt.trim().length > 3) { 
            description = alt;
         }
      }

      // 5. Construct Narration or Remove
      // IMPORTANT: Use a <p> element, NOT a bare text node.
      // A text node floating between HTML elements gets dropped by the
      // scriptwriter LLM (it treats floating text as "junk" to remove).
      // A <p> element is treated as real article content and preserved.
      let replacementNode;
      if (description) {
          replacementNode = doc.createElement('p');
          replacementNode.textContent = `An image is displayed showing ${description}. End of the image description.`;
      } else {
          // If no description and no alt text, remove the image entirely
          // to prevent "An image is shown here" spam for decorative icons.
          replacementNode = doc.createTextNode(' ');
      }
      
      img.replaceWith(replacementNode);
    });
    
    return doc.body.innerHTML;
  } catch (e) {
    console.error('[TTS] Failed to inject image narrations:', e);
    return html;
  }
}

function formatCommentsForNarration(comments: Comment[], isReply: boolean = false, replyTo?: string, isLessWrong: boolean = false): string {
  let narration = '';

  for (const comment of comments) {
    const reactions = formatReactionsForNarration(comment.karma, comment.extendedScore, isLessWrong);
    const date = comment.date ? formatDateForNarration(comment.date) : '';

    let commentIntro = '';
    // Fix: Handle potential missing username (though Fetcher usually handles this)
    // Strip emojis from username for narration (e.g. EA Forum authors with 🔸)
    const username = (comment.username || 'Anonymous').replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu, '').trim();

    if (isReply && replyTo) {
      commentIntro = `A reply to ${replyTo} by ${username}`;
    } else {
      commentIntro = `${username}`;
    }

    if (date) {
      commentIntro += ` on ${date}`;
    }

    if (reactions) {
      commentIntro += ` with ${reactions}`;
    }

    // Convert HTML content to plain text using JSDOM
    const commentText = htmlToNarrationText(comment.content);

    // Only add if there is actual text to read
    if (commentText) {
      narration += `${commentIntro}: "${commentText}"\n\n`;
    }

    if (comment.replies && comment.replies.length > 0) {
      narration += formatCommentsForNarration(comment.replies, true, username, isLessWrong);
    }
  }

  return narration;
}

async function scriptArticleForListening(htmlContent: string, openai: any, modelId: string = 'gpt-5-nano'): Promise<string> {
  try {
    // ADDED: Pre-clean HTML to remove massive technical bloat (scripts, styles, SVGs)
    // This reduces token count significantly before sending to LLM
    const dom = new JSDOM(htmlContent);
    const doc = dom.window.document;

    const junkSelectors = 'script, style, noscript, iframe, svg, path, input[type="hidden"], meta, link';
    doc.querySelectorAll(junkSelectors).forEach(el => el.remove());

    // Use the cleaner HTML which retains structure but drops junk
    const cleanHtml = doc.body.innerHTML || htmlContent;

    // Diagnostic Logging (count images in INPUT)
    console.log('[TTS] ===== IMAGE NARRATION PIPELINE START =====');
    const inputImageCount = (cleanHtml.match(/An image is displayed showing.*?\./gs) || []).length;
    console.log(`[TTS] Input HTML contains ${inputImageCount} image narration(s)`);

    if (inputImageCount > 0) {
      // Log sample image narration from input
      const sampleImage = cleanHtml.match(/An image is displayed showing.*?End of the image description\./s);
      if (sampleImage) {
        console.log(`[TTS] Sample input image narration: "${sampleImage[0].substring(0, 150)}..."`);
      }
    }
    
    console.log(`[TTS] Scriptwriting with model: ${modelId}`);
        const systemPrompt = `You are a scriptwriter for an audio narration service.

 Your goal is to rewrite the provided HTML article into a plain text script optimized for Text-to-Speech (TTS).

 CRITICAL INSTRUCTION: You must preserve the author's original words exactly as they are written, VERBATIM.
 DO NOT summarize.
 DO NOT rewrite sentences.
 DO NOT simplify the language.

 🚨 IMAGE DESCRIPTIONS:
 DO NOT CHANGE OR REMOVE image descriptions. Always preserve text following the pattern: "An image is displayed showing [description]. End of the image description."*
 1. ALWAYS keep text that starts with "An image is displayed"
 2. ALWAYS keep text that ends with "End of the image description."*
 3. These image descriptions are REQUIRED accessibility content
 4. If you see image descriptions, they MUST appear in your output VERBATIM
 5. Image descriptions are NOT extraneous - they are essential
 6. PRESERVE THE EXACT WORDING - do not paraphrase or summarize them
 *EXCEPTION: If the image description is announced but no actual description is present, just say "An image is displayed but the description is missing." without announcing the end.

 The ONLY changes you are allowed to make:
 * Remove "junk" text that is not part of the article (navigation menus, footers, "share this", "related posts", advertisements).
 * Expand abbreviations that are hard to pronounce (e.g., "St." -> "Saint").
 * Write ALL numbers, currencies, symbols, and units as fully spoken words. The TTS engine cannot interpret symbols — it will say gibberish. Examples:
   - "$1,200" -> "twelve hundred dollars"
   - "€100.000" -> "one hundred thousand euros"
   - "£50m" -> "fifty million pounds"
   - "3.5%" -> "three point five percent"
   - "10x" -> "ten times"
   - "§4.2" -> "section four point two"
   - "2024" (as a year) -> "twenty twenty-four"
   - "1990s" -> "nineteen nineties"
   - "#5" -> "number five"
   - "100k" -> "one hundred thousand"
   - "~50" -> "approximately fifty"
   - "<10" -> "less than ten"
   - "2+2=4" -> "two plus two equals four"
 * End every header (h1, h2, h3) with a period to enforce a breath pause.
 * Precede list items with transition words (e.g., "First," "Second," "Next")
 * Wrap blockquotes with explicit spoken markers: "Start of a quote: [The quote] End of the quote."
 * For LLM content blocks (div with class "llm-content-block" and data-model-name attribute): announce the model name before the content: "The following was written by [model name]: [content] End of AI-generated section."
 * Quotes within sentences can simply be turned from "He said, 'I am hungry', before he grabbed a sandwich." into "He said, quote, I am hungry, before he grabbed a sandwich."
 * For links/URLs: NEVER read out a full URL. Only read the anchor text. If a bare URL appears without anchor text, say just the domain name (e.g., "example dot com"). If the context relies on the link, append "linked here."

 Output ONLY the clean narration text.

 Input HTML follows.`;

    const response = await openai.chat.completions.create({
      model: modelId,
      messages: [
        {
          role: 'system',
          content: systemPrompt
        },
        {
          role: 'user',
          // UPDATED: Increased slice limit to 400k characters (approx 100k tokens)
          // Safe for gpt-5-nano's 400k context window
          content: cleanHtml.slice(0, 1000000)
        }
      ],
    });

    let scriptBody = response.choices[0]?.message?.content || '';

    // Validation and Retry
    const outputImageCount = (scriptBody.match(/An image is displayed showing.*?End of the image description\./gs) || []).length;
    console.log(`[TTS] Scriptwriter output contains ${outputImageCount} image narration(s)`);

    // Detect if images were dropped
    if (inputImageCount > 0 && outputImageCount === 0) {
      console.error('[TTS] ❌ SCRIPTWRITER DROPPED ALL IMAGE NARRATIONS');
      console.error('[TTS] Scriptwriter is actively removing image descriptions');

      // Log scriptwriter output sample for debugging
      console.error('[TTS] === SCRIPTWRITER OUTPUT SAMPLE (first 1000 chars) ===');
      console.error(scriptBody.substring(0, 1000));
      console.error('[TTS] === END SAMPLE ===');

      // Retry with even more explicit instruction
      console.warn('[TTS] 🔄 Retrying with explicit instruction...');

      const retrySystemPrompt = systemPrompt + `

🚨🚨🚨 CRITICAL ALERT 🚨🚨🚨
The previous output dropped ${inputImageCount} image descriptions.

YOU MUST PRESERVE ALL TEXT that matches this pattern:
"An image shows [description]. End of the image description."

DO NOT delete, modify, or omit these descriptions. They are REQUIRED accessibility content.
Copy them VERBATIM from input to output.

Failure to preserve image descriptions is a critical error.`;

      const retryResponse = await openai.chat.completions.create({
        model: modelId,
        messages: [
          { role: 'system', content: retrySystemPrompt },
          { role: 'user', content: cleanHtml.slice(0, 400000) }
        ],
        max_completion_tokens: 16000
      });

      const retryBody = retryResponse.choices[0]?.message?.content || '';
      const retryImageCount = (retryBody.match(/An image is displayed showing.*?End of the image description\./gs) || []).length;

      if (retryImageCount > outputImageCount) {
        console.log(`[TTS] ✅ Retry succeeded: ${retryImageCount} image(s) preserved`);
        scriptBody = retryBody;
      } else {
        console.error(`[TTS] ❌ Retry failed: only ${retryImageCount} image(s)`);
        // Use retry body anyway if it's not worse
        if (retryImageCount >= outputImageCount) {
          scriptBody = retryBody;
        }
      }
    } else if (inputImageCount > 0 && outputImageCount < inputImageCount) {
      console.warn(`[TTS] ⚠️  Scriptwriter dropped some images`);
      console.warn(`[TTS] Input: ${inputImageCount}, Output: ${outputImageCount}`);
    } else if (outputImageCount > 0) {
      console.log('[TTS] ✓ Image narrations preserved correctly');
    }

    console.log('[TTS] ===== IMAGE NARRATION PIPELINE END =====');

    return scriptBody;
  } catch (e) {
    console.warn('Scriptwriting failed, falling back to simple text extraction:', e);
    return htmlToNarrationText(htmlContent);
  }
}

export async function generateArticleAudio(
  articleText: string,
  userId: number,
  options: {
    voice?: string;
    instructions?: string;
    contentId?: number;
  } = {}
): Promise<{ buffer: Buffer; chunks: number; chunkMetadata: ChunkMetadata[] }> {
  try {
    const userSettings = await getTTSOptionsForUser(userId);
    const targetModel = userSettings.model || 'gpt-4o-mini-tts';
    const targetVoice = options.voice || userSettings.voice || PROCESSING_CONFIG.tts.voice;

    const openai = await getTTSClientForUser(userId, targetModel);
    
    if (!openai) {
      throw new Error('No AI API key set. Please configure OpenAI or DeepInfra in Settings.');
    }

    const textChunks = splitTextIntoChunks(articleText, PROCESSING_CONFIG.tts.chunkSize);
    console.log(`Generating TTS audio using model '${targetModel}' for ${textChunks.length} chunk(s)...`);

    const allWords = articleText.split(/\s+/);
    const tempDir = getTempDir();
    await fs.mkdir(tempDir, { recursive: true });

    // --- CASE A: Single Chunk ---
    if (textChunks.length === 1) {
      console.log(`Single chunk (${textChunks[0].length} chars)`);
      let retries = PROCESSING_CONFIG.retry.maxAttempts;
      let delay = PROCESSING_CONFIG.retry.baseDelayMs;
      let finalBuffer: Buffer | null = null;
      let finalDuration = 0;

      while (retries > 0) {
        const tempFile = path.join(tempDir, `single_${Date.now()}.mp3`);
        try {
          const response = await openai.audio.speech.create({
            model: targetModel,
            voice: targetVoice as any,
            input: textChunks[0],
            response_format: 'mp3',
          });
          
          const buffer = Buffer.from(await response.arrayBuffer());
          
          // UPDATED: Validate buffer size (min 1KB) to catch empty responses
          if (buffer.length < 1024) throw new Error('Response buffer too small');

          await fs.writeFile(tempFile, buffer);
          finalDuration = await getAudioDuration(tempFile);
          finalBuffer = buffer;
          await fs.unlink(tempFile).catch(() => {});
          break;
        } catch (error: any) {
          await fs.unlink(tempFile).catch(() => {});
          console.warn(`Single chunk attempt failed: ${error.message}`);
          if (retries > 1) {
            await new Promise(resolve => setTimeout(resolve, delay));
            delay = Math.min(delay * 2, PROCESSING_CONFIG.retry.maxDelayMs);
            retries--;
          } else {
            throw error;
          }
        }
      }

      if (!finalBuffer) throw new Error('Failed to generate audio after retries');

      const chunkMetadata: ChunkMetadata[] = [{
        text: textChunks[0],
        startWord: 0,
        endWord: allWords.length - 1,
        duration: finalDuration,
        startTime: 0
      }];

      return { buffer: finalBuffer, chunks: 1, chunkMetadata };
    }

    // --- CASE B: Multiple Chunks ---
    const chunkFiles: string[] = [];
    const chunkMetadata: ChunkMetadata[] = [];
    const timestamp = Date.now();
    let currentWordIndex = 0;
    let currentTime = 0;

    try {
      for (let i = 0; i < textChunks.length; i++) {
        console.log(`Generating chunk ${i + 1}/${textChunks.length}...`);
        
        if (options.contentId) {
          await query(
            'UPDATE content_items SET generation_progress = $1, current_operation = $2 WHERE id = $3',
            [Math.round(30 + (((i + 1) / textChunks.length) * 60)), `audio_chunk_${i + 1}_of_${textChunks.length}`, options.contentId]
          );
        }

        let retries = PROCESSING_CONFIG.retry.maxAttempts;
        let delay = PROCESSING_CONFIG.retry.baseDelayMs;
        let success = false;
        const chunkFile = path.join(tempDir, `chunk_${timestamp}_${i}.mp3`);

        while (retries > 0 && !success) {
          try {
            const response = await openai.audio.speech.create({
              model: targetModel,
              voice: targetVoice as any,
              input: textChunks[i],
              response_format: 'mp3',
            });

            const buffer = Buffer.from(await response.arrayBuffer());
            
            // UPDATED: Size validation to catch network stream truncation
            if (buffer.length < 1024) throw new Error('Response buffer too small');

            await fs.writeFile(chunkFile, buffer);

            // UPDATED: Integrity check via ffprobe utility
            const duration = await getAudioDuration(chunkFile);
            const chunkWords = textChunks[i].split(/\s+/).length;

            chunkFiles.push(chunkFile);
            chunkMetadata.push({
              text: textChunks[i],
              startWord: currentWordIndex,
              endWord: currentWordIndex + chunkWords - 1,
              duration: duration,
              startTime: currentTime
            });

            currentWordIndex += chunkWords;
            currentTime += duration;
            success = true;

          } catch (error: any) {
            console.warn(`Chunk ${i + 1} failed: ${error.message}. Retries left: ${retries - 1}`);
            await fs.unlink(chunkFile).catch(() => {});

            if (retries > 1) {
              await new Promise(resolve => setTimeout(resolve, delay));
              delay = Math.min(delay * 2, PROCESSING_CONFIG.retry.maxDelayMs);
              retries--;
            } else {
              throw new Error(`Failed to generate valid chunk ${i + 1}: ${error.message}`);
            }
          }
        }
        
        if (i < textChunks.length - 1) await new Promise(resolve => setTimeout(resolve, 200));
      }

      const outputFile = path.join(tempDir, `concatenated_${timestamp}.mp3`);
      console.log(`Concatenating ${chunkFiles.length} audio files...`);
      
      if (options.contentId) {
         await query('UPDATE content_items SET generation_progress = $1, current_operation = $2 WHERE id = $3', [95, 'concatenating_audio', options.contentId]);
      }

      await concatenateAudioFiles(chunkFiles, outputFile);
      const finalBuffer = await fs.readFile(outputFile);

      await fs.unlink(outputFile).catch(console.error);
      for (const chunkFile of chunkFiles) await fs.unlink(chunkFile).catch(console.error);

      return { buffer: finalBuffer, chunks: textChunks.length, chunkMetadata };
    } catch (error) {
      for (const chunkFile of chunkFiles) await fs.unlink(chunkFile).catch(console.error);
      throw error;
    }
  } catch (error) {
    console.error('Error generating audio:', error);
    throw new Error('Failed to generate audio. Please check your API keys.');
  }
}

// Guard against concurrent generation for the same content
const activeGenerations = new Set<number>();

export async function generateAudioForContent(contentId: number, regenerate: boolean = false): Promise<{ audioUrl: string; warning?: string }> {
  if (activeGenerations.has(contentId)) {
    console.log(`[TTS] Generation already in progress for content ${contentId}, skipping duplicate`);
    return { audioUrl: '', warning: 'Generation already in progress' };
  }
  activeGenerations.add(contentId);

  try {
    const contentResult = await query('SELECT * FROM content_items WHERE id = $1', [contentId]);
    if (contentResult.rows.length === 0) throw new Error('Content not found');
    const content = contentResult.rows[0];

    let sourceContent = content.html_content || content.content || '';
    if (!sourceContent) throw new Error('No content to convert to audio');

    let imageAltTextData = content.image_alt_text_data;

    // Step 1: Process images (0-20% progress)
    const imageAltTextEnabled = await getUserSetting(content.user_id, 'image_alt_text_enabled');

    if (imageAltTextEnabled !== 'false' && sourceContent) {
      try {
        console.log(`[TTS] Processing image descriptions (regenerate: ${regenerate})...`);

        const imageService = new ImageAltTextService(content.user_id);
        imageAltTextData = await imageService.smartRegenerate(
          sourceContent,
          imageAltTextData, // existing data or null
          content.url || '',
          { articleTitle: content.title, articleAuthor: content.author },
          // Progress callback
          async (current, total) => {
            console.log(`[TTS] Image progress callback triggered: ${current}/${total}`);
            // Scale progress between 0% and 20%
            const progressPercent = Math.round((current / total) * 20);

            console.log(`[TTS] Updating DB: progress=${progressPercent}%, operation=processing_image_${current}_of_${total}`);
            await query(
              'UPDATE content_items SET generation_progress = $1, current_operation = $2 WHERE id = $3',
              [
                progressPercent,
                `processing_image_${current}_of_${total}`,
                contentId
              ]
            );
            console.log(`[TTS] DB update complete for image ${current}/${total}`);  
          },
          regenerate // Pass regenerate flag to force full regeneration when true
        );


        // Save JSONB data (never modify html_content)
        await query(
          'UPDATE content_items SET image_alt_text_data = $1, images_processed = $2, generation_progress = $3 WHERE id = $4',
          [imageAltTextData, true, 20, contentId]
        );

        console.log(`[TTS] Processed ${Object.keys(imageAltTextData.descriptions).length} image descriptions`);
      } catch (error) {
        console.error('[TTS] Image alt-text generation failed:', error);
        // Continue with TTS generation even if image processing fails
      }
    }

    // Step 2: Replace images with narration text (if we have descriptions AND the feature is enabled)
    // IMPORTANT: Must check imageAltTextEnabled here too! Old Gemini descriptions persist in the
    // database (image_alt_text_data column) even after the user turns off the toggle. Without this
    // check, stale English descriptions get injected into non-English articles, causing Whisper to
    // drop content during English→native language transitions (8+ seconds of missing transcript).
    if (imageAltTextEnabled !== 'false' && imageAltTextData?.descriptions && Object.keys(imageAltTextData.descriptions).length > 0) {
      // PASS content.url as the third argument here:
      sourceContent = injectImageNarrations(sourceContent, imageAltTextData.descriptions, content.url || undefined);

      console.log('[TTS] Injected image narrations into HTML for audio script');
      // sourceContent now has "An image is displayed showing..." text instead of <img> tags
      // Original html_content in database remains unchanged
    } else if (imageAltTextEnabled === 'false') {
      console.log('[TTS] Image descriptions disabled by user, skipping injection');
    }

    // Step 3: Script content for listening (20-30% progress)
    let articleBodyScript = '';
    console.log('[TTS] Running Scriptwriter to format HTML for audio...');
    await query(
      'UPDATE content_items SET current_operation = $1, generation_progress = $2 WHERE id = $3',
      ['scripting_content', 20, contentId]
    );

    const chatConfig = await getChatClientForUser(content.user_id);
    if (chatConfig && sourceContent.includes('<')) {
        console.log(`[TTS] Scriptwriter using model: ${chatConfig.model}`);
        articleBodyScript = await scriptArticleForListening(sourceContent, chatConfig.client, chatConfig.model);
    } else {
        articleBodyScript = htmlToNarrationText(sourceContent);
    }

    // Log whether image narrations survived the scriptwriter
    const imageNarrationCount = (articleBodyScript.match(/An image is displayed showing/g) || []).length;
    if (imageAltTextData?.descriptions && Object.keys(imageAltTextData.descriptions).length > 0) {
      console.log(`[TTS] Script contains ${imageNarrationCount} image narration(s) (expected ${Object.keys(imageAltTextData.descriptions).length})`);
    }

    await query('UPDATE content_items SET generation_progress = $1 WHERE id = $2', [30, contentId]);

    let fullScript = '';

    if (content.title) {
      fullScript += `Title: ${content.title}. `;
      if (content.author) fullScript += `Written by ${content.author.replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu, '').trim()}. `;
      if (content.published_at) fullScript += `Published on ${formatDateForNarration(content.published_at)}. `;
      if (content.karma !== undefined && content.karma !== null) fullScript += `It has ${content.karma} karma. `;
      fullScript += '\n\n';
    }

    fullScript += articleBodyScript;

    if (content.comments) {
       try {
          const comments = typeof content.comments === 'string' ? JSON.parse(content.comments) : content.comments;
          if (comments && comments.length > 0) {
              const totalCount = countAllComments(comments);
              console.log(`[TTS] Formatting ${comments.length} top-level comments (${totalCount} total with replies) for narration`);
              const isLessWrong = content.url ? content.url.includes('lesswrong.com') : false;
              // Use a longer, more natural announcement so Whisper doesn't skip it.
              // "Comments section:" (2 words) was consistently dropped by Whisper.
              // A full sentence (~15 words) is much harder for Whisper to miss.
              // Use totalCount (includes replies) so listeners know the full scope.
              fullScript += `\n\nNow, let's move on to the comments section, where thoughts are shared in ${totalCount} ${totalCount === 1 ? 'comment' : 'comments'}.\n\n` + formatCommentsForNarration(comments, false, undefined, isLessWrong);
          }
       } catch (e) {
           console.error("Failed to parse comments for audio:", e);
       }
    }

    // Step 4: Generate audio chunks (30-90% progress)
    console.log(`[TTS] Sending script (${fullScript.length} chars) to audio engine...`);
    await query(
      'UPDATE content_items SET current_operation = $1, generation_progress = $2 WHERE id = $3',
      ['synthesizing_audio', 30, contentId]
    );

    const { buffer: audioBuffer, chunks, chunkMetadata } = await generateArticleAudio(fullScript, content.user_id, {
      contentId: contentId,
    });

    let warning: string | undefined;
    if (chunks > 1) {
      const estimatedMinutes = Math.round(fullScript.length / 900);
      warning = `Generated complete audio in ${chunks} parts (~${estimatedMinutes} minutes).`;
    }

    // Step 5: Final processing (90-95% progress)
    await query(
      'UPDATE content_items SET current_operation = $1, generation_progress = $2 WHERE id = $3',
      ['finalizing_audio', 90, contentId]
    );

    const tempDir = getTempDir();
    const tempFilePath = path.join(tempDir, `final_${contentId}.mp3`);
    let audioDuration = 0;
    try {
      await fs.writeFile(tempFilePath, audioBuffer);
      audioDuration = Math.floor(await getAudioDuration(tempFilePath));
      await fs.unlink(tempFilePath).catch(() => {});
    } catch (e) { console.error(e); }

    const port = process.env.PORT || '8080';
    const backendUrl = process.env.BACKEND_URL
      || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : null)
      || `http://localhost:${port}`;
    const audioUrl = `${backendUrl}/api/content/${contentId}/audio`;

    await query(
      'UPDATE content_items SET audio_data = $1, audio_url = $2, duration = $3, file_size = $4, tts_chunks = $5, generation_status = $6, transcript = NULL, transcript_words = NULL, audio_generated_at = NOW() WHERE id = $7',
      [audioBuffer, audioUrl, audioDuration, audioBuffer.length, JSON.stringify(chunkMetadata), 'ready', contentId]
    );

    console.log(`✓ Audio stored for content ${contentId}`);

    // Step 6: Transcription (95-100% progress)
    console.log('[TTS] Triggering auto-transcription for Read Along...');
    await query(
      'UPDATE content_items SET current_operation = $1, generation_progress = $2 WHERE id = $3',
      ['transcribing', 95, contentId]
    );

    // Whisper prompt: keep it minimal. Whisper's prompt only influences the first
    // ~30-60 seconds of audio, so adding metadata about comments (which appear at
    // the end) does nothing. Just pass an empty string — for chunked transcription
    // the continuity strategy (previous chunk text) works better than static metadata.
    const whisperPrompt = '';
    console.log(`[TTS] Whisper prompt: empty (relying on continuity strategy for chunked audio)`);

    transcribeWithTimestamps(audioBuffer, content.user_id, whisperPrompt)
      .then(async (transcriptResult) => {
          // Fix Whisper dropping the title: if the first word starts after 3s,
          // Whisper likely "consumed" the title (because the prompt matches the
          // spoken opening). Inject a synthetic anchor word at 0.0s so the LLM
          // alignment can anchor the title element to the start of the audio.
          if (transcriptResult.words.length > 0 && transcriptResult.words[0].start > 3.0) {
            console.log(`[TTS] Whisper dropped opening ${transcriptResult.words[0].start.toFixed(1)}s — injecting title anchor at 0.0s`);
            transcriptResult.words.unshift({
              word: content.title || 'Title',
              start: 0.0,
              end: Math.min(transcriptResult.words[0].start, 3.0),
            });
          }

          console.log(`[TTS] Transcription complete (${transcriptResult.words.length} words). Saving...`);
          await query(
            'UPDATE content_items SET transcript = $1, transcript_words = $2, generation_progress = $3, current_operation = $4 WHERE id = $5',
            [transcriptResult.text, JSON.stringify(transcriptResult.words), 97, 'aligning_content', contentId]
          );

          // Run LLM alignment for articles and text items
          if (content.html_content || content.type === 'text') {
            console.log('[TTS] Running LLM-based content alignment...');
            try {
              const alignment = await generateLLMAlignment(
                contentId,
                content.user_id,
                transcriptResult.words
              );

              await query(
                'UPDATE content_items SET content_alignment = $1, generation_status = $2, generation_progress = $3, current_operation = NULL WHERE id = $4',
                [JSON.stringify(alignment), 'completed', 100, contentId]
              );

              console.log(`[TTS] LLM alignment complete: ${alignment.elements.length} elements timestamped`);
            } catch (alignError) {
              console.error('[TTS] LLM alignment failed (non-fatal):', alignError);
              // Still mark as completed even if alignment fails
              await query(
                'UPDATE content_items SET generation_status = $1, generation_progress = $2, current_operation = NULL WHERE id = $3',
                ['completed', 100, contentId]
              );
            }
          } else {
            // No html_content (podcasts), mark as completed after transcription
            await query(
              'UPDATE content_items SET generation_status = $1, generation_progress = $2, current_operation = NULL WHERE id = $3',
              ['completed', 100, contentId]
            );
          }
      })
      .catch(async (err) => {
          console.error('[TTS] Auto-transcription failed:', err);
          // Still mark as completed (audio is ready even without transcript)
          await query(
            'UPDATE content_items SET generation_status = $1, generation_progress = $2, current_operation = NULL WHERE id = $3',
            ['completed', 100, contentId]
          );
      });

    return { audioUrl, warning };

  } catch (error) {
    console.error('Error generating audio for content:', error);
    throw error;
  } finally {
    activeGenerations.delete(contentId);
  }
}
