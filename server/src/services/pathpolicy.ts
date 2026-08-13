import { promises as fs } from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

/** Host-owned vault roots. The current vault is the fallback only when no host policy exists. */
export async function trustedVaultRoots(currentVault: string): Promise<string[]> {
  const roots = config.allowedRoots.length ? config.allowedRoots : [currentVault];
  return Promise.all(roots.map(async (root) => fs.realpath(path.resolve(root)).catch(() => path.resolve(root))));
}

/** Resolve an existing directory and enforce realpath containment under trusted roots. */
export async function assertVaultPathAllowed(value: string, currentVault: string): Promise<string> {
  if (!value.trim()) {
    throw Object.assign(new Error('Vault path is required'), { status: 400 });
  }
  const target = await fs.realpath(path.resolve(value)).catch(() => null);
  if (!target) {
    throw Object.assign(new Error('Vault path is not an existing directory'), { status: 400 });
  }
  const stat = await fs.stat(target).catch(() => null);
  if (!stat?.isDirectory()) {
    throw Object.assign(new Error('Vault path is not an existing directory'), { status: 400 });
  }
  const roots = await trustedVaultRoots(currentVault);
  if (!roots.some((root) => target === root || target.startsWith(root + path.sep))) {
    throw Object.assign(new Error('Vault path is outside the allowed roots'), { status: 403 });
  }
  return target;
}
