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

// Gemini 3.8 Flash, not Flash-Lite. Flash-Lite sometimes ends a piece's answer early, with
// finish=STOP as if it were done, and leaves minutes of speech out. Tests on 2026-10-23 (four
// 10-minute parts of long videos, 4 runs each, scored against YouTube's own captions):
// Flash-Lite stopped where the talk sounds finished, at a goodbye followed by a new segment
// (3 of 4 runs) or at "I need to do a bathroom break" and a cut (2 of 4), and once wrote times
// that squeezed the piece's last minutes together. A stricter prompt, a prompt saying goodbyes
// are not the end, an answer per minute and one frame per second did not stop it, while
// Gemini 3.8 Flash left nothing out in 12 of 12 runs (3.5 and 3.6 Flash neither, 28 runs),
// with sentence times as close (a median of 0.2 to 0.5 s). Asked why it stopped, Gemini
// blamed an output limit it had not reached. 3.8 Flash costs about $0.18 per hour of video
// (Flash-Lite about $0.10, Google's prices of 2026-10-23) and takes about 35 s per piece.
export const VIDEO_TRANSCRIPT_DEFAULT_MODEL = 'gemini-3.8-flash';

// A safety net for any model: a piece with a stretch of more than HOLE_SECONDS in which no
// sentence starts is transcribed once more by RETRY_MODEL (the same model when that is the
// one chosen), the answer that leaves less uncovered is kept, and a stretch still uncovered
// gets a visible line in the transcript instead of disappearing silently.
const RETRY_MODEL = 'gemini-3.8-flash';
const HOLE_SECONDS = 60;

// Longer videos go in 10-minute pieces. In one answer Gemini stopped early (a 33-minute
// video's transcript ended at 21 minutes, finish=STOP, 2026-10-23) and its times drifted
// further from the video the longer the video was. Each piece starts its times afresh at the
// piece's start, so the drift stays small. Up to 12 minutes go in one piece, and so does the
// end of a video: the last piece takes what is left when that is 12 minutes or less, so it is
// never shorter than 2 minutes. Gemini refused a 9-second last piece with HTTP 400 "Request
// contains an invalid argument" (a 20:09 video, 2026-10-23, and the same 9 seconds in a test),
// and a 69-second one worked.
const PIECE_SECONDS = 10 * 60;
const SPLIT_ABOVE_SECONDS = 12 * 60;
const PIECE_OVERLAP_SECONDS = 20;

// One video frame per 50 seconds instead of Gemini's default of one per second. The
// transcript comes from the audio, and at the default the frames were about two thirds
// of what Google bills (test 2026-10-22 on a 6-minute video: 31,943 input tokens at the
// default, 9,305 at 0.02, with the same words and sentence times within 0.6 s).
const VIDEO_FPS = 0.02;

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

