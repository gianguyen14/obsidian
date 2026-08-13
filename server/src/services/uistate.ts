import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { config } from '../config.js';

/**
 * Persisted UI/workspace state (open tabs, active note, expanded folders, panel
 * layout, bookmarks, recents). Stored server-side as a plain JSON file so the
 * workspace is isolated per browser/app installation. Vault data may be shared
 * through Git, but opening a note on one platform must never steer another.
 */

const DIR = path.join(config.dataDir, 'uistate');

export function normalizeWorkspaceId(value: unknown): string | null {
  const id = typeof value === 'string' ? value.trim() : '';
  return /^[a-zA-Z0-9_-]{8,64}$/.test(id) ? id : null;
}

function stateFile(workspaceId: string): string {
  return path.join(DIR, `${workspaceId}.json`);
}

export async function readUiState(workspaceId: string): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await fs.readFile(stateFile(workspaceId), 'utf8'));
  } catch {
    return {};
  }
}

export async function writeUiState(workspaceId: string, state: Record<string, unknown>): Promise<void> {
  await fs.mkdir(DIR, { recursive: true });
  const file = stateFile(workspaceId);
  const tmp = `${file}.tmp-${randomBytes(4).toString('hex')}`;
  await fs.writeFile(tmp, JSON.stringify(state, null, 2));
  await fs.rename(tmp, file);
}
