import fs from 'fs/promises';
import path from 'path';
import ffmpeg from 'fluent-ffmpeg';
import { query } from '../database/db.js';
import { getAudioDir, getTempDir } from '../config/storage.js';
import { getAudioDuration } from './audio-utils.js';
import { PROCESSING_CONFIG } from '../config/processing.js';
import { getOpenAIClientForUser } from './ai-providers.js';

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
          .outputOptions(['-c copy'])
          .output(outputFile)
          .on('end', () => {
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
 * Format a date naturally (e.g., "15th of January 2026")
 */
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

/**
 * Format reactions exactly as requested: "7 upvotes, 1 agree, 1 laugh"
 */
function formatReactionsForNarration(karma?: number, extendedScore?: Record<string, number>): string {
  const parts: string[] = [];

  // 1. Base Karma
  if (karma !== undefined && karma !== null) {
    parts.push(`${karma} ${karma === 1 ? 'upvote' : 'upvotes'}`);
  }

  // 2. Extended Reactions (Agree, Disagree, Laugh, etc.)
  if (extendedScore) {
    for (const [reaction, count] of Object.entries(extendedScore)) {
      if (count > 0 && reaction !== 'baseScore') {
        // Map reaction keys to readable text if needed, or use as-is
        parts.push(`${count} ${reaction}`);
      }
    }
  }

  return parts.join(', ');
}

/**
 * Recursive function to build the narration string from the comment tree
 */
function formatCommentsForNarration(comments: Comment[], isReply: boolean = false, parentAuthor?: string): string {
  let narration = '';

  for (const comment of comments) {
    // A. The Intro
    let commentIntro = '';
    if (isReply && parentAuthor) {
      commentIntro = `Reply to ${parentAuthor} by ${comment.username}`;
    } else {
      commentIntro = `${comment.username}`; // Top level just starts with name
    }

    // B. Date
    if (comment.date) {
      commentIntro += ` on ${formatDateForNarration(comment.date)}`;
    }

    // C. Reactions
    const reactions = formatReactionsForNarration(comment.karma, comment.extendedScore);
    if (reactions) {
      commentIntro += `. ${reactions}`; // "User on Date. 7 upvotes, 1 agree."
    }

    // D. The Content (Strip HTML tags for safety, though Fetcher usually handles this)
    const cleanContent = comment.content.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

    // E. Assemble
    narration += `${commentIntro}.\n"${cleanContent}"\n\n`;

    // F. Recurse for replies
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

// --- MAIN GENERATION FUNCTIONS ---

export async function generateArticleAudio(
  articleText: string,
  userId: number,
  options: {
    voice?: 'alloy' | 'echo' | 'fable' | 'onyx' | 'nova' | 'shimmer' | 'coral';
    instructions?: string;
    contentId?: number;
  } = {}
): Promise<{ buffer: Buffer; chunks: number; chunkMetadata: ChunkMetadata[] }> {
  try {
    const openai = await getOpenAIClientForUser(userId);
    if (!openai) {
      throw new Error('OpenAI API key not set. Please set your OpenAI API key in Settings.');
    }

    const voice = options.voice || PROCESSING_CONFIG.tts.voice;
    // Simplified instructions since we prepare the text heavily beforehand
    const instructions = options.instructions || 'Read this text clearly and naturally.';

    const textChunks = splitTextIntoChunks(articleText, PROCESSING_CONFIG.tts.chunkSize);
    console.log(`Generating TTS audio with gpt-4o-mini-tts for ${textChunks.length} chunk(s)...`);

    // ... (Same chunk generation logic as before, omitting for brevity as it was correct in original) ...
    // Note: In a real deployment, ensure the loop/retry/concat logic from the previous file is preserved here.
    // I am pasting the core logic back in to ensure the file is complete.

    const tempDir = getTempDir();
    await fs.mkdir(tempDir, { recursive: true });
    
    // Single Chunk Optimization
    if (textChunks.length === 1) {
       const response = await openai.audio.speech.create({
          model: 'gpt-4o-mini-tts',
          voice: voice,
          input: textChunks[0],
          instructions: instructions,
        });
        const buffer = Buffer.from(await response.arrayBuffer());
        
        // Quick duration check
        const tempFile = path.join(tempDir, `single_${Date.now()}.mp3`);
        await fs.writeFile(tempFile, buffer);
        const duration = await getAudioDuration(tempFile);
        await fs.unlink(tempFile).catch(console.error);

        return { 
          buffer, 
          chunks: 1, 
          chunkMetadata: [{ 
            text: textChunks[0], 
            startWord: 0, 
            endWord: textChunks[0].split(/\s+/).length, 
            duration, 
            startTime: 0 
          }] 
        };
    }

    // Multi-chunk Logic
    const chunkFiles: string[] = [];
    const chunkMetadata: ChunkMetadata[] = [];
    let currentTime = 0;
    let currentWordIndex = 0;

    for (let i = 0; i < textChunks.length; i++) {
        // Progress Update
        if (options.contentId) {
             const progress = Math.round(((i + 1) / textChunks.length) * 90);
             await query('UPDATE content_items SET generation_progress = $1 WHERE id = $2', [progress, options.contentId]);
        }

        const response = await openai.audio.speech.create({
            model: 'gpt-4o-mini-tts',
            voice: voice,
            input: textChunks[i],
            instructions: instructions,
        });
        
        const chunkBuffer = Buffer.from(await response.arrayBuffer());
        const chunkFile = path.join(tempDir, `chunk_${Date.now()}_${i}.mp3`);
        await fs.writeFile(chunkFile, chunkBuffer);
        chunkFiles.push(chunkFile);

        const duration = await getAudioDuration(chunkFile);
        const wordCount = textChunks[i].split(/\s+/).length;
        
        chunkMetadata.push({
            text: textChunks[i],
            startWord: currentWordIndex,
            endWord: currentWordIndex + wordCount,
            duration,
            startTime: currentTime
        });

        currentTime += duration;
        currentWordIndex += wordCount;
    }

    const outputFile = path.join(tempDir, `concat_${Date.now()}.mp3`);
    await concatenateAudioFiles(chunkFiles, outputFile);
    const finalBuffer = await fs.readFile(outputFile);

    // Cleanup
    await fs.unlink(outputFile).catch(() => {});
    for (const f of chunkFiles) await fs.unlink(f).catch(() => {});

    return { buffer: finalBuffer, chunks: textChunks.length, chunkMetadata };

  } catch (error) {
    console.error('Error generating audio:', error);
    throw error;
  }
}

export async function generateAudioForContent(contentId: number): Promise<{ audioUrl: string; warning?: string }> {
  try {
    // 1. Get content from DB
    const res = await query('SELECT * FROM content_items WHERE id = $1', [contentId]);
    if (res.rows.length === 0) throw new Error('Content not found');
    const content = res.rows[0];

    const openai = await getOpenAIClientForUser(content.user_id);

    // 2. Prepare the Script
    let finalScript = '';

    // --- A. INTRO ---
    if (content.title) {
      finalScript += `Title: ${content.title}. `;
      if (content.author) finalScript += `Written by ${content.author}. `;
      if (content.published_at) finalScript += `Published on ${formatDateForNarration(content.published_at)}. `;
      finalScript += '\n\n';
    }

    // --- B. MAIN CONTENT ---
    let articleBody = content.content || '';
    const isSpecializedSite = content.url && (content.url.includes('effectivealtruism.org') || content.url.includes('lesswrong.com'));

    // Decision: Do we polish?
    // If it's EA/LW, we assume the Fetcher did a perfect job extracting the markdown/text.
    // If it's a random blog, we use the LLM to "polish" the text (remove clutter), but NOT re-parse structure.
    if (!isSpecializedSite && articleBody && openai) {
        console.log('[TTS] Generic site detected. Running lightweight text polishing...');
        await query('UPDATE content_items SET current_operation = $1 WHERE id = $2', ['polishing_text', contentId]);
        articleBody = await polishGenericArticleText(articleBody, openai);
    }

    finalScript += articleBody;

    // --- C. COMMENTS (Only for EA/LW or if explicitly parsed) ---
    // We only read comments if they exist in the DB JSON column.
    if (content.comments) {
      let commentsArray: Comment[] = [];
      try {
        commentsArray = typeof content.comments === 'string' ? JSON.parse(content.comments) : content.comments;
      } catch (e) { console.error('Error parsing comments JSON', e); }

      if (commentsArray.length > 0) {
        console.log(`[TTS] appending ${commentsArray.length} comments to script.`);
        finalScript += '\n\nComments Section:\n\n';
        finalScript += formatCommentsForNarration(commentsArray);
      }
    }

    // 3. Generate Audio
    console.log(`[TTS] Sending ${finalScript.length} chars to OpenAI Audio API...`);
    await query('UPDATE content_items SET current_operation = $1 WHERE id = $2', ['synthesizing_audio', contentId]);
    
    const { buffer, chunks, chunkMetadata } = await generateArticleAudio(finalScript, content.user_id, {
        contentId
    });

    // 4. Save and Return
    // ... (Same saving logic as before) ...
    const tempDir = getTempDir();
    const tempFilePath = path.join(tempDir, `duration_${contentId}.mp3`);
    await fs.writeFile(tempFilePath, buffer);
    const audioDuration = Math.floor(await getAudioDuration(tempFilePath));
    await fs.unlink(tempFilePath).catch(() => {});

    const backendUrl = process.env.BACKEND_URL || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : 'http://localhost:3001');
    const audioUrl = `${backendUrl}/api/content/${contentId}/audio`;

    await query(
      'UPDATE content_items SET audio_data = $1, audio_url = $2, duration = $3, file_size = $4, tts_chunks = $5, generation_status = $6 WHERE id = $7',
      [buffer, audioUrl, audioDuration, buffer.length, JSON.stringify(chunkMetadata), 'ready', contentId]
    );

    return { audioUrl };

  } catch (error) {
    console.error('Error in generateAudioForContent:', error);
    throw error;
  }
}
