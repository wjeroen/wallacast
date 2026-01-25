import express from 'express';
import path from 'path';
import { query } from '../database/db.js';
import { fetchArticleContent } from '../services/article-fetcher.js';
import { generateAudioForContent, extractArticleContent } from '../services/openai-tts.js';
import { transcribeWithTimestamps } from '../services/transcription.js';
import { getUserSetting } from '../services/ai-providers.js';

const router = express.Router();

// Get all content items (excluding audio_data for performance)
router.get('/', async (req, res) => {
  try {
    const { type, archived, starred } = req.query;

    // Exclude large columns (html_content, comments, transcript) for performance
    let sql = 'SELECT id, type, title, url, content, author, description, preview_picture, audio_url, duration, file_size, podcast_id, episode_number, published_at, is_starred, is_archived, tags, playback_position, playback_speed, last_played_at, created_at, updated_at, generation_status, generation_progress, generation_error, current_operation, tts_chunks, transcript_words, karma, agree_votes, disagree_votes FROM content_items WHERE user_id = $1';
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
      'SELECT id, type, title, url, content, author, description, preview_picture, audio_url, transcript, duration, file_size, podcast_id, episode_number, published_at, is_starred, is_archived, tags, playback_position, playback_speed, last_played_at, created_at, updated_at, generation_status, generation_progress, generation_error, current_operation, tts_chunks, transcript_words, karma, agree_votes, disagree_votes, comments FROM content_items WHERE id = $1 AND user_id = $2',
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
// NOTE: This route is also registered in index.ts and will be handled there first
router.get('/:id/audio', async (req, res) => {
  try {
    // Note: No user_id filter - audio URLs are public but content IDs are private
    // This allows HTML5 <audio> elements to work without JWT tokens
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
    let finalPublishedAt = published_at;
    let karma: number | null = null;
    let agreeVotes: number | null = null;
    let disagreeVotes: number | null = null;
    let extractedComments: any = null;

    // Fetch article content if URL is provided
    if (type === 'article' && url && !content) {
      const articleData = await fetchArticleContent(url);
      htmlContent = articleData.html;

      // Use placeholder text - will be extracted properly in background
      processedContent = '⏳ Content is being extracted and formatted for reading...';

      // Use fetched title if no title provided (treat 'Untitled' as empty for backwards compat)
      if ((!finalTitle || finalTitle === 'Untitled') && articleData.title) {
        finalTitle = articleData.title;
      }

      // Use fetched author/byline if available
      if (!finalAuthor && (articleData.author || articleData.byline)) {
        finalAuthor = articleData.author || articleData.byline;
      }

      // Use fetched excerpt as description if available
      if (!finalDescription && articleData.excerpt) {
        finalDescription = articleData.excerpt;
      }

      // Use fetched published date if available
      if (!finalPublishedAt && articleData.published_date) {
        finalPublishedAt = articleData.published_date;
      }

      // Store EA Forum metadata if available
      if (articleData.karma !== undefined) {
        karma = articleData.karma;
      }
      if (articleData.agree_votes !== undefined) {
        agreeVotes = articleData.agree_votes;
      }
      if (articleData.disagree_votes !== undefined) {
        disagreeVotes = articleData.disagree_votes;
      }

      // Store parsed comments from Apollo state (EA Forum/LessWrong)
      if (articleData.comments && articleData.comments.length > 0) {
        extractedComments = JSON.stringify(articleData.comments);
        console.log(`Extracted ${articleData.comments.length} comments from Apollo state`);
      }
    }

    // Ensure we have a title (final fallback)
    if (!finalTitle || finalTitle === 'Untitled') {
      finalTitle = 'Untitled Article';
    }

    const result = await query(
      `INSERT INTO content_items
       (type, title, url, content, html_content, author, description, preview_picture, audio_url, podcast_id, published_at, duration, karma, agree_votes, disagree_votes, comments, user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
       RETURNING *`,
      [type, finalTitle, url, processedContent, htmlContent, finalAuthor, finalDescription, preview_picture, audioUrlValue, podcast_id || null, finalPublishedAt || null, duration || null, karma, agreeVotes, disagreeVotes, extractedComments, req.user!.userId]
    );

    const createdItem = result.rows[0];

    // Auto-generate audio for articles (if no audio URL provided)
    if ((type === 'article' || type === 'text') && !audioUrlValue && (processedContent || htmlContent)) {
      console.log(`Auto-generating audio for ${type} ${createdItem.id}`);

      // Set status to starting (will update to extracting_content immediately)
      await query(
        'UPDATE content_items SET generation_status = $1, generation_progress = $2, current_operation = $3 WHERE id = $4',
        ['starting', 0, 'initialization', createdItem.id]
      );

      // Start generation in background (don't await)
      generateAudioForContent(createdItem.id)
        .then(async () => {
          await query(
            'UPDATE content_items SET generation_status = $1, generation_progress = $2, current_operation = NULL WHERE id = $3',
            ['completed', 100, createdItem.id]
          );
        })
        .catch(async (error) => {
          console.error('Auto audio generation error:', error);
          await query(
            'UPDATE content_items SET generation_status = $1, generation_error = $2, generation_progress = $3, current_operation = NULL WHERE id = $4',
            ['failed', error.message || 'Failed to generate audio', 0, createdItem.id]
          );
        });
    }

    // Auto-generate transcript for podcast episodes (if has audio but no transcript)
    // Check user setting to see if auto-transcription is enabled
    if (type === 'podcast_episode' && audioUrlValue && !createdItem.transcript) {
      const autoTranscribe = await getUserSetting(req.user!.userId, 'auto_transcribe_podcasts');
      const shouldAutoTranscribe = autoTranscribe === null || autoTranscribe === 'true'; // Default to true for backwards compatibility

      if (shouldAutoTranscribe) {
        console.log(`Auto-generating transcript for podcast episode ${createdItem.id}`);

        // Set status to generating transcript
        await query(
          'UPDATE content_items SET generation_status = $1, generation_progress = $2, current_operation = $3 WHERE id = $4',
          ['generating_transcript', 0, 'transcript', createdItem.id]
        );

        // Start transcription in background (don't await)
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
      } else {
        console.log(`Auto-transcription disabled for user ${req.user!.userId}, skipping podcast episode ${createdItem.id}`);
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

    // Special handling for removing audio
    if (updates.audio_data === null && updates.audio_url === null) {
      const contentResult = await query(
        'SELECT type FROM content_items WHERE id = $1 AND user_id = $2',
        [id, req.user!.userId]
      );

      if (contentResult.rows.length > 0) {
        const { type } = contentResult.rows[0];

        // Only allow removing audio for articles and texts
        if (type === 'article' || type === 'text') {
          console.log(`Manually removing audio for ${type} ${id}`);
          // Also clear duration when removing audio
          updates.duration = null;
          allowedFields.push('audio_data', 'audio_url', 'duration');
        }
      }
    }

    // Special handling for regenerating content (articles only)
    if (updates.regenerate_content === true) {
      const contentResult = await query(
        'SELECT type, url, preview_picture FROM content_items WHERE id = $1 AND user_id = $2',
        [id, req.user!.userId]
      );

      if (contentResult.rows.length > 0) {
        const { type, url, preview_picture } = contentResult.rows[0];

        if (type === 'article' && url) {
          console.log(`Regenerating content for article ${id} from URL:`, url);

          // Start content regeneration in background
          (async () => {
            try {
              // Set status to fetching
              await query(
                'UPDATE content_items SET generation_status = $1, generation_progress = $2, current_operation = $3 WHERE id = $4',
                ['fetching', 10, 'fetching_article', id]
              );

              // REFETCH from the actual URL (not using stale html_content)
              // This gets fresh content + EA Forum/LessWrong comments
              const articleData = await fetchArticleContent(url);

              // Set status to extracting content
              await query(
                'UPDATE content_items SET generation_status = $1, generation_progress = $2, current_operation = $3 WHERE id = $4',
                ['extracting_content', 50, 'content_extraction', id]
              );

              // Extract readable content from HTML using LLM (with comments!)
              const extractedResult = await extractArticleContent(
                articleData.html,
                articleData.comments_html,
                parseInt(id, 10)
              );

              // Add Wallacast provenance marker to content
              const markedContent = `<!-- wallacast-generated:${new Date().toISOString()} -->\n${extractedResult.content}`;

              // Prepare comments JSON (prefer direct Apollo state extraction over LLM)
              const commentsJson = articleData.comments && articleData.comments.length > 0
                ? JSON.stringify(articleData.comments)
                : (extractedResult.comments && extractedResult.comments.length > 0
                  ? JSON.stringify(extractedResult.comments)
                  : null);

              // Update with new content + HTML + metadata + comments (keep Wallabag thumbnail!)
              await query(
                `UPDATE content_items SET
                  content = $1,
                  html_content = $2,
                  content_source = 'wallacast',
                  author = COALESCE($3, author),
                  published_at = COALESCE($4, published_at),
                  karma = COALESCE($5, karma),
                  agree_votes = COALESCE($6, agree_votes),
                  disagree_votes = COALESCE($7, disagree_votes),
                  comments = $8,
                  generation_status = $9,
                  generation_progress = $10,
                  current_operation = NULL,
                  updated_at = NOW()
                WHERE id = $11`,
                [
                  markedContent,
                  articleData.html,
                  articleData.author || articleData.byline,
                  articleData.published_date,
                  articleData.karma,
                  articleData.agree_votes,
                  articleData.disagree_votes,
                  commentsJson,
                  'completed',
                  100,
                  id
                ]
              );

              console.log(`Content regenerated successfully for article ${id} (refetched from web)`);
            } catch (error) {
              console.error('Content regeneration error:', error);
              await query(
                'UPDATE content_items SET generation_status = $1, generation_error = $2, generation_progress = $3, current_operation = NULL WHERE id = $4',
                ['failed', (error as Error).message || 'Failed to regenerate content', 0, id]
              );
            }
          })();

          // Set initial status
          updates.generation_status = 'extracting_content';
          updates.generation_progress = 0;
          allowedFields.push('generation_status', 'generation_progress');
          delete updates.regenerate_content;
        }
      }
    }

    // Special handling for regenerating transcript (podcasts only)
    if (updates.regenerate_transcript === true) {
      const contentResult = await query(
        'SELECT type, audio_url FROM content_items WHERE id = $1 AND user_id = $2',
        [id, req.user!.userId]
      );

      if (contentResult.rows.length > 0) {
        const { type, audio_url } = contentResult.rows[0];

        if (type === 'podcast_episode' && audio_url) {
          console.log(`Regenerating transcript for podcast ${id}`);

          // Start transcription in background
          (async () => {
            try {
              // Set status to generating transcript
              await query(
                'UPDATE content_items SET generation_status = $1, generation_progress = $2, current_operation = $3 WHERE id = $4',
                ['generating_transcript', 0, 'transcript', id]
              );

              // Regenerate transcript
              const result = await transcribeWithTimestamps(audio_url, req.user!.userId);

              await query(
                'UPDATE content_items SET transcript = $1, transcript_words = $2, generation_status = $3, generation_progress = $4, current_operation = NULL WHERE id = $5',
                [result.text, JSON.stringify(result.words), 'completed', 100, id]
              );

              console.log(`Transcript regenerated successfully for podcast ${id}`);
            } catch (error) {
              console.error('Transcript regeneration error:', error);
              await query(
                'UPDATE content_items SET generation_status = $1, generation_error = $2, generation_progress = $3, current_operation = NULL WHERE id = $4',
                ['failed', (error as Error).message || 'Failed to regenerate transcript', 0, id]
              );
            }
          })();

          // Set initial status
          updates.generation_status = 'generating_transcript';
          updates.generation_progress = 0;
          allowedFields.push('generation_status', 'generation_progress');
          delete updates.regenerate_transcript;
        }
      }
    }

    // Special handling for archiving: delete audio data to save space (unless favorited)
    if (updates.is_archived === true) {
      const contentResult = await query(
        'SELECT audio_data, type, is_starred FROM content_items WHERE id = $1 AND user_id = $2',
        [id, req.user!.userId]
      );

      if (contentResult.rows.length > 0) {
        const { audio_data, type, is_starred } = contentResult.rows[0];

        // Only delete audio for articles (not podcasts) and only if not favorited
        if (audio_data && (type === 'article' || type === 'text') && !is_starred) {
          const audioSizeMB = (audio_data.length / 1024 / 1024).toFixed(2);
          console.log(`Archived: Deleting ${audioSizeMB} MB of audio data to save space`);

          // Clear audio_data, audio_url, and duration from database
          updates.audio_data = null;
          updates.audio_url = null;
          updates.duration = null;
          allowedFields.push('audio_data', 'audio_url', 'duration');
        } else if (audio_data && is_starred) {
          console.log(`Archived: Preserving audio for favorited item ${id}`);
        }
      }
    }

    // Special handling for un-archiving: regenerate audio if it's missing
    if (updates.is_archived === false) {
      const contentResult = await query(
        'SELECT audio_url, type, html_content FROM content_items WHERE id = $1 AND user_id = $2',
        [id, req.user!.userId]
      );

      if (contentResult.rows.length > 0) {
        const { audio_url, type, html_content } = contentResult.rows[0];

        // If un-archiving and audio is missing, trigger regeneration
        if (!audio_url && (type === 'article' || type === 'text') && html_content) {
          console.log(`Un-archiving article ${id}: triggering audio regeneration`);

          // Start generation in background (don't await)
          generateAudioForContent(parseInt(id))
            .then(async () => {
              await query(
                'UPDATE content_items SET generation_status = $1, generation_progress = $2, current_operation = NULL WHERE id = $3',
                ['completed', 100, id]
              );
              console.log(`Audio regenerated for un-archived article ${id}`);
            })
            .catch(async (error) => {
              console.error('Auto audio regeneration error on un-archive:', error);
              await query(
                'UPDATE content_items SET generation_status = $1, generation_error = $2, generation_progress = $3, current_operation = NULL WHERE id = $4',
                ['failed', error.message || 'Failed to regenerate audio', 0, id]
              );
            });

          // Set status to show generation started
          updates.generation_status = 'starting';
          updates.generation_progress = 0;
          allowedFields.push('generation_status', 'generation_progress');
        }
      }
    }

    const setClause = [];
    const values = [];
    let paramCount = 1;

    // Track if we're updating content fields (vs just playback state)
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

    // Only update updated_at for content changes, not playback position updates
    // Playback updates happen frequently (every few seconds) and shouldn't trigger sync
    if (updatingContentFields) {
      setClause.push(`updated_at = CURRENT_TIMESTAMP`);
    }

    values.push(id);
    paramCount++;
    values.push(req.user!.userId);

    const sql = `UPDATE content_items SET ${setClause.join(', ')} WHERE id = $${paramCount - 1} AND user_id = $${paramCount} RETURNING *`;
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
    // Get item first to check for wallabag_id
    const itemResult = await query(
      'SELECT wallabag_id FROM content_items WHERE id = $1 AND user_id = $2',
      [req.params.id, req.user!.userId]
    );

    if (itemResult.rows.length === 0) {
      return res.status(404).json({ error: 'Content not found' });
    }

    const wallabagId = itemResult.rows[0].wallabag_id;

    // Delete from Wallabag if synced (fire and forget - don't fail local delete if this fails)
    if (wallabagId) {
      const { deleteFromWallabag } = await import('../services/wallabag-sync.js');
      deleteFromWallabag(req.user!.userId, wallabagId).catch(err => {
        console.error(`[Wallabag] Failed to delete from Wallabag (ID: ${wallabagId}):`, err);
      });
      console.log(`[Wallabag] Queued deletion of Wallabag entry ${wallabagId}`);
    }

    // Delete the database record (audio_data is automatically deleted)
    const result = await query(
      'DELETE FROM content_items WHERE id = $1 AND user_id = $2 RETURNING id',
      [req.params.id, req.user!.userId]
    );

    console.log(`Deleted content item ${req.params.id} (including audio data if present)`);
    res.json({ message: 'Content deleted successfully' });
  } catch (error) {
    console.error('Error deleting content item:', error);
    res.status(500).json({ error: 'Failed to delete content item' });
  }
});

// Refetch content metadata and comments (no LLM, just re-scrape)
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

    // Refetch in background
    (async () => {
      try {
        console.log(`Refetching metadata and comments for article ${id} from:`, url);

        // Refetch from URL (gets fresh metadata + comments)
        const articleData = await fetchArticleContent(url);

        // Prepare comments JSON
        const commentsJson = articleData.comments && articleData.comments.length > 0
          ? JSON.stringify(articleData.comments)
          : null;

        // Update metadata and comments only (don't touch content)
        await query(
          `UPDATE content_items SET
            author = COALESCE($1, author),
            published_at = COALESCE($2, published_at),
            karma = $3,
            agree_votes = $4,
            disagree_votes = $5,
            comments = $6,
            updated_at = NOW()
          WHERE id = $7`,
          [
            articleData.author || articleData.byline,
            articleData.published_date,
            articleData.karma,
            articleData.agree_votes,
            articleData.disagree_votes,
            commentsJson,
            id
          ]
        );

        console.log(`Refetch completed for article ${id}. Comments: ${articleData.comments?.length || 0}`);
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

// Generate TTS for an article (async)
router.post('/:id/generate-audio', async (req, res) => {
  try {
    const { id } = req.params;
    const { regenerate } = req.body;

    const contentResult = await query(
      'SELECT * FROM content_items WHERE id = $1 AND user_id = $2',
      [id, req.user!.userId]
    );

    if (contentResult.rows.length === 0) {
      return res.status(404).json({ error: 'Content not found' });
    }

    const contentItem = contentResult.rows[0];

    if (contentItem.type !== 'article' && contentItem.type !== 'text') {
      return res.status(400).json({ error: 'TTS only available for articles and text' });
    }

    // Check if already generating (unless regenerating)
    if (!regenerate && contentItem.generation_status === 'generating_audio') {
      return res.status(409).json({
        error: 'Audio generation already in progress',
        generation_status: contentItem.generation_status,
        generation_progress: contentItem.generation_progress
      });
    }

    // If regenerating, old audio data will be automatically overwritten in database
    if (regenerate && contentItem.audio_data) {
      const oldAudioSizeMB = (contentItem.audio_data.length / 1024 / 1024).toFixed(2);
      console.log(`Regenerating: Will replace ${oldAudioSizeMB} MB of existing audio data`);
    }

    // Set status to generating
    await query(
      'UPDATE content_items SET generation_status = $1, generation_progress = $2, generation_error = NULL, current_operation = $3 WHERE id = $4',
      ['generating_audio', 0, 'audio', id]
    );

    // Start generation in background (don't await)
    generateAudioForContent(parseInt(id))
      .then(async (result) => {
        // Update status to completed
        await query(
          'UPDATE content_items SET generation_status = $1, generation_progress = $2, current_operation = NULL WHERE id = $3',
          ['completed', 100, id]
        );
      })
      .catch(async (error) => {
        console.error('Background audio generation error:', error);
        // Update status to failed
        await query(
          'UPDATE content_items SET generation_status = $1, generation_error = $2, generation_progress = $3, current_operation = NULL WHERE id = $4',
          ['failed', error.message || 'Failed to generate audio', 0, id]
        );
      });

    // Return immediately with status
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

export default router;
