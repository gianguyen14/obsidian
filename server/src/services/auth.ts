import { scrypt, randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import jwt from 'jsonwebtoken';
import { getSettings, updateSettings } from './settings.js';
import { config } from '../config.js';

const scryptAsync = promisify(scrypt);
const KEYLEN = 64;

export const MIN_PASSWORD_LEN = 12;

/** So sánh chuỗi an toàn về timing (cho override pass dạng plaintext). */
function safeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** scrypt$<saltHex>$<hashHex> */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = (await scryptAsync(password, salt, KEYLEN)) as Buffer;
  return `scrypt$${salt.toString('hex')}$${derived.toString('hex')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const salt = Buffer.from(parts[1], 'hex');
  const expected = Buffer.from(parts[2], 'hex');
  const derived = (await scryptAsync(password, salt, KEYLEN)) as Buffer;
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

export async function isPasswordSet(): Promise<boolean> {
  const s = await getSettings();
  return Boolean(s.auth.userPasswordHash || s.auth.passwordHash || config.initialPassword);
}

async function storeUserPassword(password: string, requireUnset: boolean): Promise<void> {
  if (password.length < MIN_PASSWORD_LEN) {
    throw new Error(`Password must be at least ${MIN_PASSWORD_LEN} characters`);
  }
  const hash = await hashPassword(password);
  await updateSettings((d) => {
    if (requireUnset && (d.auth.userPasswordHash || d.auth.passwordHash)) {
      throw Object.assign(new Error('Password already set'), { status: 409 });
    }
    d.auth.userPasswordHash = hash;
    d.auth.sessionVersion += 1;
  });
}

let setupInProgress = false;

/** Store the first password exactly once, including across concurrent requests. */
export async function setupPassword(password: string): Promise<void> {
  if (setupInProgress || (await isPasswordSet())) {
    throw Object.assign(new Error('Password already set'), { status: 409 });
  }
  setupInProgress = true;
  try {
    await storeUserPassword(password, true);
  } finally {
    setupInProgress = false;
  }
}

export async function setUserPassword(password: string): Promise<void> {
  await storeUserPassword(password, false);
}

/**
 * Kiểm tra mật khẩu đăng nhập. Chấp nhận:
 *  1) Mật khẩu người dùng (userPasswordHash).
 *  2) Mật khẩu recovery auth.passwordHash (hash, sửa tay). The environment
 *     bootstrap password is accepted only until a persisted password exists.
 */
export async function checkPassword(password: string): Promise<boolean> {
  const s = await getSettings();

  // (1) Mật khẩu đăng nhập hiệu dụng.
  if (s.auth.userPasswordHash) {
    if (await verifyPassword(password, s.auth.userPasswordHash)) return true;
  }

  // (2) Mật khẩu override (recovery) — luôn kiểm tra, kể cả khi đã đổi pass.
  if (s.auth.passwordHash && (await verifyPassword(password, s.auth.passwordHash))) return true;
  if (!s.auth.userPasswordHash && config.initialPassword && safeEqualStr(password, config.initialPassword)) {
    return true;
  }

  return false;
}

/** Đổi mật khẩu: xác minh pass hiện tại rồi lưu pass mới. */
export async function changePassword(current: string, next: string): Promise<void> {
  if (!(await checkPassword(current))) throw new Error('Current password is incorrect');
  await setUserPassword(next);
}

const TOKEN_TTL = '30d';
const TWO_FACTOR_TOKEN_TTL_SECONDS = 5 * 60;
const pendingTwoFactorLogins = new Map<string, number>();

export async function issueToken(): Promise<string> {
  const s = await getSettings();
  return jwt.sign({ sub: 'owner', sv: s.auth.sessionVersion }, s.auth.jwtSecret, {
    expiresIn: TOKEN_TTL,
    algorithm: 'HS256',
  });
}

/** Issue a short-lived token that proves the password step succeeded, but is
 * deliberately rejected by normal session middleware until TOTP is completed. */
export async function issueTwoFactorToken(): Promise<string> {
  const s = await getSettings();
  const nonce = randomBytes(24).toString('base64url');
  pendingTwoFactorLogins.set(nonce, Date.now() + TWO_FACTOR_TOKEN_TTL_SECONDS * 1000);
  cleanupPendingTwoFactorLogins();
  return jwt.sign(
    { sub: 'owner-2fa', sv: s.auth.sessionVersion, nonce },
    s.auth.jwtSecret,
    { expiresIn: TWO_FACTOR_TOKEN_TTL_SECONDS, algorithm: 'HS256' },
  );
}

export async function verifyTwoFactorToken(token: string): Promise<string | null> {
  try {
    const s = await getSettings();
    const payload = jwt.verify(token, s.auth.jwtSecret, { algorithms: ['HS256'] });
    if (
      typeof payload !== 'object' ||
      payload === null ||
      payload.sub !== 'owner-2fa' ||
      payload.sv !== s.auth.sessionVersion ||
      typeof payload.nonce !== 'string'
    ) {
      return null;
    }
    const expiresAt = pendingTwoFactorLogins.get(payload.nonce);
    return expiresAt && expiresAt > Date.now() ? payload.nonce : null;
  } catch {
    return null;
  }
}

export function consumeTwoFactorToken(nonce: string): void {
  pendingTwoFactorLogins.delete(nonce);
}

function cleanupPendingTwoFactorLogins(): void {
  const now = Date.now();
  for (const [nonce, expiresAt] of pendingTwoFactorLogins) {
    if (expiresAt <= now) pendingTwoFactorLogins.delete(nonce);
  }
}

/**
 * Xác minh token phiên CHỦ SỞ HỮU. Ngoài chữ ký hợp lệ, token bắt buộc phải có
 * `sub === 'owner'` và dùng đúng thuật toán HS256. Điều này ngăn các token khác
 * cũng ký bằng cùng `jwtSecret` (ví dụ unlock-cookie của share công khai, mang
 * `sub: 'share'`) bị tái sử dụng như một phiên owner đầy đủ.
 */
export async function verifyToken(token: string): Promise<boolean> {
  try {
    const s = await getSettings();
    const payload = jwt.verify(token, s.auth.jwtSecret, { algorithms: ['HS256'] });
    return (
      typeof payload === 'object' &&
      payload !== null &&
      payload.sub === 'owner' &&
      payload.sv === s.auth.sessionVersion
    );
  } catch {
    return false;
  }
}

/** ---- API keys ----------------------------------------------------------- */

export function hashApiKey(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

/** Returns { raw, record-fields }. `raw` is shown to the user exactly once. */
export function generateApiKey(): { raw: string; hash: string; prefix: string } {
  const raw = `wok_${randomBytes(24).toString('base64url')}`;
  return { raw, hash: hashApiKey(raw), prefix: raw.slice(0, 12) };
}
