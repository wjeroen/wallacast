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
  // True only for read-only demo SESSIONS (see the demo-session rules above isDemoUsername).
  // Never stored in the DB.
  demo?: boolean;
}

export interface TokenPayload {
  userId: number;
  username: string;
  // Present and true only for read-only demo sessions. requireAuth reads this to block writes.
  demo?: boolean;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  user: User;
}

// The shared demo account is an ordinary users row named by DEMO_USERNAME (default 'demo').
// "Demo-ness" is a property of the SESSION, not of the user row, and is never stored in the DB:
//   - A session created by the passwordless POST /auth/demo endpoint is read-only (demo: true).
//   - A PASSWORD login into the same account is a normal writable session. Knowing the password
//     proves operator access, and the seed script (scripts/seed-demo.mjs) relies on this to
//     populate the demo library through the ordinary API.
//   - Token REFRESH re-locks any session on the demo username. A visitor's demo session can
//     therefore never escape read-only, while the operator (who holds the password) simply logs
//     in again when a writable token expires.
function isDemoUsername(username: string): boolean {
  const demoUsername = (process.env.DEMO_USERNAME || 'demo').toLowerCase();
  return typeof username === 'string' && username.toLowerCase() === demoUsername;
}

// Map a raw users row to the User shape returned to the frontend, adding demo: true only when
// the SESSION is a read-only demo session (the caller decides, see the rules above).
function buildUserResponse(row: any, demoSession: boolean): User {
  const user: User = {
    id: row.id,
    username: row.username,
    email: row.email,
    display_name: row.display_name,
    is_active: row.is_active,
    created_at: row.created_at,
  };
  if (demoSession) {
    user.demo = true;
  }
  return user;
}

// Hash a password
export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, SALT_ROUNDS);
}

// Verify a password against a hash
export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

// Generate access token (short-lived). demoSession stamps the read-only demo claim, see the
// demo-session rules above isDemoUsername for who gets it.
export function generateAccessToken(user: User, demoSession: boolean = false): string {
  const payload: TokenPayload = {
    userId: user.id,
    username: user.username,
  };
  if (demoSession) {
    payload.demo = true;
  }
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

  // A password login is always a writable session, even for the demo account: knowing the
  // password proves operator access (this is how the demo seed script writes content).
  return issueSessionTokens(user, false);
}

// Shared internals of loginUser and demoLogin: record the login, mint the token pair, persist
// the refresh session, and return the standard AuthTokens response. The caller is responsible
// for authenticating the user first (password check for login, existence check for demo) and
// decides whether this session is a read-only demo session.
async function issueSessionTokens(user: any, demoSession: boolean): Promise<AuthTokens> {
  // Update last login
  await query('UPDATE users SET last_login_at = NOW() WHERE id = $1', [user.id]);

  // Generate tokens
  const accessToken = generateAccessToken(user, demoSession);
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
    user: buildUserResponse(user, demoSession),
  };
}

// Demo login: log in to the shared read-only demo account without a password. Returns null when
// the demo account does not exist (or is disabled) so the route can respond 404. Issues the exact
// same token pair and user response as loginUser by sharing issueSessionTokens.
export async function demoLogin(): Promise<AuthTokens | null> {
  const demoUsername = (process.env.DEMO_USERNAME || 'demo').toLowerCase();
  // Case-insensitive lookup, matching isDemoUsername: a demo account registered with any
  // capitalization must resolve to the same row the token flag is derived from.
  const result = await query(
    'SELECT id, username, email, display_name, is_active, created_at FROM users WHERE LOWER(username) = $1',
    [demoUsername]
  );

  if (result.rows.length === 0) {
    return null;
  }

  const user = result.rows[0];

  if (!user.is_active) {
    return null;
  }

  // Passwordless entry point, so this session is read-only.
  return issueSessionTokens(user, true);
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
  // Refresh always RE-LOCKS sessions on the demo username: the refresh token alone does not
  // prove operator access, so a visitor's demo session can never escape read-only this way.
  // An operator whose writable password session expires simply logs in again.
  const demoSession = isDemoUsername(row.username);
  const user = buildUserResponse(row, demoSession);

  if (!user.is_active) {
    return null;
  }

  const accessToken = generateAccessToken(user, demoSession);
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

  // Demo-ness is a session property, not a user property, so it is not stamped here. The /me
  // route copies it from the verified token payload instead.
  return buildUserResponse(result.rows[0], false);
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

// Bootstrap: Assign orphaned content to the first user if any exists
// This is only needed for migrating from single-user to multi-user setup
export async function bootstrapFirstUser(): Promise<void> {
  // Check if there are any users at all
  const userCountResult = await query('SELECT COUNT(*) as count FROM users');
  const userCount = parseInt(userCountResult.rows[0].count, 10);

  if (userCount === 0) {
    console.log('ℹ No users exist yet. Users can register via /api/auth/register');
    return;
  }

  console.log(`✓ ${userCount} user(s) exist in database`);

  // Assign any orphaned content to the first user (migration from single-user setup)
  await assignOrphanedContent();
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
