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

    let fileToTranscribe = audioPath;
    let compressedPath: string | null = null;

    // OpenAI Whisper API has a 25 MB file size limit - compress if needed
    if (fileSizeMB > 25) {
      console.log(`File exceeds 25 MB limit, compressing audio...`);
      compressedPath = audioPath.replace('.mp3', '_compressed.mp3');
      await compressAudio(audioPath, compressedPath);

      const compressedStats = await fs.stat(compressedPath);
      const compressedSizeMB = compressedStats.size / (1024 * 1024);
      console.log('Compressed file size:', compressedSizeMB.toFixed(2), 'MB');

      if (compressedSizeMB > 25) {
        // Still too large even after compression - this is a very long episode
        await fs.unlink(audioPath).catch(console.error);
        await fs.unlink(compressedPath).catch(console.error);
        throw new Error(`Audio file is too large even after compression (${compressedSizeMB.toFixed(1)} MB). This episode is too long to transcribe.`);
      }

      fileToTranscribe = compressedPath;
    }

    console.log('Transcribing audio...');

    // Transcribe using OpenAI Whisper
    const transcription = await openai.audio.transcriptions.create({
      file: createReadStream(fileToTranscribe),
      model: 'gpt-4o-mini-transcribe',
      response_format: 'verbose_json',
      timestamp_granularities: ['word'],
    });

    // Clean up temp files
    await fs.unlink(audioPath).catch(console.error);
    if (compressedPath) {
      await fs.unlink(compressedPath).catch(console.error);
    }

    return transcription.text;
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

    let fileToTranscribe = audioPath;
    let compressedPath: string | null = null;

    // Compress if file exceeds 25 MB limit
    if (fileSizeMB > 25) {
      console.log(`File exceeds 25 MB limit (${fileSizeMB.toFixed(2)} MB), compressing...`);
      compressedPath = audioPath.replace('.mp3', '_compressed.mp3');
      await compressAudio(audioPath, compressedPath);

      const compressedStats = await fs.stat(compressedPath);
      const compressedSizeMB = compressedStats.size / (1024 * 1024);
      console.log('Compressed file size:', compressedSizeMB.toFixed(2), 'MB');

      if (compressedSizeMB > 25) {
        await fs.unlink(audioPath).catch(console.error);
        await fs.unlink(compressedPath).catch(console.error);
        throw new Error(`Audio file is too large even after compression (${compressedSizeMB.toFixed(1)} MB).`);
      }

      fileToTranscribe = compressedPath;
    }

    const transcription = await openai.audio.transcriptions.create({
      file: createReadStream(fileToTranscribe),
      model: 'gpt-4o-mini-transcribe',
      response_format: 'verbose_json',
      timestamp_granularities: ['word'],
    });

    await fs.unlink(audioPath).catch(console.error);
    if (compressedPath) {
      await fs.unlink(compressedPath).catch(console.error);
    }

    return {
      text: transcription.text,
      words: (transcription as any).words || [],
    };
  } catch (error) {
    console.error('Error transcribing with timestamps:', error);
    throw error;
  }
}
