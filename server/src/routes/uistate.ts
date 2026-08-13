import { Router } from 'express';
import { asyncHandler } from '../middleware/error.js';
import { requireAuth } from '../middleware/auth.js';
import { normalizeWorkspaceId, readUiState, writeUiState } from '../services/uistate.js';
import { broadcast } from '../services/realtime.js';

export const uiStateRouter = Router();
uiStateRouter.use(requireAuth);

function workspaceId(req: { headers: Record<string, unknown> }): string | null {
  return normalizeWorkspaceId(req.headers['x-workspace-id']);
}

uiStateRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const id = workspaceId(req);
    if (!id) return res.status(400).json({ error: 'valid X-Workspace-Id header required' });
    res.json(await readUiState(id));
  }),
);

uiStateRouter.put(
  '/',
  asyncHandler(async (req, res) => {
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      res.status(400).json({ error: 'object body required' });
      return;
    }
    const id = workspaceId(req);
    if (!id) return res.status(400).json({ error: 'valid X-Workspace-Id header required' });
    await writeUiState(id, body);
    // Only sibling tabs from the same browser/app installation may follow this
    // workspace. Other platforms have a different persistent workspace id.
    const originId = String(req.headers['x-client-id'] ?? '');
    broadcast({ type: 'uistate', workspaceId: id, originId, state: body });
    res.json({ ok: true });
  }),
);
