import OpenAI from 'openai';
import fetch from 'node-fetch';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

export async function transcribeAudio(audioUrl: string): Promise<string> {
  try {
    if (!process.env.OPENAI_API_KEY) {
      console.warn('OpenAI API key not set, returning dummy transcript');
      return 'Transcript not available. Please set OPENAI_API_KEY environment variable.';
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
      file: await fs.open(audioPath, 'r'),
      model: 'whisper-1',
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
    if (!process.env.OPENAI_API_KEY) {
      throw new Error('OpenAI API key not set');
    }

    const tempDir = path.join(process.cwd(), 'temp');
    await fs.mkdir(tempDir, { recursive: true });

    const audioFilename = `audio_${Date.now()}.mp3`;
    const audioPath = path.join(tempDir, audioFilename);

    const response = await fetch(audioUrl);
    const buffer = await response.arrayBuffer();
    await fs.writeFile(audioPath, Buffer.from(buffer));

    const transcription = await openai.audio.transcriptions.create({
      file: await fs.open(audioPath, 'r'),
      model: 'whisper-1',
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
