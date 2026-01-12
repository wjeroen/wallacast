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

interface Comment {
  username: string;
  date?: string;
  karma?: number;
  agree_votes?: number;
  disagree_votes?: number;
  content: string;
  replies?: Comment[];
}

export async function extractArticleContent(htmlContent: string, commentsHtml?: string): Promise<{ content: string; comments?: Comment[] }> {
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

    const response = await openai.chat.completions.create({
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

    const cleanContent = response.choices[0]?.message?.content || '';

    // Extract structured comments if comments HTML was provided
    let structuredComments: Comment[] | undefined;
    if (commentsHtml) {
      try {
        console.log('Extracting structured comments data...');
        const commentsResponse = await openai.chat.completions.create({
          model: 'gpt-4o-mini',
          messages: [
            {
              role: 'system',
              content: `You are a comments extraction assistant. Extract comment data from HTML and return it as a JSON array.

For EACH comment (including nested replies), extract:
- username: The comment author's username (required)
- date: When the comment was posted (if available, format: YYYY-MM-DD or readable date)
- karma: The comment's karma/upvote count (if available, as a number - look for numbers near vote buttons or user info)
- agree_votes: Number of agree votes (if available, as a number - often shown as "+X" or "X agree")
- disagree_votes: Number of disagree votes (if available, as a number - often shown as "-X" or "X disagree")
- content: The comment text (clean, no HTML, preserve paragraph breaks)
- replies: Array of nested reply comments with the same structure

IMPORTANT:
- Extract ALL comments from the HTML, don't stop early
- Look carefully for karma/vote numbers - they're often in spans, divs, or near voting buttons
- If you can't find a metadata field, omit it (don't use null or 0)
- Preserve the hierarchical structure of replies

Return ONLY a valid JSON array of comment objects, nothing else. If no comments found, return an empty array [].

Example format:
[
  {
    "username": "john_doe",
    "date": "2024-01-15",
    "karma": 42,
    "agree_votes": 5,
    "disagree_votes": 1,
    "content": "This is a great article!",
    "replies": [
      {
        "username": "jane_smith",
        "date": "2024-01-16",
        "karma": 15,
        "content": "I agree with this point."
      }
    ]
  }
]`,
            },
            {
              role: 'user',
              content: `Extract ALL comments from this HTML. Make sure to get every single comment, don't cut off early:\n\n${commentsHtml.slice(0, 100000)}`,
            },
          ],
          temperature: 0.2,
          max_tokens: 16384, // Max tokens for gpt-4o-mini to capture all comments
        });

        let commentsJson = commentsResponse.choices[0]?.message?.content || '[]';

        // Remove markdown code blocks if GPT wrapped the JSON
        commentsJson = commentsJson.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();

        // Parse the JSON response
        try {
          structuredComments = JSON.parse(commentsJson);
          console.log(`Extracted ${structuredComments?.length || 0} structured comments`);
          if (structuredComments && structuredComments.length > 0) {
            console.log('Sample comment:', JSON.stringify(structuredComments[0], null, 2));
          }
        } catch (parseError) {
          console.error('Failed to parse comments JSON:', parseError);
          console.error('Raw JSON:', commentsJson.substring(0, 500));
          // Continue without structured comments
        }
      } catch (error) {
        console.error('Error extracting structured comments:', error);
        // Continue without structured comments
      }
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
      const extracted = await extractArticleContent(content.html_content || content.content);
      textToConvert = extracted.content;

      // Store structured comments if extracted
      if (extracted.comments && extracted.comments.length > 0) {
        await query(
          'UPDATE content_items SET comments = $1 WHERE id = $2',
          [JSON.stringify(extracted.comments), contentId]
        );
      }
    } else {
      textToConvert = content.content || '';
    }

    if (!textToConvert) {
      throw new Error('No content to convert to audio');
    }

    // Add intro with title, author, date, and EA Forum metadata (if available)
    let intro = '';
    if (content.title) {
      intro = `This post is titled: ${content.title}`;

      if (content.author) {
        intro += `, written by ${content.author}`;
      }

      // Add published date if available
      if (content.published_at) {
        const date = new Date(content.published_at);
        const formattedDate = date.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
        intro += `, posted on the EA Forum on ${formattedDate}`;
      }

      // Add EA Forum metadata if available (from stored fields)
      if (content.karma !== undefined && content.karma !== null) {
        intro += `. It has ${content.karma} karma`;

        // Add agree/disagree votes if available
        if (content.agree_votes !== undefined && content.agree_votes !== null) {
          intro += `, ${content.agree_votes} agree votes`;
        }

        if (content.disagree_votes !== undefined && content.disagree_votes !== null) {
          intro += `, and ${content.disagree_votes} disagree votes`;
        }

        intro += '.';
      } else {
        intro += '.';
      }

      intro += '\n\n';
    }

    // Prepend intro to content
    const fullText = intro + textToConvert;
    const originalLength = fullText.length;

    // Generate audio (with chunking for long articles)
    const { buffer: audioBuffer, chunks, chunkMetadata } = await generateArticleAudio(fullText, {
      instructions:
        'You are reading an article aloud with comments. Start with the title and author introduction if present, then read the article body, then read the comments section. Do not read out URL strings (like https://example.com), but you can say the word "link" when it appears naturally in text. For comments, ALWAYS read the username, karma/upvotes, agree votes, and disagree votes if they are mentioned in the text - these numbers are important context. Read them naturally like "John Doe commented with 42 karma, 5 agree votes, and 2 disagree votes". Use appropriate pacing and natural emphasis.',
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
