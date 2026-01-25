import fs from 'fs/promises';
import path from 'path';
import ffmpeg from 'fluent-ffmpeg';
import { query } from '../database/db.js';
import { getAudioDir, getTempDir } from '../config/storage.js';
import { getAudioDuration } from './audio-utils.js';
import { PROCESSING_CONFIG } from '../config/processing.js';
// CHANGED: Import the new provider helpers
import { getTTSClientForUser, getTTSOptionsForUser } from './ai-providers.js';

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

    // If this is the last chunk, take everything
    if (chunkEnd >= text.length) {
      chunks.push(text.slice(currentPos));
      break;
    }

    // Find the last sentence boundary within the chunk
    const chunk = text.slice(currentPos, chunkEnd);
    const lastSentenceEnd = Math.max(
      chunk.lastIndexOf('. '),
      chunk.lastIndexOf('! '),
      chunk.lastIndexOf('? ')
    );

    if (lastSentenceEnd > maxLength * 0.6) {
      // Good sentence boundary found
      chunkEnd = currentPos + lastSentenceEnd + 1;
    } else {
      // No good boundary, try to break at word boundary
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
    // Create a temporary concat list file
    const concatListPath = outputFile + '.txt';
    const concatList = inputFiles.map(f => `file '${f}'`).join('\n');

    fs.writeFile(concatListPath, concatList)
      .then(() => {
        ffmpeg()
          .input(concatListPath)
          .inputOptions(['-f concat', '-safe 0'])
          .outputOptions(['-c copy'])
          .output(outputFile)
          .on('end', () => {
            // Clean up concat list file
            fs.unlink(concatListPath).catch(console.error);
            resolve();
          })
          .on('error', (err) => {
            fs.unlink(concatListPath).catch(console.error);
            reject(err);
          })
          .run();
      })
      .catch(reject);
  });
}

/**
 * Format a date naturally for TTS narration (e.g., "15th of January 2026")
 */
function formatDateForNarration(dateString: string): string {
  try {
    const date = new Date(dateString);
    const day = date.getDate();
    const month = date.toLocaleDateString('en-US', { month: 'long' });
    const year = date.getFullYear();

    // Add ordinal suffix (1st, 2nd, 3rd, 4th, etc.)
    const suffix = ['th', 'st', 'nd', 'rd'];
    const v = day % 100;
    const ordinalDay = day + (suffix[(v - 20) % 10] || suffix[v] || suffix[0]);

    return `${ordinalDay} of ${month} ${year}`;
  } catch (e) {
    return dateString; // Fallback to original if parsing fails
  }
}

/**
 * Format reactions from extendedScore for narration (e.g., "7 upvotes, 1 agree, 1 laugh")
 */
function formatReactionsForNarration(karma?: number, extendedScore?: Record<string, number>): string {
  const parts: string[] = [];

  // Always include karma as "upvotes"
  if (karma !== undefined && karma !== null) {
    parts.push(`${karma} ${karma === 1 ? 'upvote' : 'upvotes'}`);
  }

  // Include explicit reactions if available
  if (extendedScore) {
    for (const [reaction, count] of Object.entries(extendedScore)) {
      if (count > 0 && reaction !== 'baseScore') {
        parts.push(`${count} ${reaction}`);
      }
    }
  }

  return parts.join(', ');
}

/**
 * Convert HTML content to clean text for TTS narration
 */
function htmlToNarrationText(html: string): string {
  // Simple regex stripper since we trust the fetcher's cleaning mostly
  // But strictly speaking, the Fetcher stores clean HTML, so we strip tags here.
  let text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  return text;
}

/**
 * Format structured comments for TTS narration
 */
