import express from 'express';
import path from 'path';
import { JSDOM } from 'jsdom';
import fetch from 'node-fetch';
import archiver from 'archiver';
import { query } from '../database/db.js';
import { fetchArticleContent, normalizeEAForumUrl } from '../services/article-fetcher.js';
// CHANGED: Removed unused 'extractArticleContent' from import
import { generateAudioForContent } from '../services/openai-tts.js';
import { generateSummaryForContent } from '../services/summarizer.js';
import { transcribeWithTimestamps } from '../services/transcription.js';
import { getUserSetting } from '../services/ai-providers.js';
import { generateLLMAlignment } from '../services/llm-alignment.js';
import { buildWhisperPrompt } from '../services/whisper-prompt.js';
import { deleteAudioFile, getAudioFileSize } from '../services/audio-storage.js';
import { withAudioToken } from '../services/audio-token.js';
import { snapshotContentVersion } from '../services/content-versions.js';

const router = express.Router();

// Strip <script>/<style> (and javascript: URLs) from edited HTML before storing it.
// The frontend's markdownToHtml already strips these; this is defense-in-depth because
// the result is rendered with dangerouslySetInnerHTML.
function sanitizeEditedHtml(html: string): string {
  if (!html) return '';
  const dom = new JSDOM(html);
  const doc = dom.window.document;
  doc.querySelectorAll('script, style').forEach((el) => el.remove());
  doc.querySelectorAll('a[href], img[src]').forEach((el) => {
    for (const attr of ['href', 'src']) {
      const val = el.getAttribute(attr);
      if (val && /^\s*javascript:/i.test(val)) el.removeAttribute(attr);
    }
  });
  return doc.body.innerHTML;
}

// Get all content items (excluding audio_data for performance)
router.get('/', async (req, res) => {
  try {
    const { type, archived, starred } = req.query;

    // Exclude large columns (html_content, comments, transcript) for performance
    // Use stored comment_count_total (includes nested replies)
    let sql = 'SELECT id, type, title, url, content, author, description, preview_picture, audio_url, duration, file_size, podcast_id, podcast_show_name, episode_number, published_at, is_starred, is_archived, tags, playback_position, playback_speed, last_played_at, created_at, updated_at, generation_status, generation_progress, generation_error, current_operation, tts_chunks, transcript_words, karma, agree_votes, disagree_votes, summary, summary_status, summary_generated_at, summary_error, COALESCE(comment_count_total, 0) AS comment_count FROM content_items WHERE user_id = $1';
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
    res.json(result.rows.map(withAudioToken));
  } catch (error) {
    console.error('Error fetching content:', error);
    res.status(500).json({ error: 'Failed to fetch content' });
  }
});

// Batch generation-status poll. Returns ONLY the tiny status fields for many items
// in a single request (a few hundred bytes total). The library polls this every 2s
// while items are generating, instead of calling GET /:id per item.
//
// WHY THIS EXISTS: GET /:id returns the FULL item (transcript, 9,000+ word-level
// timestamps, alignment, comments), roughly 0.5MB for a transcribed podcast. Polling
// that per item every 2s is the same class of bug as the 80GB data incident (see
// ARCHITECTURE.md "Performance Optimizations"). The full item is still fetched once, at
// completion, via GET /:id (the frontend's refreshItem). Keep this endpoint lean,
// never add large columns (transcript_words, content_alignment, comments, html_content).
//
// IMPORTANT: a POST so it can take a list of ids in the body without colliding with
// the GET '/:id' route below. Defined before '/:id' to mirror the audio-error-log convention.
router.post('/status', async (req, res) => {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.json([]);
    }
    // Coerce to integers, drop junk, and cap to a sane batch size.
    const safeIds = ids
      .map((id: any) => parseInt(id, 10))
      .filter((id: number) => Number.isFinite(id))
      .slice(0, 500);
    if (safeIds.length === 0) {
      return res.json([]);
    }
    const result = await query(
      `SELECT id, generation_status, generation_progress, generation_error, current_operation, summary_status
         FROM content_items
        WHERE user_id = $1 AND id = ANY($2::int[])`,
      [req.user!.userId, safeIds]
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching content statuses:', error);
    res.status(500).json({ error: 'Failed to fetch content statuses' });
  }
});

// Debug endpoint: receives audio errors from the frontend and logs them to Railway.
// IMPORTANT: must be defined before '/:id' so Express doesn't treat 'audio-error-log' as an id.
router.post('/audio-error-log', (req, res) => {
  const { contentId, contentType, audioUrl, errorCode, errorMessage, networkState, readyState, showName } = req.body;
  const errorNames: Record<number, string> = { 1: 'ABORTED', 2: 'NETWORK', 3: 'DECODE', 4: 'SRC_NOT_SUPPORTED' };
  console.log(
    `[AudioError] type=${contentType} id=${contentId} show="${showName}" ` +
    `code=${errorCode}(${errorNames[errorCode] ?? 'unknown'}) ` +
    `networkState=${networkState} readyState=${readyState} ` +
    `msg="${errorMessage}" url=${audioUrl}`
  );
  res.json({ ok: true });
});

