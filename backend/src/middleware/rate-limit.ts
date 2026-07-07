import rateLimit from 'express-rate-limit';

// Rate limiters for the unauthenticated /api/auth endpoints. Without these, a public
// instance allows unlimited online password guessing, automated account-creation spam,
// and password-reset email bombing (which also burns the operator's Resend quota).
//
// The store is in-memory, which is correct for a single Railway backend instance (the
// Hobby setup). If you ever run multiple backend replicas, swap in a shared store
// (e.g. rate-limit-redis) so the counters are shared across them.
//
// NOTE: index.ts sets `app.set('trust proxy', 1)` so these limiters key on the real
// client IP forwarded by Railway's proxy, not the proxy's own address. Without that,
// every visitor would share a single bucket.

// Login is the brute-force target, so keep it tight.
export const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 10, // 10 attempts per IP per window
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Please wait a few minutes and try again.' },
});

// Registration: block mass automated signups.
export const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many accounts created from this address. Please try again later.' },
});

// Password-reset requests: block inbox bombing and Resend quota abuse.
export const forgotPasswordLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many reset requests. Please try again later.' },
});
