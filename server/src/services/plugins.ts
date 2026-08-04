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

export interface CommunityPlugin {
  id: string;
  name: string;
  author?: string;
  description?: string;
  repo: string;
  downloads: number;
  updated: number | null;
}

export interface CommunityPluginReadme {
  repo: string;
  markdown: string | null;
  path: string | null;
  sourceUrl: string;
  assetBaseUrl: string;
}

interface CommunityPluginStats {
  downloads?: number;
  updated?: number;
  [version: string]: number | undefined;
}

const COMMUNITY_CATALOG_URL = process.env.COMMUNITY_PLUGIN_CATALOG_URL
  ?? 'https://raw.githubusercontent.com/obsidianmd/obsidian-releases/master/community-plugins.json';
const COMMUNITY_PLUGIN_STATS_URL = process.env.COMMUNITY_PLUGIN_STATS_URL
  ?? 'https://raw.githubusercontent.com/obsidianmd/obsidian-releases/master/community-plugin-stats.json';
let catalogCache: { expiresAt: number; plugins: CommunityPlugin[] } | null = null;
const readmeCache = new Map<string, { expiresAt: number; readme: CommunityPluginReadme }>();

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

/** Official Obsidian community plugin catalog enriched with official download
 * statistics. Both documents use the plugin id as their stable join key. */
export async function listCommunityPlugins(): Promise<CommunityPlugin[]> {
  if (catalogCache && catalogCache.expiresAt > Date.now()) return catalogCache.plugins;
  const request = <T>(url: string, label: string): Promise<T> => fetch(url, {
    headers: { 'User-Agent': 'WebObsidian' },
    signal: AbortSignal.timeout(15_000),
  }).then(async (response) => {
    if (!response.ok) throw new Error(`${label} failed: ${response.status}`);
    return response.json() as Promise<T>;
  });
  let raw: Array<Omit<CommunityPlugin, 'downloads' | 'updated'>>;
  try {
    raw = await request<Array<Omit<CommunityPlugin, 'downloads' | 'updated'>>>(COMMUNITY_CATALOG_URL, 'Community plugin catalog');
  } catch (error) {
    // A stale complete catalog is more useful than an empty Browse window when
    // raw.githubusercontent.com has a short outage.
    if (catalogCache) return catalogCache.plugins;
    throw error;
  }
  const stats = await request<Record<string, CommunityPluginStats>>(COMMUNITY_PLUGIN_STATS_URL, 'Community plugin statistics')
    .catch((error) => {
      console.warn(`[plugins] ${error instanceof Error ? error.message : String(error)}; continuing without statistics`);
      return {} as Record<string, CommunityPluginStats>;
    });
  const plugins = raw
    .filter((plugin) => plugin?.id && plugin?.name && plugin?.repo)
    .map((plugin) => {
      const pluginStats = stats[plugin.id];
      return {
        ...plugin,
        id: assertSafeId(plugin.id),
        downloads: Number.isFinite(pluginStats?.downloads) ? pluginStats.downloads! : 0,
        updated: Number.isFinite(pluginStats?.updated) ? pluginStats.updated! : null,
      };
    })
    .sort((left, right) => right.downloads - left.downloads || left.name.localeCompare(right.name));
  catalogCache = { expiresAt: Date.now() + 15 * 60_000, plugins };
  return plugins;
}

/** Read the repository README through GitHub's API. The plugin id is resolved
 * against the official catalog so callers cannot turn this into an arbitrary
 * HTTP proxy. GitHub discovers the default branch and README filename for us. */
export async function getCommunityPluginReadme(id: string): Promise<CommunityPluginReadme> {
  const safeId = assertSafeId(id);
  const cached = readmeCache.get(safeId);
  if (cached && cached.expiresAt > Date.now()) return cached.readme;

  const plugin = (await listCommunityPlugins()).find((item) => item.id === safeId);
  if (!plugin) throw Object.assign(new Error('Community plugin not found'), { status: 404 });
  if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(plugin.repo)) {
    throw Object.assign(new Error('Invalid community plugin repository'), { status: 502 });
  }

  const apiTemplate = process.env.COMMUNITY_PLUGIN_README_URL_TEMPLATE
    ?? 'https://api.github.com/repos/{repo}/readme';
  const url = apiTemplate.replace('{repo}', plugin.repo);
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'WebObsidian',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
  const repositoryUrl = `https://github.com/${plugin.repo}`;
  if (response.status === 404) {
    const readme = {
      repo: plugin.repo,
      markdown: null,
      path: null,
      sourceUrl: repositoryUrl,
      assetBaseUrl: `https://raw.githubusercontent.com/${plugin.repo}/HEAD/`,
    };
    readmeCache.set(safeId, { expiresAt: Date.now() + 15 * 60_000, readme });
    return readme;
  }
  if (!response.ok) throw new Error(`GitHub README lookup failed: ${response.status}`);
  const payload = await response.json() as {
    content?: string;
    encoding?: string;
    path?: string;
    html_url?: string;
    download_url?: string;
  };
  if (payload.encoding !== 'base64' || typeof payload.content !== 'string') {
    throw new Error('GitHub README response is invalid');
  }
  const markdown = Buffer.from(payload.content.replace(/\s/g, ''), 'base64').toString('utf8');
  if (Buffer.byteLength(markdown, 'utf8') > 2 * 1024 * 1024) {
    throw new Error('Plugin README is too large');
  }
  const readmePath = payload.path || 'README.md';
  const slash = readmePath.lastIndexOf('/');
  const assetBaseUrl = payload.download_url
    ? new URL('.', payload.download_url).href
    : `https://raw.githubusercontent.com/${plugin.repo}/HEAD/${slash >= 0 ? readmePath.slice(0, slash + 1) : ''}`;
  const readme = {
    repo: plugin.repo,
    markdown,
    path: readmePath,
    sourceUrl: payload.html_url || `${repositoryUrl}/blob/HEAD/${readmePath}`,
    assetBaseUrl,
  };
  readmeCache.set(safeId, { expiresAt: Date.now() + 60 * 60_000, readme });
  return readme;
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

export async function uninstall(id: string): Promise<{ reloadRequired: boolean }> {
  const safeId = assertSafeId(id);
  const before = await getSettings();
  const wasEnabled = before.plugins.enabled.includes(safeId);
  await updateSettings((draft) => {
    draft.plugins.enabled = draft.plugins.enabled.filter((pluginId) => pluginId !== safeId);
    draft.plugins.installed = draft.plugins.installed.filter((pluginId) => pluginId !== safeId);
  });
  await fs.rm(path.join(await pluginsDir(), safeId), { recursive: true, force: true });
  return { reloadRequired: wasEnabled && before.plugins.enabled.length === 1 };
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
