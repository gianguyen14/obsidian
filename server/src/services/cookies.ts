import type { Request } from 'express';

const COOKIE_SECURE = (process.env.COOKIE_SECURE ?? 'auto').toLowerCase();

/** Match Secure cookies to the real/requested transport unless explicitly forced. */
export function cookieIsSecure(req: Request): boolean {
  return COOKIE_SECURE === 'true'
    ? true
    : COOKIE_SECURE === 'false'
      ? false
      : req.secure;
}
