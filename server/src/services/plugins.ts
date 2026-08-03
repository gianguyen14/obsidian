import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { getVaultRoot } from './vault.js';
import { getSettings, updateSettings } from './settings.js';

/**
 * Obsidian community plugin support (PRD FR-8).
 * Plugins live in `<vault>/.obsidian/plugins/<id>/` with manifest.json + main.js
 * (+ optional styles.css), exactly like the desktop app. The server lists,
 * installs (from GitHub releases) and toggles them; the browser loads main.js
 * against the Obsidian API compatibility runtime (see web/src/lib/plugins.ts).
 */

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  minAppVersion?: string;
  description?: string;
  author?: string;
  authorUrl?: string;
  isDesktopOnly?: boolean;
}

export interface InstalledPlugin extends PluginManifest {
  enabled: boolean;
  hasStyles: boolean;
  dir: string; // vault-relative
}

async function pluginsDir(): Promise<string> {
  const root = await getVaultRoot();
  return path.join(root, '.obsidian', 'plugins');
}

/**
 * A plugin id becomes a path segment under `.obsidian/plugins/`, both when
 * installing (taken from a *remote* manifest.json) and when serving assets
 * (taken from the URL). Reject anything that isn't a plain id so a crafted
 * `../../..` can't read or write outside the plugins directory.
 */
function assertSafeId(id: string): string {
  if (!/^[a-zA-Z0-9._-]+$/.test(id) || id === '.' || id === '..') {
    throw Object.assign(new Error('Invalid plugin id'), { status: 400 });
  }
  return id;
}