// Bulk actions on many items at once (used by the library's Select mode).
// IMPORTANT: defined before '/:id'-shaped routes so Express matches the literal path first.
// No transaction on purpose: query() has a connection-retry wrapper (see the wipe-all comment
// history). Every statement here is idempotent, so retrying the same request heals any
// partial state instead of corrupting it. This matches how PATCH /:id behaves.
router.post('/bulk', async (req, res) => {
  try {
    const userId = req.user!.userId;
    const { action, ids } = req.body as { action?: string; ids?: unknown };

    const ACTIONS = ['star', 'unstar', 'archive', 'unarchive', 'delete', 'remove_audio', 'remove_summary'];
    if (!action || !ACTIONS.includes(action)) {
      return res.status(400).json({ error: 'Invalid action' });
    }
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > 500 || !ids.every(n => Number.isInteger(n))) {
      return res.status(400).json({ error: 'ids must be a non-empty array of integers (max 500)' });
    }

    let affected = 0;

    if (action === 'star' || action === 'unstar') {
      // Starred/archived state must reach Wallabag, so set the explicit push flag instead of relying on an updated_at vs wallabag_updated_at comparison (those columns run on different clocks).
      const r = await query(
        `UPDATE content_items SET is_starred = $3, updated_at = NOW(), wallabag_needs_push = TRUE
         WHERE user_id = $1 AND id = ANY($2::int[])`,
        [userId, ids, action === 'star']
      );
      affected = r.rowCount ?? 0;
    }

    if (action === 'archive') {
      // Mirrors PATCH /:id is_archived=true: wipe generated audio + read-along data for
      // NON-STARRED articles/texts only. Podcasts keep their (external) audio_url and
      // starred items keep everything.
      // NOTE: no longer guarded on `audio_data IS NOT NULL`. Audio now lives on disk, so
      // that guard would skip disk-backed items and leave their files orphaned. We clear
      // the (now-mostly-empty) audio columns and delete the disk file for each affected id.
      const clearedArchive = await query(
        `UPDATE content_items
         SET audio_data = NULL, audio_url = NULL, duration = NULL, content_alignment = NULL,
             transcript = NULL, transcript_words = NULL, tts_chunks = NULL
         WHERE user_id = $1 AND id = ANY($2::int[])
           AND type IN ('article', 'text') AND is_starred = false
         RETURNING id`,
        [userId, ids]
      );
      for (const row of clearedArchive.rows) await deleteAudioFile(row.id);
      const r = await query(
        `UPDATE content_items SET is_archived = true, updated_at = NOW(), wallabag_needs_push = TRUE
         WHERE user_id = $1 AND id = ANY($2::int[])`,
        [userId, ids]
      );
      affected = r.rowCount ?? 0;
    }

    if (action === 'unarchive') {
      // Unlike single-item PATCH, bulk unarchive does NOT auto-regenerate audio. Implicitly
      // kicking off dozens of TTS jobs would be a cost surprise. Use bulk "Generate audio".
      const r = await query(
        `UPDATE content_items SET is_archived = false, updated_at = NOW(), wallabag_needs_push = TRUE
         WHERE user_id = $1 AND id = ANY($2::int[])`,
        [userId, ids]
      );
      affected = r.rowCount ?? 0;
    }

    if (action === 'remove_audio') {
      // Mirrors the per-item "remove audio" field list. The type guard ensures podcast
      // episodes are never touched. Their audio_url is the source media, not generated.
      const r = await query(
        `UPDATE content_items
         SET audio_data = NULL, audio_url = NULL, duration = NULL, content_alignment = NULL,
             transcript = NULL, transcript_words = NULL, tts_chunks = NULL,
             generation_status = 'idle', generation_progress = 0,
             generation_error = NULL, current_operation = NULL, updated_at = NOW()
         WHERE user_id = $1 AND id = ANY($2::int[]) AND type IN ('article', 'text')
         RETURNING id`,
        [userId, ids]
      );
      for (const row of r.rows) await deleteAudioFile(row.id);
      affected = r.rowCount ?? 0;
    }

    if (action === 'remove_summary') {
      const r = await query(
        `UPDATE content_items
         SET summary = NULL, comment_summary = NULL, summary_status = 'idle',
             summary_generated_at = NULL, updated_at = NOW()
         WHERE user_id = $1 AND id = ANY($2::int[])`,
        [userId, ids]
      );
      affected = r.rowCount ?? 0;
    }

    if (action === 'delete') {
      // Mirrors DELETE /:id: collect Wallabag ids first, delete locally, then fire-and-forget
      // the Wallabag deletions (non-blocking, failures only logged).
      const wb = await query(
        `SELECT wallabag_id FROM content_items
         WHERE user_id = $1 AND id = ANY($2::int[]) AND wallabag_id IS NOT NULL`,
        [userId, ids]
      );
      const r = await query(
        `DELETE FROM content_items WHERE user_id = $1 AND id = ANY($2::int[]) RETURNING id`,
        [userId, ids]
      );
      affected = r.rowCount ?? 0;
      // Delete each item's on-disk audio file too, otherwise the mp3s orphan on the /data volume.
      // Run the unlinks in parallel instead of one-at-a-time. allSettled so a single failed
      // deletion never aborts the others or fails the request (deleteAudioFile is best-effort).
      await Promise.allSettled(r.rows.map((row) => deleteAudioFile(row.id)));
      if (wb.rows.length > 0) {
        const { deleteFromWallabag } = await import('../services/wallabag-sync.js');
        for (const row of wb.rows) {
          deleteFromWallabag(userId, row.wallabag_id).catch(err => {
            console.error(`[bulk] Wallabag delete failed (ID: ${row.wallabag_id}):`, err);
          });
        }
      }
    }

    console.log(`[bulk] user=${userId} action=${action} ids=${ids.length} affected=${affected}`);
    res.json({ affected });
  } catch (error) {
    console.error('Error in bulk action:', error);
    res.status(500).json({ error: 'Failed to perform bulk action' });
  }
});

