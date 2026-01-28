import fs from 'fs/promises';
import path from 'path';
import ffmpeg from 'fluent-ffmpeg';
import { JSDOM } from 'jsdom';
import { query } from '../database/db.js';
import { getTempDir } from '../config/storage.js';
import { getAudioDuration } from './audio-utils.js';
import { getTTSOptionsForUser, getOpenAIClientForUser } from './ai-providers.js';
import { transcribeWithTimestamps } from './transcription.js';

// --- QUEUE SYSTEM STATE ---
const audioQueue: number[] = [];
let isProcessingQueue = false;

interface Comment {
  id?: string;
  username: string;
  date?: string;
  karma?: number;
  extendedScore?: Record<string, number>;
  content: string;
  replies?: Comment[];
}

// --- PUBLIC QUEUE ENTRY POINT ---

/**
 * Adds an article to the audio generation queue.
 * Returns immediately, allowing the UI to show "Generating..." state.
 */
export async function queueAudioGeneration(contentId: number): Promise<void> {
  // Prevent duplicate queuing
  if (audioQueue.includes(contentId)) {
    console.log(`[TTS-Queue] Content ${contentId} is already in the queue.`);
    return;
  }

  audioQueue.push(contentId);
  console.log(`[TTS-Queue] Added content ${contentId} to queue. Position: ${audioQueue.length}`);

  // Mark as 'generating' in DB immediately so UI updates
  await query(
    'UPDATE content_items SET generation_status = $1, current_operation = $2, generation_error = NULL WHERE id = $3', 
    ['generating_audio', 'queued', contentId]
  );

  // Trigger processor (fire-and-forget)
  processAudioQueue();
}

/**
 * The Queue Processor. Runs jobs sequentially.
 */
async function processAudioQueue() {
  if (isProcessingQueue) return;
  isProcessingQueue = true;

  try {
    while (audioQueue.length > 0) {
      const contentId = audioQueue.shift();
      if (!contentId) continue;

      try {
        console.log(`[TTS-Queue] Starting job for content ${contentId}...`);
        
        // Update DB status to 'processing'
        await query(
          'UPDATE content_items SET current_operation = $1 WHERE id = $2', 
          ['processing_audio', contentId]
        );

        // Run the heavy job
        await generateAudioForContent(contentId);
        
        console.log(`[TTS-Queue] Job for content ${contentId} completed successfully.`);
        
      } catch (error: any) {
        console.error(`[TTS-Queue] Job for content ${contentId} failed:`, error);
        
        // Update DB with failure
        await query(
          'UPDATE content_items SET generation_status = $1, generation_error = $2, current_operation = NULL WHERE id = $3',
          ['failed', error.message || 'Unknown error', contentId]
        );
      }
    }
  } finally {
    isProcessingQueue = false;
  }
}

// --- INTERNAL WORKER FUNCTIONS ---

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
    const lastPeriod = chunk.lastIndexOf('.');
    const lastQuestion = chunk.lastIndexOf('?');
    const lastExclamation = chunk.lastIndexOf('!');
    const lastSentenceEnd = Math.max(lastPeriod, lastQuestion, lastExclamation);

    if (lastSentenceEnd > maxLength * 0.5) {
      chunkEnd = currentPos + lastSentenceEnd + 1;
    } else {
      const lastSpace = chunk.lastIndexOf(' ');
      if (lastSpace > 0) chunkEnd = currentPos + lastSpace + 1;
    }

    chunks.push(text.slice(currentPos, chunkEnd).trim());
    currentPos = chunkEnd;
  }

  return chunks;
}

