import OpenAI from 'openai';
import fetch from 'node-fetch';
import fs from 'fs/promises';
import { createReadStream, createWriteStream } from 'fs';
import { pipeline } from 'stream/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import ffmpeg from 'fluent-ffmpeg';
import { query } from '../database/db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Get OpenAI client from environment variable only (for security)
async function getOpenAIClient(): Promise<OpenAI | null> {
  if (process.env.OPENAI_API_KEY) {
    return new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    });
  }

  return null;
}

// Compress audio file to reduce size for OpenAI API limits
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

// Get audio duration in seconds
async function getAudioDuration(filePath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) {
        reject(err);
      } else {
        resolve(metadata.format.duration || 0);
      }
    });
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
  const tempDir = path.dirname(inputPath);

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

export async function transcribeAudio(audioUrl: string): Promise<string> {
  try {
    const openai = await getOpenAIClient();
    if (!openai) {
      console.warn('OpenAI API key not set, returning dummy transcript');
      return 'Transcript not available. Please set your OpenAI API key in Settings.';
    }

    // Download audio file
    const tempDir = path.join(process.cwd(), 'temp');
    await fs.mkdir(tempDir, { recursive: true });

    const audioFilename = `audio_${Date.now()}.mp3`;
    const audioPath = path.join(tempDir, audioFilename);

    console.log('Downloading audio from:', audioUrl);
    const response = await fetch(audioUrl);

    if (!response.ok) {
      throw new Error(`Failed to download audio: ${response.statusText}`);
    }

    if (!response.body) {
      throw new Error('No response body from audio URL');
    }

    // Stream download to disk instead of loading into memory
    await pipeline(response.body, createWriteStream(audioPath));

    const fileStats = await fs.stat(audioPath);
    const fileSizeMB = fileStats.size / (1024 * 1024);
    console.log('Audio downloaded, file size:', fileSizeMB.toFixed(2), 'MB');

    let transcriptText = '';
    const tempFiles: string[] = [audioPath];

    // OpenAI Whisper API has a 25 MB file size limit
    if (fileSizeMB > 25) {
      console.log(`File exceeds 25 MB limit, splitting into chunks...`);

      // Split into 15-minute chunks (should be well under 25 MB after compression)
      const chunkFiles = await splitAudioIntoChunks(audioPath, 15);
      tempFiles.push(...chunkFiles);

      // Transcribe each chunk with context from previous chunk
      let previousTranscript = '';
      for (let i = 0; i < chunkFiles.length; i++) {
        console.log(`Transcribing chunk ${i + 1}/${chunkFiles.length}...`);

        const chunkStats = await fs.stat(chunkFiles[i]);
        const chunkSizeMB = chunkStats.size / (1024 * 1024);
        console.log(`Chunk ${i + 1} size: ${chunkSizeMB.toFixed(2)} MB`);

        // Use previous transcript as context for continuity
        const transcription = await openai.audio.transcriptions.create({
          file: createReadStream(chunkFiles[i]),
          model: 'gpt-4o-mini-transcribe',
          prompt: previousTranscript.slice(-224), // Last 224 chars for context (Whisper limit)
        });

        transcriptText += (i > 0 ? ' ' : '') + transcription.text;
        previousTranscript = transcription.text;
      }

      console.log(`Transcription complete: ${chunkFiles.length} chunks, ${transcriptText.length} chars`);
    } else {
      // File is small enough - transcribe directly (with compression if needed)
      let fileToTranscribe = audioPath;

      if (fileSizeMB > 20) {
        // Close to limit, compress just in case
        console.log('File close to 25 MB limit, compressing as precaution...');
        const compressedPath = audioPath.replace('.mp3', '_compressed.mp3');
        await compressAudio(audioPath, compressedPath);
        fileToTranscribe = compressedPath;
        tempFiles.push(compressedPath);
      }

      console.log('Transcribing audio...');
      const transcription = await openai.audio.transcriptions.create({
        file: createReadStream(fileToTranscribe),
        model: 'whisper-1', // whisper-1 supports verbose_json and word timestamps
        response_format: 'verbose_json',
        timestamp_granularities: ['word'],
      });

      transcriptText = transcription.text;
    }

    // Clean up all temp files
    for (const tempFile of tempFiles) {
      await fs.unlink(tempFile).catch(console.error);
    }

    return transcriptText;
  } catch (error) {
    console.error('Error transcribing audio:', error);
    throw new Error('Failed to transcribe audio');
  }
}

export async function transcribeWithTimestamps(audioUrl: string): Promise<{
  text: string;
  words: Array<{ word: string; start: number; end: number }>;
}> {
  try {
    const openai = await getOpenAIClient();
    if (!openai) {
      throw new Error('OpenAI API key not set. Please set your OpenAI API key in Settings.');
    }

    const tempDir = path.join(process.cwd(), 'temp');
    await fs.mkdir(tempDir, { recursive: true });

    const audioFilename = `audio_${Date.now()}.mp3`;
    const audioPath = path.join(tempDir, audioFilename);

    const response = await fetch(audioUrl);

    if (!response.ok) {
      throw new Error(`Failed to download audio: ${response.statusText}`);
    }

    if (!response.body) {
      throw new Error('No response body from audio URL');
    }

    // Stream download to disk instead of loading into memory
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
        console.log(`Transcribing chunk ${i + 1}/${chunkFiles.length}...`);

        const transcription = await openai.audio.transcriptions.create({
          file: createReadStream(chunkFiles[i]),
          model: 'whisper-1', // whisper-1 supports verbose_json and word timestamps
          response_format: 'verbose_json',
          timestamp_granularities: ['word'],
          prompt: previousTranscript.slice(-224),
        });

        transcriptText += (i > 0 ? ' ' : '') + transcription.text;
        previousTranscript = transcription.text;

        // Adjust word timestamps to account for chunk offset
        const chunkWords = (transcription as any).words || [];
        const adjustedWords = chunkWords.map((word: any) => ({
          ...word,
          start: word.start + timeOffset,
          end: word.end + timeOffset,
        }));
        allWords.push(...adjustedWords);

        // Update time offset for next chunk (15 minutes = 900 seconds)
        timeOffset += 900;
      }
    } else {
      // File is small enough - transcribe directly (with compression if needed)
      let fileToTranscribe = audioPath;

      if (fileSizeMB > 20) {
        console.log('File close to 25 MB limit, compressing as precaution...');
        const compressedPath = audioPath.replace('.mp3', '_compressed.mp3');
        await compressAudio(audioPath, compressedPath);
        fileToTranscribe = compressedPath;
        tempFiles.push(compressedPath);
      }

      const transcription = await openai.audio.transcriptions.create({
        file: createReadStream(fileToTranscribe),
        model: 'whisper-1', // whisper-1 supports verbose_json and word timestamps
        response_format: 'verbose_json',
        timestamp_granularities: ['word'],
      });

      transcriptText = transcription.text;
      allWords = (transcription as any).words || [];
    }

    // Clean up all temp files
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
