import { Router } from 'express';
import {
  loginUser,
  demoLogin,
  registerUser,
  refreshAccessToken,
  logoutUser,
  getUserById,
  changePassword,
  createPasswordResetToken,
  resetPasswordWithToken,
} from '../services/auth.js';
import { emailConfigured, sendEmail } from '../services/email.js';
import { requireAuth } from '../middleware/auth.js';
import { loginLimiter, registerLimiter, forgotPasswordLimiter, tokenLimiter } from '../middleware/rate-limit.js';
import { createApiToken, listApiTokens, revokeApiToken, ApiTokenLimitError } from '../services/api-tokens.js';

const router = Router();

// POST /api/auth/login - Login and get tokens
router.post('/login', loginLimiter, async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }

    const result = await loginUser(username, password);

    if (!result) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    res.json({
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      user: result.user,
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/auth/demo - Log in to the shared read-only demo account (no password required).
// Returns the same token pair and user response shape as /login. Responds 404 when this instance
// has no demo account configured, so the frontend can hide or disable the "Try the demo" button.
router.post('/demo', async (req, res) => {
  try {
    const result = await demoLogin();

    if (!result) {
      return res.status(404).json({ error: 'Demo is not available on this instance' });
    }

    res.json({
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      user: result.user,
    });
  } catch (error) {
    console.error('Demo login error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/auth/config - Public instance configuration the logged-out UI needs
// (currently only whether registration requires an invite code).
router.get('/config', (_req, res) => {
  res.json({ inviteRequired: !!(process.env.INVITE_CODE || '').trim() });
});

// POST /api/auth/register - Register new user
router.post('/register', registerLimiter, async (req, res) => {
  try {
    const { username, password, displayName, email } = req.body;

    // Optional invite gate: when the INVITE_CODE env var is set, registration requires
    // the matching code. Unset (the default) keeps registration open for self-hosters.
    const requiredCode = (process.env.INVITE_CODE || '').trim();
    if (requiredCode) {
      const given = typeof req.body.inviteCode === 'string' ? req.body.inviteCode.trim() : '';
      if (given !== requiredCode) {
        return res.status(403).json({ error: 'This instance requires a valid invite code to register' });
      }
    }

    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }

    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    if (username.length < 3) {
      return res.status(400).json({ error: 'Username must be at least 3 characters' });
    }

    const user = await registerUser(username, password, displayName, email);

    if (!user) {
      return res.status(409).json({ error: 'Username or email already exists' });
    }

    // Auto-login after registration
    const loginResult = await loginUser(username, password);

    if (!loginResult) {
      return res.status(500).json({ error: 'Registration succeeded but login failed' });
    }

    res.status(201).json({
      accessToken: loginResult.accessToken,
      refreshToken: loginResult.refreshToken,
      user: loginResult.user,
    });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/auth/forgot-password - Email a password reset link. Requires the email
// service to be configured (RESEND_API_KEY), otherwise reports itself unavailable.
router.post('/forgot-password', forgotPasswordLimiter, async (req, res) => {
  try {
    if (!emailConfigured()) {
      return res.status(503).json({ error: 'Password reset by email is not set up on this instance. Contact the operator.' });
    }

    const { username } = req.body;
    if (!username || typeof username !== 'string') {
      return res.status(400).json({ error: 'Username is required' });
    }

    const created = await createPasswordResetToken(username.trim());
    if (created) {
      const base = (process.env.FRONTEND_URL || '').trim().replace(/\/+$/, '');
      const link = `${base}/?reset=${created.token}`;
      try {
        await sendEmail(
          created.email,
          'Reset your Wallacast password',
          `Someone asked to reset the Wallacast password for "${username.trim()}".\n\n` +
          `Open this link to choose a new password (valid for 1 hour):\n${link}\n\n` +
          `If this was not you, you can ignore this email. Your password stays unchanged.`
        );
      } catch (mailErr) {
        console.error('Password reset email failed:', mailErr);
        return res.status(502).json({ error: 'Could not send the reset email, try again later' });
      }
    }

    // Same answer whether or not the account exists or has an email address, so this
    // endpoint cannot be used to probe usernames.
    res.json({ message: 'If that account exists and has an email address, a reset link is on its way.' });
  } catch (error) {
    console.error('Forgot password error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/auth/reset-password - Set a new password using an emailed token.
router.post('/reset-password', async (req, res) => {
  try {
    const { token, newPassword } = req.body;
    if (!token || !newPassword) {
      return res.status(400).json({ error: 'Token and new password are required' });
    }
    if (newPassword.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    const ok = await resetPasswordWithToken(token, newPassword);
    if (!ok) {
      return res.status(400).json({ error: 'This reset link is invalid or has expired. Request a new one.' });
    }

    res.json({ success: true, message: 'Password changed. You can now sign in.' });
  } catch (error) {
    console.error('Reset password error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/auth/refresh - Refresh access token
router.post('/refresh', async (req, res) => {
  try {
    const { refreshToken } = req.body;

    if (!refreshToken) {
      return res.status(400).json({ error: 'Refresh token is required' });
    }

    const result = await refreshAccessToken(refreshToken);

    if (!result) {
      return res.status(401).json({ error: 'Invalid or expired refresh token' });
    }

    res.json({
      accessToken: result.accessToken,
      user: result.user,
    });
  } catch (error) {
    console.error('Token refresh error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/auth/logout - Logout (revoke refresh token)
router.post('/logout', async (req, res) => {
  try {
    const { refreshToken } = req.body;

    if (refreshToken) {
      await logoutUser(refreshToken);
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Logout error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/auth/me - Get current user info
router.get('/me', requireAuth, async (req, res) => {
  try {
    const user = await getUserById(req.user!.userId);

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Demo-ness is a session property: the verified token payload is the source of truth,
    // so a read-only demo session keeps its flag across page reloads (checkAuth calls /me).
    if (req.user!.demo) {
      user.demo = true;
    }

    res.json({ user });
  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/auth/change-password - Change password
router.post('/change-password', requireAuth, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'Current and new password are required' });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({ error: 'New password must be at least 6 characters' });
    }

    const success = await changePassword(req.user!.userId, currentPassword, newPassword);

    if (!success) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }

    res.json({ success: true, message: 'Password changed. Please log in again.' });
  } catch (error) {
    console.error('Change password error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// Read-only API tokens (services/api-tokens.ts, migration 029). JWT sessions only: the
// allow-list in requireAuth already keeps a token away from these routes, and the explicit
// req.apiToken check below makes that intent visible. The demo session cannot create or
// revoke (requireAuth blocks every non-GET for it). It may list, and sees none.
// ---------------------------------------------------------------------------

// POST /api/auth/tokens { name } - Create a token. The raw token is in this response only.
router.post('/tokens', tokenLimiter, requireAuth, async (req, res) => {
  try {
    if (req.apiToken) {
      return res.status(403).json({ error: 'This token is read-only' });
    }
    if (req.user!.demo) {
      return res.status(403).json({ error: 'Tokens cannot be created in the read-only demo.', demo: true });
    }
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    if (!name) {
      return res.status(400).json({ error: 'Give the token a name, such as the device or tool it is for' });
    }
    if (name.length > 100) {
      return res.status(400).json({ error: 'Token name must be 100 characters or fewer' });
    }
    const created = await createApiToken(req.user!.userId, name);
    console.log(`[ApiToken] user=${req.user!.userId} created token ${created.id} "${name}"`);
    res.status(201).json(created);
  } catch (error) {
    if (error instanceof ApiTokenLimitError) {
      return res.status(400).json({ error: error.message });
    }
    console.error('Create API token error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/auth/tokens - The caller's live tokens (id, name, created_at, last_used_at).
// Never the token value itself, which exists only in the create response.
router.get('/tokens', requireAuth, async (req, res) => {
  try {
    if (req.apiToken) {
      return res.status(403).json({ error: 'This token is read-only' });
    }
    res.json({ tokens: await listApiTokens(req.user!.userId) });
  } catch (error) {
    console.error('List API tokens error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/auth/tokens/:id - Revoke a token. Requests carrying it fail from then on.
router.delete('/tokens/:id', tokenLimiter, requireAuth, async (req, res) => {
  try {
    if (req.apiToken) {
      return res.status(403).json({ error: 'This token is read-only' });
    }
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ error: 'Invalid token id' });
    }
    const revoked = await revokeApiToken(req.user!.userId, id);
    if (!revoked) {
      return res.status(404).json({ error: 'Token not found' });
    }
    console.log(`[ApiToken] user=${req.user!.userId} revoked token ${id}`);
    res.json({ success: true });
  } catch (error) {
    console.error('Revoke API token error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
