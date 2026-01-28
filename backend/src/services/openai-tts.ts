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

export async function queueAudioGeneration(contentId: number): Promise<void> {
  if (audioQueue.includes(contentId)) {
    console.log(`[TTS-Queue] Content ${contentId} is already in the queue.`);
    return;
  }

  audioQueue.push(contentId);
  console.log(`[TTS-Queue] Added content ${contentId} to queue. Position: ${audioQueue.length}`);

  // Mark as 'queued'
  await query(
    'UPDATE content_items SET generation_status = $1, current_operation = $2, generation_error = NULL WHERE id = $3', 
    ['generating_audio', 'queued', contentId]
  );

  // Fire and forget processor
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
        
        await query(
          'UPDATE content_items SET current_operation = $1 WHERE id = $2', 
          ['processing_audio', contentId]
        );

        await generateAudioForContent(contentId);
        
        console.log(`[TTS-Queue] Job for content ${contentId} completed successfully.`);
        
      } catch (error: any) {
        console.error(`[TTS-Queue] Job for content ${contentId} failed:`, error);
        
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

  const blockElements = ['p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'br'];
  blockElements.forEach(tag => {
    doc.querySelectorAll(tag).forEach(el => {
      el.innerHTML = ` ${el.innerHTML} . `; 
    });
  });

  let text = doc.body.textContent || '';
  
  text = text
    .replace(/\s+/g, ' ')
    .replace(/\s+\./g, '.')
    .replace(/\.\./g, '.')
    .replace(/\[\d+\]/g, '')
    .trim();

  return text;
}

async function generateChunkWithRetry(
  openai: any, 
  apiOptions: any, // Pass the FULL options object
  chunkIndex: number, 
  totalChunks: number
): Promise<Buffer> {
  const MAX_RETRIES = 3;
  let attempt = 0;

  while (attempt < MAX_RETRIES) {
    try {
      attempt++;
      console.log(`[TTS] Generating chunk ${chunkIndex + 1}/${totalChunks} (Attempt ${attempt})...`);
      
      // Use options exactly as constructed
      const mp3 = await openai.audio.speech.create(apiOptions);

      const buffer = Buffer.from(await mp3.arrayBuffer());

      if (buffer.length < 100) {
        throw new Error(`Generated audio chunk is too small (${buffer.length} bytes)`);
      }

      return buffer;
    } catch (error: any) {
      console.warn(`[TTS] Chunk ${chunkIndex + 1} failed (Attempt ${attempt}): ${error.message}`);
      
      if (attempt === MAX_RETRIES) throw error;
      
      await new Promise(r => setTimeout(r, 1000 * attempt));
    }
  }
  throw new Error('Unreachable');
}

/**
 * Worker Logic - Replicates original parameter handling
 */
async function generateArticleAudio(text: string, voiceId: string, speed: number, userId: number): Promise<{ buffer: Buffer, duration: number }> {
  // 1. Await the providers (Crucial Fix)
  const openai = await getOpenAIClientForUser(userId);
  const dbOptions = await getTTSOptionsForUser(userId);

  // 2. Construct Options - SPREAD dbOptions to keep 'model' and other settings intact
  const apiOptions = {
    ...dbOptions, // This preserves the 'model' you set in settings
    input: text,  // Will be overwritten per chunk
  };

  // 3. Override only if specific values were passed
  if (voiceId) apiOptions.voice = voiceId;
  if (speed) apiOptions.speed = speed;

  // Log what we are using to be sure
  console.log(`[TTS] Configured with Model: ${apiOptions.model}, Voice: ${apiOptions.voice}`);

  const chunks = splitTextIntoChunks(text, 4000);
  const tempDir = getTempDir();
  const chunkFiles: string[] = [];
  
  console.log(`[TTS] Processing ${chunks.length} chunks...`);

  try {
    for (let i = 0; i < chunks.length; i++) {
      // Create a chunk-specific options object
      const chunkOptions = { ...apiOptions, input: chunks[i] };
      
      const buffer = await generateChunkWithRetry(openai, chunkOptions, i, chunks.length);
      
      const chunkPath = path.join(tempDir, `chunk_${Date.now()}_${i}.mp3`);
      await fs.writeFile(chunkPath, buffer);
      chunkFiles.push(chunkPath);
      
      const progress = Math.round(((i + 1) / chunks.length) * 100);
      await query('UPDATE content_items SET generation_progress = $1 WHERE generation_status = $2', [progress, 'generating_audio']);
    }

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

    const duration = await getAudioDuration(outputPath);
    const finalBuffer = await fs.readFile(outputPath);

    await Promise.all([
      ...chunkFiles.map(f => fs.unlink(f).catch(() => {})),
      fs.unlink(outputPath).catch(() => {})
    ]);

    return { buffer: finalBuffer, duration };

  } catch (error) {
    chunkFiles.forEach(f => fs.unlink(f).catch(() => {}));
    throw error;
  }
}

async function generateAudioForContent(contentId: number): Promise<void> {
  const res = await query('SELECT * FROM content_items WHERE id = $1', [contentId]);
  if (res.rows.length === 0) throw new Error('Content not found');
  const content = res.rows[0];

  let textToSpeak = cleanHtmlForTTS(content.content || '');

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

  const { buffer: audioBuffer, duration: audioDuration } = await generateArticleAudio(
    textToSpeak, 
    content.voice_id, 
    content.playback_speed, 
    content.user_id
  );

  const backendUrl = process.env.BACKEND_URL || `http://localhost:${process.env.PORT || 8080}`;
  const audioUrl = `${backendUrl}/api/content/${contentId}/audio`;

  await query(
    'UPDATE content_items SET audio_data = $1, audio_url = $2, duration = $3, file_size = $4, generation_status = $5, generation_progress = 100, current_operation = NULL WHERE id = $6',
    [audioBuffer, audioUrl, audioDuration, audioBuffer.length, 'completed', contentId]
  );

  console.log(`✓ Audio stored for content ${contentId}`);

  triggerTranscription(contentId, audioUrl, content.user_id);
}

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
    await query('UPDATE content_items SET current_operation = NULL WHERE id = $1', [contentId]);
  }
}
