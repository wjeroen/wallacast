import express from 'express';
import path from 'path';
import { query } from '../database/db.js';
import { fetchArticleContent } from '../services/article-fetcher.js';
// CHANGED: Removed unused 'extractArticleContent' from import
import { generateAudioForContent } from '../services/openai-tts.js';
import { transcribeWithTimestamps } from '../services/transcription.js';
import { getUserSetting } from '../services/ai-providers.js';
import { generateLLMAlignment } from '../services/llm-alignment.js';

const router = express.Router();

// Get all content items (excluding audio_data for performance)
router.get('/', async (req, res) => {
  try {
    const { type, archived, starred } = req.query;

    // Exclude large columns (html_content, comments, transcript) for performance
    let sql = 'SELECT id, type, title, url, content, author, description, preview_picture, audio_url, duration, file_size, podcast_id, podcast_show_name, episode_number, published_at, is_starred, is_archived, tags, playback_position, playback_speed, last_played_at, created_at, updated_at, generation_status, generation_progress, generation_error, current_operation, tts_chunks, transcript_words, karma, agree_votes, disagree_votes FROM content_items WHERE user_id = $1';
    const params: any[] = [req.user!.userId];
    let paramCount = 2;

    if (type) {
      sql += ` AND type = $${paramCount}`;
      params.push(type);
      paramCount++;
    }

    if (archived !== undefined) {
      sql += ` AND is_archived = $${paramCount}`;
      params.push(archived === 'true');
      paramCount++;
    }

    if (starred !== undefined) {
      sql += ` AND is_starred = $${paramCount}`;
      params.push(starred === 'true');
      paramCount++;
    }

    sql += ' ORDER BY created_at DESC';
    
    const result = await query(sql, params);
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching content:', error);
    res.status(500).json({ error: 'Failed to fetch content' });
  }
});

// Get single content item (includes large columns needed for display)
router.get('/:id', async (req, res) => {
  try {
    const result = await query(
      'SELECT id, type, title, url, content, html_content, author, description, preview_picture, audio_url, transcript, duration, file_size, podcast_id, podcast_show_name, episode_number, published_at, is_starred, is_archived, tags, playback_position, playback_speed, last_played_at, created_at, updated_at, generation_status, generation_progress, generation_error, current_operation, tts_chunks, transcript_words, content_alignment, karma, agree_votes, disagree_votes, comments, content_source FROM content_items WHERE id = $1 AND user_id = $2',
      [req.params.id, req.user!.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Content not found' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error fetching content item:', error);
    res.status(500).json({ error: 'Failed to fetch content item' });
  }
});

// Serve audio from database (PUBLIC - no auth required for HTML5 audio player compatibility)
router.get('/:id/audio', async (req, res) => {
  try {
    // Note: No user_id filter - audio URLs are public but content IDs are private
    const result = await query(
      'SELECT audio_data FROM content_items WHERE id = $1',
      [req.params.id]
    );

    if (result.rows.length === 0 || !result.rows[0].audio_data) {
      return res.status(404).json({ error: 'Audio not found' });
    }

    const audioData = result.rows[0].audio_data;
    const fileSize = audioData.length;

    // Handle range requests for seeking/streaming
    const range = req.headers.range;
    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
      const chunkSize = end - start + 1;

      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunkSize,
        'Content-Type': 'audio/mpeg',
        'Cache-Control': 'public, max-age=31536000',
      });

      res.end(audioData.slice(start, end + 1));
    } else {
      // No range request - send full file
      res.setHeader('Content-Type', 'audio/mpeg');
      res.setHeader('Content-Length', fileSize);
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Cache-Control', 'public, max-age=31536000');

      res.send(audioData);
    }
  } catch (error) {
    console.error('Error serving audio:', error);
    res.status(500).json({ error: 'Failed to serve audio' });
  }
});

