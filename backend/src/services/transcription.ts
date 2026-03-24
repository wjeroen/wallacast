import fetch from 'node-fetch';
import fs from 'fs/promises';
import { createReadStream, createWriteStream } from 'fs';
import { pipeline } from 'stream/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import ffmpeg from 'fluent-ffmpeg';
import { getAudioDuration } from './audio-utils.js';
import { getTranscriptionClientForUser } from './ai-providers.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function compressAudio(inputPath: string, outputPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .audioChannels(1)
      .audioBitrate('64k')
      .audioFrequency(16000)
      .format('mp3')
      .on('end', () => resolve())
      .on('error', reject)
      .save(outputPath);
  });
}

async function splitAudioIntoChunks(inputPath: string, chunkDurationMinutes: number): Promise<string[]> {
  const duration = await getAudioDuration(inputPath);
  const chunkDurationSeconds = chunkDurationMinutes * 60;
  const numChunks = Math.ceil(duration / chunkDurationSeconds);
  const chunkFiles: string[] = [];
  
  for (let i = 0; i < numChunks; i++) {
    const startTime = i * chunkDurationSeconds;
    const chunkPath = inputPath.replace('.mp3', `_chunk_${i}.mp3`);
    await new Promise<void>((resolve, reject) => {
      ffmpeg(inputPath)
        .setStartTime(startTime)
        .setDuration(chunkDurationSeconds)
        .audioChannels(1)
        .audioBitrate('64k')
        .audioFrequency(16000)
        .format('mp3')
        .on('end', () => resolve())
        .on('error', reject)
        .save(chunkPath);
    });
    chunkFiles.push(chunkPath);
  }
  return chunkFiles;
}

