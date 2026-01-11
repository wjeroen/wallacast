import OpenAI from 'openai';
import fetch from 'node-fetch';
import fs from 'fs/promises';
import { createReadStream } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { query } from '../database/db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Lazy initialization - only create OpenAI client when needed
async function getOpenAIClient(): Promise<OpenAI | null> {
  // First try environment variable
  if (process.env.OPENAI_API_KEY) {
    return new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    });
  }

  // Then try settings table
  try {
    const result = await query('SELECT value FROM settings WHERE key = $1', ['OPENAI_API_KEY']);
    if (result.rows.length > 0 && result.rows[0].value) {
      return new OpenAI({
        apiKey: result.rows[0].value,
      });
    }
  } catch (error) {
    console.error('Error fetching API key from settings:', error);
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
    const buffer = await response.arrayBuffer();
    await fs.writeFile(audioPath, Buffer.from(buffer));

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
    const buffer = await response.arrayBuffer();
    await fs.writeFile(audioPath, Buffer.from(buffer));

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
