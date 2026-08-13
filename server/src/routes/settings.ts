import { Router } from 'express';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { asyncHandler } from '../middleware/error.js';
import { requireAuth } from '../middleware/auth.js';
import {
  getSettings,
  updateSettings,
  redactSettings,
  isSafeVaultRelativeDir,
} from '../services/settings.js';
import { assertVaultPathAllowed, trustedVaultRoots } from '../services/pathpolicy.js';

export const settingsRouter = Router();
settingsRouter.use(requireAuth);

settingsRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    res.json(redactSettings(await getSettings()));
  }),
);

// Patch a subset of settings. Secret fields are only overwritten when present.
settingsRouter.put(
  '/',
  asyncHandler(async (req, res) => {
    const body = req.body ?? {};
    // A changed vault.path turns the whole files API into read/write over that
    // tree, so constrain it to the allowed roots (same gate as Browse…) and
    // require it to be an existing directory before persisting.
    if (body.vault && Object.prototype.hasOwnProperty.call(body.vault, 'path')) {
      if (typeof body.vault.path !== 'string') {
        throw Object.assign(new Error('Vault path must be a string'), { status: 400 });
      }
      const current = await getSettings();
      body.vault.path = await assertVaultPathAllowed(body.vault.path, current.vault.path);
    }
    const updated = await updateSettings((d) => {
      if (body.vault) {
        Object.assign(d.vault, sanitizeVault(body.vault));
      }
      if (body.git) {
        const { token, ...rest } = body.git;
        Object.assign(d.git, rest);
        if (typeof token === 'string' && token && token !== '••••••••') d.git.token = token;
      }
      if (body.search) Object.assign(d.search, body.search);
      if (body.ui) Object.assign(d.ui, body.ui);
      if (body.api && typeof body.api.rateLimitPerMin === 'number') {
        d.api.rateLimitPerMin = body.api.rateLimitPerMin;
      }
    });
    res.json(redactSettings(updated));
  }),
);

function sanitizeVault(v: any) {
  const out: any = {};
  if (typeof v.path === 'string') out.path = v.path;
  if (typeof v.trash === 'string') {
    if (!isSafeVaultRelativeDir(v.trash)) {
      throw Object.assign(new Error('Trash directory must be a safe vault-relative path'), { status: 400 });
    }
    out.trash = v.trash;
  }
  if (v.deleteMode === 'trash' || v.deleteMode === 'permanent') out.deleteMode = v.deleteMode;
  if (typeof v.attachmentDir === 'string') out.attachmentDir = v.attachmentDir;
  return out;
}

/** Host-owned roots only. Persisted/client-supplied allowedRoots are never trusted. */
async function effectiveRoots(): Promise<string[]> {
  const s = await getSettings();
  return trustedVaultRoots(s.vault.path);
}


/** Safe folder browser for picking a vault path, limited to allowed roots. */
settingsRouter.get(
  '/browse',
  asyncHandler(async (req, res) => {
    const roots = await effectiveRoots();
    const dir = req.query.dir ? path.resolve(String(req.query.dir)) : roots[0];
    const realDir = await fs.realpath(dir).catch(() => null);

    const allowed = Boolean(realDir && roots.some((r) => realDir === r || realDir.startsWith(r + path.sep)));
    if (!allowed) {
      res.status(403).json({ error: 'Path outside allowed roots', roots });
      return;
    }
    const entries = await fs.readdir(realDir!, { withFileTypes: true });
    const folders = entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => ({ name: e.name, path: path.join(realDir!, e.name) }))
      .sort((a, b) => a.name.localeCompare(b.name));
    res.json({ dir: realDir, parent: path.dirname(realDir!), roots, folders });
  }),
);