// Create new content item
router.post('/', async (req, res) => {
  try {
    const {
      type,
      title,
      url,
      content,
      author,
      description,
      preview_picture,
      podcast_id,
      audio_url,
      published_at,
      duration,
    } = req.body;

    let processedContent = content;
    let htmlContent = null;
    let audioUrlValue = audio_url || null;
    let finalTitle = title;
    let finalAuthor = author;
    let finalDescription = description;
    // FIX 1: Initialize finalPreviewPicture with the value passed from frontend
    let finalPreviewPicture = preview_picture || null;
    let finalPublishedAt = published_at;
    let karma: number | null = null;
    let agreeVotes: number | null = null;
    let disagreeVotes: number | null = null;
    let extractedComments: any = null;
    let podcastShowName: string | null = null;

    // Fetch article content if URL is provided
    if (type === 'article' && url && !content) {
      const articleData = await fetchArticleContent(url);
      htmlContent = articleData.cleaned_html;
      processedContent = articleData.content;

      if ((!finalTitle || finalTitle === 'Untitled') && articleData.title) {
        finalTitle = articleData.title;
      }

      if (!finalAuthor && (articleData.author || articleData.byline)) {
        finalAuthor = articleData.author || articleData.byline;
      }

      if (!finalDescription && articleData.excerpt) {
        finalDescription = articleData.excerpt;
      }

      // FIX 2: If we don't have a picture yet, try to use the one from the scraper
      if (!finalPreviewPicture && articleData.lead_image_url) {
        finalPreviewPicture = articleData.lead_image_url;
      }

      if (!finalPublishedAt && articleData.published_date) {
        finalPublishedAt = articleData.published_date;
      }

      if (articleData.karma !== undefined) {
        karma = articleData.karma;
      }
      if (articleData.agree_votes !== undefined) {
        agreeVotes = articleData.agree_votes;
      }
      if (articleData.disagree_votes !== undefined) {
        disagreeVotes = articleData.disagree_votes;
      }

      if (articleData.comments && articleData.comments.length > 0) {
        extractedComments = JSON.stringify(articleData.comments);
      }
    }

    if (!finalTitle || finalTitle === 'Untitled') {
      finalTitle = 'Untitled Article';
    }

    // Look up podcast show name if podcast_id is provided (for podcast episodes)
    if (podcast_id) {
      const podcastResult = await query(
        'SELECT title FROM podcasts WHERE id = $1 AND user_id = $2',
        [podcast_id, req.user!.userId]
      );
      if (podcastResult.rows.length > 0) {
        podcastShowName = podcastResult.rows[0].title;
      }
    }

    // FIX 3: Use finalPreviewPicture instead of raw preview_picture
    const result = await query(
      `INSERT INTO content_items
       (type, title, url, content, html_content, author, description, preview_picture, audio_url, podcast_id, podcast_show_name, published_at, duration, karma, agree_votes, disagree_votes, comments, content_source, user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
       RETURNING *`,
      [type, finalTitle, url, processedContent, htmlContent, finalAuthor, finalDescription, finalPreviewPicture, audioUrlValue, podcast_id || null, podcastShowName, finalPublishedAt || null, duration || null, karma, agreeVotes, disagreeVotes, extractedComments, 'wallacast', req.user!.userId]
    );

    const createdItem = result.rows[0];
    
    // Auto-generate audio for articles
    if ((type === 'article' || type === 'text') && !audioUrlValue && (processedContent || htmlContent)) {
      const autoGenerateAudio = await getUserSetting(req.user!.userId, 'auto_generate_audio_for_articles');
      const shouldAutoGenerate = autoGenerateAudio === 'true';

      if (shouldAutoGenerate) {
        console.log(`Auto-generating audio for ${type} ${createdItem.id}`);

        await query(
          'UPDATE content_items SET generation_status = $1, generation_progress = $2, current_operation = $3 WHERE id = $4',
          ['starting', 0, 'initialization', createdItem.id]
        );

        generateAudioForContent(createdItem.id)
          .then(() => {
            console.log(`Audio generation pipeline started for ${createdItem.id}`);
            // Note: Final status will be set by transcription/alignment handler
          })
          .catch(async (error) => {
            console.error('Auto audio generation error:', error);
            await query(
              'UPDATE content_items SET generation_status = $1, generation_error = $2, generation_progress = $3, current_operation = NULL WHERE id = $4',
              ['failed', error.message || 'Failed to generate audio', 0, createdItem.id]
            );
          });
      }
    }

    // Auto-generate transcript for podcast episodes
    if (type === 'podcast_episode' && audioUrlValue && !createdItem.transcript) {
      const autoTranscribe = await getUserSetting(req.user!.userId, 'auto_transcribe_podcasts');
      const shouldAutoTranscribe = autoTranscribe === null || autoTranscribe === 'true';

      if (shouldAutoTranscribe) {
        console.log(`Auto-generating transcript for podcast episode ${createdItem.id}`);

        await query(
          'UPDATE content_items SET generation_status = $1, generation_progress = $2, current_operation = $3 WHERE id = $4',
          ['generating_transcript', 0, 'transcript', createdItem.id]
        );

        transcribeWithTimestamps(audioUrlValue, req.user!.userId)
          .then(async (result) => {
            await query(
              'UPDATE content_items SET transcript = $1, transcript_words = $2, generation_status = $3, generation_progress = $4, current_operation = NULL WHERE id = $5',
              [result.text, JSON.stringify(result.words), 'completed', 100, createdItem.id]
            );
          })
          .catch(async (error) => {
            console.error('Auto transcription error:', error);
            await query(
              'UPDATE content_items SET generation_status = $1, generation_error = $2, generation_progress = $3, current_operation = NULL WHERE id = $4',
              ['failed', error.message || 'Failed to transcribe', 0, createdItem.id]
            );
          });
      }
    }

    res.status(201).json(createdItem);
  } catch (error) {
    console.error('Error creating content item:', error);
    res.status(500).json({ error: 'Failed to create content item' });
  }
});

