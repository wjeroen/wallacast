import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { initializeDatabase } from './database/db.js';
import contentRouter from './routes/content.js';
import podcastRouter from './routes/podcasts.js';
import queueRouter from './routes/queue.js';
import settingsRouter from './routes/settings.js';
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

// Serve static files (audio, images, etc.)
app.use('/audio', express.static(path.join(process.cwd(), 'public', 'audio')));
app.use('/uploads', express.static(path.join(process.cwd(), 'public', 'uploads')));

// Routes
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

app.use('/api/content', contentRouter);
app.use('/api/podcasts', podcastRouter);
app.use('/api/queue', queueRouter);
app.use('/api/settings', settingsRouter);
app.use('/api/transcription', transcriptionRouter);

// Initialize database and start server
async function start() {
  // Start HTTP server FIRST so Railway sees it as healthy
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Readcast API server running on http://0.0.0.0:${PORT}`);
  });

  // Then initialize database with retries
  let retries = 5;
  while (retries > 0) {
    try {
      await initializeDatabase();
      console.log('✅ Database connection established');
      break;
    } catch (error) {
      retries--;
      console.error(`Database connection failed (${5 - retries}/5), retrying in 2s...`, error);
      if (retries === 0) {
        console.error('Failed to connect to database after 5 attempts');
        // Don't exit - server stays running for health checks
      } else {
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }
  }
}

start();
