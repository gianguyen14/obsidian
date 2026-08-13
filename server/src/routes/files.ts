import { Router, type Request, type Response, type NextFunction } from 'express';
import multer from 'multer';
import path from 'node:path';
import { mkdir } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { asyncHandler } from '../middleware/error.js';
import { requireAuth } from '../middleware/auth.js';
import * as vault from '../services/vault.js';
import { getSettings } from '../services/settings.js';
import { qmd } from '../services/search.js';
import { updateLinkGraphForFile } from '../services/links.js';
import { removeMetaCache, upsertMetaCache } from '../services/metacache.js';
import { scheduleAutoCommitOnSave } from '../services/git.js';
import { resolveFile } from '../services/fileindex.js';
import { onFileRenamed } from '../services/shares.js';
import { mimeFor } from '../services/mime.js';
import { sendFileWithRange } from '../services/httpfile.js';
import { config } from '../config.js';

export const filesRouter = Router();
filesRouter.use(requireAuth);

const uploadTmp = path.join(config.dataDir, 'uploads');
const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      mkdir(uploadTmp, { recursive: true }, (error) => cb(error, uploadTmp));
    },
    filename: (_req, _file, cb) => cb(null, randomBytes(24).toString('hex')),
  }),
  limits: { fileSize: config.uploadMaxBytes, files: 1, fields: 1 },
});

let activeUploads = 0;
function limitUploadConcurrency(_req: Request, res: Response, next: NextFunction) {
  if (activeUploads >= config.uploadMaxConcurrent) {
    res.status(429).json({ error: 'Too many uploads in progress' });
    return;
  }
  activeUploads += 1;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    activeUploads -= 1;
  };
  res.once('finish', release);
  res.once('close', release);
  next();
}

const isMd = (p: string) => /\.(md|markdown)$/i.test(p);

// Refresh derived indexes after a mutation (best-effort, non-blocking).
// Incremental: only the touched file(s) are reparsed, not the whole vault.
function reindex(opts: { upsert?: string; added?: string; removed?: string } = {}) {
  if (opts.upsert) void qmd.upsert(opts.upsert).catch(() => {});
  if (opts.upsert && isMd(opts.upsert)) void upsertMetaCache(opts.upsert).catch(() => {});
  if (opts.added && isMd(opts.added)) void updateLinkGraphForFile(opts.added).catch(() => {});
  if (opts.removed && isMd(opts.removed)) {
    removeMetaCache(opts.removed);
    void updateLinkGraphForFile(opts.removed, true).catch(() => {});
  }
  scheduleAutoCommitOnSave();
}

filesRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    res.json(await vault.listTree());
  }),
);

filesRouter.get(
  '/content',
  asyncHandler(async (req, res) => {
    let rel = String(req.query.path ?? '');
    if (!rel) {
      res.status(400).json({ error: 'path required' });
      return;
    }
    // Obsidian-style resolution: if the exact path doesn't exist (e.g. an embed
    // `![[image.jpg]]` that lives in Attachments/), resolve it by basename.
    if (!(await vault.exists(rel))) {
      const resolved = resolveFile(rel);
      if (resolved) rel = resolved;
    }
    if (vault.isTextFile(rel)) {
      res.json({ path: rel, content: await vault.readFileText(rel), encoding: 'utf8' });
    } else {
      // Stream with Range support so embedded <video>/<audio> can seek.
      const abs = await vault.resolveInVault(rel);
      await sendFileWithRange(req, res, abs, mimeFor(rel));
    }
  }),
);

filesRouter.put(
  '/content',
  asyncHandler(async (req, res) => {
    const { path: rel, content } = req.body ?? {};
    if (typeof rel !== 'string' || typeof content !== 'string') {
      res.status(400).json({ error: 'path and content required' });
      return;
    }
    await vault.writeFileText(rel, content);
    reindex({ upsert: rel, added: rel });
    res.json({ ok: true, path: rel });
  }),
);

filesRouter.post(
  '/folder',
  asyncHandler(async (req, res) => {
    const { path: rel } = req.body ?? {};
    if (typeof rel !== 'string') {
      res.status(400).json({ error: 'path required' });
      return;
    }
    await vault.createFolder(rel);
    res.json({ ok: true, path: rel });
  }),
);

