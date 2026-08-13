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

const COMMUNITY_CATALOG_URL =
  'https://raw.githubusercontent.com/obsidianmd/obsidian-releases/master/community-plugins.json';
const COMMUNITY_STATS_URL =
  'https://raw.githubusercontent.com/obsidianmd/obsidian-releases/master/community-plugin-stats.json';
const CACHE_MS = 15 * 60_000;

let catalogCache: { expiresAt: number; plugins: CommunityPlugin[] } | null = null;

async function publicFetch(url: string): Promise<Response> {
  const response = await fetch(url, {
    mode: 'cors',
    cache: 'no-cache',
    signal: AbortSignal.timeout(15_000),
  });
  return response;
}

async function fetchJson<T>(url: string, label: string): Promise<T> {
  const response = await publicFetch(url);
  if (!response.ok) throw new Error(`${label} failed: ${response.status}`);
  return response.json() as Promise<T>;
}

function safePluginId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9._-]+$/.test(value) && value !== '.' && value !== '..';
}

function safeRepository(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(value);
}

/**
 * Load the official catalog in the browser instead of routing it through the
 * self-hosted API. This avoids deployments whose reverse proxy serves the app
 * correctly but only forwards a fixed subset of /api/plugins routes.
 */
export async function fetchCommunityPluginCatalog(): Promise<{
  plugins: CommunityPlugin[];
  total: number;
  source: string;
}> {
  if (catalogCache && catalogCache.expiresAt > Date.now()) {
    return { plugins: catalogCache.plugins, total: catalogCache.plugins.length, source: 'obsidian-community' };
  }

  const catalogPromise = fetchJson<Array<Omit<CommunityPlugin, 'downloads' | 'updated'>>>(
    COMMUNITY_CATALOG_URL,
    'Community plugin catalog',
  );
  const statsPromise = fetchJson<Record<string, CommunityPluginStats>>(
    COMMUNITY_STATS_URL,
    'Community plugin statistics',
  ).catch(() => ({} as Record<string, CommunityPluginStats>));
  const [catalog, stats] = await Promise.all([catalogPromise, statsPromise]);

  const plugins = catalog
    .filter((plugin) => safePluginId(plugin?.id) && plugin?.name && safeRepository(plugin?.repo))
    .map((plugin) => {
      const pluginStats = stats[plugin.id];
      return {
        ...plugin,
        downloads: Number.isFinite(pluginStats?.downloads) ? pluginStats.downloads! : 0,
        updated: Number.isFinite(pluginStats?.updated) ? pluginStats.updated! : null,
      };
    })
    .sort((left, right) => right.downloads - left.downloads || left.name.localeCompare(right.name));

  catalogCache = { expiresAt: Date.now() + CACHE_MS, plugins };
  return { plugins, total: plugins.length, source: 'obsidian-community' };
}

/** Fetch README.md from the repository itself. `main` is attempted first so
 * Breadcrumbs resolves to michaelpporter/breadcrumbs/refs/heads/main/README.md;
 * HEAD and master cover repositories whose default branch differs. */
export async function fetchCommunityPluginReadme(
  id: string,
  knownRepo?: string,
): Promise<{ readme: CommunityPluginReadme }> {
  if (!safePluginId(id)) throw new Error('Invalid community plugin id');

  let repo = safeRepository(knownRepo) ? knownRepo : '';
  if (!repo) {
    const catalog = await fetchCommunityPluginCatalog();
    repo = catalog.plugins.find((plugin) => plugin.id === id)?.repo ?? '';
  }
  if (!safeRepository(repo)) throw new Error('Community plugin repository not found');

  const candidates = [
    { ref: 'refs/heads/main', path: 'README.md', branch: 'main' },
    { ref: 'HEAD', path: 'README.md', branch: 'HEAD' },
    { ref: 'refs/heads/master', path: 'README.md', branch: 'master' },
    { ref: 'refs/heads/main', path: 'readme.md', branch: 'main' },
    { ref: 'HEAD', path: 'readme.md', branch: 'HEAD' },
  ];

  for (const candidate of candidates) {
    const rawUrl = `https://raw.githubusercontent.com/${repo}/${candidate.ref}/${candidate.path}`;
    const response = await publicFetch(rawUrl);
    if (response.status === 404) continue;
    if (!response.ok) throw new Error(`GitHub README download failed: ${response.status}`);
    const markdown = await response.text();
    if (new TextEncoder().encode(markdown).byteLength > 2 * 1024 * 1024) {
      throw new Error('Plugin README is too large');
    }
    return {
      readme: {
        repo,
        markdown,
        path: candidate.path,
        sourceUrl: `https://github.com/${repo}/blob/${candidate.branch}/${candidate.path}`,
        assetBaseUrl: new URL('.', rawUrl).href,
      },
    };
  }

  return {
    readme: {
      repo,
      markdown: null,
      path: null,
      sourceUrl: `https://github.com/${repo}`,
      assetBaseUrl: `https://raw.githubusercontent.com/${repo}/HEAD/`,
    },
  };
}
