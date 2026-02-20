import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import fetch from 'node-fetch';
import { initializeDatabase, closePool } from './database/db.js';
import { ensureStorageDirectories, getAudioDir } from './config/storage.js';
import contentRouter from './routes/content.js';
import podcastRouter from './routes/podcasts.js';
import queueRouter from './routes/queue.js';
import transcriptionRouter from './routes/transcription.js';
import authRouter from './routes/auth.js';
import usersRouter from './routes/users.js';
import wallabagRouter from './routes/wallabag.js';
import { requireAuth, requireDatabaseReady } from './middleware/auth.js';
import { bootstrapFirstUser } from './services/auth.js';
import { query } from './database/db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config();

const app = express();
const PORT = parseInt(process.env.PORT || '3001', 10);

// CORS configuration
const corsOptions = {
  origin: process.env.FRONTEND_URL || 'http://localhost:5173',
  credentials: true,
};

app.use(cors(corsOptions));
app.use(express.json({ limit: '50mb' }));

// Serve static files (audio, images, etc.) from persistent storage
app.use('/audio', express.static(getAudioDir()));
app.use('/uploads', express.static(path.join(process.cwd(), 'public', 'uploads')));

// Public routes (no auth required)
app.get('/', (req, res) => {
  res.json({
    name: 'Wallacast API',
    version: '1.0.0',
    status: 'ok'
  });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Auth routes (no JWT auth required, but requires database)
app.use('/api/auth', requireDatabaseReady, authRouter);

// Public audio endpoint (no auth - HTML5 audio player can't send JWT tokens)
// Must be registered before protected /api/content routes to match first
app.get('/api/content/:id/audio', requireDatabaseReady, async (req, res) => {
  try {
    const range = req.headers.range;

    // Step 0: Cheap metadata check — type + audio_url only, no blob access.
    // Podcast episodes have an external audio_url and no audio_data in the DB,
    // so they need to be proxied. Articles/texts have audio_data and go through
    // the optimised DB path below.
    const metaResult = await query(
      'SELECT type, audio_url FROM content_items WHERE id = $1',
      [req.params.id]
    );

    if (metaResult.rows.length === 0) {
      return res.status(404).json({ error: 'Audio not found' });
    }

    const { type, audio_url: audioUrl } = metaResult.rows[0];

    // -------------------------------------------------------------------------
    // PATH A: podcast episode — proxy external CDN URL through our server.
    // This sidesteps CORS issues (e.g. api.substack.com blocks cross-origin
    // range requests from the browser). We forward the Range header so only
    // the requested bytes are fetched upstream — never the full file.
    // -------------------------------------------------------------------------
    if (type === 'podcast_episode' && audioUrl) {
      const upstreamHeaders: Record<string, string> = {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      };
      if (range) {
        upstreamHeaders['Range'] = range;
      }

      console.log(`[AudioProxy] ${range || 'no-range'} → ${audioUrl.substring(0, 100)}`);

      const upstreamRes = await fetch(audioUrl, { headers: upstreamHeaders });

      if (!upstreamRes.ok && upstreamRes.status !== 206) {
        console.error(`[AudioProxy] Upstream error ${upstreamRes.status} for ${audioUrl}`);
        return res.status(502).json({ error: 'Upstream audio unavailable' });
      }

      res.status(upstreamRes.status);
      for (const header of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
        const val = upstreamRes.headers.get(header);
        if (val) res.setHeader(header, val);
      }

      if (!upstreamRes.body) return res.end();

      // node-fetch body is a Node.js ReadableStream — pipe it directly to the
      // Express response. Same pattern used by transcription.ts for podcast audio.
      // Never buffers the full file: each chunk flows through as it arrives.
      upstreamRes.body.pipe(res);
      upstreamRes.body.on('error', (err: Error) => {
        console.error('[AudioProxy] Stream error:', err.message);
        if (!res.writableEnded) res.end();
      });
      return;
    }

    // -------------------------------------------------------------------------
    // PATH B: article/text — serve audio_data from the database.
    // Uses PostgreSQL substring() for range requests so only the needed bytes
    // are read from the TOAST store (no full-blob loads = fast seeking).
    // -------------------------------------------------------------------------
    if (range) {
      // RANGE REQUEST: Use PostgreSQL substring() to read only the needed bytes
      // instead of loading the entire blob (which could be 50-100MB for long audio).
      // This makes seeking near-instant instead of 4-5 seconds.

      // Get file size without reading the blob (fast - no TOAST access)
      const sizeResult = await query(
        'SELECT COALESCE(file_size, length(audio_data)) as total_size FROM content_items WHERE id = $1 AND audio_data IS NOT NULL',
        [req.params.id]
      );

      if (sizeResult.rows.length === 0) {
        return res.status(404).json({ error: 'Audio not found' });
      }

      const fileSize = sizeResult.rows[0].total_size;
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      // For open-ended ranges (bytes=0-), cap at 2MB chunks so initial playback
      // starts fast. The browser will automatically request more as needed.
      const maxChunk = 2 * 1024 * 1024; // 2MB
      const end = parts[1]
        ? Math.min(parseInt(parts[1], 10), fileSize - 1)
        : Math.min(start + maxChunk - 1, fileSize - 1);
      const chunkSize = end - start + 1;

      // Read only the needed bytes (PostgreSQL substring is 1-based)
      const chunkResult = await query(
        'SELECT substring(audio_data FROM $2 FOR $3) as chunk FROM content_items WHERE id = $1',
        [req.params.id, start + 1, chunkSize]
      );

      if (chunkResult.rows.length === 0 || !chunkResult.rows[0].chunk) {
        return res.status(404).json({ error: 'Audio not found' });
      }

      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunkSize,
        'Content-Type': 'audio/mpeg',
        'Cache-Control': 'public, max-age=31536000',
      });

      res.end(chunkResult.rows[0].chunk);
    } else {
      // NO RANGE REQUEST: Must send full file (rare - browsers usually use ranges)
      const result = await query(
        'SELECT audio_data FROM content_items WHERE id = $1',
        [req.params.id]
      );

      if (result.rows.length === 0 || !result.rows[0].audio_data) {
        return res.status(404).json({ error: 'Audio not found' });
      }

      const audioData = result.rows[0].audio_data;
      res.setHeader('Content-Type', 'audio/mpeg');
      res.setHeader('Content-Length', audioData.length);
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Cache-Control', 'public, max-age=31536000');

      res.send(audioData);
    }
  } catch (error) {
    console.error('Error serving audio:', error);
    res.status(500).json({ error: 'Failed to serve audio' });
  }
});