filesRouter.post(
  '/upload',
  limitUploadConcurrency,
  upload.single('file'),
  asyncHandler(async (req, res) => {
    const dir = String(req.body?.dir ?? '');
    const file = req.file;
    if (!file) {
      res.status(400).json({ error: 'file required' });
      return;
    }
    try {
      // Reuse an existing folder that differs only in case (e.g. an Obsidian vault's
      // "Attachments") instead of creating a duplicate "attachments". See vault.ts.
      const resolvedDir = dir ? await vault.resolveDirCaseInsensitive(dir) : '';
      const safeName = path.posix.basename(file.originalname.replaceAll('\\', '/'));
      if (!safeName || safeName === '.' || safeName === '..') {
        throw Object.assign(new Error('invalid filename'), { status: 400 });
      }
      const rel = path.posix.join(resolvedDir, safeName);
      await vault.writeFileFromPath(rel, file.path);
      res.json({ ok: true, path: rel, size: file.size });
    } finally {
      await vault.removeTemporaryFile(file.path);
    }
  }),
);

filesRouter.patch(
  '/rename',
  asyncHandler(async (req, res) => {
    const { from, to } = req.body ?? {};
    if (typeof from !== 'string' || typeof to !== 'string') {
      res.status(400).json({ error: 'from and to required' });
      return;
    }
    await vault.rename(from, to);
    await qmd.rename(from, to);
    await onFileRenamed(from, to).catch(() => {}); // keep public share links pointing at the note
    reindex({ added: to, removed: from });
    res.json({ ok: true, from, to });
  }),
);

filesRouter.post(
  '/copy',
  asyncHandler(async (req, res) => {
    const { from, to } = req.body ?? {};
    if (typeof from !== 'string' || typeof to !== 'string') {
      res.status(400).json({ error: 'from and to required' });
      return;
    }
    const copied = await vault.copy(from, to);
    for (const f of copied) {
      if (isMd(f)) {
        void qmd.upsert(f).catch(() => {});
        void updateLinkGraphForFile(f).catch(() => {});
      }
    }
    scheduleAutoCommitOnSave();
    res.json({ ok: true, from, to });
  }),
);

// --- Trash (FR-1) -----------------------------------------------------------
// Listed/mutated via dedicated /trash* routes; the plain DELETE / below either
// trashes or permanently removes depending on settings.vault.deleteMode.

filesRouter.get(
  '/trash',
  asyncHandler(async (_req, res) => {
    res.json({ items: await vault.listTrash() });
  }),
);

filesRouter.post(
  '/trash/restore',
  asyncHandler(async (req, res) => {
    const rel = String(req.body?.path ?? '');
    if (!rel) {
      res.status(400).json({ error: 'path required' });
      return;
    }
    const restored = await vault.restoreFromTrash(rel);
    reindex({ upsert: restored, added: restored });
    res.json({ ok: true, restored });
  }),
);

// Permanently delete one trashed item.
filesRouter.delete(
  '/trash/item',
  asyncHandler(async (req, res) => {
    const rel = String(req.query.path ?? '');
    if (!rel) {
      res.status(400).json({ error: 'path required' });
      return;
    }
    await vault.deleteFromTrash(rel);
    res.json({ ok: true });
  }),
);

// Empty the whole trash.
filesRouter.delete(
  '/trash',
  asyncHandler(async (_req, res) => {
    await vault.emptyTrash();
    res.json({ ok: true });
  }),
);

filesRouter.delete(
  '/',
  asyncHandler(async (req, res) => {
    const rel = String(req.query.path ?? '');
    if (!rel) {
      res.status(400).json({ error: 'path required' });
      return;
    }
    // `mode` lets callers pin the semantics instead of inheriting the vault
    // default: the Obsidian plugin API exposes vault.trash() and vault.delete()
    // as two distinct operations, so the shim must be able to force either one.
    const mode = String(req.query.mode ?? '');
    if (mode && mode !== 'trash' && mode !== 'permanent') {
      res.status(400).json({ error: 'mode must be "trash" or "permanent"' });
      return;
    }
    const s = await getSettings();
    qmd.remove(rel);
    if (mode ? mode === 'permanent' : s.vault.deleteMode === 'permanent') {
      await vault.remove(rel);
      reindex({ removed: rel });
      res.json({ ok: true, deleted: rel });
      return;
    }
    const dest = await vault.trash(rel);
    reindex({ removed: rel });
    res.json({ ok: true, trashed: dest });
  }),
);