// Get single content item (includes large columns needed for display)
router.get('/:id', async (req, res) => {
  try {
    const result = await query(
      `SELECT id, type, title, url, content, html_content, author, description, preview_picture, audio_url, transcript, duration, file_size, podcast_id, podcast_show_name, episode_number, published_at, is_starred, is_archived, tags, playback_position, playback_speed, last_played_at, created_at, updated_at, generation_status, generation_progress, generation_error, current_operation, tts_chunks, transcript_words, content_alignment, karma, agree_votes, disagree_votes, comments, content_source, comment_source, audio_generated_at, content_fetched_at, summary, comment_summary, summary_status, summary_generated_at, summary_error, COALESCE(comment_count_total, 0) AS comment_count FROM content_items WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.user!.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Content not found' });
    }

    const item = withAudioToken(result.rows[0]);
    // Log podcast episode URLs so we can diagnose CDN/streaming issues in Railway logs
    if (item.type === 'podcast_episode' && item.audio_url) {
      console.log(`[PodcastDebug] id=${item.id} show="${item.podcast_show_name}" url=${item.audio_url}`);
    }
    res.json(item);
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
      url: rawUrl,
      content,
      author,
      description,
      preview_picture,
      podcast_id,
      audio_url,
      published_at,
      duration,
    } = req.body;

    // Rewrite EA Forum links to the bot-friendly mirror (forum.effectivealtruism.org ->
    // forum-bots.effectivealtruism.org). Applies to BOTH the Add tab and RSS "add to library",
    // since both add paths go through this endpoint. Non-EA-Forum links are left untouched.
    const url = normalizeEAForumUrl(rawUrl);

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
    let commentSource: string | null = null;
    let commentCountTotal: number = 0;
    let podcastShowName: string | null = null;

    // For text items, store content in html_content too so read-along works (same as articles)
    // Strip <script> and <style> tags to prevent injected CSS from breaking the player UI
    // Also clean up broken Obsidian/saved-webpage artifacts (broken markdown image syntax, relative image paths)
    if (type === 'text' && processedContent && !htmlContent) {
      const dom = new JSDOM(processedContent);
      const doc = dom.window.document;
      doc.querySelectorAll('script, style').forEach(el => el.remove());

      // Clean up broken Obsidian markdown image artifacts:
      // When Obsidian exports to HTML, markdown image links like ![](url) can get split into:
      //   <p>[</p>  <p><img src="local_cache.jpg"></p>  <p>](https://real-url.com/image.png)</p>
      // Fix: replace relative-path images with the real URL from the ](url) text that follows,
      // and remove the stray [ and ](url) text elements.
      const allElements = Array.from(doc.querySelectorAll('p, div'));
      for (let i = 0; i < allElements.length; i++) {
        const el = allElements[i];
        const text = el.textContent?.trim() || '';

        // Detect ](https://...) pattern, which is the trailing part of a broken markdown image link
        const mdLinkMatch = text.match(/^\]\s*\(\s*(https?:\/\/[^\s)]+)\s*\)$/);
        if (mdLinkMatch) {
          const realUrl = mdLinkMatch[1];

          // Look backward for an <img> element (possibly with a [ before it)
          // The pattern is: <p>[</p> <p><img ...></p> <p>](url)</p>
          // or sometimes: <p><img ...></p> <p>](url)</p>
          let imgEl: Element | null = null;
          let bracketEl: Element | null = null;

          // Check previous sibling for <img>
          const prev = allElements[i - 1];
          if (prev) {
            const prevImg = prev.querySelector('img') || (prev.tagName === 'IMG' ? prev : null);
            if (prevImg) {
              imgEl = prevImg;
              // Check if element before that is just "["
              const prevPrev = allElements[i - 2];
              if (prevPrev && prevPrev.textContent?.trim() === '[') {
                bracketEl = prevPrev;
              }
            } else if (prev.textContent?.trim() === '[') {
              // Maybe img is inside prev's parent or we need to look further
              bracketEl = prev;
            }
          }

          if (imgEl) {
            // Check if the image has a non-http src (local/relative path)
            const src = imgEl.getAttribute('src') || '';
            if (!src.startsWith('http://') && !src.startsWith('https://') && !src.startsWith('data:')) {
              // Replace with the real URL from the markdown link
              imgEl.setAttribute('src', realUrl);
            }
            // Remove the ](url) text element
            el.parentNode?.removeChild(el);
            // Remove the stray [ element if found
            if (bracketEl) {
              bracketEl.parentNode?.removeChild(bracketEl);
            }
          } else {
            // No img found before, just remove the broken markdown text
            el.parentNode?.removeChild(el);
          }
          continue;
        }

        // Remove standalone "[" or "]" text that's part of broken markdown image syntax
        // Only if it's a very short element (just brackets, maybe whitespace)
        if (text === '[' || text === ']') {
          // Check if there's an img nearby (next or previous element)
          const next = allElements[i + 1];
          const prev2 = allElements[i - 1];
          const hasNearbyImg = (next && next.querySelector?.('img')) || (prev2 && prev2.querySelector?.('img'));
          if (hasNearbyImg) {
            el.parentNode?.removeChild(el);
          }
        }
      }

      // Fix remaining images with relative/local paths. Replace src with empty to trigger onerror,
      // or remove them if they can't possibly load
      doc.querySelectorAll('img').forEach(img => {
        const src = img.getAttribute('src') || '';
        if (src && !src.startsWith('http://') && !src.startsWith('https://') && !src.startsWith('data:')) {
          // Relative path, won't work on server, remove the image
          img.parentNode?.removeChild(img);
        }
      });

      htmlContent = doc.body.innerHTML;
    }

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

      commentSource = articleData.comment_source || null;
      commentCountTotal = articleData.comment_count_total || 0;
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

    const dbType = type;

    // FIX 3: Use finalPreviewPicture instead of raw preview_picture
    // Set content_fetched_at for articles fetched from a URL
    const contentFetchedAt = (type === 'article' && url) ? new Date() : null;
    const result = await query(
      `INSERT INTO content_items
       (type, title, url, content, html_content, author, description, preview_picture, audio_url, podcast_id, podcast_show_name, published_at, duration, karma, agree_votes, disagree_votes, comments, comment_source, comment_count_total, content_source, user_id, content_fetched_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22)
       RETURNING *`,
      [dbType, finalTitle, url, processedContent, htmlContent, finalAuthor, finalDescription, finalPreviewPicture, audioUrlValue, podcast_id || null, podcastShowName, finalPublishedAt || null, duration || null, karma, agreeVotes, disagreeVotes, extractedComments, commentSource, commentCountTotal, 'wallacast', req.user!.userId, contentFetchedAt]
    );

    const createdItem = result.rows[0];
    
    // Auto-generate audio for articles
    if ((type === 'article' || type === 'text') && !audioUrlValue && (processedContent || htmlContent)) {
      const autoGenerateAudio = await getUserSetting(req.user!.userId, 'auto_generate_audio_for_articles');
      const shouldAutoGenerate = autoGenerateAudio === 'true';

      if (shouldAutoGenerate) {
        // Check max comment limit. Skip auto-generation if article has too many comments
        const maxCommentsStr = await getUserSetting(req.user!.userId, 'max_narrated_comments');
        const maxComments = maxCommentsStr ? parseInt(maxCommentsStr, 10) || 50 : 50;
        const articleCommentCount = createdItem.comment_count_total || 0;

        if (articleCommentCount > maxComments) {
          console.log(`Skipping auto-generation for ${createdItem.id}: ${articleCommentCount} comments exceeds max ${maxComments}`);
        } else {
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
    }

    // Auto-generate summary for articles/texts (independent of audio, both can run at once).
    // No comment cutoff here (unlike audio): summaries are cheap and the user asked for none.
    if ((type === 'article' || type === 'text') && (processedContent || htmlContent)) {
      const autoGenerateSummary = await getUserSetting(req.user!.userId, 'auto_generate_summary');
      if (autoGenerateSummary === 'true') {
        console.log(`Auto-generating summary for ${type} ${createdItem.id}`);
        await query(
          'UPDATE content_items SET summary_status = $1 WHERE id = $2',
          ['generating', createdItem.id]
        );
        generateSummaryForContent(createdItem.id)
          .then(() => console.log(`Summary generation finished for ${createdItem.id}`))
          .catch(async (error) => {
            console.error('Auto summary generation error:', error);
            await query(
              'UPDATE content_items SET summary_status = $1 WHERE id = $2',
              ['failed', createdItem.id]
            ).catch(() => { /* swallow */ });
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

        // Build Whisper prompt so it recognizes title, author, comment headers
        const whisperPrompt = buildWhisperPrompt({
          title: createdItem.title,
          author: createdItem.author,
          published_at: createdItem.published_at,
          podcast_show_name: createdItem.podcast_show_name,
          comments: createdItem.comments,
        });
        console.log('Generated Whisper Prompt for new episode:', whisperPrompt);

        transcribeWithTimestamps(audioUrlValue, req.user!.userId, whisperPrompt)
          .then(async (result) => {
            await query(
              'UPDATE content_items SET transcript = $1, transcript_words = $2, generation_status = $3, generation_progress = $4, current_operation = NULL, updated_at = CURRENT_TIMESTAMP, wallabag_needs_push = TRUE WHERE id = $5',
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

    // Manual Markdown/HTML edit of an article/text body. The frontend converts Markdown ->
    // HTML and sends { is_edit: true, html_content, content }. We snapshot the current body
    // first (so the edit is undoable), sanitize, and treat the edit like a fresh fetch
    // (content_fetched_at = now). Audio + read-along are left untouched-but-outdated. The
    // provenance then shows the content is newer than the narration (regenerate to re-sync).
    if (updates.is_edit === true) {
      const cur = await query(
        'SELECT type, title, html_content, content, comments FROM content_items WHERE id = $1 AND user_id = $2',
        [id, req.user!.userId]
      );
      if (cur.rows.length > 0 && (cur.rows[0].type === 'article' || cur.rows[0].type === 'text')) {
        await snapshotContentVersion(id, req.user!.userId, cur.rows[0], 'edit').catch((err) =>
          console.error('Failed to snapshot version before edit:', err)
        );
        if (typeof updates.html_content === 'string') {
          updates.html_content = sanitizeEditedHtml(updates.html_content);
        }
        updates.content_fetched_at = new Date();
        updates.content_source = 'wallacast';
        allowedFields.push('html_content', 'content', 'content_fetched_at', 'content_source');
      }
      delete updates.is_edit;
    }

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
          updates.content_alignment = null;
          updates.transcript = null;
          updates.transcript_words = null;
          updates.tts_chunks = null;
          // Match the bulk remove_audio field list: reset to idle and clear any prior
          // failure, otherwise a previously-failed item keeps its red error box after removal.
          updates.generation_status = 'idle';
          updates.generation_progress = 0;
          updates.generation_error = null;
          updates.current_operation = null;
          allowedFields.push('audio_data', 'audio_url', 'duration', 'content_alignment', 'transcript', 'transcript_words', 'tts_chunks', 'generation_status', 'generation_progress', 'generation_error', 'current_operation');
          await deleteAudioFile(id); // audio now lives on disk, delete the file too
        }
      }
    }

    // Remove summary (mirrors audio removal): frontend sends { summary: null } to clear it.
    if (updates.summary === null) {
      updates.comment_summary = null;
      updates.summary_status = 'idle';
      updates.summary_generated_at = null;
      updates.summary_error = null;
      allowedFields.push('summary', 'comment_summary', 'summary_status', 'summary_generated_at', 'summary_error');
    }

    // Dismiss a failed-generation / failed-summary error from the UI: reset the failed status
    // to idle and clear the stored message so the red error box on the card goes away.
    if (updates.dismiss_generation_error === true) {
      updates.generation_status = 'idle';
      updates.generation_error = null;
      updates.current_operation = null;
      updates.generation_progress = 0;
      allowedFields.push('generation_status', 'generation_error', 'current_operation', 'generation_progress');
      delete updates.dismiss_generation_error;
    }
    if (updates.dismiss_summary_error === true) {
      updates.summary_status = 'idle';
      updates.summary_error = null;
      allowedFields.push('summary_status', 'summary_error');
      delete updates.dismiss_summary_error;
    }

    if (updates.regenerate_transcript === true) {
      const contentResult = await query(
        'SELECT type, audio_url, title, author, published_at, comments FROM content_items WHERE id = $1 AND user_id = $2',
        [id, req.user!.userId]
      );

      if (contentResult.rows.length > 0) {
        const { type, audio_url, title, author, published_at, comments } = contentResult.rows[0];

        if (audio_url) {
          console.log(`Regenerating transcript for ${type} ${id}`);

          // Build Whisper prompt hint for better transcription of key phrases
          const whisperPrompt = buildWhisperPrompt({ title, author, published_at, comments });
          console.log('Generated Whisper Prompt:', whisperPrompt);

          (async () => {
            try {
              await query(
                'UPDATE content_items SET generation_status = $1, generation_progress = $2, current_operation = $3 WHERE id = $4',
                ['generating_transcript', 0, 'transcript', id]
              );

              // CHANGED: Removed .slice(0, 1000) here; the service handles the slicing logic centrally.
              const result = await transcribeWithTimestamps(audio_url, req.user!.userId, whisperPrompt);

              // Decide up front whether LLM alignment will run (articles/texts that have a body).
              // The frontend stops polling the instant generation_status turns terminal, so we must
              // NOT report 'completed' here when alignment still has to run. Otherwise it refreshes
              // while content_alignment is stale and shows the old read-along. Keep the status
              // non-terminal ('generating_transcript' + 'aligning_content') until alignment ends.
              const htmlRow = await query('SELECT html_content FROM content_items WHERE id = $1', [id]);
              const hasHtmlContent = htmlRow.rows.length > 0 && !!htmlRow.rows[0].html_content;
              const willAlign = (type === 'article' || type === 'text') && (hasHtmlContent || type === 'text');

              await query(
                'UPDATE content_items SET transcript = $1, transcript_words = $2, generation_status = $3, generation_progress = $4, current_operation = $5, updated_at = CURRENT_TIMESTAMP, wallabag_needs_push = TRUE WHERE id = $6',
                [
                  result.text,
                  JSON.stringify(result.words),
                  willAlign ? 'generating_transcript' : 'completed',
                  willAlign ? 97 : 100,
                  willAlign ? 'aligning_content' : null,
                  id,
                ]
              );

              // Run LLM alignment for articles and text items (not podcasts). The status set
              // above stays non-terminal until this block writes the final 'completed'.
              if (willAlign) {
                console.log(`[LLM-Align] Running alignment for ${type} ${id}...`);
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

              console.log(`Transcript regenerated successfully for ${type} ${id}`);
            } catch (error) {
              console.error('Transcript regeneration error:', error);
              await query(
                // Mark the failed step so the card's Retry re-runs transcript regen (not audio gen)
                "UPDATE content_items SET generation_status = $1, generation_error = $2, generation_progress = $3, current_operation = 'failed_transcript' WHERE id = $4",
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
      // Only read whether a blob exists and its stored size, never the blob itself.
      // Loading audio_data (BYTEA, tens of MB) into RAM just to check existence was wasteful.
      const contentResult = await query(
        'SELECT audio_data IS NOT NULL AS has_blob, pg_column_size(audio_data) AS blob_bytes, type, is_starred FROM content_items WHERE id = $1 AND user_id = $2',
        [id, req.user!.userId]
      );

      if (contentResult.rows.length > 0) {
        const { has_blob, blob_bytes, type, is_starred: dbStarred } = contentResult.rows[0];

        // CHECK IF FAVORITED IN THIS UPDATE OR PREVIOUSLY
        // If updates.is_starred is present, use it. Otherwise use DB value.
        const effectiveStarred = updates.is_starred !== undefined ? updates.is_starred : dbStarred;

        // Audio may be in the DB blob (legacy) OR on the disk volume (new). Check both, so
        // archiving still frees space after the migration (when audio_data is NULL).
        const diskBytes = await getAudioFileSize(id);
        const hasAudio = has_blob || diskBytes !== null;

        // Only delete audio for articles (not podcasts) and only if not favorited
        if (hasAudio && (type === 'article' || type === 'text') && !effectiveStarred) {
          const sizeMB = ((blob_bytes ?? diskBytes ?? 0) / 1024 / 1024).toFixed(2);
          console.log(`Archived: Deleting ${sizeMB} MB of audio to save space`);
          updates.audio_data = null;
          updates.audio_url = null;
          updates.duration = null;
          updates.content_alignment = null;
          updates.transcript = null;
          updates.transcript_words = null;
          updates.tts_chunks = null;
          allowedFields.push('audio_data', 'audio_url', 'duration', 'content_alignment', 'transcript', 'transcript_words', 'tts_chunks');
          await deleteAudioFile(id); // remove the on-disk file too
        } else if (hasAudio && effectiveStarred) {
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
          // Only auto-generate if user has the setting enabled
          const autoGenerateAudio = await getUserSetting(req.user!.userId, 'auto_generate_audio_for_articles');
          const shouldAutoGenerate = autoGenerateAudio === 'true';

          if (shouldAutoGenerate) {
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
          } else {
            console.log(`Un-archiving article ${id}: skipping audio regeneration (auto_generate_audio_for_articles is off)`);
          }
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
      // Any non-playback change (star, archive, title, edit) must be re-pushed to Wallabag.
      // We flag it explicitly instead of relying on an updated_at vs wallabag_updated_at
      // comparison, which is unreliable because those two columns are on different clocks.
      setClause.push(`wallabag_needs_push = TRUE`);
    }

    values.push(id);
    paramCount++;
    values.push(req.user!.userId);

    // CRITICAL FIX: Never use RETURNING *. It includes audio_data (BYTEA, 10-50MB),
    // which was being sent in every response, causing ~7GB/hour of data transfer
    // during playback (saves every 10s). For playback-only updates, return minimal data.
    // For content updates, return the same columns as the list endpoint.
    const returningClause = updatingContentFields
      ? 'RETURNING id, type, title, url, content, author, description, preview_picture, audio_url, duration, file_size, podcast_id, episode_number, published_at, is_starred, is_archived, tags, playback_position, playback_speed, last_played_at, created_at, updated_at, generation_status, generation_progress, generation_error, current_operation, tts_chunks, transcript_words, karma, agree_votes, disagree_votes, summary_status, summary_generated_at, summary_error'
      : 'RETURNING id, playback_position, playback_speed, last_played_at';

    const sql = `UPDATE content_items SET ${setClause.join(', ')} WHERE id = $${paramCount - 1} AND user_id = $${paramCount} ${returningClause}`;
    const result = await query(sql, values);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Content not found' });
    }

    res.json(withAudioToken(result.rows[0]));
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

    await deleteAudioFile(req.params.id); // remove the on-disk audio file, if any

    res.json({ message: 'Content deleted successfully' });
  } catch (error) {
    console.error('Error deleting content item:', error);
    res.status(500).json({ error: 'Failed to delete content item' });
  }
});

// Download original (raw) HTML from source URL. No cleaning, for debugging
// Export all fields for a content item as a zip file (except audio_data which is too large)
router.get('/:id/export', async (req, res) => {
  try {
    const { id } = req.params;

    const result = await query(
      `SELECT id, type, title, url, content, html_content, author, description, preview_picture,
              audio_url, transcript, duration, file_size, podcast_id, podcast_show_name,
              episode_number, published_at, is_starred, is_archived, tags,
              wallabag_id, wallabag_updated_at, playback_position, playback_speed, last_played_at,
              generation_status, generation_progress, generation_error, current_operation,
              tts_chunks, transcript_words, content_alignment,
              karma, agree_votes, disagree_votes, comments, comment_source,
              COALESCE(comment_count_total, 0) AS comment_count,
              content_source, content_fetched_at, audio_generated_at,
              images_processed, image_alt_text_data,
              summary, comment_summary, summary_status, summary_generated_at,
              created_at, updated_at, user_id
       FROM content_items WHERE id = $1 AND user_id = $2`,
      [id, req.user!.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Content not found' });
    }

    const data = result.rows[0];
    const safeName = (data.title || 'content').replace(/[^a-zA-Z0-9-_ ]/g, '').substring(0, 100);

    // Separate large text fields into their own files
    const htmlContent = data.html_content || '';
    const textContent = data.content || '';
    const transcript = data.transcript || '';
    const comments = data.comments;
    const contentAlignment = data.content_alignment;
    const transcriptWords = data.transcript_words;
    const ttsChunks = data.tts_chunks;
    const imageAltTextData = data.image_alt_text_data;

    // Build metadata object without the large fields
    const metadata = { ...data };
    delete metadata.html_content;
    delete metadata.content;
    delete metadata.transcript;
    delete metadata.comments;
    delete metadata.content_alignment;
    delete metadata.transcript_words;
    delete metadata.tts_chunks;
    delete metadata.image_alt_text_data;

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}.zip"`);

    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.pipe(res);

    archive.append(JSON.stringify(metadata, null, 2), { name: 'metadata.json' });
    if (htmlContent) archive.append(htmlContent, { name: 'content.html' });
    if (textContent) archive.append(textContent, { name: 'content_plain.txt' });
    if (transcript) archive.append(transcript, { name: 'transcript.txt' });

    const jsonField = (val: any) => typeof val === 'string' ? val : JSON.stringify(val, null, 2);
    if (comments) archive.append(jsonField(comments), { name: 'comments.json' });
    if (contentAlignment) archive.append(jsonField(contentAlignment), { name: 'alignment.json' });
    if (transcriptWords) archive.append(jsonField(transcriptWords), { name: 'transcript_words.json' });
    if (ttsChunks) archive.append(jsonField(ttsChunks), { name: 'tts_chunks.json' });
    if (imageAltTextData) archive.append(jsonField(imageAltTextData), { name: 'image_alt_text.json' });

    await archive.finalize();
  } catch (error) {
    console.error('Error exporting content item:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to export content item' });
    }
  }
});

