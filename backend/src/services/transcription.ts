import fetch from 'node-fetch';
import fs from 'fs/promises';
import { createReadStream, createWriteStream } from 'fs';
import { pipeline } from 'stream/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import ffmpeg from 'fluent-ffmpeg';
import { getAudioDuration } from './audio-utils.js';
import { getTranscriptionClientForUser, type TranscriptionConfig } from './ai-providers.js';
import { PROCESSING_CONFIG } from '../config/processing.js';
import { getTempDir } from '../config/storage.js';

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

// Normalized per-file transcription result (word shape matches what read-along/DB expect).
type ChunkResult = { text: string; words: Array<{ word: string; start: number; end: number }> };

// Anti-hallucination safety params for DeepInfra's NATIVE Whisper endpoint (v1).
// condition_on_previous_text=false is the headline fix: it stops Whisper from re-reading its own
// (possibly repetitive) output for the previous 30s window and snowballing into "even. even. even."
// loops. The threshold params are Whisper defaults (only bite if DeepInfra runs the temperature
// fallback loop, harmless no-ops otherwise). vad / no_repeat_ngram_size are deliberately NOT set
// yet, they're staged follow-ups so we can measure each knob's effect independently.
const DEEPINFRA_WHISPER_PARAMS: Record<string, string> = {
  // Read-along needs per-word timestamps. The native endpoint defaults word_timestamps=false and
  // chunk_level=segment, which returns segment-level text only (no per-word timing). That broke
  // read-along. chunk_level=word is the switch that emits word-level output, word_timestamps=true
  // asks each word to carry start/end. The response can put words at the top level OR nested inside
  // segments[].words, so extractDeepInfraWords() below reads both.
  chunk_level: 'word',
  word_timestamps: 'true',
  condition_on_previous_text: 'false',
  temperature: '0',
  compression_ratio_threshold: '2.4',
  logprob_threshold: '-1',
  no_speech_threshold: '0.6',
};

// Pull per-word timestamps out of a DeepInfra native response, wherever they live:
// (1) a top-level `words` array, or (2) nested under each `segments[].words`. Word objects may use
// `word` or `text` for the token. Returns [] if the response carries no real per-word timing.
function extractDeepInfraWords(json: any): ChunkResult['words'] {
  const norm = (w: any) => ({ word: w.word ?? w.text ?? '', start: Number(w.start), end: Number(w.end) });
  const valid = (w: { start: number; end: number }) => Number.isFinite(w.start) && Number.isFinite(w.end);

  if (Array.isArray(json?.words) && json.words.length > 0) {
    return json.words.map(norm).filter(valid);
  }
  if (Array.isArray(json?.segments)) {
    const nested: any[] = [];
    for (const seg of json.segments) {
      if (Array.isArray(seg?.words) && seg.words.length > 0) nested.push(...seg.words);
    }
    if (nested.length > 0) return nested.map(norm).filter(valid);
  }
  return [];
}

// Fallback: if the native response ever lacks per-word timestamps, spread each segment's words
// evenly across the segment's [start, end] span so read-along still works (approximately) instead
// of breaking entirely. This is timing interpolation WITHIN a known segment, not content-transcript
// matching, so it does not violate the "no fuzzy alignment" rule.
function wordsFromSegments(segments: any[]): ChunkResult['words'] {
  const out: ChunkResult['words'] = [];
  for (const seg of segments) {
    const segStart = Number(seg.start) || 0;
    const segEnd = Number(seg.end);
    const end = Number.isFinite(segEnd) ? segEnd : segStart;
    const tokens = String(seg.text ?? '').trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) continue;
    const per = Math.max(end - segStart, 0) / tokens.length;
    tokens.forEach((tok, idx) => {
      out.push({ word: tok, start: segStart + per * idx, end: segStart + per * (idx + 1) });
    });
  }
  return out;
}

// Call DeepInfra's native inference endpoint (NOT the OpenAI-compatible one) so the safety params
// above are actually honored. Native response returns words as { start, end, text }; we remap
// `text` -> `word` so the rest of the pipeline is unchanged.
async function transcribeFileDeepInfra(filePath: string, apiKey: string, model: string): Promise<ChunkResult> {
  const fileBuffer = await fs.readFile(filePath);
  const form = new FormData();
  form.append('audio', new Blob([fileBuffer], { type: 'audio/mpeg' }), 'audio.mp3');
  for (const [key, value] of Object.entries(DEEPINFRA_WHISPER_PARAMS)) form.append(key, value);

  const url = `https://api.deepinfra.com/v1/inference/${model}`;
  const res = await globalThis.fetch(url, {
    method: 'POST',
    headers: { Authorization: `bearer ${apiKey}` },
    body: form,
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`DeepInfra transcription HTTP ${res.status} ${res.statusText}: ${body.slice(0, 300)}`);
  }

  const json: any = await res.json();
  let words = extractDeepInfraWords(json);

  if (words.length === 0) {
    const segments: any[] = Array.isArray(json.segments) ? json.segments : [];
    // Diagnostic: log the ACTUAL response shape so we can see exactly where (if anywhere) the
    // per-word data is, instead of guessing. This fires only when real words weren't found.
    const seg0 = segments[0];
    console.warn(
      `[Transcription] No per-word timestamps found. shape: ` +
      `topWords=${Array.isArray(json.words) ? json.words.length : 'none'}, ` +
      `segments=${segments.length}, ` +
      `seg0keys=${seg0 ? Object.keys(seg0).join('|') : '-'}, ` +
      `seg0words=${Array.isArray(seg0?.words) ? seg0.words.length : 'none'}`
    );
    if (segments.length > 0) {
      // Last-resort: interpolate word timings from segment spans so read-along is at least roughly synced.
      console.warn('[Transcription] Synthesizing word timings from segments (read-along timing approximate).');
      words = wordsFromSegments(segments);
    } else {
      console.warn('[Transcription] WARNING: DeepInfra native endpoint returned neither words nor segments.');
    }
  }
  return { text: json.text ?? '', words };
}

