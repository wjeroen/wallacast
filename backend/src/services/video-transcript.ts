import { getUserSetting } from './ai-providers.js';
import { youtubeVideoId } from '../shared/format.js';

// A YouTube video's transcript, written by Gemini from the video's address. Gemini reads
// public YouTube videos itself (https://ai.google.dev/gemini-api/docs/video-understanding),
// so our server never downloads the video. One test on a 6-minute TED-Ed video
// (2026-10-22): the text was nearly word for word against YouTube's own captions, and 35 of
// 36 sentence times fell within 1.6 seconds of the captions.
//
// Gemini gives one start time per sentence. Each sentence's words are spread evenly over
// its span (up to the next sentence), the same fallback transcription.ts uses for Whisper
// segments without word times. That is timing interpolation WITHIN a known sentence, not
// matching text against text, so it does not touch the "no fuzzy alignment" rule. The
// result has the shape of a Whisper transcript ({ word, start, end }), so the Transcript
// tab, the summaries and Copy content treat it like a podcast transcript.

export const VIDEO_TRANSCRIPT_DEFAULT_MODEL = 'gemini-3.5-flash-lite';

// Long videos go in 30-minute pieces, so one answer never nears the model's output limit
// (a 30-minute talk is roughly 5,000 words). Up to 40 minutes go in one piece.
const PIECE_SECONDS = 30 * 60;
const SPLIT_ABOVE_SECONDS = 40 * 60;
const PIECE_OVERLAP_SECONDS = 20;

// A part of the video sent on its own: from..to is what Gemini gets, ownTo is where the
// sentences this piece keeps must have started by (Infinity for the last piece)
interface Piece {
  from: number;
  to: number;
  ownTo: number;
}
const REQUEST_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 3;

interface Sentence {
  start: number;
  text: string;
}

export interface VideoTranscript {
  text: string;
  words: Array<{ word: string; start: number; end: number }>;
}

// "1:02:03", "02:03", "2:03.5" or a plain number of seconds, in seconds. Null when unreadable.
function clockToSeconds(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : null;
  const parts = String(value ?? '').trim().split(':');
  if (parts.length === 0 || parts.length > 3 || parts.some((p) => !/^\d+(\.\d+)?$/.test(p))) return null;
  return parts.reduce((total, p) => total * 60 + Number(p), 0);
}

