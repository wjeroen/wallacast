import fetch from 'node-fetch';
import fs from 'fs/promises';
import { createReadStream, createWriteStream } from 'fs';
import { pipeline } from 'stream/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import ffmpeg from 'fluent-ffmpeg';
import { getAudioDuration } from './audio-utils.js';
import { getTranscriptionClientForUser } from './ai-providers.js'; // CHANGED: Import hybrid router

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Compress audio file to reduce size for API limits
async function compressAudio(inputPath: string, outputPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .audioChannels(1) // Convert to mono
      .audioBitrate('64k') // 64kbps is sufficient for speech recognition
      .audioFrequency(16000) // 16kHz sample rate (speech quality)
      .format('mp3')
      .on('end', () => {
        console.log('Audio compression complete');
        resolve();
      })
      .on('error', (err) => {
        console.error('Audio compression error:', err);
        reject(err);
      })
      .save(outputPath);
  });
}

// Split audio file into chunks of specified duration
async function splitAudioIntoChunks(
  inputPath: string,
  chunkDurationMinutes: number
): Promise<string[]> {
  const duration = await getAudioDuration(inputPath);
  const chunkDurationSeconds = chunkDurationMinutes * 60;
  const numChunks = Math.ceil(duration / chunkDurationSeconds);

  console.log(`Audio duration: ${(duration / 60).toFixed(1)} minutes, splitting into ${numChunks} chunks`);

  const chunkFiles: string[] = [];

  for (let i = 0; i < numChunks; i++) {
    const startTime = i * chunkDurationSeconds;
    const chunkPath = inputPath.replace('.mp3', `_chunk_${i}.mp3`);

    await new Promise<void>((resolve, reject) => {
      ffmpeg(inputPath)
        .setStartTime(startTime)
        .setDuration(chunkDurationSeconds)
        .audioChannels(1) // Compress while splitting
        .audioBitrate('64k')
        .audioFrequency(16000)
        .format('mp3')
        .on('end', () => {
          console.log(`Chunk ${i + 1}/${numChunks} created`);
          resolve();
        })
        .on('error', (err) => {
          console.error(`Error creating chunk ${i}:`, err);
          reject(err);
        })
        .save(chunkPath);
    });

    chunkFiles.push(chunkPath);
  }

  return chunkFiles;
}

export async function transcribeWithTimestamps(audioUrl: string, userId: number): Promise<{
  text: string;
  words: Array<{ word: string; start: number; end: number }>;
}> {
  try {
    // CHANGED: Use the smart router that picks OpenAI or DeepInfra
    const provider = await getTranscriptionClientForUser(userId);
    
    if (!provider) {
      throw new Error('No API key set. Please configure OpenAI or DeepInfra in Settings.');
    }

    const { client, model } = provider; // Destructure the client and the correct model ID

    const tempDir = path.join(process.cwd(), 'temp');
    await fs.mkdir(tempDir, { recursive: true });

    const audioFilename = `audio_${Date.now()}.mp3`;
    const audioPath = path.join(tempDir, audioFilename);

    console.log(`[Transcription] Downloading audio from ${audioUrl}...`);
    const response = await fetch(audioUrl);

    if (!response.ok) {
      throw new Error(`Failed to download audio: ${response.statusText}`);
    }

    if (!response.body) {
      throw new Error('No response body from audio URL');
    }

    // Stream download to disk
    await pipeline(response.body, createWriteStream(audioPath));

    const fileStats = await fs.stat(audioPath);
    const fileSizeMB = fileStats.size / (1024 * 1024);
    const tempFiles: string[] = [audioPath];

    let transcriptText = '';
    let allWords: any[] = [];

    // Handle large files with splitting
    if (fileSizeMB > 25) {
      console.log(`File exceeds 25 MB limit (${fileSizeMB.toFixed(2)} MB), splitting...`);

      const chunkFiles = await splitAudioIntoChunks(audioPath, 15);
      tempFiles.push(...chunkFiles);

      let previousTranscript = '';
      let timeOffset = 0;

      for (let i = 0; i < chunkFiles.length; i++) {
        console.log(`Transcribing chunk ${i + 1}/${chunkFiles.length} using model ${model}...`);

        const transcription = await client.audio.transcriptions.create({
          file: createReadStream(chunkFiles[i]),
          model: model, // DYNAMIC MODEL ID (whisper-1 OR openai/whisper-large-v3-turbo)
          response_format: 'verbose_json',
          timestamp_granularities: ['word'],
          prompt: previousTranscript.slice(-224),
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

        timeOffset += 900;
      }
    } else {
      // Small file
      let fileToTranscribe = audioPath;

      if (fileSizeMB > 20) {
        console.log('File close to 25 MB limit, compressing as precaution...');
        const compressedPath = audioPath.replace('.mp3', '_compressed.mp3');
        await compressAudio(audioPath, compressedPath);
        fileToTranscribe = compressedPath;
        tempFiles.push(compressedPath);
      }

      console.log(`Transcribing file using model ${model}...`);
      const transcription = await client.audio.transcriptions.create({
        file: createReadStream(fileToTranscribe),
        model: model, // DYNAMIC MODEL ID
        response_format: 'verbose_json',
        timestamp_granularities: ['word'],
      });

      transcriptText = transcription.text;
      allWords = (transcription as any).words || [];
    }

    // Clean up
    for (const tempFile of tempFiles) {
      await fs.unlink(tempFile).catch(console.error);
    }

    return {
      text: transcriptText,
      words: allWords,
    };
  } catch (error) {
    console.error('Error transcribing with timestamps:', error);
    throw error;
  }
}
