import { Router, type Request } from 'express';
import { asyncHandler } from '../middleware/error.js';
import { COOKIE_NAME, requireAuth } from '../middleware/auth.js';
import {
  isPasswordSet,
  setupPassword,
  checkPassword,
  changePassword,
  issueToken,
  MIN_PASSWORD_LEN,
} from '../services/auth.js';
import { loginRateLimit } from '../middleware/ratelimit.js';
import { cookieIsSecure } from '../services/cookies.js';

export const authRouter = Router();

// A `Secure` cookie is silently dropped by browsers over plain http://, so tying
// it to NODE_ENV broke HTTP-only self-hosting (every API call 401'd → blank UI).
// Default 'auto' = match the request's actual transport (honours X-Forwarded-Proto
// via `trust proxy`); set COOKIE_SECURE=true/false to force.
function cookieOpts(req: Request) {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: cookieIsSecure(req),
    maxAge: 30 * 24 * 60 * 60 * 1000,
    path: '/',
  };
}

authRouter.get(
  '/status',
  asyncHandler(async (_req, res) => {
    res.json({ passwordSet: await isPasswordSet(), mustChangePassword: false });
  }),
);

authRouter.post(
  '/setup',
  asyncHandler(async (req, res) => {
    const { password } = req.body ?? {};
    if (typeof password !== 'string') {
      res.status(400).json({ error: 'password required' });
      return;
    }
    if (password.length < MIN_PASSWORD_LEN) {
      res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD_LEN} characters` });
      return;
    }
    await setupPassword(password);
    const token = await issueToken();
    res.cookie(COOKIE_NAME, token, cookieOpts(req)).json({ ok: true });
  }),
);

authRouter.post(
  '/change-password',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { currentPassword, newPassword } = req.body ?? {};
    if (typeof currentPassword !== 'string' || typeof newPassword !== 'string') {
      res.status(400).json({ error: 'currentPassword and newPassword required' });
      return;
    }
    if (newPassword.length < MIN_PASSWORD_LEN) {
      res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD_LEN} characters` });
      return;
    }
    try {
      await changePassword(currentPassword, newPassword);
    } catch {
      res.status(401).json({ error: 'Current password is incorrect' });
      return;
    }
    const token = await issueToken();
    res.cookie(COOKIE_NAME, token, cookieOpts(req)).json({ ok: true });
  }),
);

authRouter.post(
  '/login',
  loginRateLimit,
  asyncHandler(async (req, res) => {
    const { password } = req.body ?? {};
    if (typeof password !== 'string' || !(await checkPassword(password))) {
      res.status(401).json({ error: 'Invalid password' });
      return;
    }
    const token = await issueToken();
    res
      .cookie(COOKIE_NAME, token, cookieOpts(req))
      .json({ ok: true, mustChangePassword: false });
  }),
);

authRouter.post('/logout', (_req, res) => {
  res.clearCookie(COOKIE_NAME, { path: '/' }).json({ ok: true });
});

authRouter.get(
  '/me',
  requireAuth,
  asyncHandler(async (_req, res) => {
    res.json({ authenticated: true, mustChangePassword: false });
  }),
);