function clock(seconds: number): string {
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h}:${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

// The answer is a JSON array. When it was cut off at the output limit, the sentences that
// did arrive in full are kept.
function parseSentences(raw: string): Array<{ start?: unknown; text?: unknown }> {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    const lastClose = raw.lastIndexOf('}');
    if (lastClose < 0) return [];
    try {
      const parsed = JSON.parse(`${raw.slice(0, lastClose + 1)}]`);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
}

async function transcribePiece(
  apiKey: string,
  model: string,
  videoUrl: string,
  piece: Piece | null,
  label: string
): Promise<Sentence[]> {
  const scope = piece
    ? ` You are given only the part of the video from ${clock(piece.from)} to ${clock(piece.to)}.`
      + (piece.from > 0 ? ' If it begins in the middle of a sentence, leave that unfinished sentence out.' : '')
      + (Number.isFinite(piece.ownTo)
        ? ` Transcribe only the sentences that start before ${clock(piece.ownTo)}, and finish the last of them even when it runs past that time.`
        : '')
      + ' Still count every time from the start of the full video.'
    : '';
  const prompt = 'Transcribe all speech in this video word for word, in the language that is spoken. '
    + 'Do not summarize, translate, skip or reword anything. Leave out music and sound effects. '
    + 'Split the transcript into sentences. For each sentence give the time it starts as H:MM:SS, '
    + `counted from the start of the video.${scope} `
    + 'Answer only with a JSON array of objects with "start" and "text".';
  const body = {
    contents: [{
      parts: [
        {
          fileData: { fileUri: videoUrl },
          ...(piece ? { videoMetadata: { startOffset: `${piece.from}s`, endOffset: `${piece.to}s` } } : {}),
        },
        { text: prompt },
      ],
    }],
    generationConfig: {
      mediaResolution: 'MEDIA_RESOLUTION_LOW',
      maxOutputTokens: 65536,
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'ARRAY',
        items: {
          type: 'OBJECT',
          properties: { start: { type: 'STRING' }, text: { type: 'STRING' } },
          required: ['start', 'text'],
        },
      },
    },
  };

  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
        method: 'POST',
        // The key goes in a header, so it never ends up in an error message or a log line
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      const data = (await res.json().catch(() => ({}))) as any;
      if (!res.ok) {
        const err: any = new Error(`Gemini answered HTTP ${res.status}: ${(data?.error?.message || '').slice(0, 300)}`);
        err.status = res.status;
        throw err;
      }
      const candidate = data?.candidates?.[0];
      const text = (candidate?.content?.parts || []).map((p: any) => p?.text || '').join('');
      const rows = parseSentences(text);
      console.log(`[VideoTranscript] ${label} done: model=${model} tokens_in=${data?.usageMetadata?.promptTokenCount ?? '?'} tokens_out=${data?.usageMetadata?.candidatesTokenCount ?? '?'} finish=${candidate?.finishReason ?? '?'} sentences=${rows.length}`);
      if (candidate?.finishReason === 'MAX_TOKENS') {
        console.warn(`[VideoTranscript] ${label} TRUNCATED at the output limit, the sentences that arrived in full are kept`);
      }
      const sentences: Sentence[] = [];
      for (const row of rows) {
        const start = clockToSeconds(row?.start);
        const sentenceText = typeof row?.text === 'string' ? row.text.trim() : '';
        if (start !== null && sentenceText) sentences.push({ start, text: sentenceText });
      }
      return sentences;
    } catch (err: any) {
      lastError = err;
      const status: number | undefined = err?.status;
      const retryable = status === undefined || status === 429 || status >= 500;
      if (!retryable || attempt === MAX_ATTEMPTS) break;
      const delay = attempt * 15_000;
      console.warn(`[VideoTranscript] ${label} attempt ${attempt}/${MAX_ATTEMPTS} failed (${status ?? 'conn'}): ${err?.message}. Retrying in ${delay / 1000}s`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastError ?? new Error('Gemini gave no transcript');
}

// Gemini is asked for times from the start of the full video. If a piece's times plainly
// start near 0 instead, they count from the piece's own start and are shifted.
function toVideoTime(sentences: Sentence[], piece: Piece | null, label: string): Sentence[] {
  if (!piece || piece.from === 0 || sentences.length === 0) return sentences;
  const first = sentences[0].start;
  const last = sentences[sentences.length - 1].start;
  if (first < piece.from - 60 && last <= piece.to - piece.from + 60) {
    console.log(`[VideoTranscript] ${label}: times count from the piece's start, shifted by ${piece.from}s`);
    return sentences.map((s) => ({ ...s, start: s.start + piece.from }));
  }
  return sentences;
}

export async function transcribeYouTubeVideo(
  userId: number,
  videoUrl: string,
  durationSeconds: number | null
): Promise<VideoTranscript> {
  const apiKey = (await getUserSetting(userId, 'gemini_api_key'))?.trim();
  if (!apiKey) throw new Error('Video transcripts need a Gemini API key. Add one in Settings.');
  const model = (await getUserSetting(userId, 'video_transcript_model'))?.trim() || VIDEO_TRANSCRIPT_DEFAULT_MODEL;
  return transcribeYouTubeVideoWith(apiKey, model, videoUrl, durationSeconds);
}

// The same with the key and model given (also what a test script calls)
export async function transcribeYouTubeVideoWith(
  apiKey: string,
  model: string,
  videoUrl: string,
  durationSeconds: number | null,
  pieceSeconds = PIECE_SECONDS
): Promise<VideoTranscript> {
  const id = youtubeVideoId(videoUrl) || videoUrl;

  // A piece cut mid-sentence loses that sentence's last words (seen at a 2:00 cut in a test:
  // "shape, size," instead of "shape, size, and hue."), so each piece runs on for
  // PIECE_OVERLAP_SECONDS past its own end, and Gemini is told to finish the sentence in
  // progress there and to skip the unfinished one a piece begins with. A sentence belongs
  // to the piece it starts in.
  const pieces: Array<Piece | null> = [];
  if (durationSeconds && durationSeconds > Math.max(SPLIT_ABOVE_SECONDS * pieceSeconds / PIECE_SECONDS, pieceSeconds)) {
    const end = Math.ceil(durationSeconds);
    for (let from = 0; from < end; from += pieceSeconds) {
      const last = from + pieceSeconds >= end;
      pieces.push({
        from,
        to: last ? end : Math.min(from + pieceSeconds + PIECE_OVERLAP_SECONDS, end),
        ownTo: last ? Infinity : from + pieceSeconds,
      });
    }
  } else {
    pieces.push(null);
  }
  console.log(`[VideoTranscript] ${id}: ${pieces.length} piece(s), duration=${durationSeconds ?? 'unknown'}, model=${model}`);

  // One piece after the other: each piece counts against Gemini's per-minute limits
  const sentences: Sentence[] = [];
  for (let i = 0; i < pieces.length; i++) {
    const label = `${id} piece ${i + 1}/${pieces.length}`;
    const piece = pieces[i];
    const got = toVideoTime(await transcribePiece(apiKey, model, videoUrl, piece, label), piece, label);
    for (const [k, s] of got.entries()) {
      if (piece && (s.start < piece.from - 1 || s.start >= piece.ownTo)) continue;
      // Gemini sometimes still writes the end of the sentence a piece begins in, although
      // the previous piece finished it ("and hue." in a test). Such a leftover starts
      // right at the cut with a small letter, where a real sentence starts with a capital.
      if (piece && piece.from > 0 && k === 0 && s.start < piece.from + 3 && s.text[0] !== s.text[0].toUpperCase()) continue;
      // Times never run backwards
      const prev = sentences[sentences.length - 1];
      sentences.push({ start: prev && s.start < prev.start ? prev.start : s.start, text: s.text });
    }
  }
  if (sentences.length === 0) throw new Error('Gemini found no speech in this video');

  const words: VideoTranscript['words'] = [];
  sentences.forEach((s, i) => {
    const tokens = s.text.split(/\s+/).filter(Boolean);
    const next = sentences[i + 1]?.start;
    // The last sentence ends at the video's end, or after about 0.4 s per word
    const end = next !== undefined ? next : Math.max(s.start, Math.min(durationSeconds || Infinity, s.start + tokens.length * 0.4));
    const per = Math.max(end - s.start, 0) / tokens.length;
    tokens.forEach((token, k) => {
      words.push({
        word: token,
        start: Math.round((s.start + per * k) * 100) / 100,
        end: Math.round((s.start + per * (k + 1)) * 100) / 100,
      });
    });
  });
  return { text: sentences.map((s) => s.text).join(' '), words };
}