router.get('/:id/original-html', async (req, res) => {
  try {
    const { id } = req.params;

    const contentResult = await query(
      'SELECT url FROM content_items WHERE id = $1 AND user_id = $2',
      [id, req.user!.userId]
    );

    if (contentResult.rows.length === 0) {
      return res.status(404).json({ error: 'Content not found' });
    }

    const { url } = contentResult.rows[0];
    if (!url) {
      return res.status(400).json({ error: 'No source URL available for this content' });
    }

    console.log(`[Original HTML] Fetching raw HTML from: ${url}`);
    const response = await fetch(url);
    if (!response.ok) {
      return res.status(502).json({ error: `Source returned HTTP ${response.status}` });
    }

    const html = await response.text();
    console.log(`[Original HTML] Got ${html.length} bytes of raw HTML`);

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (error) {
    console.error('Error fetching original HTML:', error);
    res.status(500).json({ error: 'Failed to fetch original HTML' });
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

        // Mark an in-progress status so the card shows a spinner and so a failure is visible.
        await query(
          'UPDATE content_items SET generation_status = $1, generation_progress = $2, current_operation = $3 WHERE id = $4',
          ['fetching', 10, 'fetching_article', id]
        );

        // Snapshot the current body before the refetch overwrites it (undoable via version history)
        const before = await query(
          'SELECT title, html_content, content, comments FROM content_items WHERE id = $1 AND user_id = $2',
          [id, req.user!.userId]
        );
        if (before.rows.length > 0) {
          await snapshotContentVersion(id, req.user!.userId, before.rows[0], 'refetch').catch((err) =>
            console.error('Failed to snapshot version before refetch:', err)
          );
        }

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
            comment_source = $10,
            comment_count_total = $11,
            content_source = 'wallacast',
            wallabag_needs_push = TRUE,
            generation_status = 'completed',
            generation_progress = 100,
            current_operation = NULL,
            updated_at = NOW(),
            content_fetched_at = NOW()
          WHERE id = $12`,
          [
            articleData.cleaned_html,
            articleData.content,
            articleData.author || articleData.byline,
            articleData.published_date,
            articleData.karma,
            articleData.agree_votes,
            articleData.disagree_votes,
            commentsJson,
            articleData.lead_image_url || null,
            articleData.comment_source || null,
            articleData.comment_count_total || 0,
            id
          ]
        );

        console.log(`Refetch completed for article ${id}`);
      } catch (error) {
        console.error(`Refetch error for article ${id}:`, error);
        // Mark the failed step so the card's Retry re-runs a refetch (not audio gen).
        await query(
          "UPDATE content_items SET generation_status = $1, generation_error = $2, generation_progress = $3, current_operation = 'failed_refetch' WHERE id = $4",
          ['failed', (error as Error).message || 'Failed to refetch content', 0, id]
        ).catch(() => { /* swallow */ });
      }
    })();

    res.json({ message: 'Refetch started' });
  } catch (error) {
    console.error('Error starting refetch:', error);
    res.status(500).json({ error: 'Failed to start refetch' });
  }
});

// List version-history snapshots for an item (lean metadata only, no html bodies).
router.get('/:id/versions', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await query(
      `SELECT id, source, title, created_at,
              octet_length(COALESCE(html_content, '')) AS html_bytes,
              (comments IS NOT NULL) AS has_comments
       FROM content_versions
       WHERE content_item_id = $1 AND user_id = $2
       ORDER BY created_at DESC`,
      [id, req.user!.userId]
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Error listing content versions:', error);
    res.status(500).json({ error: 'Failed to list versions' });
  }
});

// Fetch a single version's full body (for viewing before restoring).
router.get('/:id/versions/:versionId', async (req, res) => {
  try {
    const { id, versionId } = req.params;
    const result = await query(
      `SELECT id, source, title, html_content, content, comments, created_at
       FROM content_versions
       WHERE id = $1 AND content_item_id = $2 AND user_id = $3`,
      [versionId, id, req.user!.userId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Version not found' });
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error fetching content version:', error);
    res.status(500).json({ error: 'Failed to fetch version' });
  }
});

// Restore a previous version. Snapshots the CURRENT body first (so restore is undoable),
// then overwrites the item's body from the chosen version. Like an edit/refetch, this leaves
// audio + read-along untouched-but-outdated.
router.post('/:id/versions/:versionId/restore', async (req, res) => {
  try {
    const { id, versionId } = req.params;

    const v = await query(
      `SELECT title, html_content, content, comments FROM content_versions
       WHERE id = $1 AND content_item_id = $2 AND user_id = $3`,
      [versionId, id, req.user!.userId]
    );
    if (v.rows.length === 0) return res.status(404).json({ error: 'Version not found' });
    const version = v.rows[0];

    const cur = await query(
      'SELECT title, html_content, content, comments FROM content_items WHERE id = $1 AND user_id = $2',
      [id, req.user!.userId]
    );
    if (cur.rows.length === 0) return res.status(404).json({ error: 'Content not found' });

    await snapshotContentVersion(id, req.user!.userId, cur.rows[0], 'restore').catch((err) =>
      console.error('Failed to snapshot before restore:', err)
    );

    const commentsValue =
      version.comments == null
        ? null
        : typeof version.comments === 'string'
          ? version.comments
          : JSON.stringify(version.comments);

    await query(
      `UPDATE content_items SET
         html_content = $1, content = $2, comments = $3,
         content_source = 'wallacast', content_fetched_at = NOW(), updated_at = NOW(),
         wallabag_needs_push = TRUE
       WHERE id = $4 AND user_id = $5`,
      [version.html_content, version.content, commentsValue, id, req.user!.userId]
    );

    res.json({ message: 'Version restored' });
  } catch (error) {
    console.error('Error restoring content version:', error);
    res.status(500).json({ error: 'Failed to restore version' });
  }
});

// Generate TTS for an article
router.post('/:id/generate-audio', async (req, res) => {
  try {
    const { id } = req.params;
    const { regenerate, exclude_comments } = req.body;

    // OPTIMIZED: Select only necessary columns, excluding audio_data
    const contentResult = await query(
      'SELECT id, type, generation_status, generation_progress, audio_url, comment_count_total FROM content_items WHERE id = $1 AND user_id = $2',
      [id, req.user!.userId]
    );

    if (contentResult.rows.length === 0) {
      return res.status(404).json({ error: 'Content not found' });
    }

    const contentItem = contentResult.rows[0];
    console.log(`[generate-audio] id=${id} comment_count_total=${contentItem.comment_count_total} exclude_comments=${exclude_comments} regenerate=${regenerate}`);

    if (contentItem.type !== 'article' && contentItem.type !== 'text') {
      return res.status(400).json({ error: 'TTS only available for articles and text' });
    }

    // Any non-terminal (in-flight) status means a pipeline is already running. Auto-generation
    // sets 'starting' first, so guarding only on 'generating_audio' let a click in that window
    // double-start TTS (double spend). Guard on the full in-flight set instead.
    const IN_FLIGHT_STATUSES = [
      'starting', 'fetching', 'extracting_content', 'content_ready',
      'generating_audio', 'generating_transcript', 'ready',
    ];
    if (!regenerate && IN_FLIGHT_STATUSES.includes(contentItem.generation_status)) {
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

    generateAudioForContent(parseInt(id), !!regenerate, !!exclude_comments)
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

// Generate (or regenerate) summaries. Articles/texts summarize their body (+ comments);
// podcast episodes summarize their transcript. Runs independently of audio generation,
// uses its own `summary_status` field so both can be in progress at the same time.
// For podcasts WITHOUT a transcript: pass `generate_transcript: true` to first run Whisper
// and then summarize (the frontend shows a confirmation before doing this); without the
// flag the request is rejected with code 'no_transcript' so the frontend can warn.
router.post('/:id/generate-summary', async (req, res) => {
  try {
    const { id } = req.params;
    const generateTranscript = req.body?.generate_transcript === true;

    const contentResult = await query(
      'SELECT id, type, summary_status, transcript, audio_url, generation_status, title, author, published_at, comments FROM content_items WHERE id = $1 AND user_id = $2',
      [id, req.user!.userId]
    );

    if (contentResult.rows.length === 0) {
      return res.status(404).json({ error: 'Content not found' });
    }

    const contentItem = contentResult.rows[0];

    if (contentItem.type !== 'article' && contentItem.type !== 'text' && contentItem.type !== 'podcast_episode') {
      return res.status(400).json({ error: 'Summaries are not available for this content type' });
    }

    if (contentItem.summary_status === 'generating') {
      return res.status(409).json({
        error: 'Summary generation already in progress',
        summary_status: 'generating',
      });
    }

    const needsTranscript = contentItem.type === 'podcast_episode' && !(contentItem.transcript || '').trim();

    if (needsTranscript && !generateTranscript) {
      return res.status(400).json({
        error: 'This podcast episode has no transcript yet. Generate the transcript first.',
        code: 'no_transcript',
      });
    }
    if (needsTranscript && !contentItem.audio_url) {
      return res.status(400).json({ error: 'Episode has no audio to transcribe' });
    }
    if (needsTranscript && contentItem.generation_status === 'generating_transcript') {
      return res.status(409).json({ error: 'Transcription already in progress' });
    }

    await query(
      'UPDATE content_items SET summary_status = $1 WHERE id = $2',
      ['generating', id]
    );

    const runSummary = () =>
      generateSummaryForContent(parseInt(id))
        .then(() => console.log(`Summary generation finished for ${id}`))
        .catch(async (error) => {
          console.error('Background summary generation error:', error);
          await query(
            'UPDATE content_items SET summary_status = $1 WHERE id = $2',
            ['failed', id]
          ).catch(() => { /* swallow */ });
        });

    if (needsTranscript) {
      // Transcript-then-summary chain (same transcription flow as routes/transcription.ts)
      await query(
        'UPDATE content_items SET generation_status = $1, generation_progress = $2, generation_error = NULL, current_operation = $3 WHERE id = $4',
        ['generating_transcript', 0, 'transcript', id]
      );
      console.log(`Starting transcription (for summary) for content ${id}`);
      const whisperPrompt = buildWhisperPrompt({
        title: contentItem.title,
        author: contentItem.author,
        published_at: contentItem.published_at,
        comments: contentItem.comments,
      });
      transcribeWithTimestamps(contentItem.audio_url, req.user!.userId, whisperPrompt)
        .then(async (result) => {
          console.log(`Transcription complete for ${id} (${result.words.length} words), starting summary`);
          await query(
            'UPDATE content_items SET transcript = $1, transcript_words = $2, generation_status = $3, generation_progress = $4, current_operation = NULL, updated_at = CURRENT_TIMESTAMP, wallabag_needs_push = TRUE WHERE id = $5 AND user_id = $6',
            [result.text, JSON.stringify(result.words), 'completed', 100, id, req.user!.userId]
          );
          await runSummary();
        })
        .catch(async (error) => {
          console.error('Background transcription (for summary) error:', error);
          await query(
            'UPDATE content_items SET generation_status = $1, generation_error = $2, generation_progress = $3, current_operation = NULL, summary_status = $4 WHERE id = $5 AND user_id = $6',
            ['failed', error.message || 'Failed to transcribe', 0, 'failed', id, req.user!.userId]
          ).catch(() => { /* swallow */ });
        });
    } else {
      runSummary();
    }

    res.json({ message: 'Summary generation started', summary_status: 'generating' });
  } catch (error) {
    console.error('Error starting summary generation:', error);
    res.status(500).json({ error: 'Failed to start summary generation' });
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