function formatCommentsForNarration(comments: Comment[], isReply: boolean = false, replyTo?: string): string {
  let narration = '';

  for (const comment of comments) {
    // Format metadata
    const reactions = formatReactionsForNarration(comment.karma, comment.extendedScore);
    const date = comment.date ? formatDateForNarration(comment.date) : '';

    // Build comment intro
    let commentIntro = '';
    if (isReply && replyTo) {
      commentIntro = `Reply to ${replyTo} by ${comment.username}`;
    } else {
      commentIntro = `${comment.username}`;
    }

    if (date) {
      commentIntro += ` on ${date}`;
    }

    if (reactions) {
      commentIntro += `. ${reactions}`;
    }

    // Convert HTML content to plain text
    const commentText = htmlToNarrationText(comment.content);

    narration += `${commentIntro}.\n"${commentText}"\n\n`;

    // Recursively add replies
    if (comment.replies && comment.replies.length > 0) {
      narration += formatCommentsForNarration(comment.replies, true, comment.username);
    }
  }

  return narration;
}

/**
 * Polish generic article text using LLM to remove "Share this", "Subscribe", etc.
 * Does NOT re-extract comments or restructure deeply.
 */
async function polishGenericArticleText(rawText: string, openai: any): Promise<string> {
  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini', // Cheap and fast
      messages: [
        {
          role: 'system',
          content: `You are a text cleaner for audio narration.
          Your goal is to remove "web clutter" from the provided text so it reads smoothly.
          
          RULES:
          1. REMOVE: Navigation menus, "Share this", "Subscribe", "Read more", image captions that don't make sense without the image, and footer text.
          2. KEEP: All original sentences, paragraphs, and informational content.
          3. DO NOT SUMMARIZE. Output the full, original text, just cleaned.
          4. DO NOT ADD an intro or outro.
          5. DO NOT READ URLs.
          
          Input text follows.`
        },
        {
          role: 'user',
          content: rawText.slice(0, 100000) // Safety cap
        }
      ],
      max_completion_tokens: 16000,
    });
    return response.choices[0]?.message?.content || rawText;
  } catch (e) {
    console.warn('Text polishing failed, using raw text:', e);
    return rawText;
  }
}


