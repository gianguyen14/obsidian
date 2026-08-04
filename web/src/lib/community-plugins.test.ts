import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('community plugin discovery', () => {
  it('joins the official catalog and stats, then sorts by downloads', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('community-plugins.json')) {
        return new Response(JSON.stringify([
          { id: 'second', name: 'Second', repo: 'owner/second' },
          { id: 'first', name: 'First', repo: 'owner/first' },
        ]), { status: 200 });
      }
      return new Response(JSON.stringify({
        first: { downloads: 100, updated: 20 },
        second: { downloads: 5, updated: 10 },
      }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const { fetchCommunityPluginCatalog } = await import('./community-plugins');
    const result = await fetchCommunityPluginCatalog();

    expect(result.total).toBe(2);
    expect(result.plugins.map((plugin) => plugin.id)).toEqual(['first', 'second']);
    expect(result.plugins[0]).toMatchObject({ downloads: 100, updated: 20 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('loads Breadcrumbs README from the main branch raw URL', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toBe('https://raw.githubusercontent.com/michaelpporter/breadcrumbs/refs/heads/main/README.md');
      return new Response('# Breadcrumbs', { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const { fetchCommunityPluginReadme } = await import('./community-plugins');
    const result = await fetchCommunityPluginReadme('breadcrumbs', 'michaelpporter/breadcrumbs');

    expect(result.readme.markdown).toBe('# Breadcrumbs');
    expect(result.readme.sourceUrl).toBe('https://github.com/michaelpporter/breadcrumbs/blob/main/README.md');
    expect(result.readme.assetBaseUrl).toBe('https://raw.githubusercontent.com/michaelpporter/breadcrumbs/refs/heads/main/');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('falls back to the repository default branch when main has no README', async () => {
    const fetchMock = vi.fn(async (url: string) => new Response(
      url.includes('/refs/heads/main/') ? 'Not Found' : '# Default branch',
      { status: url.includes('/refs/heads/main/') ? 404 : 200 },
    ));
    vi.stubGlobal('fetch', fetchMock);

    const { fetchCommunityPluginReadme } = await import('./community-plugins');
    const result = await fetchCommunityPluginReadme('sample', 'owner/sample');

    expect(result.readme.markdown).toBe('# Default branch');
    expect(result.readme.sourceUrl).toBe('https://github.com/owner/sample/blob/HEAD/README.md');
  });
});