// Retry a chunk API call on network errors (ECONNRESET, socket hang up, etc.)
// Waits 2s, 4s, 8s between attempts. Throws immediately on non-network errors (e.g. auth failures).
async function withChunkRetry<T>(fn: () => Promise<T>, chunkLabel: string, maxRetries = 3): Promise<T> {
  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    try {
      return await fn();
    } catch (error: any) {
      const isNetworkError =
        error?.code === 'ECONNRESET' ||
        error?.cause?.code === 'ECONNRESET' ||
        error?.cause?.type === 'system' ||
        error?.constructor?.name === 'APIConnectionError' ||
        (typeof error?.message === 'string' && /connection|socket hang up|network/i.test(error.message));

      if (!isNetworkError || attempt > maxRetries) {
        console.error(`${chunkLabel} failed after ${attempt} attempt(s), giving up.`);
        throw error;
      }

      const delayMs = Math.pow(2, attempt) * 1000; // 2s, 4s, 8s
      console.log(`${chunkLabel} network error (${error?.cause?.code || error?.message}), retrying in ${delayMs / 1000}s (attempt ${attempt}/${maxRetries})...`);
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
  // TypeScript requires this but the loop always returns or throws
  throw new Error('Unreachable');
}

export async function transcribeWithTimestamps(
  audioSource: string | Buffer,
  userId: number,
  initialPrompt?: string
): Promise<{
  text: string;
  words: Array<{ word: string; start: number; end: number }>;
}> {
  // Declare outside try so finally can clean up even if transcription fails
  const tempFiles: string[] = [];

  try {
    const provider = await getTranscriptionClientForUser(userId);
    if (!provider) throw new Error('No API key set. Please configure OpenAI or DeepInfra in Settings.');

    const { client, model } = provider;

    const tempDir = path.join(process.cwd(), 'temp');
    await fs.mkdir(tempDir, { recursive: true });

    const audioFilename = `audio_transcribe_${Date.now()}.mp3`;
    const audioPath = path.join(tempDir, audioFilename);

    if (Buffer.isBuffer(audioSource)) {
      // Audio buffer passed directly — write to temp file (avoids HTTP round-trip)
      console.log(`[Transcription] Writing audio buffer (${(audioSource.length / 1024 / 1024).toFixed(1)} MB) to temp file...`);
      await fs.writeFile(audioPath, audioSource);
    } else {
      // URL passed — download it (legacy path, used for podcast transcription)
      console.log(`[Transcription] Downloading audio from ${audioSource}...`);
      const response = await fetch(audioSource);
      if (!response.ok) throw new Error(`Failed to download audio: ${response.statusText}`);
      if (!response.body) throw new Error('No response body');
      await pipeline(response.body, createWriteStream(audioPath));
    }

    const fileStats = await fs.stat(audioPath);
    const fileSizeMB = fileStats.size / (1024 * 1024);
    tempFiles.push(audioPath);

    let transcriptText = '';
    let allWords: any[] = [];
    
    // Hint for Whisper to improve accuracy.
    // We allow a larger slice (1000 chars) for the initial prompt to capture headers/metadata.
    let previousTranscript = initialPrompt ? initialPrompt.slice(0, 1000) : '';

    if (fileSizeMB > 25) {
      console.log(`File exceeds 25 MB limit (${fileSizeMB.toFixed(2)} MB), splitting...`);
      const chunkFiles = await splitAudioIntoChunks(audioPath, 15);
      tempFiles.push(...chunkFiles);

      let timeOffset = 0;
      for (let i = 0; i < chunkFiles.length; i++) {
        // Get actual chunk duration instead of assuming hardcoded 900s.
        // FFmpeg splitting may not produce exactly chunkDurationMinutes * 60
        // due to MP3 frame alignment at the split boundary.
        const chunkDuration = await getAudioDuration(chunkFiles[i]);
        console.log(`Transcribing chunk ${i + 1}/${chunkFiles.length} (${chunkDuration.toFixed(1)}s) using model ${model}...`);

        // HYBRID PROMPT STRATEGY:
        // 1. Chunk 1: Use the full initialPrompt to establish names/context.
        // 2. Chunk 2+: Combine the Metadata (first 600 chars) with Continuity (last 200 chars).
        let currentPrompt = previousTranscript;
        
        if (i > 0 && initialPrompt) {
            // Take the Metadata (Title, Author, Comments) from the start
            const metadataPart = initialPrompt.slice(0, 600);
            // Take the Continuity (last few sentences) from the actual previous text
            const continuityPart = previousTranscript.slice(-200);
            currentPrompt = `${metadataPart} ... ${continuityPart}`;
        }

        const transcription = await withChunkRetry(
          () => client.audio.transcriptions.create({
            file: createReadStream(chunkFiles[i]),
            model: model,
            response_format: 'verbose_json',
            timestamp_granularities: ['word'],
            prompt: currentPrompt,
          }),
          `Chunk ${i + 1}/${chunkFiles.length}`
        );

        transcriptText += (i > 0 ? ' ' : '') + transcription.text;
        previousTranscript = transcription.text;

        const chunkWords = (transcription as any).words || [];
        const adjustedWords = chunkWords.map((word: any) => ({
          ...word,
          start: word.start + timeOffset,
          end: word.end + timeOffset,
        }));
        allWords.push(...adjustedWords);
        timeOffset += chunkDuration;
      }
    } else {
      let fileToTranscribe = audioPath;
      if (fileSizeMB > 20) {
        console.log('Compressing large file...');
        const compressedPath = audioPath.replace('.mp3', '_compressed.mp3');
        await compressAudio(audioPath, compressedPath);
        fileToTranscribe = compressedPath;
        tempFiles.push(compressedPath);
      }

      console.log(`Transcribing file using model ${model}...`);
      const transcription = await withChunkRetry(
        () => client.audio.transcriptions.create({
          file: createReadStream(fileToTranscribe),
          model: model,
          response_format: 'verbose_json',
          timestamp_granularities: ['word'],
          prompt: previousTranscript,
        }),
        'Single file'
      );

      transcriptText = transcription.text;
      allWords = (transcription as any).words || [];
    }

    return { text: transcriptText, words: allWords };
  } catch (error) {
    console.error('Error transcribing:', error);
    throw error;
  } finally {
    // Cleanup temp files regardless of success or failure
    for (const f of tempFiles) await fs.unlink(f).catch(() => {});
  }
}