// Update content item
router.patch('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;

    const allowedFields = [
      'is_starred',
      'is_archived',
      'playback_position',
      'playback_speed',
      'last_played_at',
      'title',
      'description',
      'duration',
    ];

    if (updates.audio_data === null && updates.audio_url === null) {
      const contentResult = await query(
        'SELECT type FROM content_items WHERE id = $1 AND user_id = $2',
        [id, req.user!.userId]
      );

      if (contentResult.rows.length > 0) {
        const { type } = contentResult.rows[0];
        if (type === 'article' || type === 'text') {
          console.log(`Manually removing audio for ${type} ${id}`);
          updates.duration = null;
          allowedFields.push('audio_data', 'audio_url', 'duration');
        }
      }
    }

    if (updates.regenerate_content === true) {
      const contentResult = await query(
        'SELECT type, url, preview_picture FROM content_items WHERE id = $1 AND user_id = $2',
        [id, req.user!.userId]
      );

      if (contentResult.rows.length > 0) {
        const { type, url, preview_picture } = contentResult.rows[0];

        if (type === 'article' && url) {
          console.log(`Regenerating content for article ${id} from URL:`, url);

          (async () => {
            try {
              await query(
                'UPDATE content_items SET generation_status = $1, generation_progress = $2, current_operation = $3 WHERE id = $4',
                ['fetching', 10, 'fetching_article', id]
              );

              const articleData = await fetchArticleContent(url);

              const commentsJson = articleData.comments && articleData.comments.length > 0
                ? JSON.stringify(articleData.comments)
                : null;

              // FIX 4: Update preview_picture when regenerating content
              await query(
                `UPDATE content_items SET
                  html_content = $1,
                  content = $2,
                  author = COALESCE($3, author),
                  published_at = COALESCE($4, published_at),
                  karma = $5,
                  agree_votes = $6,
                  disagree_votes = $7,
                  comments = $8,
                  preview_picture = COALESCE($9, preview_picture),
                  content_source = 'wallacast',
                  generation_status = 'completed',
                  generation_progress = 100,
                  current_operation = NULL,
                  updated_at = NOW()
                WHERE id = $10`,
                [
                  articleData.cleaned_html,
                  articleData.content,
                  articleData.author || articleData.byline,
                  articleData.published_date,
                  articleData.karma,
                  articleData.agree_votes,
                  articleData.disagree_votes,
                  commentsJson,
                  articleData.lead_image_url || null, // Capture image on refetch
                  id
                ]
              );

              console.log(`Content refetched successfully for article ${id} (no LLM)`);
            } catch (error) {
              console.error('Content refetch error:', error);
              await query(
                'UPDATE content_items SET generation_status = $1, generation_error = $2, generation_progress = $3, current_operation = NULL WHERE id = $4',
                ['failed', (error as Error).message || 'Failed to regenerate content', 0, id]
              );
            }
          })();

          updates.generation_status = 'extracting_content';
          updates.generation_progress = 0;
          allowedFields.push('generation_status', 'generation_progress');
          delete updates.regenerate_content;
        }
      }
    }

    if (updates.regenerate_transcript === true) {
      const contentResult = await query(
        'SELECT type, audio_url, title, author, published_at, comments FROM content_items WHERE id = $1 AND user_id = $2',
        [id, req.user!.userId]
      );

      if (contentResult.rows.length > 0) {
        const { type, audio_url, title, author, comments } = contentResult.rows[0];

        if (audio_url) {
          console.log(`Regenerating transcript for ${type} ${id}`);

          // Build Whisper prompt hint for better transcription of key phrases
          let whisperPrompt = '';
          if (title) whisperPrompt += `Title: ${title}. `;
          if (author) whisperPrompt += `Written by ${author.replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu, '').trim()}. `;
          if (comments) {
            try {
              const commentsData = typeof comments === 'string' ? JSON.parse(comments) : comments;
              if (commentsData && Array.isArray(commentsData) && commentsData.length > 0) {
                whisperPrompt += 'Comments section: ';
                const username = (commentsData[0].username || 'Anonymous').replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu, '').trim();
                whisperPrompt += username;
              }
            } catch { /* ignore */ }
          }

          (async () => {
            try {
              await query(
                'UPDATE content_items SET generation_status = $1, generation_progress = $2, current_operation = $3 WHERE id = $4',
                ['generating_transcript', 0, 'transcript', id]
              );

              const result = await transcribeWithTimestamps(audio_url, req.user!.userId, whisperPrompt.slice(0, 224));

              await query(
                'UPDATE content_items SET transcript = $1, transcript_words = $2, generation_status = $3, generation_progress = $4, current_operation = NULL WHERE id = $5',
                [result.text, JSON.stringify(result.words), 'completed', 100, id]
              );

              // Run LLM alignment if html_content is available (articles/texts only, not podcasts)
              if (type === 'article' || type === 'text') {
                const contentResult = await query('SELECT html_content FROM content_items WHERE id = $1', [id]);
                if (contentResult.rows.length > 0 && contentResult.rows[0].html_content) {
                  console.log(`[LLM-Align] Running alignment for ${type} ${id}...`);
                  await query(
                    'UPDATE content_items SET generation_progress = $1, current_operation = $2 WHERE id = $3',
                    [97, 'aligning_content', id]
                  );
                  try {
                    const alignment = await generateLLMAlignment(
                      parseInt(id),
                      req.user!.userId,
                      result.words
                    );
                    await query(
                      'UPDATE content_items SET content_alignment = $1, generation_status = $2, generation_progress = $3, current_operation = NULL WHERE id = $4',
                      [JSON.stringify(alignment), 'completed', 100, id]
                    );
                    console.log(`[LLM-Align] Complete: ${alignment.elements.length} elements timestamped`);
                  } catch (alignError) {
                    console.error('[LLM-Align] Failed (non-fatal):', alignError);
                    await query(
                      'UPDATE content_items SET generation_status = $1, generation_progress = $2, current_operation = NULL WHERE id = $3',
                      ['completed', 100, id]
                    );
                  }
                }
              }

              console.log(`Transcript regenerated successfully for ${type} ${id}`);
            } catch (error) {
              console.error('Transcript regeneration error:', error);
              await query(
                'UPDATE content_items SET generation_status = $1, generation_error = $2, generation_progress = $3, current_operation = NULL WHERE id = $4',
                ['failed', (error as Error).message || 'Failed to regenerate transcript', 0, id]
              );
            }
          })();

          updates.generation_status = 'generating_transcript';
          updates.generation_progress = 0;
          allowedFields.push('generation_status', 'generation_progress');
          delete updates.regenerate_transcript;
        }
      }
    }

    if (updates.is_archived === true) {
      const contentResult = await query(
        'SELECT audio_data, type, is_starred FROM content_items WHERE id = $1 AND user_id = $2',
        [id, req.user!.userId]
      );

      if (contentResult.rows.length > 0) {
        const { audio_data, type, is_starred: dbStarred } = contentResult.rows[0];

        // CHECK IF FAVORITED IN THIS UPDATE OR PREVIOUSLY
        // If updates.is_starred is present, use it. Otherwise use DB value.
        const effectiveStarred = updates.is_starred !== undefined ? updates.is_starred : dbStarred;

        // Only delete audio for articles (not podcasts) and only if not favorited
        if (audio_data && (type === 'article' || type === 'text') && !effectiveStarred) {
          const audioSizeMB = (audio_data.length / 1024 / 1024).toFixed(2);
          console.log(`Archived: Deleting ${audioSizeMB} MB of audio data to save space`);
          updates.audio_data = null;
          updates.audio_url = null;
          updates.duration = null;
          allowedFields.push('audio_data', 'audio_url', 'duration');
        } else if (audio_data && effectiveStarred) {
          console.log(`Archived: Preserving audio for favorited item ${id}`);
        }
      }
    }

    if (updates.is_archived === false) {
      const contentResult = await query(
        'SELECT audio_url, type, html_content FROM content_items WHERE id = $1 AND user_id = $2',
        [id, req.user!.userId]
      );

      if (contentResult.rows.length > 0) {
        const { audio_url, type, html_content } = contentResult.rows[0];

        if (!audio_url && (type === 'article' || type === 'text') && html_content) {
          console.log(`Un-archiving article ${id}: triggering audio regeneration`);

          generateAudioForContent(parseInt(id))
            .then(() => {
              console.log(`Audio generation pipeline started for ${id}`);
              // Note: Final status will be set by transcription/alignment handler
            })
            .catch(async (error) => {
              console.error('Auto audio generation error on un-archive:', error);
              await query(
                'UPDATE content_items SET generation_status = $1, generation_error = $2, generation_progress = $3, current_operation = NULL WHERE id = $4',
                ['failed', error.message || 'Failed to regenerate audio', 0, id]
              );
            });

          updates.generation_status = 'starting';
          updates.generation_progress = 0;
          allowedFields.push('generation_status', 'generation_progress');
        }
      }
    }

    const setClause = [];
    const values = [];
    let paramCount = 1;

    const playbackOnlyFields = ['playback_position', 'playback_speed', 'last_played_at'];
    const updatingContentFields = Object.keys(updates).some(
      key => allowedFields.includes(key) && !playbackOnlyFields.includes(key)
    );

    for (const [key, value] of Object.entries(updates)) {
      if (allowedFields.includes(key)) {
        setClause.push(`${key} = $${paramCount}`);
        values.push(value);
        paramCount++;
      }
    }

    if (setClause.length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    if (updatingContentFields) {
      setClause.push(`updated_at = CURRENT_TIMESTAMP`);
    }

    values.push(id);
    paramCount++;
    values.push(req.user!.userId);

    // CRITICAL FIX: Never use RETURNING * — it includes audio_data (BYTEA, 10-50MB),
    // which was being sent in every response, causing ~7GB/hour of data transfer
    // during playback (saves every 10s). For playback-only updates, return minimal data.
    // For content updates, return the same columns as the list endpoint.
    const returningClause = updatingContentFields
      ? 'RETURNING id, type, title, url, content, author, description, preview_picture, audio_url, duration, file_size, podcast_id, episode_number, published_at, is_starred, is_archived, tags, playback_position, playback_speed, last_played_at, created_at, updated_at, generation_status, generation_progress, generation_error, current_operation, tts_chunks, transcript_words, karma, agree_votes, disagree_votes'
      : 'RETURNING id, playback_position, playback_speed, last_played_at';

    const sql = `UPDATE content_items SET ${setClause.join(', ')} WHERE id = $${paramCount - 1} AND user_id = $${paramCount} ${returningClause}`;
    const result = await query(sql, values);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Content not found' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error updating content item:', error);
    res.status(500).json({ error: 'Failed to update content item' });
  }
});

