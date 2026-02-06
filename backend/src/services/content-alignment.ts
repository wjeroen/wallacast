/**
 * Content Alignment Service
 *
 * Aligns original article content with Whisper transcript using Needleman-Wunsch algorithm.
 * This enables synchronized highlighting in the read-along tab by mapping HTML content
 * (with formatting, images, headers) to audio timestamps from the transcript.
 *
 * How it works:
 * 1. Extract plain text words from HTML content (strip tags but preserve structure)
 * 2. Normalize both original and transcript words (lowercase, remove punctuation)
 * 3. Run Needleman-Wunsch global sequence alignment
 * 4. Build mapping: original word index -> transcript word index -> timestamp
 * 5. Detect comments section start (for EA Forum/LessWrong timeline marker)
 * 6. Return alignment data to be stored in database
 */

import * as seqalign from 'seqalign';
import * as cheerio from 'cheerio';

interface TranscriptWord {
  word: string;
  start: number;
  end: number;
}

interface WordMapping {
  originalIndex: number;
  transcriptIndex: number;
  timestamp: number;
}

interface SectionMapping {
  type: 'paragraph' | 'heading' | 'list-item';
  startWordIndex: number;
  endWordIndex: number;
  startTime: number;
  endTime: number;
  text: string;
}

interface AlignmentResult {
  words: WordMapping[];
  sections: SectionMapping[];
  commentsStartTime: number | null;
  stats: {
    originalWordCount: number;
    transcriptWordCount: number;
    matchedWords: number;
    accuracy: number;
  };
}

/**
 * Normalize a word for alignment (lowercase, remove punctuation)
 */
function normalizeWord(word: string): string {
  return word
    .toLowerCase()
    .replace(/[^\w\s]/g, '') // Remove punctuation
    .trim();
}

/**
 * Extract plain text words from HTML content while preserving section boundaries
 * Smart chunking: breaks long paragraphs into ~50-word chunks for better highlighting granularity
 */
function extractWordsFromHTML(htmlContent: string): {
  words: string[];
  sections: Array<{ type: 'paragraph' | 'heading' | 'list-item'; startIndex: number; endIndex: number; text: string }>;
} {
  const $ = cheerio.load(htmlContent);
  const words: string[] = [];
  const sections: Array<{ type: 'paragraph' | 'heading' | 'list-item'; startIndex: number; endIndex: number; text: string }> = [];

  const CHUNK_SIZE = 50; // Words per chunk for long paragraphs (roughly 15-20 seconds of audio)

  // Remove script, style, and other non-content elements
  $('script, style, nav, footer, aside').remove();

  // Extract text from headings, paragraphs, list items, and images
  $('h1, h2, h3, h4, h5, h6, p, li, img').each((_: number, element: any) => {
    const $el = $(element);
    const text = $el.text().trim();
    if (!text) return;

    const tagName = element.name;
    let type: 'paragraph' | 'heading' | 'list-item' = 'paragraph';
    if (tagName.startsWith('h')) {
      type = 'heading';
    } else if (tagName === 'li') {
      type = 'list-item';
    }

    // Split text into words
    const sectionWords = text.split(/\s+/).filter((w: string) => w.length > 0);

    // For headings and list items, keep as single chunk
    // For paragraphs, break into chunks if too long
    if (type === 'heading' || type === 'list-item' || sectionWords.length <= CHUNK_SIZE) {
      const startIndex = words.length;
      words.push(...sectionWords);
      const endIndex = words.length - 1;

      sections.push({
        type,
        startIndex,
        endIndex,
        text: text.substring(0, 100) + (text.length > 100 ? '...' : ''),
      });
    } else {
      // Break long paragraph into chunks
      for (let i = 0; i < sectionWords.length; i += CHUNK_SIZE) {
        const chunk = sectionWords.slice(i, i + CHUNK_SIZE);
        const startIndex = words.length;
        words.push(...chunk);
        const endIndex = words.length - 1;

        const chunkText = chunk.join(' ');
        sections.push({
          type: 'paragraph',
          startIndex,
          endIndex,
          text: chunkText.substring(0, 100) + (chunkText.length > 100 ? '...' : ''),
        });
      }
    }
  });

  return { words, sections };
}

/**
 * Detect where comments section starts in the transcript
 * Looks for "comment section" or "comments section" phrases in last 15% of transcript
 * (EA Forum/LW can have 90% comments, so we search very late to avoid false matches)
 */
function detectCommentsStart(transcriptWords: TranscriptWord[]): number | null {
  // Search in the last 15% of transcript to avoid matching "comments" in article
  const startSearchIndex = Math.floor(transcriptWords.length * 0.85);

  const commentsPatterns = [
    ['comment', 'section'],
    ['comments', 'section'],
    ['discussion', 'section'],
  ];

  for (let i = startSearchIndex; i < transcriptWords.length - 1; i++) {
    const currentWord = normalizeWord(transcriptWords[i].word);
    const nextWord = i + 1 < transcriptWords.length ? normalizeWord(transcriptWords[i + 1].word) : '';

    for (const pattern of commentsPatterns) {
      if (currentWord === pattern[0] && nextWord === pattern[1]) {
        return transcriptWords[i].start;
      }
    }
  }

  return null;
}

