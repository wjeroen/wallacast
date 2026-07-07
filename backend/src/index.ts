import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { safeFetch } from './services/url-guard.js';
import { verifyAudioToken } from './services/audio-token.js';
import { initializeDatabase, closePool } from './database/db.js';
import { ensureStorageDirectories, isPersistentVolume } from './config/storage.js';
import { getAudioFileSize, createAudioReadStream, migrateAudioBlobsToDisk, clearMigratedAudioBlobs } from './services/audio-storage.js';
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

// Trust Railway's reverse proxy so req.ip is the real client IP (from X-Forwarded-For),
// not the proxy's own address. Without this the auth rate limiters would bucket every
// visitor together. '1' = trust exactly one proxy hop (Railway's edge), which also stops
// clients spoofing X-Forwarded-For to dodge the limiter.
app.set('trust proxy', 1);

// The /api/auth endpoints only ever receive tiny JSON (credentials), so cap their body
// size far below the global 50mb the content routes need for large paste-ins. This runs
// BEFORE the global parser, and express.json marks the body as parsed, so the 50mb parser
// then skips these routes. Keeps a 50mb pre-auth memory-exhaustion lever off the table.
app.use('/api/auth', express.json({ limit: '100kb' }));
app.use(express.json({ limit: '50mb' }));

// The old `app.use('/audio', express.static(getAudioDir()))` static mount was removed for
// security: it exposed generated audio as /audio/<id>.mp3 over sequential, guessable ids with
// no auth. Audio is served only through the streaming route GET /api/content/:id/audio below
// (which reads the same files from disk), so the static mount was pure extra attack surface.

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

// Parse a single HTTP Range header against a known total size.
// Supports "bytes=START-", "bytes=START-END", and the suffix form "bytes=-N" (last N bytes).
// Open-ended ranges are capped to maxChunk bytes so playback starts fast (the browser then
// asks for more). Returns null when the header is malformed or the range cannot be satisfied,
// so the caller can answer 416 with "Content-Range: bytes */<size>" instead of emitting a NaN
// Content-Length.
function parseAudioRange(
  rangeHeader: string,
  totalSize: number,
  maxChunk: number
): { start: number; end: number } | null {
  const m = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
  if (!m) return null;
  const startStr = m[1];
  const endStr = m[2];
  if (startStr === '' && endStr === '') return null; // "bytes=-" is meaningless

  let start: number;
  let end: number;
  if (startStr === '') {
    // Suffix form: the last N bytes of the file.
    const suffixLen = parseInt(endStr, 10);
    if (!Number.isFinite(suffixLen) || suffixLen <= 0) return null;
    start = Math.max(0, totalSize - suffixLen);
    end = totalSize - 1;
  } else {
    start = parseInt(startStr, 10);
    if (!Number.isFinite(start) || start >= totalSize) return null; // unsatisfiable
    if (endStr === '') {
      // Open-ended (bytes=START-): cap the span for a fast start.
      end = Math.min(start + maxChunk - 1, totalSize - 1);
    } else {
      const reqEnd = parseInt(endStr, 10);
      if (!Number.isFinite(reqEnd)) return null;
      end = Math.min(reqEnd, totalSize - 1);
    }
  }
  if (end < start) return null;
  return { start, end };
}

