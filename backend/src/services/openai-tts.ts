import OpenAI from 'openai';
import fs from 'fs/promises';
import path from 'path';
import ffmpeg from 'fluent-ffmpeg';
import { query } from '../database/db.js';

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

async function getOpenAIClient(): Promise<OpenAI | null> {
  // Use environment variable only for security
  if (process.env.OPENAI_API_KEY) {
    return new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    });
  }

  return null;
}

export async function extractArticleContent(htmlContent: string): Promise<string> {
  try {
    const openai = await getOpenAIClient();
    if (!openai) {
      console.warn('OpenAI API key not set, returning raw HTML content');
      return htmlContent.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    }

    // Use GPT-4o-mini to extract and format article content for audio reading
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: `You are a content extraction assistant that formats web content for text-to-speech reading.

Extract and format content following these rules:
1. Extract the main article text, removing navigation, ads, footers, headers
2. REMOVE actual URL strings (like "https://example.com") - don't read them out loud
3. Keep the word "link" when it's used naturally in text - only remove URL strings
4. KEEP comment sections - they are VERY IMPORTANT
5. For comments, extract and format naturally for speaking:
   - Include the username/author of each comment
   - Include karma/vote counts (e.g., "+42 karma", "23 karma", "15 agree, 3 disagree")
   - For EA Forum: look for karma numbers and agree/disagree votes
   - Format like: "Username wrote a comment with 42 karma: [comment text]"
   - Or: "Username commented with 15 agree and 3 disagree votes: [comment text]"
   - Include ALL comments, even nested replies
6. After the main article, add a clear section break like "Comments section:" before listing comments
7. Format lists and structure naturally for speaking
8. Replace special characters and symbols with spoken equivalents
9. Remove "Share", "Tweet", "Like" buttons text
10. Remove newsletter signup prompts

Return the article body, then clearly marked comments section with ALL comments formatted for natural speech.`,
        },
        {
          role: 'user',
          content: `Extract the main article content and comments from this HTML for audio reading:\n\n${htmlContent.slice(0, 50000)}`,
        },
      ],
      temperature: 0.3,
    });

    const cleanContent = response.choices[0]?.message?.content || '';
    return cleanContent;
  } catch (error) {
    console.error('Error extracting article content:', error);
    // Fallback: strip HTML tags
    return htmlContent.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  }
}

function splitTextIntoChunks(text: string, maxLength: number): string[] {
  if (text.length <= maxLength) return [text];

  const chunks: string[] = [];
  let currentPos = 0;

  while (currentPos < text.length) {
    let chunkEnd = currentPos + maxLength;

    // If this is the last chunk, take everything
    if (chunkEnd >= text.length) {
      chunks.push(text.slice(currentPos));
      break;
    }

    // Find the last sentence boundary within the chunk
    const chunk = text.slice(currentPos, chunkEnd);
    const lastSentenceEnd = Math.max(
      chunk.lastIndexOf('. '),
      chunk.lastIndexOf('! '),
      chunk.lastIndexOf('? ')
    );

    if (lastSentenceEnd > maxLength * 0.6) {
      // Good sentence boundary found
      chunkEnd = currentPos + lastSentenceEnd + 1;
    } else {
      // No good boundary, try to break at word boundary
      const lastSpace = chunk.lastIndexOf(' ');
      if (lastSpace > maxLength * 0.8) {
        chunkEnd = currentPos + lastSpace;
      }
    }

    chunks.push(text.slice(currentPos, chunkEnd).trim());
    currentPos = chunkEnd;
  }

  return chunks;
}

async function concatenateAudioFiles(inputFiles: string[], outputFile: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // Create a temporary concat list file
    const concatListPath = outputFile + '.txt';
    const concatList = inputFiles.map(f => `file '${f}'`).join('\n');

    fs.writeFile(concatListPath, concatList)
      .then(() => {
        ffmpeg()
          .input(concatListPath)
          .inputOptions(['-f concat', '-safe 0'])
          .outputOptions(['-c copy'])
          .output(outputFile)
          .on('end', () => {
            // Clean up concat list file
            fs.unlink(concatListPath).catch(console.error);
            resolve();
          })
          .on('error', (err) => {
            fs.unlink(concatListPath).catch(console.error);
            reject(err);
          })
          .run();
      })
      .catch(reject);
  });
}