/**
 * Align original content with Whisper transcript using Needleman-Wunsch algorithm
 */
export async function alignContentWithTranscript(
  htmlContent: string,
  transcriptWords: TranscriptWord[]
): Promise<AlignmentResult> {
  console.log('[Alignment] Starting content alignment...');

  // Extract words and sections from HTML
  const { words: originalWords, sections: originalSections } = extractWordsFromHTML(htmlContent);
  console.log(`[Alignment] Extracted ${originalWords.length} words and ${originalSections.length} sections from HTML`);

  // Normalize words for alignment
  const normalizedOriginal = originalWords.map(normalizeWord);
  const normalizedTranscript = transcriptWords.map(w => normalizeWord(w.word));

  console.log(`[Alignment] Running Needleman-Wunsch alignment...`);
  console.log(`[Alignment] Original: ${normalizedOriginal.length} words, Transcript: ${normalizedTranscript.length} words`);

  // Configure aligner (factory pattern - pass options only)
  const aligner = seqalign.NWaligner({
    similarityScoreFunction: (a: string, b: string) => {
      if (!a || !b) return -1;
      if (a === b) return 2; // Exact match
      // Fuzzy match: check if words share common prefix (handles transcription errors)
      if (a.length > 3 && b.length > 3 && a.substring(0, 3) === b.substring(0, 3)) {
        return 1; // Partial match
      }
      return -1; // Mismatch
    },
    gapScoreFunction: () => -1, // Penalty for gaps (image descriptions in transcript)
    gapSymbol: '', // Use empty string for gaps
  });

  // Execute alignment (pass sequences to align method)
  const result = aligner.align(normalizedOriginal, normalizedTranscript);
  console.log('[Alignment] Alignment complete');

  // Build word mappings from coordinateWalk
  // coordinateWalk is a PATH through the alignment matrix
  // IMPORTANT: seqalign returns the path BACKWARDS (end→start) due to backtracking
  // We must reverse it to go from start→end before processing
  const wordMappings: WordMapping[] = [];
  let matchedWords = 0;

  if (result && result.coordinateWalk && result.coordinateWalk.length > 1) {
    // Reverse the walk if it starts from the end (standard Needleman-Wunsch backtracking)
    let walk = result.coordinateWalk;
    if (walk[0][0] !== 0 || walk[0][1] !== 0) {
      walk = [...walk].reverse(); // Create a copy and reverse it
    }

    // Iterate through consecutive pairs in the path (now start→end)
    for (let i = 0; i < walk.length - 1; i++) {
      const [currOrig, currTrans] = walk[i];
      const [nextOrig, nextTrans] = walk[i + 1];

      // Check if this is a diagonal move (both indices increase = alignment)
      if (nextOrig === currOrig + 1 && nextTrans === currTrans + 1) {
        // This is an alignment: original[currOrig] aligns with transcript[currTrans]
        if (currOrig < normalizedOriginal.length && currTrans < normalizedTranscript.length &&
            currTrans < transcriptWords.length) {
          wordMappings.push({
            originalIndex: currOrig,
            transcriptIndex: currTrans,
            timestamp: transcriptWords[currTrans].start,
          });

          if (normalizedOriginal[currOrig] === normalizedTranscript[currTrans]) {
            matchedWords++;
          }
        }
      }
      // Note: We ignore gaps (non-diagonal moves) as they don't represent alignments
    }
  }

  console.log(`[Alignment] Mapped ${wordMappings.length} words, ${matchedWords} exact matches`);

  // Build section mappings (paragraphs/headings with timestamps)
  const sectionMappings: SectionMapping[] = [];

  for (const section of originalSections) {
    // Find timestamps for this section's start and end words
    const startMapping = wordMappings.find(m => m.originalIndex >= section.startIndex);
    const endMapping = wordMappings.slice().reverse().find(m => m.originalIndex <= section.endIndex);

    if (startMapping && endMapping) {
      sectionMappings.push({
        type: section.type,
        startWordIndex: section.startIndex,
        endWordIndex: section.endIndex,
        startTime: startMapping.timestamp,
        endTime: endMapping.timestamp,
        text: section.text,
      });
    }
  }

  console.log(`[Alignment] Created ${sectionMappings.length} section mappings`);

  // Detect comments section start
  const commentsStartTime = detectCommentsStart(transcriptWords);
  if (commentsStartTime !== null) {
    console.log(`[Alignment] Detected comments section at ${commentsStartTime.toFixed(1)}s`);
  }

  const accuracy = originalWords.length > 0 ? (matchedWords / originalWords.length) * 100 : 0;
  console.log(`[Alignment] Alignment accuracy: ${accuracy.toFixed(1)}%`);

  return {
    words: wordMappings,
    sections: sectionMappings,
    commentsStartTime,
    stats: {
      originalWordCount: originalWords.length,
      transcriptWordCount: transcriptWords.length,
      matchedWords,
      accuracy,
    },
  };
}
