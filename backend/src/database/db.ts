import pg from 'pg';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { encrypt, isEncrypted } from '../services/encryption.js';

const { Pool } = pg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Railway provides DATABASE_URL or individual PG* variables
// Support both Railway's standard variables and custom DB_* variables
const getDatabaseConfig = () => {
  // If DATABASE_URL is provided (Railway default), use it
  if (process.env.DATABASE_URL) {
    return {
      connectionString: process.env.DATABASE_URL,
      connectionTimeoutMillis: 10000, // 10 seconds to establish connection
      idleTimeoutMillis: 30000, // 30 seconds before idle connection is closed
      max: 20, // maximum pool size
      keepAlive: true,
      keepAliveInitialDelayMillis: 10000,
    };
  }

  // Otherwise use individual variables (Railway also provides these)
  const config = {
    host: process.env.PGHOST || process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.PGPORT || process.env.DB_PORT || '5432'),
    database: process.env.PGDATABASE || process.env.DB_NAME || 'wallacast',
    user: process.env.PGUSER || process.env.DB_USER || 'postgres',
    password: process.env.PGPASSWORD || process.env.DB_PASSWORD || 'postgres',
  };
  console.log('Using individual variables, connecting to:', config.host + ':' + config.port);
  return config;
};

// Create pool lazily to avoid connection attempts at module load time
let pool: pg.Pool | null = null;

// Database readiness flag - set to true after successful initialization
let databaseReady = false;

export function isDatabaseReady(): boolean {
  return databaseReady;
}

export function getPool(): pg.Pool {
  if (!pool) {
    pool = new Pool(getDatabaseConfig());
  }
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    console.log('Closing database connection pool...');
    await pool.end();
    pool = null;
    console.log('Database connection pool closed');
  }
}