interface ChunkMetadata {
  text: string;
  startWord: number;
  endWord: number;
  duration: number;
  startTime: number;
}

export async function generateArticleAudio(
  articleText: string,
  options: {
    voice?: 'alloy' | 'echo' | 'fable' | 'onyx' | 'nova' | 'shimmer' | 'coral';
    instructions?: string;
    contentId?: number;
  } = {}
): Promise<{ buffer: Buffer; chunks: number; chunkMetadata: ChunkMetadata[] }> {
  try {
    const openai = await getOpenAIClient();
    if (!openai) {
      throw new Error('OpenAI API key not set. Please set your OpenAI API key in Settings.');
    }

    const voice = options.voice || 'alloy';
    const instructions =
      options.instructions ||
      'Read this article clearly and naturally. Focus on the main content. Use appropriate pacing and emphasis for readability.';

    // Split text into chunks that fit within OpenAI's 4096 character limit
    const textChunks = splitTextIntoChunks(articleText, 4090);
    console.log(`Generating TTS audio with gpt-4o-mini-tts for ${textChunks.length} chunk(s)...`);

    // Calculate word positions for the full text
    const allWords = articleText.split(/\s+/);

    if (textChunks.length === 1) {
      // Single chunk - simple case
      console.log(`Single chunk (${textChunks[0].length} chars)`);
      const response = await openai.audio.speech.create({
        model: 'gpt-4o-mini-tts',
        voice: voice,
        input: textChunks[0],
        instructions: instructions,
      });

      const buffer = Buffer.from(await response.arrayBuffer());

      // Save temp file to get duration
      const tempDir = path.join(process.cwd(), 'temp');
      await fs.mkdir(tempDir, { recursive: true });
      const tempFile = path.join(tempDir, `single_${Date.now()}.mp3`);
      await fs.writeFile(tempFile, buffer);
      const duration = await getAudioDuration(tempFile);
      await fs.unlink(tempFile).catch(console.error);

      const chunkMetadata: ChunkMetadata[] = [{
        text: textChunks[0],
        startWord: 0,
        endWord: allWords.length - 1,
        duration: duration,
        startTime: 0
      }];

      return { buffer, chunks: 1, chunkMetadata };
    }

    // Multiple chunks - generate and concatenate
    const tempDir = path.join(process.cwd(), 'temp');
    await fs.mkdir(tempDir, { recursive: true });

    const chunkFiles: string[] = [];
    const chunkMetadata: ChunkMetadata[] = [];
    const timestamp = Date.now();
    let currentWordIndex = 0;
    let currentTime = 0;

    try {
      // Generate audio for each chunk
      for (let i = 0; i < textChunks.length; i++) {
        console.log(`Generating chunk ${i + 1}/${textChunks.length} (${textChunks[i].length} chars)...`);

        // Update progress (90% for chunk generation, 10% for concatenation)
        const chunkProgress = Math.round(((i + 1) / textChunks.length) * 90);
        if (options.contentId) {
          await query(
            'UPDATE content_items SET generation_progress = $1 WHERE id = $2',
            [chunkProgress, options.contentId]
          );
        }

        const response = await openai.audio.speech.create({
          model: 'gpt-4o-mini-tts',
          voice: voice,
          input: textChunks[i],
          instructions: instructions,
        });

        const chunkFile = path.join(tempDir, `chunk_${timestamp}_${i}.mp3`);
        const chunkBuffer = Buffer.from(await response.arrayBuffer());
        await fs.writeFile(chunkFile, chunkBuffer);
        chunkFiles.push(chunkFile);

        // Get duration and calculate word positions
        const duration = await getAudioDuration(chunkFile);
        const chunkWords = textChunks[i].split(/\s+/).length;

        chunkMetadata.push({
          text: textChunks[i],
          startWord: currentWordIndex,
          endWord: currentWordIndex + chunkWords - 1,
          duration: duration,
          startTime: currentTime
        });

        currentWordIndex += chunkWords;
        currentTime += duration;
      }

      // Concatenate all chunks
      const outputFile = path.join(tempDir, `concatenated_${timestamp}.mp3`);
      console.log(`Concatenating ${chunkFiles.length} audio files...`);

      // Update progress to 95% before concatenation
      if (options.contentId) {
        await query(
          'UPDATE content_items SET generation_progress = $1 WHERE id = $2',
          [95, options.contentId]
        );
      }

      await concatenateAudioFiles(chunkFiles, outputFile);

      // Read the final file
      const finalBuffer = await fs.readFile(outputFile);

      // Clean up temporary files
      await fs.unlink(outputFile).catch(console.error);
      for (const chunkFile of chunkFiles) {
        await fs.unlink(chunkFile).catch(console.error);
      }

      return { buffer: finalBuffer, chunks: textChunks.length, chunkMetadata };
    } catch (error) {
      // Clean up on error
      for (const chunkFile of chunkFiles) {
        await fs.unlink(chunkFile).catch(console.error);
      }
      throw error;
    }
  } catch (error) {
    console.error('Error generating audio:', error);
    throw new Error('Failed to generate audio. Please check your OpenAI API key and try again.');
  }
}