// Public audio endpoint (no auth - HTML5 audio player can't send JWT tokens)
// Must be registered before protected /api/content routes to match first
app.get('/api/content/:id/audio', requireDatabaseReady, async (req, res) => {
  try {
    const range = req.headers.range;

    // Step 0: Cheap metadata check, type + audio_url only, no blob access.
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

    // Private generated audio (article/text narration of the user's saved/pasted text) must not
    // be enumerable by sequential id. Require the unguessable per-item token (see audio-token.ts).
    // Podcast episodes proxy already-public CDN audio, so they stay open.
    if (type === 'article' || type === 'text') {
      const t = typeof req.query.t === 'string' ? req.query.t : '';
      if (!verifyAudioToken(Number(req.params.id), t)) {
        return res.status(403).json({ error: 'Missing or invalid audio token' });
      }
    }

    // -------------------------------------------------------------------------
    // PATH A: podcast episode. Proxy external CDN URL through our server.
    // This sidesteps CORS issues (e.g. api.substack.com blocks cross-origin
    // range requests from the browser). We forward the Range header so only
    // the requested bytes are fetched upstream, never the full file.
    // -------------------------------------------------------------------------
    if (type === 'podcast_episode' && audioUrl) {
      const upstreamHeaders: Record<string, string> = {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      };
      if (range) {
        upstreamHeaders['Range'] = range;
      }

      console.log(`[AudioProxy] ${range || 'no-range'} → ${audioUrl.substring(0, 100)}`);

      const upstreamRes = await safeFetch(audioUrl, { headers: upstreamHeaders });

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

      // node-fetch body is a Node.js ReadableStream, pipe it directly to the
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
    // PATH B (preferred): article/text audio stored as a file on the volume.
    // Generated audio now lives on disk (cheap) instead of a Postgres blob
    // (expensive RAM). Falls through to the DB-blob path below for items that
    // haven't been migrated yet, so playback keeps working during the rollout.
    // -------------------------------------------------------------------------
    const diskSize = await getAudioFileSize(req.params.id);
    if (diskSize !== null) {
      const onStreamError = (err: Error) => {
        console.error('[Audio] Disk stream error:', err.message);
        if (!res.writableEnded) res.end();
      };
      if (range) {
        const maxChunk = 2 * 1024 * 1024; // 2MB, same as the DB path, for fast start
        const parsed = parseAudioRange(range, diskSize, maxChunk);
        if (!parsed) {
          res.setHeader('Content-Range', `bytes */${diskSize}`);
          return res.status(416).end();
        }
        const { start, end } = parsed;
        res.writeHead(206, {
          'Content-Range': `bytes ${start}-${end}/${diskSize}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': end - start + 1,
          'Content-Type': 'audio/mpeg',
          'Cache-Control': 'public, max-age=31536000',
        });
        createAudioReadStream(req.params.id, start, end).on('error', onStreamError).pipe(res);
      } else {
        res.writeHead(200, {
          'Content-Length': diskSize,
          'Accept-Ranges': 'bytes',
          'Content-Type': 'audio/mpeg',
          'Cache-Control': 'public, max-age=31536000',
        });
        createAudioReadStream(req.params.id).on('error', onStreamError).pipe(res);
      }
      return;
    }

    // -------------------------------------------------------------------------
    // PATH C (fallback): article/text. Serve audio_data from the database.
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

      const fileSize = Number(sizeResult.rows[0].total_size);
      // For open-ended ranges (bytes=0-), cap at 2MB chunks so initial playback
      // starts fast. The browser will automatically request more as needed.
      const maxChunk = 2 * 1024 * 1024; // 2MB
      const parsed = parseAudioRange(range, fileSize, maxChunk);
      if (!parsed) {
        res.setHeader('Content-Range', `bytes */${fileSize}`);
        return res.status(416).end();
      }
      const { start, end } = parsed;
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

// Log how much disk the database is using (audio blobs, transcripts, etc.) to the
// Railway logs on every startup, so storage growth is visible without DB tooling.
// Used for sizing the planned audio-to-volume migration (TODO.md, Performance section).
// Fire-and-forget: must NEVER block or crash startup (table may not exist on a fresh DB).
// pg_column_size() reads stored (TOASTed) sizes without loading the blobs into RAM.
async function logStorageStats() {
  try {
    const items = await query(`
      SELECT
        COUNT(*)::int AS total_items,
        COUNT(*) FILTER (WHERE audio_data IS NOT NULL)::int AS audio_items,
        COALESCE(SUM(COALESCE(file_size, pg_column_size(audio_data))) FILTER (WHERE audio_data IS NOT NULL), 0)::bigint AS audio_bytes,
        COALESCE(SUM(pg_column_size(transcript)), 0)::bigint AS transcript_bytes,
        COALESCE(SUM(pg_column_size(transcript_words)), 0)::bigint AS transcript_words_bytes,
        COALESCE(SUM(pg_column_size(html_content)), 0)::bigint AS html_bytes,
        COALESCE(SUM(pg_column_size(comments)), 0)::bigint AS comments_bytes
      FROM content_items
    `);
    const sizes = await query(
      `SELECT pg_total_relation_size('content_items')::bigint AS table_bytes,
              pg_database_size(current_database())::bigint AS db_bytes`
    );
    const mb = (b: any) => (Number(b) / 1024 / 1024).toFixed(1) + ' MB';
    const s = items.rows[0];
    const t = sizes.rows[0];
    console.log('📦 [Storage] ===== Database storage breakdown =====');
    console.log(`📦 [Storage] Audio blobs (audio_data):   ${mb(s.audio_bytes)} across ${s.audio_items} of ${s.total_items} items  <-- what the volume migration would move`);
    console.log(`📦 [Storage] Transcripts (text):         ${mb(s.transcript_bytes)}`);
    console.log(`📦 [Storage] Word timestamps (JSONB):    ${mb(s.transcript_words_bytes)}`);
    console.log(`📦 [Storage] Article HTML:               ${mb(s.html_bytes)}`);
    console.log(`📦 [Storage] Comments (JSONB):           ${mb(s.comments_bytes)}`);
    console.log(`📦 [Storage] content_items table total:  ${mb(t.table_bytes)} (incl. indexes/overhead)`);
    console.log(`📦 [Storage] Whole database on disk:     ${mb(t.db_bytes)}`);

    // Postgres memory settings so you can SEE whether POSTGRES_CONFIG (or any tuning)
    // actually took effect. If shared_buffers is small (e.g. 64-128MB) the low preset is
    // live; if it's the stock default the variable isn't being read by your DB image.
    const cfg = await query(
      `SELECT name, setting, unit FROM pg_settings
        WHERE name IN ('shared_buffers','effective_cache_size','work_mem','maintenance_work_mem','max_connections')
        ORDER BY name`
    );
    const fmt = cfg.rows.map((r: any) => `${r.name}=${r.setting}${r.unit ? r.unit : ''}`).join('  ');
    console.log(`🧠 [Postgres] ${fmt}`);
  } catch (error: any) {
    // Never let stats logging affect startup (e.g. fresh DB without tables yet)
    console.log('📦 [Storage] Stats unavailable:', error?.message || error);
  }
}

// Warn loudly at startup about missing security-critical env vars. We do NOT crash (the server
// must stay up for health checks, per the db.ts philosophy), but silence was the real risk:
// without ENCRYPTION_KEY every user's provider API key is stored as PLAINTEXT, and without
// JWT_SECRET all sessions drop on each restart. Production only, so local dev stays quiet.
function warnMissingSecurityEnv() {
  if (process.env.NODE_ENV !== 'production') return;
  const key = process.env.ENCRYPTION_KEY;
  if (!key || key.length !== 64) {
    console.error('🔓 [SECURITY] ENCRYPTION_KEY is missing or not 64 hex chars: user API keys and Wallabag passwords are being stored as PLAINTEXT. Set a 64-hex-char ENCRYPTION_KEY (see RAILWAY_DEPLOYMENT.md).');
  }
  if (!process.env.JWT_SECRET) {
    console.error('🔑 [SECURITY] JWT_SECRET is missing: a random secret is generated each boot, so everyone is logged out on every redeploy. Set a stable JWT_SECRET (see RAILWAY_DEPLOYMENT.md).');
  }
}

// Initialize database and start server
async function start() {
  warnMissingSecurityEnv();

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

      // Assign any orphaned pre-multi-user content to the first registered user
      await bootstrapFirstUser();

      // Initialize storage directories
      await ensureStorageDirectories();

      // Log storage breakdown to Railway logs (fire-and-forget, never blocks startup)
      logStorageStats().catch(() => {});

      // Migrate audio blobs out of Postgres onto the volume (fire-and-forget, never blocks
      // startup). COPY is non-destructive and idempotent, safe to run every boot. The
      // destructive CLEAR (NULL the blobs to actually free the DB) only runs when you set
      // CLEAR_AUDIO_BLOBS=true, and only for items already verified on disk.
      (async () => {
        try {
          if (isPersistentVolume()) {
            console.log('🎵 [AudioMigration] ✅ Persistent volume detected at /data. Audio files survive redeploys.');
          } else {
            console.warn('🎵 [AudioMigration] ⚠️ NO VOLUME AT /data. Audio files are being written to the container\'s EPHEMERAL disk and will NOT survive a redeploy. Check the volume\'s mount path in Railway (must be exactly /data). DB blobs are kept, so nothing is lost, but the migration is not effective until the volume is mounted.');
          }
          const copy = await migrateAudioBlobsToDisk();
          if (copy.migrated > 0 || copy.failed > 0) {
            console.log(`🎵 [AudioMigration] Copied ${copy.migrated} audio file(s) to disk (${copy.mb} MB), skipped ${copy.skipped}, failed ${copy.failed}.`);
          } else {
            console.log(`🎵 [AudioMigration] Nothing to copy (${copy.skipped} already on disk or no blobs).`);
          }
          if (process.env.CLEAR_AUDIO_BLOBS === 'true') {
            // clearMigratedAudioBlobs throws if storage isn't the persistent volume,
            // so this can never destroy audio that only exists on ephemeral disk.
            const cleared = await clearMigratedAudioBlobs();
            console.log(`🧹 [AudioMigration] Cleared ${cleared.cleared} DB blob(s) now safely on disk; kept ${cleared.kept} (no disk file). You can now run VACUUM FULL to reclaim disk.`);
          }
        } catch (err: any) {
          console.error('🎵 [AudioMigration] Stopped:', err?.message || err);
        }
      })();
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