export async function initializeDatabase() {
  const poolInstance = getPool();
  // Use a dedicated client so we can set lock_timeout and statement_timeout
  // that only apply to initialization, not to normal queries.
  // This prevents migrations from hanging forever on locked tables
  // (e.g., after a crash leaves dead transactions holding locks).
  console.log('Connecting to database...');
  const client = await poolInstance.connect();
  console.log('Database connection acquired');

  try {
    // Set timeouts: if a migration can't acquire a lock within 5s, fail fast
    // so the retry loop in index.ts can try again instead of hanging forever
    await client.query('SET lock_timeout = \'5s\'');
    await client.query('SET statement_timeout = \'30s\'');

    // Try to terminate stuck sessions from previous crashed processes
    // that might be holding locks on content_items. pg_terminate_backend
    // kills the entire session (releases locks), not just the current query.
    try {
      const stuckResult = await client.query(`
        SELECT pg_terminate_backend(pid)
        FROM pg_stat_activity
        WHERE pid != pg_backend_pid()
        AND state != 'idle'
        AND query LIKE '%content_items%'
        AND backend_start < NOW() - INTERVAL '30 seconds'
      `);
      if (stuckResult.rowCount && stuckResult.rowCount > 0) {
        console.log(`Terminated ${stuckResult.rowCount} stuck session(s) from previous crashes`);
        // Brief pause to let PostgreSQL clean up the terminated sessions
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    } catch (e) {
      // Ignore - might not have permission, lock_timeout will handle it
    }

    console.log('Running database migrations...');

    // Run main schema
    const schemaPath = path.join(__dirname, 'schema.sql');
    const schema = await fs.readFile(schemaPath, 'utf-8');
    await client.query(schema);

    // Run migration for word timestamps
    const migrationPath = path.join(__dirname, 'add_word_timestamps.sql');
    const migration = await fs.readFile(migrationPath, 'utf-8');
    await client.query(migration);

    // Run migration for generation status tracking
    const statusMigrationPath = path.join(__dirname, 'add_generation_status.sql');
    const statusMigration = await fs.readFile(statusMigrationPath, 'utf-8');
    await client.query(statusMigration);

    // Run migration for article metadata (karma, votes)
    const articleMetadataMigrationPath = path.join(__dirname, 'add_article_metadata.sql');
    const articleMetadataMigration = await fs.readFile(articleMetadataMigrationPath, 'utf-8');
    await client.query(articleMetadataMigration);

    // Run migration for comments field
    const commentsFieldMigrationPath = path.join(__dirname, 'add_comments_field.sql');
    const commentsFieldMigration = await fs.readFile(commentsFieldMigrationPath, 'utf-8');
    await client.query(commentsFieldMigration);

    // Run migration to add audio_data column for storing audio in database
    const audioDataMigrationPath = path.join(__dirname, 'migrations', '001_add_audio_data_column.sql');
    const audioDataMigration = await fs.readFile(audioDataMigrationPath, 'utf-8');
    await client.query(audioDataMigration);

    // Run migration for Wallabag compatibility (renames + new fields)
    // IMPORTANT: Must run BEFORE 002_add_performance_indexes because 002 creates indexes on renamed columns
    const wallabagMigrationPath = path.join(__dirname, 'migrations', '004_wallabag_compatibility.sql');
    const wallabagMigration = await fs.readFile(wallabagMigrationPath, 'utf-8');
    await client.query(wallabagMigration);

    // Run migration to add performance indexes (uses renamed columns from 004)
    const indexesMigrationPath = path.join(__dirname, 'migrations', '002_add_performance_indexes.sql');
    const indexesMigration = await fs.readFile(indexesMigrationPath, 'utf-8');
    await client.query(indexesMigration);

    // Run migration to remove unused is_read column
    const removeIsReadMigrationPath = path.join(__dirname, 'migrations', '003_remove_is_read_column.sql');
    const removeIsReadMigration = await fs.readFile(removeIsReadMigrationPath, 'utf-8');
    await client.query(removeIsReadMigration);

    // Run migration to add users and user settings
    const usersMigrationPath = path.join(__dirname, 'migrations', '005_add_users.sql');
    const usersMigration = await fs.readFile(usersMigrationPath, 'utf-8');
    await client.query(usersMigration);

    // Run migration to add content_source field for provenance tracking
    const contentSourceMigrationPath = path.join(__dirname, 'migrations', '006_add_content_source.sql');
    const contentSourceMigration = await fs.readFile(contentSourceMigrationPath, 'utf-8');
    await client.query(contentSourceMigration);

    // Run migration to fix podcast multi-user subscriptions
    const podcastMultiUserMigrationPath = path.join(__dirname, 'migrations', '007_fix_podcast_multi_user.sql');
    const podcastMultiUserMigration = await fs.readFile(podcastMultiUserMigrationPath, 'utf-8');
    await client.query(podcastMultiUserMigration);

    // Run migration to optimize playback position updates
    const playbackOptimizationMigrationPath = path.join(__dirname, 'migrations', '008_optimize_playback_updates.sql');
    const playbackOptimizationMigration = await fs.readFile(playbackOptimizationMigrationPath, 'utf-8');
    await client.query(playbackOptimizationMigration);

    // Run migration to expand podcast language column
    const expandLanguageMigrationPath = path.join(__dirname, 'migrations', '009_expand_podcast_language_column.sql');
    const expandLanguageMigration = await fs.readFile(expandLanguageMigrationPath, 'utf-8');
    await client.query(expandLanguageMigration);

    // Fix content_source default: should be 'wallacast' not 'wallabag'
    const fixContentSourceDefaultPath = path.join(__dirname, 'migrations', '010_fix_content_source_default.sql');
    const fixContentSourceDefault = await fs.readFile(fixContentSourceDefaultPath, 'utf-8');
    await client.query(fixContentSourceDefault);

    // Run migration to add podcast_show_name column
    const podcastShowNameMigrationPath = path.join(__dirname, 'migrations', '010_add_podcast_show_name.sql');
    const podcastShowNameMigration = await fs.readFile(podcastShowNameMigrationPath, 'utf-8');
    await poolInstance.query(podcastShowNameMigration);

    // Run migration to add feed type column to podcasts table
    const feedTypeMigrationPath = path.join(__dirname, 'migrations', '012_add_feed_type.sql');
    const feedTypeMigration = await fs.readFile(feedTypeMigrationPath, 'utf-8');
    await client.query(feedTypeMigration);

    // Run migration to add feed_items cache table for RSS feeds
    const feedItemsCacheMigrationPath = path.join(__dirname, 'migrations', '013_add_feed_items_cache.sql');
    const feedItemsCacheMigration = await fs.readFile(feedItemsCacheMigrationPath, 'utf-8');
    await client.query(feedItemsCacheMigration);

    // Run migration to add image alt-text columns for Gemini descriptions
    const imageAltTextMigrationPath = path.join(__dirname, 'migrations', '014_add_image_alt_text.sql');
    const imageAltTextMigration = await fs.readFile(imageAltTextMigrationPath, 'utf-8');
    await client.query(imageAltTextMigration);

    // Run migration to add content_alignment column
    const contentAlignmentMigrationPath = path.join(__dirname, 'migrations', '015_add_content_alignment.sql');
    const contentAlignmentMigration = await fs.readFile(contentAlignmentMigrationPath, 'utf-8');
    await client.query(contentAlignmentMigration);

    // Run migration to add content_fetched_at and audio_generated_at timestamps
    const contentTimestampsMigrationPath = path.join(__dirname, 'migrations', '016_add_content_timestamps.sql');
    const contentTimestampsMigration = await fs.readFile(contentTimestampsMigrationPath, 'utf-8');
    await client.query(contentTimestampsMigration);

    // Reset any stuck generation statuses (server restart during generation)
    const resetResult = await client.query(`
      UPDATE content_items
      SET generation_status = 'failed',
          generation_error = 'Server restarted during generation',
          generation_progress = 0,
          current_operation = NULL
      WHERE generation_status NOT IN ('idle', 'completed', 'failed')
    `);

    if (resetResult.rowCount && resetResult.rowCount > 0) {
      console.log(`Reset ${resetResult.rowCount} stuck generation task(s) to failed status`);
    }

    // Update table statistics so PostgreSQL's query planner picks optimal plans.
    // After crashes or heavy writes, statistics can become stale, causing the
    // planner to choose slow sequential scans instead of fast index lookups.
    // ANALYZE is fast (reads a sample, not the whole table) and safe to run.
    // Wrapped in try/catch: missing tables should NOT crash initialization.
    const tablesToAnalyze = ['content_items', 'users', 'user_sessions', 'user_settings', 'podcasts', 'feed_items'];
    for (const table of tablesToAnalyze) {
      try {
        await client.query(`ANALYZE ${table}`);
      } catch (e) {
        // Table might not exist yet — that's fine, skip it
      }
    }

    // Encrypt any existing plaintext secret values (one-time migration)
    // Only runs if ENCRYPTION_KEY is set. Safe to run every startup — already-encrypted
    // values are detected by the 'enc:' prefix and skipped.
    if (process.env.ENCRYPTION_KEY) {
      try {
        const secretRows = await client.query(
          `SELECT user_id, setting_key, setting_value FROM user_settings WHERE is_secret = true AND setting_value IS NOT NULL`
        );
        let encryptedCount = 0;
        for (const row of secretRows.rows) {
          if (!isEncrypted(row.setting_value)) {
            const encryptedValue = encrypt(row.setting_value);
            await client.query(
              `UPDATE user_settings SET setting_value = $1 WHERE user_id = $2 AND setting_key = $3`,
              [encryptedValue, row.user_id, row.setting_key]
            );
            encryptedCount++;
          }
        }
        if (encryptedCount > 0) {
          console.log(`✓ Encrypted ${encryptedCount} existing plaintext secret value(s)`);
        }
      } catch (e) {
        // Don't crash startup if this fails — user_settings table might not exist yet
        console.warn('Could not run secret encryption migration:', e);
      }
    }

    // Mark database as ready for queries
    databaseReady = true;
    console.log('Database initialized successfully');
  } catch (error) {
    console.error('Error initializing database:', error);
    throw error;
  } finally {
    client.release();
  }
}

export async function query(text: string, params?: any[]) {
  const start = Date.now();
  const poolInstance = getPool();

  // Retry logic for transient connection errors
  let lastError: Error | null = null;
  const maxRetries = 3;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const res = await poolInstance.query(text, params);
      const duration = Date.now() - start;

      // Log query summary (only show full query text for slow queries > 300ms)
      // Note: 100-200ms is normal latency for Railway's separate database service
      // (network hop between app container and PostgreSQL container). Flag queries
      // above 300ms since multiple 400ms+ queries in a row would be concerning.
      const queryType = text.trim().split(/\s+/)[0].toUpperCase();
      const tableMatch = text.match(/(?:FROM|INTO|UPDATE)\s+(\w+)/i);
      const table = tableMatch ? tableMatch[1] : '?';

      if (duration > 300) {
        console.log(`Slow query (${duration}ms): ${queryType} ${table}`, { text: text.substring(0, 100) + '...', rows: res.rowCount });
      } else if (queryType !== 'SELECT') {
        // Log non-SELECT queries (INSERT, UPDATE, DELETE are important)
        console.log(`${queryType} ${table}`, { duration, rows: res.rowCount });
      }
      // Skip logging fast SELECT queries to reduce noise

      return res;
    } catch (error: any) {
      lastError = error;

      // Only retry on connection errors, not on SQL errors
      const isConnectionError =
        error.code === 'ETIMEDOUT' ||
        error.code === 'ECONNREFUSED' ||
        error.code === 'ECONNRESET' ||
        error.message?.includes('Connection terminated') ||
        error.message?.includes('Connection timeout');

      if (!isConnectionError || attempt === maxRetries) {
        throw error;
      }

      // Wait before retrying (exponential backoff)
      const delayMs = Math.min(1000 * Math.pow(2, attempt - 1), 5000);
      console.log(`Query failed (attempt ${attempt}/${maxRetries}), retrying in ${delayMs}ms...`);
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }

  throw lastError;
}