export async function listInstalled(): Promise<InstalledPlugin[]> {
  const dir = await pluginsDir();
  const s = await getSettings();
  let entries: string[] = [];
  try {
    entries = (await fs.readdir(dir, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
  const out: InstalledPlugin[] = [];
  for (const id of entries) {
    try {
      const manifestRaw = await fs.readFile(path.join(dir, id, 'manifest.json'), 'utf8');
      const manifest = JSON.parse(manifestRaw) as PluginManifest;
      const hasStyles = await fileExists(path.join(dir, id, 'styles.css'));
      out.push({
        ...manifest,
        id: manifest.id || id,
        enabled: s.plugins.enabled.includes(manifest.id || id),
        hasStyles,
        dir: `.obsidian/plugins/${id}`,
      });
    } catch {
      /* skip invalid plugin dir */
    }
  }
  return out;
}

export async function getPluginAsset(
  id: string,
  asset: 'main.js' | 'styles.css' | 'manifest.json',
): Promise<string> {
  return fs.readFile(await getPluginFilePath(id, asset), 'utf8');
}

/**
 * The loader must not evaluate plugin source with `new Function`. Serve a
 * normal, same-origin ES module which executes the plugin's CommonJS bundle
 * inside a Node-style wrapper instead. `require()` is provided by the browser
 * runtime. Plugin-authored dynamic code is handled separately by the
 * community-plugin CSP mode.
 */
export async function getPluginModule(id: string): Promise<string> {
  const safeId = assertSafeId(id);
  const code = await getPluginAsset(safeId, 'main.js');
  return [
    'const __woModule = { exports: {} };',
    '((module, exports, require) => {',
    code,
    `})(__woModule, __woModule.exports, (name) => globalThis.__webObsidianRequire(${JSON.stringify(safeId)}, name));`,
    'const __woPlugin = __woModule.exports?.default ?? __woModule.exports;',
    'export default __woPlugin;',
    `//# sourceURL=/api/plugins/${safeId}/module.js`,
  ].join('\n');
}

/** Resolve an arbitrary plugin-owned asset without allowing traversal/symlinks. */
export async function getPluginFilePath(id: string, relative: string): Promise<string> {
  const safeId = assertSafeId(id);
  if (!relative || relative.includes('\0') || path.isAbsolute(relative)) {
    throw Object.assign(new Error('Invalid plugin asset path'), { status: 400 });
  }
  const base = path.resolve(await pluginsDir(), safeId);
  const target = path.resolve(base, relative.replaceAll('\\', '/'));
  if (target === base || !target.startsWith(base + path.sep)) {
    throw Object.assign(new Error('Invalid plugin asset path'), { status: 400 });
  }
  const realBase = await fs.realpath(base);
  const realTarget = await fs.realpath(target);
  if (!realTarget.startsWith(realBase + path.sep)) {
    throw Object.assign(new Error('Plugin asset escapes its directory'), { status: 400 });
  }
  const stat = await fs.stat(realTarget);
  if (!stat.isFile()) throw Object.assign(new Error('Plugin asset not found'), { status: 404 });
  return realTarget;
}

export async function readPluginData(id: string): Promise<unknown> {
  try {
    return JSON.parse(await fs.readFile(await getPluginDataPath(id), 'utf8'));
  } catch (error: any) {
    if (error?.code === 'ENOENT') return {};
    if (error instanceof SyntaxError) {
      throw Object.assign(new Error('Plugin data.json is invalid JSON'), { status: 500 });
    }
    throw error;
  }
}

export async function writePluginData(id: string, data: unknown): Promise<void> {
  const file = await getPluginDataPath(id, true);
  const tmp = `${file}.tmp-${randomBytes(8).toString('hex')}`;
  try {
    await fs.writeFile(tmp, JSON.stringify(data ?? {}, null, 2), { encoding: 'utf8', mode: 0o600 });
    await fs.rename(tmp, file);
  } finally {
    await fs.rm(tmp, { force: true }).catch(() => {});
  }
}

async function getPluginDataPath(id: string, ensure = false): Promise<string> {
  const safeId = assertSafeId(id);
  const dir = path.join(await pluginsDir(), safeId);
  if (ensure) await fs.mkdir(dir, { recursive: true });
  return path.join(dir, 'data.json');
}

export async function setEnabled(id: string, enabled: boolean): Promise<{ reloadRequired: boolean }> {
  assertSafeId(id);
  const before = await getSettings();
  const pluginModeBefore = before.plugins.enabled.length > 0;
  const updated = await updateSettings((d) => {
    const set = new Set(d.plugins.enabled);
    if (enabled) set.add(id);
    else set.delete(id);
    d.plugins.enabled = [...set];
  });
  return { reloadRequired: pluginModeBefore !== (updated.plugins.enabled.length > 0) };
}

/**
 * Install a community plugin from a GitHub repo (owner/repo). Pulls
 * manifest.json + main.js (+ styles.css) from the latest release assets.
 */
export async function installFromGithub(repo: string): Promise<InstalledPlugin> {
  const clean = repo.replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '').trim();
  const relApi = `https://api.github.com/repos/${clean}/releases/latest`;
  const res = await fetch(relApi, { headers: { 'User-Agent': 'WebObsidian' } });
  if (!res.ok) throw new Error(`GitHub release lookup failed: ${res.status}`);
  const release = (await res.json()) as { assets: { name: string; browser_download_url: string }[] };
  const assets = Object.fromEntries(release.assets.map((a) => [a.name, a.browser_download_url]));
  if (!assets['manifest.json'] || !assets['main.js']) {
    throw new Error('Release missing manifest.json or main.js');
  }

  const manifest = JSON.parse(await fetchText(assets['manifest.json'])) as PluginManifest;
  // id comes from a REMOTE manifest — validate before it becomes a path segment
  // (a crafted `../../..` would otherwise write main.js outside the plugins dir).
  const id = assertSafeId(manifest.id || clean.split('/')[1]);
  const dir = await pluginsDir();
  const target = path.join(dir, id);
  await fs.mkdir(target, { recursive: true });
  await fs.writeFile(path.join(target, 'manifest.json'), JSON.stringify(manifest, null, 2));
  await fs.writeFile(path.join(target, 'main.js'), await fetchText(assets['main.js']));
  if (assets['styles.css']) {
    await fs.writeFile(path.join(target, 'styles.css'), await fetchText(assets['styles.css']));
  }
  await updateSettings((d) => {
    if (!d.plugins.installed.includes(id)) d.plugins.installed.push(id);
  });
  const installed = await listInstalled();
  const found = installed.find((p) => p.id === id);
  if (!found) throw new Error('Install verification failed');
  return found;
}

async function fetchText(url: string): Promise<string> {
  const r = await fetch(url, { headers: { 'User-Agent': 'WebObsidian' } });
  if (!r.ok) throw new Error(`Download failed: ${url} (${r.status})`);
  return r.text();
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}