export async function generateAudioForContent(contentId: number): Promise<{ audioUrl: string; warning?: string }> {
  try {
    // Get content item
    const contentResult = await query('SELECT * FROM content_items WHERE id = $1', [contentId]);

    if (contentResult.rows.length === 0) {
      throw new Error('Content not found');
    }

    const content = contentResult.rows[0];

    let textToConvert = '';

    if (content.type === 'article') {
      // Extract clean content from HTML
      const cleanContent = await extractArticleContent(content.html_content || content.content);
      textToConvert = cleanContent;
    } else {
      textToConvert = content.content || '';
    }

    if (!textToConvert) {
      throw new Error('No content to convert to audio');
    }

    // Add intro with title, author, and karma (if available)
    let intro = '';
    if (content.title) {
      intro = `This article is titled: ${content.title}.`;

      if (content.author) {
        intro += ` Written by ${content.author}.`;
      }

      // Try to extract karma from description or content if it's an EA Forum post
      // EA Forum often includes karma in metadata
      const karmaMatch = (content.description || content.html_content || '').match(/(\d+)\s*karma/i);
      if (karmaMatch) {
        intro += ` This post has ${karmaMatch[1]} karma.`;
      }

      intro += '\n\n';
    }

    // Prepend intro to content
    const fullText = intro + textToConvert;
    const originalLength = fullText.length;

    // Generate audio (with chunking for long articles)
    const { buffer: audioBuffer, chunks, chunkMetadata } = await generateArticleAudio(fullText, {
      instructions:
        'You are reading an article aloud with comments. Start with the title and author introduction if present, then read the article body, then read the comments section. Do not read out URL strings (like https://example.com), but you can say the word "link" when it appears naturally in text. For comments, read the username and karma/votes naturally before reading the comment text. Use appropriate pacing and natural emphasis.',
      contentId: contentId, // Pass contentId for progress tracking
    });

    // Generate info message about chunks if multiple were used
    let warning: string | undefined;
    if (chunks > 1) {
      const estimatedMinutes = Math.round(originalLength / 900); // ~900 chars/minute for TTS
      warning = `Generated complete audio in ${chunks} parts (~${estimatedMinutes} minutes). The full article has been converted to audio.`;
      console.log(`Generated audio from ${originalLength} chars using ${chunks} chunks`);
    }

    // Save audio file
    const audioDir = path.join(process.cwd(), 'public', 'audio');
    await fs.mkdir(audioDir, { recursive: true });

    const audioFilename = `article_${contentId}_${Date.now()}.mp3`;
    const audioPath = path.join(audioDir, audioFilename);
    await fs.writeFile(audioPath, audioBuffer);

    // Construct full URL for audio file
    const backendUrl = process.env.BACKEND_URL || process.env.RAILWAY_PUBLIC_DOMAIN
      ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
      : 'http://localhost:3001';
    const audioUrl = `${backendUrl}/audio/${audioFilename}`;

    // Update content item with audio URL and chunk metadata
    await query(
      'UPDATE content_items SET audio_url = $1, tts_chunks = $2 WHERE id = $3',
      [audioUrl, JSON.stringify(chunkMetadata), contentId]
    );

    return { audioUrl, warning };
  } catch (error) {
    console.error('Error generating audio for content:', error);
    throw error;
  }
}
