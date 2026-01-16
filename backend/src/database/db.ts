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
    };
  }

  // Otherwise use individual variables (Railway also provides these)
  const config = {
    host: process.env.PGHOST || process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.PGPORT || process.env.DB_PORT || '5432'),
    database: process.env.PGDATABASE || process.env.DB_NAME || 'readcast',
    user: process.env.PGUSER || process.env.DB_USER || 'postgres',
    password: process.env.PGPASSWORD || process.env.DB_PASSWORD || 'postgres',
  };
  console.log('Using individual variables, connecting to:', config.host + ':' + config.port);
  return config;
};

// Create pool lazily to avoid connection attempts at module load time
let pool: pg.Pool | null = null;

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

    // Run migration to add performance indexes
    const indexesMigrationPath = path.join(__dirname, 'migrations', '002_add_performance_indexes.sql');
    const indexesMigration = await fs.readFile(indexesMigrationPath, 'utf-8');
    await poolInstance.query(indexesMigration);

    // Run migration to remove unused is_read column
    const removeIsReadMigrationPath = path.join(__dirname, 'migrations', '003_remove_is_read_column.sql');
    const removeIsReadMigration = await fs.readFile(removeIsReadMigrationPath, 'utf-8');
    await poolInstance.query(removeIsReadMigration);

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

    console.log('Database initialized successfully');
  } catch (error) {
    console.error('Error initializing database:', error);
    throw error;
  }
}

export async function query(text: string, params?: any[]) {
  const start = Date.now();
  const poolInstance = getPool();
  const res = await poolInstance.query(text, params);
  const duration = Date.now() - start;
  console.log('Executed query', { text, duration, rows: res.rowCount });
  return res;
}
