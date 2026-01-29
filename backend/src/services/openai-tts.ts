import fs from 'fs/promises';
import path from 'path';
import ffmpeg from 'fluent-ffmpeg';
// RESTORED: JSDOM for robust HTML cleaning (fixes empty comments)
import { JSDOM } from 'jsdom';
import { query } from '../database/db.js';
import { getTempDir } from '../config/storage.js';
import { getAudioDuration } from './audio-utils.js';
import { PROCESSING_CONFIG } from '../config/processing.js';
import { getTTSClientForUser, getTTSOptionsForUser, getOpenAIClientForUser } from './ai-providers.js';
import { transcribeWithTimestamps } from './transcription.js';

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
      .audioFrequency(44100)
      .audioBitrate('192k')
      .format('mp3')
      .on('end', () => resolve())
      .on('error', (err) => {
        console.error('[FFmpeg] Error during seamless concatenation:', err);
        reject(err);
      })
      .save(outputFile);
  });
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

    // Get text content (handles entities like &quot; correctly)
    let text = doc.body.textContent || '';

    // Remove emojis (for narration only - they don't render well in TTS)
    text = text.replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu, '');

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

function formatCommentsForNarration(comments: Comment[], isReply: boolean = false, replyTo?: string, isLessWrong: boolean = false): string {
  let narration = '';

  for (const comment of comments) {
    const reactions = formatReactionsForNarration(comment.karma, comment.extendedScore, isLessWrong);
    const date = comment.date ? formatDateForNarration(comment.date) : '';

    let commentIntro = '';
    // Fix: Handle potential missing username (though Fetcher usually handles this)
    const username = comment.username || 'Anonymous';

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

async function scriptArticleForListening(htmlContent: string, openai: any): Promise<string> {
  try {
    // ADDED: Pre-clean HTML to remove massive technical bloat (scripts, styles, SVGs)
    // This reduces token count significantly before sending to LLM
    const dom = new JSDOM(htmlContent);
    const doc = dom.window.document;
    
    const junkSelectors = 'script, style, noscript, iframe, svg, path, input[type="hidden"], meta, link';
    doc.querySelectorAll(junkSelectors).forEach(el => el.remove());
    
    // Use the cleaner HTML which retains structure but drops junk
    const cleanHtml = doc.body.innerHTML || htmlContent;

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: `You are a scriptwriter for an audio narration service.

 Your goal is to rewrite the provided HTML article into a plain text script optimized for Text-to-Speech (TTS).

 CRITICAL INSTRUCTION: You must preserve the author's original words exactly as they are written, VERBATIM. 
 DO NOT summarize. 
 DO NOT rewrite sentences. 
 DO NOT simplify the language.

 The ONLY changes you are allowed to make:
 * Remove "junk" text that is not part of the article (navigation menus, footers, "share this", "related posts", advertisements).
 * Expand abbreviations that are hard to pronounce (e.g., "St." -> "Saint").
 * Format numbers/dates to be readable (e.g., "1990s" -> "nineteen nineties").
 * End every header (h1, h2, h3) with a period or colon to enforce a breath pause.
 * Precede list items with transition words (e.g., "First," "Second," "Next")
 * Wrap significant quotes with explicit spoken markers: "Quote: [The quote] End quote."
 * Locate the 'alt' text or context for <img> tags. Insert a narrative description such as: "An image displays [alt text]."
 * Ignore URLs. Read only the anchor text. If the context relies on the link, append "linked here."

 Output ONLY the clean narration text.
 
 Input HTML follows.`
        },
        {
          role: 'user',
          // UPDATED: Increased slice limit to 400k characters (approx 100k tokens)
          // Safe for gpt-4o-mini's 128k context window
          content: cleanHtml.slice(0, 400000)
        }
      ],
      max_completion_tokens: 16000,
    });
    return response.choices[0]?.message?.content || htmlToNarrationText(htmlContent);
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
            [Math.round(((i + 1) / textChunks.length) * 90), `audio_chunk_${i + 1}_of_${textChunks.length}`, options.contentId]
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

