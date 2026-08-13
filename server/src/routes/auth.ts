import { randomBytes } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import type {
  AuthenticationResponseJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { asyncHandler } from '../middleware/error.js';
import { COOKIE_NAME, requireAuth } from '../middleware/auth.js';
import {
  isPasswordSet,
  setupPassword,
  checkPassword,
  changePassword,
  consumeTwoFactorToken,
  issueToken,
  issueTwoFactorToken,
  MIN_PASSWORD_LEN,
  verifyTwoFactorToken,
} from '../services/auth.js';
import { loginRateLimit } from '../middleware/ratelimit.js';
import { cookieIsSecure } from '../services/cookies.js';
import { getSettings } from '../services/settings.js';
import {
  createTotpSetup,
  disableTotp,
  enableTotp,
  regenerateRecoveryCodes,
  verifySecondFactor,
  verifyTotpSecret,
} from '../services/mfa.js';
import {
  authenticationOptions,
  deletePasskey,
  finishAuthentication,
  finishRegistration,
  listPasskeys,
  registrationOptions,
} from '../services/passkeys.js';

export const authRouter = Router();

interface PendingTotpSetup {
  secret: string;
  expiresAt: number;
  sessionVersion: number;
}

const pendingTotpSetups = new Map<string, PendingTotpSetup>();
const TOTP_SETUP_TTL_MS = 10 * 60 * 1000;

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

async function setSessionCookie(req: Request, res: Response) {
  const token = await issueToken();
  res.cookie(COOKIE_NAME, token, cookieOpts(req));
}

function cleanTotpSetups(): void {
  const now = Date.now();
  for (const [id, setup] of pendingTotpSetups) {
    if (setup.expiresAt <= now) pendingTotpSetups.delete(id);
  }
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw Object.assign(new Error(`${field} required`), { status: 400 });
  }
  return value.trim();
}

async function requireCurrentPassword(value: unknown): Promise<void> {
  if (typeof value !== 'string' || !(await checkPassword(value))) {
    throw Object.assign(new Error('Current password is incorrect'), { status: 401 });
  }
}

authRouter.get(
  '/status',
  asyncHandler(async (_req, res) => {
    const settings = await getSettings();
    res.json({
      passwordSet: await isPasswordSet(),
      mustChangePassword: false,
      totpEnabled: settings.auth.totp.enabled,
      passkeyEnabled: settings.auth.passkeys.length > 0,
    });
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
    await setSessionCookie(req, res);
    res.json({ ok: true });
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
    await setSessionCookie(req, res);
    res.json({ ok: true });
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
    const settings = await getSettings();
    if (settings.auth.totp.enabled) {
      res.json({
        ok: false,
        requiresTwoFactor: true,
        twoFactorToken: await issueTwoFactorToken(),
      });
      return;
    }
    await setSessionCookie(req, res);
    res.json({ ok: true, requiresTwoFactor: false, mustChangePassword: false });
  }),
);

authRouter.post(
  '/login/totp',
  loginRateLimit,
  asyncHandler(async (req, res) => {
    const twoFactorToken = requiredString(req.body?.twoFactorToken, 'twoFactorToken');
    const code = requiredString(req.body?.code, 'code');
    const nonce = await verifyTwoFactorToken(twoFactorToken);
    if (!nonce) {
      res.status(401).json({ error: 'The two-factor login session expired; enter your password again' });
      return;
    }
    const result = await verifySecondFactor(code);
    if (!result.ok) {
      res.status(401).json({ error: 'Invalid or already-used verification code' });
      return;
    }
    consumeTwoFactorToken(nonce);
    await setSessionCookie(req, res);
    res.json({
      ok: true,
      method: result.method,
      recoveryCodesRemaining: result.recoveryCodesRemaining,
    });
  }),
);

authRouter.post(
  '/passkeys/login/options',
  loginRateLimit,
  asyncHandler(async (req, res) => {
    res.json(await authenticationOptions(req));
  }),
);

authRouter.post(
  '/passkeys/login/verify',
  loginRateLimit,
  asyncHandler(async (req, res) => {
    const ceremonyId = requiredString(req.body?.ceremonyId, 'ceremonyId');
    const response = req.body?.response as AuthenticationResponseJSON | undefined;
    if (!response || typeof response !== 'object') {
      res.status(400).json({ error: 'Passkey response required' });
      return;
    }
    await finishAuthentication(ceremonyId, response);
    await setSessionCookie(req, res);
    res.json({ ok: true });
  }),
);