export async function generateArticleAudio(
  articleText: string,
  userId: number,
  options: {
    voice?: 'alloy' | 'echo' | 'fable' | 'onyx' | 'nova' | 'shimmer' | 'coral' | string;
    instructions?: string;
    contentId?: number;
  } = {}
): Promise<{ buffer: Buffer; chunks: number; chunkMetadata: ChunkMetadata[] }> {
  try {
    // 1. Get Settings (Model & Voice)
    const userSettings = await getTTSOptionsForUser(userId);
    const targetModel = userSettings.model || 'gpt-4o-mini-tts';
    const targetVoice = options.voice || userSettings.voice || PROCESSING_CONFIG.tts.voice;

    // 2. Get the Client (Routes to DeepInfra if targetModel is Kokoro)
    const openai = await getTTSClientForUser(userId, targetModel);
    
    if (!openai) {
      throw new Error('No AI API key set. Please configure OpenAI or DeepInfra in Settings.');
    }

    const instructions = options.instructions || 'Read this article clearly and naturally.';

    // 3. Chunking
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
            model: targetModel, // Pass dynamic model
            voice: targetVoice as any,
            input: textChunks[0],
            // instructions: instructions, // Note: some providers might ignore this
          });
          break;
        } catch (error: any) {
          if (error.status === 429 && retries > 1) {
            console.log(`Rate limit hit, retrying in ${delay/1000}s... (${retries - 1} retries left)`);
            await new Promise(resolve => setTimeout(resolve, delay));
            delay = Math.min(delay * 2, PROCESSING_CONFIG.retry.maxDelayMs);
            retries--;
          } else {
            throw error;
          }
        }
      }

      if (!response) {
        throw new Error('Failed to generate audio after retries');
      }

      const buffer = Buffer.from(await response.arrayBuffer());

      // Save temp file to get duration
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
        console.log(`Generating chunk ${i + 1}/${textChunks.length} (${textChunks[i].length} chars)...`);

        const chunkProgress = Math.round(((i + 1) / textChunks.length) * 90);
        if (options.contentId) {
          await query(
            'UPDATE content_items SET generation_progress = $1, current_operation = $2 WHERE id = $3',
            [chunkProgress, `audio_chunk_${i + 1}_of_${textChunks.length}`, options.contentId]
          );
        }

        let retries = PROCESSING_CONFIG.retry.maxAttempts;
        let delay = PROCESSING_CONFIG.retry.baseDelayMs;
        let response: any = null;

        while (retries > 0) {
          try {
            response = await openai.audio.speech.create({
              model: targetModel, // Pass dynamic model
              voice: targetVoice as any,
              input: textChunks[i],
              // instructions: instructions,
            });
            break;
          } catch (error: any) {
            if (error.status === 429 && retries > 1) {
              console.log(`Rate limit hit on chunk ${i + 1}, retrying in ${delay/1000}s... (${retries - 1} retries left)`);
              await new Promise(resolve => setTimeout(resolve, delay));
              delay = Math.min(delay * 2, PROCESSING_CONFIG.retry.maxDelayMs);
              retries--;
            } else {
              throw error;
            }
          }
        }

        if (!response) {
          throw new Error(`Failed to generate chunk ${i + 1} after retries`);
        }

        const chunkFile = path.join(tempDir, `chunk_${timestamp}_${i}.mp3`);
        const chunkBuffer = Buffer.from(await response.arrayBuffer());
        await fs.writeFile(chunkFile, chunkBuffer);
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

        if (i < textChunks.length - 1) {
          const delayMs = 200; 
          await new Promise(resolve => setTimeout(resolve, delayMs));
        }
      }

      const outputFile = path.join(tempDir, `concatenated_${timestamp}.mp3`);
      console.log(`Concatenating ${chunkFiles.length} audio files...`);

      if (options.contentId) {
        await query(
          'UPDATE content_items SET generation_progress = $1, current_operation = $2 WHERE id = $3',
          [95, 'concatenating_audio', options.contentId]
        );
      }

      await concatenateAudioFiles(chunkFiles, outputFile);
      const finalBuffer = await fs.readFile(outputFile);

      // Cleanup
      await fs.unlink(outputFile).catch(console.error);
      for (const chunkFile of chunkFiles) {
        await fs.unlink(chunkFile).catch(console.error);
      }

      return { buffer: finalBuffer, chunks: textChunks.length, chunkMetadata };
    } catch (error) {
      for (const chunkFile of chunkFiles) {
        await fs.unlink(chunkFile).catch(console.error);
      }
      throw error;
    }
  } catch (error) {
    console.error('Error generating audio:', error);
    throw new Error('Failed to generate audio. Please check your API keys.');
  }
}

