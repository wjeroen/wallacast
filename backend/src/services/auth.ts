import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { query } from '../database/db.js';

const SALT_ROUNDS = 10;
const ACCESS_TOKEN_EXPIRY = '15m';
const REFRESH_TOKEN_EXPIRY_DAYS = 30;

// Get JWT secret from env or generate a random one (dev only)
function getJwtSecret(): string {
  if (process.env.JWT_SECRET) {
    return process.env.JWT_SECRET;
  }
  console.warn('WARNING: JWT_SECRET not set, using random secret (sessions will not persist across restarts)');
  return crypto.randomBytes(32).toString('hex');
}

const JWT_SECRET = getJwtSecret();

export interface User {
  id: number;
  username: string;
  email: string | null;
  display_name: string | null;
  is_active: boolean;
  created_at: Date;
}

export interface TokenPayload {
  userId: number;
  username: string;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  user: User;
}

// Hash a password
export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, SALT_ROUNDS);
}

// Verify a password against a hash
export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

// Generate access token (short-lived)
export function generateAccessToken(user: User): string {
  const payload: TokenPayload = {
    userId: user.id,
    username: user.username,
  };
  return jwt.sign(payload, JWT_SECRET, { expiresIn: ACCESS_TOKEN_EXPIRY });
}

// Generate refresh token (long-lived)
export function generateRefreshToken(): string {
  return crypto.randomBytes(40).toString('hex');
}

// Hash refresh token for storage
export function hashRefreshToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

// Verify access token
export function verifyAccessToken(token: string): TokenPayload | null {
  try {
    return jwt.verify(token, JWT_SECRET) as TokenPayload;
  } catch {
    return null;
  }
}

// Login user
export async function loginUser(username: string, password: string): Promise<AuthTokens | null> {
  const result = await query(
    'SELECT id, username, email, password_hash, display_name, is_active, created_at FROM users WHERE username = $1',
    [username.toLowerCase()]
  );

  if (result.rows.length === 0) {
    return null;
  }

  const user = result.rows[0];

  if (!user.is_active) {
    return null;
  }

  if (!user.password_hash) {
    // User has no password set (legacy user)
    return null;
  }

  const isValid = await verifyPassword(password, user.password_hash);
  if (!isValid) {
    return null;
  }

  // Update last login
  await query('UPDATE users SET last_login_at = NOW() WHERE id = $1', [user.id]);

  // Generate tokens
  const accessToken = generateAccessToken(user);
  const refreshToken = generateRefreshToken();
  const refreshTokenHash = hashRefreshToken(refreshToken);

  // Store refresh token in database
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + REFRESH_TOKEN_EXPIRY_DAYS);

  await query(
    'INSERT INTO user_sessions (user_id, refresh_token_hash, expires_at) VALUES ($1, $2, $3)',
    [user.id, refreshTokenHash, expiresAt]
  );

  // Clean up expired sessions
  await query('DELETE FROM user_sessions WHERE expires_at < NOW() OR revoked_at IS NOT NULL');

  return {
    accessToken,
    refreshToken,
    user: {
      id: user.id,
      username: user.username,
      email: user.email,
      display_name: user.display_name,
      is_active: user.is_active,
      created_at: user.created_at,
    },
  };
}

// Refresh access token using refresh token
export async function refreshAccessToken(refreshToken: string): Promise<{ accessToken: string; user: User } | null> {
  const refreshTokenHash = hashRefreshToken(refreshToken);

  const result = await query(
    `SELECT s.user_id, s.expires_at, u.id, u.username, u.email, u.display_name, u.is_active, u.created_at
     FROM user_sessions s
     JOIN users u ON s.user_id = u.id
     WHERE s.refresh_token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > NOW()`,
    [refreshTokenHash]
  );

  if (result.rows.length === 0) {
    return null;
  }

  const row = result.rows[0];
  const user: User = {
    id: row.id,
    username: row.username,
    email: row.email,
    display_name: row.display_name,
    is_active: row.is_active,
    created_at: row.created_at,
  };

  if (!user.is_active) {
    return null;
  }

  const accessToken = generateAccessToken(user);
  return { accessToken, user };
}

// Logout (revoke refresh token)
export async function logoutUser(refreshToken: string): Promise<void> {
  const refreshTokenHash = hashRefreshToken(refreshToken);
  await query(
    'UPDATE user_sessions SET revoked_at = NOW() WHERE refresh_token_hash = $1',
    [refreshTokenHash]
  );
}

// Logout all sessions for a user
export async function logoutAllSessions(userId: number): Promise<void> {
  await query('UPDATE user_sessions SET revoked_at = NOW() WHERE user_id = $1', [userId]);
}

// Get user by ID
export async function getUserById(userId: number): Promise<User | null> {
  const result = await query(
    'SELECT id, username, email, display_name, is_active, created_at FROM users WHERE id = $1',
    [userId]
  );

  if (result.rows.length === 0) {
    return null;
  }

  return result.rows[0];
}