// Delete content item
router.delete('/:id', async (req, res) => {
  try {
    const itemResult = await query(
      'SELECT wallabag_id FROM content_items WHERE id = $1 AND user_id = $2',
      [req.params.id, req.user!.userId]
    );

    if (itemResult.rows.length === 0) {
      return res.status(404).json({ error: 'Content not found' });
    }

    const wallabagId = itemResult.rows[0].wallabag_id;

    if (wallabagId) {
      const { deleteFromWallabag } = await import('../services/wallabag-sync.js');
      deleteFromWallabag(req.user!.userId, wallabagId).catch(err => {
        console.error(`[Wallabag] Failed to delete from Wallabag (ID: ${wallabagId}):`, err);
      });
    }

    await query(
      'DELETE FROM content_items WHERE id = $1 AND user_id = $2 RETURNING id',
      [req.params.id, req.user!.userId]
    );

    res.json({ message: 'Content deleted successfully' });
  } catch (error) {
    console.error('Error deleting content item:', error);
    res.status(500).json({ error: 'Failed to delete content item' });
  }
});

// Refetch content metadata and comments
router.post('/:id/refetch', async (req, res) => {
  try {
    const { id } = req.params;

    const contentResult = await query(
      'SELECT type, url FROM content_items WHERE id = $1 AND user_id = $2',
      [id, req.user!.userId]
    );

    if (contentResult.rows.length === 0) {
      return res.status(404).json({ error: 'Content not found' });
    }

    const { type, url } = contentResult.rows[0];

    if (type !== 'article' || !url) {
      return res.status(400).json({ error: 'Refetch only available for articles with URLs' });
    }

    (async () => {
      try {
        console.log(`Refetching metadata and comments for article ${id} from:`, url);

        const articleData = await fetchArticleContent(url);

        const commentsJson = articleData.comments && articleData.comments.length > 0
          ? JSON.stringify(articleData.comments)
          : null;

        // FIX 5: Update preview_picture during manual refetch
        await query(
          `UPDATE content_items SET
            html_content = $1,
            content = $2,
            author = COALESCE($3, author),
            published_at = COALESCE($4, published_at),
            karma = $5,
            agree_votes = $6,
            disagree_votes = $7,
            comments = $8,
            preview_picture = COALESCE($9, preview_picture),
            content_source = 'wallacast',
            updated_at = NOW()
          WHERE id = $10`,
          [
            articleData.cleaned_html,
            articleData.content,
            articleData.author || articleData.byline,
            articleData.published_date,
            articleData.karma,
            articleData.agree_votes,
            articleData.disagree_votes,
            commentsJson,
            articleData.lead_image_url || null, // Capture image on refetch
            id
          ]
        );

        console.log(`Refetch completed for article ${id}`);
      } catch (error) {
        console.error(`Refetch error for article ${id}:`, error);
      }
    })();

    res.json({ message: 'Refetch started' });
  } catch (error) {
    console.error('Error starting refetch:', error);
    res.status(500).json({ error: 'Failed to start refetch' });
  }
});

