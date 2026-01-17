import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { initializeDatabase, closePool } from './database/db.js';
import { ensureStorageDirectories, getAudioDir } from './config/storage.js';
import contentRouter from './routes/content.js';
import podcastRouter from './routes/podcasts.js';
import queueRouter from './routes/queue.js';
import transcriptionRouter from './routes/transcription.js';
import authRouter from './routes/auth.js';
import usersRouter from './routes/users.js';
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

// Protected API routes (JWT auth + database required)
app.use('/api/users', requireDatabaseReady, usersRouter);
app.use('/api/content', requireDatabaseReady, requireAuth, contentRouter);
app.use('/api/podcasts', requireDatabaseReady, requireAuth, podcastRouter);
app.use('/api/queue', requireDatabaseReady, requireAuth, queueRouter);
app.use('/api/transcription', requireDatabaseReady, requireAuth, transcriptionRouter);

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
