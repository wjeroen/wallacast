import { Request, Response, NextFunction } from 'express';
import { verifyAccessToken, TokenPayload } from '../services/auth.js';
import { isDatabaseReady } from '../database/db.js';

// Middleware to check if database is ready - returns 503 if not
export function requireDatabaseReady(req: Request, res: Response, next: NextFunction) {
  if (!isDatabaseReady()) {
    return res.status(503).json({
      error: 'Service starting up, please try again in a moment',
      retryAfter: 5,
    });
  }
  next();
}

// Extend Express Request type to include user
declare global {
  namespace Express {
    interface Request {
      user?: TokenPayload;
    }
  }
}

// Auth middleware - requires valid access token
export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token provided' });
  }

  const token = authHeader.substring(7);
  const payload = verifyAccessToken(token);

  if (!payload) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  req.user = payload;

  // Read-only demo enforcement.
  //
  // This deliberately lives in requireAuth, the single auth choke point that every protected
  // route passes through. Putting it here (rather than in individual routes) means no current
  // or future mutating endpoint can forget to enforce it. The shared demo account can read
  // everything but must not change anything, so we block any non-GET/HEAD/OPTIONS request,
  // with two narrow, harmless exceptions whitelisted below.
  if (payload.demo) {
    const method = req.method;
    const isReadMethod = method === 'GET' || method === 'HEAD' || method === 'OPTIONS';

    if (!isReadMethod) {
      // originalUrl includes the query string, strip it before matching the path.
      const path = (req.originalUrl || '').split('?')[0];
      // req.body may be undefined (no parsed body), guard against it.
      const body = req.body || {};

      // Exception a) the lean status poll the frontend uses to watch processing progress.
      const isStatusPoll = method === 'POST' && path === '/api/content/status';

      // Exception b) persisting playback position/speed on a single content item, so the shared
      // demo account can remember where playback stopped. Only allowed when every body key is in
      // this set and the body is non-empty, so edits/stars/regenerates stay blocked.
      const PLAYBACK_KEYS = ['playback_position', 'playback_speed', 'last_played_at'];
      const bodyKeys = Object.keys(body);
      const isPlaybackUpdate =
        method === 'PATCH' &&
        /^\/api\/content\/\d+$/.test(path) &&
        bodyKeys.length > 0 &&
        bodyKeys.every((key) => PLAYBACK_KEYS.includes(key));

      if (!isStatusPoll && !isPlaybackUpdate) {
        return res.status(403).json({
          error: 'This action is not available in the read-only demo.',
          demo: true,
        });
      }
    }
  }

  next();
}

// Optional auth - attaches user if token is valid, but doesn't fail if missing
export function optionalAuth(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;

  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.substring(7);
    const payload = verifyAccessToken(token);
    if (payload) {
      req.user = payload;
    }
  }

  next();
}