export async function generateAudioForContent(contentId: number): Promise<{ audioUrl: string; warning?: string }> {
  try {
    const contentResult = await query('SELECT * FROM content_items WHERE id = $1', [contentId]);
    if (contentResult.rows.length === 0) throw new Error('Content not found');
    const content = contentResult.rows[0];

    let articleBodyScript = '';
    const sourceContent = content.html_content || content.content || '';

    if (!sourceContent) throw new Error('No content to convert to audio');

    console.log('[TTS] Running Scriptwriter to format HTML for audio...');
    await query('UPDATE content_items SET current_operation = $1 WHERE id = $2', ['scripting_content', contentId]);
    
    const chatClient = await getOpenAIClientForUser(content.user_id);
    if (chatClient && sourceContent.includes('<')) { 
        articleBodyScript = await scriptArticleForListening(sourceContent, chatClient);
    } else {
        articleBodyScript = htmlToNarrationText(sourceContent);
    }

    let fullScript = '';

    if (content.title) {
      fullScript += `Title: ${content.title}. `;
      if (content.author) fullScript += `Written by ${content.author}. `;
      if (content.published_at) fullScript += `Published on ${formatDateForNarration(content.published_at)}. `;
      if (content.karma !== undefined && content.karma !== null) fullScript += `It has ${content.karma} karma. `;
      fullScript += '\n\n';
    }

    fullScript += articleBodyScript;

    if (content.comments) {
       try {
          const comments = typeof content.comments === 'string' ? JSON.parse(content.comments) : content.comments;
          if (comments && comments.length > 0) {
              console.log(`[TTS] Formatting ${comments.length} comments for narration`);
              const isLessWrong = content.url ? content.url.includes('lesswrong.com') : false;
              fullScript += '\n\nComments section:\n\n' + formatCommentsForNarration(comments, false, undefined, isLessWrong);
          }
       } catch (e) {
           console.error("Failed to parse comments for audio:", e);
       }
    }

    console.log(`[TTS] Sending script (${fullScript.length} chars) to audio engine...`);
    await query('UPDATE content_items SET current_operation = $1 WHERE id = $2', ['synthesizing_audio', contentId]);

    const { buffer: audioBuffer, chunks, chunkMetadata } = await generateArticleAudio(fullScript, content.user_id, {
      contentId: contentId,
    });

    let warning: string | undefined;
    if (chunks > 1) {
      const estimatedMinutes = Math.round(fullScript.length / 900);
      warning = `Generated complete audio in ${chunks} parts (~${estimatedMinutes} minutes).`;
    }

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
      'UPDATE content_items SET audio_data = $1, audio_url = $2, duration = $3, file_size = $4, tts_chunks = $5, generation_status = $6, transcript = NULL, transcript_words = NULL WHERE id = $7',
      [audioBuffer, audioUrl, audioDuration, audioBuffer.length, JSON.stringify(chunkMetadata), 'ready', contentId]
    );

    console.log(`✓ Audio stored for content ${contentId}`);

    console.log('[TTS] Triggering auto-transcription for Read Along...');
    await query('UPDATE content_items SET current_operation = $1 WHERE id = $2', ['transcribing', contentId]);

    transcribeWithTimestamps(audioUrl, content.user_id)
      .then(async (transcriptResult) => {
          console.log(`[TTS] Transcription complete (${transcriptResult.words.length} words). Saving...`);
          await query(
            'UPDATE content_items SET transcript = $1, transcript_words = $2, current_operation = NULL WHERE id = $3',
            [transcriptResult.text, JSON.stringify(transcriptResult.words), contentId]
          );
      })
      .catch(err => {
          console.error('[TTS] Auto-transcription failed:', err);
      });

    return { audioUrl, warning };

  } catch (error) {
    console.error('Error generating audio for content:', error);
    throw error;
  }
}
