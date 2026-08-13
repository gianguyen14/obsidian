import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { generateSecret, generateURI, verify } from 'otplib';
import { getSettings, updateSettings } from './settings.js';

const RECOVERY_CODE_COUNT = 10;
const TOTP_PERIOD_SECONDS = 30;

export interface TotpSetup {
  secret: string;
  uri: string;
}

function encryptionKey(jwtSecret: string): Buffer {
  return createHash('sha256').update(`webobsidian:totp:${jwtSecret}`).digest();
}

function encryptSecret(secret: string, jwtSecret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(jwtSecret), iv);
  const encrypted = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString('base64url')}.${tag.toString('base64url')}.${encrypted.toString('base64url')}`;
}

function decryptSecret(stored: string, jwtSecret: string): string {
  const [version, ivRaw, tagRaw, encryptedRaw] = stored.split('.');
  if (version !== 'v1' || !ivRaw || !tagRaw || !encryptedRaw) {
    throw new Error('Invalid encrypted TOTP secret');
  }
  const decipher = createDecipheriv(
    'aes-256-gcm',
    encryptionKey(jwtSecret),
    Buffer.from(ivRaw, 'base64url'),
  );
  decipher.setAuthTag(Buffer.from(tagRaw, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(encryptedRaw, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

function normalizeCode(code: string): string {
  return code.replace(/[\s-]/g, '').toUpperCase();
}

function recoveryCodeHash(code: string, jwtSecret: string): string {
  return createHmac('sha256', jwtSecret)
    .update(`webobsidian:recovery:${normalizeCode(code)}`)
    .digest('hex');
}

function constantTimeHexEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

function makeRecoveryCodes(): string[] {
  return Array.from({ length: RECOVERY_CODE_COUNT }, () => {
    const raw = randomBytes(10).toString('hex').toUpperCase();
    return raw.match(/.{1,5}/g)?.join('-') ?? raw;
  });
}

export function createTotpSetup(): TotpSetup {
  const secret = generateSecret({ length: 20 });
  return {
    secret,
    uri: generateURI({
      issuer: 'WebObsidian',
      label: 'owner',
      secret,
      algorithm: 'sha1',
      digits: 6,
      period: TOTP_PERIOD_SECONDS,
    }),
  };
}

export async function verifyTotpSecret(secret: string, code: string): Promise<number | null> {
  const normalized = normalizeCode(code);
  if (!/^\d{6}$/.test(normalized)) return null;
  const result = await verify({
    secret,
    token: normalized,
    algorithm: 'sha1',
    digits: 6,
    period: TOTP_PERIOD_SECONDS,
    epochTolerance: TOTP_PERIOD_SECONDS,
  });
  return result.valid && 'timeStep' in result ? result.timeStep : null;
}

export async function enableTotp(secret: string, firstTimeStep: number): Promise<string[]> {
  const recoveryCodes = makeRecoveryCodes();
  await updateSettings((draft) => {
    draft.auth.totp.enabled = true;
    draft.auth.totp.secretEncrypted = encryptSecret(secret, draft.auth.jwtSecret);
    draft.auth.totp.recoveryCodeHashes = recoveryCodes.map((code) =>
      recoveryCodeHash(code, draft.auth.jwtSecret),
    );
    draft.auth.totp.lastUsedTimeStep = firstTimeStep;
    draft.auth.sessionVersion += 1;
  });
  return recoveryCodes;
}

type SecondFactorResult =
  | { ok: false }
  | { ok: true; method: 'totp' | 'recovery'; recoveryCodesRemaining: number };

let totpVerificationQueue = Promise.resolve();

function serialized<T>(operation: () => Promise<T>): Promise<T> {
  const result = totpVerificationQueue.then(operation, operation);
  totpVerificationQueue = result.then(() => undefined, () => undefined);
  return result;
}

/**
 * Verify a TOTP or one-time recovery code. TOTP time steps are persisted to
 * prevent replay; recovery codes are removed atomically and revoke older
 * sessions before a new session is issued.
 */
export async function verifySecondFactor(code: string): Promise<SecondFactorResult> {
  return serialized(async () => {
    const settings = await getSettings();
    const totp = settings.auth.totp;
    if (!totp.enabled || !totp.secretEncrypted) return { ok: false };

    const normalized = normalizeCode(code);
    if (/^\d{6}$/.test(normalized)) {
      const secret = decryptSecret(totp.secretEncrypted, settings.auth.jwtSecret);
      const result = await verify({
        secret,
        token: normalized,
        algorithm: 'sha1',
        digits: 6,
        period: TOTP_PERIOD_SECONDS,
        epochTolerance: TOTP_PERIOD_SECONDS,
        ...(totp.lastUsedTimeStep === null ? {} : { afterTimeStep: totp.lastUsedTimeStep }),
      });
      if (!result.valid || !('timeStep' in result)) return { ok: false };
      await updateSettings((draft) => {
        draft.auth.totp.lastUsedTimeStep = result.timeStep;
      });
      return {
        ok: true,
        method: 'totp',
        recoveryCodesRemaining: totp.recoveryCodeHashes.length,
      };
    }

    const candidate = recoveryCodeHash(normalized, settings.auth.jwtSecret);
    const recoveryIndex = totp.recoveryCodeHashes.findIndex((stored) =>
      constantTimeHexEqual(candidate, stored),
    );
    if (recoveryIndex === -1) return { ok: false };
    await updateSettings((draft) => {
      draft.auth.totp.recoveryCodeHashes.splice(recoveryIndex, 1);
      draft.auth.sessionVersion += 1;
    });
    return {
      ok: true,
      method: 'recovery',
      recoveryCodesRemaining: totp.recoveryCodeHashes.length - 1,
    };
  });
}

export async function disableTotp(): Promise<void> {
  await updateSettings((draft) => {
    draft.auth.totp.enabled = false;
    draft.auth.totp.secretEncrypted = '';
    draft.auth.totp.recoveryCodeHashes = [];
    draft.auth.totp.lastUsedTimeStep = null;
    draft.auth.sessionVersion += 1;
  });
}

export async function regenerateRecoveryCodes(): Promise<string[]> {
  const recoveryCodes = makeRecoveryCodes();
  await updateSettings((draft) => {
    draft.auth.totp.recoveryCodeHashes = recoveryCodes.map((code) =>
      recoveryCodeHash(code, draft.auth.jwtSecret),
    );
    draft.auth.sessionVersion += 1;
  });
  return recoveryCodes;
}