// Transcribe a single audio file with the right transport for the configured provider.
// `prompt` is only used by the OpenAI-shaped path; the DeepInfra path deliberately sends no prompt
// (condition_on_previous_text=false handles continuity, and feeding the previous chunk's tail as a
// prompt is exactly what seeds cross-chunk loops).
async function transcribeFile(
  filePath: string,
  config: TranscriptionConfig,
  prompt: string,
  label: string,
): Promise<ChunkResult> {
  if (config.kind === 'deepinfra') {
    return withChunkRetry(() => transcribeFileDeepInfra(filePath, config.apiKey, config.model), label);
  }
  const transcription = await withChunkRetry(
    () => config.client.audio.transcriptions.create({
      file: createReadStream(filePath),
      model: config.model,
      response_format: 'verbose_json',
      timestamp_granularities: ['word'],
      prompt,
    }),
    label,
  );
  return { text: transcription.text, words: (transcription as any).words || [] };
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
    const config = await getTranscriptionClientForUser(userId);
    if (!config) throw new Error('No API key set. Please configure OpenAI or DeepInfra in Settings.');

    const model = config.model;

    const tempDir = getTempDir();
    await fs.mkdir(tempDir, { recursive: true });

    const audioFilename = `audio_transcribe_${Date.now()}.mp3`;
    const audioPath = path.join(tempDir, audioFilename);

    if (Buffer.isBuffer(audioSource)) {
      // Audio buffer passed directly, write to temp file (avoids HTTP round-trip)
      console.log(`[Transcription] Writing audio buffer (${(audioSource.length / 1024 / 1024).toFixed(1)} MB) to temp file...`);
      await fs.writeFile(audioPath, audioSource);
    } else {
      // URL passed, download it (legacy path, used for podcast transcription)
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

    if (fileSizeMB > PROCESSING_CONFIG.whisper.maxFileSizeMB) {
      console.log(`File exceeds ${PROCESSING_CONFIG.whisper.maxFileSizeMB} MB limit (${fileSizeMB.toFixed(2)} MB), splitting...`);
      const chunkFiles = await splitAudioIntoChunks(audioPath, PROCESSING_CONFIG.whisper.chunkDurationMinutes);
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
        // IMPORTANT: the continuation prompt must ALWAYS be bounded. previousTranscript
        // holds the FULL text of the previous chunk (often >10k chars for a 15-min chunk);
        // sending it unbounded made DeepInfra's Whisper endpoint reject chunk 2+ with a
        // bare 400 whenever initialPrompt was empty, which it always is since
        // whisper-prompt.ts started returning '' (OpenAI silently truncates instead).
        // OpenAI-shaped path keeps the hybrid continuity prompt; the DeepInfra native path sends
        // NO prompt (condition_on_previous_text=false handles continuity, and feeding the previous
        // chunk's tail is exactly what seeds cross-chunk repetition loops). previousTranscript is
        // still tracked below because the OpenAI path's continuity depends on it.
        let currentPrompt = '';
        if (config.kind === 'openai') {
          currentPrompt = previousTranscript;
          if (i > 0) {
            // Take the Metadata (Title, Author, Comments) from the start
            const metadataPart = initialPrompt ? initialPrompt.slice(0, 600) : '';
            // Take the Continuity (last few sentences) from the actual previous text
            const continuityPart = previousTranscript.slice(-200);
            currentPrompt = metadataPart ? `${metadataPart} ... ${continuityPart}` : continuityPart;
          }
        }

        const { text, words } = await transcribeFile(
          chunkFiles[i], config, currentPrompt, `Chunk ${i + 1}/${chunkFiles.length}`
        );

        transcriptText += (i > 0 ? ' ' : '') + text;
        previousTranscript = text;

        const adjustedWords = words.map((word) => ({
          ...word,
          start: word.start + timeOffset,
          end: word.end + timeOffset,
        }));
        allWords.push(...adjustedWords);
        timeOffset += chunkDuration;
      }
    } else {
      let fileToTranscribe = audioPath;
      if (fileSizeMB > PROCESSING_CONFIG.whisper.compressionThresholdMB) {
        console.log('Compressing large file...');
        const compressedPath = audioPath.replace('.mp3', '_compressed.mp3');
        await compressAudio(audioPath, compressedPath);
        fileToTranscribe = compressedPath;
        tempFiles.push(compressedPath);
      }

      console.log(`Transcribing file using model ${model}...`);
      // DeepInfra native path ignores the prompt; OpenAI path keeps the initial hint.
      const singlePrompt = config.kind === 'openai' ? previousTranscript : '';
      const { text, words } = await transcribeFile(fileToTranscribe, config, singlePrompt, 'Single file');

      transcriptText = text;
      allWords = words;
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
