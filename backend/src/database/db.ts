import pg from 'pg';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const { Pool } = pg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Railway provides DATABASE_URL or individual PG* variables
// Support both Railway's standard variables and custom DB_* variables
const getDatabaseConfig = () => {
  // DEBUG: Log what environment variables we actually have
  console.log('=== DATABASE CONNECTION DEBUG ===');
  console.log('DATABASE_URL exists:', !!process.env.DATABASE_URL);
  console.log('PGHOST:', process.env.PGHOST || 'NOT SET');
  console.log('PGPORT:', process.env.PGPORT || 'NOT SET');
  console.log('PGDATABASE:', process.env.PGDATABASE || 'NOT SET');
  console.log('DB_HOST:', process.env.DB_HOST || 'NOT SET');
  console.log('================================');

  // If DATABASE_URL is provided (Railway default), use it
  if (process.env.DATABASE_URL) {
    console.log('Using DATABASE_URL connection string');
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
  try {
    const poolInstance = getPool();

    // Run main schema
    const schemaPath = path.join(__dirname, 'schema.sql');
    const schema = await fs.readFile(schemaPath, 'utf-8');
    await poolInstance.query(schema);

    // Run migration for word timestamps
    const migrationPath = path.join(__dirname, 'add_word_timestamps.sql');
    const migration = await fs.readFile(migrationPath, 'utf-8');
    await poolInstance.query(migration);

    // Run migration for generation status tracking
    const statusMigrationPath = path.join(__dirname, 'add_generation_status.sql');
    const statusMigration = await fs.readFile(statusMigrationPath, 'utf-8');
    await poolInstance.query(statusMigration);

    // Run migration for article metadata (karma, votes)
    const articleMetadataMigrationPath = path.join(__dirname, 'add_article_metadata.sql');
    const articleMetadataMigration = await fs.readFile(articleMetadataMigrationPath, 'utf-8');
    await poolInstance.query(articleMetadataMigration);

    // Run migration for comments field
    const commentsFieldMigrationPath = path.join(__dirname, 'add_comments_field.sql');
    const commentsFieldMigration = await fs.readFile(commentsFieldMigrationPath, 'utf-8');
    await poolInstance.query(commentsFieldMigration);

    // Run migration to add audio_data column for storing audio in database
    const audioDataMigrationPath = path.join(__dirname, 'migrations', '001_add_audio_data_column.sql');
    const audioDataMigration = await fs.readFile(audioDataMigrationPath, 'utf-8');
    await poolInstance.query(audioDataMigration);

    // Run migration for Wallabag compatibility (renames + new fields)
    // IMPORTANT: Must run BEFORE 002_add_performance_indexes because 002 creates indexes on renamed columns
    const wallabagMigrationPath = path.join(__dirname, 'migrations', '004_wallabag_compatibility.sql');
    const wallabagMigration = await fs.readFile(wallabagMigrationPath, 'utf-8');
    await poolInstance.query(wallabagMigration);

    // Run migration to add performance indexes (uses renamed columns from 004)
    const indexesMigrationPath = path.join(__dirname, 'migrations', '002_add_performance_indexes.sql');
    const indexesMigration = await fs.readFile(indexesMigrationPath, 'utf-8');
    await poolInstance.query(indexesMigration);

    // Run migration to remove unused is_read column
    const removeIsReadMigrationPath = path.join(__dirname, 'migrations', '003_remove_is_read_column.sql');
    const removeIsReadMigration = await fs.readFile(removeIsReadMigrationPath, 'utf-8');
    await poolInstance.query(removeIsReadMigration);

    // Run migration to add users and user settings
    const usersMigrationPath = path.join(__dirname, 'migrations', '005_add_users.sql');
    const usersMigration = await fs.readFile(usersMigrationPath, 'utf-8');
    await poolInstance.query(usersMigration);

    // Reset any stuck generation statuses (server restart during generation)
    const resetResult = await poolInstance.query(`
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

    // Mark database as ready for queries
    databaseReady = true;
    console.log('Database initialized successfully');
  } catch (error) {
    console.error('Error initializing database:', error);
    throw error;
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
      console.log('Executed query', { text, duration, rows: res.rowCount });
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