function cleanHtmlForTTS(html: string): string {
  const dom = new JSDOM(html);
  const doc = dom.window.document;

  const removeSelectors = [
    'sup', 'sub', 'code', 'pre', 'table', 'img', 'figure', 'video', 'iframe',
    '.w-rich-text-figure-caption', 'figcaption', '.footnote', '.citation',
    'style', 'script', 'noscript'
  ];
  
  removeSelectors.forEach(sel => {
    doc.querySelectorAll(sel).forEach(el => el.remove());
  });

  // Basic block element spacing
  const blockElements = ['p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'br'];
  blockElements.forEach(tag => {
    doc.querySelectorAll(tag).forEach(el => {
      el.innerHTML = ` ${el.innerHTML} . `; 
    });
  });

  let text = doc.body.textContent || '';
  
  // Clean up whitespace and punctuation
  text = text
    .replace(/\s+/g, ' ')
    .replace(/\s+\./g, '.')
    .replace(/\.\./g, '.')
    .replace(/\[\d+\]/g, '') // remove reference numbers [1]
    .trim();

  return text;
}

/**
 * Robustly generates audio for a single article chunk.
 * Includes retries and validation.
 */
async function generateChunkWithRetry(
  openai: any, 
  text: string, 
  options: any, 
  chunkIndex: number, 
  totalChunks: number
): Promise<Buffer> {
  const MAX_RETRIES = 3;
  let attempt = 0;

  while (attempt < MAX_RETRIES) {
    try {
      attempt++;
      console.log(`[TTS] Generating chunk ${chunkIndex + 1}/${totalChunks} (Attempt ${attempt})...`);
      
      const mp3 = await openai.audio.speech.create({
        model: options.model,
        voice: options.voice,
        input: text,
        speed: options.speed,
      });

      const buffer = Buffer.from(await mp3.arrayBuffer());

      // Validation: Check for empty or dangerously small files (likely error responses)
      if (buffer.length < 100) {
        throw new Error(`Generated audio chunk is too small (${buffer.length} bytes)`);
      }

      return buffer;
    } catch (error: any) {
      console.warn(`[TTS] Chunk ${chunkIndex + 1} failed (Attempt ${attempt}): ${error.message}`);
      
      if (attempt === MAX_RETRIES) throw error;
      
      // Exponential backoff
      await new Promise(r => setTimeout(r, 1000 * attempt));
    }
  }
  throw new Error('Unreachable');
}

/**
 * Generates audio and returns both the Buffer and the Duration.
 */
async function generateArticleAudio(text: string, voiceId: string, speed: number, userId: number): Promise<{ buffer: Buffer, duration: number }> {
  const openai = getOpenAIClientForUser(userId);
  const defaults = await getTTSOptionsForUser(userId);
  
  // FIX: Construct a new object to avoid accessing missing properties on 'defaults'
  const options = {
    model: defaults.model,
    voice: voiceId || defaults.voice,
    speed: speed || 1.0 // Default to 1.0 since defaults doesn't have speed
  };

  const chunks = splitTextIntoChunks(text, 4000);
  const tempDir = getTempDir();
  const chunkFiles: string[] = [];
  
  console.log(`[TTS] Processing ${chunks.length} chunks...`);

  try {
    // 1. Generate all chunks
    for (let i = 0; i < chunks.length; i++) {
      // Use the retry wrapper
      const buffer = await generateChunkWithRetry(openai, chunks[i], options, i, chunks.length);
      
      const chunkPath = path.join(tempDir, `chunk_${Date.now()}_${i}.mp3`);
      await fs.writeFile(chunkPath, buffer);
      chunkFiles.push(chunkPath);
      
      // Update progress in DB
      const progress = Math.round(((i + 1) / chunks.length) * 100);
      await query('UPDATE content_items SET generation_progress = $1 WHERE generation_status = $2', [progress, 'generating_audio']);
    }

    // 2. Merge chunks using ffmpeg
    const outputFilename = `merged_${Date.now()}.mp3`;
    const outputPath = path.join(tempDir, outputFilename);

    console.log('[TTS] Merging chunks...');
    
    await new Promise<void>((resolve, reject) => {
      const command = ffmpeg();
      chunkFiles.forEach(file => command.input(file));
      
      command
        .on('error', (err) => reject(new Error(`FFmpeg merge error: ${err.message}`)))
        .on('end', () => resolve())
        .mergeToFile(outputPath, tempDir);
    });

    // FIX: Get duration from the file path string (not Buffer)
    const duration = await getAudioDuration(outputPath);
    
    // Read the file into a buffer to return it
    const finalBuffer = await fs.readFile(outputPath);

    // Cleanup
    await Promise.all([
      ...chunkFiles.map(f => fs.unlink(f).catch(() => {})),
      fs.unlink(outputPath).catch(() => {})
    ]);

    return { buffer: finalBuffer, duration };

  } catch (error) {
    // Cleanup on error
    chunkFiles.forEach(f => fs.unlink(f).catch(() => {}));
    throw error;
  }
}

/**
 * The actual worker function that does the heavy lifting.
 * Called by the queue processor.
 */
async function generateAudioForContent(contentId: number): Promise<void> {
  // 1. Fetch content
  const res = await query('SELECT * FROM content_items WHERE id = $1', [contentId]);
  if (res.rows.length === 0) throw new Error('Content not found');
  const content = res.rows[0];

  // 2. Prepare text
  let textToSpeak = cleanHtmlForTTS(content.content || '');

  // Add comments if available (limit to top 15)
  if (content.comments && content.comments.length > 0) {
    textToSpeak += " . Here are the top comments. ";
    const comments: Comment[] = content.comments.slice(0, 15);
    
    comments.forEach((comment) => {
      const cleanComment = cleanHtmlForTTS(comment.content);
      if (cleanComment.length > 20) {
        textToSpeak += ` ${comment.username} says: ${cleanComment} . `;
      }
    });
  }

  // 3. Generate Audio
  const { buffer: audioBuffer, duration: audioDuration } = await generateArticleAudio(
    textToSpeak, 
    content.voice_id || 'alloy', 
    content.playback_speed || 1.0, 
    content.user_id
  );

  const backendUrl = process.env.BACKEND_URL || `http://localhost:${process.env.PORT || 8080}`;
  const audioUrl = `${backendUrl}/api/content/${contentId}/audio`;

  // 4. Save Result
  await query(
    'UPDATE content_items SET audio_data = $1, audio_url = $2, duration = $3, file_size = $4, generation_status = $5, generation_progress = 100, current_operation = NULL WHERE id = $6',
    [audioBuffer, audioUrl, audioDuration, audioBuffer.length, 'completed', contentId]
  );

  console.log(`✓ Audio stored for content ${contentId}`);

  // 5. Trigger Transcription (Async)
  triggerTranscription(contentId, audioUrl, content.user_id);
}

// Separated transcription trigger so it doesn't block the audio queue
async function triggerTranscription(contentId: number, audioUrl: string, userId: number) {
  try {
    console.log('[TTS] Triggering auto-transcription...');
    await query('UPDATE content_items SET current_operation = $1 WHERE id = $2', ['transcribing', contentId]);

    const result = await transcribeWithTimestamps(audioUrl, userId);
    
    await query(
      'UPDATE content_items SET transcript = $1, transcript_words = $2, current_operation = NULL WHERE id = $3',
      [result.text, JSON.stringify(result.words), contentId]
    );
    console.log(`[TTS] Transcription saved for ${contentId}`);
  } catch (err) {
    console.error(`[TTS] Transcription failed for ${contentId}:`, err);
    // Don't mark content as failed, just clear the operation flag
    await query('UPDATE content_items SET current_operation = NULL WHERE id = $1', [contentId]);
  }
}
