import fetch from 'node-fetch';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || 'EXAVITQu4vr4xnSDxMaL'; // Default voice

export async function generateTTS(text: string): Promise<string> {
  try {
    if (!ELEVENLABS_API_KEY) {
      console.warn('ElevenLabs API key not set, returning dummy audio URL');
      return '/audio/dummy.mp3';
    }

    // Split text into chunks if too long (ElevenLabs has character limits)
    const chunks = splitTextIntoChunks(text, 5000);
    const audioFiles: string[] = [];

    for (let i = 0; i < chunks.length; i++) {
      const audioUrl = await generateTTSChunk(chunks[i], i);
      audioFiles.push(audioUrl);
    }

    // If multiple chunks, we'd need to concatenate them
    // For now, return the first one or implement audio concatenation
    return audioFiles[0];
  } catch (error) {
    console.error('Error generating TTS:', error);
    throw new Error('Failed to generate TTS');
  }
}

async function generateTTSChunk(text: string, index: number): Promise<string> {
  const response = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}`,
    {
      method: 'POST',
      headers: {
        'Accept': 'audio/mpeg',
        'Content-Type': 'application/json',
        'xi-api-key': ELEVENLABS_API_KEY!,
      },
      body: JSON.stringify({
        text,
        model_id: 'eleven_monolingual_v1',
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.5,
        },
      }),
    }
  );

  if (!response.ok) {
    throw new Error(`ElevenLabs API error: ${response.statusText}`);
  }

  // Save audio file
  const audioDir = path.join(process.cwd(), 'public', 'audio');
  await fs.mkdir(audioDir, { recursive: true });

  const filename = `tts_${Date.now()}_${index}.mp3`;
  const filepath = path.join(audioDir, filename);

  const buffer = await response.arrayBuffer();
  await fs.writeFile(filepath, Buffer.from(buffer));

  // Construct full URL for audio file
  const backendUrl = process.env.BACKEND_URL || process.env.RAILWAY_PUBLIC_DOMAIN
    ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
    : 'http://localhost:3001';
  return `${backendUrl}/audio/${filename}`;
}

function splitTextIntoChunks(text: string, maxLength: number): string[] {
  const chunks: string[] = [];
  const sentences = text.match(/[^.!?]+[.!?]+/g) || [text];

  let currentChunk = '';

  for (const sentence of sentences) {
    if ((currentChunk + sentence).length > maxLength) {
      if (currentChunk) {
        chunks.push(currentChunk.trim());
      }
      currentChunk = sentence;
    } else {
      currentChunk += sentence;
    }
  }

  if (currentChunk) {
    chunks.push(currentChunk.trim());
  }

  return chunks;
}