export async function generateAudioForContent(contentId: number): Promise<{ audioUrl: string; warning?: string }> {
  try {
    // 1. Get content
    const contentResult = await query('SELECT * FROM content_items WHERE id = $1', [contentId]);

    if (contentResult.rows.length === 0) {
      throw new Error('Content not found');
    }

    const content = contentResult.rows[0];

    // 2. Prepare Text (Use existing, clean content from Fetcher)
    let textToConvert = '';
    
    // We assume the Fetcher has done its job.
    // However, if we are in "Generate Audio" mode, we might need to construct the reading script.
    
    if (content.type === 'article') {
       // Check if content exists
       if (content.content) {
          textToConvert = content.content;
       } else if (content.html_content) {
          // Fallback if no formatted content (should generally not happen if fetcher ran)
          textToConvert = htmlToNarrationText(content.html_content);
       }
    } else {
      textToConvert = content.content || '';
    }

    if (!textToConvert) {
      throw new Error('No content to convert to audio');
    }

    // 3. Assemble the Script (Intro + Body + Comments)
    let fullText = '';

    // Intro
    if (content.title) {
      fullText = `This post is titled: ${content.title}`;
      if (content.author) fullText += `, written by ${content.author}`;
      if (content.published_at) fullText += `, posted on ${formatDateForNarration(content.published_at)}`;
      
      // Add karma info to intro if available
      if (content.karma !== undefined && content.karma !== null) {
        fullText += `. It has ${content.karma} karma`;
      }
      fullText += '.\n\n';
    }

    // Polish generic text?
    // Get OpenAI client just for polishing (doesn't matter if it's deepinfra or openai for this, 
    // but polishing is best done by a smart model like 4o-mini, so let's stick to OpenAI for polish if available)
    // Note: If user ONLY has DeepInfra key, we can skip polishing or use Llama if we added that support.
    // For now, let's try to get a client.
    
    // Check if we need polishing
    const isSpecializedSite = content.url && (content.url.includes('effectivealtruism.org') || content.url.includes('lesswrong.com'));
    
    // Only polish if it's a generic site AND we have content
    if (!isSpecializedSite && textToConvert.length > 0) {
        try {
            // We use the "Chat" provider for polishing.
            // Currently assuming 'openai' provider for chat.
            const { getOpenAIClientForUser } = await import('./ai-providers.js');
            const chatClient = await getOpenAIClientForUser(content.user_id);
            
            if (chatClient) {
                 console.log('[TTS] Generic site detected. Running text polishing...');
                 await query('UPDATE content_items SET current_operation = $1 WHERE id = $2', ['polishing_text', contentId]);
                 // We don't want to re-polish if it looks clean, but the fetcher saves raw text.
                 // Safety: only polish if it hasn't been polished (difficult to track without flag)
                 // or just polish the input string before concatenating.
                 textToConvert = await polishGenericArticleText(textToConvert, chatClient);
            }
        } catch (e) {
            console.warn("Skipping text polish due to client error", e);
        }
    }

    fullText += textToConvert;

    // Comments
    // Check for structured comments
    if (content.comments) {
       try {
          const comments = typeof content.comments === 'string' 
            ? JSON.parse(content.comments) 
            : content.comments;
            
          if (comments && comments.length > 0) {
              console.log(`[TTS] Formatting ${comments.length} comments for narration`);
              fullText += '\n\nComments section:\n\n' + formatCommentsForNarration(comments);
          }
       } catch (e) {
           console.error("Failed to parse comments for audio:", e);
       }
    }

    // 4. Generate
    const { buffer: audioBuffer, chunks, chunkMetadata } = await generateArticleAudio(fullText, content.user_id, {
      contentId: contentId,
    });

    // 5. Store Result
    let warning: string | undefined;
    if (chunks > 1) {
      const estimatedMinutes = Math.round(fullText.length / 900);
      warning = `Generated complete audio in ${chunks} parts (~${estimatedMinutes} minutes).`;
    }

    console.log(`Storing audio in database (${(audioBuffer.length / 1024 / 1024).toFixed(2)} MB)`);

    // Get duration
    const tempDir = getTempDir();
    const tempFilePath = path.join(tempDir, `temp_duration_${contentId}.mp3`);
    let audioDuration = 0;

    try {
      await fs.writeFile(tempFilePath, audioBuffer);
      audioDuration = Math.floor(await getAudioDuration(tempFilePath));
    } catch (error) {
      console.error('Failed to get audio duration:', error);
    } finally {
      await fs.unlink(tempFilePath).catch(() => {});
    }

    const backendUrl = process.env.BACKEND_URL
      || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : null)
      || `http://localhost:3001`;
    const audioUrl = `${backendUrl}/api/content/${contentId}/audio`;

    const fileSize = audioBuffer.length;
    await query(
      'UPDATE content_items SET audio_data = $1, audio_url = $2, duration = $3, file_size = $4, tts_chunks = $5, generation_status = $6 WHERE id = $7',
      [audioBuffer, audioUrl, audioDuration, fileSize, JSON.stringify(chunkMetadata), 'ready', contentId]
    );

    console.log(`✓ Audio stored in database for content ${contentId}`);

    return { audioUrl, warning };
  } catch (error) {
    console.error('Error generating audio for content:', error);
    throw error;
  }
}
