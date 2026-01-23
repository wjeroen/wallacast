import fs from 'fs/promises';
import path from 'path';
import ffmpeg from 'fluent-ffmpeg';
import { query } from '../database/db.js';
import { getAudioDir, getTempDir } from '../config/storage.js';
import { getAudioDuration } from './audio-utils.js';
import { PROCESSING_CONFIG } from '../config/processing.js';
import { getOpenAIClientForUser } from './ai-providers.js';

interface Comment {
  username: string;
  date?: string;
  karma?: number;
  agree_votes?: number;
  disagree_votes?: number;
  content: string;
  replies?: Comment[];
}

export async function extractArticleContent(htmlContent: string, commentsHtmlOrContentId?: string | number, contentId?: number, userId?: number): Promise<{ content: string; comments?: Comment[] }> {
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
    // If userId not provided, try to get it from contentId
    let effectiveUserId = userId;
    if (!effectiveUserId && actualContentId) {
      console.log('[Extract Content] Looking up user_id for content item:', actualContentId);
      const contentResult = await query('SELECT user_id FROM content_items WHERE id = $1', [actualContentId]);
      console.log('[Extract Content] Query result:', contentResult.rows);
      effectiveUserId = contentResult.rows[0]?.user_id;
      console.log('[Extract Content] Effective user ID:', effectiveUserId);
    }

    if (!effectiveUserId) {
      throw new Error('User ID is required to extract article content. Please set your OpenAI API key in Settings.');
    }

    const openai = await getOpenAIClientForUser(effectiveUserId);
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
7. For EACH comment (including nested replies), extract ONCE and ONLY ONCE:
   - Username, date, karma, agree/disagree votes (look for numbers near usernames, vote buttons, or patterns like "15 karma • 3 agree • 1 disagree")
   - Format as: "[Username] commented on [date] with [X] karma, [Y] agree votes, and [Z] disagree votes: [comment text]"
   - For replies: "A reply to this comment by [username] on [date] with [X] karma, [Y] agree votes, and [Z] disagree votes: [comment text]"
8. Include ALL comments and nested replies in conversation order - do not cut off early
9. IMPORTANT: Look carefully for vote/karma numbers in the HTML - they're usually in spans or divs near the comment header
10. If karma/votes aren't visible in HTML, just use: "[Username] commented on [date]: [comment text]"
11. CRITICAL: Each comment should appear exactly once - do NOT repeat or duplicate comments

Return: Main article body, then complete comments section with ALL comments (each listed exactly once) and all available metadata.`,
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

    // Extract structured comments if comments HTML was provided
    let structuredComments: Comment[] | undefined;
    if (commentsHtml) {
      try {
        console.log('Extracting structured comments data...');

        // Retry logic for comments extraction
        let commentRetries = 5;
        let commentDelay = 1000;
        let commentsResponse: any = null;

        while (commentRetries > 0) {
          try {
            commentsResponse = await openai.chat.completions.create({
              model: 'gpt-5-mini-2025-08-07',
              messages: [
                {
                  role: 'developer',
                  content: `You are a comments extraction assistant. Extract comment data from HTML and return it as a JSON array.

For EACH comment (including nested replies), extract:
- username: The comment author's username (required)
- date: When the comment was posted (if available, format: YYYY-MM-DD or readable date)
- karma: The INDIVIDUAL COMMENT's karma/upvote count (if available, as a number - look for:
  * Small numbers (typically 0-50 for individual comments) near the comment header
  * Numbers in spans/divs with classes like "karma", "vote", "points", "score" WITHIN the comment container
  * Numbers near up/down arrow buttons for THAT SPECIFIC comment
  * Patterns like "15 points" or "+15" near the comment username (not the post author)
  * Data attributes like data-karma or data-score on the comment element
  * IMPORTANT: Do NOT use the post's karma (which is much higher, like 300+). Comment karma is usually much smaller.
- agree_votes: Number of agree votes FOR THIS COMMENT (if available, as a number - look for:
  * Small numbers (typically 0-20) near green checkmark/agree buttons WITHIN this comment
  * Text like "5 agree", "+5", or "✓ 5" in the comment's vote section
  * Spans with classes like "agree", "agreement-count" for THIS comment only
  * NOT the post's agree votes - look only within this comment's HTML
- disagree_votes: Number of disagree votes FOR THIS COMMENT (if available, as a number - look for:
  * Small numbers (typically 0-10) near red X/disagree buttons WITHIN this comment
  * Text like "2 disagree", "-2", or "✗ 2" in the comment's vote section
  * Spans with classes like "disagree", "disagreement-count" for THIS comment only
  * NOT the post's disagree votes - look only within this comment's HTML
- content: The comment text (clean, no HTML, preserve paragraph breaks)
- replies: Array of nested reply comments with the same structure

IMPORTANT:
- Extract ALL comments from the HTML, don't stop early
- Each comment has its OWN vote counts - don't reuse the post's votes or other comments' votes
- Comment karma/votes are typically MUCH SMALLER than post karma (individual comments rarely exceed 50 karma)
- If you see large numbers like 300+, that's likely the POST karma, not a comment's karma
- Check for vote data ONLY within each comment's container/div, not at the page level
- If you can't find a metadata field after thorough searching WITHIN that comment's HTML, omit it (don't use null or 0)
- Preserve the hierarchical structure of replies
- CRITICAL: Identify comment boundaries by HTML container elements (div/article tags with comment classes)
- QUOTES/BLOCKQUOTES WITHIN A COMMENT are PART OF THAT COMMENT'S CONTENT - do not treat them as separate comments
- Only extract text that belongs to each comment's author - quoted text from others should be included in the "content" field of the comment that contains the quote

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
                  content: `Extract ALL comments from this HTML.

CRITICAL: The vote data is located in the __APOLLO_STATE__ JSON block within a <script> tag. Look for entries like:
- Comment IDs: "Comment:xxxxx" containing "baseScore" and "extendedScore":{"agree":X,"disagree":Y}
- Post data: "Post:xxxxx" containing vote counts

Example from the JSON:
"Comment:tqwACbJGbgXwwrLWg": {"baseScore":35,"extendedScore":{"agree":11,"disagree":1}}

Use this JSON data to get accurate vote counts. If the JSON is present, prioritize it over HTML elements.

HTML to extract:\n\n${commentsHtml.slice(0, 100000)}`,
                },
              ],
              temperature: 0.2,
              reasoning_effort: 'low', // 'low' is the fastest supported setting for gpt-5-mini (supports: low, medium, high)
              max_completion_tokens: 128000, // GPT-5-mini supports up to 128k output tokens
            } as any); // Cast to any to bypass SDK 4.24.1 type restrictions
            break;
          } catch (error: any) {
            if (error.status === 429 && commentRetries > 1) {
              console.log(`Rate limit hit on comments extraction, retrying in ${commentDelay/1000}s... (${commentRetries - 1} retries left)`);
              await new Promise(resolve => setTimeout(resolve, commentDelay));
              commentDelay = Math.min(commentDelay * 2, 30000);
              commentRetries--;
            } else {
              throw error;
            }
          }
        }

        if (!commentsResponse) {
          throw new Error('Failed to extract comments after retries');
        }

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
  userId: number,
  options: {
    voice?: 'alloy' | 'echo' | 'fable' | 'onyx' | 'nova' | 'shimmer' | 'coral';
    instructions?: string;
    contentId?: number;
  } = {}
): Promise<{ buffer: Buffer; chunks: number; chunkMetadata: ChunkMetadata[] }> {
  try {
    const openai = await getOpenAIClientForUser(userId);
    if (!openai) {
      throw new Error('OpenAI API key not set. Please set your OpenAI API key in Settings.');
    }

    const voice = options.voice || PROCESSING_CONFIG.tts.voice;
    const instructions =
      options.instructions ||
      'Read this article clearly and naturally. Focus on the main content. Use appropriate pacing and emphasis for readability.';

    // Split text into chunks that fit within OpenAI's 4096 character limit
    const textChunks = splitTextIntoChunks(articleText, PROCESSING_CONFIG.tts.chunkSize);
    console.log(`Generating TTS audio with gpt-4o-mini-tts for ${textChunks.length} chunk(s)...`);

    // Calculate word positions for the full text
    const allWords = articleText.split(/\s+/);

    if (textChunks.length === 1) {
      // Single chunk - simple case with retry logic
      console.log(`Single chunk (${textChunks[0].length} chars)`);

      let retries = PROCESSING_CONFIG.retry.maxAttempts;
      let delay = PROCESSING_CONFIG.retry.baseDelayMs;
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
            delay = Math.min(delay * 2, PROCESSING_CONFIG.retry.maxDelayMs);
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
        let retries = PROCESSING_CONFIG.retry.maxAttempts;
        let delay = PROCESSING_CONFIG.retry.baseDelayMs;
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
              delay = Math.min(delay * 2, PROCESSING_CONFIG.retry.maxDelayMs);
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

    let textToConvert = '';

    if (content.type === 'article') {
      // Check if content was already extracted by Wallacast (e.g., during regeneration)
      if (content.content_source === 'wallacast' && content.content) {
        console.log(`✓ Using existing Wallacast-extracted content for article ${contentId} (skipping re-extraction)`);

        // Strip the wallacast-generated marker and use the content as-is
        let existingContent = content.content;
        existingContent = existingContent.replace(/^<!-- wallacast-generated:.*?-->\n/, '');

        // Strip the display intro (title + metadata) to get just the article text
        // The display intro follows this format:
        // # Title
        // *metadata*
        // ---
        // [actual content starts here]
        const introEndMarker = /^#.*?\n\n.*?\n\n---\n\n/s;
        existingContent = existingContent.replace(introEndMarker, '');

        textToConvert = existingContent;

        // Update status to show we're using existing content
        await query(
          'UPDATE content_items SET generation_status = $1, current_operation = $2, generation_progress = $3 WHERE id = $4',
          ['content_ready', 'audio_generation', 15, contentId]
        );
      } else {
        // Content is from Wallabag or needs extraction - extract from HTML
        console.log(`Extracting fresh content from HTML for article ${contentId} (source: ${content.content_source || 'unknown'})`);

        // CRITICAL: Only extract from html_content (raw HTML), never from content (already formatted)
        // Passing formatted content to extraction causes LLM to duplicate/repeat comments
        if (!content.html_content) {
          throw new Error(`Cannot extract content for article ${contentId}: html_content is missing. Use existing content or regenerate from URL.`);
        }

        // Update status to show content extraction is in progress
        await query(
          'UPDATE content_items SET generation_status = $1, current_operation = $2, generation_progress = $3 WHERE id = $4',
          ['extracting_content', 'extracting_article_text', 10, contentId]
        );

        // Extract clean content from HTML (with comments for audio)
        const extracted = await extractArticleContent(content.html_content, contentId);
        textToConvert = extracted.content;

        // Build intro for display (shown at top of content)
        let displayIntro = '';
        if (content.title) {
          displayIntro = `# ${content.title}\n\n`;

          const metadataParts: string[] = [];
          if (content.author) {
            metadataParts.push(`By ${content.author}`);
          }
          if (content.published_at) {
            const date = new Date(content.published_at);
            const formattedDate = date.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
            metadataParts.push(formattedDate);
          }
          if (content.karma !== undefined && content.karma !== null) {
            metadataParts.push(`${content.karma} karma`);
          }
          if (content.agree_votes !== undefined && content.agree_votes !== null) {
            metadataParts.push(`${content.agree_votes} agree`);
          }
          if (content.disagree_votes !== undefined && content.disagree_votes !== null) {
            metadataParts.push(`${content.disagree_votes} disagree`);
          }

          if (metadataParts.length > 0) {
            displayIntro += `*${metadataParts.join(' • ')}*\n\n---\n\n`;
          }
        }

        // Update the content field with intro + extracted content and store structured comments
        const updates: string[] = [];
        const values: any[] = [];
        let paramCount = 1;

        // Add Wallacast provenance marker to content
        const markedContent = `<!-- wallacast-generated:${new Date().toISOString()} -->\n${displayIntro}${extracted.content}`;

        updates.push(`content = $${paramCount}`);
        values.push(markedContent);
        paramCount++;

        // Mark content source as wallacast (generated by us)
        updates.push(`content_source = $${paramCount}`);
        values.push('wallacast');
        paramCount++;

        // Update status to show content is ready to read
        updates.push(`generation_status = $${paramCount}`);
        values.push('content_ready');
        paramCount++;

        updates.push(`current_operation = $${paramCount}`);
        values.push('audio_generation');
        paramCount++;

        if (extracted.comments && extracted.comments.length > 0) {
          updates.push(`comments = $${paramCount}`);
          values.push(JSON.stringify(extracted.comments));
          paramCount++;
          console.log(`Storing ${extracted.comments.length} structured comments`);
        }

        values.push(contentId);
        await query(
          `UPDATE content_items SET ${updates.join(', ')} WHERE id = $${paramCount}`,
          values
        );

        console.log(`✓ Content extracted and ready to read for article ${contentId}`);
      }
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
      }
      if (content.published_at) {
        const date = new Date(content.published_at);
        const formattedDate = date.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
        introParts.push(`posted on ${formattedDate}`);
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
    const { buffer: audioBuffer, chunks, chunkMetadata } = await generateArticleAudio(fullText, content.user_id, {
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

    // Store audio data directly in database
    console.log(`Storing audio in database (${(audioBuffer.length / 1024 / 1024).toFixed(2)} MB)`);

    // Get duration from audio buffer
    const tempDir = getTempDir();
    const tempFilePath = path.join(tempDir, `temp_duration_${contentId}.mp3`);
    let audioDuration = 0;

    try {
      // Write buffer to temp file to get duration
      await fs.writeFile(tempFilePath, audioBuffer);
      audioDuration = Math.floor(await getAudioDuration(tempFilePath));
      console.log(`Audio duration: ${audioDuration} seconds`);
    } catch (error) {
      console.error('Failed to get audio duration:', error);
      // Continue without duration rather than failing
    } finally {
      // Clean up temp file
      try {
        await fs.unlink(tempFilePath);
      } catch (error) {
        // Ignore cleanup errors
      }
    }

    // Construct audio URL pointing to database endpoint
    const backendUrl = process.env.BACKEND_URL
      || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : null)
      || `http://localhost:3001`;
    const audioUrl = `${backendUrl}/api/content/${contentId}/audio`;

    // Update content item with audio data, URL, duration, file size, and chunk metadata
    const fileSize = audioBuffer.length;
    await query(
      'UPDATE content_items SET audio_data = $1, audio_url = $2, duration = $3, file_size = $4, tts_chunks = $5 WHERE id = $6 AND user_id = $7',
      [audioBuffer, audioUrl, audioDuration, fileSize, JSON.stringify(chunkMetadata), contentId, content.user_id]
    );

    console.log(`✓ Audio stored in database for content ${contentId}`);

    return { audioUrl, warning };
  } catch (error) {
    console.error('Error generating audio for content:', error);
    throw error;
  }
}
