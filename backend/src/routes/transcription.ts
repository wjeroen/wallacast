import express from 'express';
import { query } from '../database/db.js';
import { transcribeAudio } from '../services/transcription.js';

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
      return res.json({ transcript: content.transcript });
    }

    console.log('Starting transcription for content:', id);
    const transcript = await transcribeAudio(content.audio_url);

    await query(
      'UPDATE content_items SET transcript = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
      [transcript, id]
    );

    res.json({ transcript });
  } catch (error) {
    console.error('Error transcribing content:', error);
    res.status(500).json({ error: 'Failed to transcribe content' });
  }
});

export default router;