// Register new user
export async function registerUser(
  username: string,
  password: string,
  displayName?: string,
  email?: string
): Promise<User | null> {
  const passwordHash = await hashPassword(password);

  try {
    const result = await query(
      `INSERT INTO users (username, password_hash, display_name, email)
       VALUES ($1, $2, $3, $4)
       RETURNING id, username, email, display_name, is_active, created_at`,
      [username.toLowerCase(), passwordHash, displayName || username, email?.toLowerCase()]
    );

    return result.rows[0];
  } catch (error: any) {
    // Unique constraint violation (username or email already exists)
    if (error.code === '23505') {
      return null;
    }
    throw error;
  }
}

// Change password
export async function changePassword(userId: number, currentPassword: string, newPassword: string): Promise<boolean> {
  const result = await query('SELECT password_hash FROM users WHERE id = $1', [userId]);

  if (result.rows.length === 0) {
    return false;
  }

  const isValid = await verifyPassword(currentPassword, result.rows[0].password_hash);
  if (!isValid) {
    return false;
  }

  const newPasswordHash = await hashPassword(newPassword);
  await query('UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2', [newPasswordHash, userId]);

  // Revoke all existing sessions (force re-login)
  await logoutAllSessions(userId);

  return true;
}

// Bootstrap: Create first user from AUTH_USERNAME/AUTH_PASSWORD env vars
// Called on startup to ensure at least one user exists
export async function bootstrapFirstUser(): Promise<void> {
  const username = process.env.AUTH_USERNAME;
  const password = process.env.AUTH_PASSWORD;

  if (!username || !password) {
    console.log('⚠ AUTH_USERNAME/AUTH_PASSWORD not set, skipping user bootstrap');
    return;
  }

  // Check if the AUTH_USERNAME user already exists
  const existingUser = await query(
    'SELECT id, username FROM users WHERE username = $1',
    [username.toLowerCase()]
  );

  if (existingUser.rows.length > 0) {
    console.log(`✓ User "${username}" already exists, skipping bootstrap`);
    await assignOrphanedContent();
    return;
  }

  // AUTH_USERNAME doesn't exist, but check if OTHER users exist
  const userCountResult = await query('SELECT COUNT(*) as count FROM users');
  const userCount = parseInt(userCountResult.rows[0].count, 10);

  if (userCount > 0) {
    // Other users exist but not the AUTH_USERNAME user
    // This happens when hardcoded users were created but AUTH_USERNAME changed
    console.log(`⚠ Found ${userCount} user(s) but AUTH_USERNAME "${username}" not found`);
    console.log('Removing existing users to bootstrap with AUTH_USERNAME...');

    await query('DELETE FROM users');
    console.log(`✓ Removed ${userCount} user(s)`);
  }

  // Create the AUTH_USERNAME user
  console.log(`Creating first user from AUTH_USERNAME: ${username}`);

  const passwordHash = await hashPassword(password);

  try {
    const insertResult = await query(
      `INSERT INTO users (username, password_hash, display_name)
       VALUES ($1, $2, $3)
       RETURNING id, username`,
      [username.toLowerCase(), passwordHash, username]
    );

    const newUser = insertResult.rows[0];
    console.log(`✓ Created user "${newUser.username}" with id ${newUser.id}`);

    // Assign all existing content to this user
    await assignOrphanedContent();

  } catch (error: any) {
    if (error.code === '23505') {
      console.log(`User "${username}" already exists`);
    } else {
      throw error;
    }
  }
}

// Assign content with no user_id to the first user
async function assignOrphanedContent(): Promise<void> {
  // Get the first user (lowest ID)
  const userResult = await query('SELECT id FROM users ORDER BY id ASC LIMIT 1');

  if (userResult.rows.length === 0) {
    return;
  }

  const firstUserId = userResult.rows[0].id;

  // Update orphaned content
  const contentResult = await query(
    'UPDATE content_items SET user_id = $1 WHERE user_id IS NULL',
    [firstUserId]
  );
  if (contentResult.rowCount && contentResult.rowCount > 0) {
    console.log(`✓ Assigned ${contentResult.rowCount} content item(s) to user ${firstUserId}`);
  }

  const podcastResult = await query(
    'UPDATE podcasts SET user_id = $1 WHERE user_id IS NULL',
    [firstUserId]
  );
  if (podcastResult.rowCount && podcastResult.rowCount > 0) {
    console.log(`✓ Assigned ${podcastResult.rowCount} podcast(s) to user ${firstUserId}`);
  }

  const queueResult = await query(
    'UPDATE queue_items SET user_id = $1 WHERE user_id IS NULL',
    [firstUserId]
  );
  if (queueResult.rowCount && queueResult.rowCount > 0) {
    console.log(`✓ Assigned ${queueResult.rowCount} queue item(s) to user ${firstUserId}`);
  }
}
