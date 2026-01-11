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
  try {
    await initializeDatabase();
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`🚀 Readcast API server running on http://0.0.0.0:${PORT}`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

start();
