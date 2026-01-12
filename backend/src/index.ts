import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import basicAuth from 'express-basic-auth';
import { initializeDatabase, closePool } from './database/db.js';
import { ensureStorageDirectories, getAudioDir } from './config/storage.js';
import contentRouter from './routes/content.js';
import podcastRouter from './routes/podcasts.js';
import queueRouter from './routes/queue.js';
import transcriptionRouter from './routes/transcription.js';

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

// HTTP Basic Auth middleware
const authMiddleware = basicAuth({
  users: {
    [process.env.AUTH_USERNAME || 'admin']: process.env.AUTH_PASSWORD || 'changeme'
  },
  challenge: true,
  realm: 'Readcast API',
});

// Serve static files (audio, images, etc.) from persistent storage
app.use('/audio', express.static(getAudioDir()));
app.use('/uploads', express.static(path.join(process.cwd(), 'public', 'uploads')));

// Public routes (no auth required)
app.get('/', (req, res) => {
  res.json({
    name: 'Readcast API',
    version: '1.0.0',
    status: 'ok'
  });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Protected API routes (auth required)
app.use('/api/content', authMiddleware, contentRouter);
app.use('/api/podcasts', authMiddleware, podcastRouter);
app.use('/api/queue', authMiddleware, queueRouter);
app.use('/api/transcription', authMiddleware, transcriptionRouter);

// Initialize database and start server
async function start() {
  // Start HTTP server FIRST so Railway sees it as healthy
  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Readcast API server running on http://0.0.0.0:${PORT}`);
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
