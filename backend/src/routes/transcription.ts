import express from 'express';
import { query } from '../database/db.js';
import { transcribeWithTimestamps } from '../services/transcription.js';

const router = express.Router();

// Transcribe a podcast episode
router.post('/content/:id', async (req, res) => {
  try {
    const { id } = req.params;

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

    if (content.transcript) {
      return res.json({
        transcript: content.transcript,
        words: content.transcript_words || null
      });
    }

    console.log('Starting transcription for content:', id, 'audio_url:', content.audio_url);
    const result = await transcribeWithTimestamps(content.audio_url);

    console.log('Transcription complete, length:', result.text.length, 'words:', result.words.length);

    await query(
      'UPDATE content_items SET transcript = $1, transcript_words = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3',
      [result.text, JSON.stringify(result.words), id]
    );

    res.json({
      transcript: result.text,
      words: result.words
    });
  } catch (error) {
    console.error('Error transcribing content:', error);
    if (error instanceof Error) {
      console.error('Error message:', error.message);
      console.error('Error stack:', error.stack);
    }
    res.status(500).json({
      error: 'Failed to transcribe content',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

export default router;
