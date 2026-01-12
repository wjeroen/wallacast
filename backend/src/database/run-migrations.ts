import { query } from './db.js';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function runMigrations() {
  console.log('Running database migrations...');

  try {
    // Run add_comments_json migration
    const commentsJsonPath = path.join(__dirname, 'add_comments_json.sql');
    const commentsJsonSql = await fs.readFile(commentsJsonPath, 'utf-8');

    console.log('Running migration: add_comments_json.sql');
    await query(commentsJsonSql, []);
    console.log('✓ Migration add_comments_json.sql completed');

    console.log('All migrations completed successfully!');
  } catch (error) {
    console.error('Migration error:', error);
    // Don't throw - allow app to start even if migrations fail
    console.warn('Warning: Some migrations may have failed. App will continue but may have issues.');
  }
}

export { runMigrations };
