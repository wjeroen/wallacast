-- Migration: Add users and user settings tables
-- With authentication support (password hashes)

-- Users table with auth support
CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    username VARCHAR(100) NOT NULL UNIQUE,
    email VARCHAR(255) UNIQUE,
    password_hash VARCHAR(255),  -- bcrypt hash, NULL for legacy/OAuth users
    display_name VARCHAR(255),
    is_active BOOLEAN DEFAULT TRUE,
    last_login_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- User settings table (per-user API keys and preferences)
CREATE TABLE IF NOT EXISTS user_settings (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    setting_key VARCHAR(100) NOT NULL,
    setting_value TEXT,
    is_secret BOOLEAN DEFAULT FALSE,  -- For API keys, encrypted values
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, setting_key)
);

-- Sessions table for JWT refresh tokens
CREATE TABLE IF NOT EXISTS user_sessions (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    refresh_token_hash VARCHAR(255) NOT NULL,  -- hashed refresh token
    expires_at TIMESTAMP NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    revoked_at TIMESTAMP  -- NULL if active, timestamp if revoked
);

-- Add user_id to content_items (default to user 1 for existing content)
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'content_items' AND column_name = 'user_id') THEN
        ALTER TABLE content_items ADD COLUMN user_id INTEGER REFERENCES users(id) ON DELETE CASCADE;
    END IF;
END $$;

-- Add user_id to podcasts table
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'podcasts' AND column_name = 'user_id') THEN
        ALTER TABLE podcasts ADD COLUMN user_id INTEGER REFERENCES users(id) ON DELETE CASCADE;
    END IF;
END $$;

-- Add user_id to queue_items table
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'queue_items' AND column_name = 'user_id') THEN
        ALTER TABLE queue_items ADD COLUMN user_id INTEGER REFERENCES users(id) ON DELETE CASCADE;
    END IF;
END $$;

-- Add columns to existing users table if they don't exist (for upgrades)
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'email') THEN
        ALTER TABLE users ADD COLUMN email VARCHAR(255) UNIQUE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'password_hash') THEN
        ALTER TABLE users ADD COLUMN password_hash VARCHAR(255);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'is_active') THEN
        ALTER TABLE users ADD COLUMN is_active BOOLEAN DEFAULT TRUE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'last_login_at') THEN
        ALTER TABLE users ADD COLUMN last_login_at TIMESTAMP;
    END IF;
END $$;

-- Seed users (idempotent)
-- Passwords will be set via the app (these are placeholder bcrypt hashes for 'password123')
-- $2b$10$... is bcrypt format - this hash is for 'password123'
INSERT INTO users (id, username, display_name, password_hash)
VALUES (1, 'jeroen', 'Jeroen', '$2b$10$rQZ5qXJvQkVGJh1zZL1C4.8HvEF1L1xBQEMJQ2ZE1K5VqQkVV5Uve')
ON CONFLICT (id) DO UPDATE SET
    password_hash = COALESCE(users.password_hash, EXCLUDED.password_hash);

INSERT INTO users (id, username, display_name, password_hash)
VALUES (2, 'testuser', 'TestUser', '$2b$10$rQZ5qXJvQkVGJh1zZL1C4.8HvEF1L1xBQEMJQ2ZE1K5VqQkVV5Uve')
ON CONFLICT (id) DO UPDATE SET
    password_hash = COALESCE(users.password_hash, EXCLUDED.password_hash);

-- Reset sequence to avoid conflicts
SELECT setval('users_id_seq', GREATEST((SELECT MAX(id) FROM users), 2));

-- Update existing content to belong to user 1 (Jeroen)
UPDATE content_items SET user_id = 1 WHERE user_id IS NULL;
UPDATE podcasts SET user_id = 1 WHERE user_id IS NULL;
UPDATE queue_items SET user_id = 1 WHERE user_id IS NULL;

-- Create indexes
CREATE INDEX IF NOT EXISTS idx_user_settings_user_id ON user_settings(user_id);
CREATE INDEX IF NOT EXISTS idx_user_sessions_user_id ON user_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_user_sessions_expires ON user_sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_content_items_user_id ON content_items(user_id);
CREATE INDEX IF NOT EXISTS idx_podcasts_user_id ON podcasts(user_id);
CREATE INDEX IF NOT EXISTS idx_queue_items_user_id ON queue_items(user_id);
