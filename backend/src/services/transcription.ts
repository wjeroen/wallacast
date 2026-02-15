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

export async function transcribeWithTimestamps(
  audioUrl: string, 
  userId: number,
  initialPrompt?: string
): Promise<{
  text: string;
  words: Array<{ word: string; start: number; end: number }>;
}> {
  try {
    const provider = await getTranscriptionClientForUser(userId);
    if (!provider) throw new Error('No API key set. Please configure OpenAI or DeepInfra in Settings.');

    const { client, model } = provider;

    const tempDir = path.join(process.cwd(), 'temp');
    await fs.mkdir(tempDir, { recursive: true });

    const audioFilename = `audio_transcribe_${Date.now()}.mp3`;
    const audioPath = path.join(tempDir, audioFilename);

    console.log(`[Transcription] Downloading audio from ${audioUrl}...`);
    const response = await fetch(audioUrl);
    if (!response.ok) throw new Error(`Failed to download audio: ${response.statusText}`);
    if (!response.body) throw new Error('No response body');

    await pipeline(response.body, createWriteStream(audioPath));
    const fileStats = await fs.stat(audioPath);
    const fileSizeMB = fileStats.size / (1024 * 1024);
    const tempFiles: string[] = [audioPath];

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

        const transcription = await client.audio.transcriptions.create({
          file: createReadStream(chunkFiles[i]),
          model: model,
          response_format: 'verbose_json',
          timestamp_granularities: ['word'],
          prompt: currentPrompt,
        });

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
      const transcription = await client.audio.transcriptions.create({
        file: createReadStream(fileToTranscribe),
        model: model,
        response_format: 'verbose_json',
        timestamp_granularities: ['word'],
        prompt: previousTranscript,
      });

      transcriptText = transcription.text;
      allWords = (transcription as any).words || [];
    }

    // Cleanup
    for (const f of tempFiles) await fs.unlink(f).catch(console.error);

    return { text: transcriptText, words: allWords };
  } catch (error) {
    console.error('Error transcribing:', error);
    throw error;
  }
}