// Protected API routes (JWT auth + database required)
app.use('/api/users', requireDatabaseReady, usersRouter);
app.use('/api/content', requireDatabaseReady, requireAuth, contentRouter);
app.use('/api/podcasts', requireDatabaseReady, requireAuth, podcastRouter);
app.use('/api/queue', requireDatabaseReady, requireAuth, queueRouter);
app.use('/api/transcription', requireDatabaseReady, requireAuth, transcriptionRouter);
app.use('/api/wallabag', requireDatabaseReady, wallabagRouter);

// Initialize database and start server
async function start() {
  // Start HTTP server FIRST so Railway sees it as healthy
  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Wallacast API server running on http://0.0.0.0:${PORT}`);
  });

  // Graceful shutdown handler
  const shutdown = async (signal: string) => {
    console.log(`\n${signal} received, shutting down gracefully...`);

    // Close HTTP server (stop accepting new connections)
    server.close(async () => {
      console.log('HTTP server closed');

      // Close database pool
      try {
        await closePool();
      } catch (error) {
        console.error('Error closing database pool:', error);
      }

      console.log('Shutdown complete');
      process.exit(0);
    });

    // Force shutdown after 10 seconds
    setTimeout(() => {
      console.error('Forced shutdown after timeout');
      process.exit(1);
    }, 10000);
  };

  // Register shutdown handlers
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Then initialize database with retries and exponential backoff
  const maxRetries = 10;
  let retries = maxRetries;
  let delay = 2000; // Start with 2 seconds

  while (retries > 0) {
    try {
      await initializeDatabase();
      console.log('✅ Database connection established');

      // Bootstrap first user from AUTH_USERNAME/AUTH_PASSWORD env vars
      await bootstrapFirstUser();

      // Initialize storage directories
      await ensureStorageDirectories();
      break;
    } catch (error) {
      retries--;
      const attemptNum = maxRetries - retries;
      console.error(`Database connection failed (${attemptNum}/${maxRetries}), retrying in ${delay/1000}s...`, error);

      if (retries === 0) {
        console.error(`Failed to connect to database after ${maxRetries} attempts`);
        console.error('Server will continue running for health checks, but database operations will fail');
        // Don't exit - server stays running for health checks
      } else {
        await new Promise(resolve => setTimeout(resolve, delay));
        // Exponential backoff: increase delay for next retry (max 10s)
        delay = Math.min(delay * 1.5, 10000);
      }
    }
  }
}

start();
