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

async function concatenateAudioFiles(inputFiles: string[], outputFile: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const concatListPath = outputFile + '.txt';
    const concatList = inputFiles.map(f => `file '${f}'`).join('\n');

    fs.writeFile(concatListPath, concatList)
      .then(() => {
        ffmpeg()
          .input(concatListPath)
          .inputOptions(['-f concat', '-safe 0'])
          // Keep Kokoro fix: Force 44.1kHz MP3 to avoid quality issues
          .audioFrequency(44100)
          .audioBitrate('192k')
          .format('mp3')
          .save(outputFile)
          .on('end', () => {
            fs.unlink(concatListPath).catch(console.error);
            resolve();
          })
          .on('error', (err) => {
            fs.unlink(concatListPath).catch(console.error);
            reject(err);
          });
      })
      .catch(reject);
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

function formatReactionsForNarration(karma?: number, extendedScore?: Record<string, number>): string {
  const parts: string[] = [];
  
  // RESTORED: Logic from openai-tts-1.ts (shows all votes properly)
  if (karma !== undefined && karma !== null) {
    parts.push(`${karma} ${karma === 1 ? 'upvote' : 'upvotes'}`);
  }
  
  // Loop through ALL extended scores (agree, disagree, etc.)
  // This fixes the missing "Agreement" and "Disagree" counts
  if (extendedScore) {
    for (const [reaction, count] of Object.entries(extendedScore)) {
      if (count > 0 && reaction !== 'baseScore') {
        // Clean up key names if needed, but usually they are readable
        parts.push(`${count} ${reaction}`);
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
    
    // Clean up whitespace
    text = text.replace(/\s+/g, ' ').trim();
    return text;
  } catch (e) {
    console.error('JSDOM parsing failed, falling back to regex:', e);
    return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  }
}

function formatCommentsForNarration(comments: Comment[], isReply: boolean = false, replyTo?: string): string {
  let narration = '';

  for (const comment of comments) {
    const reactions = formatReactionsForNarration(comment.karma, comment.extendedScore);
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
      narration += formatCommentsForNarration(comment.replies, true, username);
    }
  }

  return narration;
}

async function scriptArticleForListening(htmlContent: string, openai: any): Promise<string> {
  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: `You are a scriptwriter for an audio narration service.

Your goal is to rewrite the provided HTML article into a plain text script optimized for Text-to-Speech (TTS). A blind person must be able to easily understand the entire article without losing any information.

CRITICAL RULES:
 * CLEAN TEXT: Remove any text that's part of the website but not the article body (like footers, social media share buttons, navigation buttons, curated or recommended posts,...)
 * HEADERS: End every header (h1, h2, h3) with a period or colon to enforce a breath pause.
 * LISTS: Do not rely on HTML tags for lists. Precede list items with transition words (e.g., "First," "Second," "Next") or number them explicitly in text (e.g., "Number one:").
 * NUMBERS & DATES: Convert complex numbers and dates into spoken English. Write "13/10/2024" as "thirteenth October twenty twenty-four" and "1990s" as "nineteen nineties." Write out currency like "$5 million" as "five million dollars."
 * ABBREVIATIONS: Expand all abbreviations that are pronounced differently from how they are written (e.g., change "lbs" to "pounds,", "etc." to "etcetera", "St." to "Saint" or "Street" depending on context).
 * QUOTES: Wrap significant quotes with explicit spoken markers: "Quote: [The quote] End quote."
 * TABLES: Do not read tables row-by-row. Summarize the table's key insight in 1-2 sentences (e.g., "The data indicates a fifty percent increase in...").
 * IMAGES: Locate the 'alt' text or context for <img> tags. Insert a brief narrative description such as: "An image displays [description]."
 * LINKS: Ignore URLs. Read only the anchor text. If the context relies on the link, append "linked here."
 * PARENTHESES: Remove parentheses. Incorporate the parenthetical text naturally into the sentence using commas or em dashes.
 * TONE: Preserve the author's original word choice for the body text. Do not summarize or change their words.
 * DON'T ADD AN INTRO/OUTRO: Output only the narration text.
 
Input HTML follows.`
        },
        {
          role: 'user',
          content: htmlContent.slice(0, 100000)
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

    // --- CASE A: Single Chunk ---
    if (textChunks.length === 1) {
      console.log(`Single chunk (${textChunks[0].length} chars)`);
      let retries = PROCESSING_CONFIG.retry.maxAttempts;
      let delay = PROCESSING_CONFIG.retry.baseDelayMs;
      let response: any = null;

      while (retries > 0) {
        try {
          response = await openai.audio.speech.create({
            model: targetModel,
            voice: targetVoice as any,
            input: textChunks[0],
            response_format: 'mp3',
          });
          break;
        } catch (error: any) {
          if (error.status === 429 && retries > 1) {
            console.log(`Rate limit hit, retrying...`);
            await new Promise(resolve => setTimeout(resolve, delay));
            delay = Math.min(delay * 2, PROCESSING_CONFIG.retry.maxDelayMs);
            retries--;
          } else {
            throw error;
          }
        }
      }

      if (!response) throw new Error('Failed to generate audio after retries');

      const buffer = Buffer.from(await response.arrayBuffer());
      
      const tempDir = getTempDir();
      await fs.mkdir(tempDir, { recursive: true });
      const tempFile = path.join(tempDir, `single_${Date.now()}.mp3`);
      await fs.writeFile(tempFile, buffer);
      const duration = await getAudioDuration(tempFile);
      await fs.unlink(tempFile).catch(console.error);

      const chunkMetadata: ChunkMetadata[] = [{
        text: textChunks[0],
        startWord: 0,
        endWord: allWords.length - 1,
        duration: duration,
        startTime: 0
      }];

      return { buffer, chunks: 1, chunkMetadata };
    }

    // --- CASE B: Multiple Chunks ---
    const tempDir = getTempDir();
    await fs.mkdir(tempDir, { recursive: true });
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
        let response: any = null;

        while (retries > 0) {
          try {
            response = await openai.audio.speech.create({
              model: targetModel,
              voice: targetVoice as any,
              input: textChunks[i],
              response_format: 'mp3',
            });
            break;
          } catch (error: any) {
            if (error.status === 429 && retries > 1) {
              console.log(`Rate limit hit, retrying...`);
              await new Promise(resolve => setTimeout(resolve, delay));
              delay = Math.min(delay * 2, PROCESSING_CONFIG.retry.maxDelayMs);
              retries--;
            } else {
              throw error;
            }
          }
        }

        if (!response) throw new Error(`Failed to generate chunk ${i + 1}`);

        const chunkFile = path.join(tempDir, `chunk_${timestamp}_${i}.mp3`);
        await fs.writeFile(chunkFile, Buffer.from(await response.arrayBuffer()));
        chunkFiles.push(chunkFile);

        const duration = await getAudioDuration(chunkFile);
        const chunkWords = textChunks[i].split(/\s+/).length;

        chunkMetadata.push({
          text: textChunks[i],
          startWord: currentWordIndex,
          endWord: currentWordIndex + chunkWords - 1,
          duration: duration,
          startTime: currentTime
        });

        currentWordIndex += chunkWords;
        currentTime += duration;
        
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
        // Fallback: use JSDOM cleaner
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
              fullScript += '\n\nComments section:\n\n' + formatCommentsForNarration(comments);
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

    const backendUrl = process.env.BACKEND_URL
      || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : null)
      || `http://localhost:3001`;
    const audioUrl = `${backendUrl}/api/content/${contentId}/audio`;

    await query(
      'UPDATE content_items SET audio_data = $1, audio_url = $2, duration = $3, file_size = $4, tts_chunks = $5, generation_status = $6 WHERE id = $7',
      [audioBuffer, audioUrl, audioDuration, audioBuffer.length, JSON.stringify(chunkMetadata), 'ready', contentId]
    );

    console.log(`✓ Audio stored for content ${contentId}`);

    // --- TRIGGER TRANSCRIPTION (No prompt passed to avoid skipping intro) ---
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
