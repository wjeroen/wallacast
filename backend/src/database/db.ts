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

export const pool = new Pool(getDatabaseConfig());

export async function initializeDatabase() {
  try {
    const schemaPath = path.join(__dirname, 'schema.sql');
    const schema = await fs.readFile(schemaPath, 'utf-8');
    await pool.query(schema);
    console.log('Database initialized successfully');
  } catch (error) {
    console.error('Error initializing database:', error);
    throw error;
  }
}

export async function query(text: string, params?: any[]) {
  const start = Date.now();
  const res = await pool.query(text, params);
  const duration = Date.now() - start;
  console.log('Executed query', { text, duration, rows: res.rowCount });
  return res;
}
