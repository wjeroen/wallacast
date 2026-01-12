import OpenAI from 'openai';
import fs from 'fs/promises';
import path from 'path';
import ffmpeg from 'fluent-ffmpeg';
import { query } from '../database/db.js';
import { getAudioDir, getTempDir } from '../config/storage.js';

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

interface Comment {
  username: string;
  date?: string;
  karma?: number;
  agree_votes?: number;
  disagree_votes?: number;
  content: string;
  replies?: Comment[];
}

export async function extractArticleContent(htmlContent: string, commentsHtmlOrContentId?: string | number, contentId?: number, preExtractedComments?: Comment[]): Promise<{ content: string; comments?: Comment[] }> {
  // Handle overloaded parameters
  let commentsHtml: string | undefined;
  let actualContentId: number | undefined;

  if (typeof commentsHtmlOrContentId === 'number') {
    actualContentId = commentsHtmlOrContentId;
  } else {
    commentsHtml = commentsHtmlOrContentId;
    actualContentId = contentId;
  }
  try {
    const openai = await getOpenAIClient();
    if (!openai) {
      console.warn('OpenAI API key not set, returning raw HTML content');
      const fallbackContent = htmlContent.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      return { content: fallbackContent };
    }

    // Use GPT-4o-mini to extract and format article content for audio reading
    // Increase limit to 150k characters to avoid cutting off comments
    const htmlToSend = htmlContent.slice(0, 150000);

    // Build the user prompt with separate sections for better extraction
    let userPrompt = `Extract the main article content from this HTML for reading. Remember: NEVER include actual URL strings (like https://...) even if they exist in href attributes.\n\nMain HTML:\n\n${htmlToSend}`;

    // Add comments HTML separately if provided (better for extraction)
    if (commentsHtml) {
      const commentsToSend = commentsHtml.slice(0, 100000);
      userPrompt += `\n\nComments Section HTML:\n\n${commentsToSend}`;
    }

    // Retry logic for content extraction with exponential backoff
    let retries = 5;
    let delay = 1000;
    let response: any = null;

    while (retries > 0) {
      try {
        response = await openai.chat.completions.create({
          model: 'gpt-4o-mini',
          messages: [
            {
              role: 'system',
              content: `You are a content extraction assistant that formats web content for text-to-speech reading.

Extract and format content following these rules:

**IMPORTANT: Do NOT include post metadata intro (title, author, date, karma) - that will be added separately. Start directly with the main article content.**

**Main Content:**
1. Extract article body, removing navigation, ads, footers, headers, "Share" buttons, newsletter prompts
2. NEVER extract actual URL strings from href/src attributes
   - For links: keep anchor text only (e.g., "click here" but not "https://example.com")
   - Don't say URLs aloud, but you can say "link" when it appears naturally in text
3. For visual elements:
   - Images: Say "The article shows an image here" or describe if alt text exists
   - Tables: Say "The article contains a table" then describe headers/key data if readable
   - Videos/embeds: Say "The article links to a video here" (don't read the URL)
4. Replace HTML entities (&#x27; → apostrophe, etc.) with proper characters
5. Format lists and structure naturally for speaking

**Comments Section:**
6. After main article, say "Comments section:"
7. For EACH comment (including nested replies), extract:
   - Username, date, karma, agree/disagree votes (look for numbers near usernames, vote buttons, or patterns like "15 karma • 3 agree • 1 disagree")
   - Format as: "[Username] commented on [date] with [X] karma, [Y] agree votes, and [Z] disagree votes: [comment text]"
   - For replies: "A reply to this comment by [username] on [date] with [X] karma, [Y] agree votes, and [Z] disagree votes: [comment text]"
8. Include ALL comments and nested replies in conversation order - do not cut off early
9. IMPORTANT: Look carefully for vote/karma numbers in the HTML - they're usually in spans or divs near the comment header
10. If karma/votes aren't visible in HTML, just use: "[Username] commented on [date]: [comment text]"

Return: Main article body, then complete comments section with ALL comments and all available metadata.`,
            },
            {
              role: 'user',
              content: userPrompt,
            },
          ],
          temperature: 0.3,
          max_tokens: 16384, // Max tokens for gpt-4o-mini
        });
        break;
      } catch (error: any) {
        if (error.status === 429 && retries > 1) {
          console.log(`Rate limit hit on content extraction, retrying in ${delay/1000}s... (${retries - 1} retries left)`);
          await new Promise(resolve => setTimeout(resolve, delay));
          delay = Math.min(delay * 2, 30000);
          retries--;
        } else {
          throw error;
        }
      }
    }

    if (!response) {
      throw new Error('Failed to extract content after retries');
    }

    const cleanContent = response.choices[0]?.message?.content || '';

    // Update progress after main content extraction
    if (actualContentId) {
      await query(
        'UPDATE content_items SET generation_progress = $1, current_operation = $2 WHERE id = $3',
        [30, 'extracting_comments', actualContentId]
      );
    }

    // Use pre-extracted comments if provided, otherwise skip GPT extraction
    // Comments are now extracted at fetch time using DOM selectors in article-fetcher.ts
    let structuredComments: Comment[] | undefined = preExtractedComments;

    if (structuredComments && structuredComments.length > 0) {
      console.log(`Using ${structuredComments.length} pre-extracted comments from DOM parsing`);
      if (structuredComments[0]) {
        console.log('Sample comment:', JSON.stringify(structuredComments[0], null, 2));
      }
    } else if (commentsHtml) {
      console.log('No pre-extracted comments available, comments will only appear in TTS audio');
    }

    return { content: cleanContent, comments: structuredComments };
  } catch (error) {
    console.error('Error extracting article content:', error);
    // Fallback: strip HTML tags
    const fallbackContent = htmlContent.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    return { content: fallbackContent };
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
    // Using 3500 to leave buffer for any encoding or special characters
    const textChunks = splitTextIntoChunks(articleText, 3500);
    console.log(`Generating TTS audio with gpt-4o-mini-tts for ${textChunks.length} chunk(s)...`);

    // Calculate word positions for the full text
    const allWords = articleText.split(/\s+/);

    if (textChunks.length === 1) {
      // Single chunk - simple case with retry logic
      console.log(`Single chunk (${textChunks[0].length} chars)`);

      let retries = 5;
      let delay = 1000;
      let response: any = null;

      while (retries > 0) {
        try {
          response = await openai.audio.speech.create({
            model: 'gpt-4o-mini-tts',
            voice: voice,
            input: textChunks[0],
            instructions: instructions,
          });
          break;
        } catch (error: any) {
          if (error.status === 429 && retries > 1) {
            console.log(`Rate limit hit, retrying in ${delay/1000}s... (${retries - 1} retries left)`);
            await new Promise(resolve => setTimeout(resolve, delay));
            delay = Math.min(delay * 2, 30000);
            retries--;
          } else {
            throw error;
          }
        }
      }

      if (!response) {
        throw new Error('Failed to generate audio after retries');
      }

      const buffer = Buffer.from(await response.arrayBuffer());

      // Save temp file to get duration
      const tempDir = getTempDir();
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
    const tempDir = getTempDir();
    await fs.mkdir(tempDir, { recursive: true });

    const chunkFiles: string[] = [];
    const chunkMetadata: ChunkMetadata[] = [];
    const timestamp = Date.now();
    let currentWordIndex = 0;
    let currentTime = 0;

    try {
      // Generate audio for each chunk with rate limiting
      for (let i = 0; i < textChunks.length; i++) {
        console.log(`Generating chunk ${i + 1}/${textChunks.length} (${textChunks[i].length} chars)...`);

        // Update progress (90% for chunk generation, 10% for concatenation)
        const chunkProgress = Math.round(((i + 1) / textChunks.length) * 90);
        if (options.contentId) {
          await query(
            'UPDATE content_items SET generation_progress = $1, current_operation = $2 WHERE id = $3',
            [chunkProgress, `audio_chunk_${i + 1}_of_${textChunks.length}`, options.contentId]
          );
        }

        // Retry logic with exponential backoff for rate limits
        let retries = 5;
        let delay = 1000; // Start with 1 second
        let response: any = null;

        while (retries > 0) {
          try {
            response = await openai.audio.speech.create({
              model: 'gpt-4o-mini-tts',
              voice: voice,
              input: textChunks[i],
              instructions: instructions,
            });
            break; // Success, exit retry loop
          } catch (error: any) {
            if (error.status === 429 && retries > 1) {
              // Rate limit hit, wait and retry
              console.log(`Rate limit hit on chunk ${i + 1}, retrying in ${delay/1000}s... (${retries - 1} retries left)`);
              await new Promise(resolve => setTimeout(resolve, delay));
              delay = Math.min(delay * 2, 30000); // Exponential backoff, max 30s
              retries--;
            } else {
              // Other error or out of retries, throw
              throw error;
            }
          }
        }

        if (!response) {
          throw new Error(`Failed to generate chunk ${i + 1} after retries`);
        }

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

        // Add delay between chunks to respect rate limits (except for last chunk)
        if (i < textChunks.length - 1) {
          const delayMs = 200; // 200ms delay between chunks (retry logic handles rate limits)
          await new Promise(resolve => setTimeout(resolve, delayMs));
        }
      }

      // Concatenate all chunks
      const outputFile = path.join(tempDir, `concatenated_${timestamp}.mp3`);
      console.log(`Concatenating ${chunkFiles.length} audio files...`);

      // Update progress to 95% before concatenation
      if (options.contentId) {
        await query(
          'UPDATE content_items SET generation_progress = $1, current_operation = $2 WHERE id = $3',
          [95, 'concatenating_audio', options.contentId]
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

    console.log('=== Content metadata debug ===');
    console.log('Title:', content.title);
    console.log('Author:', content.author);
    console.log('Published:', content.published_at);
    console.log('Karma:', content.karma);
    console.log('Agree votes:', content.agree_votes);
    console.log('Disagree votes:', content.disagree_votes);
    console.log('Pre-extracted comments:', content.comments ? 'Yes' : 'No');
    console.log('==============================');

    let textToConvert = '';

    if (content.type === 'article') {
      // Content is already clean and ready from Readability + formatted comments
      // No GPT chat model extraction needed!
      textToConvert = content.content || '';

      // Update status to show content is ready for audio generation
      await query(
        'UPDATE content_items SET generation_status = $1, current_operation = $2, generation_progress = $3 WHERE id = $4',
        ['content_ready', 'audio_generation', 15, contentId]
      );

      console.log(`✓ Content is ready for TTS (Readability + formatted comments)`);
    } else {
      textToConvert = content.content || '';
    }

    if (!textToConvert) {
      throw new Error('No content to convert to audio');
    }

    // Add intro with title, author, date, and EA Forum metadata (if available) for TTS
    let intro = '';
    if (content.title) {
      intro = `This post is titled: ${content.title}`;

      // Add author and date
      const introParts: string[] = [];
      if (content.author) {
        introParts.push(`written by ${content.author}`);
        console.log('✓ Including author in TTS:', content.author);
      } else {
        console.log('⚠ No author found in content object');
      }
      if (content.published_at) {
        const date = new Date(content.published_at);
        const formattedDate = date.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
        introParts.push(`posted on ${formattedDate}`);
        console.log('✓ Including date in TTS:', formattedDate);
      } else {
        console.log('⚠ No published_at found in content object');
      }
      if (introParts.length > 0) {
        intro += `, ${introParts.join(', ')}`;
      }

      // Add EA Forum metadata if available (from stored fields)
      if (content.karma !== undefined && content.karma !== null) {
        intro += `. It has ${content.karma} karma`;

        // Add agree/disagree votes if available
        if (content.agree_votes !== undefined && content.agree_votes !== null) {
          intro += `, ${content.agree_votes} agree votes`;
          console.log('✓ Including agree votes in TTS:', content.agree_votes);
        } else {
          console.log('⚠ No agree_votes found');
        }

        if (content.disagree_votes !== undefined && content.disagree_votes !== null) {
          intro += `, and ${content.disagree_votes} disagree votes`;
          console.log('✓ Including disagree votes in TTS:', content.disagree_votes);
        } else {
          console.log('⚠ No disagree_votes found');
        }

        intro += '.';
      } else {
        intro += '.';
      }

      intro += '\n\n';
    }

    console.log('=== Final TTS Intro ===');
    console.log(intro);
    console.log('=======================');

    // Prepend intro to content
    const fullText = intro + textToConvert;
    const originalLength = fullText.length;

    // Generate audio (with chunking for long articles)
    // Trust the TTS model to read the pre-formatted content naturally
    const { buffer: audioBuffer, chunks, chunkMetadata } = await generateArticleAudio(fullText, {
      instructions:
        'You are a professional narrator reading an article exactly as written. Read all text including titles, metadata, article body, and comments section completely and naturally. When you encounter a username followed by "with X karma, Y agree votes, Z disagree votes:", read the full phrase including all numbers - these are important metadata. Do not skip, summarize, or omit any part of the text. For URLs, say "link" instead of reading the full address. Maintain steady, clear pacing throughout.',
      contentId: contentId, // Pass contentId for progress tracking
    });

    // Generate info message about chunks if multiple were used
    let warning: string | undefined;
    if (chunks > 1) {
      const estimatedMinutes = Math.round(originalLength / 900); // ~900 chars/minute for TTS
      warning = `Generated complete audio in ${chunks} parts (~${estimatedMinutes} minutes). The full article has been converted to audio.`;
      console.log(`Generated audio from ${originalLength} chars using ${chunks} chunks`);
    }

    // Store audio data directly in database
    console.log(`Storing audio in database (${(audioBuffer.length / 1024 / 1024).toFixed(2)} MB)`);

    // Construct audio URL pointing to database endpoint
    const backendUrl = process.env.BACKEND_URL || process.env.RAILWAY_PUBLIC_DOMAIN
      ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
      : 'http://localhost:3001';
    const audioUrl = `${backendUrl}/api/content/${contentId}/audio`;

    // Update content item with audio data, URL, and chunk metadata
    await query(
      'UPDATE content_items SET audio_data = $1, audio_url = $2, tts_chunks = $3 WHERE id = $4',
      [audioBuffer, audioUrl, JSON.stringify(chunkMetadata), contentId]
    );

    console.log(`✓ Audio stored in database for content ${contentId}`);

    return { audioUrl, warning };
  } catch (error) {
    console.error('Error generating audio for content:', error);
    throw error;
  }
}