authRouter.get(
  '/security',
  requireAuth,
  asyncHandler(async (_req, res) => {
    const settings = await getSettings();
    res.json({
      totpEnabled: settings.auth.totp.enabled,
      recoveryCodesRemaining: settings.auth.totp.recoveryCodeHashes.length,
      passkeys: await listPasskeys(),
    });
  }),
);

authRouter.post(
  '/totp/setup/start',
  requireAuth,
  asyncHandler(async (req, res) => {
    await requireCurrentPassword(req.body?.currentPassword);
    const settings = await getSettings();
    if (settings.auth.totp.enabled) {
      res.status(409).json({ error: 'Authenticator 2FA is already enabled' });
      return;
    }
    cleanTotpSetups();
    const setupId = randomBytes(24).toString('base64url');
    const setup = createTotpSetup();
    pendingTotpSetups.set(setupId, {
      secret: setup.secret,
      expiresAt: Date.now() + TOTP_SETUP_TTL_MS,
      sessionVersion: settings.auth.sessionVersion,
    });
    res.json({ setupId, secret: setup.secret, uri: setup.uri });
  }),
);

authRouter.post(
  '/totp/setup/verify',
  requireAuth,
  loginRateLimit,
  asyncHandler(async (req, res) => {
    cleanTotpSetups();
    const setupId = requiredString(req.body?.setupId, 'setupId');
    const code = requiredString(req.body?.code, 'code');
    const setup = pendingTotpSetups.get(setupId);
    const settings = await getSettings();
    if (!setup || setup.sessionVersion !== settings.auth.sessionVersion) {
      res.status(400).json({ error: 'The 2FA setup expired; please start again' });
      return;
    }
    const timeStep = await verifyTotpSecret(setup.secret, code);
    if (timeStep === null) {
      res.status(401).json({ error: 'Invalid verification code' });
      return;
    }
    pendingTotpSetups.delete(setupId);
    const recoveryCodes = await enableTotp(setup.secret, timeStep);
    await setSessionCookie(req, res);
    res.json({ ok: true, recoveryCodes });
  }),
);

authRouter.post(
  '/totp/disable',
  requireAuth,
  loginRateLimit,
  asyncHandler(async (req, res) => {
    await requireCurrentPassword(req.body?.currentPassword);
    const code = requiredString(req.body?.code, 'code');
    const result = await verifySecondFactor(code);
    if (!result.ok) {
      res.status(401).json({ error: 'Invalid or already-used verification code' });
      return;
    }
    await disableTotp();
    await setSessionCookie(req, res);
    res.json({ ok: true });
  }),
);

authRouter.post(
  '/totp/recovery-codes',
  requireAuth,
  loginRateLimit,
  asyncHandler(async (req, res) => {
    await requireCurrentPassword(req.body?.currentPassword);
    const code = requiredString(req.body?.code, 'code');
    const result = await verifySecondFactor(code);
    if (!result.ok) {
      res.status(401).json({ error: 'Invalid or already-used verification code' });
      return;
    }
    const recoveryCodes = await regenerateRecoveryCodes();
    await setSessionCookie(req, res);
    res.json({ ok: true, recoveryCodes });
  }),
);

authRouter.post(
  '/passkeys/register/options',
  requireAuth,
  asyncHandler(async (req, res) => {
    await requireCurrentPassword(req.body?.currentPassword);
    const name = requiredString(req.body?.name, 'name');
    if (name.length > 64) {
      res.status(400).json({ error: 'Passkey name must be 64 characters or fewer' });
      return;
    }
    res.json(await registrationOptions(req, name));
  }),
);

authRouter.post(
  '/passkeys/register/verify',
  requireAuth,
  asyncHandler(async (req, res) => {
    const ceremonyId = requiredString(req.body?.ceremonyId, 'ceremonyId');
    const response = req.body?.response as RegistrationResponseJSON | undefined;
    if (!response || typeof response !== 'object') {
      res.status(400).json({ error: 'Passkey response required' });
      return;
    }
    await finishRegistration(ceremonyId, response);
    res.json({ ok: true });
  }),
);

authRouter.delete(
  '/passkeys/:id',
  requireAuth,
  asyncHandler(async (req, res) => {
    await requireCurrentPassword(req.body?.currentPassword);
    if (!(await deletePasskey(req.params.id))) {
      res.status(404).json({ error: 'Passkey not found' });
      return;
    }
    await setSessionCookie(req, res);
    res.json({ ok: true });
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