// Generate TTS for an article
router.post('/:id/generate-audio', async (req, res) => {
  try {
    const { id } = req.params;
    const { regenerate } = req.body;

    // OPTIMIZED: Select only necessary columns, excluding audio_data
    const contentResult = await query(
      'SELECT id, type, generation_status, generation_progress, audio_url FROM content_items WHERE id = $1 AND user_id = $2',
      [id, req.user!.userId]
    );

    if (contentResult.rows.length === 0) {
      return res.status(404).json({ error: 'Content not found' });
    }

    const contentItem = contentResult.rows[0];

    if (contentItem.type !== 'article' && contentItem.type !== 'text') {
      return res.status(400).json({ error: 'TTS only available for articles and text' });
    }

    if (!regenerate && contentItem.generation_status === 'generating_audio') {
      return res.status(409).json({
        error: 'Audio generation already in progress',
        generation_status: contentItem.generation_status,
        generation_progress: contentItem.generation_progress
      });
    }

    // CHANGED: Check audio_url instead of audio_data to avoid fetching BLOB
    if (regenerate && contentItem.audio_url) {
      console.log(`Regenerating: Will replace existing audio data`);
    }

    await query(
      'UPDATE content_items SET generation_status = $1, generation_progress = $2, generation_error = NULL, current_operation = $3 WHERE id = $4',
      ['generating_audio', 0, 'audio', id]
    );

    generateAudioForContent(parseInt(id), !!regenerate)
      .then((result) => {
        console.log(`Audio generation pipeline started for ${id}`);
        // Note: Final status will be set by transcription/alignment handler
      })
      .catch(async (error) => {
        console.error('Background audio generation error:', error);
        await query(
          'UPDATE content_items SET generation_status = $1, generation_error = $2, generation_progress = $3, current_operation = NULL WHERE id = $4',
          ['failed', error.message || 'Failed to generate audio', 0, id]
        );
      });

    res.json({
      message: 'Audio generation started',
      generation_status: 'generating_audio',
      generation_progress: 0
    });
  } catch (error) {
    console.error('Error starting TTS generation:', error);
    res.status(500).json({ error: 'Failed to start audio generation' });
  }
});

// Cancel ongoing audio generation
router.post('/:id/cancel-generation', async (req, res) => {
  try {
    const { id } = req.params;

    // Verify content belongs to user
    const contentResult = await query(
      'SELECT id, generation_status FROM content_items WHERE id = $1 AND user_id = $2',
      [id, req.user!.userId]
    );

    if (contentResult.rows.length === 0) {
      return res.status(404).json({ error: 'Content not found' });
    }

    const currentStatus = contentResult.rows[0].generation_status;

    // Only allow cancelling if currently generating
    if (!currentStatus || currentStatus === 'idle' || currentStatus === 'completed' || currentStatus === 'failed') {
      return res.status(400).json({ error: 'No generation in progress' });
    }

    // Mark as cancelled
    await query(
      'UPDATE content_items SET generation_status = $1, generation_error = $2, generation_progress = $3, current_operation = NULL WHERE id = $4',
      ['failed', 'Cancelled by user', 0, id]
    );

    console.log(`Generation cancelled for content ${id}`);

    res.json({ message: 'Generation cancelled successfully' });
  } catch (error) {
    console.error('Error cancelling generation:', error);
    res.status(500).json({ error: 'Failed to cancel generation' });
  }
});

export default router;
