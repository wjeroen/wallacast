import express from 'express';
import { query } from '../database/db.js';
import { transcribeWithTimestamps } from '../services/transcription.js';

const router = express.Router();

// Transcribe a podcast episode (async)
router.post('/content/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { regenerate } = req.body;

    // OPTIMIZED: Select necessary columns for prompt generation
    const contentResult = await query(
      'SELECT id, audio_url, transcript, transcript_words, generation_status, generation_progress, title, author, published_at, comments FROM content_items WHERE id = $1 AND user_id = $2',
      [id, req.user!.userId]
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

    // Build Whisper prompt hint for better transcription of key phrases
    let whisperPrompt = '';

    // 1. Article Metadata
    if (content.title) whisperPrompt += `Title: ${content.title}. `;
    if (content.author) whisperPrompt += `Written by ${content.author.replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu, '').trim()}. `;
    
    // Use real date if available, otherwise generic fallback
    const dateStr = content.published_at ? new Date(content.published_at).toLocaleDateString('en-US') : 'recent date';
    whisperPrompt += `Published on ${dateStr}. `;

    // 2. Comments Section
    if (content.comments) {
      try {
        const commentsData = typeof content.comments === 'string' ? JSON.parse(content.comments) : content.comments;
        
        if (commentsData && Array.isArray(commentsData) && commentsData.length > 0) {
          whisperPrompt += 'Comments section: ';
          
          // First Commenter
          const firstComm = commentsData[0];
          const user1 = (firstComm.username || 'User').replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu, '').trim();
          const date1 = firstComm.date ? new Date(firstComm.date).toLocaleDateString('en-US') : 'recently';
          const upvotes1 = firstComm.karma || 0; // matching fetcher.ts property
          
          whisperPrompt += `${user1} on ${date1} with ${upvotes1} upvotes. `;

          // Reply / Second Commenter
          let secondComm = null;
          let isReply = false;

          // Check if first comment has replies (as per Comment interface)
          if (firstComm.replies && firstComm.replies.length > 0) {
              secondComm = firstComm.replies[0];
              isReply = true;
          } else if (commentsData.length > 1) {
              secondComm = commentsData[1];
          }

          if (secondComm) {
              const user2 = (secondComm.username || 'User').replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu, '').trim();
              const date2 = secondComm.date ? new Date(secondComm.date).toLocaleDateString('en-US') : 'recently';
              const upvotes2 = secondComm.karma || 0;
              
              // Handle agree votes from extendedScore
              let agree2 = 0;
              if (secondComm.extendedScore) {
                 // extendedScore might be parsed object or JSON string
                 const es = typeof secondComm.extendedScore === 'string' ? JSON.parse(secondComm.extendedScore) : secondComm.extendedScore;
                 agree2 = es.agreement || es.agree || 0;
              }

              if (isReply) {
                   whisperPrompt += `A reply to ${user1} by ${user2} on ${date2} with ${upvotes2} upvotes, ${agree2} agree.`;
              } else {
                   whisperPrompt += `${user2} on ${date2} with ${upvotes2} upvotes.`;
              }
          }
        }
      } catch { /* ignore parsing errors */ }
    }

    // Start transcription in background (don't await)
    // Pass the generated prompt (sliced to 800 chars to be safe, logic handled in service)
    transcribeWithTimestamps(content.audio_url, req.user!.userId, whisperPrompt)
      .then(async (result) => {
        console.log('Transcription complete, length:', result.text.length, 'words:', result.words.length);

        await query(
          'UPDATE content_items SET transcript = $1, transcript_words = $2, generation_status = $3, generation_progress = $4, current_operation = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = $5 AND user_id = $6',
          [result.text, JSON.stringify(result.words), 'completed', 100, id, req.user!.userId]
        );
      })
      .catch(async (error) => {
        console.error('Background transcription error:', error);
        await query(
          'UPDATE content_items SET generation_status = $1, generation_error = $2, generation_progress = $3, current_operation = NULL WHERE id = $4 AND user_id = $5',
          ['failed', error.message || 'Failed to transcribe', 0, id, req.user!.userId]
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