// The same three numbers read as minutes, seconds and hundredths ("8:30:16" for 8 min 30.16 s),
// which Gemini sometimes writes although H:MM:SS was asked for (see readStarts). Null when it
// is not three numbers.
function minutesSecondsHundredths(value: unknown): number | null {
  const parts = String(value ?? '').trim().split(':');
  if (parts.length !== 3 || parts.some((p) => !/^\d+$/.test(p))) return null;
  return Number(parts[0]) * 60 + Number(parts[1]) + Number(parts[2]) / 100;
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
  label: string,
  // Where the part Gemini gets ends (the video's length for a whole video), null when unknown
  spanEnd: number | null
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
    + 'hours, minutes and whole seconds (0:01:05 is one minute and five seconds), '
    + `counted from the start of the video.${scope} `
    + 'Answer only with a JSON array of objects with "start" and "text".';
  const body = {
    contents: [{
      parts: [
        {
          fileData: { fileUri: videoUrl },
          videoMetadata: {
            fps: VIDEO_FPS,
            ...(piece ? { startOffset: `${piece.from}s`, endOffset: `${piece.to}s` } : {}),
          },
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
      return readStarts(rows, spanEnd, label);
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

// Gemini writes most starts as the H:MM:SS that was asked for, but sometimes as minutes,
// seconds and hundredths ("8:30:16" for 8 min 30.16 s): for a whole answer (two videos of 8
// and 14 minutes got times of up to 14 hours read as H:MM:SS, 2026-10-23) or for a few
// sentences of it (a later test). So every start is read both ways. Read as hundredths, a
// start almost always fits, so that reading only counts for the whole answer when most
// starts read as H:MM:SS run past the part Gemini was given (spanEnd plus a minute). A start
// that only fits the other way is read that way, and a sentence whose start fits neither
// keeps its text and takes the start before it.
function readStarts(rows: Array<{ start?: unknown; text?: unknown }>, spanEnd: number | null, label: string): Sentence[] {
  const fits = (t: number | null): t is number => t !== null && (spanEnd === null || t <= spanEnd + 60);
  const read = rows
    .map((row) => ({
      hms: clockToSeconds(row?.start),
      hundredths: minutesSecondsHundredths(row?.start),
      text: typeof row?.text === 'string' ? row.text.trim() : '',
    }))
    .filter((r) => r.text);
  const preferHundredths = read.filter((r) => fits(r.hms)).length < read.length / 2;
  if (preferHundredths) console.warn(`[VideoTranscript] ${label}: the times were written as M:SS:hundredths, read that way`);
  const sentences: Sentence[] = [];
  let switched = 0;
  let unread = 0;
  for (const r of read) {
    const [first, second] = preferHundredths ? [r.hundredths, r.hms] : [r.hms, r.hundredths];
    let start: number | null = null;
    if (fits(first)) start = first;
    else if (fits(second)) { start = second; switched++; }
    else unread++;
    sentences.push({ start: start ?? sentences[sentences.length - 1]?.start ?? 0, text: r.text });
  }
  if (switched) console.warn(`[VideoTranscript] ${label}: ${switched} start(s) only fit when read the other way`);
  if (unread) console.warn(`[VideoTranscript] ${label}: ${unread} start(s) fit neither way, those sentences take the start before them`);
  return sentences;
}

// A stretch of a piece's own part in which no sentence starts, longer than HOLE_SECONDS: a
// conversation leaves no such silence, so speech is probably missing (or it is music). From
// the piece's start when it is not the video's start, and up to where its own part ends
// when it is not the last piece, so a silent intro or closing music is never a hole.
interface Hole {
  from: number;
  to: number;
  // The index of the sentence the hole follows, -1 before the first
  after: number;
}

function holesIn(sentences: Sentence[], piece: Piece | null): Hole[] {
  const holes: Hole[] = [];
  let prev: number | null = piece && piece.from > 0 ? piece.from : null;
  sentences.forEach((s, k) => {
    if (prev !== null && s.start - prev > HOLE_SECONDS) holes.push({ from: prev, to: s.start, after: k - 1 });
    prev = s.start;
  });
  if (piece && Number.isFinite(piece.ownTo)) {
    const last = sentences.length > 0 ? sentences[sentences.length - 1].start : piece.from;
    if (piece.ownTo - last > HOLE_SECONDS) holes.push({ from: last, to: piece.ownTo, after: sentences.length - 1 });
  }
  return holes;
}

const uncovered = (holes: Hole[]) => holes.reduce((total, h) => total + h.to - h.from, 0);

// The sentences a piece keeps: those that start in its own part (a sentence belongs to the
// piece it starts in), without the leftover of the sentence it begins in
function ownSentences(got: Sentence[], piece: Piece | null): Sentence[] {
  if (!piece) return got;
  return got.filter((s, k) => {
    if (s.start < piece.from - 1 || s.start >= piece.ownTo) return false;
    // Gemini sometimes still writes the end of the sentence a piece begins in, although
    // the previous piece finished it ("and hue." in a test). Such a leftover starts
    // right at the cut with a small letter, where a real sentence starts with a capital.
    return !(piece.from > 0 && k === 0 && s.start < piece.from + 3 && s.text[0] !== s.text[0].toUpperCase());
  });
}

// The piece's sentences with a line in each stretch that stays uncovered, where its speech
// would be. The line starts when the sentence before it has had about 0.4 s per word, so
// that sentence keeps its own time.
function withHoleLines(sentences: Sentence[], holes: Hole[]): Sentence[] {
  const line = (h: Hole): Sentence => {
    const before = sentences[h.after];
    const spoken = before && before.start === h.from ? before.text.split(/\s+/).length * 0.4 : 0;
    const from = Math.min(h.from + spoken, h.to - 1);
    return { start: from, text: `[Transcript may be missing from ${clock(from)} to ${clock(h.to)}.]` };
  };
  const out = holes.filter((h) => h.after === -1).map(line);
  sentences.forEach((s, k) => {
    out.push(s, ...holes.filter((h) => h.after === k).map(line));
  });
  return out;
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
  const longestPiece = Math.max(SPLIT_ABOVE_SECONDS * pieceSeconds / PIECE_SECONDS, pieceSeconds);
  if (durationSeconds && durationSeconds > longestPiece) {
    const end = Math.ceil(durationSeconds);
    for (let from = 0; from < end; from += pieceSeconds) {
      const last = end - from <= longestPiece;
      pieces.push({
        from,
        to: last ? end : Math.min(from + pieceSeconds + PIECE_OVERLAP_SECONDS, end),
        ownTo: last ? Infinity : from + pieceSeconds,
      });
      if (last) break;
    }
  } else {
    pieces.push(null);
  }
  console.log(`[VideoTranscript] ${id}: ${pieces.length} piece(s), duration=${durationSeconds ?? 'unknown'}, model=${model}`);

  // One piece after the other: each piece counts against Gemini's per-minute limits
  const sentences: Sentence[] = [];
  let spoken = 0;
  for (let i = 0; i < pieces.length; i++) {
    const label = `${id} piece ${i + 1}/${pieces.length}`;
    const piece = pieces[i];
    const spanEnd = piece ? piece.to : (durationSeconds || null);
    const transcribe = async (withModel: string) => ownSentences(
      toVideoTime(await transcribePiece(apiKey, withModel, videoUrl, piece, label, spanEnd), piece, label),
      piece
    );
    let own = await transcribe(model);
    let holes = holesIn(own, piece);
    if (holes.length > 0) {
      const where = holes.map((h) => `${clock(h.from)}-${clock(h.to)}`).join(', ');
      console.warn(`[VideoTranscript] ${label}: no sentence starts in ${where}, asking ${RETRY_MODEL} again`);
      try {
        const again = await transcribe(RETRY_MODEL);
        const againHoles = holesIn(again, piece);
        if (again.length > 0 && uncovered(againHoles) < uncovered(holes)) {
          own = again;
          holes = againHoles;
        }
        console.log(`[VideoTranscript] ${label}: kept the ${own === again ? 'second' : 'first'} answer, ${Math.round(uncovered(holes))} s still uncovered`);
      } catch (err) {
        console.warn(`[VideoTranscript] ${label}: the second answer failed, keeping the first: ${(err as Error).message}`);
      }
    }
    if (holes.length > 0) console.warn(`[VideoTranscript] ${label}: ${holes.length} stretch(es) marked as possibly missing`);
    spoken += own.length;
    for (const s of withHoleLines(own, holes)) {
      // Times never run backwards
      const prev = sentences[sentences.length - 1];
      sentences.push({ start: prev && s.start < prev.start ? prev.start : s.start, text: s.text });
    }
  }
  if (spoken === 0) throw new Error('Gemini found no speech in this video');

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
