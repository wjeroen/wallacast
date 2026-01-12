import express from 'express';
import { query } from '../database/db.js';
import { fetchArticleContent } from '../services/article-fetcher.js';
import { generateTTS } from '../services/tts.js';
import { generateAudioForContent, extractArticleContent } from '../services/openai-tts.js';
import { transcribeWithTimestamps } from '../services/transcription.js';

const router = express.Router();

// Get all content items
router.get('/', async (req, res) => {
  try {
    const { type, archived, favorite } = req.query;

    let sql = 'SELECT * FROM content_items WHERE 1=1';
    const params: any[] = [];
    let paramCount = 1;

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

    if (favorite !== undefined) {
      sql += ` AND is_favorite = $${paramCount}`;
      params.push(favorite === 'true');
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

// Get single content item
router.get('/:id', async (req, res) => {
  try {
    const result = await query(
      'SELECT * FROM content_items WHERE id = $1',
      [req.params.id]
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
      thumbnail_url,
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
    }

    // Ensure we have a title (final fallback)
    if (!finalTitle || finalTitle === 'Untitled') {
      finalTitle = 'Untitled Article';
    }

    const result = await query(
      `INSERT INTO content_items
       (type, title, url, content, html_content, author, description, thumbnail_url, audio_url, podcast_id, published_at, duration, karma, agree_votes, disagree_votes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
       RETURNING *`,
      [type, finalTitle, url, processedContent, htmlContent, finalAuthor, finalDescription, thumbnail_url, audioUrlValue, podcast_id || null, finalPublishedAt || null, duration || null, karma, agreeVotes, disagreeVotes]
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
    if (type === 'podcast_episode' && audioUrlValue && !createdItem.transcript) {
      console.log(`Auto-generating transcript for podcast episode ${createdItem.id}`);

      // Set status to generating transcript
      await query(
        'UPDATE content_items SET generation_status = $1, generation_progress = $2, current_operation = $3 WHERE id = $4',
        ['generating_transcript', 0, 'transcript', createdItem.id]
      );

      // Start transcription in background (don't await)
      transcribeWithTimestamps(audioUrlValue)
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
      'is_favorite',
      'is_archived',
      'is_read',
      'playback_position',
      'playback_speed',
      'last_played_at',
      'title',
      'description',
    ];

    // Special handling for archiving: delete audio file to save space
    if (updates.is_archived === true) {
      const contentResult = await query(
        'SELECT audio_url, type FROM content_items WHERE id = $1',
        [id]
      );

      if (contentResult.rows.length > 0) {
        const { audio_url, type } = contentResult.rows[0];

        // Only delete audio for articles (not podcasts)
        if (audio_url && (type === 'article' || type === 'text')) {
          try {
            // Extract filename from URL
            const filename = audio_url.split('/').pop();
            if (filename) {
              const { getAudioDir } = await import('../config/storage.js');
              const audioPath = path.join(getAudioDir(), filename);
              const fs = await import('fs/promises');
              await fs.unlink(audioPath);
              console.log(`Archived: Deleted audio file ${filename} to save space`);
            }
          } catch (error) {
            console.warn('Failed to delete audio file on archive:', error);
          }

          // Clear audio_url from database
          updates.audio_url = null;
          allowedFields.push('audio_url');
        }
      }
    }

    // Special handling for un-archiving: regenerate audio if it's missing
    if (updates.is_archived === false) {
      const contentResult = await query(
        'SELECT audio_url, type, html_content FROM content_items WHERE id = $1',
        [id]
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

    setClause.push(`updated_at = CURRENT_TIMESTAMP`);
    values.push(id);

    const sql = `UPDATE content_items SET ${setClause.join(', ')} WHERE id = $${paramCount} RETURNING *`;
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
    // First get the content item to extract the audio URL
    const contentResult = await query(
      'SELECT audio_url FROM content_items WHERE id = $1',
      [req.params.id]
    );

    if (contentResult.rows.length === 0) {
      return res.status(404).json({ error: 'Content not found' });
    }

    const audioUrl = contentResult.rows[0].audio_url;

    // Delete the database record
    const result = await query(
      'DELETE FROM content_items WHERE id = $1 RETURNING id',
      [req.params.id]
    );

    // Delete the audio file if it exists
    if (audioUrl) {
      try {
        // Extract filename from URL (e.g., "article_123_1234567890.mp3")
        const filename = audioUrl.split('/').pop();
        if (filename) {
          const { getAudioDir } = await import('../config/storage.js');
          const audioPath = path.join(getAudioDir(), filename);
          const fs = await import('fs/promises');
          await fs.unlink(audioPath);
          console.log(`Deleted audio file: ${filename}`);
        }
      } catch (error) {
        console.warn('Failed to delete audio file:', error);
        // Don't fail the delete operation if file deletion fails
      }
    }

    res.json({ message: 'Content deleted successfully' });
  } catch (error) {
    console.error('Error deleting content item:', error);
    res.status(500).json({ error: 'Failed to delete content item' });
  }
});

// Generate TTS for an article (async)
router.post('/:id/generate-audio', async (req, res) => {
  try {
    const { id } = req.params;
    const { regenerate } = req.body;

    const contentResult = await query(
      'SELECT * FROM content_items WHERE id = $1',
      [id]
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

    // If regenerating and old audio exists, delete it first
    if (regenerate && contentItem.audio_url) {
      try {
        const filename = contentItem.audio_url.split('/').pop();
        if (filename) {
          const { getAudioDir } = await import('../config/storage.js');
          const audioPath = path.join(getAudioDir(), filename);
          const fs = await import('fs/promises');
          await fs.unlink(audioPath);
          console.log(`Regenerating: Deleted old audio file ${filename}`);
        }
      } catch (error) {
        console.warn('Failed to delete old audio file on regenerate:', error);
      }
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
