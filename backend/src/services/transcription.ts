import OpenAI from 'openai';
import fetch from 'node-fetch';
import fs from 'fs/promises';
import { createReadStream, createWriteStream } from 'fs';
import { pipeline } from 'stream/promises';
import path from 'path';
import { fileURLToPath } from 'url';
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

    // OpenAI Whisper API has a 25 MB file size limit
    if (fileSizeMB > 25) {
      await fs.unlink(audioPath).catch(console.error);
      throw new Error(`Audio file is too large (${fileSizeMB.toFixed(1)} MB). OpenAI Whisper API has a 25 MB limit. Please try a shorter episode.`);
    }

    console.log('Transcribing audio...');

    // Transcribe using OpenAI Whisper
    const transcription = await openai.audio.transcriptions.create({
      file: createReadStream(audioPath),
      model: 'gpt-4o-mini-transcribe',
      response_format: 'verbose_json',
      timestamp_granularities: ['word'],
    });

    // Clean up temp file
    await fs.unlink(audioPath).catch(console.error);

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

    const transcription = await openai.audio.transcriptions.create({
      file: createReadStream(audioPath),
      model: 'gpt-4o-mini-transcribe',
      response_format: 'verbose_json',
      timestamp_granularities: ['word'],
    });

    await fs.unlink(audioPath).catch(console.error);

    return {
      text: transcription.text,
      words: (transcription as any).words || [],
    };
  } catch (error) {
    console.error('Error transcribing with timestamps:', error);
    throw error;
  }
}
