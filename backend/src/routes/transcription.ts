import express from 'express';
import { query } from '../database/db.js';
import { transcribeWithTimestamps } from '../services/transcription.js';

const router = express.Router();

// Transcribe a podcast episode (async)
router.post('/content/:id', async (req, res) => {
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

    const content = contentResult.rows[0];

    if (!content.audio_url) {
      return res.status(400).json({ error: 'Content has no audio URL' });
    }

    // If already has transcript and not regenerating, return it
    if (content.transcript && !regenerate) {
      return res.json({
        transcript: content.transcript,
        words: content.transcript_words ? JSON.parse(content.transcript_words) : null
      });
    }

    // Check if already generating
    if (!regenerate && content.generation_status === 'generating_transcript') {
      return res.status(409).json({
        error: 'Transcription already in progress',
        generation_status: content.generation_status,
        generation_progress: content.generation_progress
      });
    }

    // Set status to generating
    await query(
      'UPDATE content_items SET generation_status = $1, generation_progress = $2, generation_error = NULL, current_operation = $3 WHERE id = $4',
      ['generating_transcript', 0, 'transcript', id]
    );

    console.log('Starting transcription for content:', id, 'audio_url:', content.audio_url);

    // Start transcription in background (don't await)
    transcribeWithTimestamps(content.audio_url, req.user!.userId)
      .then(async (result) => {
        console.log('Transcription complete, length:', result.text.length, 'words:', result.words.length);

        await query(
          'UPDATE content_items SET transcript = $1, transcript_words = $2, generation_status = $3, generation_progress = $4, current_operation = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = $5',
          [result.text, JSON.stringify(result.words), 'completed', 100, id]
        );
      })
      .catch(async (error) => {
        console.error('Background transcription error:', error);
        await query(
          'UPDATE content_items SET generation_status = $1, generation_error = $2, generation_progress = $3, current_operation = NULL WHERE id = $4',
          ['failed', error.message || 'Failed to transcribe', 0, id]
        );
      });

    // Return immediately with status
    res.json({
      message: 'Transcription started',
      generation_status: 'generating_transcript',
      generation_progress: 0
    });
  } catch (error) {
    console.error('Error starting transcription:', error);
    res.status(500).json({
      error: 'Failed to start transcription',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

export default router;
